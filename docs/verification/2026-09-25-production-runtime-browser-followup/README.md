# 生产运行状态与浏览器续验回执

- 日期：2026-09-25
- 核查时间：2026-09-25 02:19–02:31 UTC
- 状态：生产 Worker 版本、路由、D1/R2 绑定和未登录接口已只读确认；生产 ERP 浏览器停在登录页，员工页面验收及真实业务流程未完成。**不构成发布候选整体验收通过。**
- 目标：复核生产 Worker 当前版本、`workers.dev`、ERP 路由、资源绑定及当前生产浏览器可访问状态；明确认证和真实数据的阻塞。
- 关联历史：[生产发布只读核查](../2026-09-25-production-release-readiness/README.md)、[发布候选验收矩阵](../2026-09-25-release-candidate-acceptance/README.md)、[本地网页逐页续验](../2026-09-25-web-browser-acceptance/README.md)、[数据与附件上线保障计划](../../plans/2026-09-25-data-attachment-go-live/README.md)。

## 本轮范围

- 生产控制面、D1 查询和浏览器访问均为只读。本轮没有登录生产 ERP、写入生产单据/库存/客户、发起付款、上传附件、创建资源、执行迁移或再次部署。
- 前一阶段的生产操作状态由本次接续信息提供：`pc-db` 已先备份并做克隆演练，之后应用 0006–0028；R2 `pc-attachments` 已创建；生产 Worker `pc-backend` 已经发布；ERP 路由已从 Preview Worker 移到生产 Worker。下面会标明哪些结果由本轮独立复核，哪些只来自接续信息。
- Edge 的 ERP 标签保留在登录页供用户本人接手。没有填写账号、密码、验证码或会话令牌。

## 生产 Worker、路由与绑定

| 检查项 | 本轮结果 |
|---|---|
| Worker 与当前版本 | `npx wrangler deployments list --config wrangler.toml` 与 `npx wrangler deployments status --config wrangler.toml` 均显示生产 Worker `pc-backend` 当前 100% 流量在版本 `309b3528-ce24-42af-b335-74bca2bbaff3`；部署时间 `2026-09-25T02:19:23Z`。此前 02:13Z 的版本不是当前版本。Wrangler 版本为 4.105.0。 |
| `workers.dev` | Cloudflare Dashboard 的 `pc-backend / 生产 / 域` 页面显示 `pc-backend.563838884.workers.dev` 的生产开关已开启；预览 workers.dev 开关也开启。Dashboard 中该页面及设置页为本轮 Edge 实看。 |
| ERP 自定义路由 | 同一生产 Worker 的域名路由表显示 `erp.huangqidong.cn/*`，类型为“路由”，区域 `huangqidong.cn`。因此此前所述绑定到 Preview Worker 的状态已被生产 Worker 路由表取代。 |
| D1 / R2 | Dashboard 的生产“绑定”区显示 `DB → pc-db`、`BUCKET → pc-attachments`。与当前 `backend/wrangler.toml` 中生产库名/ID、R2 桶名相符。 |
| 运行时变量 | Dashboard 显示 `REQUIRE_PERSISTENT_STORAGE=true`、`INVENTORY_OPENING_MODE=disabled`。本轮未读取或记录任何密钥值。 |
| Assets 与页面 | 源配置定义 `ASSETS` 绑定及 SPA 回退；Edge 打开生产 `https://erp.huangqidong.cn/quotes` 实际返回 ERP 登录页面。未登录状态不验证应用内数据请求或受权页面资源。 |

源配置 `backend/wrangler.toml` 同时含生产 `workers_dev=true`、D1/R2/Assets 和 `erp.huangqidong.cn/*`。曾供发布使用的 `backend/wrangler.stage.toml` 内容是去掉路由的临时配置；本轮查明全仓没有该文件引用，确认线上版本、绑定与源配置一致后已删除该临时单文件。未改动其他工作区文件。

### 凭据发现

Cloudflare 生产设置页把 `PDD_CLIENT_ID`、`PDD_CLIENT_SECRET`、`PDD_PID` 列为普通 runtime variables；其中 `PDD_CLIENT_SECRET` 在页面上以明文显示。此次没有复制或记录变量值，也没有变更变量。请将该明文变量按已暴露处理，由有权限的维护者通过受控密钥流程轮换，并改存为 Worker secret；`keep_vars=true` 仍需保留到旧变量完成迁移。`JWT_SECRET` 与 `DEEPSEEK_KEY` 在同页显示为加密 secret。

生产设置页含明文凭据，所以没有把整页截图导出到仓库。配置事实用页面逐项观察和不含凭据的只读查询结果记录，避免将敏感值扩散到验收证据。

## 生产 API 与 ERP 浏览器页面

### `workers.dev` API

当前源码在 `backend/src/index.ts` 注册 `GET /api/auth/me`；未提供 Authorization 的会话检查预期应返回登录要求。本轮用命令行只发起此单一只读 GET：

```text
curl.exe -i --max-time 25 https://pc-backend.563838884.workers.dev/api/auth/me
```

