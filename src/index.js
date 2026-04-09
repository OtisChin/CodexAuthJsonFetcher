import { unzipSync, zipSync } from "fflate";

const JSON_TYPE = "application/json; charset=utf-8";
const ZIP_TYPE = "application/zip";
const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const ZIP_NAME_REGEX = /\.zip$/i;
const JSON_NAME_REGEX = /\.json$/i;

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname.startsWith("/api/")) {
        return await routeApi(request, env, url);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return jsonResponse(
        {
          error: "server_error",
          message: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
};

async function routeApi(request, env, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (url.pathname === "/api/health" && request.method === "GET") {
    return jsonResponse({ ok: true, service: "codex-auth-json-fetcher" });
  }

  if (url.pathname === "/api/query/single" && request.method === "POST") {
    return handleSingleQuery(request, env);
  }

  if (url.pathname === "/api/query/batch" && request.method === "POST") {
    return handleBatchQuery(request, env);
  }

  if (url.pathname === "/api/admin/upload" && request.method === "POST") {
    return handleAdminUpload(request, env);
  }

  if (url.pathname === "/api/download" && request.method === "GET") {
    return handleDownload(url, env);
  }

  return jsonResponse({ error: "not_found", message: "API route not found." }, 404);
}

async function handleSingleQuery(request, env) {
  const body = await request.json().catch(() => null);
  const rawInput = body?.input ?? "";
  const email = extractEmail(rawInput);

  if (!email) {
    return jsonResponse(
      { error: "invalid_email", message: "请输入有效邮箱，支持 email 或 email-----密码 格式。" },
      400,
    );
  }

  const normalizedEmail = normalizeEmail(email);
  const record = await getIndexRecord(env, normalizedEmail);

  if (!record?.latest) {
    return jsonResponse(
      { error: "not_found", message: "云端没有找到对应邮箱的 JSON 文件。", normalizedEmail },
      404,
    );
  }

  return jsonResponse({
    ok: true,
    mode: "single",
    email,
    normalizedEmail,
    filename: record.latest.originalFilename,
    uploadedAt: record.latest.uploadedAt,
    timestamp: record.latest.timestamp,
    downloadUrl: buildDownloadUrl(request.url, record.latest.storageKey, record.latest.originalFilename),
  });
}

async function handleBatchQuery(request, env) {
  const body = await request.json().catch(() => null);
  const rawInput = body?.input ?? "";
  const rawItems = splitBatchInput(rawInput);
  const normalizedItems = [];
  const seen = new Set();

  for (const item of rawItems) {
    const email = extractEmail(item);
    if (!email) {
      continue;
    }

    const normalizedEmail = normalizeEmail(email);
    if (!seen.has(normalizedEmail)) {
      seen.add(normalizedEmail);
      normalizedItems.push({ email, normalizedEmail });
    }
  }

  const maxBatchItems = Number(env.MAX_BATCH_ITEMS || 100);
  if (!normalizedItems.length) {
    return jsonResponse(
      { error: "empty_batch", message: "请至少输入一个有效邮箱，每行一个。" },
      400,
    );
  }

  if (normalizedItems.length > maxBatchItems) {
    return jsonResponse(
      {
        error: "batch_limit_exceeded",
        message: `单次最多支持 ${maxBatchItems} 个邮箱。`,
      },
      400,
    );
  }

  const lookupResults = await Promise.all(
    normalizedItems.map(async (item) => {
      const record = await getIndexRecord(env, item.normalizedEmail);
      return { ...item, record };
    }),
  );

  const found = lookupResults.filter((item) => item.record?.latest);
  const missing = lookupResults.filter((item) => !item.record?.latest).map((item) => item.email);

  if (!found.length) {
    return jsonResponse(
      {
        error: "not_found",
        message: "没有找到任何匹配的 JSON 文件。",
        missing,
      },
      404,
    );
  }

  if (found.length === 1) {
    const latest = found[0].record.latest;
    return jsonResponse({
      ok: true,
      mode: "single",
      email: found[0].email,
      normalizedEmail: found[0].normalizedEmail,
      filename: latest.originalFilename,
      missing,
      downloadUrl: buildDownloadUrl(request.url, latest.storageKey, latest.originalFilename),
    });
  }

  const entries = {};
  const packedFiles = [];

  for (const item of found) {
    const object = await env.AUTH_BUCKET.get(item.record.latest.storageKey);
    if (!object) {
      missing.push(item.email);
      continue;
    }

    const bytes = new Uint8Array(await object.arrayBuffer());
    const dedupedFilename = uniqueFilename(
      item.record.latest.originalFilename,
      packedFiles.map((file) => file.filename),
    );

    entries[dedupedFilename] = [bytes, { level: 0 }];
    packedFiles.push({
      email: item.email,
      normalizedEmail: item.normalizedEmail,
      filename: dedupedFilename,
    });
  }

  if (!packedFiles.length) {
    return jsonResponse(
      {
        error: "not_found",
        message: "匹配项存在索引，但文件体不存在，请重新上传数据。",
      },
      404,
    );
  }

  const zipBytes = zipSync(entries, { level: 6 });
  const batchFilename = `auth-json-batch-${Date.now()}.zip`;
  const batchStorageKey = `batches/${Date.now()}-${crypto.randomUUID()}.zip`;

  await env.AUTH_BUCKET.put(batchStorageKey, zipBytes, {
    httpMetadata: {
      contentType: ZIP_TYPE,
      contentDisposition: buildContentDisposition(batchFilename),
    },
    customMetadata: {
      generatedAt: new Date().toISOString(),
      ttlSeconds: String(Number(env.BATCH_ZIP_TTL_SECONDS || 86400)),
      itemCount: String(packedFiles.length),
    },
  });

  return jsonResponse({
    ok: true,
    mode: "batch",
    count: packedFiles.length,
    missing,
    filename: batchFilename,
    downloadUrl: buildDownloadUrl(request.url, batchStorageKey, batchFilename),
    files: packedFiles,
  });
}

async function handleAdminUpload(request, env) {
  const formData = await request.formData();
  const adminToken = request.headers.get("x-admin-token") || String(formData.get("adminToken") || "");

  if (!env.ADMIN_TOKEN || adminToken !== env.ADMIN_TOKEN) {
    return jsonResponse(
      { error: "unauthorized", message: "管理员口令错误，无法上传。" },
      401,
    );
  }

  const fileEntries = formData.getAll("files").filter((value) => value instanceof File);

  if (!fileEntries.length) {
    return jsonResponse(
      { error: "missing_files", message: "请至少选择一个 JSON、ZIP 或文件夹内容。" },
      400,
    );
  }

  const extractedItems = [];
  const skipped = [];

  for (const file of fileEntries) {
    if (JSON_NAME_REGEX.test(file.name)) {
      extractedItems.push({
        originalFilename: sanitizeFilename(file.name),
        bytes: new Uint8Array(await file.arrayBuffer()),
        sourceName: file.name,
        sourceType: "json",
      });
      continue;
    }

    if (ZIP_NAME_REGEX.test(file.name)) {
      try {
        const zipContents = unzipSync(new Uint8Array(await file.arrayBuffer()));
        let extractedCount = 0;

        for (const [entryName, entryBytes] of Object.entries(zipContents)) {
          if (!JSON_NAME_REGEX.test(entryName)) {
            continue;
          }

          extractedItems.push({
            originalFilename: sanitizeFilename(entryName),
            bytes: entryBytes,
            sourceName: file.name,
            sourceType: "zip",
          });
          extractedCount += 1;
        }

        if (!extractedCount) {
          skipped.push({ name: file.name, reason: "ZIP 中没有 JSON 文件。" });
        }
      } catch {
        skipped.push({ name: file.name, reason: "ZIP 文件损坏或无法解压。" });
      }
      continue;
    }

    skipped.push({
      name: file.name,
      reason: "仅支持 .json、.zip 或文件夹中的 JSON 文件。",
    });
  }

  if (!extractedItems.length) {
    return jsonResponse(
      {
        error: "empty_upload",
        message: "上传内容里没有可处理的 JSON 文件。",
        skipped,
      },
      400,
    );
  }

  const nowIso = new Date().toISOString();
  const validItems = [];

  for (const item of extractedItems) {
    const metadata = parseStoredJsonFilename(item.originalFilename);
    if (!metadata?.normalizedEmail) {
      skipped.push({
        name: item.originalFilename,
        reason: "文件名不符合 token_xxx_hotmail.com_时间戳.json 规则。",
      });
      continue;
    }

    const storageKey = [
      "json",
      metadata.normalizedEmail,
      `${metadata.timestamp}-${crypto.randomUUID()}-${item.originalFilename}`,
    ].join("/");

    validItems.push({
      ...item,
      normalizedEmail: metadata.normalizedEmail,
      timestamp: metadata.timestamp,
      uploadedAt: nowIso,
      storageKey,
    });
  }

  if (!validItems.length) {
    return jsonResponse(
      {
        error: "invalid_filenames",
        message: "没有任何文件符合邮箱命名规则，无法建立索引。",
        skipped,
      },
      400,
    );
  }

  await Promise.all(
    validItems.map((item) =>
      env.AUTH_BUCKET.put(item.storageKey, item.bytes, {
        httpMetadata: {
          contentType: JSON_TYPE,
          contentDisposition: buildContentDisposition(item.originalFilename),
        },
        customMetadata: {
          normalizedEmail: item.normalizedEmail,
          originalFilename: item.originalFilename,
          sourceName: item.sourceName,
          sourceType: item.sourceType,
          timestamp: String(item.timestamp),
          uploadedAt: item.uploadedAt,
        },
      }),
    ),
  );

  const groupedByEmail = groupBy(validItems, (item) => item.normalizedEmail);
  const maxHistoryItems = Number(env.MAX_HISTORY_ITEMS || 20);

  for (const [normalizedEmail, items] of Object.entries(groupedByEmail)) {
    const existing = await getIndexRecord(env, normalizedEmail);
    const incomingFiles = items.map((item) => ({
      storageKey: item.storageKey,
      originalFilename: item.originalFilename,
      timestamp: item.timestamp,
      uploadedAt: item.uploadedAt,
    }));

    const mergedFiles = mergeHistory(existing?.files || [], incomingFiles).slice(0, maxHistoryItems);
    const latest = mergedFiles[0];

    await env.AUTH_INDEX.put(
      buildIndexKey(normalizedEmail),
      JSON.stringify({
        normalizedEmail,
        updatedAt: nowIso,
        latest,
        files: mergedFiles,
      }),
    );
  }

  return jsonResponse({
    ok: true,
    uploaded: validItems.length,
    indexedEmails: Object.keys(groupedByEmail).length,
    skipped,
  });
}

async function handleDownload(url, env) {
  const storageKey = url.searchParams.get("key") || "";
  if (!storageKey.startsWith("json/") && !storageKey.startsWith("batches/")) {
    return jsonResponse({ error: "invalid_key", message: "下载地址无效。" }, 400);
  }

  const object = await env.AUTH_BUCKET.get(storageKey);
  if (!object) {
    return jsonResponse({ error: "not_found", message: "文件不存在或已过期。" }, 404);
  }

  const filename = sanitizeFilename(
    url.searchParams.get("download") || storageKey.split("/").pop() || "download.json",
  );
  const headers = new Headers(corsHeaders());
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=60");
  headers.set("content-disposition", buildContentDisposition(filename));

  return new Response(object.body, { status: 200, headers });
}

function splitBatchInput(input) {
  return String(input)
    .split(/[\r\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractEmail(input) {
  const match = String(input).toLowerCase().match(EMAIL_REGEX);
  return match?.[0] || null;
}

function normalizeEmail(email) {
  const [localPart, domain] = String(email).trim().toLowerCase().split("@");
  if (!localPart || !domain) {
    return null;
  }

  return `${localPart}_${domain}`;
}

function parseStoredJsonFilename(filename) {
  const safeName = sanitizeFilename(filename);
  const withoutExt = safeName.replace(/\.json$/i, "");
  const timestampMatch = withoutExt.match(/^(.*)_([0-9]{6,})$/);

  if (!timestampMatch) {
    return null;
  }

  let normalizedEmail = timestampMatch[1];
  if (normalizedEmail.startsWith("token_")) {
    normalizedEmail = normalizedEmail.slice("token_".length);
  }

  if (!normalizedEmail.includes("_")) {
    return null;
  }

  return {
    normalizedEmail: normalizedEmail.toLowerCase(),
    timestamp: Number(timestampMatch[2]),
  };
}

function sanitizeFilename(filename) {
  return String(filename)
    .split(/[\\/]/)
    .pop()
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

function uniqueFilename(filename, existingNames) {
  if (!existingNames.includes(filename)) {
    return filename;
  }

  const lastDot = filename.lastIndexOf(".");
  const base = lastDot >= 0 ? filename.slice(0, lastDot) : filename;
  const ext = lastDot >= 0 ? filename.slice(lastDot) : "";
  let counter = 2;

  while (existingNames.includes(`${base}-${counter}${ext}`)) {
    counter += 1;
  }

  return `${base}-${counter}${ext}`;
}

function buildIndexKey(normalizedEmail) {
  return `idx:${encodeURIComponent(normalizedEmail)}`;
}

async function getIndexRecord(env, normalizedEmail) {
  if (!normalizedEmail) {
    return null;
  }

  const raw = await env.AUTH_INDEX.get(buildIndexKey(normalizedEmail));
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mergeHistory(existingFiles, incomingFiles) {
  const merged = [...incomingFiles, ...existingFiles];
  const deduped = new Map();

  for (const file of merged) {
    const dedupeKey = `${file.originalFilename}:${file.timestamp}`;
    if (!deduped.has(dedupeKey)) {
      deduped.set(dedupeKey, file);
    }
  }

  return [...deduped.values()].sort((left, right) => {
    if (right.timestamp !== left.timestamp) {
      return right.timestamp - left.timestamp;
    }

    return String(right.uploadedAt).localeCompare(String(left.uploadedAt));
  });
}

function groupBy(items, keySelector) {
  return items.reduce((groups, item) => {
    const key = keySelector(item);
    groups[key] ||= [];
    groups[key].push(item);
    return groups;
  }, {});
}

function buildDownloadUrl(requestUrl, storageKey, filename) {
  const url = new URL(requestUrl);
  url.pathname = "/api/download";
  url.search = "";
  url.searchParams.set("key", storageKey);
  url.searchParams.set("download", filename);
  return url.toString();
}

function buildContentDisposition(filename) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type, X-Admin-Token",
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": JSON_TYPE,
    },
  });
}
