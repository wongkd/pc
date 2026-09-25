# E09 · 取消 / 退货 / 退款 / 欠款交付 / 账本（前端最小入口 + 收尾）

更新：2026-09-21 晚。状态：**E09 后端（B09/B11/B17/B43/B18/B34/R12 的领域+路由+迁移+测试）由上一会话完成；本卡补齐 R04 详情读模型缺口 + 前端最小入口 + 路由接线 + 浏览器验收，全部通过**。

## 本卡做了什么

**背景**：上一会话已落地 E09 后端（`finance.ts` / `finance-v2.ts` / `sale.ts` 扩展 / `0017` 迁移 / `e09-cancel-return-refund-http.test.mjs`，后端 234 用例）。本卡按栋哥「后端为主 + 最小入口」裁定补前端。

1. **后端读模型补洞（必要前置）**：R04 详情接口原本**不返回退货记录**，前端「登记退货 → 批准贷项 → 退款」链路会在刷新后丢失退货单、无法批准与退款。在 `querySaleOrderDetail` 补：
   - `returns` 列表（`sale_returns`：id / creditCents / creditState / acceptedQty / reason / createdAt / approvedAt）；
   - `order.returnCreditCents`（累计已批准贷项）。
   纯读模型扩展，不动契约源文件、不动写动作、不动迁移。
2. **订单页收尾动作区**（`WorkbenchSalesPage.tsx` 详情页，按状态 + 权限显隐）：
   - **取消**（B11）：已成交未交付的单，填原因；已交付不出现（走退货）；
   - **批准欠款交付**（B09，owner）：已成交有余额未交付的单，到期日 + 原因；
   - **登记退货**（B17）：已交付的单，行号 position + 数量 + 贷项金额 + 原因（+ 二手件实物编号）；
   - **批准贷项**（B43，owner）：pending 退货单行内按钮；
   - **登记退款**（B18，owner）：只对**已批准**贷项开放（pending 时表单不出现），金额 + 方式 + 原因。
   按栋哥拍板：**本刀退款只走「退货→批准→退款」链路**；取消单的「门店待退」如实显示、不给退款按钮（adjustmentRef 机制未实现，不伪造入口）。
3. **账本页**（`/finance`，原占位页换真页面）：汇总卡（现金流入/流出/净额、应收单数+金额、应付单数+金额）+ 资金流水表（方向过滤 in/out、反冲笔标记）+ 反冲入口（B34，owner，仅非反冲笔可反冲）。
4. **路由接线**：`App.tsx` 挂 `/finance`，批量占位路由排除 `/finance`。

## 验证命令与结果（本轮实跑）

| 命令 | 结果 |
|---|---|
| `npm --prefix backend test` | **234 通过 / 0 失败**（读模型补洞未破坏；后端用例数与上一会话 E09 后端完成时一致） |
| `npm --prefix frontend test` | **16 文件 170 用例通过**（基线 15 文件 165 + 本卡账本页 5 用例） |
| `npm --prefix frontend run build` | 通过（tsc -b + vite build） |
| `npm --prefix frontend run lint` | **39 项既有失败（35 error + 4 warning），本卡新增 0** |
| `node contracts/tools/validate-contracts.mjs` | **3355 通过 / 0 失败**（本卡未改契约源文件） |
| `node contracts/tools/generate-dto.mjs --check` | 通过 |
| `node frontend/scripts/sync-contracts.mjs --check` | 通过 |
| `node contracts/tools/check-client-parity.mjs` | 通过 |
| `node backend/scripts/sync-error-codes.mjs --check` | 通过 |
| `node scripts/check-doc-links.mjs` | 通过（0 断链） |
| `node docs/verification/E09-current/verify-e09.cjs` | **22 项通过 / 0 失败**（端到端 HTTP：取消 / 欠款交付 / 退货退款 / 账本 / 反冲，见 `verify-report.json`） |
| `node docs/verification/E09-current/verify-e09-browser.cjs` | **13 项通过 / 0 失败**（浏览器：账本页 + 订单页收尾动作区 + 页面内提交退货，见 `verify-browser-report.json`） |

**截图已实际查看**（`screenshots/`，4 张，1440×1000 Edge headless）：
1. 账本页：五张彩色汇总卡、方向过滤、空态文案，与全站 v2 彩色口径一致；
2. 已交付订单详情：「登记退货」表单完整（行号/数量/贷项/实物/原因/按钮）；
3. 页面内提交退货后：成功提示 + 「退货与退款」区出现「待批准」记录与「批准贷项」按钮；退款表单按设计未出现（贷项未批准）；
4. 已成交未交付订单详情：「取消销售单」与「批准欠款交付」表单齐备；「登记退货」不出现（未交付）。

## 证据

- 后端补洞：`backend/src/domains/sale.ts`（`querySaleOrderDetail` 加 `returns` + `order.returnCreditCents`）
- 前端：`sales-api.ts`（5 个写动作 + 类型扩展）、`WorkbenchSalesPage.tsx`（收尾动作区）、`finance-api.ts` + `WorkbenchFinancePage.tsx` + `.test.tsx`（新建）、`App.tsx`（路由）、`WorkbenchFulfillmentPage.test.tsx`（mock 补字段）
- 端到端：本目录 `verify-e09.cjs` + `verify-e09-browser.cjs` + 两份 report.json + 4 张截图
- E09 后端本体（上一会话）：`backend/src/domains/finance.ts`、`backend/src/routes/finance-v2.ts`、`backend/src/domains/sale.ts`（B09/B11/B17/B43/B18）、`backend/migrations/0017_sale_refund_credit.sql`、`backend/tests/e09-cancel-return-refund-http.test.mjs`

## 未验证 / 已知观感

1. **后端读模型补洞无专项单测**：`returns` 字段由端到端脚本（verify-e09.cjs 的 R04 两条断言）覆盖，未加后端单测用例。
2. **「取消销售单」按钮 disabled 态对比度偏低**：截图上浅灰按钮在浅底上不够醒目（功能正常——同结构的「登记退货」按钮已实际点击提交成功）。视觉统一留给后续视觉卡（无稿屏裁定：先功能后视觉）。
3. **取消单退款（adjustmentRef）未做**：B18 支持 `returnRef` / `adjustmentRef` 二选一，但「调整」实体本刀未实现；取消后的「门店待退」只显示不提供退款按钮。要补需先定「调整」的契约语义。
4. **账本页未覆盖「有流水」的浏览器截图**：浏览器脚本先开账本页（空态）后铺数据；有流水的账本页渲染由前端单测（170 用例中账本页 5 项）与 HTTP 验收覆盖。
5. 未跑微信真机（本卡是店员 ERP 侧）；未访问生产、未部署、未应用远端迁移（0004–0017 均未核实远端状态）。

## 下一动作

E09 已完整收工（后端 + 前端 + 验收）。剩余候选等栋哥点刀：**隔离件出 quarantine（B19，独立小卡）** → **售后维修（E10）** → 回收抵用 → Q-09 顾客侧。E09 未在进度台在册，**不写 progress 回执**。
