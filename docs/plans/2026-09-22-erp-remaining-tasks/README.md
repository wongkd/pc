# 新版 ERP 剩余任务清单（可复制执行版）

日期：2026-09-22 ｜ 范围：**仅网页端 ERP**（不含顾客端小程序）
用途：栋哥把下面每张卡的提示词复制到不同对话框，交给独立会话执行。

> **进度更新 2026-09-22 15:50**：**BK-02（B16 盘点录入与差异批准）已完成并通过验收。**
> 后端 334 用例 0 失败、契约 3476 通过 0 失败、端到端 `verify-b16.cjs` 37 项 0 失败；
> 迁移 `0024_inventory_counts.sql`。见 [B16 验证卡](../../verification/2026-09-22-B16-count/README.md)
> 与 `docs/verification/progress/B16.json`。**B16 的两条路径都在 `/api/v2/inventory` 前缀下，
> 由既有 `routes/inventory-v2.ts` 认领 ⇒ 本轮没有改 `backend/src/index.ts`，不涉及证据行号平移。**
> 剩余主动作：**B30 整备上架（BK-03）、B36 生成单据（BK-04）**；**读接口缺口已清零**
> （BK-01 R02 工作台读已于 2026-09-22 完成并通过验收：后端 351/351、端到端 59 项 0 失败，
> 见 [R02 验证卡](../../verification/2026-09-22-R02-workbench/README.md)与 `docs/verification/progress/R02.json`）。
> ⚠️ B30 的口径已由栋哥 2026-09-22 拍板：只对「来自回收单、未拆件、回收单处于 acquired」的实物生效，
> 整备时把回收单推到 `refurbishing`，门槛齐备后推到 `ready_for_sale`（与 B44 拆件天然互斥）；
> B36 本轮只做 html 白名单快照，pdf/image 请求返回明确的不支持错误。

---

## 一、先看结论：还剩多少

| 层面 | 总数 | 已完成 | 剩余 |
|---|---|---|---|
| 契约正式动作（B 码） | 42 | **40** | **2**：B30 整备上架、B36 生成单据 |
| 契约读接口（R 码） | 14 | **14** | **0** —— 读接口缺口已清零（R02 工作台读已完成） |
| 契约预留动作（reserved） | 2 | 0 | **2**：B39 报损、B40 普通价格调整（需先拍板提升） |
| 需先拍板的语义空白 | — | — | **9 项** |
| 后端已就绪、缺前端入口 | — | — | **4 项**（+3 项导航/路由收敛） |
| 发布前必须核实 | — | — | **5 项** |

**核实方法（可复现）**：契约动作的 `operations[].path`（读接口是 `readActions[].path`），去掉参数段后，在 `backend/src/**/*.ts` 里搜索同一段固定路径序列。

脚本已固化，随时可复跑：

```bash
node docs/plans/2026-09-22-erp-remaining-tasks/audit-action-coverage.mjs
```

> ⚠️ 这个方法**有假阴性**，本轮实测踩了三次，脚本里已逐条消解（改脚本时别退化）：
> 1. **路由可能写成正则常量**：`const ORDER_CANCEL_PATH = /^\/api\/v2\/sales\/orders\/([^/]+)\/cancel$/`。纯字符串匹配搜不到 ⇒ `B09 / B11 / B18 / B43` 起初被误判为「无路由」，实际都已实现。
> 2. **读接口的 path 是多路径用顿号合写**：`"/sales/orders、/sales/orders/:id"` ⇒ 不拆开就会把 `R04 / R05 / R08 / R09` 全判成未实现。
> 3. **参数占位有三种写法**：契约用 `:id`、新 v2 路由用 `([^/]+)`、旧 `/api` 路由用 `(\d+)`。只归一化一种就会漏 ⇒ `R13` 曾因此被误判。
>
> ⇒ 结论：**B16 / B30 / B36 在消解以上三种假阴性后仍找不到任何证据（连动作码引用都没有）**，可信度高；但执行会话开工前仍应自己再核一次。
> ⇒ 另：**R13 不能据旧 `/api` 路径判为已实现**。核实发现客户详情与轻量设备列表仍在兼容接口；没有契约前缀下的 `/devices/:id`，嵌套设备 GET 也返回列表而非单设备，且没有配置历史读模型。详见当前核查记录。

