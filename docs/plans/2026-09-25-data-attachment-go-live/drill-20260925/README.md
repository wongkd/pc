# 2026-09-25 隔离附件与数据演练回执

日期：2026-09-25 ｜ 状态：D1 迁移、R2 远端对象读写、合成一致点备份/恢复、SHA-256 核对及 Worker 版本控制面回退已完成；Worker HTTP 跨实例与并发演练未完成。本回执不代表应用端到端验收或生产放行。

## 范围与隔离资源

只使用本轮新建的 D1、R2 桶和 Workers.dev Worker。未访问或修改 `pc-db`、`pc-attachments`、现有预览 D1、预览 Worker、自定义域名或生产配置。附件字节和 D1 记录全部为合成夹具。

| 资源 | 名称 / ID | 用途 |
|---|---|---|
| 源 D1 | `pc-erp-drill-20260925` / `70b8bac3-330a-4f8a-9a21-e0e8553de622` | 迁移及源快照 |
| 源 R2 | `pc-erp-drill-20260925` | 远端对象读写 |
| 恢复 D1 | `pc-erp-drill-restore-20260925` / `f2df0c55-acba-4dd6-906b-a7d9195f678c` | 新资源恢复目标 |
| 恢复 R2 | `pc-erp-drill-restore-20260925` | 新资源附件恢复目标 |
| 源 Worker | `pc-erp-drill-20260925` | `DB` + 源 `BUCKET` |
| 恢复 Worker | `pc-erp-drill-restore-20260925` | 恢复 `DB` + 恢复 `BUCKET` |

Wrangler 为一次性 `npx wrangler@4.139.0`，未改依赖文件。账户管理员已在本轮开始后启用 R2。

## 已完成的远端演练

### D1 迁移

- `npm --prefix backend run check:migrations` 通过：29 项，编号连续覆盖 `0000–0028`。
- 源 D1 从空库远端应用 29 项迁移；远端查询 `d1_migrations` 得到 `29 / 0000_baseline.sql / 0028_document_export_attachments.sql`。
- 重复 `migrations apply` 返回 `No migrations to apply!`。

### R2 真实对象写读

- Wrangler 显示 `Resource location: remote`；把 72 字节合成 PNG 写入源桶，再从源桶下载回本机。
- 本地原文件与源桶回读文件 SHA-256 都为 `140327229d509b2c56ff22054152b942723a8a4781ef2bfb4b1d2cf79e673467`。
- R2 的真实对象 PUT/GET 已证实；这不是 Worker 绑定写入，也不证明附件 HTTP 响应报告 `storageKind=r2` / `storagePersistent=true`。

### 同一静止点 D1 + R2 备份和恢复

1. 源桶只由本演练写入一个受控对象；Worker 请求未成功进入，快照期间没有附件写入。先将同一 `object_key`、72 字节和 SHA 记录为源 D1 的合成 `attached` 夹具，随后导出 D1。
2. D1 远端快照时间为 `2026-09-25T01:15:11Z`。SQL 文件大小 `76,762` 字节，SHA-256：`07c0783fe63432eaaff29a0b5ea34081b2ec4eb7b06cb97a219f901c34b802073`。
3. 从源 R2 远端下载对象，再上传至恢复桶，并从恢复桶再次下载。恢复对象 SHA-256 与源对象及 D1 `attachments.sha256` 相同，字节数均为 72。
4. Wrangler 对原始全量 SQL 的直接导入在 `hardware` 数据行处报 `no such table: main.product_brands`；失败后确认恢复 D1 仍空。保留原始快照不变，改在新 D1 先应用相同 29 项仓库迁移，再从该快照按外键顺序恢复 6 条合成数据行（users、stores、store_members、hardware、stock_items、attachments）。这完成了逻辑数据恢复，但不是原始 SQL 文件一次性原样导入。
5. 源库和恢复库的远端核验均为 29 项迁移、1 条 `attached` 附件；附件关联的 `stock_items` 行存在；两边 `PRAGMA foreign_key_check` 都返回空集。

