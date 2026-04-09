# Codex Auth 文件自助提货

这个项目面向 Cloudflare Workers 部署：

- 前端静态页面随 Worker 一起发布
- R2 存放原始 JSON 和批量 ZIP
- KV 按邮箱维护最新文件索引
- 支持单个提取、批量提取、管理员上传

## 架构

- `public/`
  - 页面、样式和前端交互
- `src/index.js`
  - Worker 入口，处理 API 和静态资源
- `AUTH_BUCKET`
  - R2 bucket，保存 `json/` 和 `batches/` 文件
- `AUTH_INDEX`
  - KV namespace，保存 `idx:${encodeURIComponent(normalizedEmail)}`
- `ADMIN_TOKEN`
  - Cloudflare Secret，用于管理员上传

查询算法：

1. 从输入中提取邮箱，兼容 `email` 和 `email-----password`
2. 规范化成 `localPart_domain`
3. 用规范化值直接查 KV
4. KV 返回最新文件对应的 R2 key
5. Worker 生成下载地址

这个流程避免每次去遍历 R2，查询效率远高于直接 list。

## 文件命名规则

上传后建立索引依赖文件名格式：

- `token_gongyun1989_hotmail.com_1775573029.json`
- `gongyun1989_hotmail.com_1775573029.json`

要求：

- 后缀必须是 `.json`
- 文件名末尾带时间戳
- 中间能解析出 `邮箱本地部分_域名`

## Cloudflare 准备步骤

这个项目当前采用“bindings 写在仓库，变量写在 Dashboard”的配置方式：

- [wrangler.toml](/D:/code/my/CodexAuthJsonFetcher/wrangler.toml) 保留 Worker 基础配置以及 R2/KV bindings
- R2 和 KV 必须写在 `wrangler.toml`，否则 `wrangler deploy` 会把线上 bindings 清掉
- 业务参数和管理员口令继续放在 Cloudflare 控制台配置
- `keep_vars = true` 已开启，避免部署时覆盖控制台变量

建议在 R2 后台为 `batches/` 前缀增加生命周期规则，例如 1 天自动删除，避免批量压缩包长期堆积。

## 纯网页配置

如果你不想用命令行，推荐走这个流程：

1. 先把当前项目上传到 GitHub 仓库。
2. 打开 Cloudflare Dashboard。
3. 进入 `Workers & Pages`。
4. 选择 `Create application`。
5. 选择 `Import a repository`，连接你的 GitHub 仓库。
6. 仓库导入时，项目名称尽量保持和 `wrangler.toml` 里的 `name` 一致，也就是 `codex-auth-json-fetcher`。
7. 导入完成后，再分别创建资源，并确认 `wrangler.toml` 里的 R2/KV bindings 指向正确资源。

网页端资源配置路径：

- 创建 R2 bucket
  - Dashboard -> `R2 Object Storage` -> `Create bucket`
- 创建 KV namespace
  - Dashboard -> `Workers KV` -> `Create instance`
- 检查或补充变量与密钥
  - Dashboard -> `Workers & Pages` -> 你的 Worker -> `Settings` -> `Variables and Secrets`
- 添加管理员口令
  - Dashboard -> `Workers & Pages` -> 你的 Worker -> `Settings` -> `Variables and Secrets`

注意，这里要区分两类配置：

- `AUTH_BUCKET`、`AUTH_INDEX`
  - 这两个不是普通环境变量，而是 Cloudflare Bindings
  - 它们已经写在 [wrangler.toml](/D:/code/my/CodexAuthJsonFetcher/wrangler.toml)
  - 后续如果换 bucket 或 namespace，需要同步修改配置文件
- `ADMIN_TOKEN`、`MAX_BATCH_ITEMS` 这些
  - 才是 Variables / Secrets

本项目在网页端需要配置的名字必须和代码一致：

- R2 Binding：`AUTH_BUCKET`
- KV Binding：`AUTH_INDEX`
- Secret：`ADMIN_TOKEN`

可选普通环境变量：

- `MAX_BATCH_ITEMS`
- `MAX_HISTORY_ITEMS`
- `BATCH_ZIP_TTL_SECONDS`

推荐值：

- `MAX_BATCH_ITEMS=100`
- `MAX_HISTORY_ITEMS=20`
- `BATCH_ZIP_TTL_SECONDS=86400`

## 本地开发

```bash
npm install
npm run dev
```

## 部署

```bash
npm run deploy
```

部署后可用接口：

- `/`
- `/api/admin/upload`
- `/api/query/single`
- `/api/query/batch`
- `/api/download`

## 上传行为

- `.json`
  - 直接上传并建立索引
- `.zip`
  - 先解压，再提取内部所有 `.json`
- 文件夹上传
  - 由浏览器把目录内文件提交给 Worker，Worker 只处理 `.json`
- 其他文件
  - 自动跳过

## 后续可增强

- 接入 Cloudflare Access 做管理员登录
- 用 D1 记录上传审计日志
- 给下载链接增加签名或过期控制
- 如果未来文件名规则变化，可改为解析 JSON 内容中的邮箱字段再建索引
