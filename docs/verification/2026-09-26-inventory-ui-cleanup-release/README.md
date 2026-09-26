# 库存登记弹窗与清理入口 UI 修复

- 日期：2026-09-26
- 状态：已推送并部署生产；登录后业务验收与本轮真实浏览器视觉检查未做。
- 代码提交：`a7c2ac2 fix: repair stock opening layout and expose cleanup actions`。
- 目标：修复“登记现有库存”弹窗溢出/文字竖排问题，并让管理员能从报价和仓库页找到草稿/无引用商品清理入口。

## 改动

- [WorkbenchInventoryPage.tsx](../../../frontend/src/features/workbench/WorkbenchInventoryPage.tsx)：库存登记行按行头、字段组、提示分区；仓库页增加管理员清理入口，链接直达无引用商品区域。
- [WorkbenchInventoryPage.css](../../../frontend/src/features/workbench/WorkbenchInventoryPage.css) 与 [workbench.css](../../../frontend/src/styles/workbench.css)：宽版库存弹窗使用宽度上限；字段组在桌面为三列、窄屏为两列、手机为单列。
- [WorkbenchQuotePage.tsx](../../../frontend/src/features/workbench/WorkbenchQuotePage.tsx)：报价页增加管理员删除未发出草稿入口，直达报价草稿区域。
- [TestDataCleanupPage.tsx](../../../frontend/src/features/admin/TestDataCleanupPage.tsx)：清理页面标题和说明改为业务语言，支持入口锚点定位。
- [SystemSettingsPage.tsx](../../../frontend/src/components/SystemSettingsPage.tsx)：设置入口描述改为“清理草稿与空商品”。

## 验证与发布

- 定向测试：`npm.cmd --prefix frontend run test -- src/features/workbench/WorkbenchInventoryPage.test.tsx src/features/workbench/WorkbenchQuotePage.test.tsx`，41/41 通过。
- 构建：`npm.cmd --prefix frontend run build`，通过；Vite 提示 JS chunk 595.94 kB，超过 500 kB 建议值。
- Worker dry-run：`npx.cmd wrangler deploy --dry-run --config backend/wrangler.toml`，通过；Assets 17 个文件，绑定为生产 D1 `pc-db`、R2 `pc-attachments`、Assets，正式变量与配置一致。
- 推送：`a7c2ac2` 已普通快进推送到 `origin/main`，没有强推或覆盖远端历史。
- 部署：`pc-backend` Worker 版本 `36b76790-2c3b-46db-8738-7af1ac5d95cc`，部署记录显示 100% 流量。
- 线上资源：`node scripts/check-web-release.mjs https://erp.huangqidong.cn/` 返回 HTTP 200；线上 JS/CSS 与本地构建文件名一致：`index-DXmC-XXO.js`、`index-Z4Rh2NyP.css`。
- [`check-web-release.mjs`](../../../scripts/check-web-release.mjs) 只核对线上 HTML 所引用的 JS/CSS 文件名；不证明登录、API、缓存内容或业务验收通过。

## 边界与后续

- 未应用数据库迁移，未新增、删除或修改生产商品、库存、报价等业务数据。
- 管理员清理仍受原服务端引用校验保护；报价限未发出的草稿，商品限无业务引用档案。没有实际删除生产记录。
- 未做本地或生产登录后的桌面/窄屏真实页面验收。页面静态资源一致只证明当前线上引用本次构建，不代表登录、权限或删除业务流程验收通过。
- 单行库存登记仍要求至少保留一行；“删除本行”操作移至对应行头，添加多行后可移除多余行。
- 当前生产版本与下一动作见[STATUS](../../STATUS.md)和[NEXT-SESSION-PROMPT](../../NEXT-SESSION-PROMPT.md)。
