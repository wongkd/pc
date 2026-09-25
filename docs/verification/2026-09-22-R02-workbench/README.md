# R02 · 工作台读模型（GET /api/v2/workbench）

更新：2026-09-22。状态：**已完成并通过验收**（后端测试 + 契约门禁 + 端到端 HTTP）。
本记录只证明本次本地隔离环境的结果，不代表生产状态。

> ⚠️ **交接说明**：本卡由上一会话创建（`domains/workbench.ts` / `routes/workbench-v2.ts` / 测试 /
> 验收脚本 / 入口接线 / 契约行号平移均已完成，验收 59 项 0 失败），但在写验证卡与回执前中断。
> 本会话完成收尾：**独立核实代码与契约行号证据 → 重跑全部门禁 → 补验证卡与回执**。
> 除新增 `verify-evidence-lines.mjs`（行号落点核实工具）与本文档、回执外，**未改动任何实现代码**。

## 目标

把在办单据派生为「今天」页的待办列表与统计，让前端不再拿演示数据。

契约依据：`actions.json` R02（`GET /workbench`，**无权限门槛** —— 03 §8 权限表首行「待办老板与店员均可」），
返回 `metrics / tasks / filters / generatedAt`（`TaskReadModel` 列表）；
`objects.json` `TaskReadModel`（16 字段 + 5 条排序/去重规则）；
`fixtures.json` `datasets.V1`（响应形状与 `expected` 口径的首次冻结）；
`conventions.json` `reading.noHiddenSecurity`、`pagination.snapshot`。

## 入口与命令

| 项 | 内容 |
|---|---|
| 读接口 | `GET /api/v2/workbench`，无权限门槛（登录即可） |
| 查询参数 | `scope=open`（默认）／`category=<五类 或 all>`／`q`／`limit`（默认 50，上限 200） |
| 后端测试 | `node --test --test-concurrency=1 backend/tests/r02-workbench.test.mjs`（17 项） |
| 端到端验收 | `node docs/verification/2026-09-22-R02-workbench/verify-r02.cjs` |
| 行号证据核实 | `node docs/verification/2026-09-22-R02-workbench/verify-evidence-lines.mjs` |

## 本轮实际验证（交接会话实跑）

| 检查 | 结果 |
|---|---|
| 后端全套测试 | **351 用例 / 351 通过 / 0 失败**（B16 基线 334；本卡新增 `r02-workbench.test.mjs` 17 项） |
| 契约校验 `validate-contracts.mjs` | **3476 通过 / 0 失败**（与 B16 基线一致 —— R02 **未改契约语义**，只平移行号） |
| `generate-dto --check` / `frontend sync-contracts --check` / `miniprogram sync-contracts --check` | 四处生成物与 `contracts/v1` 一致 |
| `check-client-parity` / `sync-error-codes --check` | 通过（18 个错误码两端一致） |
| `check:migrations` | 0000–**0024** 连续无缺号（25 文件），下一个 **0025** |
| 端到端 HTTP 验收 | **59 项 / 0 失败**（`report.json`，14 秒） |
| 行号证据落点核实 | **26 处引用全部落点正确**（21 处权限守卫 + 5 处正常例外，见下文） |
| `check-doc-links` | 214 链接 / 0 断链 |

## 验收覆盖（`verify-r02.cjs`，真实登录 + 真实 HTTP，A/B/C 三段）

- **A 段 · 入口层**：匿名 401、非 GET 405、非法 `category`/`scope`/`limit` 一律 400（不静默忽略）、
  `category=all` 等价于不传、契约信封含 `meta.contractVersion=v1`。
- **B 段 · 造四类待办**（全走真实业务链路，不写测试后门）：缺货单（B12 建数量件 → 报价 → 发出 → 转单 → 付清 → 确认成交）、
  待交机（B12 建逐件 → B13 期初 → 报价 → 转单 → 付清 → 确认成交）、维修单（B20 接修）、回收单（B26 登记）。