---

## 二、需要你先拍板的（拍完才能排期，别直接开工）

这些不是「写代码」的活，是「定语义」的活。没定之前开工，AI 只能编，编出来的契约会污染后续所有实现。

| 编号 | 要定什么 | 现状与影响 |
|---|---|---|
| P-01 | **取消单退款 / 「调整」实体** | 契约有 `adjustmentRef` 引用，但「调整」实体未实现。取消单只能退款到「门店待退」，无法记「调整冲抵」。E09 明确留白。 |
| P-02 | **采购取消后的付款冲销** | F3 现状：有净付款的采购单**拒绝取消**（409）。要不要支持「先冲销付款再取消」？若要，得定冲销动作语义。 |
| P-03 | **回收单发出报价后能否重新议价** | 契约 RecoveryState 没有 `offered → inspecting` 回头路（G-27）。客户还价现在只能走 B29 归还后重开单。要给契约加转换吗？ |
| P-04 | **B39 报损 / B40 普通价格调整** | 契约里是 `reserved`（不是正式动作）。要启用得按 B38/B37 的先例走「提升为正式动作」流程。报损还牵涉盘差行（与 P-05 的盘点相关）。 |
| P-05 | **剩余状态机缺口契约化** | 7 个对象的状态机转换表缺失：`Reservation` / `ReturnRecord` / `Offset` / `Operation` / `CashEntry` / `Product` / `QuoteVersion`。契约明说不自行编造转换表。 |
| P-06 | **T-12：B03 的 effects 仍列 Reservation** | 但 B03 实际不写任何占用（写入在 B05）。要不要改？属契约语义变更。 |
| P-07 | **D-I：Product.specs 类型矛盾** | 动作数组定义与对象字符串定义冲突。E04b 暂按 `string` 实现，冲突已登记。 |
| P-08 | **G-16 / G-17 期初成本结构与流水方向语义** | E04b 已按现行口径实现并实测，但**契约化本身没做**。不定就不能据此改口径。 |
| P-09 | **经营决策类（4 小项）** | ①Q-03 10km 外配送阶梯金额；②Q-05 定金/退款/保修表述复核；③G-11 供应商页面归属；④G-20 旧商品页 `/inventory/products` 与新页 `/inventory` 的职责边界（哪页是营业入口）。 |

---

## 三、通用开工前言（每次复制都带上）

> 下面的任务卡都假设这句话已经在对话框开头贴过。

```
你是「PC 报价系统」项目（装机店经营工作台 ERP）的执行会话，栋哥是项目负责人。
开工前按顺序读：
1) AGENTS.md —— 工程约定与红线
2) docs/NEXT-SESSION-PROMPT.md 的「开始前」「边界与红线」「收工必跑」三节
3) docs/STATUS.md、docs/OPEN-ITEMS.md 里与本卡相关的条目
4) docs/plans/2026-09-22-erp-remaining-tasks/README.md 中本卡的小节
5) 本卡涉及的源码、迁移与验证记录（只读相关文件，不递归扫 node_modules 和 backups）

硬约束：
- 契约/入口/迁移是「单点区」：contracts/v1、contracts/generated、frontend 与 miniprogram 的端内生成物、
  backend/migrations、以及 backend/src/index.ts 的接线部分。本会话独占，开工前先看这些文件 mtime 确认没人在写。
- 改了 backend/src/index.ts 必须重跑 `node contracts/tools/validate-contracts.mjs`，
  并按新增行数整体平移 contracts/v1/actions.json 里 legacyPermissionMap 的绝对行号证据，改完逐行复验落点。
- 迁移只追加、4 位补零，当前下一个编号是 0024。提交前跑 `npm --prefix backend run check:migrations`。
- 非生成物之外的契约改动，收尾必须按「重新生成 → 同步两端 → 跑门禁」三步走。
- 不自动提交、不自动部署、不应用远端迁移、不外发。
- 金额一律整数分；顾客不能收到成本/供应商/SN/内部备注，必须服务端按角色过滤（响应里根本没有该字段）。
- 收工必须跑完 NEXT-SESSION-PROMPT 的「收工必跑」清单，门禁全绿才算交付。
  lint 基线是 39 项既有失败（35 error + 4 warning），新增任何一项算回归。
- 完成后写 docs/verification/<卡目录>/README.md（含实测命令与结果），并新建/更新
  docs/verification/progress/<编号>.json（字段：id / status / summary / next / updatedAt / evidence）。
  注意：verdict 为 verified 时必须同时有一条源码路径与一条 docs/verification/*.md 证据。

交付时说明：改了什么、依据是什么、怎么验证的、还有什么没验证。
```

