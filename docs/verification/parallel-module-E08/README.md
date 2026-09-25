# E08 并行协作记录

- **负责人**：本对话（E08 装机、检测与交付）。
- **认领文件**：`backend/src/domains/assembly.ts`、`backend/src/routes/sales-v2.ts`（E08 段）、`backend/migrations/0016_sale_fulfillment.sql`、`backend/tests/e08-fulfillment-http.test.mjs`、`frontend/src/features/workbench/{fulfillment-api,fulfillment-view,WorkbenchFulfillmentPage,fulfillment.css}` 及两个前端测试、`docs/verification/E08-current/*`、`docs/verification/progress/E08.json`。
- **依赖**：E06（sale_orders / B05 / B08）、E04b（stock_items / inventory_movements / 0007 触发器）、E07 无关。
- **进度**：后端 + 契约 + 迁移 + 前端页面完成，本卡测试全绿；前端路由未接线（待总集成）。详见 `docs/verification/E08-current/README.md`。
- **冲突声明**：未发现其他并行模块的 `parallel-module-*` 记录；本卡只在 `sales-v2.ts` 内追加 E08 路由，未改动公共接线文件。
