# 数据与附件上线保障

日期：2026-09-25 ｜ 状态：本地持久存储护栏与附件 HTTP 专项已验证；专用隔离环境已完成 D1 迁移、R2 CLI 对象读写、合成一致点备份/恢复、SHA-256 与 Worker 控制面回退。生产 `pc-db` 备份/克隆演练、0006–0028 迁移、R2/Worker 绑定与生产 Worker 发布已按接续操作完成；本轮复核当前版本、路由、D1/R2 绑定、迁移记录及外键。**生产 ERP 浏览器仍停在登录，员工页面/业务流程及应用层 R2 上传、授权下载、跨实例读写和完整恢复/回退未验，不代表生产业务验收或 RC 放行。**详见[生产运行与浏览器续验回执](../../verification/2026-09-25-production-runtime-browser-followup/README.md)。

生产资源只读核查另见[发布核查证据](../../verification/2026-09-25-production-release-readiness/README.md)；生产迁移与发布仍未放行。

## 目标与边界

正式 Worker 的附件接口必须绑定持久对象存储。配置 `REQUIRE_PERSISTENT_STORAGE=true` 后，若缺少 `BUCKET`，创建、写入、读取单据均返回 503，不创建内存附件。`dev:local` 和测试不设置此变量，仍可用内存 D1 / 内存附件。

附件由 D1 中的 `attachments` 元数据、权限及业务关系，与 R2 中按 `object_key` 定位的字节组成。备份和恢复需为同一时间点保存这两部分；附件字节校验使用每行 `sha256`。顾客端分享读取仍受备案域名限制，不因 R2 上线自动开放。

## 正式资源配置

1. 由资源管理员核实 Cloudflare 账户、`pc-db` D1 ID、生产 Worker、`pc-attachments` R2 桶实际归属与访问权限。配置中的名字和 ID 只是声明，不能代替账户实查。生产实际绑定已于 2026-09-25 在 Dashboard 复核，见本目录关联的生产续验回执。
2. 对照 `backend/wrangler.toml` dry-run 并检查产物，确认 `DB` 指向 `pc-db`、`BUCKET` 指向 `pc-attachments`、`REQUIRE_PERSISTENT_STORAGE` 为 `true`。不得将 `wrangler.preview.toml` 的测试 D1 替换进生产配置。
3. 部署前通过 `wrangler secret list` 核对 Worker 必需 secrets 的名称，不打印值；新增发布需先备齐 JWT 与业务所需密钥，避免发布时旧变量消失。
4. R2 绑定生效后做专用 canary：生成随机 key，PUT 随机内容，另一请求/实例 GET 并核对 SHA-256，再删除 canary。确认上传 API 返回 `storageKind=r2`、`storagePersistent=true`。不得用客户附件做 canary。
5. 生产 D1 已于 2026-09-25 在备份与克隆演练后应用 0006–0028；本轮只读查询确认 `d1_migrations` 有 0000–0028 共 29 条、`PRAGMA foreign_key_check` 为空。不要重跑迁移；后续生产数据变更仍须单独记录备份点、操作窗口、执行结果和回退条件。

## 备份策略

- D1：上线前及每日低峰导出 SQL；每次迁移前再导出一次。备份保存于受控、加密、与 Cloudflare 账户隔离的存储，限制访问并记录时间、数据库 ID、迁移号、文件 SHA-256。建议至少保留每日 30 份、每月 12 份；存储介质自身需启用版本/不可变保留。
- R2：生产对象桶配置异地/独立账户目的桶，用 S3 API 兼容客户端定时同步（例如 rclone），版本化或保留上一版本；禁止镜像删除直接传播到唯一副本。每轮记录对象数、总字节、同步时间及失败清单。同步账号只给源读、备份桶写权限。
- 一致性：每轮先记录 D1 导出完成时刻，再同步对象；暂停附件写入或用维护窗口取得静止点。恢复前根据 D1 当前清单与副本比较，确保所有 `attached` 元数据引用的对象都存在且 SHA-256 一致。无静止点时只能声明尽力恢复，并单独处理窗口期间新附件。
- 访问：凭据只放受控环境变量/密钥管理器，不放脚本参数、文档、终端回执或仓库。备份文件不得进入 Git。