---

## 四、后端任务卡（独占通道，一次只跑一张）

⚠️ 这些卡**都会碰 `backend/src/index.ts` 的接线**，而契约校验依赖它的绝对行号 ⇒ **后端卡之间不能并行**。

### 【BK-01】工作台读接口（R02）★建议第一刀

| 项 | 内容 |
|---|---|
| 目标 | 实现 `GET /api/v2/workbench`，返回契约 R02 定义的 `metrics / tasks / filters / generatedAt` |
| 契约依据 | `contracts/v1/actions.json` → `readActions` R02 |
| 现状 | 契约有读模型定义，**后端无任何实现**；前端「今天」页（`WorkbenchTodayPage.tsx`）目前是演示数据 |
| 落点 | 新建 `backend/src/routes/workbench-v2.ts` + 领域读模型；`index.ts` 接线 |
| 碰单点区 | 是（仅 `index.ts` 接线，不动契约、不动迁移） |
| 验收 | 新建 HTTP 测试 + 验收脚本；前端接真实数据后跑浏览器验收 |

```
【BK-01】实现工作台读接口 R02
目标：让「今天」页拿到真实数据，不再是演示数据。
契约依据：contracts/v1/actions.json 的 readActions R02（GET /workbench：
        metrics、tasks、filters、generatedAt）。
落点：新建 backend/src/routes/workbench-v2.ts + 对应领域读模型；backend/src/index.ts 接线。
注意：这是个纯读接口，不改契约、不新建迁移。指标口径必须先对照 docs/plans/2026-09-19-erp-first/00-requirements.md
     确认「工作台要显示什么」，不要自己发明指标；口径写进卡 README。
验收：HTTP 测试 + docs/verification/ 下验收脚本（起 dev-server 走真实 HTTP）。
```

### 【BK-02】B16 盘点录入与差异批准

| 项 | 内容 |
|---|---|
| 目标 | `POST /inventory/counts`（录入，权限 `inventory/count`）+ `POST /inventory/counts/:id/approve`（批准差异，权限 `inventory/count-approve`，老板专属） |
| 契约要点 | 同一编号两个路径且**权限不同**；保存实盘**不直接改库存**；批准后才生成差异调整事件；并发必须以截止序号对齐 |
| 落点 | 迁移 `0024_*.sql`（盘点草稿/行表）+ 领域 + 路由 + 两个新权限码（写 `domains/access.ts`，**不要写进 `index.ts`**） |
| 碰单点区 | 是（契约已有定义，只需登记迁移到 legacy-mapping；迁移新增；index.ts 接线） |
| 依赖 | 与 P-04（B39 报损）强相关 —— 盘差行与报损是同一套语义，建议一起定 |

```
【BK-02】实现 B16 盘点录入与差异批准
目标：POST /inventory/counts（inventory/count）+ POST /inventory/counts/:id/approve（inventory/count-approve，老板专属）。
契约依据：actions.json B16。要点：同一编号两条路径权限不同；保存实盘不直接改库存（02 §5）；
        批准后才生成差异调整事件（effects: InventoryMovement / StockBalance / AuditEvent）；
        并发以截止时点/事件序号对齐（03 §7）；错误含 VERSION_CONFLICT。
落点：新建迁移（下个编号 0024）建盘点草稿与盘点行表 + 领域 + 路由 + 两个新权限码
      （写 backend/src/domains/access.ts，含 LEGACY_EQUIVALENT 旧码等价；不要写进 index.ts）。
      legacy-mapping.json 登记新表。
前置：先确认 P-04 的报损语义（盘差与报损共用一套口径）。
验收：后端测试 + HTTP 验收脚本；恒等式与「保存不改库存、批准才改」必须有断言。
```

