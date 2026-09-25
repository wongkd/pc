# 电脑配置单网页 — CHANGELOG

> 用途：只记录"什么时候、改了什么、怎么验证、部署到哪里"。详细接手信息看 `电脑配置单网页开发完成记录.md`，下一步任务看 `电脑配置单网页TODO.md`。

---

## 2026-07-20 — ERP 阶段 1：应用壳与导航

**范围**：建立 ERP 左侧导航、前端路由和后续模块占位页；保留现有报价工作台的编辑、保存、模板、硬件库、查价、打印与导出能力。未改后端、D1 或业务数据，未部署。

**变更**：
- `frontend/package.json` / `frontend/package-lock.json`：新增 `react-router-dom`。
- `frontend/src/main.tsx`：接入 `BrowserRouter`。
- `frontend/src/App.tsx`：登录后默认进入 `/quotes`；新增 `/dashboard`、`/quotes`、商品与库存、采购、客户、供应商、装机、售后、收支、系统设置等路由；未知地址显示页面不存在。报价状态仍由同一 `App` 管理，切换模块不丢失编辑内容。
- `frontend/src/components/ErpShell.tsx`：新增固定侧栏、顶部模块标题、修改密码与退出登录入口。
- `frontend/src/components/ModulePlaceholderPage.tsx` 与 `frontend/src/erpNavigation.ts`：新增模块占位页面和统一导航配置。
- `frontend/src/index.css`：新增 ERP 应用壳及移动端导航样式，同时保留打印时隐藏导航。
- `App.tsx`：修正三处只读分类数组/可选 `categoryOrder` 的类型初始化，属于不改变运行行为的类型基线修复，使生产构建恢复通过。

**验证**：`npm --prefix frontend run build` 通过；Vitest 4 个文件、12 个测试通过；本地 Vite 服务对 `/quotes`、`/inventory` 与未知路由均返回应用入口。现有 ESLint 仍有 25 个错误、2 个警告，均为本阶段外既有问题。

**部署**：无。

---

## 2026-07-20 — ERP 阶段 0：备份与基线

**范围**：仅建立恢复基线、源码备份、数据库迁移目录和验证记录；未修改任何业务功能，未部署。

**变更**：
- 新增 `backups/stage-0-20260720/pc-quote-source-20260720-1320.tar` 和 `CHECKSUMS.sha256`，源码归档已验证，且排除依赖、构建缓存与既有备份。
- 新增 `backend/migrations/README.md` 与 `backend/migrations/0000_baseline.sql`，记录历史 D1 结构基线；未执行数据库迁移。
- 新增 `阶段0备份与基线记录.md`，包含盘点、验证结果、恢复步骤和风险。
- 通过 GitHub API 确认远程 `main` 提交 `169b72a99d586a2fe90dbf2c3627d9d6734b2202`，本地 `frontend/src/App.tsx` 与该提交 blob 一致；本机 Git clone 被网络重置，未生成工作树。
- 新增 `backups/stage-0-20260720/d1-pc-db-20260720.sql`，通过 D1 raw 只读接口导出 6 张业务表并在本地 SQLite 导入验证；`_cf_KV` 为平台托管表，未包含。
- 实时记录 Worker Version ID `7f0da140-d384-4fab-90c9-da6b0b4bb1d0` 与 Pages Deployment ID `32e473b2-37af-450a-932f-2d860d438f9c`。
- 更新 `电脑配置单网页TODO.md`，收敛 `ERP-0` 剩余阻塞项。

**验证**：Vitest 4 个文件、12 个测试通过。ESLint 25 个错误、2 个警告；TypeScript/Vite 构建因 `App.tsx` 3 个既有类型错误未通过，均已记录且未在本阶段修复。

**剩余阻塞**：当前同步目录无 Git 工作树，远程克隆仍受网络重置影响；官方 D1 整库导出接口未返回可下载文件。业务表 SQL 备份与线上 Worker/Pages 版本清单已完成。

**部署**：无。

---