实际响应为 HTTP `401 Unauthorized`，JSON `{"error":"请先登录"}`；`Date: Fri, 25 Sep 2026 02:28:09 GMT`，`CF-RAY: a4069807ae8e7ab6-SJC`。这证明当前 `workers.dev` 主机上的 API 路由可达并进入会话守卫；未登录请求本身不证明受权 API 及页面正常。之前浏览器地址栏直接打开同一 API 路径被浏览器客户端拦截（`ERR_BLOCKED_BY_CLIENT`），所以接口状态以这次 HTTP 响应为准。此前记录的 404 本轮未复现。

### Edge ERP 页面

- 通过真实 Edge 打开 `https://erp.huangqidong.cn/quotes`，页面标题为“土豪弟弟 - 企稳稳科技”；可见应用标题“装一下机 · 门店 ERP”、登录说明“登录门店，继续处理报价、库存与客户”、账号/邮箱和密码输入框、“登录”及“凭邀请码加入门店”按钮。
- 页面停留在登录状态。用户需要在已保留的 Edge 标签中自行完成登录，随后再由用户指示是否继续受权页面只读验收。不要在该标签提交登录信息给代理。
- 登录成功前，客户台账、库存、报价、销售、履约、售后、回收和员工角色页面均未逐页检查；员工页面级权限显示/隐藏仍是 RC 缺项。

## D1 迁移与数据条件

本轮仅做生产 D1 只读查询，均为 `changed_db=false`、`rows_written=0`：

```text
npx wrangler d1 execute pc-db --remote --command "SELECT name FROM d1_migrations ORDER BY name;" --json --config wrangler.toml
npx wrangler d1 execute pc-db --remote --command "PRAGMA foreign_key_check;" --json --config wrangler.toml
npx wrangler d1 execute pc-db --remote --command "SELECT (SELECT COUNT(*) FROM customers) AS customers, (SELECT COUNT(*) FROM stock_items) AS stock_items, (SELECT COUNT(*) FROM quotes) AS quotes, (SELECT COUNT(*) FROM sale_orders) AS sale_orders, (SELECT COUNT(*) FROM service_orders) AS service_orders, (SELECT COUNT(*) FROM recovery_orders) AS recovery_orders, (SELECT COUNT(*) FROM attachments) AS attachments;" --json --config wrangler.toml
```

- `d1_migrations` 返回 29 行，从 `0000_baseline.sql` 连续到 `0028_document_export_attachments.sql`；`0003_orders.sql` 与 `0004_sn.sql` 现记录为带 `.sql` 的名称。数据库 `PRAGMA foreign_key_check` 返回空结果。
- 计数为：`customers=0`、`stock_items=0`、`quotes=1`、`sale_orders=0`、`service_orders=0`、`recovery_orders=0`、`attachments=0`。只查计数，未读取那条 quote 的客户或内容；因此不基于单一数量判断其新旧。
- 用户提供的先前操作报告说明备份前后旧单据数量未变；本轮没有读取旧单据行，也没有重新比较其数量。
- `npx wrangler d1 migrations list DB --remote --config wrangler.toml` 在非交互命令环境因未设置 `CLOUDFLARE_API_TOKEN` 退出；因此本轮不声称该 CLI 清单成功。本轮以直接查询 `d1_migrations`、外键和计数结果核实数据库状态。接续信息中的“待迁移 0、旧单据数不变”未通过该 CLI 再次独立确认。

## 验收边界与接手步骤

### 已验证

- 生产当前 Worker 版本与 100% 部署权重。
- Cloudflare Dashboard 中生产 workers.dev 开关、ERP 路由以及 D1/R2 绑定。
- ERP 路由可在真实 Edge 加载登录页面；`workers.dev` 的当前只读会话 API 返回预期 401。
- D1 迁移记录 0000–0028、外键检查为空，以及业务表计数。
- 删除了已无引用的临时发布配置 `backend/wrangler.stage.toml`。

### 未验证

- 账号登录后的逐页浏览器验收和员工角色页面级显示/隐藏。
- 客户、库存和真实业务交易；当前客户与库存为空。未伪造生产库存、客户、付款、销售、售后或回收交易。
- 生产附件 API 实际 R2 上传/授权下载、R2 内容完整性/应用层 canary、跨实例读取。
- 使用生产备份执行完整恢复、Production Worker 代码回退与恢复后的业务兼容性；本轮不重复这些操作。
- 原发布候选验收矩阵中的其他缺项。所有本地合成业务流仍仅证明本地 Worker/D1 行为。

### 用户接手

1. 在保留的 Edge 标签 `https://erp.huangqidong.cn/quotes` 亲自输入生产账号并完成登录；不要把密码、验证码或 token 发到文档或聊天中。
2. 登录后确认是否授权我继续仅做生产只读页面验收。没有现存真实数据的页面记录为空态；不要为验收创建生产客户、库存或交易。
3. 让凭据管理员轮换当前以普通变量保存的 PDD client secret，再按受控流程迁入加密 Worker secret；不在聊天或仓库粘贴变量值。

## 总体结论

生产 Worker 与路由现已部署和绑定，生产 D1 迁移状态由只读查询确认；这表示生产运行时已变更，不表示生产 ERP 整体已验收或可宣布整体验收通过。无登录会话、无客户/库存与新业务单据，因此本轮没有进行真实销售、收款、履约、售后、回收或员工页面权限验收。原 RC 矩阵保留未通过状态，后续以本回执和后续授权验收更新当前事实，不覆盖旧历史证据。
