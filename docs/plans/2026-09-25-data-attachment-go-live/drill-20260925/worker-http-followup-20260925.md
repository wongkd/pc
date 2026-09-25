# 2026-09-25 隔离 Worker HTTP 与对象清单续验

日期：2026-09-25 13:50 UTC ｜ 状态：R2 单对象与恢复对象逐项匹配；应用层验收仍被 Workers.dev 连接失败阻断。

## 隔离范围

仅访问 `pc-erp-drill-20260925` 与 `pc-erp-drill-restore-20260925` 的 D1、R2 和 Workers.dev 地址。没有访问或写入生产 `pc-db`、`pc-attachments`，也没有部署、迁移或修改 Cloudflare 资源。

## R2 清单续核

- 源桶和恢复桶的 Wrangler 远端摘要都返回 `object_count=1`、`bucket_size=100 B`。这更新了原演练时 `0` 对象的摘要；历史结果保留在[原演练回执](README.md)中。
- 两边 D1 只读查询各返回一条相同的 `attached` 合成附件：
  - Key：`attachments/store-9801/drill-attachment-20260925.png`
  - D1 字节数：72
  - SHA-256：`140327229d509b2c56ff22054152b942723a8a4781ef2bfb4b1d2cf79e673467`
- Wrangler 从源桶和恢复桶分别按该 key 远端 GET，读回文件各为 72 字节，SHA-256 均与 D1 元数据相同。两次 D1 查询元数据均为 `changed_db=false`、`rows_written=0`。
- 因摘要对象数为 1，且 D1 唯一 key 在源桶与恢复桶都能读回并匹配，已完成这条合成记录的数量与内容对账。尚未从 Worker `bucket.list()` 或 S3 ListObjects API 取得逐对象清单；`bucket_size=100 B` 与 D1 / GET 的 72 字节不同，差异原因未核实。因此仍不把它记作独立 API 全量清单通过，也不据此排除清单接口视角下的孤儿对象。

读回文件仅在 Git 忽略目录 `backend/.validation-data-attachment-drill-20260925/`。未将文件或凭据复制进仓库文档。

## Worker HTTP 与应用附件验收

- 对源 Worker 与恢复 Worker 的 `/health` 分别用 `curl.exe` 请求，均在 TLS 握手阶段失败：`schannel: failed to receive handshake, SSL/TLS connection failed`。
- Edge 对源 Worker `/health` 的单次直接访问显示 `net::ERR_CONNECTION_CLOSED`。没有绕过证书或安全提示，也没有将失败当成应用响应。
- 隔离应用 B 的既有部署清单为 100% 流量，配置绑定源 D1 与源 R2；但 Workers.dev 请求不可达，无法通过应用 API 验证上传、第二 Worker 读取、授权/跨店拒绝、并发完成结果，或 `storageKind=r2` / `storagePersistent=true`。
- 恢复 Worker `/health` 和应用授权读取没有 HTTP 结果，恢复服务健康状态仍未知。Wrangler CLI 成功 GET 对象不等于 Worker 运行时健康或应用端上传通过。

## 下一步

需要一条获准且能连接 `*.workers.dev` 的网络路径，继续访问源、B、恢复 Worker。先取得 `/health` 与 `bucket.list()` / S3 完整清单，再用合成附件完成应用签发、上传、跨 Worker 读取、权限拒绝、并发与持久化标记；之后验证恢复 Worker 健康及授权读取。继续只用本回执列出的隔离 D1/R2，不做生产演练。
