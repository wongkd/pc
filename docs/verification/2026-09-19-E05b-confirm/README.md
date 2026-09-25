# E05b · 报价「顾客已确认」契约补态 · 验证记录

日期：2026-09-19。范围：契约修订（QuoteStatus + confirmed / B42）+ 后端确认动作 + 报价页确认入口。
上一卡：[E05 报价闭环](../2026-09-19-E05-quote/README.md)。

## 改动清单

| 层 | 文件 | 内容 |
|---|---|---|
| 契约 | `contracts/v1/enums.json` | QuoteStatus 新增 `confirmed`；状态机补 `issued → confirmed`（B42）；ActionCode 补 B42 |
| 契约 | `contracts/v1/objects.json` | QuoteVersion 新增 `confirmedAt` / `confirmedSource`（nullable，仅 confirmed 时有值）+ 规则行 |
| 契约 | `contracts/v1/actions.json` | 新增动作 **B42「记录顾客确认」**（frozen，POST `/sales/quotes/:id/confirm`，权限 `sales/quote-edit`）。注意：B42 进的是**主 actions 数组**（与 ActionCode 枚举双向一致），不是 supplementaryActions |
| 契约 | `contracts/v1/legacy-mapping.json` | 登记过渡表 `quote_versions__v12` |
| 迁移 | `backend/migrations/0012_quote_confirmed.sql` | 重建 quote_versions：status CHECK 补 `confirmed`，新增 `confirmed_at` / `confirmed_source`，CHECK 强制确认字段与状态成对出现、来源只能三渠道。与 0011 同一前提（0009–0011 未应用远端、表为空） |
| 后端 | `backend/src/domains/quote.ts` | `planConfirmQuote` / `confirmQuote`：重放保护在预读之前；过期闸做成结构化守卫（`EXISTS valid_until < now`）；条件 UPDATE 只命中 `status='issued'` + 守卫确认状态真的变了；全程不写库存/资金表 |
| 后端 | `backend/src/routes/quote-v2.ts` | B42 路由（confirm 正则在 detail 正则之前），权限 `QUOTE_PERMISSIONS.edit` |
| 前端 | `frontend/src/features/workbench/quote-api.ts` | 类型补 confirmed / confirmedAt / confirmedSource / totals.confirmed；`confirmQuoteVersion()`（action B42） |
| 前端 | `frontend/src/features/workbench/WorkbenchQuotePage.tsx` | 详情页确认入口（来源下拉 + 按钮，仅当前版本 issued 且未过期时显示）；已确认提示行（时间 + 来源 + 确认 ≠ 付款）；列表汇总与状态标签 |
| 测试 | `backend/tests/e05b-quote-confirm.test.mjs` | 14 用例 |
| 测试 | `frontend/src/features/workbench/WorkbenchQuotePage.test.tsx` | +2 用例（确认提交参数 / 已确认态展示与按钮隐藏） |
| 验收 | `verify-confirm.cjs` | 浏览器验收 21 项 |

## 实跑结果（2026-09-19）

- 后端 `npm --prefix backend test`：**172 通过 / 0 失败**（基线 158 + 本卡 14）
- 前端 `npm --prefix frontend test`：**13 文件 152 用例通过 / 0 失败**（基线 150 + 本卡 2）
- 前端 `npm run build`：通过；`npm run lint`：**39 项既有失败不变，本卡新增 0**（改动文件均不在失败清单）
- 契约 `validate-contracts.mjs`：**全部通过**（generate-dto / sync-contracts / check-client-parity / sync-error-codes / check-doc-links 均绿）
- 浏览器验收：**21 / 21 通过**，截图 5 张已实看：
  `01-new-quote-editor`（编辑）、`02-issued-with-confirm`（发出后确认入口就位）、
  `03-confirmed-detail`（已确认态、来源微信、确认 ≠ 付款提示、按钮消失）、
  `04-list-with-confirmed`（列表状态「顾客已确认」、汇总「已确认 1」）、`05-revise-after-confirm`（改一版 = 出新版本）

## 语义口径（写代码前已定，勿再发挥）

- 确认 ≠ 付款、确认不锁库存（R12）：B42 不写任何库存/资金表，前端提示原样转述。
- 确认后本版本不可改：save 只删改 draft 版本（结构上碰不到 confirmed 行）；要改必须出新版本重新发出并重新确认（R10）。
- 已过期（超过 validUntil）的版本须先续期再确认；预读与 SQL 守卫双重拦截。
- 确认目标是 `current_revision` 指向的版本；历史版本不可确认（前端按 `revision === currentRevision` 收口）。

## 实测教训（本轮新踩/复踩）

- **同文件并行 Edit 会互相覆盖（本轮复踩两次）**：`quote-v2.ts` 常量被处理器编辑冲掉 → 运行时 `QUOTE_CONFIRM_PATH is not defined` 500；
  测试文件的 import 同理。同文件多处修改必须串行。
- **guardStatement 条件为真即中止**：过期闸第一版写成 `NOT EXISTS (…过期…)`，语义反向，正常单全被拦（guidanceFor 兜底文案照出来）。
  写守卫先读 `operations.ts` 里 `INSERT … SELECT ? WHERE <conditionFails>` 的签名。
- **actions.json 有两个数组**：主 `actions` 必须与 ActionCode 枚举双向一致（frozen 动作进这里）；
  B37–B41 在 `supplementaryActions`（status 只能 reserved/specified）。插错数组校验报「缺 B42 / status=frozen 不合法」。
- **uiRefs 只认已登记页面**：「报价详情」不在白名单，复用 B01 的「新建装机报价」。
- 验收断言注意提示文案：成功通知里含动作名时，`body.innerText.includes` 会误判按钮仍存在，要按 DOM 查询断言。

## 未验证 / 留给后续卡

- 顾客侧确认（小程序内点「确认」）未做：依赖 T03a 顾客身份，届时 B42 由顾客端调用（来源 miniprogram）。
- B03 报价转销售单（convert）未接：属收款/订单卡，confirmed → converted 的转换留给那一刀。
- 0012 未应用任何远端环境（与其他迁移一致，见 OPEN-ITEMS T-06）。
