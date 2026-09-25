# F1 · 附件基础（B35）

日期：2026-09-22。状态：**后端已落地并通过验收**（契约 + 迁移 + 领域 + 路由 + 测试 + 端到端 HTTP）。
本卡不含前端页面（B35 的 uiRefs 是「接修」「回收」，读取由对应详情卡接入）。

## 目标与边界

交付**附件基础设施**：签发上传意图 → 写入字节并校验 → 关联业务对象 → 孤立上传回收。

它本身不产出面向店员的界面。它的消费者是：

- **接修（E10）**：客户设备外观 / 故障照片
- **回收（E11）**：验机证据
- **待检件判定（B19）**：检测证据（尚未实现，本卡先把它需要的能力准备好）

## 入口

| 类型 | 位置 |
|---|---|
| 契约 | `contracts/v1/actions.json`（B35）· `objects.json`（Attachment）· `enums.json`（三个枚举 + 状态机）· `legacy-mapping.json`（attachments 表登记） |
| 迁移 | `backend/migrations/0022_attachments.sql` |
| 存储适配器 | `backend/src/domains/storage.ts` |
| 领域 | `backend/src/domains/attachment.ts` |
| 路由 | `backend/src/routes/attach-v2.ts` |
| 权限 | `backend/src/domains/access.ts`（`ATTACHMENT_PERMISSIONS` + 旧码等价） |
| 接线 | `backend/src/index.ts` · `backend/wrangler.toml`（R2 绑定） |
| 测试 | `backend/tests/f1-attachments.test.mjs` |
| 验收 | `docs/verification/F1-current/verify-f1.cjs` |