### 【BK-03】B30 整备与上架

| 项 | 内容 |
|---|---|
| 目标 | `POST /inventory/items/:id/refurbishments`（记录整备事件）+ `POST /inventory/items/:id/make-available`（上架门槛） |
| 契约要点 | 逐件编号 + 成色 + 检测 + 成本 + 披露 + 标价 + 质保**齐备**方可上架；状态机走 `acquired → refurbishing → ready_for_sale` |
| 现状 | 回收件经 B28 取得所有权后落 `store/quarantine` 待检，B19 可放行到 available —— 但**整备路径完全没有** |
| 落点 | 迁移（`refurbishment_costs`）+ 领域 + 路由 + 权限码 `inventory/refurbish` |
| 碰单点区 | 是（全部） |
| 依赖 | 与 P-05（RecoveryState 状态机缺口）相关 |
| 注意 | 成本示例：收购 800 + 整备 80 = 880，交付只确认 880，**不新增「采购 880」现金** |

```
【BK-03】实现 B30 整备与上架
契约依据：actions.json B30（RefurbishmentCost / StockItem / StockBalance；
        stateMachine: RecoveryState）。两个路径：POST /inventory/items/:id/refurbishments
        与 POST /inventory/items/:id/make-available，权限均为 inventory/refurbish。
要求：上架门槛必须逐件校验「编号、成色、检测、成本、披露、标价、质保」齐备，
     缺项返回 INSPECTION_REQUIRED；状态机 acquired → refurbishing → ready_for_sale。
     成本口径：整备成本计入件成本，交付只确认一次成本快照，不得新增一笔采购现金。
落点：新建迁移建 refurbishment_costs 表 + 领域 + 路由 + 权限码（写 domains/access.ts）。
验收：后端测试（含缺项被拦、成本守恒）+ HTTP 验收脚本。
```

### 【BK-04】B36 生成单据文件

| 项 | 内容 |
|---|---|
| 目标 | `POST /documents`（权限 `document/export`），按 `entityRef` + `snapshotVersion` + `audience` + `format` 生成单据 |
| 契约要点 | `audience=customer` 时**后端白名单 DTO**，不含成本/供应商/原卖方；**不自动发给任何人**；小程序不得用 html2canvas / window.print 导出 |
| 现状 | 报价打印已有脱敏实现（可复用），但没有统一的单据出口 |
| 落点 | 路由 + 白名单 DTO 映射；可能需要在 objects.json 补 CustomerDocument 白名单定义 |
| 碰单点区 | 是（可能动契约 objects.json + index.ts） |

```
【BK-04】实现 B36 生成单据文件
契约依据：actions.json B36（POST /documents，权限 document/export；effects: Operation / Attachment；
        uiRefs: 账本）。inputs：entityRef / snapshotVersion / audience / format。
要求：audience=customer 必须走**服务端白名单 DTO**，响应与文件里根本不含成本、供应商、原卖方、SN、内部备注；
     生成结果不自动外发；同一 entityRef + snapshotVersion 生成的快照要可追溯。
落点：新建路由 + DTO 白名单映射（参考现有报价打印脱敏实现）；若需登记 CustomerDocument 白名单，改 contracts/v1/objects.json。
验收：后端测试断言「客户视角响应里没有成本/供应商字段」+ HTTP 验收脚本。
```

### 【BK-05】附件列表接入详情读模型（F1-READ）

