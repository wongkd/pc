# 管理员测试数据清理

日期：2026-09-26
状态：已部署生产；静态门禁通过。管理员登录后的浏览器业务验收未做。
目标：让门店管理员从一个入口清理无业务影响的测试记录，同时保住库存、资金和顾客交接轨迹。

## 入口与范围

- 设置 → 测试数据清理：`/settings/data-cleanup`。
- B45：只清理从未发出、未分享、未转销售单的报价草稿，后端会在写入批次中复核。
- 旧版 `quotes.data` 工作副本不在列表中；源码和字段结构尚未核实，不自动清理。只要当前门店存在这份旧副本，B46 会 fail closed，不列出该店任何商品为删除候选。
- B46：只清理没有库存、库存流水、新版报价、采购、销售、旧订单、盘点或附件引用的商品主档。查询候选和删除都要求 `store/manage`；删除前会在同一幂等写入中再次检查引用。
- 操作原因和操作者保存在操作结果记录中；不删除商品版本日志、库存、单据、附件或库存流水。
- 回收登记会立即产生顾客设备暂存记录，没有可硬删的空白草稿；应走“归还客户”。销售、采购、售后及实物按各自取消、退货、归还、盘点差异或退役流程处理。B39 报损动作仍未开放。

## 变更入口

- 页面：`frontend/src/features/admin/TestDataCleanupPage.tsx`、`frontend/src/features/admin/test-data-cleanup-api.ts`。
- 路由与权限：`frontend/src/App.tsx`、`frontend/src/components/SystemSettingsPage.tsx`、`backend/src/routes/inventory-v2.ts`、`backend/src/routes/quote-v2.ts`。
- 业务守卫：`backend/src/domains/inventory.ts`、`backend/src/domains/quote.ts`。
- 协议：`contracts/v1.1/`，保留 `contracts/v1/` 历史快照；未改数据库迁移。

## 本轮执行与证据

生成与静态门禁：

```text
node contracts/tools/validate-contracts.mjs                 通过 3608 项；9 条既有提示
node contracts/tools/generate-dto.mjs --check              通过
node frontend/scripts/sync-contracts.mjs --check            通过
node miniprogram/scripts/sync-contracts.mjs --check         通过
node contracts/tools/check-client-parity.mjs                通过
node contracts/tools/generate-d10-contract.mjs --check      通过
node scripts/check-doc-links.mjs                             通过，0 个断链
npm.cmd run build （frontend）                              通过；Vite 提示 JS chunk > 500 kB
git diff --check                                             通过
```

## 生产发布回执（2026-09-26）

- 发布目标：`pc-backend`，路线 `erp.huangqidong.cn/*`；Worker 版本 `ec14139c-e51f-457d-a8e8-413240644342`，Wrangler 部署列表确认 100%。
- 同步资产：`index-BpcqvCym.js`、`index-B9uV-T6V.css`；生产首页 HTTP 200，页面引用的 JS HTTP 200，资源包含清理入口与 `/settings/data-cleanup` 路由。
- 生产 API 未登录 GET 返回 401「请先登录」；未使用管理员会话验证 UI 或写操作。
- 部署前 dry-run 确认 `pc-db`、`pc-attachments`、Assets 绑定及正式变量；远端迁移检查结果为无待应用迁移。没有改数据库结构，也没有删除或写入生产业务记录。
- 发布从隔离工作树只带入本功能及 v1.1 契约相关文件；未带入主工作区其他未提交 UI 改动。发布源码未提交到 Git。

## 验收边界与下一步

未运行本轮应用测试，未做登录后浏览器业务验收。当前可以在 ERP「设置 → 测试数据清理」使用；先核对列表与影响提示。若需要验证删除行为，请用本地或专用隔离环境的合成报价和商品逐条核对；不要用生产记录试删。商品候选受业务引用保护；库存实物、流水、顾客设备交接与交易历史不提供硬删。
