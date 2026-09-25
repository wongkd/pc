# E06 · 收款与预留 —— 验证记录

日期：2026-09-21。状态：**已实现并通过后端与浏览器验收**。
前置：[E05 报价闭环](../2026-09-19-E05-quote/README.md)、[E05b 顾客已确认](../2026-09-19-E05b-confirm/README.md)。
对应任务卡：[05 收款、采购、装机与交付](../../plans/2026-09-19-erp-first/ai-tasks/05-fulfillment.md) 子卡 05a。

## 本卡做了什么

把「报价 → 销售单 → 收款 → 占用实物」这条线接成可跑的闭环。契约动作全部是既有 frozen 条目，
本轮不新增动作编号：

| 动作 | 路径 | 权限 | 落点 |
|---|---|---|---|
| B03 报价转销售单 | `POST /api/v2/sales/quotes/:id/convert` | `sales/quote-convert`（旧码 `quote/edit`） | `domains/sale.ts` |
| B05 确认成交与补分配 | `POST /api/v2/sales/orders/:id/confirm` \| `/allocate` | `sales/order-edit` | 同上 |
| B08 登记销售收款 | `POST /api/v2/sales/orders/:id/payments` | `sales/order-payment` | 同上 |
| R04 销售单列表 / 详情 | `GET /api/v2/sales/orders` \| `/:id` | `sales/order-view` | 同上 |

页面入口：顶栏「开单」→ 域落地页「订单处理」，或直接 `/sales/orders`。
报价页详情新增「确认成交（转销售单）」按钮（B03 的 uiRef），转单后跳到订单处理页。

## 放行证据（卡片原文 → 证据位置）

| 卡片要求 | 怎么证明的 |
|---|---|
| 未付款不预留采购 | `backend/tests/e06-sales-http.test.mjs`「未付款不预留：收款前确认成交被拒绝，实物保持可取」；浏览器验收断言「未收款确认成交被拒，页面给出「未付款不预留」的原因」 |
| 重复收款只记一次 | 同文件「重复收款只记一次（同 requestId 复用结果）」：两次提交同一 requestId，`cash_entries` 只多一条 |
| 抢最后实物仅一单成功，失败单收款仍留账 | 同文件「两个订单抢最后一件实物」：A 单 200、B 单 409 `STOCK_CONFLICT`，**B 单的 `cash_net_cents` 仍为 15000 且有一条资金流水** |

## 三条硬边界在代码里的落点

1. **未付款不预留**：B03 一行库存都不写；占用只由 B05 写，且 B05 带一道定金闸 ——
   已核实收款 + 有效折抵必须达到条款里的定金比例（默认 15%），否则 `VALIDATION_ERROR`。
   门槛与当前已收都显示在界面上，不靠禁用按钮让人猜。
2. **抢最后一件**：逐件占用写 0007 的 `stock_reservations`，靠部分唯一索引
   `uq_stock_reservations_active_item` 兜底。这条路不查「还剩几件」，所以没有检查与写入之间的窗口。
3. **预留失败不吞掉已收的钱**：收款（B08）与预留（B05）是两次独立 `runIdempotent`、两个 batch。
   预留失败只回滚它自己那一批 —— 这是结构结果，不需要补偿代码。

金额口径：`total = subtotal − discount + adjustment`、`balance = total − cash − offset`、
`net_line = unitPrice × qty − discountAllocation` 全部写成表级 CHECK；
「不超收」写成带 `BALANCE_EXCEEDED` 的断言守卫（不写成 CHECK —— 契约允许 `store_due`，
一刀切会把那个枚举值变成死值）。优惠分摊按 money-rules 的「按占比向下取整 + 最大余数」实现。

## 新增 / 修改范围

**契约（源文件，改完重新生成）**
- `contracts/v1/objects.json`：SaleOrder / SaleLine / CashEntry 增列实表，Reservation 由 `[]` 改为 `stock_reservations`
- `contracts/v1/enums.json`：QuoteStatus 状态机补 `confirmed → converted`（B03）——
  E05b 新增 confirmed 态时没同步这条出口，而「顾客确认后成交」是主路径
- `contracts/v1/legacy-mapping.json`：登记 0013 的三张新表；三处说明更新
- 生成物已重新生成（`contracts/generated` + `frontend/src/contracts/generated`）

**迁移**
- `backend/migrations/0013_sales_core.sql`（新增）：`sale_orders` / `sale_lines` / `cash_entries`

**领域与路由**
- `backend/src/domains/sale.ts`（新增）
- `backend/src/domains/access.ts`：新增 `SALE_PERMISSIONS` 与旧码等价表
- `backend/src/routes/sales-v2.ts`（新增）
- `backend/src/index.ts`：+2 行 import、+6 行分发；**legacyPermissionMap 的 25 处证据行整体 +4 并复验**