| 项 | 内容 |
|---|---|
| 状态 | 已完成（2026-09-22）；本地 HTTP 用例覆盖接修与回收详情 |
| 目标 | 让接修（R09）/ 回收（R10）详情带出已关联附件列表 |
| 落点 | `backend/src/domains/service.ts` / `recovery.ts` 复用 `listAttachedForOwner`；无独立 `/attachments` 读接口 |
| 契约边界 | R09/R10 的 `readActions.result` 为概述文字，未枚举响应字段；本次按用户明确要求增加详情扩展字段，未修改冻结契约或 generated |
| 证据 | [BE-03/R13 核查记录](../../verification/2026-09-22-BE03-R13/README.md) |

```
BK-05 已完成；沿用 R09/R10 既有详情路径与鉴权，不能增加独立附件读接口。实现与验证见上方证据链接。
```

### 【BK-06】收敛：客户/设备读接口迁 v2 + 旧 /api 逐域拆分

| 项 | 内容 |
|---|---|
| 目标 | 核实 R13 当前兼容读路径是否覆盖契约，避免把旧 `/api` 客户主数据接口误记成完整 R13 |
| 现状 | 旧 `/api/customers/:id` 返回客户联系信息、订单和轻量 `customer_devices`；旧嵌套设备 GET 查询整份设备列表且忽略 `:did`。契约约定前缀 `/api/v2`，读路径为 `/customers/:id`、`/devices/:id` |
| 判定 | 旧路径继续作为兼容接口保留，但**不等价于 R13**：缺少 v2 顶层设备详情和配置历史读取；`customer_devices` 也不是 `CustomerDevice` 保管模型 |
| 下一步 | 先定 R13 设备详情 DTO、配置历史字段及按域权限边界，再单独实现 v2 路由。不能只为覆盖路径审计加别名或改返回结构 |
| 碰单点区 | 如需改 `index.ts` 接线，先查 mtime、保护既有工作，并完整跑契约门禁；可优先另建路由模块后最小接线 |

```
【BK-06】把旧 /api 客户/设备链路逐域拆出 index.ts（T-08）
核查结论：这不是单纯把旧嵌套路径搬进 routes/ 就能完成的等价拆分。旧接口按 legacyPrefix 保留；R13 的 v2 设备详情和配置历史读模型仍待 DTO/权限决策。
不要在本卡中给 `/devices/:id` 发明响应，也不要通过修改审计脚本把缺失路径标为通过。方案明确后再拆路由或新增 v2 读模型，并按单点区规则处理 index.ts。
```

---

## 五、前端任务卡（并行通道，但共享文件要错开）

⚠️ **改 `frontend/src/App.tsx` 或 `frontend/src/app/navigation.ts` 的卡不能互相并行**（共享文件会撞车）。只在各自页面文件里加按钮的卡，彼此独立可并行。

### FE 通用前言（每张 FE 卡都带上）

```
你是「PC 报价系统」项目（内部 ERP，React 19 + Vite + TS）的前端执行会话。
先读：AGENTS.md、docs/NEXT-SESSION-PROMPT.md 的「前端两个坑」与「收工必跑」两节、
docs/STATUS.md 里本功能对应的条目、本卡涉及的页面源码与对应验证卡。

要求：
- 页面放 frontend/src/features/workbench/ 下，沿用现有彩色版样式（wb-* 类），不引入新框架、不改样式体系。
- 两个已知坑：①不要把 .wb-inv-head 用在 <thead> 上（它带 display:grid，会让表头崩列宽），<thead> 不加类名；
  ②effect 里不要同步 setState，用 fetch(...).then(...) 把 setState 放回调里（lint 基线 39 项，新增算回归）。
- 必须提供真实的加载态、失败态、重试与空状态；失败要保留用户输入。
- 服务端 4xx/5xx 如实展示，**不许伪造成功**；动作按钮的可见性按服务端返回的 allowedActions 决定，
  不要在前端自己猜权限。中文 UI。
- ⚠️ 改 frontend/src/App.tsx 或 frontend/src/app/navigation.ts 的卡，不能与别的 FE 卡同时跑（共享文件会撞车）。
验收：npm --prefix frontend test、npm --prefix frontend run build、npm --prefix frontend run lint（新增必须为 0）；
     跑浏览器验收脚本并**实际看截图确认没破版**（只看 json 通过数不算）。
```

### 【FE-01】隔离件判定入口（B19）

