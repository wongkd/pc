# F3 · 采购取消（B37）与采购付款（B33）

更新：2026-09-22。状态：**已完成并通过验收**（后端测试 + 契约门禁 + 端到端 HTTP）。
本记录只证明本次本地隔离环境的结果，不代表生产状态。

## 目标

1. **B37 取消采购**：把采购单里「尚未到货」的数量取消掉，且**不改写订购量**——采购恒等式
   `ordered = received + rejected + cancelled + pending` 由到货明细与取消事件共同派生，历史永远可回溯。
   取消必须逐采购行给数量与原因；已到货 / 已拒收的数量不属于可取消范围（即使后来退供 B38 也不回到可取消）。
2. **B33 采购付款**：`/finance/payments` 支持 `purchase:<采购单号>`，能对采购单登记真实资金流水
   （部分付款、超付拒绝、幂等、可追溯），并让账本能按采购单查到这笔钱。

## 入口与命令

| 项 | 内容 |
|---|---|
| 取消采购 | `POST /api/v2/inventory/purchases/:id/cancel`，权限 `inventory/purchase-cancel` |
| 采购付款 | `POST /api/v2/finance/payments`，`sourceDocument` 取 `purchase:<id>` 或 `{ kind:'purchase', id }`，权限 `finance/payment`（老板专属） |
| 采购读模型 | `GET /api/v2/inventory/purchases`、`GET /api/v2/inventory/purchases/:id`（R08，含应付 / 已付 / 剩余应付） |
| 账本读模型 | `GET /api/v2/finance/overview`、`GET /api/v2/finance/entries`（R12） |
| 后端测试 | `node --test --test-concurrency=1 backend/tests/f3-purchase-cancel-http.test.mjs`、`.../f3-purchase-payment-http.test.mjs` |
| 端到端验收 | `node docs/verification/2026-09-22-F3-purchase-cancel-payment/verify-f3.cjs` |

## 本轮实际验证

### 2026-09-24 网页补验

- 本地浏览器创建 5 件、单价 ¥300 的采购单，登记部分付款 ¥500 后，剩余应付正确显示 ¥1,000；再付 ¥1,100 被服务端以“超收、超退或超出可退现金上限”拒绝，输入保留。
- 对已有净付款的采购单取消 1 件，被服务端明确拒绝并提示先处理付款冲销，未伪造自动退款。
- 另建 3 件、单价 ¥200 的未付款采购单，取消 2 件成功：订购量仍为 3，在途 3→1，应付 ¥600→¥200。
- 尚未补权限、断网/超时重试、付款冲销后取消和远端/生产浏览器验收。

| 检查 | 结果 |
|---|---|
| 后端全套测试 | **311 用例 / 311 通过 / 0 失败**（原 307；本卡新增 B37 4 项） |
| 契约校验 `validate-contracts.mjs` | **3464 通过 / 0 失败**（原 3450，+14） |
| `generate-dto --check` / `frontend sync-contracts --check` / `miniprogram sync-contracts --check` | 三处生成物与 `contracts/v1` 逐字节一致 |
| `check-client-parity` / `sync-error-codes --check` | 通过（18 个错误码两端一致） |
| `check:migrations` | 0000–0023 连续无缺号，下一个 **0024** |
| 端到端 HTTP 验收 | **42 项 / 0 失败**（`report.json`） |

验收覆盖（A 段 B37 / B 段 B33）：

- 取消 2 件 → `cancelledQty=2`、在途 5→3、`qtyOrdered` 仍为 5、进度仍「尚未到货」；
- **应付基数随取消收缩**：5 件 → 3 件，应付 60000 → 36000 分；
- 同 requestId 重放 → 复用同一 operationId、不重复落台账；改载荷 → 409 `IDEMPOTENCY_MISMATCH`；
- 到货 2 件后再取消 2 件 → 422 `PURCHASE_CANCEL_EXCEEDED`；取消最后 1 件在途 → 在途 0、进度「到货完成」；
- 部分付款 8000 → 再付 8000 → 超付 5000 被 422 `BALANCE_EXCEEDED` → 付清 4000 → 剩余应付 0；
- 账本 `direction=out` 三笔均 `allocationType='purchase'` 且 `allocationId` 命中该采购单，合计 20000 分；
  账本应付净减 20000 分；