示例（远端 D1 导出，目标路径应位于受控备份挂载点；先确认目标卷空间和权限）：

```powershell
npx wrangler d1 export pc-db --remote --output <受控备份路径>/pc-db-<UTC时间>.sql
Get-FileHash <受控备份路径>/pc-db-<UTC时间>.sql -Algorithm SHA256
```

R2 副本同步命令取决于运维选择的 S3 客户端及密钥管理方式，本仓库不保存凭据或虚构访问密钥。上线前需把实际命令、任务频率、保留策略填入受控运维手册并做一次完整同步验证。

## 隔离演练：迁移、并发、恢复、回退

全部使用新建且命名带 `drill-日期` 的 D1 与 R2 测试桶，禁止使用 `pc-db`、`pc-attachments`。当前 Wrangler 版本：4.139.0。

### 1. 迁移演练

```powershell
npm --prefix backend run check:migrations
npx wrangler d1 create pc-erp-drill-20260925
# 用隔离演练配置（其中 DB 的 database_name/id 必须换成刚创建的 ID）
npx wrangler d1 migrations list DB --remote --config <隔离演练专用wrangler配置>
npx wrangler d1 migrations apply DB --remote --config <隔离演练专用wrangler配置>
npx wrangler d1 migrations list DB --remote --config <隔离演练专用wrangler配置>
```

不能直接用当前 preview 配置执行创建以外的数据库动作：它绑定的是现有预览 D1。演练专用配置必须绑定刚建 D1、隔离 R2 桶及 `REQUIRE_PERSISTENT_STORAGE=true`；保存迁移前/后状态和 `d1_migrations` 内容。验证空库从 0000 顺序迁移至当前最高编号，再验证同一代码重复 apply 无未迁移项。

### 2. 跨实例并发

```powershell
node --test backend/tests/f1-attachments.test.mjs
```

新增用例在两个独立 Miniflare Worker 间共享 D1/R2：A 签发，B 写对象，并发完成，另一实例读取对象并比对元数据 SHA-256。通过条件为至少一个完成成功、其余仅允许版本冲突、D1 最终恰有一条 attached 状态、R2 对象字节与 SHA 一致。它验证适配器和业务并发，不等于 Cloudflare 多 PoP/全球边缘实测；远端需在隔离 Worker 上并行发请求重复该场景。

### 3. 恢复演练

1. 从隔离演练 D1 导出 SQL；把 R2 测试桶完整同步到另一隔离恢复桶，并保存两份校验清单。
2. 新建空恢复 D1，使用 `wrangler d1 execute <恢复库名> --remote --file <导出.sql>` 导入 SQL（不覆盖源库），确认迁移表、附件行数和业务主键约束。
3. 把恢复 Worker 配到恢复 D1 + 恢复 R2 桶；遍历全部 `attached` 附件，对象必须存在，下载后 SHA-256 必须等于 D1 的 `sha256`，抽查前端受权下载及跨店拒绝。
4. 记录 RPO（最后一致备份时刻与演练时刻差）和 RTO（开始恢复到验收通过耗时）、丢失/孤儿对象数、修复项。上线目标须由业务方确认；首轮先报告实测值，不宣称满足目标。

### 4. 回退演练

- 应用迁移前：恢复旧 Worker 版本即可；先确认该版本能兼容当前 schema 与对象布局。
- 只扩展 schema 的前向兼容迁移后：代码可回退，但保留新增 schema；不要把“代码回退”误称为“数据库回滚”。
- 破坏性/收缩迁移后：停止写入，部署兼容旧/新 schema 的过渡版本，或把备份恢复到新的 D1 并切换绑定；不可对现有 D1 盲目导入旧 SQL，以免覆盖后续交易。
- R2 对象采用不可变 key；回退代码版本不删除对象。若对象副本恢复，先在独立桶核验完成，再切 Worker 绑定。记录故障注入、切换时间、数据差异和恢复版本。

