# 报价列表工作版本读模型修复与 QT03 续验

日期：2026-09-25。状态：列表读模型修复已完成并有本地 HTTP / 页面证据；QT03 **未放行**，系统打印预览内容与取消状态未验收。

## 目标与范围

单独修复报价列表摘要与详情选择版本不一致的问题。这是 QT03 模板 A+B 验收卡之外的后端读模型缺陷，不修改 QT03 原卡、不改报价写入/签发语义。

根因：`quote_headers.current_revision` 是最近已发出的版本指针，新建草稿保持 `0`，已发出后另存草稿也不推进该指针。旧列表只按该指针关联金额/明细，并以 `COALESCE` 把无匹配版本显示为 v0 / ¥0；详情默认优先读草稿，因而同一张报价的列表和详情不同。

## 变更

- `backend/src/domains/quote.ts`：列表同时读取工作草稿与已发出指针。列表工作版本优先取草稿，否则取当前已发出版本；状态、版本、行数、金额、有效期都从该工作版本读取。另返回 `publishedRevision` / `publishedStatus` / `publishedTotalCents`，`shared` 继续依据已发出指针。
- `frontend/src/features/workbench/quote-api.ts`、`WorkbenchQuotePage.tsx`：使用工作版本号；列表显示明细行数和工作版本金额；有新草稿时注明仍保留的已发出版本状态与金额。不存在任何匹配版本时显示“版本缺失”，版本、行数和金额留空。
- `backend/tests/e05-quote-http.test.mjs`、`e05b-quote-confirm.test.mjs`、`frontend/src/features/workbench/WorkbenchQuotePage.test.tsx`：补纯草稿、无新草稿的已发出版本、已发出后另存草稿、已确认后另存草稿、共享/历史金额、汇总/筛选以及缺失版本回归。

未修改 `contracts`、迁移、`backend/src/index.ts` 接线或 `current_revision` 写入。

## 汇总与筛选口径

- `totals.all` 是全部报价头数；状态/搜索筛选和列表 limit 不缩小汇总范围。
- `totals.draft` 按工作版本为草稿的报价计数。
- `issued`、`confirmed`、`expired` 按 `current_revision` 指向的已发出生命周期版本计数；一张“已发出版 + 新草稿”会同时反映工作草稿和原有生命周期状态。
- `issuedAmountCents` 只累加未过期、仍为 `issued` 的已发出指针版本金额；不包含工作草稿、confirmed、expired 金额。
- 列表状态筛选按显示的工作版本状态执行。已发出/已确认版本号、状态、金额、共享状态和历史记录不会因另存草稿而覆盖。
- 有报价头但没有草稿且 current revision 无匹配版本时，摘要标记 `missing`，金额/版本/行数为 `null`，不静默填成 0。

## 本轮验证

### 后端与前端测试

| 命令 | 结果 |
|---|---|
| `node --test --test-concurrency=1 tests/e05-quote-http.test.mjs`（backend） | 34/34 通过 |
| `node --test --test-concurrency=1 tests/e05b-quote-confirm.test.mjs`（backend） | 14/14 通过 |
| `node --test --test-concurrency=1 tests/p2-erp-flow.test.mjs`（backend） | 1/1 通过 |
| `npm --prefix frontend run test -- src/features/workbench/WorkbenchQuotePage.test.tsx` | 1 文件、20/20 通过 |
| `npm --prefix frontend run test` | 23 文件：185 通过、16 跳过、2 失败。两个失败与本修复无关：`WorkbenchFulfillmentPage.test.tsx` 找不到“需 SN 的已绑定”；`WorkbenchInventoryPage.test.tsx` 找不到“第 1 行：逐件商品必须填写内部编号”。未用历史基线判断其来源。报价页定向用例通过。 |
| `npm --prefix frontend run build` | `tsc -b` 与 Vite build 通过；有既有的大于 500 kB chunk 提示。 |

### 本机页面与环境

- 启动前检查 8787、5173、5174、8788 均无监听；`VITE_API_TARGET` 原先未设置，Vite 配置默认指向 `http://127.0.0.1:8787`。本轮显式设为该本机地址。
- `npm --prefix backend run dev:local` 启动隔离 Worker / 内存 D1 于 `127.0.0.1:8787`；Vite 实际运行于 `127.0.0.1:5173`。未访问或写入 Cloudflare 预览/生产环境。
- 在正式 `/sales/quotes` 页面创建虚构报价“QT03列表修复复验-虚构双行”：CPU ×2，¥320.00；内存 ×1，¥159.99；优惠 ¥20.00。
- 保存后详情实看 v1、2 行、小计 ¥799.99、优惠 ¥20.00、应付 ¥779.99、定金 15%、门店自取。
- 独立重新加载列表后实看“草稿 / 2 行 / v1 / ¥779.99”；再次打开详情仍是相同版本、行数和金额。列表和详情均来自本机正式页面，不是源码推断。
- 本轮 Edge 列表/详情真实页面截图由浏览器工具捕获并在本会话中显示；当前 CUA 接口没有把截图字节写入仓库文件的路径，因此未生成新 PNG，也未覆盖 QT03 旧截图。旧证据仍在 [QT03 续验回执](../2026-09-24-quote-templates-ab/QT03-followup.md)。
- 9 月 25 日续验详情见[本机打印续验](print-followup.md)：本机正式详情页面实看 2 行明细、金额与条款；Codex 内置浏览器点击打印后没有打开系统打印窗口。系统预览未实看，也未取消真实打印对话框。没有物理打印。

## 放行判断与交接

报价列表金额/版本缺陷的代码和指定回归已通过；列表/详情页面实测通过。QT03 还要求打印实看“仅含两行真实明细、不含空槽/内部字段并核对条款”，这一步仍无系统打印预览证据，所以保持**未放行**。下一步在能接管 Edge 系统打印预览的环境实看明细/条款并取消，不执行物理打印；完成前不要写 QT03 本地验收完成。C/D、真实打印、业务交易、远端操作均不在本轮范围。
