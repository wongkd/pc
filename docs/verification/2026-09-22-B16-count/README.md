# B16 · 盘点录入与差异批准

更新：2026-09-22。状态：**已完成并通过验收**（后端测试 + 契约门禁 + 端到端 HTTP）。
本记录只证明本次本地隔离环境的结果，不代表生产状态。

## 目标

1. **录入盘点（保存实盘）**：`POST /inventory/counts` —— 把人工实盘结果记下来，
   **不直接改库存**（02 §5）。录入时锁存当时账面（`book_qty`），供批准时算差异。
2. **批准差异**：`POST /inventory/counts/:id/approve`（老板专属）—— 逐行按
   `diff = counted_qty − book_qty` 写 `source='count_adjustment'` 的库存流水，
   由 0007 的余额触发器结算 `stock_balances`。批准前库存分毫不动。

契约把这两件事编在同一个编号 B16 下，但**两条路径、两个权限码**：
录入归 `inventory/count`（旧码 `library/edit` 等价），批准归 `inventory/count-approve`
（`legacySource=null`、`grantPolicy=owner_only`，旧宽权限不得自动获得）。

## 入口与命令

| 项 | 内容 |
|---|---|
| 录入盘点 | `POST /api/v2/inventory/counts`，权限 `inventory/count` |
| 批准差异 | `POST /api/v2/inventory/counts/:id/approve`，权限 `inventory/count-approve`（老板专属） |
| 结果查询 | `GET /api/v2/operations/:requestId`（R14，若响应丢失可据此确认结果） |
| 后端测试 | `node --test --test-concurrency=1 backend/tests/b16-count-http.test.mjs` |
| 端到端验收 | `node docs/verification/2026-09-22-B16-count/verify-b16.cjs` |

请求体（录入）：

```json
{
  "requestId": "…",
  "scope": { "asOf": "2026-09-22T01:00:00.000Z", "note": "全店盘点" },
  "lines": [{ "productRef": "商品 entity_id", "countedQty": 7, "note": "货架第三层" }]
}
```

请求体（批准）：`{ "requestId": "…", "reason": "批准差异理由（必填）", "expectedVersion": 1 }`

## 本轮实际验证

### 2026-09-24 网页补验

- 本地浏览器对主板录入实盘 2（原账面 3），保存草稿后页面明确提示“保存实盘不改动库存”，库存仍为 3。
- 点击批准后提示 1 行生成差异调整，库存总量 16→15、该主板 3→2，证明网页没有把“保存”误当“批准”。
- 权限、账面并发变化后的 409、断网/超时重试及远端/生产浏览器仍未验收。

| 检查 | 结果 |
|---|---|
| 后端全套测试 | **334 用例 / 334 通过 / 0 失败**（原 311；本卡新增 `b16-count-http.test.mjs` 23 项） |
| 契约校验 `validate-contracts.mjs` | **3476 通过 / 0 失败**（原 3464，+12） |
| `generate-dto --check` / `frontend sync-contracts --check` / `miniprogram sync-contracts --check` | 三处生成物与 `contracts/v1` 逐字节一致 |
| `check-client-parity` / `sync-error-codes --check` | 通过（18 个错误码两端一致） |
| `check:migrations` | 0000–**0024** 连续无缺号（25 文件），下一个 **0025** |
| 端到端 HTTP 验收 | **37 项 / 0 失败**（`report.json`） |

验收覆盖（`verify-b16.cjs`，走真实登录与真实 HTTP）：

- **★ 保存实盘不直接改库存**：B13 期初 10 件 → 录入实盘 7 → R06 仍读回 **10**；
  录入响应 `effects.stockTouched=false`，且没有任何 `count_adjustment` 流水；
- **★ 批准后余额 == 实盘值**：批准 → R06 读回 **7**，流水 `from_bucket='available'`、`qty=3`、`source='count_adjustment'`；
- 盘盈：账面 0 的商品实盘 2 → 批准后余额 2（`to_bucket='available'`）；
- 幂等：同一 `requestId` 重放批准 → 200 且复用同一实体版本，余额只被调整一次；
- 重复批准（换 `requestId`）→ 409 `VERSION_CONFLICT`，余额不变；
- **★ 账面已变 → 409**：录入后余额被另一次盘点批准改过（5 → 4），再批准原单被 409 拒绝，
  且**没有生成任何调整**（余额仍为 4）——这是「截止序号对齐」的实际效果；
- 入参：空 `lines` / 负实盘 / 空理由 → 400；不存在的盘点单 → 404；两个路径 `GET` → 405。

## 改动范围

**迁移**（`backend/migrations`）

- `0024_inventory_counts.sql`（新增）：建 `inventory_counts`（表头：`status` draft/approved、
  `as_of` 截止时点、`scope_note`、批准理由/批准人/批准时间、`version`、两个 `requestId`）与
  `inventory_count_lines`（`book_qty` 锁存账面 + `counted_qty` 实盘 + `adjustment_movement_id` 回填）。

**领域与路由**（`backend/src`）

- `domains/inventory.ts`：`validateCountInput` / `validateCountApproveInput` / `planCount` / `createCount` /
  `planCountApprove` / `approveCount`，`INVENTORY_PERMISSIONS` 补 `count` 与 `countApprove`。