## 2026-07-02 — 第十七阶段：硬件分类胶囊拖拽排序

**范围**：左侧分类胶囊（CPU / 主板 / 内存…）可拖拽排序，排序影响右侧报价预览。

**变更**：
- `frontend/src/types/quote.ts`：`QuoteDocument` 新增 `categoryOrder?: string[]`。
- `frontend/src/App.tsx`：新增 `categoryOrder` state；从本地/云端恢复；保存到本地/云端；传给 `QuoteItemsSection` 和 `QuotePreview`。
- `frontend/src/components/QuoteItemsSection.tsx`：导出 `ALL_CATEGORIES`；用 `categoryOrder` 排序胶囊；给胶囊添加 `draggable` 和 drag 事件处理；实现 drag-and-drop 重排。
- `frontend/src/components/QuotePreview.tsx`：按 `categoryOrder` 对展示项目排序。
- `frontend/src/index.css`：新增 `.split-nav-item[draggable]` / `.is-dragging` / `.is-drag-over` 样式。

**验证**：TypeScript + Vite build 通过。

**部署**：`wrangler pages deploy` → `https://32e473b2.pc-quote.pages.dev` → 生产域名 `https://pc.huangqidong.cn`。

**待确认**：用户测试拖拽胶囊排序、刷新/跨设备保持顺序、右侧预览顺序同步。

---

## 2026-07-01 — 第十六阶段：P3 硬件库即时云端同步

**范围**：硬件库更新/删除时即时同步到 `/api/library`，不再依赖全量 save 延迟同步。

**变更**：
- `frontend/src/types/quote.ts`：`HardwareLibraryItem` 新增 `cloudId?: number`。
- `frontend/src/App.tsx`：云端加载硬件库时写入 `cloudId: i.id`。
- `frontend/src/hooks/useHardwareLibrary.ts`：
  - 引入 `syncUpdate` / `syncDelete` API 函数。
  - `updateLibraryItem`：若 item 有 cloudId，fire-and-forget 调用 `PUT /api/library/:cloudId`。
  - `deleteLibraryItem`：若 item 有 cloudId，fire-and-forget 调用 `DELETE /api/library/:cloudId`。

**验证**：TypeScript + Vite build 通过。

**部署**：`wrangler pages deploy` → `https://32e473b2.pc-quote.pages.dev` → 生产域名 `https://pc.huangqidong.cn`。（与下方拖拽排序合并提交）

---

## 2026-07-01 — 第十五阶段：多多进宝 API 集成

**范围**：为后端新增拼多多多多进宝数据源，支持关键词搜索 + 商品详情 SKU 查询。

**变更**：
- `backend/wrangler.toml`：新增 `PDD_CLIENT_ID` / `PDD_CLIENT_SECRET` / `PDD_PID` 环境变量。
- `backend/src/index.ts`：
  - 新增纯 JS MD5 实现（Cloudflare Workers 不支持 Web Crypto MD5）。
  - 新增 `pddCall()` / `pddSign()` 签名和调用函数。
  - 新增 `pddSearch()`：调用 `pdd.ddk.goods.search`，翻译为统一格式（source=3、价格 /100）。
  - 新增 `pddGetDetail()`：调用 `pdd.ddk.goods.detail`，返回 SKU 明细。
  - 修改 `handleSearch`：并发调用 maishou88 + PDD，合并结果。
  - 新增 `/api/pdd/detail` 端点（公开、30/min 限流）。
  - `Env` 接口和路由传参更新。

**凭证**：client_id=1b9ed09f..., PID=44542885_316722429，已通过 PID+custom_parameters 授权备案（bind=1）。

**验证**：PDD API 直接调用无报错；`/api/search` 并发返回正常。  
**部署**：后端 `v7f0da140`（前端无需更新）。  
**⚠️** PDD DDK 搜索对电脑硬件关键词覆盖率极低（仅返回有佣金商品），作补充数据源。

---

## 2026-07-01 — 第十二阶段：N1-N7 条款备注可编辑 + N8-N12 规格默认留空

