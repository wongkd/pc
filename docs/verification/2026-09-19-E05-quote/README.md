# E05 · 报价闭环接真实接口（ERP 侧）

日期：2026-09-19。范围：把 0009 的报价四张表接上 HTTP 路由与界面，补客户外键（0011），
落地 D-C 权限码裁定，前端新增报价列表 / 编辑 / 详情 / 打印脱敏 / 过期续期。

本目录属于**本地实现 + 本地验收**：真实 Worker 入口 + 内存 D1 + 真实 HTTP，不连生产、不部署、不应用远端迁移。

## 0. 开卡四项裁定（栋哥 2026-09-19）

| # | 裁定 | 落点 |
|---|---|---|
| ① | 契约 `QuoteStatus` 没有「顾客已确认」态 ⇒ **本轮不做确认动作** | 全程未碰冻结枚举；「确认后不能改」这道闸本轮不存在（见 §4 边界） |
| ② | **只做 ERP 侧**，顾客侧分享页与 T03a 一起 | 凭证已随发出签发（只存摘要），校验/过期判定留 Q-09 |
| ③ | 到期提醒**站内真实可用 + 规则参数化**（微信订阅消息需小程序内授权入口，现在推不出去） | 列表「已过期 / 即将到期」标记 + 详情「剩 N 小时」；`QUOTE_SETTINGS` 集中定义（24h / 提前 2h / 锁定 7 天 / 定金 15%），随每次发出写进 `terms_snapshot` |
| ④ | 客户接口权限码改用契约正牌码 `sales/order-view` / `sales/order-edit` | E05-4（见 §2.3），旧码保留兼容 |

## 1. 入口与命令

| 用途 | 命令（仓库根） |
|---|---|
| 起隔离后端 | `npm --prefix backend run dev:local` |
| 起网页端（`/api` 代理到本地后端） | `npm --prefix frontend run dev` |
| 浏览器验收 | `node docs/verification/2026-09-19-E05-quote/verify-quote.cjs` |
| 后端接口测试（33 用例） | `node --test backend/tests/e05-quote-http.test.mjs` |
| 前端报价页测试（12 用例） | `npx --prefix frontend vitest run src/features/workbench/WorkbenchQuotePage.test.tsx` |

演示账号：`owner@local.test` / `local-preview-pass`（只存在于内存）。页面入口：顶栏「开单」→「新建装机报价」卡片 → `/sales/quotes`。

## 2. 接了什么

### 2.1 数据层（0011）

`backend/migrations/0011_quote_customer_fk.sql`：把 `quote_headers.customer_id` 补上**同店复合外键**
`(store_id, customer_id) → customers(store_id, id)`。SQLite 不支持 ALTER 加约束 ⇒ 整表重建
（建新表 → 拷数据 → DROP → RENAME）。普通外键只能证明「客户存在」，拦不住 A 店报价挂 B 店客户。
前置条件（写在迁移注释里）：0009/0010/0011 均未应用远端、`quote_headers` 为空。

### 2.2 后端链路

| 契约条目 | 方法 / 路径 | 权限码 | 说明 |
|---|---|---|---|
| B01 | `POST /api/v2/sales/quotes` | `sales/quote-edit` | 创建草稿（header + revision 1 draft） |
| B02 | `POST /api/v2/sales/quotes/:id/save` | `sales/quote-edit` | 保存版本；草稿反复保存不涨版本号，已发出后再保存 = 新版本 |
| B02 | `POST /api/v2/sales/quotes/:id/issue` | `sales/quote-edit` | 发出（draft → issued，不可覆盖）；签发分享凭证 |
| R05 | `GET /api/v2/sales/quotes` | `sales/quote-view` | 列表 + 汇总 + 门店参数 |
| R05 | `GET /api/v2/sales/quotes/:id?revision=N` | `sales/quote-view` | 详情；默认读「当前工作版本」（有草稿读草稿） |

