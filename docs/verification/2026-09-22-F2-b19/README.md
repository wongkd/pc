# F2 · 隔离件判定 B19 —— 验证记录

- **日期**：2026-09-22
- **卡面**：F2「隔离件判定 B19」
- **状态**：✅ 已交付（后端契约路径 + 领域逻辑 + 测试 + 端到端验收），**未部署、未提交**
- **范围**：`POST /api/v2/inventory/items/:id/inspection`
- **不做**：前端页面（按既有做法留给栋哥用 ChatGPT 做）、报废 / 退供的独立动作、整备动作 B30

## 1. 这是什么问题

E08 的 B07「检测不通过」会把坏件从 `reserved` 打进 `quarantine`（来源 `inspection_quarantine`），
但此前**没有任何动作能把隔离件移出去** —— 隔离件「进得去出不来」。B19 就是那个出口：待检件判定，
只允许两条合法去向（`enums.json` `inventoryBucketRules.transitions` 明写）：

| 去向 | 语义 | 库存后果 |
|---|---|---|
| `quarantine → available` | 验机通过放回可卖 | 待处理 -1、可卖 +1，**在库总量不变** |
| `quarantine → retired` | 拒收退供或报废离店 | 待处理 -1、**可卖量分毫不动** |

## 2. 契约依据（本卡**未改契约**）

| 契约件 | 已具备的内容 |
|---|---|
| `actions.json` B19 | 路径 `/inventory/items/:id/inspection`、权限 `inventory/inspection`、inputs（result/findings/evidence/disposition）、errors（INSPECTION_REQUIRED / OWNERSHIP_INVALID / VERSION_CONFLICT）、`status: frozen` |
| `enums.json` `inventoryBucketRules.transitions` | `quarantine→available`（B19，「不再新增一次总库存」）、`quarantine→retired` |
| `enums.json` `InspectionResult` | `pass` / `fail` |
| `enums.json` `InventoryMovementSource` | `inspection_release`（0018 迁移已补进 CHECK） |
| `objects.json` `StockItem` | `version`、`inspectionRef` 字段（0007 迁移已建列） |
| `objects.json` `AuditEvent` | 检查事实的落地载体（见下） |

⇒ B19 的契约在动工前已经完备，**本卡无需改 `contracts/v1`、生成物或 `index.ts` 接线**。

## 3. 两个关键设计决策（2026-09-22 栋哥拍板）

### 3.1 检查记录存哪里 → **复用 `audit_logs`**

契约 B19 的 `effects` 只有 `StockItem` / `StockBalance`，**没有 Inspection 实体**。
因此检查事实（结果 / 发现 / 证据 / 处置 / 操作人 / 版本）写 `audit_logs`（契约 `AuditEvent`），
`stock_items.inspection_ref` 回填本次判定的逻辑 id：`<requestId>::inspection`。

- 不新建业务表、不改契约 —— 也因此**完全不碰单点区**（`contracts/v1`、生成物、`index.ts`、`migrations`），
  能与并行进行的其他卡安全共存。
- 代价（如实登记）：检查记录不是一等实体，将来要做「检测报告页」需从 `audit_logs` 捞取。

### 3.2 附件门槛 → **放行必须带有效附件**

`disposition = available`（放行可卖）时，`evidence` 至少一条，且每条都必须是**服务端已实测**的有效附件：

- 存在 + 同店 + `upload_state = 'attached'` + `owner` 指向本实物（0022 的 CHECK 保证 attached 必有 owner）。

没有有效证据就想放行 → **422 `INSPECTION_REQUIRED`**（不是 400：它拦的是「没验机就想上架」，不是「填错字段」）。
`retired`（报废）不强制附件，但**一旦引用了 evidence 就同样逐条核实**，不许拿假 id 充数。

## 4. 改了什么

