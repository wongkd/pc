# E11 · 回收拆件与抵用收尾

- 日期：2026-09-22 ｜ 状态：已完成并通过验收（回执 `docs/verification/progress/E11.json`）
- 目标：把并行会话留下的「回收拆件」半成品收尾到可验收——补缺的迁移、接通 B33 付款 HTTP 出口、补后端测试、换掉前端占位页为真页面、端到端 + 浏览器验收。
- 页面入口：网页端顶栏「回收置换」→ `/recovery`（原 T02a 占位页已替换为真页面）。

## 本轮改了什么（与依据）

| 层 | 文件 | 改动 |
|---|---|---|
| 迁移 | `backend/migrations/0018_inventory_movement_sources.sql`（**新建，此前缺失**） | 重建 inventory_movements，把 source 枚举从 0007 的 14 值补齐到契约 16 值（缺 recovery_acquisition / inspection_release），并原样重建余额触发器 |
| 后端 | `backend/src/domains/recovery.ts` | 修 3 处真实 bug（见下），其余为并行会话已有成果 |
| 后端 | `backend/src/routes/finance-v2.ts` | 接 `/api/v2/finance/payments`（B33）回收付款；采购来源已由 F3 在同一出口扩展 |
| 后端 | `backend/src/routes/recovery-v2.ts` | 付款出口 `handleRecoveryPayment` 改为接收 requestId |
| 后端 | `backend/src/domains/access.ts` | `FINANCE_PERMISSIONS` 补 `payment: 'finance/payment'`（owner_only，不登记旧码） |
| 契约 | `contracts/v1/legacy-mapping.json` | 登记中转表 `inventory_movements__new`、sources 补 0018/0020、revisionNote 记 E11 |
| 前端 | `frontend/src/features/workbench/recovery-api.ts`（新建） | 回收接口装配 + 类型 |
| 前端 | `frontend/src/features/workbench/WorkbenchRecoveryPage.tsx`（新建） | 回收页一页两态（列表/详情 + 6 个动作表单） |
| 前端 | `frontend/src/App.tsx` | `/recovery` 换真页面、删 T02a 占位配置、占位路由排除 |
| 测试 | `backend/tests/e11-recovery-http.test.mjs`（新建） | 12 项 HTTP 测试 |
| 验收 | `docs/verification/E11-current/verify-e11.cjs`、`verify-e11-browser.cjs` | HTTP 34 项 + 浏览器 28 项 |

## 修掉的 3 个后端 bug（都只在「带损耗拆件」这条路径上才会爆）

1. **拆件损耗流水的 `from_bucket` 写成 `quarantine`**：源整机退役已经把 quarantine 减 1，损耗再减 1 就撞 `stock_balances` 的 `CHECK (quarantine_qty >= 0)`，整批回滚。改成 `from_bucket = NULL`（损耗是价值报废记录，不是实物桶移动）。
2. **守恒 guard 写成 `SELECT 1 WHERE ? <> ?`**：`guardStatement` 会把这段拼进 `INSERT ... SELECT ? WHERE <这里>`，拼出 SQL 语法错误。改成裸条件 `? <> ?`。
3. **`sourceRow` 字段名不匹配**：SQL 查出 `product_id`，plan 里读的是 `source.productId`，恒为 undefined，绑 D1 报 `D1_TYPE_ERROR`。在入口处转成驼峰口径。

> 另有两个非 bug、但需要栋哥知道的**实现边界**（已在 OPEN-ITEMS 登记）：
> - 报价发出后不能就地改价（契约 RecoveryState 没有 offered→inspecting 的回头路，客户还价只能走 B29 归还重开一单）；
> - E11 当时只验收回收付款；采购付款边界已由 F3 独立实现与验收，历史报告不回写。

## 验证结果（本轮实跑，非历史数字）

| 项 | 结果 |
|---|---|
| 后端 `npm --prefix backend test` | **257 通过 / 0 失败**（原 245 + E11 新增 12） |
| 前端 `npm --prefix frontend test` | **170 通过 / 16 文件** |
| 前端 build | 通过 |
| 前端 lint | **39 项既有失败（35 error + 4 warning），本轮新增 0** |
| 契约门禁 | validate-contracts / generate-dto --check / sync-contracts --check / check-client-parity / sync-error-codes 全绿 |
| 文档链接 | check-doc-links 175 链接 0 断链 |
| 端到端 HTTP | `verify-e11.cjs` **34 项 / 0 失败**（B26→B27→B28→B33→B44→B29 全链路 + R10） |
| 浏览器 | `verify-e11-browser.cjs` **28 项 / 0 失败**（路由 + 渲染 + 表单提交 + 状态流转，12 张截图） |

> ⚠️ 截图已生成在 `docs/verification/E11-current/screenshots/`，但本轮会话用的模型读不了图，**截图我无法逐张肉眼确认**，只能靠脚本的文本断言 + 接口断言。视觉是否破版请栋哥自己扫一眼，或换多模态模型复核。

## 未完成 / 下一步

- **抵用额度（B31/B32 折抵）未实现**：契约早已 frozen（`tradein/offset`、`tradein/reverse`，owner_only），但后端无 trade_ins/offsets 表、无路由、无前端。这是「完整首版必须包含回收拆件/抵用/维修」里的最后一块，独立一刀。
- 隔离件出 quarantine（B19）仍未做：收购/拆件的产出件现在「进得去 quarantine、出不来」，要等 B19 判定。
- 报价改价（G-27）契约缺口，待栋哥拍板是否加 offered→inspecting 的「重新议价」转换。
- 远端迁移（0000–0020）状态未核实，未部署、未应用远端迁移。