| 文件 | 改动 |
|---|---|
| `backend/src/domains/quote.ts` | **新增**。报价领域逻辑：校验、金额服务端重算、B01/B02 的 plan + 入口、R05 读模型、过期判定 |
| `backend/src/routes/quote-v2.ts` | **新增**。契约信封、权限、入参解析、`guidanceFor()` 兜底文案 |
| `backend/src/domains/access.ts` | **新增**。新权限码与旧码兼容表（`LEGACY_EQUIVALENT`，依 legacyPermissionMap） |
| `backend/src/routes/inventory-v2.ts` | **改 1 处**：兜底 404 从「所有 `/api/v2/*`」收窄为「`/api/v2/inventory*`」。原来它对一切 v2 路径兜底 404，报价路由永远不会被调用（实测症状）。`/api/v2/operations/:requestId` 仍由它先行接管 |
| `backend/src/index.ts` | 顶部 +2 行 import；`requirePermission` 支持数组（行数不变）；客户接口改用新码常量；末尾 +4 行分发。**重跑契约校验**，25 处证据行整体 +2（用文本外科替换，行数零变化） |
| `backend/migrations/0011_quote_customer_fk.sql` | **新增**（见 §2.1） |
| `backend/tests/e05-quote-http.test.mjs` | **新增 33 用例** |
| `contracts/v1/actions.json` | 25 处 `backend/src/index.ts:NNN` 证据行 +2、specBasis 1 处 +2；quote/view 的 note 更新（D-C 已裁定） |
| `contracts/v1/legacy-mapping.json` | 登记 `quote_headers__v11`（重建表的过渡名，如实登记而非绕过校验）；sources 补 0011；quote_headers 条目 notes 更新（外键已补） |

### 2.3 权限码（D-C 落地）

- 客户接口从复用 `quote/view` / `quote/edit` 改为**契约正牌码** `sales/order-view` / `sales/order-edit`，**旧码保留兼容**
  （门店角色行里存的就是旧码，只认新码会让所有店员立刻失去客户权限 —— 与 E04b 的 `LEGACY_EQUIVALENT` 同一机制）。
- 报价链路认 `sales/quote-view` / `sales/quote-edit`，兼容 `quote/view` / `template/*`。
- `actions.json` 的 quote/view note 已如实更新；actuallyGuards 不变（旧码仍能访问客户接口，描述仍成立）。

### 2.4 前端

| 文件 | 改动 |
|---|---|
| `frontend/src/features/workbench/quote-api.ts` | **新增**。走 T03b 请求核心（v2 管报价、根路径管旧客户接口） |
| `frontend/src/features/workbench/WorkbenchQuotePage.tsx` | **新增**。列表 / 编辑（选客户、四类来源行、二手选实物、客供选设备）/ 详情 / 打印脱敏 / 过期续期 |
| `frontend/src/features/workbench/WorkbenchQuotePage.test.tsx` | **新增 12 用例** |
| `frontend/src/styles/workbench.css` | 追加 `.wb-quote-*` 样式（只用 theme.css 已定义的变量） |
| `frontend/src/App.tsx` | 路由 `/sales/quotes`；SALES_WORKSPACE 占位项「新建装机报价（T07）」落地 |

## 3. 实测发现并修掉的缺陷

都不是推测，是这一轮跑出来的：

1. **`inventory-v2` 兜底 404 吞掉一切 `/api/v2` 路径。** 它对不认识的 v2 路径返回契约 404 而不是 null，
   报价路由排在后面永远不会被调用。修：兜底收窄到 `/api/v2/inventory*`。**这是两条 v2 链路共存的必要前提。**
2. **同路径双方法漏分发。** `POST /sales/quotes`（B01）与 `GET`（R05）同路径，初版只放行 GET，POST 全 405。
3. **issue 的幂等重放会先撞业务预读。** 发出成功后草稿已变 issued，客户端超时重试会先拿到「没有待发出的草稿」400
   而不是复用原成功结果。修：重放保护（按原 requestId 查幂等记录）移到业务预读**之前**；载荷摘要改为只含客户端输入。
4. **纯草稿（`current_revision = 0`）的详情一行都看不到。** 详情默认读 currentRevision，而 B01 建的行挂在 revision 1。
   修：默认读「有草稿读草稿，否则最新已发版」。
5. **`baseUrl '/'` 把 `/api/customers` 拼成 `//api/customers`**（协议相对 URL），请求根本到不了后端 ——
   浏览器验收抓到的，单测照不出来。修：客户客户端 baseUrl 用空串。
6. **续期按钮条件写错。** 服务端会把超过有效期的 issued 直接算成 expired，`status === 'issued'` 的判断让过期单永远等不到续期按钮。
7. **验收脚本自己的三处错误**（不是产品缺陷，记录防复发）：改版后应付算错（2999−100=2899，不是 2999）；
   版本历史断言选到了页面上的两张表；打印弹窗断言找错了单（续期流程后详情停在过期单）。

## 4. 已确认成立的行为（实跑）