接口（前缀 `/api/v2`）：

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/attachments/upload-intents` | 签发上传意图，返回一次性凭证与保留期 |
| PUT | `/attachments/upload-intents/:id/blob` | 写入文件字节（服务端实算 sha256 / 真实类型 / 大小） |
| POST | `/attachments/upload-intents/:id/complete` | 校验归属并关联为业务附件 |

## 契约修订（本卡动了契约规范面，四处）

这四处**必须一起改**，漏一处门禁就红（`validate-contracts.mjs` 有反向校验）：

1. **`enums.json`** 补 `stateMachines.AttachmentUploadState`。
   取值（pending/uploaded/attached/failed/orphaned）本来就有，**缺的是转换表** ——
   这正是契约里早已登记的缺口（`actions.json` 的 `stateMachineGaps`，owner = T16a）。
   转换：`pending→uploaded`、`pending→failed`、`uploaded→attached`、`pending/uploaded→orphaned`。
2. **`actions.json`** B35 的 `stateMachine` 由 `null` 改为 `AttachmentUploadState`；
   `operations` 补入 `PUT /attachments/upload-intents/:id/blob`（见下节）；
   `stateMachineGaps` 中 Attachment 那条**销案**并转入 `notAGap` 留痕。
3. **`objects.json`** `Attachment.tables` 由 `[]` 改为 `["attachments"]`。
4. **`legacy-mapping.json`** 新增 `attachments` 表登记，并把 `Attachment` 从
   `objectsWithoutLegacyTable` 移出；`sources` 补入 0022。

## 三个关键取舍

### 1. 文件字节走 Worker 中转，不用预签名直传

04 §5 只规定了「签发凭证」与「完成确认」两个端点，**文件字节的通道原本是留白**。
本卡补入第三条 operation `PUT /attachments/upload-intents/:id/blob`，由 Worker 经手字节。

理由：契约要求上传服务「校验类型、大小、归属」。若让客户端直传对象存储，服务端在完成确认时
要么把对象整个拉回来重算哈希（多一次流量），要么只能**相信客户端自报的 sha256** —— 那等于没校验。
走中转后，sha256、真实 mime（魔数嗅探）、实际字节数三项全部由服务端自己算。

代价是 2MB 过一遍 Worker，远低于请求体上限；对小店规模不构成问题。

### 2. 存储用 Cloudflare R2，但顾客端对外这条线划死

2026-09-22 栋哥拍板用 R2。理由：后端此刻就跑在 CF Workers 上，R2 是唯一有**原生绑定**
（零密钥、零配置）的对象存储；免费额度 10GB 存储 + 100 万写 + 1000 万读 + 出网流量免费，
按「每单 12 张 × 2MB」算够 400 单以上。

⚠️ **但 R2 的图片域名备不了案**（备案要求接入国内云资源）。而项目已定「后端终态迁腾讯云 CloudBase」，
理由正是小程序 request 合法域名必须 ICP 备案。
⇒ **顾客端（小程序）将来不能从 R2 取图**。因此 B35 响应里 `customerShareable` 恒为 `false`，
如实标注而不是假装可用。

迁云时只需在 `domains/storage.ts` 新增一个 COS 实现（接口不变），把 `wrangler.toml` 的绑定换掉，
业务代码一行不动。附件是存量数据，届时照片要跟着搬一次 —— 但那是「加适配器 + 搬数据」，
不是「改业务代码」。

### 3. 顺序固定为「先写对象存储，再更新 D1」

对象存储与 D1 不构成同一事务（04 §7 第 9 条）。两个方向都会出错，但错法不同：

- 先写存储后写库 → 失败留下**可被保留期回收的孤儿对象**（可补救）
- 先写库后写存储 → 失败留下**「记录说已上传、存储里却没有」**的假成功（不可补救）

所以本模块固定用前者。

## 「约束即断言」的两处落地

迁移里两条 CHECK 都用**单向蕴含**表达，而不是双向等价 —— 这是本卡实测踩出来的：

- `upload_state NOT IN ('uploaded','attached') OR (sha256/byte_size/content_type 均非空)`
- `upload_state <> 'attached' OR (owner_entity_type/owner_entity_id 均非空)`

写成双向等价（`(A) = (B)`）会让两类正常行被判非法：签发时的 pending 行带着「归属意图」，
以及从 uploaded 回收来的 orphaned 行仍保留实测元数据。第一版就是这样写的，**19 个用例里挂了 15 个**才暴露。

## 幂等与重复完成保护（两层）

1. **同 requestId 同载荷** → 走 `operations` 幂等记录直接复用原结果，不重复写。
   附件 id 由 `requestId` 派生（`${requestId}::att`），所以重放必然落到同一行。
2. **不同 requestId 但该附件已 attached** → 归属一致则按幂等返回；不一致则 `VERSION_CONFLICT` 拒绝
   （防止把别人已关联的附件改挂到别处）。

另外：已 `attached` 的附件**不能再覆盖内容**（PUT 字节返回 409）；写字节用条件 UPDATE
（`upload_state IN ('pending','uploaded')`），影响 0 行即视为并发冲突。

## 实测（本卡实跑）

| 检查 | 结果 |
|---|---|
| `npm --prefix backend test` | **287 通过 / 0 失败**（原 268 + F1 19） |
| `node contracts/tools/validate-contracts.mjs` | **3450 通过 / 0 失败**（原 3441，+9） |
| `node contracts/tools/generate-dto.mjs --check` | ✓ 生成物与 contracts/v1 一致（6 个文件） |
| `node frontend/scripts/sync-contracts.mjs --check` | ✓ 一致 |
| `node miniprogram/scripts/sync-contracts.mjs --check` | ✓ 一致（顺带修掉了此前 stale 的 manifest，即遗留项 P-A） |
| `node contracts/tools/check-client-parity.mjs` | ✓ 通过 |
| `node backend/scripts/sync-error-codes.mjs --check` | ✓ 一致（16 个错误码） |
| `node docs/verification/F1-current/verify-f1.cjs` | **28 项 / 0 失败**（HTTP 端到端） |

测试用例（19 个）覆盖：权限拒绝 · 旧码 `library/edit` 兼容 · 签发成功与参数逐项校验 ·
sha256 不符 · 真实类型与声明不符 · 白名单外内容 · 大小不符 · 请求头不符 · 凭证错误 ·
跨店隔离 · 完成确认 · 未上传即完成 · 幂等重放 · 重复完成保护 · 改挂拒绝 · 已关联后内容冻结 · 孤立回收。

验收脚本（28 项）覆盖两条 uiRefs 链路：**实物证据**（owner = 库存实物）与
**回收证据**（owner = 新建回收单）。

## 未验证范围（如实列出）

- **R2 真实读写未验证**：`wrangler.toml` 已声明绑定 `pc-attachments`，但**远端桶尚未创建**。
  远端未建桶时生产会回落到内存实现（响应里 `storagePersistent=false` 可见）。
  测试与验收跑的都是内存替身，验证的是**协议与规则**，不是 R2 的真实读写行为。
- **浏览器与视觉未验证**：本卡无新页面，没有截图可看。
- **孤立回收只做了惰性清理**：签发新意图时顺带扫本店过期行，不依赖定时任务。
  要精确排程需另加 CF Cron，不是本卡前置。清理上限每轮 50 条。
- **`listAttachedForOwner` 尚无 HTTP 路径**：读模型已实现（只返回 `attached` 行），
  但契约的读接口表里没有 `/attachments` 读路径。附件列表应由接修 / 回收的详情读模型带出，
  属对应详情卡的职责 —— 本卡不新增契约外协议。
- **`width` / `height` 未被服务端实测**：契约把两列列为可空，本卡按「客户端可选申报」处理
  （完成确认时可带），未做图片解码取真实尺寸。
- **微信真机、生产环境、远端迁移**均未触及。

## 对并行回执的连带影响（不是回退）

F1 改了若干**共享文件**：`contracts/v1/actions.json`、`enums.json`、`objects.json`、`legacy-mapping.json`、
`backend/src/domains/access.ts`、`backend/src/index.ts`。这些文件同时是 E10 / E11 / E12 回执的 evidence，
因此它们的 mtime 会晚于那些回执的 `updatedAt`，被 `check-receipts.mjs` 判为「待复核」。

这是后续卡改共享文件的**正常连带**，不是那些卡的功能回退。消解方式由各卡自己的会话负责：
重跑各自门禁后刷新 `updatedAt`。本卡**未代改任何其他回执的状态** —— 改状态而不复验等于伪造「已验证」。

## 上线前置（不在本卡范围）

1. **创建 R2 桶**并在部署前确认绑定生效；否则附件会落在临时内存里，进程一退就没了。
2. 前端「照片墙」与顾客端读图依赖**已备案域名**；`visibility=customer_shared` 在域名就绪前不可对外。
3. 新权限码 `attachment/upload` 在生产 `permissions` 表里没有种子迁移
   （与 `inventory/*` 同一情况），店员要能用需另行授权；旧码 `library/edit` 已等价兼容，
   现有门店角色不受影响。

## 下一步

- **B19（隔离件出 quarantine）**：需要检测证据 —— B35 已把挂附件到实物的能力准备好
  （`ownerEntityType: 'stock_item'` 可用）。
- **接修 / 回收详情接入附件读模型**：把 `listAttachedForOwner` 挂进 R09 / R10 的详情响应。
- 若要支持「拍照后稍后补关联」，当前保留期是 **24 小时**（`UPLOAD_INTENT_TTL_MS`），可按使用感受调整。

## 2026-09-25 权限、并发与失败重试补验

- HTTP 回归覆盖无 `attachment/upload` 权限拒绝、同附件并发完成只关联一次、冲突方复用原请求编号确认结果；原权限兼容与跨店隔离用例继续保留。
- 新增前端 API/组件回归：签发意图响应丢失后重用同一意图请求编号；完成响应丢失后只重试完成确认，不重复上传字节，并复用相同完成请求编号。面板保留当前文件并提供“重试当前上传”，永久性业务错误不显示盲目重试。
- 实际执行：`npm --prefix frontend test -- --run src/features/workbench/AttachmentPanel.test.tsx src/features/workbench/attachment-api.test.ts`（3/3）；`node --test --test-concurrency=1 backend/tests/f1-attachments.test.mjs`（20/20）。
- 未覆盖真实浏览器断网注入与 R2 跨进程持久化；预览仍未启用 R2，不能把内存替身结果当作远端存储证明。