- `routes/inventory-v2.ts`：`parseCountInput` / `parseCountApproveInput` / `countWriteResponse` /
  `handleCountWrite` / `handleCountApproveWrite`，两条路径认领 + 局部旧码等价表补 `inventory/count ← library/edit`。

**契约**（`contracts/v1`，单点区）

- `legacy-mapping.json`：`tables` 登记 `inventory_counts` / `inventory_count_lines`
  （`targetObjects: ["InventoryMovement"]`）、`sources` 补 0024。
  `actions.json` / `enums.json` / `objects.json` **未改**（B16 早已 frozen，`count_adjustment` 已在 16 值枚举内）。

**测试**（`backend/tests`）

- 新增 `b16-count-http.test.mjs`（23 项）；`lib/inventory.mjs` 的 `CLEAN_ORDER` 补两张新表（先删行再删表头）。

## 三条口径（实现前定的，不是事后补的）

1. **为什么建这两张表而不建「盘点单」契约对象**：契约 B16 的 `effects` 只有
   `InventoryMovement / StockBalance / AuditEvent`，**没有独立盘点单实体**；
   `legacy-mapping` 的 `objectsWithoutLegacyTable` 里一直挂着「盘点单（T06c 定义，枚举待补）」。
   因此这两张表按**支撑事件表**登记（与 `purchase_cancellations` 挂 `Purchase` 同一处理），
   **不新增契约对象、不改 contractVersion**。
2. **为什么差异用锁存账面算，而不是批准时重算**：重算会把「录入之后发生的正常出入库」
   一起吞进调整额，账面从此说不清。锁存 + 「账面已变就 409 要求重盘」是保守且可解释的做法
   （03 §7 的截止序号对齐）。
3. **为什么状态闸门写在 `plan` 的守卫里而不是入口 JS 里**：批准成功后 `status` 就从
   `draft` 变 `approved`，若在入口用 JS 判断，合法的「同 ID 重放」会被误判成「重复批准」。
   幂等分支先行返回，走到 `plan` 的一定是新请求 —— B19 实测踩过一次同类坑。

## 未做与边界（不得当成已完成）

- 库存页的盘点入口与批准按钮已在后续前端卡接入并完成上述本地浏览器主路径。
- **只做数量口径盘点**：`CountLine` 按 `productRef` + `countedQty` 盘 `available_qty`。
  **逐件实物（`tracking_mode='item'`）的明细盘点未做** —— 找不到实物、发现账外实物这两类
  需要实物级盘查的形态，仍要靠 B19 判定 / 后续报损（B39）处理。
- **只盘 `available` 桶**：`reserved` / `quarantine` 数量的盘点未做（差异只调 `available`）。
- **不做「盘点期间冻结」**：账面已变时报 409 让操作人重盘，而不是锁库停业盘点。
- **B39 报损仍是 `reserved`**：盘差与报损的语义关系（任务清单 P-04）本卡未涉及，
  实现时刻意没有越界去动 B39；盘亏只走 `count_adjustment`，不生成报损单。
- **远端未核实**：0024 的远端应用状态未核实；本轮**未部署、未应用远端迁移、未提交**。
- **生产权限种子仍缺**：`inventory/count` / `inventory/count-approve` 在生产 `permissions`
  表里没有种子迁移，店员与老板角色要能用需另行授权（与既有 `inventory/*` 同状）。
- 未跑微信真机；网页权限与完整异常矩阵仍未验收。

## 首跑踩到的坑（留给后人）

- **验收脚本的幂等用例设计错**：拿一张**已经批准过**的盘点单，换个新 `requestId` 去「重放」，
  测出来的是 409「重复批准」，不是幂等（首跑 1 项失败）。
  正确测法是「盘点单**首次批准就用**这个 `requestId`，再用同一字符串重放」。
  这与 F3 那条教训同源：**幂等用例必须复用同一个 `requestId` 字符串**，且必须让第一次请求就走这个 id。
  另注意实现侧的正确性由此被反向确认：已批准的盘点单换个新 id 批准，确实会 409。

## 2026-09-25 本地权限、并发与失败重试补验

- 后端 HTTP 回归覆盖：无权限/录入与批准权限分离、旧权限映射、账面改变后批准返回 409、并发批准仅一笔生效、幂等重放和跨店隔离。
- 前端发现并修复：每次点“保存实盘”都重新生成 `asOf`，结果未知后相同输入会生成不同载荷，无法复用原 `requestId`。现在一个盘点草稿生命周期固定快照时间；结果未知时显示查询入口并保留实盘输入。
- 定向页面回归覆盖“结果未知 → 查询确认查不到 → 不改内容重试”，两次提交载荷（含 `asOf`）完全相同；`inventory/count` 账号可保存，但无 `inventory/count-approve` 时看不到批准按钮。
- 实际执行：`node --test --test-concurrency=1 backend/tests/b16-count-http.test.mjs`；`npm --prefix frontend test -- --run src/features/workbench/WorkbenchInventoryPage.test.tsx -t "结果未知后保留盘点快照时间"`，通过。
- 这证明本地 HTTP/组件行为；未做浏览器网络故障注入、生产权限种子核验或远端/生产验收。数量盘点范围和保留桶边界仍按上文限制。