- 未登录 401；无权限店员读写报价全 403（契约信封）；只有读码写不了（403）。
- 旧码 `quote/view` 能读报价与客户；新码 `sales/quote-view` / `sales/order-view` 同样能读；两者都没有则 403。
- 创建：落 header + revision 1 draft；金额服务端重算；行小计客户端送多少都不采信。
- 客户外键：不存在/跨店的客户 404 且不落库（0011 的同店复合外键 + 写前守卫）。
- 幂等：同 requestId 同载荷复用（含 issue 重放）；改载荷 409 `IDEMPOTENCY_MISMATCH`；缺 requestId 400。
- 版本：草稿反复保存不涨 revision；`expectedVersion` 落后 409 `VERSION_CONFLICT` 且内容不变；
  发出后改价生成新版本，旧版本金额原样留在账上（v1 ¥2,899 / v2 ¥2,799 并存）。
- 发出：draft → issued、validUntil = 发出时刻 + 24h、current_revision 前进、签发分享凭证；
  **凭证只存摘要**（明文不在库里、不在幂等记录的 effects 里），明文只在签发那次响应出现，页面明示「只显示这一次」与「顾客端页面尚未开通」。
- 校验拦截：客供件带价 / 缺来源设备、二手缺实物 / 数量≠1、优惠超小计、空单发出 —— 全 400。
- 红线：报价全程 `stock_reservations` / `inventory_movements` 零写入，实物 availability 不变；
  报价与打印响应里没有成本 / 供应商 / SN / 预算字样（数据源头就没有，不是前端藏）。
- 续期：过期单出现「续期 24 小时」→ 保存新版本（内容不变）+ 发出 → 新版本已发出，提示旧链接锁旧版本。
- 浏览器 53 项 0 失败：入口可达、空态引导、三类来源行、实时合计、改版原因随快照、打印弹窗内容正确、
  1920/1440/1280/390 无横向溢出、无页面 JS 错误、无意外 4xx/5xx、全程只请求 127.0.0.1。

## 5. 实跑证据（本轮全量）

| 检查 | 结果 |
|---|---|
| 后端测试 | **158 通过 / 0 失败**（本卡新增 33；E04b 基线 125） |
| 前端测试 | **13 文件 150 用例通过**（本卡新增 12；此前 138） |
| 前端构建 | 通过（`tsc -b` + vite build） |
| 契约校验 | **通过 3239 项 / 0 失败**（E04b 基线 3233；新增 0011 表登记等） |
| 生成物 / 同步 / 跨端一致性 / 错误码 | 4 项 `--check` 全部通过 |
| 浏览器验收 | **53 项 / 0 失败 / 0 页面错误**（报告 `logs/report.json`，截图已人工查看） |
| 前端 lint | 39 项既有失败（35 error + 4 warning），**本卡新增 0**；新文件不在报告里 |
| 文档链接 | 通过（收工时复跑） |

## 6. 未验证 / 未做（不要当已完成）

- **「确认后不能改」这道闸不存在**：契约没有 confirmed 态（裁定①）。本轮只拦「已发出不能原地改写」。
- **顾客侧**：分享凭证已签发但校验/过期判定未实现（Q-09）；顾客页面未做；微信身份（T03a）未做。
- **B03（报价转销售单）未接**：convert 会产生库存预留，属收款/订单卡。
- **未部署、未应用远端迁移**（0006–0011 全部只在本地）；生产/测试隔离未核实。
- **微信真机、小程序端**完全不涉及。
- **续期时长 / 提醒提前量**目前是代码常量（`QUOTE_SETTINGS`），不是门店可配参数 —— 要改数值得改代码。
- **配送阶梯（Q-03）、延保定价（R10）**未定，界面写「待设置」，未编造运费。
- 键盘序列、对比度完整验收仍未做（V-01 仍开着）；本轮沿用 E04b 补过的焦点样式。
- **`quote_lines.customer_device_ref` 是 TEXT**，存的是 `customer_devices.id` 的字符串，无外键（类型不匹配，随 E10 处理）。

## 7. 下一步

1. **契约补「已确认」态**（QuoteStatus 加值或新增动作，走契约修订）→ 补「确认后不能改」的闸与确认动作。
2. **顾客侧一刀**：T03a 顾客微信身份 + 凭证校验/过期判定 + 顾客只读页（Q-09 关口）。
3. **收款与锁库存**：B03 convert、定金登记、预留与到期自动释放（业务规则 R12–R16）。
4. 收尾两件旧账：D-D/G-20/G-21（路由与导航收敛）、旧商品页职责边界 —— 均为 E03 前置。
