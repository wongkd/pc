# E08 · 集成说明（供总集成接线）

> ✅ **状态更新（2026-09-21）**：总集成已完成。第 1 节的路由接线已落到 `App.tsx`（import + `/sales/fulfillment` Route 各一行），第 7 节检查全部复跑通过，第 8 节「迁移编号 0016」已复核未被占用。第 8 节其余缺口（B09 / B19 / CustomerDevice / B35）仍未实现，各自独立成卡。以下保留原集成说明备查。

本卡**不修改**公共接线文件（`backend/src/index.ts`、`frontend/src/App.tsx`、`erpNavigation.ts`、`app/navigation.ts`、`styles/erp-polish.css`、`docs/STATUS.md`、`docs/NEXT-SESSION-PROMPT.md`）。后端入口无需改动（路由加在已有的 `sales-v2.ts` 内）；前端只有**一行**路由要接。以下是把 E08 接进主链路的完整清单。

## 1. 前端路由（唯一必须改的接线点）

文件：`frontend/src/App.tsx`

```tsx
// 1) 顶部 import 区新增一行
import { WorkbenchFulfillmentPage } from './features/workbench/WorkbenchFulfillmentPage'

// 2) <Routes> 内、/sales/orders 之后新增一条
<Route path="/sales/fulfillment" element={<WorkbenchFulfillmentPage permissions={profile.permissions} />} />
```

导航入口（可选，等栋哥定）：`frontend/src/erpNavigation.ts` 或顶栏「开单」落地页，建议 label「装机与交付」、path `/sales/fulfillment`、权限提示 `sales/order-view`。

## 2. 后端路由 —— 无需改入口

B04 / B06 / B07 / B10 已全部接在 `backend/src/routes/sales-v2.ts` 内（同一前缀，`routeSalesV2` 已由入口分发）。路径与权限：

| 动作 | 路径 | 权限码（新） | 旧码等价 |
|---|---|---|---|
| B04 建零售单 | POST `/api/v2/sales/orders` | `sales/order-edit` | `quote/edit` |
| B06 备料装机 | POST `/api/v2/sales/orders/:id/start-assembly` | `sales/order-assembly` | `quote/edit` |
| B07 装机检测 | POST `/api/v2/sales/orders/:id/checks` | `sales/order-assembly` | `quote/edit` |
| B10 确认交付 | POST `/api/v2/sales/orders/:id/deliver` | `sales/order-deliver` | `quote/edit` |
| R04 详情+看板 | GET `/api/v2/sales/orders/:id` | `sales/order-view` | `quote/view` |

- `sales/order-assembly` 的旧码等价已登记在 `backend/src/domains/access.ts` 的 `LEGACY_EQUIVALENT`（`quote/edit`，契约 grantPolicy=default）。
- R04 详情响应新增 `fulfillment` 字段（契约 R04 的 result 本就是「完整处理视图」，uiRefs 含「办理交付」），前端旧页忽略该字段即可。

## 3. 数据库迁移顺序

`backend/migrations/0016_sale_fulfillment.sql` —— 依赖 0000–0015，**追加式**，只新建 `sale_checklists` / `sale_deliveries` 两张表与索引，不改任何既有表。

> ⚠️ 编号说明：本卡按「迁移由底座统一编号」的要求，**没有抢占编号** —— 但为让本卡可测，编号 0016 是当前迁移目录里最大的下一个空号。若总集成 / 底座有并行模块另分配了 0016，请整体重命名本文件并同步 `contracts/v1/legacy-mapping.json` 里两条登记的 `definedIn` 字符串。

## 4. 契约改动（已做完并重新生成）

- `contracts/v1/objects.json`：`Checklist.tables` / `TestRecord.tables` = `["sale_checklists"]`，`Delivery.tables` = `["sale_deliveries"]`。
- `contracts/v1/legacy-mapping.json`：新增 `sale_checklists`、`sale_deliveries` 两条登记，`Checklist` / `TestRecord` / `Delivery` 移出 `objectsWithoutLegacyTable`。
- `contracts/v1/enums.json`（2026-09-21 收尾补）：`InventoryMovementSource.values` 新增 `inspection_quarantine`（检测隔离）；0007 迁移 `inventory_movements.source` 的 CHECK 与后端 `MOVEMENT_SOURCES` 同步补齐；前端/小程序端 `MOVEMENT_SOURCE_LABELS` 各加「检测隔离」标签。
- 已跑 `generate-dto.mjs` 与两端 `sync-contracts.mjs` 重新生成；`validate-contracts.mjs` 3322 通过 / 0 失败。

## 5. 共享样式 / 设计变量

本卡新增的局部样式在 `frontend/src/features/workbench/fulfillment.css`（只作用 `.wb-fulfillment-page`），**不碰** `erp-polish.css`。若总集成要统一收口，请把其中 `.wb-gate-list` / `.wb-gate-dot` 迁入公共样式，本卡不改。

## 6. 与其他模块的依赖

- 复用 E06 的 `sale_orders` / `sale_lines` / `stock_reservations` 与 `B05`（确认成交占用）、`B08`（收款）。
- 复用 E04b 的 `stock_items` / `inventory_movements` / 0007 触发器（扣库靠它）。
- 交付里的 `CustomerDevice`、检测附件、欠款交付（B09）分别交给 E10 / B35 / E09；故障件隔离已实现逐件隔离（来源 inspection_quarantine），隔离件「出 quarantine」的判定交库存域 B19 —— **本卡不越界**（详见 `README.md` 未验证清单）。

## 7. 集成后必须补跑的检查

```
npm --prefix backend test
npm --prefix frontend test
npm --prefix frontend run build
node contracts/tools/validate-contracts.mjs
node contracts/tools/generate-dto.mjs --check
node frontend/scripts/sync-contracts.mjs --check
node contracts/tools/check-client-parity.mjs
node backend/scripts/sync-error-codes.mjs --check
node scripts/check-doc-links.mjs
```

接上 `/sales/fulfillment` 路由后，补跑浏览器验收（起 `dev:local` + vite，看真实页面），并复核：
1. 订单详情能否进「装机与交付」面板；
2. 备料 / 检测 / 交付三个动作在真实页面上的加载、失败、空、无权状态；
3. 交付按钮的六项闸门逐条显示是否正确。

## 8. 底座缺口（阻塞项，不伪造完成）

| 缺口 | 影响 | 归属 |
|---|---|---|
| 前端路由未接（App.tsx 禁改） | 页面不可达，浏览器验收未跑 | 总集成 |
| 迁移编号 0016 可能被并行模块占用 | 需核对重命名 | 底座 / 总集成 |
| ~~库存流水来源缺「检测隔离」值~~（已补 inspection_quarantine） | B07 已实现逐件坏件隔离；隔离件「出不了 quarantine」的 B19 待检件判定仍缺 | 库存域 B19 |
| B09 批准欠款交付未实现 | 欠款交付不可用（明确拒绝） | E09 |
| CustomerDevice 未建（E04-DEVICE） | 交付不写设备归属 | E10 |
| B35 附件上传未实现 | 检测不能挂照片 | 附件卡 |