- **已有净付款 → 取消被 409 `PURCHASE_PAYMENT_CONFLICT` 拒绝，且不落台账**；
- 成本未知的采购单应付计 0、登记付款 → 400 且提示「成本未知」；不存在的采购单 → 404。

## 改动范围

**领域与路由**（`backend/src`）

- `domains/purchase.ts`：B37 领域（`cancelPurchase` / `planCancelPurchase`、台账插入、逐行超量守卫、
  `PURCHASE_PAYMENT_CONFLICT` 前置判定）。**2026-09-22 13:55 由并行会话写入，本卡负责验收与收尾。**
- `routes/purchase-v2.ts`：`handlePurchaseCancel` + 精确路径认领（仍不抢 `/inventory` 其它路径）。
- `domains/access.ts`：`inventory/purchase-cancel`，旧码等价 `library/edit`。
- `domains/finance.ts`：采购付款 `payPurchase` / `planPayPurchase`（并行会话写入）+ 本卡两处修复（见下）。

**迁移**（`backend/migrations`）

- `0023_purchase_cancellations.sql`：建 `purchase_cancellations`，逐采购行记录取消事件；
  `UNIQUE(store_id, request_id, purchase_line_id)` 保证同请求同行只落一条；`reason` 六值 CHECK。

**契约**（`contracts/v1`，单点区，本卡独占修改）

- `enums.json`：`ActionCode` 补入 **B37**（值列表 + desc 说明 + `pending` 销项，剩 B39/B40）。
- `legacy-mapping.json`：`tables` 登记 `purchase_cancellations`（`targetObjects: ["Purchase"]`）、
  `sources` 补 0023、`revisionNote` 记录本次修订。
- `actions.json` / `errors.json`：B37 由 `supplementaryActions` 的 reserved 提升为 `frozen` 正式动作；
  新增 `PURCHASE_CANCEL_EXCEEDED`（422）与 `PURCHASE_PAYMENT_CONFLICT`（409）。
  （2026-09-22 14:22 由并行会话写入，本卡复验并补齐登记。）
- 生成物：`contracts/generated`（6 件）、`frontend/src/contracts/generated`（6 件）、
  `miniprogram/contracts/generated`（6 件）、`backend/src/generated/error-codes.ts` 全部重新生成。
- 未提升 `contractVersion`：没有改动任何既有 action 取值、目标对象名与校验规则。

**测试**

- `tests/f3-purchase-cancel-http.test.mjs`（本卡新增 4 项）：恒等式与进度派生、不改写订购量、幂等重放与改载荷、
  已到货不可再取消、取消不动已入库可用量、取消收缩应付基数、净付款冲突、
  无权限 403 / 旧码 `library/edit` 放行 / 跨店 404 / 入参校验。
- `tests/f3-purchase-payment-http.test.mjs`（并行会话写入 2 项，本卡修正 1 处断言）。

## 本轮修掉的两个真问题

### 1. `guardStatement` 极性写反，导致「成本齐全」的采购单一律付不了款（阻断级）

`finance.ts` 的采购付款计划里，守卫写成了：

```
guardStatement(db, 'VALIDATION_ERROR',
  `NOT EXISTS (SELECT 1 FROM purchase_lines WHERE ... AND (cost_known <> 1 OR unit_cost_cents IS NULL))`, ...)
```

而 `guardStatement` 的语义是**条件为真即中止**（`INSERT INTO assertion_guards SELECT ? WHERE <条件>`，
触发器 `RAISE(ABORT, code)`）。所以上面这条是「**没有**成本未知的行 → 中止」，把正常单子全拦死。

为什么它没被更早发现：`payPurchase` 在计划之前还有一道**同义的前置检查**（`unknown_cost_lines > 0` → 400），
成本未知的单子在更早处就被带文案拦住了，守卫永远走不到；而成本齐全的单子一定走到守卫并被反着拒掉。
现象是「成本未知的用例通过、正常付款用例失败」——测试结果的**方向恰好相反**，很容易被误读成测试写错。

