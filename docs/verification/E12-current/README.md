# E12 · 抵用额度（置换折抵）—— 后端与契约收尾

- **日期**：2026-09-22
- **状态**：后端 + 契约 + 迁移 + 测试 + HTTP 验收完成；前端由栋哥另行用 ChatGPT 实现，浏览器验收待补
- **回执**：`docs/verification/progress/E12.json`（status=working，前端未做不标 verified）

## 目标

落地契约早已 frozen 的 B31（建立置换关联 + 应用折抵）、B32（撤销折抵）、R11（置换单读），
把「回收旧机 → 抵用额度 → 折抵新机货款 → 找零/保留/撤销」这条完整首版最后一块打通。

栋哥 2026-09-22 拍板：**折抵入口用方案 B**（不单开页，挂在回收单/销售单详情里），**前端页面用 ChatGPT 做**，
本卡只负责后端 + 契约 + 迁移 + 测试 + HTTP 验收。

## 关键裁定（Q-04 找零语义）

栋哥选「**两者都支持，默认保留**」：
- 旧机作价 > 新机应付时，剩余额度**默认保留**在回收单应付里（可拆分、无有效期，下次置换继续折抵）；
- 客户要求时**找零**：复用 B33 付款把剩余应付退现金/转账，不新增契约动作。

## 交付范围

| 层 | 内容 |
|---|---|
| 迁移 | `0021_tradein.sql`：`trade_ins`（置换关联）+ `offsets`（折抵凭据，applied/reversed + reversal_of） |
| 后端 domain | `domains/tradein.ts`：createTradeIn / applyOffset / reverseOffset / queryTradeIn（R11） |
| 后端路由 | `routes/tradein-v2.ts`：/api/v2/trade-ins 前缀三动作 + R11 读；`index.ts` 只加 import + 分发行 |
| 权限 | `domains/access.ts`：TRADEIN_PERMISSIONS（view←quote/view、create←quote/edit、offset/reverse owner_only 不登记旧码） |
| 联动改动 | `domains/recovery.ts`：① B33 付款超付守卫改为「剩余应付 = payable − 有效折抵」；② R10 读模型加 `offsetCents` 字段 |
| 契约 | `objects.json` Offset.tables=["offsets"]；`legacy-mapping.json` 登记 trade_ins/offsets + sources 补 0021 + Offset 移出 objectsWithoutLegacyTable；`actions.json` 证据行号整体 +2；重新生成 DTO/manifest |
| 测试 | `tests/e12-tradein-http.test.mjs`（10 用例） |
| 验收 | `docs/verification/E12-current/verify-e12.cjs`（17 项纯 HTTP 端到端） |

## 核心语义（照契约 money-rules）

- 折抵是**非现金事件**：不写 cash_entries，不生成虚构现金收/付。销售侧落在 `sale_orders.offset_net_cents`
  （0017 已建列，此前恒为 0），回收侧走 `offsets` 表聚合（`recovery_orders` 不重建、不落列，0020 注释「本表只承载现金付款路径」）。
- 首版折抵金额 = `min(销售正余额, 回收剩余应付)`；回收剩余应付 = `payable_cents − 有效折抵(SUM applied − SUM reversed)`。
- 双方交易主体须相同（sale.customer_id = recovery.seller_customer_id，均非空），否则 OWNERSHIP_INVALID。
- 部分折抵、累计不得超额（OFFSET_EXCEEDED）；撤销不搬动实物（原 offset 保留 + 新增 reversed 笔）。

## 验证结果

- **后端测试**：`npm --prefix backend test` → **268 用例 / 0 失败**（原 257 + E12 11）。
- **契约六件套全绿**：validate-contracts **3441 通过 / 0 失败**、generate-dto --check、sync-contracts --check、
  check-client-parity、sync-error-codes --check、check-doc-links（181 链接 0 断链）。
- **HTTP 端到端**：`node docs/verification/E12-current/verify-e12.cjs` → **17 项 / 0 失败**（链路 A 折抵+找零，链路 B 折抵+撤销+版本冲突）。

## 未完成 / 边界（如实记录，不算 bug）

- **前端未实现**：`tradein-api.ts`、置换页/折抵动作入口由栋哥用 ChatGPT 做；本卡不做前端、不做浏览器验收。
- **R10 加 offsetCents 字段**属读模型扩展，供前端算「剩余应付」；契约 Recovery 实体无此字段，属实现扩展非契约变更。
- trade_ins.state 首版只用 `active`，`closed` 预留给「销售单取消导致关联关闭」等后续语义。
- 折抵不 bump recovery 版本（recovery 表不被折抵动作改写），「双方 expectedVersion」里 recovery 版本仅作读一致性校验；
  并发安全由 offsets 守卫 + SQLite 串行写保证。

## 前端（ChatGPT）对接要点

- 三个动作 + 一个读，前缀 `/api/v2/trade-ins`：
  - `POST /trade-ins`（tradein/create）入参 `saleOrderId + recoveryId + saleOrderVersion + recoveryVersion`；
  - `POST /trade-ins/:id/apply-offset`（tradein/offset）入参 `amountCents + saleOrderVersion + recoveryVersion`；
  - `POST /trade-ins/:id/reverse-offset`（tradein/reverse）入参 `offsetId + reason + saleOrderVersion + recoveryVersion`；
  - `GET /trade-ins/:id`（tradein/view）返回两端单据 + offsets + `validOffsetCents` + `recoveryPayableRemainingCents`。
- 回收单详情（R10）已带 `offsetCents`（有效折抵），前端可用 `payableCents − offsetCents` 算「剩余应付」决定折抵/找零金额。
- 权限：view/create 旧码 quote/view、quote/edit 等价；offset/reverse 老板专属。