- **C 段 · 读模型口径**（C1–C40）：
  - 四类各就各位；**缺货单归 `stock_shortage` 且不同时作为可交付重复出现**（卡点优先）；
  - 主动作码正确（**还没备料的单给 B06 而不是 B10** —— 点了必然 400 的动作不能给）；
  - **`metrics` 与 `tasks` 出自同一次快照**：`taskTotal`/`pendingDelivery`/`stockShortage`/`servicePending`
    与 `tasks` 计数一致；`receivable` 只累加 `countsTowardReceivable=true` 的 `balanceCents`；
  - **筛选与 limit 改动汇总口径**：`category` / `limit` / `q` 只影响 `tasks`，`metrics` 仍按全量算
    （`conventions.pagination.snapshot`），界面才能区分「没待办」与「筛掉了」；
  - 未确认收购的回收单**不计应收**，初估只落 `estimateCents` 不冒充确定应收；
  - 16 个契约字段齐全且**不多出契约外字段**；`taskId` = `entityType + entityId`；
    `blocker.code` 全部来自 `errors.json`；禁用的主动作必须给可读原因；
  - 排序：无交期事项排在已知交期之后，且 `deadlineText` 为 `null`（界面显示「未约定」）；
  - **★ 响应里没有成本 / 供应商 / 毛利字段**（服务端就没取，不是前端隐藏）。

后端测试额外覆盖（HTTP 验收跑不到的部分）：**跨店隔离**（别家店的单不出现在本店工作台）、
**无任何权限的店员照样能拿到工作台**（R02 无门槛）、`ready_delivery` 阶段的 B10 与三条交付卡点
（检测 / SN / 尾款）、空门店不编数字（无待办就是 0）。

## 改动范围

**后端（新增 3 个）**

- `backend/src/domains/workbench.ts`：读模型。**一次批量 SQL** 读齐销售单 / 工单 / 回收单
  （不按行回调 `queryFulfillmentBoard`，避免 N+1 拖垮工作台），派生待办与五项统计。
  缺件口径复用 `querySaleOrders` 的同一算法（行数量 − 该行有效数量占用），不另立第二套。
- `backend/src/routes/workbench-v2.ts`：路由。**只认领 `/api/v2/workbench` 这一条精确路径**，
  不对更宽前缀兜底 404（兜底会吃掉后面接的链路 —— E05 实测过）。
- `backend/tests/r02-workbench.test.mjs`：17 项。

**后端（修改 1 个）**

- `backend/src/index.ts`：顶部 **+2 行**（1 行注释 + 1 行 import），分发行 **+5 行**
  （在文件末尾的 `/api/v2` 分发链尾部，`routeAttachV2` 之后、404 兜底之前 ⇒ **不影响任何证据行号**）。

**契约（修改 1 个，纯行号平移）**

- `contracts/v1/actions.json`：`legacyPermissionMap` 与 `specBasis` 里指向 `backend/src/index.ts`
  的**绝对行号证据整体 +2**（因入口顶部加 2 行）。**无语义变更**，故契约校验通过数与 B16 一致（3476）。

**验收与记录（新增）**

- `verify-r02.cjs` + `report.json`（上一会话）、`verify-evidence-lines.mjs`（本会话补）、本 README、
  `docs/verification/progress/R02.json`。

## 契约行号证据核实（本会话补做，为什么值得单列）

`shift-index-lines.mjs` 按**固定步长**整体平移行号 —— 这本身不保证落点正确：
若插入行数数错、或脚本被重复执行（仓库里存在一个来历不同、时间为 14:22 的 `actions.json.bak-r02`），
**校验器仍可能通过，而证据已悄悄指错行**（项目踩坑记录里明确要求「改完逐行复验落点」）。

因此本会话补了 `verify-evidence-lines.mjs`，把**每一处引用的实际行内容**打出来逐条比对。实测：

