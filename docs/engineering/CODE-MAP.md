# 代码地图与按需阅读

更新：2026-09-22。只帮助定位，不重复业务协议或完成状态。
用 `rg -n "符号名" 相关目录` 找定义/调用，再读取局部；默认不要输出全文件或全库搜索结果。

| 要改什么 | 优先读 | 对应验证 |
|---|---|---|
| 网页入口 / 导航 | frontend/src/App.tsx、app/AppShell.tsx、app/navigation.ts、app/workspaces.ts | App.test.tsx、frontend test → build |
| 新 ERP 页面 | frontend/src/features/workbench/Workbench*Page.tsx，配套 *-api.ts / *-view.ts | 同域测试及浏览器 |
| 旧报价 / 打印 | frontend/src/features/legacy-quote、components/Quote*、hooks | App.test.tsx 副作用隔离；导出/打印回归 |
| 客户台账 | frontend/src/components/CustomersPage.tsx；backend/src/index.ts 的 customers 分支 | CustomersPage.test.tsx、e04-customers.test.mjs |
| 请求 / 幂等错误 | frontend/src/api、backend/src/domains/operations.ts | 请求层测试、t04 系列 |
| 报价 / 销售 / 交付 | backend/src/domains/quote.ts、sale.ts、assembly.ts；routes/quote-v2.ts、sales-v2.ts | e05 / e06 / e08 / e09 系列 |
| 二手配件仓库 / 库存 / 采购 | frontend/src/features/workbench/InventoryPartsWorkspace.tsx、WorkbenchInventoryPage.tsx、WorkbenchQuotePage.tsx、WorkbenchPurchasePage.tsx、WorkbenchRecoveryPage.tsx；backend/src/domains/inventory.ts、purchase.ts、recovery.ts | InventoryPartsWorkspace / WorkbenchQuote / WorkbenchPurchase / WorkbenchRecovery tests；u01-inventory-read / u02-stock-backfill-http / e07 / e11 |
| 维修 / 回收 / 抵用 / 财务 | backend/src/domains/service.ts、recovery.ts、tradein.ts、finance.ts；同名 v2 路由 | e10 / e11 / e12 与验收卡 |
| 附件 | backend/src/domains/attachment.ts、storage.ts；routes/attach-v2.ts | f1-attachments.test.mjs |
| 今天页读模型 | backend/src/domains/workbench.ts、routes/workbench-v2.ts；frontend/src/features/workbench/workbench-api.ts | r02-workbench.test.mjs、WorkbenchTodayPage.test.tsx |
| 顾客微信端 | miniprogram/app.json、pages/home/shop/community/mine、features | miniprogram tests / check-pages / check-classes / typecheck |
| 跨端协议 | contracts/v1；读 contracts/README.md 与 F0 卡后再修改 | 重生成 → 两端同步 → 契约门禁 |

## 大文件怎么拆

- `node scripts/audit-repository.mjs` 列出实时行数；超过 600 行是阅读热点，不是删除依据。
- 先找调用者、纯函数、I/O 与事务边界；每次只拆本任务触及的职责，保留公开接口。
- 销售域优先分开读模型与动作计划；页面优先提取表单/详情组件和纯视图逻辑。
- 后端入口的绝对行号受契约引用；不得格式化整个 index.ts 或机械平移证据后跳过验证。
- tests、原型、迁移、generated 都有独立用途；零运行时引用不等于全项目无用。
- 旧小程序页面还在 app.json；其退出属于 MP 任务范围，不直接删路由或测试。

## 节省上下文

README + AGENTS + STATUS + 交接为默认入口；只再打开当前任务的一个 README。
工程踩坑按关键词查，验证按任务编号查；不重复读取 archive、历史提示词、锁文件和生成物。
`.rgignore` 默认排除历史归档及生成副本；追溯时用显式路径或 `rg --no-ignore`，不是文件丢失。
