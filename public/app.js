const tabs = Array.from(document.querySelectorAll("[data-tab-target]"));
const panels = Array.from(document.querySelectorAll(".tab-panel"));

const singleForm = document.querySelector("#single-form");
const batchForm = document.querySelector("#batch-form");
const adminForm = document.querySelector("#admin-form");

const singleResult = document.querySelector("#single-result");
const batchResult = document.querySelector("#batch-result");
const adminResult = document.querySelector("#admin-result");

setEmptyState(singleResult, "输入邮箱后即可返回对应 JSON 下载地址。");
setEmptyState(batchResult, "多个邮箱会自动打包成 ZIP，并返回下载链接。");
setEmptyState(adminResult, "管理员上传后，系统会自动抽取 JSON 并建立邮箱索引。");

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    const targetId = tab.dataset.tabTarget;
    tabs.forEach((item) => item.classList.toggle("is-active", item === tab));
    panels.forEach((panel) => panel.classList.toggle("is-active", panel.id === targetId));
  });
}

singleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = singleForm.querySelector("button[type='submit']");
  const input = singleForm.querySelector("input[name='input']").value.trim();

  if (!input) {
    renderError(singleResult, "请输入邮箱。");
    return;
  }

  toggleLoading(submitButton, true, "查询中...");

  try {
    const response = await fetch("/api/query/single", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.message || "查询失败。");
    }

    renderSuccess(singleResult, {
      title: "查询完成",
      lines: [
        `匹配邮箱：${payload.email}`,
        `索引键：${payload.normalizedEmail}`,
        `文件名：${payload.filename}`,
      ],
      link: payload.downloadUrl,
      linkLabel: "下载 JSON 文件",
    });
  } catch (error) {
    renderError(singleResult, error.message || "查询失败。");
  } finally {
    toggleLoading(submitButton, false, "立即查询");
  }
});

batchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = batchForm.querySelector("button[type='submit']");
  const input = batchForm.querySelector("textarea[name='input']").value.trim();

  if (!input) {
    renderError(batchResult, "请至少输入一个邮箱。");
    return;
  }

  toggleLoading(submitButton, true, "生成中...");

  try {
    const response = await fetch("/api/query/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.message || "批量查询失败。");
    }

    const lines = [];
    if (payload.mode === "single") {
      lines.push(`仅命中 1 个文件：${payload.filename}`);
    } else {
      lines.push(`打包文件数：${payload.count}`);
      lines.push(`压缩包：${payload.filename}`);
    }

    if (Array.isArray(payload.missing) && payload.missing.length) {
      lines.push(`未命中：${payload.missing.length} 个`);
    }

    renderSuccess(batchResult, {
      title: payload.mode === "single" ? "查询完成" : "批量打包完成",
      lines,
      link: payload.downloadUrl,
      linkLabel: payload.mode === "single" ? "下载 JSON 文件" : "下载 ZIP 压缩包",
      pills: payload.missing || [],
    });
  } catch (error) {
    renderError(batchResult, error.message || "批量查询失败。");
  } finally {
    toggleLoading(submitButton, false, "批量生成下载包");
  }
});

adminForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = adminForm.querySelector("button[type='submit']");
  const token = adminForm.querySelector("#admin-token").value.trim();
  const fileInput = adminForm.querySelector("#admin-files");
  const folderInput = adminForm.querySelector("#admin-folder");

  const files = [...fileInput.files, ...folderInput.files];
  if (!token) {
    renderError(adminResult, "请输入管理员口令。");
    return;
  }

  if (!files.length) {
    renderError(adminResult, "请选择要上传的文件或文件夹。");
    return;
  }

  toggleLoading(submitButton, true, "上传中...");

  try {
    const formData = new FormData();
    formData.set("adminToken", token);
    files.forEach((file) => formData.append("files", file, file.name));

    const response = await fetch("/api/admin/upload", {
      method: "POST",
      body: formData,
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.message || "上传失败。");
    }

    renderSuccess(adminResult, {
      title: "上传完成",
      lines: [
        `成功上传：${payload.uploaded} 个 JSON`,
        `建立索引邮箱：${payload.indexedEmails} 个`,
        `跳过文件：${payload.skipped?.length || 0} 个`,
      ],
      pills: (payload.skipped || []).map((item) => `${item.name}: ${item.reason}`),
    });

    fileInput.value = "";
    folderInput.value = "";
  } catch (error) {
    renderError(adminResult, error.message || "上传失败。");
  } finally {
    toggleLoading(submitButton, false, "上传并建立索引");
  }
});

function toggleLoading(button, loading, text) {
  button.disabled = loading;
  button.textContent = text;
}

function setEmptyState(container, message) {
  container.className = "result-card is-empty";
  container.textContent = message;
}

function renderError(container, message) {
  container.className = "result-card is-error";
  container.innerHTML = `
    <h3 class="result-title">操作失败</h3>
    <p class="result-meta">${escapeHtml(message)}</p>
  `;
}

function renderSuccess(container, { title, lines = [], link, linkLabel, pills = [] }) {
  const linesHtml = lines.map((line) => `<p class="result-meta">${escapeHtml(line)}</p>`).join("");
  const linkHtml = link
    ? `<a class="result-link" href="${encodeURI(link)}" target="_blank" rel="noreferrer">${escapeHtml(linkLabel)}</a>`
    : "";
  const pillsHtml = pills.length
    ? `<div class="pill-list">${pills
        .map((pill) => `<span class="pill">${escapeHtml(pill)}</span>`)
        .join("")}</div>`
    : "";

  container.className = "result-card is-success";
  container.innerHTML = `
    <h3 class="result-title">${escapeHtml(title)}</h3>
    ${linesHtml}
    ${linkHtml}
    ${pillsHtml}
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
