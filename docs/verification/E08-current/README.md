# E08 · 装机、检测与交付（B04 / B06 / B07 / B10）

更新：2026-09-21（总集成收尾）。状态：**后端 + 契约 + 迁移 + 前端页面均已完成并通过本卡测试；网页路由已接线（`/sales/fulfillment`），浏览器验收通过**。

## 本卡做了什么

- **B04 创建零售与直接销售单**（`POST /api/v2/sales/orders`）：生成 `draft` / `waiting_stock` 的销售单，**不写任何库存**；新品必须选商品、二手必须指定实物、客供件售价 0 数量 1；整单优惠按 money-rules 分摊。
- **B06 开始备料与装机**（`POST /api/v2/sales/orders/:id/start-assembly`）：`waiting_stock → preparing → testing` 两段推进；守卫「已成交 + 店有件占齐 + 客供件已接收」；备料不改变任何库存桶。
- **B07 保存装机检测结果**（`POST /api/v2/sales/orders/:id/checks`）：结论由检查项**派生**（有 fail 即 failed、全 pass 即 passed、否则 incomplete）；passed → ready_delivery；failed → 回 waiting_stock，失败的检查项若指向具体实物则**逐件坏件隔离进 quarantine**（来源 `inspection_quarantine`）、其余占用整单释放回可用桶；支持增量合并（契约 changedItems 语义）。
- **B10 确认交付**（`POST /api/v2/sales/orders/:id/deliver`）：六项闸门逐项核（已成交 / 到交付阶段 / 货占齐 / 需 SN 已绑定 / 检测通过 / 款项结清）；交付一个 batch 里同时写交付记录 + reserved→sold 流水 + 实物 sold + 占用 consumed + 成本快照，**扣库一次**。

## 验证命令与结果（本轮实跑）

| 命令 | 结果 |
|---|---|
| `npm --prefix backend test` | **224 通过 / 0 失败**（基线 208 + 本卡新增 16） |
| `npm --prefix frontend test` | **15 文件 165 用例通过**（基线 152 + 本卡新增 13） |
| `npm --prefix frontend run build` | 通过（tsc -b + vite build） |
| `npm --prefix frontend run lint` | 39 项既有失败（35 error + 4 warning），**本卡新增 0** |
| `node contracts/tools/validate-contracts.mjs` | **3322 通过 / 0 失败**（基线 3309 + 本卡新增 13） |
| `node contracts/tools/generate-dto.mjs --check` | 通过 |
| `node frontend/scripts/sync-contracts.mjs --check` | 通过 |
| `node contracts/tools/check-client-parity.mjs` | 通过 |
| `node backend/scripts/sync-error-codes.mjs --check` | 通过 |
| `node scripts/check-doc-links.mjs` | 通过（0 断链） |
| `node docs/verification/E08-current/verify-e08.cjs` | **25 项通过 / 0 失败**（端到端 HTTP，见 `verify-report.json`） |

## 证据

- 迁移：`backend/migrations/0016_sale_fulfillment.sql`（`sale_checklists` / `sale_deliveries`）
- 领域：`backend/src/domains/assembly.ts`
- 路由：`backend/src/routes/sales-v2.ts`（B04 / B06 / B07 / B10 + R04 详情带 fulfillment 看板）
- 后端测试：`backend/tests/e08-fulfillment-http.test.mjs`
- 前端：`frontend/src/features/workbench/{fulfillment-api,fulfillment-view,WorkbenchFulfillmentPage,fulfillment.css}.{ts,tsx,css}` + 两个测试文件
- 端到端：本目录 `verify-e08.cjs` + `verify-report.json`

## 未验证 / 阻塞

1. ~~**网页路由未接线**~~ **已完成（2026-09-21 总集成）**：`frontend/src/App.tsx` 加一行 import + 一条 `/sales/fulfillment` Route；浏览器验收 15 项通过（`verify-e08-browser.cjs`），截图已实际查看。
2. **欠款交付（B09）未实现**：B10 收到余额未结清 + creditApprovalRef 时明确拒绝，不伪造「已批准欠款」。
3. **故障件隔离（quarantine）已实现逐件隔离**：失败的检查项带 `stockItemId` 时，该件 reserved → quarantine（来源 `inspection_quarantine`）、不回流 available；数量件坏件无法逐件隔离，仍整单释放。隔离件「出不了 quarantine」的判定（B19「待检件判定」）仍缺，属库存域（inventory-v2.ts），紧邻下一刀。
4. **CustomerDevice（交付后设备归属）未建**：属 E10 维修卡的 `customer_devices` 扩展。
5. **检测附件（resultEvidence）未实现**：依赖 B35 附件上传，收到非空引用明确拒绝。
6. 浏览器验收未跑（页面无路由，无法起真实浏览器）；微信真机验收不适用（本卡是店员 ERP 侧）。

## 下一动作

~~见 `INTEGRATION.md` 的「总集成待办」~~ **总集成已完成**（路由接线 + 浏览器验收 + 全量串行门禁复跑 + 迁移编号复核：0016 仍是迁移目录最大编号，未被并行模块占用）。剩余四项缺口（B09 欠款交付 / B19 隔离件出 quarantine / CustomerDevice / 检测附件）各自独立成卡，等栋哥点下一刀。
