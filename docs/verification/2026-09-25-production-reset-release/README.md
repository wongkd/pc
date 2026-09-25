# 生产旧数据清理与下线发布

- 日期：2026-09-25
- 状态：生产 D1 清理完成，Cloudflare Worker 与网页已发布；这不代表 RC 整体验收通过。
- 目标：移除旧报价/订单入口及旧店员小程序页，按用户确认清空业务数据并保留 Owner、门店和权限，随后部署。
- 入口：生产 `https://erp.huangqidong.cn/`；Worker `pc-backend`；D1 `pc-db`；R2 `pc-attachments`。

## 已确认范围

- 用户选择“只清空业务数据，保留当前 Owner、门店和权限”。生产用户、门店、成员关系、角色与权限数据均保留。
- 用户确认旧 `/quotes` 移除；此前列出的旧店员小程序“今天、开单、库存、更多”和销售/库存详情分包不是新页面，同意删除。
- 本轮不清 schema、迁移记录、备份或 R2 对象；不改支付、库存业务规则；不提交 Git。

## 旧入口处置

- 网页 `/quotes` 跳转新版 `/sales/quotes`；旧 `/orders` 与 `/orders/:id` 跳转新版 `/sales/orders`。客户详情里的订单链接改走新版订单号查询参数。
- 删除旧报价编辑器、订单页面、独有模板/硬件库编辑组件、旧存储工具及旧前端 API 包装。新版打开时会移除浏览器 localStorage 中 `pc-quote-app` 与 `pc-quote-app:merchant-templates` 两个旧键。
- 旧后端接口 `/api/search`、`/api/pdd/detail`、`/api/normalize`、`/api/dashboard/todos`、`/api/library`、`/api/templates`、`/api/quotes`、`/api/orders` 返回 HTTP 410；新版 `/api/v2/*` 路径不匹配该退役规则。
- 上述旧接口的处理函数仍保留在 `backend/src/index.ts`；路由前置退役守卫会在认证和分发前统一返回 410。本轮退役了线上功能入口，没有物理删除这些后端函数。
- 小程序 `app.json` 仅保留顾客端 `home/shop/community/mine` 四页。`node miniprogram/scripts/check-pages.mjs` 检查通过，磁盘页面与注册表均为 4 页。该代码尚未通过微信开发者工具上传、审核或发布。

## 生产 D1 清理

- 写入前仅读取表名、外键定义及行数，未读取客户、订单或报价内容。62 张业务表里有 16 张非空，共清除 90 行，包括旧报价、旧订单、订单行/收款、商品主数据、模板/硬件库、操作与审计记录等。
- 删除顺序根据生产 `sqlite_master` 外键定义计算为子表在前；先将 2 个用户的 `token_version` 各递增 1，使已签发会话失效。账号记录本身保留，现有用户需重新登录。
- 清理后，62 张业务表均为 0 行；`PRAGMA foreign_key_check` 返回 0 条。
- 保留计数：users 2、stores 1、store_members 2、roles 5、permissions 11、role_permissions 33、member_roles 2、d1_migrations 29。
- 生产 R2 桶只读复查为 0 个对象、0 B。
- 写入前取得的 D1 Time Travel bookmark：`000000fe-00000000-000050f1-7f662e65f61ba216723b0eb740a8a388`。如需恢复，应在 Cloudflare D1 Time Travel 中使用该书签，并先确认恢复点对其他生产写入的影响。

## 发布与核对

- 前端 `npm.cmd run build` 通过。产物：`/assets/index-BC2tlbGZ.css` 与 `/assets/index-D4q7yByn.js`；构建提示 JS chunk 超过 500 kB。
- `node miniprogram/scripts/check-pages.mjs` 通过。
- `node contracts/tools/validate-contracts.mjs` 通过 3,590 项；DTO 生成物检查、前端/小程序契约同步检查、跨端一致性检查均通过。单元与浏览器测试本轮未运行。
- Wrangler dry-run 确认资产、D1、R2 与环境绑定；最终 Worker 版本 `ef23cfb9-4754-4cae-a20f-77c4694b0c00`，部署时间 `2026-09-25T05:46:39Z`，100% 流量。生产路由仍为 `erp.huangqidong.cn/*`。
- `node scripts/check-web-release.mjs https://erp.huangqidong.cn/` 返回 HTTP 200，页面引用的 CSS/JS 文件名与本地构建一致。
- 生产只读 API 检查：退役接口返回 410；`GET /api/v2/workbench` 与 `/api/auth/me` 未登录时返回 401。

## 未完成与风险

- 未使用生产账号登录；登录后页面、业务流程与页面级权限未验收。D1 被清空后，ERP 为空库状态；用户需重新登录。
- Wrangler 配置已设 `keep_vars=false`，本轮最终部署会以配置里的 `REQUIRE_PERSISTENT_STORAGE`、`INVENTORY_OPENING_MODE` 两项变量覆盖 Dashboard 普通变量；旧 `PDD_*` 变量不再随部署保留。复核 `wrangler secret list` 仍有 `DEEPSEEK_KEY`、`JWT_SECRET` 两个加密 secret，未读取其值。
- 此前曾在 Cloudflare Dashboard 以明文显示的 PDD client secret 可能仍在拼多多侧有效；本轮未读取或轮换其值。凭据管理员仍需在供应商处轮换旧密钥，之后如确有新集成再通过受控流程配置。
- 生产业务验收与 RC 矩阵仍未通过；小程序代码尚未发布到微信平台。
- 用户下一步希望按小程序风格美化前端；本轮未改视觉，待另行开展。

## Git 与工作区

- 保留开工时已有的未提交改动；未 reset、clean、提交或强推。源码、契约证据行和同步生成物仅为本次路由退役/校验所需而更新。
