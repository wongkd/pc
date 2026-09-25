# E07 · 采购到货 —— 验证记录

日期：2026-09-21。状态：**已实现并通过后端与浏览器验收**。
前置：[E04b 库存](../2026-09-19-E04b-inventory/README.md)、[E06 收款与预留](../2026-09-21-E06/README.md)。
对应任务卡：[05 收款、采购、装机与交付](../../plans/2026-09-19-erp-first/ai-tasks/05-fulfillment.md) 子卡 05b。

## 本卡做了什么

把缺件采购这条线接通：下单 → 分批到货 → 拒收 → 退供。

| 动作 | 路径 | 权限 | 状态 |
|---|---|---|---|
| B14 创建采购与到货计划 | `POST /api/v2/inventory/purchases` | `inventory/purchase-create`（旧码 `library/edit`） | 契约既有 frozen |
| B15 登记实际到货与入库 | `POST /api/v2/inventory/receipts` | `inventory/receipt` | 契约既有 frozen |
| B38 退供 | `POST /api/v2/inventory/supplier-returns` | `inventory/supplier-return` | **本轮由 reserved 提升为正式动作** |
| R08 采购列表 / 详情 | `GET /api/v2/inventory/purchases` \| `/:id` | `inventory/view` | 契约既有 readAction |

页面入口：顶栏「库存」→ 旧深链 `/purchases`，或契约路径 `/inventory/purchases`（两条都指向同一页）。

### B38 的契约修订（按 B42 先例）

`supplementaryActions` 里的 `reserved` 条目被提升为 `actions.json` 主数组的 frozen 动作，
并把 `B38` 补进 `enums.json` 的 `ActionCode`。路径与权限码沿用旧登记值（`/inventory/supplier-returns`
与 `inventory/supplier-return`），未另起新名。B37（取消采购）、B39（报损）、B40（价格调整）
保持 reserved 未动。

## 放行证据（卡片原文 → 证据位置）

| 卡片要求 | 怎么证明的 |
|---|---|
| 5 件仅到 3 件，在途剩 2 | `backend/tests/e07-purchase-http.test.mjs`「采购 5 件只到 3 件 —— 在途剩 2，再补到齐」；浏览器验收断言表行「订购 4 / 实到 3 / 在途」并截图 |
| 拒收不进可用 | 同文件「拒收的件不进可用量，且计入采购恒等式」：4 件收 3 拒 1 → `available_qty` 只增 3，拒收不建 `stock_item`；浏览器验收另测 4 件收 3 拒 1 后可用量 = 3 |
| 来源成本可查 | 同文件「逐件商品必须给内部编号；来源成本与采购单可查」：实物上的 `acquisition_cost_cents = 12000`、`acquisition_ref` 指回采购单；快速采购也有自己的来源标识与成本 |

## 三条设计口径

1. **在途是算出来的，不是记上去的**：`purchase_orders` **刻意不设 status 列** ——
   `objects.json Purchase.notStored` 把这件事写成有意设计。进度永远是
   `pendingQty = orderedQty − receivedQty − cancelledQty` 的派生值，
   所以不可能出现「状态说到齐了、行说还差 2 件」。
2. **拒收的货从未进入自有在库**：只有 `inspection_disposition ∈ {available, quarantine}`
   才写库存流水；`return_to_supplier` / `scrapped` 既不建实物也不写流水，
   拒收量记在 `qty_rejected` 并计入采购恒等式，所以也不留下「还在途」的假象。
3. **快捷供应商 ≠ 没有来源**：`purchase_id` 为空时 `quick_purchase_note` 是必填（0014 的 CHECK），
   照样要写商品、数量、单件成本与成本是否已知；成本未知必须为 NULL，不写 0。

到货行没填成本时**继承采购行约定的成本**（采购单上谈好的价不必再抄一遍）——
两者不一致的唯一来源是显式覆盖，优先本次到货行给的值。

## 新增 / 修改范围

**契约（源文件，改完重新生成）**
- `contracts/v1/actions.json`：B38 从 `supplementaryActions` 提升到主 `actions` 数组；
  **legacyPermissionMap 的 25 处证据行整体 +4 并复验**
- `contracts/v1/enums.json`：`ActionCode` 补 `B38`；desc 同步说明
- `contracts/v1/objects.json`：Purchase / Receipt 增列实表
- `contracts/v1/legacy-mapping.json`：登记 0014 的五张新表
- 生成物已重新生成