| 文件 | 改动 |
|---|---|
| `backend/src/domains/inventory.ts` | 新增 B19 领域实现：`InspectionInput` / `validateInspectionInput` / `planStockInspection` / `inspectStockItem` / `verifyInspectionEvidence`；补 `INVENTORY_PERMISSIONS.inspection`；**补 `MOVEMENT_SOURCES` 缺失的 2 值**（`recovery_acquisition` / `inspection_release`，此前常量只有 14 值而契约与迁移是 16 值） |
| `backend/src/routes/inventory-v2.ts` | 新增 B19 路由分支（**排在实物详情之前**，否则 `ITEM_PATH` 的 `(.+)` 会吞掉 `/inspection`）；权限映射补 `inventory/inspection ← library/edit`；新增 `parseInspectionInput` / `handleInspectionWrite` |
| `backend/tests/f2-inspection.test.mjs` | 新增，18 项 |
| `docs/verification/2026-09-22-F2-b19/verify-b19.cjs` | 新增端到端验收（真实 HTTP） |
| `docs/verification/2026-09-22-F2-b19/README.md` | 本文件 |

**未改**：`contracts/v1`、`contracts/generated`、`frontend`、`miniprogram`、`index.ts`、`migrations`。

### 4.1 两处实现要点（都会静默出错，写下来备查）

1. **幂等必须排在状态检查之前。** 判定成功后实物已不在 `quarantine`；若先查状态，
   合法的「同 ID 重放」（网络超时后客户端重发）会被误判成「重复判定」而 422，
   违反契约 `Operation.rules`「同 ID 同载荷返回原结果」。故入口先查幂等记录（`queryOperation`）再走业务闸门。
2. **命名避歧义。** B19 的处置去向常量命名为 `INSPECTION_RELEASE_BUCKETS`（值 `available` / `retired`），
   **不是** `INSPECTION_DISPOSITIONS` —— 后者在 `domains/purchase.ts` 里是契约枚举 `InspectionDisposition`
   （5 值收货去向，含退供 / 退客）。两者语义不同，同名会误导后人。

## 5. 怎么验证的

### 5.1 后端测试（`backend/tests/f2-inspection.test.mjs`）—— 18 / 18 通过

覆盖：鉴权 401、权限 403、旧码 `library/edit` 等价、GET 405；
放行（`quarantine→available` + 余额守恒 + 审计可追溯）；报废（`→retired` 且可卖量不动）；
证据门槛（无附件 / 附件不存在 / 附件挂别件 / 未完成上传 / 别店附件一律 422）；
重复判定 422、跨店 404、版本冲突 409、幂等重放、处置值非法 400、findings 空 400；
来源无关（`conversion` 回收拆件 / `purchase_receipt` 采购待检 / `return_receipt` 退货待处理都能判定）。

```
node --test tests/f2-inspection.test.mjs     # 18 通过 / 0 失败
```

### 5.2 端到端验收（`verify-b19.cjs`）—— 37 / 37 通过

真实 HTTP 走完整链路：B12 建逐件商品 → B15 快速采购到货（`disposition=quarantine`）→
R06 查回隔离件 → B35 上传并关联验机证据 → B19 判定。逐项对应验收重点：

- ✅ 隔离件可以放行（`quarantine→available`，写 `inspection_release` 流水）
- ✅ 报废不会重新进入可卖库存（可卖量前后一致）
- ✅ 同一个实物不能重复判定（再判 422 `INSPECTION_REQUIRED`）
- ✅ 没有必要附件时不能强行通过（无附件 422、假证据 422，且实物留在待检）

```
node docs/verification/2026-09-22-F2-b19/verify-b19.cjs   # 37 通过 / 0 失败
```

### 5.3 门禁

| 检查 | 结果 |
|---|---|
| `backend/tests` 全量 | 307 用例 / 305 通过 / 2 失败；**2 项失败均为并行会话 F3 自己的新测试**，见 §6 |
| `generate-dto.mjs --check` | ✅ 生成物与 contracts/v1 一致 |
| `sync-contracts.mjs --check` | ✅ 端内生成物一致 |
| `validate-contracts.mjs` | ⚠️ 失败 1 项 —— **不是本卡**，见 §6.2 |