**范围**：N1-N7（条款备注四框可编辑）和 N8-N12（硬件规格默认留空）。

**变更**：
- `frontend/src/types/quote.ts`：新增 `QuoteNotes` 类型（payment/afterSales/warranty/remarks），新增 `migrateNotes` 兼容旧数据；`QuoteDocument` 和 `MerchantTemplate` 的 `notes` 改为 `QuoteNotes`。
- `frontend/src/App.tsx`：notes state 改为 `QuoteNotes`；localStorage 恢复、云端加载、模板保存/套用全部适配 `migrateNotes` 迁移逻辑。
- `frontend/src/components/NotesSection.tsx`：单 textarea 拆为四宫格编辑区（付款方式/售后说明/质保政策/备注条款）。
- `frontend/src/components/QuotePreview.tsx`：termRows 三处硬编码改为读取 `notes` 对象，留空时用默认文案兜底。
- `frontend/src/utils/exportHtml.ts`：HTML 导出四框同样改为读取 `notes` 对象。
- `frontend/src/components/QuoteItemsSection.tsx`：`handleApplySuggestion` 删除 `details = libItem.description`，规格不再从库建议回填。
- `frontend/src/index.css`：新增 `.notes-grid`（2×2 宫格）和 `.notes-label` 样式。

**验证**：TypeScript + Vite build 通过。

**部署**：`https://4a661e99.pc-quote.pages.dev`。

**待确认**：用户测试四个框分别编辑、旧模板兼容、新增硬件规格为空。

---

## 2026-07-01 — 第十四阶段：N19-N26 多 SKU 候选商品选择

**范围**：N19-N26（查价返回多候选时弹出选择弹窗，用户确认后写入）。

**变更**：
- `frontend/src/components/HardwareLibrarySection.tsx`：新增 `CandidateModal` 门户组件（候选商品卡 + 评分排序 + 推荐高亮 + 改选确认）；修改 `handlePriceSearch` / `handleSingleRefresh` 在 ≥2 条时弹候选框（批量刷新不弹）；新增 `handleCandidateConfirm` 和 `searchError` 错误提示。
- `frontend/src/index.css`：新增 `.cand-*` 系列样式（overlay/modal/card/badge/price/button）+ `.hl-error`。

**验证**：TypeScript + Vite build 通过。

**部署**：`https://9a4754d4.pc-quote.pages.dev`。

**待确认**：用户测试查价/单条刷新多候选弹窗、取消不写入、批量刷新不打断。

---

## 2026-07-01 — 第十三阶段：N27-N32 导出按钮合并为下拉菜单 + 工具栏统一

**范围**：N27-N32（导出按钮下拉菜单 + 工具栏合并到同一行）。

**变更**：
- `frontend/src/components/QuoteToolbar.tsx`：四个导出按钮（打印/PNG/PDF/HTML）合并为"导出报价单"主按钮 + 下拉菜单；菜单支持点击外部关闭、四个菜单项各有图标和悬停反馈；工具栏从两行改为 flex 同一行（预览模式 / 页面方向 / 导出按钮）。
- `frontend/src/index.css`：新增 `.toolbar-row`、`.export-dropdown*` 系列样式；移除 `.quote-toolbar-grid`、`.quote-toolbar-actions`、`.toolbar-action-row` 等旧样式；移动端响应式同步更新。

**验证**：TypeScript + Vite build 通过。

**部署**：`https://fc5f3f4b.pc-quote.pages.dev`。

**待确认**：用户测试导出下拉菜单四个选项、点击外部关闭、工具栏布局。

---

## 2026-07-01 — 第十一阶段：PNG 导出方向 + 打印空白页修复

## 2026-07-01 — 第十一阶段：PNG 导出方向 + 打印空白页修复

**范围**：只处理 `N13-N18` 和 `B4-1 ~ B4-5`。