修复：条件改为 `EXISTS (...)`，并在代码里写明这条守卫的极性要求。

### 2. R12 账本流水读模型丢了 `allocation`，账本里查不到「这笔钱挂哪张单」

契约 `objects.json` 的 `CashEntry` 明确有 `allocation`（订单 / 采购 / 回收 / 维修分摊），
`cash_entries` 也有 `allocation_type` / `allocation_id` 两列，但 `queryFinanceEntries` 只返回了
`sale_order_id`。后果是：销售收款看得出挂在哪张销售单，**采购 / 回收 / 维修付款在账本里全都断链**
（这几类的 `sale_order_id` 都是 NULL），应付与回收对账无从下手。

修复：`FinanceEntryRow` 与流水查询补上 `allocationType` / `allocationId`（纯读模型扩展，不改写动作、不改契约）。

## 与并行会话的关系（重要）

本卡动的是**单点区**（`contracts/v1`、生成物、`migrations`）。开工前的状态是：并行会话在 13:45–14:22
写了 B37 的契约提升、迁移与后端代码后停手，`validate-contracts.mjs` 失败 1 项（0023 未登记 mapping）、
生成物未重新生成、`f3` 测试 2 项失败。本卡接手前确认 **14:25 之后无任何文件被改写**后才动手。
`0023` 迁移头注释原写「F4 · B37」，与 F2 回执、OPEN-ITEMS 的口径（**F3 = 采购取消 + 采购付款**）不一致，
已校正为 F3。

⚠️ **连带效应（正常，不是回退）**：本卡改了共享契约文件（`enums.json`、`legacy-mapping.json`）与
`backend/src/domains/access.ts`，这些文件也在 E11 / E12 / F1 的回执 evidence 里，因此它们的 evidence mtime
被连带前移、进度台会显示「回执待复核」。按既定规矩，消解方式是**由原负责会话重跑门禁后刷新自己的 `updatedAt`**，
本卡不代其他模块回报、不改它们的状态。

## 未做 / 未验证

- 网页采购取消与付款入口已在后续前端卡接入并完成上述本地浏览器主路径；独立对账/发票和完整异常矩阵仍未做。
- `finance-api.ts` 的类型未补 `allocationType` / `allocationId`（显示层当前没用这两个字段）。
- 取消**不退已付款**：存在净付款时直接 409 拒绝，付款冲销（反向分录）没有并入取消动作——契约 notes 已明写本首版不合并。
- 采购付款**没有独立对账/发票**概念，`verification_state` 恒为 `unverified`。
- B39（报损）、B40（价格调整）仍是 `reserved`。
- 未跑微信真机；未访问生产；未部署；未应用远端迁移
  （`0023` 远端应用状态未核实）。

## 2026-09-25 本地权限、并发与付款冲销后取消补验

- HTTP 用例现覆盖取消无权限、跨店隔离、并发超量取消最多一笔成功；两笔并发付款不能突破剩余应付；权限错误不产生副作用。
- 补齐一条连续链：同一采购单登记两笔付款，分别以 B34 反向分录完整冲销；只冲销一笔时净付款仍大于零，B37 取消被服务端拒绝；两笔都冲销后净付款归零，才允许取消未到数量。原付款与冲销分录均保留，不自动执行或声称供应商现金退款。
- 采购页结果未知提示现在可按请求编号查询；pending/查不到时保留表单，成功后刷新采购数据，终态失败显示原因并释放该请求的本地 pending 键。页面回归覆盖未知新建采购 → 查询确认失败 → 保留表单并显示失败原因；幂等核心回归覆盖同载荷重试沿用 requestId，以及终态只清除对应请求。
- 实际执行：`node --test --test-concurrency=1 backend/tests/f3-purchase-cancel-http.test.mjs backend/tests/f3-purchase-payment-http.test.mjs`，相关 9 项全部通过。
- 前端目标回归：`npm --prefix frontend test -- --run src/api/core.test.ts src/features/workbench/WorkbenchPurchasePage.test.tsx`，30/30 通过。
- 此补验为本地隔离 Worker/内存 D1 HTTP 证据；采购表单完整浏览器故障注入、远端/生产仍未验证。