后端 F2 已完成并通过 37 项 HTTP 验收，**无前端入口**。

```
【FE-01】给待检件加「判定」入口（B19）
后端接口（已实现）：POST /api/v2/inventory/items/:id/inspection，权限 inventory/inspection。
两条去向：→ available（放行）或 → retired（报废离店）。
放行必须带服务端实测过的有效附件（upload_state='attached'、同店、挂在本件），
所以界面上要能选/挂附件，否则放行会被服务端拒。
要做：在库存页（WorkbenchInventoryPage.tsx）里找到待检件（quarantine）的展示位置加判定入口，能选去向、填检查事实、挂附件；
     **若库存页当前不展示待检件，先把展示补上再加入口**（开工时先核实这一点，别假设它已经展示）。
     服务端 422/409 要如实提示（附件无效、状态不允许），不要在前端预先放行。
参考验证卡：docs/verification/2026-09-22-F2-b19/README.md
```

### 【FE-02】采购取消 + 采购付款入口（B37 / B33）

后端 F3 已完成并通过 42 项 HTTP 验收，**两个入口都没做**。

```
【FE-02】采购单「取消未到数量」+「登记采购付款」两个入口
后端接口（已实现）：
  POST /api/v2/inventory/purchases/:id/cancel     权限 inventory/purchase-cancel（旧码 library/edit 等价）
  POST /api/v2/finance/payments                   权限 finance/payment
   请求体支持 purchase:<采购单号> 或 {kind:'purchase', id}
业务语义（务必如实呈现，不要美化）：
  - 取消**只针对未到数量**，不改写订购量；已到货 / 拒收数量不可再取消（422 PURCHASE_CANCEL_EXCEEDED）。
  - 该采购单**已有净付款时取消会被拒**（409 PURCHASE_PAYMENT_CONFLICT），且**不会自动退已付款**——
    前端必须把这句话提示给操作人，不能显示「已取消并退款」。
  - 付款支持部分付款，超付拒绝（422）；同一 requestId 必须幂等。
要做：①采购页（WorkbenchPurchasePage.tsx）每行加「取消未到数量」，弹窗里必须显示已到/拒收/在途的数量分布，
     默认只允许填未到部分；②采购页或账本页（WorkbenchFinancePage.tsx）加「登记采购付款」，能选采购单、填金额。
参考验证卡：docs/verification/2026-09-22-F3-purchase-cancel-payment/README.md
```

### 【FE-03】抵用额度入口（B31 / B32）

后端 E12 已完成，**前端原计划由栋哥用 ChatGPT 实现**；若交给本机会话，用下面这段。

```
【FE-03】抵用额度：建立置换关联、应用折抵、撤销折抵（B31 / B32）
后端接口（已实现）：
  POST /api/v2/trade-ins                        权限 tradein/create
  POST /api/v2/trade-ins/:id/apply-offset       权限 tradein/offset
  POST /api/v2/trade-ins/:id/reverse-offset     权限 tradein/reverse
  GET  /api/v2/trade-ins/:id                    权限 tradein/view（R11 读）
业务语义：
  - 折抵金额 = min(销售正余额, 回收剩余应付)；可由服务端算，前端不自己算或只做展示。
  - 双方客户主体必须相同，否则 OWNERSHIP_INVALID；部分折抵累计不得超过，否则 OFFSET_EXCEEDED。
  - 撤销折抵**保留原笔 + 新增 reversed 笔**，不搬实物；不要做「原地改金额」。
  - 折抵是非现金事件，不写现金流水。
要说清楚的设计口径：剩余额度默认**保留**在回收单应付里（可拆分、无有效期）；
     客户要求找零时才走 B33 付款（复用付款动作，不新增动作）。
要做：折抵动作挂在回收单 / 销售单详情里（方案 B）；R10 详情有 offsetCents 字段可展示已折抵额。
参考验证卡：docs/verification/E12-current/README.md
```

### 【FE-04】附件上传入口（B35）

后端 F1 已完成三段式，**无前端页面**。上传入口按 F1 设计应挂在接修/回收详情，因此**依赖 BK-05 先给出附件读路径**。