- 共 **26 处**绝对行号引用；
- **21 处**落在 `requirePermission(...)` 守卫行上 ✅；
- **5 处**属正常例外，逐条确认无问题：
  - `L126` / `L154`（×2）/ `L500`：`context.permissions.includes(...)` 形态的**成本可见性判定**（权限相关代码，非守卫写法）；
  - `L730`（`specBasis`）：指向 `hardware` 查询里的 SQL 拼接逻辑 —— `specBasis` 记的是**规格依据所在位置**，本就不要求是守卫行。

⇒ 结论：**入口顶部的插入行数（2 行）与 `SHIFT=2` 一致，行号平移正确，无双重平移。**

## 与契约样本「故意不同」的地方（都记了理由，不是漏改）

| 项 | 契约样本 | 实现 | 理由 |
|---|---|---|---|
| `taskId` | 主键形态 | **用单号**（`sale_order:SO-...`） | `entityId` 取业务单号（`UNIQUE (store_id, order_no)` 保证店内唯一），与样本里 `entityId="DEMO-SO-003"` 的形态一致；两者必须能拼起来，否则前端拿 `taskId` 做 key、拿 `entityId` 显示单号会各说各话 |
| `detailTarget` | `/orders/DEMO-SO-003` | **指向真实存在的路由**（`/sales/orders`、`/after-sales`、`/recovery`） | 旧的 `/orders/:id` 页里是 `Number(id)`，而 v2 销售单 id 是字符串 ⇒ 指过去只会得到 NaN 空页 |
| `collection` 类目 | 枚举里有 | **本轮不生成** | 契约 V1 样本里 `collection` 为 0 条、`expected.categoryCounts` 只有四类，无先例 ⇒ 不自己发明指标（留白已登记） |
| 主动作码 | `testing` 阶段的单也标 B10 | **按履约阶段分档**（B06/B07/B10） | `deliverSaleOrder` 第一道闸门是 `fulfillment_state !== 'ready_delivery'` 直接 400 ⇒ 给必然失败的动作等于骗操作人。契约那处是读模型样本的形态演示，**以后端实际闸门为准** |

## 已知未做 / 未验证

1. **前端「今天」页仍是演示数据**：`WorkbenchTodayPage.tsx` 仍硬编码
   `DEMO_METRICS` / `DEMO_TASKS` / `demoVisual`，**没有调用 `/api/v2/workbench`**。
   ⇒ 后端已就绪、**前端未接**，属前端卡（与 B16 / F1 / F2 / F3 同一种模式）。
2. **照片字段一律 `null`**：附件读路径归 BK-05（接修 / 回收详情读模型带出），本卡不半接。
3. **`detailTarget` 只到业务工作区**，精确到单的深链要等前端补出 `/sales/orders/:id` 之后再改。
4. **`collection`（待收款）类目不生成**，见上表。
5. 未跑前端测试与浏览器验收（本卡**无前端改动、无新页面**）；未跑微信真机；未访问生产；未部署。
6. 远端迁移状态未核实（本轮无新迁移，B16 的 0024 是否已应用远端同样未核实）。

## 未决项（留给后续卡）

| # | 事项 |
|---|---|
| 1 | 前端接线：`WorkbenchTodayPage.tsx` 换掉演示数据、接 `/api/v2/workbench`，并补浏览器验收（**UI 必须实际看图**） |
| 2 | D-E：`demoData.ts` / `demoInventory.ts` 仍在仓库且被今天页引用 ⇒ 营业版本发布前要做演示/真实入口隔离与产物检查 |
| 3 | `collection` 类目的口径：需要契约给先例（或栋哥拍板）后才能生成，否则不发明指标 |
| 4 | `detailTarget` 深链：等前端 `/sales/orders/:id` 存在后改为精确到单 |
| 5 | `resources` 未接：BK-05 给出附件读路径后，`photoKind` / `photoUrl` 才能有值 |
