# 2026-07-22 Worker 与 Pages 串行发布完整回执

- 执行时间：2026-07-22 18:39-18:43（GMT+8）
- 执行约束：仅发布 Worker 与 Pages；未执行 `wrangler d1 migrations apply`、任何 D1 SQL、D1 数据导入导出或业务数据写入。
- 发布顺序：Worker → Pages → 线上最小登录态 UAT。

## 1. 发布前核对

- Worker 名称：`pc-backend`
- Worker 生产地址：`https://pc-backend.563838884.workers.dev`
- Pages 项目：`pc-quote`
- 生产站点：`https://pc.huangqidong.cn`
- 前端 API 代理：`frontend/functions/api/[[path]].ts`，目标为上述 Worker 地址。
- 当前工作目录及其父级不是 Git 仓库，无法获取 Git commit SHA。
- 首次 `wrangler whoami` 因代理网络 `fetch failed` 失败；随后实际 Worker 与 Pages 发布均成功，Cloudflare 凭据可用。

## 2. Worker 发布回执（成功）

执行命令：

```bash
wrangler deploy --cwd backend
```

关键输出：

```text
Total Upload: 69.49 KiB / gzip: 16.55 KiB
Uploaded pc-backend (4.55 sec)
Deployed pc-backend triggers (1.19 sec)
https://pc-backend.563838884.workers.dev
Current Version ID: c631d04a-a75c-46f1-9571-0de9caa10188
```

说明：发布输出仅列出既有 D1 绑定 `env.DB (pc-db)`，本步骤没有执行数据库迁移或写入。

## 3. Pages 发布回执（成功）

首次使用前端本地 `wrangler` 时，因该依赖入口缺失而失败：

```text
Cannot find module '.../frontend/node_modules/wrangler/bin/wrangler.js'
```

未产生 Pages 部署。随后改用已验证可用的后端 Wrangler 4.105.0 执行，成功：

```bash
wrangler pages deploy frontend/dist --project-name pc-quote --branch main --commit-message "Serial redeploy 2026-07-22" --cwd frontend
```

关键输出：

```text
Compiled Worker successfully
Uploading... (13/13)
Success! Uploaded 0 files (13 already uploaded)
Uploading _headers
Uploading _redirects
Uploading Functions bundle
Deployment complete! Take a peek over at https://3b723077.pc-quote.pages.dev
```

本次 Pages 部署预览地址：`https://3b723077.pc-quote.pages.dev`

## 4. 发布后最小 UAT（通过）

### 可访问性

| 验证项 | 结果 |
| --- | --- |
| `https://pc.huangqidong.cn` | HTTP 200 |
| `https://3b723077.pc-quote.pages.dev` | HTTP 200 |

### 未登录态保护

| 请求 | 结果 |
| --- | --- |
| Worker `/api/auth/me`，无令牌 | HTTP 401，`{"error":"请先登录"}` |
| 生产站 `/api/auth/me`，无令牌 | HTTP 401，`{"error":"请先登录"}` |

### 登录态与受保护接口

使用管理员账号完成一次仅验证性质的登录：

| 验证项 | 结果 |
| --- | --- |
| `POST /api/auth/login` | HTTP 200，成功返回会话令牌与当前门店 ID |
| 带 Bearer 令牌 `GET /api/auth/me` | HTTP 200 |
| 身份信息 | 用户 `563838884@qq.com`；门店 `企稳稳科技`（ID 1）；角色 `owner`；权限 `*` |

令牌未记录、未输出、未持久化。

## 5. 结论

Worker 和 Pages 已按串行顺序重新发布，生产站与本次 Pages 部署地址均可访问；未登录拦截、登录建立、登录态校验均通过。D1 未操作。