R2 CLI 对象上传/下载遵循 Cloudflare 的 [Wrangler R2 CLI](https://developers.cloudflare.com/r2/get-started/cli/)；完整对象批量清单通常经 [R2 S3 兼容接口](https://developers.cloudflare.com/r2/get-started/s3/)或 Worker `bucket.list()` 获取。

### Worker 绑定与回退

- 源 Worker `deploy --dry-run` 明确列出隔离 D1、源 R2 桶及 `REQUIRE_PERSISTENT_STORAGE=true`；恢复 Worker 同样列出恢复 D1、恢复 R2 桶及该变量。
- 源 Worker 从基线版本 `77827fc9-3809-4b83-bdb1-025f8474119b` 部署候选版本 `68197c63-3a52-40a7-b425-5abce1306fb7`，随后执行 Wrangler rollback。远端部署清单确认基线版本再次为 100%。
- 恢复 Worker 已部署到新资源；设置专用随机 `JWT_SECRET` 后，当前 100% 版本为 `8536bc77-7dbb-411b-941e-3326eb3c25a6`。密钥值未进入文档或日志。
- 回退证明的是 Worker 版本控制面操作成功。候选版本只改变演练标记变量，没有注入真实故障；回退后的应用健康与数据兼容性未通过 HTTP 验收。

## 未完成项与证据限制

- 源 Worker 的 `/health` 请求在本机收到 TLS unexpected EOF；恢复 Worker 请求报告无法建立 SSL 连接；此前 Wrangler 远程开发请求报告 `Network connection lost`。没有把本地模拟、远端绑定 dry-run 或 CLI 对象操作写成 Worker 请求证据。
- 尚未通过两个远端 Worker 实例完成附件签发/上传/跨实例读取、并发冲突及授权下载；应用端 `storageKind`、`storagePersistent` 未实测。
- `wrangler r2 bucket info` 在 PUT/GET 成功后仍报告两个桶 `object_count=0`、`bucket_size=0 B`。已验证对象能通过远端 GET 取回，但桶摘要与 GET 证据不一致；恢复只覆盖本轮唯一受控对象，完整对象清单仍需 Worker `bucket.list()` 或 S3/API 清单核实。
- 恢复 Worker 的实际 `/health`、附件服务读取及端到端回退健康检查都被上述 Workers.dev 网络问题阻塞。

## 时间与恢复指标

- 源 D1 快照：`2026-09-25T01:15:11Z`。
- 恢复 D1 创建：`2026-09-25T01:16:14Z`；源/恢复 D1、恢复 R2 最终远端核验：`2026-09-25T01:26:20Z`。数据/对象恢复闭环耗时约 **10 分 06 秒**；Worker HTTP 健康未通过，因此这不是完整服务 RTO。
- 对本轮静止的合成夹具，快照和恢复数据无差异，观测 RPO 为 **0 行 / 0 字节**。没有写入负载，不能据此推导线上或写入中断时的 RPO。

## 本机演练产物

临时配置、合成 PNG、原始 D1 SQL 快照、数据恢复副本及读回文件保存在 Git 忽略目录 `backend/.validation-data-attachment-drill-20260925/`。目录内含本地临时测试凭据，禁止提交或复制进文档。恢复与演练资源保留以便后续从远端 Worker HTTP 验证继续；后续只需补上述未完成项，不必重建已核验数据。

## 下一步

从可访问 Workers.dev 的网络重试 `/health`，再用两个独立 probe Worker 获取 `/db`、源/恢复 `/manifest` 与 `/object`；之后通过应用附件 API 并发上传并跨实例下载，检查 HTTP 持久存储标记、权限和 SHA。若本机仍无法访问，保留此断点并更换获准网络路径；不得把本地测试或 CLI 单对象读写替代这些证据。