## 本轮已实现 / 尚待实跑

- 已实现：正式/预览配置 fail-closed；缺 R2 不落附件行并返回 503；附件 HTTP 并发完成覆盖通过，R2 测试绑定下响应标明 `r2` 与持久性。
- 本地实跑：`node --test backend/tests/f1-attachments.test.mjs` 22/22；`npm --prefix backend run check:migrations` 通过；`node scripts/check-doc-links.mjs` 234 个 Markdown、578 链接、0 断链。
- 远端部分实跑：[2026-09-25 隔离演练回执](drill-20260925/README.md)：专用 D1 已应用 29 个迁移；源/恢复 R2 已由 Wrangler 远端 PUT/GET 一条 72 字节合成对象；D1+R2 合成静止点已导出并恢复到新 D1/桶，迁移、归属、外键与 SHA 相符；Worker 基线版本回退控制面成功。
- 尚欠端到端实跑：两个远端 Worker 实例间的应用附件写读与并发、`storageKind=r2`/`storagePersistent=true`、恢复 Worker 健康/授权读取，以及 Worker `bucket.list()` 或 S3 API 的完整对象清单。本次续验中 `curl.exe` 与 Edge 对隔离 Workers.dev 的 `/health` 分别遇到 TLS 握手失败和 `ERR_CONNECTION_CLOSED`。源/恢复桶的控制面摘要现各报 1 个对象、100 B；两边 D1 同有 1 条 72 字节 `attached` 记录，精确 key 远端 GET 均与元数据 SHA-256 相符。该单对象对账见[HTTP 与对象清单续验](drill-20260925/worker-http-followup-20260925.md)；完整 API 清单及应用验收仍未通过，不得把 CLI 单对象读写或本地模拟写作应用跨实例通过。
- 生产执行与复核：[生产运行与浏览器续验回执](../../verification/2026-09-25-production-runtime-browser-followup/README.md)。按接续记录，`pc-db` 已备份、克隆演练并应用 0006–0028；`pc-attachments` 已创建；`pc-backend` 版本 `309b3528-ce24-42af-b335-74bca2bbaff3` 已部署，Dashboard 复核 workers.dev、`erp.huangqidong.cn/*`、D1 `pc-db` 和 R2 `pc-attachments`。本轮 D1 只读查询验证 29 条迁移记录与空外键检查；没有重复部署或写生产。
- 生产业务/附件仍未验：生产客户、库存、销售、售后、回收和附件计数为 0；quotes 表有 1 行但本轮未读取内容。ERP 页面停在登录页，未登录逐页浏览；未做生产附件上传、授权下载、R2 内容校验或跨实例 canary，也未执行完整生产备份恢复/Worker 回退。
- 本轮没有新建/修改 Cloudflare 资源、再次应用生产迁移、再次部署、导出或恢复生产数据；前序生产资源创建、迁移和发布结果以日期回执为准。

## 目录职责与下一步

本目录 README 是数据/附件上线保障任务入口；实测回执放本目录下日期子目录，不放密钥、客户附件或真实生产导出。专用演练桶、D1 与 Worker 保留供隔离续验。下一步先由用户在保留的 Edge ERP 标签自行登录；生产真实数据为空时只记录页面空态，不写测试业务记录。跨实例附件上传/读取、并发及授权下载仍应继续在专用隔离资源验证，并核对 Worker/S3 对象清单。生产附件 API canary、完整备份恢复与代码回退需另行安全安排；完成前不得把 T-13/V-02/V-03 标记完成，也不得把本地或隔离结果外推至生产。