```
【FE-04】接修 / 回收详情加附件上传与列表（B35）
后端接口（已实现，三段式，顺序固定）：
  POST /api/v2/attachments/upload-intents            权限 attachment/upload（签发一次性凭证 + 24h 保留期）
  PUT  /api/v2/attachments/upload-intents/:id/blob   写入字节
  POST /api/v2/attachments/upload-intents/:id/complete 完成关联（归属必须存在且同店）
注意：服务端会**实算** sha256、用魔数嗅探真实 mime、按实际字节数校验，三项与声明不符即拒绝——
     前端不要伪造 mime 或大小，否则必被拒。
前置依赖：附件列表的读路径由 BK-05 提供（接修 R09 / 回收 R10 详情读模型带出）。
     如果 BK-05 还没做，本卡只做「上传 + 完成关联」，列表先不做，并在卡里记明。
要做：在售后（WorkbenchServicePage.tsx）/ 回收（WorkbenchRecoveryPage.tsx）详情里加上传入口与附件列表。
参考验证卡：docs/verification/F1-current/README.md
```

### 【FE-05】客户台账顶栏入口（G-21）

```
【FE-05】给客户台账加顶栏入口（G-21）
现状：/customers 有真实页面（components/CustomersPage.tsx），但顶栏六项（今天/开单/库存/售后/回收置换/账本）
     里没有客户位，只能直接输地址进入。库存页是有入口的（src/app/navigation.ts 约 30 行），客户页没有。
要做：在不增加顶栏项的前提下（这是栋哥此前定的前提），把客户入口挂在头像菜单或搜索旁；
     具体挂哪里**先问栋哥**，不要自己决定。
落点：frontend/src/app/navigation.ts、frontend/src/app/AppShell.tsx（或头像菜单组件）。
注意：本卡会改共享文件，不能与别的 FE 卡同时跑。
```

### 【FE-06】路由与导航收敛（D-D）

```
【FE-06】清理重复路由与占位路径（D-D）
已定位的具体问题：
  - /customers 既有显式 Route，又被 ERP_NAV_ITEMS 的批量映射再生成一条同路径占位路由（实测显式路由胜出、界面正常，
    但两条同路径路由不该长期并存）。
  - /purchases 同样被生成两条，已在 App.tsx 的过滤列表里排除它。
  - 同一处还剩 /suppliers、/assembly、/after-sales、/finance 等占位路径要一起扫。
要做：把「显式路由」与「批量映射」两套机制收敛成一套，去掉重复与死路径；
     收敛后逐个路径实测能打开、能返回、刷新不白屏。不要顺手改页面视觉。
落点：frontend/src/App.tsx、frontend/src/app/navigation.ts、frontend/src/erpNavigation.ts。
注意：本卡改核心共享文件，**必须独占前端通道**，不能与任何 FE 卡并行。
```

---

## 六、核查任务卡（只读为主，可多张同时跑）

| 编号 | 要核什么 | 为什么现在能做 |
|---|---|---|
| CH-01 | **R2 附件桶**：`wrangler.toml` 已声明绑定 `pc-attachments`，但远端桶**未创建**。未建时生产回落到内存实现，进程退出即丢 | 纯配置核实，但要**先拍板是否创建**（会产生资源） |
| CH-02 | **远端迁移应用状态**：0000–0023 本地连续无缺号，但远端应用到哪一号**从未核实** | 只读查询 |
| CH-03 | **生产/测试隔离**：Worker `pc-backend` 生产与测试**共用**（部署即影响线上）。核实真实隔离状态与回退方法 | 只读 |
| CH-04 | **生产 permissions 种子**：新权限码（`inventory/*`、`inventory/count`、`inventory/refurbish`、`document/export` 等）在**生产 permissions 表里没有任何种子迁移**，店员角色要能用需另行授权 | 只读 + 出补种方案 |
| CH-05 | **远端 secret 是否齐全**（`wrangler deploy` 前必须补 3 个；不输出密钥值） | 只读 |
| CH-06 | **lint 39 项既有失败清账**（35 error + 4 warning） | 纯代码质量 |
| CH-07 | **浏览器完整异常态 / 键盘序列 / 缩放对比度**（V-01） | 不依赖其他卡 |
| CH-08 | **跨实例并发压测**（V-02）：数量件占用只测过同进程顺序提交 | 不依赖其他卡 |
| CH-09 | **文档漂移修正**：见下 | 纯文档，改 1–2 个文件 |