**变更**：
- `frontend/src/hooks/useHtml2Canvas.ts`：PNG/PDF 共用打印版离屏克隆；PNG 按当前页面方向导出竖版/横版。
- `frontend/src/App.tsx`：导出 PNG 时传入 `viewSettings.orientation`。
- `frontend/src/index.css`：收紧打印态外层容器和分页样式，减少单页内容额外撑出空白第二页。

**验证**：TypeScript + Vite build 通过。

**部署**：`https://d54a0852.pc-quote.pages.dev`。

**待确认**：用户测试竖版/横版 PNG、打印预览是否仍有空白第二页。

---

## 2026-07-01 — 第十阶段：B3 新增项目空白项修复 + 本地登录代理

**范围**：只处理 B3 和本地预览登录网络错误。

**变更**：
- `frontend/src/components/QuoteItemsSection.tsx`：点击「新增项目」后创建全部硬件分类空白项，并默认选中 CPU。
- `frontend/vite.config.ts`：本地开发增加 `/api/auth` 代理到正式域名，解决本地预览登录网络错误。

**验证**：前端 build 通过；本地 `/api/auth/login` 返回后端 JSON。

**部署**：`https://752e1983.pc-quote.pages.dev`，生产域名 `https://pc.huangqidong.cn`。

---

## 2026-07-01 — 第九阶段：商家模板保存/套用修复

**问题**：商家模板套用后不恢复硬件配置、品牌联系方式、条款备注。

**根因**：`MerchantTemplate` 类型只存 `brand`，没有保存 `quoteItems` 和 `notes`。

**变更**：
- `frontend/src/types/quote.ts`：`MerchantTemplate` 增加 `quoteItems`、`notes`。
- `frontend/src/App.tsx`：保存、加载、套用、标准化模板时补齐三项数据。

**验证**：前端 build 通过；旧模板需删除后重新保存。

**部署**：`https://9df6adee.pc-quote.pages.dev`。

---

## 2026-07-01 — 第八阶段：补齐 m8 前端测试覆盖

**范围**：只补测试，不改生产逻辑。

**变更**：
- 新增 `frontend/src/utils/api.test.ts`。
- 覆盖 `normalizeTitles()` 成功/失败分支，以及硬件库 `name` ↔ `description` 字段映射。

**验证**：Vitest 4 个测试文件、12 个测试通过。

---

## 2026-07-01 — 第七阶段：用户反馈小修补与性能优化

**变更**：
- 硬件库查价添加时保留图片。
- 登录后首屏不再被云端加载阻塞。
- `html2canvas`、`jspdf`、`xlsx` 改为动态 import，主 bundle 约 1.27MB 降到 255KB。
- LOGO 上传前压缩，降低云端保存失败风险。
- 新增硬件时同步写入 `/api/library`。

**验证**：前端 build 通过。

**部署**：`https://pc.huangqidong.cn`。

---

## 2026-06-30 — 部署与端到端验证

**范围**：部署并验证 C5、C6、M8。

**验证**：
- PBKDF2 正确/错误密码登录正常。
- 报价配置 `/api/quotes` 保存和读取正常。
- `/api/normalize` 空输入报错、正常输入解析正常。

**部署**：
- Backend：`a8f85b56`。
- Frontend：`https://872fa261.pc-quote.pages.dev`，正式域名 `https://pc.huangqidong.cn`。

---

## 2026-06-30 — 安全加固与核心审查项修复

**变更**：
- 移除 `wrangler.toml` 明文密钥，改用 Cloudflare Worker Secrets。
- `collect.js`、`collect-v2.js` 登录凭据改为环境变量。
- `schema.sql` 补齐 `templates` 表和索引。
- 前端硬件查价不再直连第三方 API，改走后端 `/api/search`。
- 前端 API 改同域 `/api/...`，由 Pages Functions 代理后端 Worker。
- Vite `base` 改为 `/`，正式域名根路径访问。
- 首页加 no-store 缓存控制，并兼容旧 `/pc/assets/...` 缓存资源。

**验证**：Secrets、D1 schema、前后端接口和正式域名资源均验证通过。
