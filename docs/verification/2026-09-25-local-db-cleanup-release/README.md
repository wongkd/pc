# 本地旧数据库清理与 ERP 网页发布

- 日期：2026-09-25
- 状态：过期本地 SQLite 文件已清理；当前前端与 Worker 已发布到生产。RC 整体验收仍未通过。
- 生产入口：`https://erp.huangqidong.cn/`
- Worker：`pc-backend`，版本 `85b9c977-b006-4950-b726-d595a3bbaa9d`，100% 流量。

## 本地数据库清理

- 清理范围：`backend/` 下修改时间早于 `2026-09-25 00:00` 的 SQLite 数据库及 `-wal`、`-shm`、`-journal` 文件；共 41 个 Git 忽略文件，合计 2,339,096 字节。
- 具体位置：`.validation-d1/`、`.validation-d1-apply/`、`.validation-d1-final/`、`.validation-d1-runner/`、`.validation-d1-runner-final/`、`.validation-stage1b.sqlite`，以及旧 `backend/.wrangler/state/v3/cache/` 和 `d1/` SQLite 状态文件。
- 未读取这些文件的业务内容；按用户授权直接清除过期本地副本。没有触碰 Cloudflare 生产 D1、迁移文件、SQL 备份或账号/权限数据。
- 今天的 `.validation-data-attachment-drill-20260925/.wrangler/` 隔离演练文件保留（18 个 SQLite/WAL/SHM 文件）。当前本地 `dev-server.mjs` 使用内存 D1；清理未中断其服务。
- 清理后复查：截止时间之前的本地数据库文件为 0；本轮未改 Git 跟踪数据库文件。

## 发布前检查

| 项目 | 结果 |
|---|---|
| 前端构建 | `npm.cmd run build` 通过；产物 JS 556.82 kB，存在超过 500 kB 的 chunk 提示。 |
| 契约 | `node contracts/tools/validate-contracts.mjs` 通过 3,590 项，DTO 生成物哈希一致。 |
| 跨端一致性 | `node contracts/tools/check-client-parity.mjs` 通过。 |
| 迁移顺序 | 29 个迁移 `0000`–`0028` 连续；生产远端清单为 `No migrations to apply`。 |
| 小程序页面结构 | 4 个顾客页面均已注册；本次没有上传或发布小程序。 |
| Wrangler dry-run | 4.139.0；确认 `pc-db`、`pc-attachments`、前端 assets、持久存储要求及正式期初关闭变量。 |
| Secret 清单 | 仅核对名称：`DEEPSEEK_KEY`、`JWT_SECRET`；未读取值。 |

## 生产发布与复核

- `2026-09-25T06:27:45Z` 通过 Wrangler 4.139.0 发布，无 D1 迁移执行、无生产数据写入。
- Worker 版本：`85b9c977-b006-4950-b726-d595a3bbaa9d`；路由 `erp.huangqidong.cn/*` 与 `pc-backend.563838884.workers.dev`。
- `node scripts/check-web-release.mjs https://erp.huangqidong.cn/` 返回 HTTP 200，生产页面引用的 JS/CSS 文件名与本地构建一致：`index-BNqtmelw.js`、`index-CNOUpwcm.css`。
- 未登录 HTTP 核查：`GET /api/v2/workbench` 为 401，`GET /api/auth/me` 为 401，退役接口 `GET /api/quotes` 为 410。
- Wrangler 部署状态复核为该版本 100% 流量；生产 D1 迁移清单仍无待应用项。

## 未完成范围

- 没有使用生产账号登录；员工页面级权限、真实业务流程与发布候选整体验收仍未完成。
- 生产应用附件上传/授权下载的 R2 canary、完整 D1/R2 备份恢复及 Worker 回退仍未验证。
- 此前公开显示过的 PDD 供应商密钥仍需由凭据管理员轮换；本次只确认 PDD 名称未出现在生产 Secret 清单，没有读取密钥值。
- 小程序没有提交微信工具上传、审核或发布。
- 保留所有已有未提交源码改动；本次未提交 Git。