**迁移**
- `backend/migrations/0014_purchase_core.sql`（新增）：`purchase_orders` / `purchase_lines` /
  `purchase_receipts` / `purchase_receipt_lines` / `supplier_returns`

**领域与路由**
- `backend/src/domains/purchase.ts`（新增）
- `backend/src/domains/access.ts`：新增 `PURCHASE_PERMISSIONS` 与 `inventory/view` 的旧码映射
- `backend/src/routes/purchase-v2.ts`（新增，**必须排在库存模块之前**被调用 ——
  它认领的路径都在 `/api/v2/inventory` 前缀下，排后面会被 `inventory-v2.ts` 的兜底 404 吃掉）
- `backend/src/index.ts`：分发行（与 E06 共用同一次 import 改动）

**前端**
- `frontend/src/features/workbench/purchase-api.ts`（新增）
- `frontend/src/features/workbench/WorkbenchPurchasePage.tsx`（新增，彩色版）
- `frontend/src/App.tsx`：`/inventory/purchases` 与 `/purchases` 两条路由
- `frontend/src/styles/erp-polish.css`：与 E06 共用的表格列宽与 dl 布局规则

**测试与验收**
- `backend/tests/e07-purchase-http.test.mjs`（新增，13 用例）
- `docs/verification/2026-09-21-E07/verify-purchase.cjs`（新增）+ `report.json` + 6 张截图

## 实跑与结果（2026-09-21）

```
npm --prefix backend test                          # 201 通过 / 0 失败
node --test tests/e07-purchase-http.test.mjs        # 13 通过 / 0 失败
node docs/verification/2026-09-21-E07/verify-purchase.cjs   # 14 检查项 / 0 失败
node contracts/tools/validate-contracts.mjs        # 3303 通过 / 0 失败
```

浏览器验收截图：空列表 → 建单 → **收 3 拒 1（进度变「到货完成」、在途归零）** → 退供成功 →
超量退供被拒 → 列表收尾。**截图已实际查看**：指标卡（订购 4 / 实到 3 / 拒收 1 / 在途 0 / 到货完成）
与明细表数字与后端一致。

## 实测缺陷（本轮发现并修掉）

1. **`queryPurchaseDetail` 查了不存在的列**：`purchase_receipt_lines` 没有 `name_snapshot`
  （名称属于采购行），导致采购详情 500。已改为从本采购单的行取名称。
2. **逐件到货的行级编号会误导**：一行到 3 件时，行级 `asset_code` 只能装下最后一个编号，
   看起来像只到了一件。已改为**只有这一行就一件时**才回填行级字段；多件时逐件明细在
   `stock_items` 里逐条可查。
3. **`acquisition_ref` 指错了对象**：原本记到货单，改为优先指回**采购单**（供应商、约定价、
   订购量都在那张单上），快速采购没有采购单时才记到货单。

## 已知缺口（不夸大，登记在此）

1. **取消采购（B37）未实现**，契约里仍是 `reserved`。代码里没有留半个入口。
2. **应付账未接**：B33（对外付款）属账本卡，本卡只记录采购带来的入库与成本，不产生付款流水。
3. **供应商只是文本**：契约里没有 `Supplier` 对象（G-11 供应商页面归属未定），
   所以「快捷供应商」实现为采购单上的名称快照 + 可空的 `supplier_ref`，不建 `suppliers` 表。
4. **分批到货的并发**未专门测试：两个客户端同时登记同一采购行时，超量守卫按「已处置 + 本次
   与订购量比一次」判定，理论上仍以同一批内的读数为准；未做跨实例压测。
5. 采购列表的 `scope=done` 只把「实到 + 拒收已齐」算作完成；本轮没有取消量，
   所以 `cancelledQty` 恒为 0。

## 未验证范围

- 未访问生产、未部署、未应用任何远端迁移（0004–0014 的远端状态仍未核实）。
- 未做微信端验收（采购是内部 ERP 功能，小程序端不涉及）。
- 窄屏只做了样式层面自适应，未逐项走查。

## 下一动作

- 本卡的链路本身未改；同一批的[补洞卡](../2026-09-21-E06E07-gapfix/README.md)修好了
  E06 的报价行商品引用与数量件预留 —— 那正是「订单缺口 → 建采购」能走通的前提。
- E08 装机与交付/零售（B04 / B06 / B07 / B10）。到货建出的 `stock_items`
  已经带 `acquisition_ref` 与成本，正是预留与交付要用的输入。
- 备选：先做 E09 取消退款与销售账本（到账款的正确性由它兜底）。