## 6. 未验证 / 已知口子（如实登记）

### 6.1 完整后端套件的失败与并行会话干扰

- 首轮全量（13:43–13:49）出现 1 项失败：`e11-recovery-http.test.mjs` 的 `B33 付款`。
  **经核实与本卡无关**：该文件**单独运行 12 / 12 通过**；失败时段正有并行会话在写文件（§6.2），
  判为「并行写入打断文件读取」的干扰（本会话自身也遇到过同类现象：一次改名操作打断过全量运行）。
- 复跑全量（13:51–13:57）：**307 用例 / 305 通过 / 2 失败**。两项失败均为
  `tests/f3-purchase-payment-http.test.mjs`（F3 采购付款，该文件创建于 13:57、**会话仍在进行中**），
  属那个卡自己的中间状态。**本卡的 18 项在这两次运行里全部通过**；首轮那项 B33 干扰未复现。
- 本卡对 E11 / F3 的改动面为零（未碰 `finance`、采购付款、契约或入口）。

### 6.2 并行会话与单点区（重要）

本机当时**至少有两个其他会话在动单点区文件**：

| 会话 | 产物 | 时间 |
|---|---|---|
| F1 附件基础（B35） | `migrations/0022_attachments.sql`、`routes/attach-v2.ts`、`domains/attachment.ts`，改 `index.ts` 接线与 `contracts/v1/enums.json` | 13:21–13:33 |
| F3 采购取消 + 采购付款 | `migrations/0023_purchase_cancellations.sql`、`tests/f3-purchase-payment-http.test.mjs` | 13:45–13:57（进行中） |

`validate-contracts.mjs` 的 1 项失败即来自后者：新迁移表 `purchase_cancellations` **尚未登记进
`contracts/v1/legacy-mapping.json`**（那个卡还在做）。**这是它的中间状态，本卡不应代改**
（改 `legacy-mapping.json` 属单点区，会与之撞车）。

⇒ 收工时 `validate-contracts` 不是全绿；**等 0023 卡收尾并登记 mapping 后复跑应恢复全绿**。
本卡自身的契约侧（生成物一致性）已通过。

### 6.3 其他口子

- **前端未做**：`/inventory` 页面的「判定放行 / 报废」入口未实现（按既有做法，前端可由栋哥用 ChatGPT 做）。
  本卡交付的是契约路径 + 服务端行为。
- **检查记录读取接口未做**：`inspection_ref` 已回填、`audit_logs` 有记录，但没有专门的「读取某件检测历史」
  接口；R07 详情的 `movements` 里能看到 `inspection_release` 流水，`audit_logs` 需另查。
- **报废后是否要生成独立单据**（如报损单）未做：本卡只做桶转换 `→retired`；
  契约里 `StockAdjustmentReason` 仍是 `pendingEnums`。
- **`retired` 可逆性**：契约无 `retired → *` 的回头路，误报废只能靠盘点调整（`count_adjustment`）。

## 7. 结论

B19「隔离件出 quarantine」已实现并通过全部本卡验收（后端 18 项 + 端到端 37 项，0 失败）。
隔离件现在可以放行可卖或报废离店，余额守恒由结构保证，重复判定与假证据都拦得住。
契约未改，单点区未碰。

## 2026-09-25 网页退役入口补验

- 前端回归覆盖隔离实物详情填写检测发现后，不提供附件也可提交 `result='fail' / disposition='retired'`；提交携带实物当前版本，确认“无附件”只限制放行，不误拦报废退役。
- 后端专项 18/18 通过，已有覆盖判定权限、旧权限映射、跨店隔离、版本冲突、幂等、退役不增加可卖库存、报废无需附件及伪造附件拒绝。
- 新增页面回归命令：`npm --prefix frontend test -- --run src/features/workbench/WorkbenchInventoryPage.test.tsx -t "有检测发现但没有附件时仍可提交报废退役"`，1/1 通过。
- 这是本地组件/HTTP 证据；没有做浏览器现场退役操作或远端/生产验收。