### CH-09 具体要修的漂移（我已核实）

| 文件 | 问题 | 怎么修 |
|---|---|---|
| `docs/OPEN-ITEMS.md` | **G-23 已过时**：说「报价行没有商品引用列、该列不存在」，实际 `0015_quote_line_ref_and_quantity_reservation.sql` 已给 `quote_lines` 加 `product_ref`（补洞卡 2026-09-21 完成） | 标为已关闭并注明依据 |
| `docs/OPEN-ITEMS.md` | **G-24 已过时**：说「数量件占用未实现」，实际 0015 之后 `stock_reservations` 已支持数量件（`quantityBucketRef`） | 同上 |
| `docs/STATUS.md` | **同一文件内数字打架**：第 30 行写「契约一致性 C-01 保持关闭：实跑 3239 项通过」，第 61 行写「契约校验 3464 通过」；F3 后基线是 **3464** | 统一为 3464，并注明旧数字作废 |
| `docs/verification/progress/` | **E12 是 `working`**（前端待完成），其余 8 份 verified；且 E06/E08/E10 的证据 mtime 晚于 updatedAt，会被判「待复核」 | **不要代改别人的回执**。只核对并在交接文档说明，等原负责会话自己刷 updatedAt |

---

## 七、并行编排规则（重要，别乱开）

```
                    ┌─────────────────────────────────────────┐
  同一时间最多开 3 个  │ 通道① 后端（独占）  → 一次只跑一张 BK 卡        │
                    │ 通道② 前端（独占）  → 一次只跑一张 FE 卡        │
                    │ 通道③ 核查/文档     → CH 卡可多张同时跑（只读）  │
                    └─────────────────────────────────────────┘
```

红线（违反会让门禁整体失效且**不报错**）：

1. **契约/迁移/入口同一时间只允许一个会话动**。任何两个会话同时改 `contracts/v1`、`backend/migrations` 或 `backend/src/index.ts`，动作证据的绝对行号会整体错位，校验器会静默失效。
2. **开工前先看相关文件的 mtime**，确认没人在写；收工时再看一次。
3. **共享文件之间的冲突**：`backend/src/index.ts`、`frontend/src/App.tsx`、`frontend/src/app/navigation.ts`、`contracts/v1/*` —— 这几类是「一条通道」的天然分界。
4. **同一文件的多个 Edit 不能在同一消息并行调用**（会丢更新，且工具仍报成功）。
5. **跑全量测试套件期间不要编辑源码**（会读到半成品，出现大量假失败）。
6. **不要代其他模块回报进度回执**，收到回执指令 ≠ 开工授权。

---

## 八、收工口径参考（当前基线，改完必须复验）

| 门禁 | F3 收工时的基线 |
|---|---|
| `npm --prefix backend test` | 311 用例 / 0 失败 |
| `npm --prefix frontend test` | 16 文件 / 170 用例 |
| `node contracts/tools/validate-contracts.mjs` | 3464 通过 / 0 失败 |
| 生成物四处一致性 | `generate-dto --check`、`frontend/scripts/sync-contracts.mjs --check`、`miniprogram/scripts/sync-contracts.mjs --check`、`backend/scripts/sync-error-codes.mjs --check` 全过 |
| `check-client-parity.mjs` | 通过 |
| `npm --prefix backend run check:migrations` | 0000–0023 连续（下个 **0024**） |
| `node scripts/check-doc-links.mjs` | 212 链接 / 0 断链 |
| `npm --prefix frontend run lint` | **39 项既有失败，不得说成通过**；新增必须为 0 |

> 完整命令清单与各卡验收脚本见 `docs/NEXT-SESSION-PROMPT.md` 的「收工必跑」一节，此表只是基线数字。