**前端**
- `frontend/src/features/workbench/sales-api.ts`（新增）
- `frontend/src/features/workbench/WorkbenchSalesPage.tsx`（新增，彩色版）
- `frontend/src/App.tsx`：`/sales/orders` 路由；开单域落地页文案更新
- `frontend/src/features/workbench/WorkbenchQuotePage.tsx`：加 B03 入口（回调式跳转，不引入 router 依赖）
- `frontend/src/styles/erp-polish.css`：订单/采购两页的表格列宽与 dl 布局

**测试与验收**
- `backend/tests/e06-sales-http.test.mjs`（新增，16 用例）
- `docs/verification/2026-09-21-E06/verify-sales.cjs`（新增）+ `report.json` + 10 张截图

## 实跑与结果（2026-09-21）

```
npm --prefix backend test                          # 201 通过 / 0 失败（基线 172 + 本卡 16 + E07 的 13）
npm --prefix frontend test                         # 13 文件 152 用例（与基线同）
npm --prefix frontend run build                    # 通过
npm --prefix frontend run lint                     # 39 项既有失败（35 error + 4 warning），新增 0
node contracts/tools/validate-contracts.mjs        # 3303 通过 / 0 失败（基线 3239）
node contracts/tools/generate-dto.mjs --check      # 一致
node frontend/scripts/sync-contracts.mjs --check   # 一致
node docs/verification/2026-09-21-E06/verify-sales.cjs   # 29 检查项 / 0 失败
```

浏览器验收在**本地隔离环境**（真实 Worker + 内存 D1 + 真实 vite dev），
截图见 `screenshots/`：报价可转单 → 订单列表 → 订单详情（未付款）→ 确认被拒 → 收款 → 已确认 →
采购页建单 → 部分到货 → 列表收尾。**截图已实际查看**，确认彩色版渲染正常。

## 实测缺陷（本轮发现并修掉）

1. **优惠分摊算出 NaN**：`allocateDiscount` 的入参是 camelCase，而数据库行是 snake_case
   （`unit_price_cents`），直接传行对象会让折前金额变 NaN，写出的分摊额违反 `NOT NULL`。
   在 `planConvertQuote` 里做显式映射修掉。
2. **明细表整表破版**：`.wb-inv-head` 带 `display: grid`，我一开始把它误用在 `<thead>` 上，
   表头变 grid → 列头竖排成单字、金额被截断。去掉 thead 上的该类，并给这两页单独定列宽策略。
3. **动作成功提示被自己的刷新清掉**：`openDetail` 会清上一轮提示，而调用顺序是先提示后刷新。
   已把回执统一挪到刷新之后（订单与采购两页共 6 处）。
4. 测试夹具只 INSERT 实物、不写入库流水 → `stock_balances.available_qty` 是 0，
   首次占用就被 `CHECK (available_qty >= 0)` 拦下。这不是被测代码的问题，但**印证了 0007 的
   「实物游离在余额之外可被对账发现」**；夹具已补上流水。

## 已知缺口（不夸大，登记在此）

1. ✅ **已修复（2026-09-21 补洞卡）**：~~新品行没有商品映射~~ —— 根因是 E05 的 `QuoteLineInput` 收了
   `productRef` 但 `insertLineStatement` 没落库（`quote_lines` 当时也没这一列）。0015 补列后，
   报价行能携带商品引用，转单按 `hardware.entity_id` 解析；**解析不出就整次拒绝**，不再静默进缺口。
   见 [补洞卡](../2026-09-21-E06E07-gapfix/README.md)。
2. ✅ **已修复（2026-09-21 补洞卡）**：~~数量件占用未实现~~ —— 0015 重建 `stock_reservations` 支持
   `quantityBucketRef`，确认成交时按可用量占用（锁不满的部分才进缺口）。
   硬边界③「付定金即锁库存」对按量卖的新品同样生效。
3. **B03 只做冲突预检，不写占用**：`actions.json` B03 的 result 措辞提到「现货预留」，
   但 R07（未付款不预留）优先级更高，`enums.json` 的桶转换也把「成交预留」绑在 B05 上。
   预检之后到 B05 之间理论上有窗口，真正的硬闸在 B05 的唯一索引。
4. 本卡不做：B04 新建零售单（E08）、B10 交付、B11 取消、B17/B18 退货退款（E09）。

## 未验证范围

- 未跑微信开发者工具、未访问生产、未部署、未应用任何远端迁移（0004–0013 的远端状态仍未核实）。
- 未做真机验收与完整键盘序列；窄屏（390px）只做了样式层面的自适应，未逐项走查。
- 并发只测了「同进程顺序提交」下的争抢（靠唯一索引与 CHECK 兜底），未做跨实例压测。

## 下一动作

- ✅ 本卡的两个已知缺口已于 2026-09-21 由[补洞卡](../2026-09-21-E06E07-gapfix/README.md)修复
  （报价行商品引用 + 数量件预留）。浏览器验收脚本随之更新，现为 **32 项**（新增数量件锁定与缺口准确性检查）。
- 下一步：顾客侧分享页（Q-09，依赖 T03a）；或 E08 装机交付/零售（B04/B06/B07/B10）。
- 若先做 E08：本卡的 `sale_orders.configuration_version` 与 `sale_lines.stock_item_id`
  已经是它要用的两个锚点。
