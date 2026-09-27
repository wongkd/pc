# U01 · 二手配件库存读取

- 日期：2026-09-27。
- 状态：本地实现与定向验证通过；未部署、未连接生产数据；不代表 U03 页面或 U05 正式验收。
- 需求入口：[任务方案](../../plans/2026-09-27-used-parts-inventory/README.md)、[实施任务](../../plans/2026-09-27-used-parts-inventory/implementation.md)。

## 实现范围

新增 `GET /api/v2/inventory/stock-items`，走现有库存路由和 `inventory/view` 权限：

- 按 `category`、商品型号 / SKU、逐件内部编号、SN、备注搜索；查询直接跨全部匹配型号，不受商品页 100 行窗口影响。
- `items` 返回真实门店自有逐件实物，按 `assetCode + id` 稳定排序和游标分页；`quantityProducts` 单独分页读取有正自有在库余额的数量型号。两个游标各自绑定当前登录门店和关键词、类别、成色、库存桶筛选，跨门店或跨筛选复用会明确返回 400。
- `totals` 对完整筛选结果计算；`categoryCounts` 忽略所选类别、保留其余筛选；`availabilityCounts` 忽略所选库存桶、保留其余筛选。三者都不受两个分页游标或 `limit` 影响。逐件页、数量型号页、两类 facet 与总数在同一 D1 batch 中读取。
- 数量模式只从 `stock_balances` 汇总；逐件模式只计真实 `stock_items`。统计明确分列 `quantityTrackedQty`、`itemCount` 和库存桶数量；不把数量余额伪造成逐件行，也不重复累计逐件商品的余额。
- 只计自有在库 `available / reserved / quarantine`，不含客户保管、在途、已售和退役。`condition` 仅对数据库中有成色字段的逐件实物生效；数量余额不会被推断为新品或二手。
- 成本列在无 `inventory/cost-view` 权限时不查询、不返回。检测状态没有独立字段；响应不包含检测结论，也不从 `availability` 或 `inspection_ref` 推造。

## 定向验证

| 检查 | 结果 |
|---|---|
| `node --test --test-concurrency=1 backend/tests/u01-inventory-read.test.mjs` | 6/6 通过：类别筛选、逐件分页、数量型号独立分页、全量统计与分类 facet 口径、105 型号目标搜索、SN / 编号搜索、数量 / 逐件语义、真实成色筛选、两类游标跨门店 / 跨筛选拒绝、未登录 / 门店隔离 / 成本权限、并发筛选与参数校验。数据仅写入本地内存 D1。 |
| `npm.cmd --prefix frontend test -- src/features/workbench/WorkbenchInventoryPage.test.tsx` | 31/31 通过：包含现有筛选晚到响应保护。本轮未把新接口接入页面。 |
| `frontend/node_modules/.bin/tsc.cmd -b --pretty false` | 通过。 |
| 后端 TypeScript `tsc -p backend/tsconfig.json --noEmit` | 未能运行通过：本工作区未安装 `@cloudflare/workers-types`，TypeScript 报 TS2688 缺类型定义；定向 Worker HTTP 测试已实际构建并执行该路由。 |
| `node contracts/tools/generate-d10-contract.mjs --check` | 通过；v2 生成物、后端和网页副本一致。 |
| `node contracts/tools/validate-contracts.mjs` | 通过 3608 项；9 条既有提示不阻断。 |
| `node contracts/tools/generate-dto.mjs --check`、`node frontend/scripts/sync-contracts.mjs --check`、`node contracts/tools/check-client-parity.mjs` | 均通过；v1.1 端内生成物和客户端一致性通过。 |

未运行全仓测试、生产登录、生产迁移、部署或浏览器页面验收。浏览器页面仍使用原 R06 商品汇总读接口；U03 接入尚未开始。

## 下一步与边界

等待用户确认[U02 检测状态与同型号补录选项](../../plans/2026-09-27-used-parts-inventory/u02-decision-review.md)。在状态模型确认前，U01 只返回真实 availability 库存桶数量，不提供“待检测 / 已检测”等数量。随后单独做 U02；页面接入属于 U03；本回执不宣称 U05 完成。
