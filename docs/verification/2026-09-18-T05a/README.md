# T05a · 商品、实物与期初库存（后端实现）

日期：2026-09-18。状态：**本地通过**（B12 / B13 / 查询在真实 workerd + 真实 D1 上跑通；HTTP 路由未接，见 §8）。

入口：`backend/src/domains/inventory.ts`、`backend/migrations/0007_inventory_core.sql`。
规格依据：[03-domain-rules.md](../../plans/2026-09-17-web-wechat-plan/03-domain-rules.md) §1 L13、§4 L84 / L86 / L88–L98；[04-data-and-api.md](../../plans/2026-09-17-web-wechat-plan/04-data-and-api.md) §2 L19–L21、§3 L57–L58、§5 L98–L99。
任务卡：[05-implementation-tasks.md](../../plans/2026-09-17-web-wechat-plan/05-implementation-tasks.md) T05a。
一致性前提：[2026-09-17-T04](../2026-09-17-T04/README.md) §3「核心设计决策」。

**本次只做 T05a。** T05b（界面）与 T05c（样本执行）未开始。

---

## 1 · 这张卡要解决什么（一句话）

**让库存第一次有真实的账。** 在 T04 把「一致性」变成可用的基础设施之后，本卡建立四件事并且只做这四件：商品有哪些逐件属性、一件实物怎么被单独描述、数量余额怎么算、以及**期初账从哪里来**。最后一条是关键：期初只能来自**人工确认的实盘**，不许把历史 SN 表的行数刷成库存。

---

## 2 · 实际改动

| 文件 | 状态 | 职责 |
|---|---|---|
| `backend/migrations/0007_inventory_core.sql` | 新增 | 扩展 `hardware`；新建 `stock_items`、`stock_balances`、`inventory_movements`、`stock_reservations`、`inventory_openings`、`inventory_opening_lines` 及全部约束、索引、余额触发器。**只新增，不改 0000–0006 任何表、列、触发器、行** |
| `backend/src/domains/inventory.ts` | 新增 | B12 建档 / 改档、B13 受控期初、GET /inventory、GET /inventory/items/:id、余额与实物的两个对账函数 |
| `backend/tests/lib/inventory.mjs` | 新增 | 库存测试夹具（环境、清库、播种、断言辅助） |
| `backend/tests/t05a-inventory-schema.test.mjs` | 新增 | 8 用例：结构与约束 |
| `backend/tests/t05a-product-write.test.mjs` | 新增 | 9 用例：B12 |
| `backend/tests/t05a-opening.test.mjs` | 新增 | 11 用例：B13 |
| `backend/tests/t05a-inventory-query.test.mjs` | 新增 | 9 用例：查询口径与对账 |
| `contracts/v1/legacy-mapping.json` | 修改 | **+79 / −1**：`tables` 末尾追加 6 条新表登记、`sources` 补入 0007、`revisionNote` 追加一条（同一行内追加，原文保留）。未改任何 action 取值、目标对象名与校验规则 |

**未改**：`backend/src/index.ts`（旧 Worker 一行未动）、`backend/wrangler.toml`、迁移 0000–0006、`contracts/v1` 除 legacy-mapping 外的任何文件、`frontend/`、`miniprogram/`。

### 2.1 ⚠️ 工作区中存在**不属于本卡**的改动

开工时 `git status --short` 为空；施工期间发现工作区出现另一批改动，文件时间戳（00:08–00:13）与本卡工作时间（00:09–00:19）**交错**，可判定为**另一个并行进程所写**，不是本卡产出：

```
README.md
frontend/src/features/workbench/WorkbenchTodayPage.tsx / .test.tsx
frontend/src/features/workbench/StateGraphic.tsx（新）
frontend/src/features/workbench/demoVisuals.ts（新）
frontend/src/styles/workbench.css、motion.css（新）
frontend/public/assets/（新）
docs/design/2026-09-18-assets/（新）
miniprogram/pages/today/*、miniprogram/packages/sales/order-detail/index.ts
miniprogram/assets/（新）、miniprogram/features/demo-visuals.ts（新）
```

本卡**没有触碰**这些文件，也**没有回退**它们。提交时必须按路径限定，不要与本卡改动混在一个提交里。这批改动的前端 / 小程序测试，本卡同样**未运行**。

---

## 3 · 数据变化

| 项 | 结论 |
|---|---|
| 迁移是否只本地执行 | **是**。0007 仅在本机 miniflare 的内存 D1 里按序应用过，**未应用到任何远端** |
| 是否改了远端数据 | **没有**。未连远程、未 deploy、未接触生产 D1 |
| 0007 内的 `UPDATE hardware` 回填 | 两条：`tracking_mode`/`requires_sn` 由 `is_serialized=1` 推导；`entity_id` 回填为 `'legacy-' || id`。**本地测试库在迁移执行时 hardware 是空表**，因此这两条回填在本地没有实际数据可改 —— 它们在真实存量库上的效果**未被验证**（如实登记，见 §8） |
| 是否搬运历史 SN 数据 | **没有**（这是卡面通过标准）。`serial_numbers` / `sn_events` 的行原样保留，代码中不存在从它们计数搬运的路径 |
| 旧写入口 | 未收口。`index.ts` 仍直接读写 `serial_numbers`，与 T04 的同类遗留一致，归 T19 封旁路 |

---

## 4 · 关键设计决策（后续卡必须遵守）

### 4.1 Product 就地扩展 `hardware`，不建第二张主数据表

依据：`objects.json` L36 `Product.tables: ["hardware"]`、`legacy-mapping.json` L45 `action: "extend"`。
好处：旧报价系统立刻看得到新商品，不产生「两份商品主数据」。
代价（必须知道）：`hardware.id` 是 `AUTOINCREMENT`，**batch 内取不到自增 ID**，正好撞上 T04 的硬约束 2。解法是给 `hardware` 加服务端生成的 `entity_id TEXT`，动作结果一律用它；`hardware.id` 留给旧代码。`tracking_mode` 与旧列 `is_serialized` **双写**，防漂移。

### 4.2 StockItem / StockBalance / InventoryMovement **必须新建表**，不能就地改旧表

| 旧表 | 为什么不能就地用 | 证据 |
|---|---|---|
| `serial_numbers` | 只有一个 `status` 轴（7 值），装不下 `ownership × availability × location` 三轴；`purchase_cost_cents` 默认 0 分不清「免费」与「未知」 | `0004_sn.sql` L18–L20、`legacy-mapping` L258 |
| `sn_events` | `sn_id` 为 `NOT NULL`，**数量件（无 SN）的流水无处安放**；缺 `reversalOf` | `0004_sn.sql` L48 |
| `stock_balances` | 契约 `tables: []`，本就无旧表 | `objects.json` L57 |

`legacy-mapping` 自己把 `serial_numbers` 标为 `split`（拆为多个新对象，行级解析映射）——新建表正是 `split` 的形态，行级搬运留 T20。

### 4.3 余额只有一个写入者

`stock_balances` 的三列**只由** `inventory_movements_apply_balance` 触发器改动，应用层不直接写。所以「一条流水必然改变一次余额」是结构保证，余额随时可按流水重算（`reconcileProductBalance`）。

### 4.4 三桶在结构上不可能被混算

`stock_balances` **只有** `available_qty / reserved_qty / quarantine_qty` 三列 —— 在途和客户保管**没有列可以放**。于是 03 §4 L84 的「在途不算在库、客户保管另列」不是靠约定，是靠表结构。

### 4.5 客户财产边界写成两条 CHECK

```sql
CHECK (availability NOT IN ('available','reserved','quarantine','sold') OR ownership = 'store')
CHECK (availability <> 'customer_custody' OR ownership <> 'store')
```
第一条对应 03 §1 L13 / enums `inventoryBucketRules`；第二条让「客户保管 = 他人财产」不可违反。客户件与店有件**可以**同 SN 并存（不同 owner 记录，不自动合并），这正是 03 §4 L86 的要求。

### 4.6 断言全部落在 SQL，不用「条件 UPDATE + 查影响行数」

沿用 T04 §3。本卡新增的守卫形态里有一条**容易踩的**：

> **同一批次内的守卫会看见本批刚写入的行。** B13 一个请求可以有多行，第二行检查「该商品是否已有库存」时，会看到第一行刚建的行，于是自己把自己拦下。

解法：守卫必须**排除本次 `requestId` 写入的行**（流水按 `request_id <> ?` 排除，实物按期初单号 `acquisition_ref <> ?` 排除）。这是本卡实测踩到的坑，已登记为 P-19。

### 4.7 期初与盘点不是同一件事

`inventory_openings` 是 B13 的**审计载体**（记录「谁在何时确认了这份实盘」），不是 B16 的盘点单 —— 盘点单的 `CountState` 枚举仍未定义（`enums.json` L306），归 T06c。两者分开，避免用期初表冒充盘点能力。

---

## 5 · 验证证据

环境：本机 `workerd` via `miniflare` 4.20260625.0 + 真实 D1 binding；Node v22.22.2；隔离内存库，按序应用 **8 个迁移**（0000→0007）。**未连远程、未 deploy、未接触生产 D1。**

| 检查 | 命令 | 时间 | 结果 |
|---|---|---|---|
| 后端集成（真实 workerd + 真实 D1） | `npm --prefix backend test` | 2026-09-18 00:17 | ✅ **58 用例 / 58 通过 / 0 失败**（T04 原有 21 + 本卡 37） |
| 契约自洽 | `node contracts/tools/validate-contracts.mjs` | 2026-09-18 00:19 | ✅ 退出码 0，**通过 3109 项**（T04 时 3047；新增 62 项来自 6 张新表的双向覆盖检查），旧表映射 31 张 / 迁移实际表 31 张 |
| 后端错误码防漂移 | `node backend/scripts/sync-error-codes.mjs --check` | 2026-09-18 00:19 | ✅ 16 个错误码一致 |
| 生产构建可编译 | `npx wrangler deploy --dry-run` | 2026-09-18 00:19 | ✅ 99.52 KiB / gzip 22.68 KiB，**未部署** |
| 网页端生成物防漂移 | `node frontend/scripts/sync-contracts.mjs --check` | 2026-09-18 00:20 | ✅ 6 个文件一致（额外检查，非卡面必跑项） |
| 小程序端生成物防漂移 | `node miniprogram/scripts/sync-contracts.mjs --check` | 2026-09-18 00:20 | ✅ 6 个文件一致（额外检查，非卡面必跑项） |

**未运行**（不得当成通过）：前端单测与构建、小程序单测、lint、微信开发者工具编译、任何浏览器或真机验收。前端 / 小程序本卡未动，且工作区里另有并行改动（§2.1），其验证与本卡无关。

⚠️ `--dry-run` 体积与 T04 完全相同 —— 因为 `inventory.ts` **尚未被 `index.ts` 引用**，不进入生产构建产物。这不是坏事（未接线），但也不能把它读成「新代码已随 Worker 上线」。

日志：`logs/`。

### 5.1 覆盖点

| 组 | 覆盖 |
|---|---|
| 结构与约束 | 0007 的表 / 索引 / 触发器；hardware 新列默认值；客户财产边界 2 条 CHECK；未知成本双向 CHECK；重复 SN（店有拒绝、客户件并存）；三桶非负；桶间转移；在途与客户保管不落地；`qty=0` / `from=to` 拒绝；数量守恒重算一致；同一实物重复 active 占用被部分唯一索引拒绝、释放后可再占 |
| B12 | 建档（幂等记录 + 版本日志 + 双写旧列）；同 ID 同载荷复用；同 ID 改载荷 `IDEMPOTENCY_MISMATCH`；SKU 重复拒绝且无副作用；改档推进版本；**已发生业务后改 trackingMode 被拒且无副作用**；版本冲突；参数非法在拼 SQL 前拦住；改不存在的商品 `ENTITY_NOT_FOUND` |
| B13 | 数量件期初（流水 / 余额 / 成本 / 审计齐备）；逐件期初（每件独立成行、内部编号、SN 规范化）；未知成本为 NULL 且 `cost_known=0`；缺 `approvedCountRef` 拒绝；商品不存在拒绝；逐件行缺编号 / `qty≠1` 拒绝；数量件行带编号拒绝；**已有在库的商品不得再走期初**；成本口径声明与实际矛盾拒绝；同 requestId 复用不重复建账；**旧 SN 表有 4 行而库存仍为 0，实盘确认 2 件后库存才是 2** |
| 查询 | 三桶分别可查且合计自洽；在途 / 客户保管不算在库；同型号不同实物分别定位；客户保管另列；`condition` / `availability` / `q` 筛选；**无权时成本字段根本不出现**（不是置空）；cursor 分页不重不漏；实物详情的来源 / 有效占用 / 流水；查不到时如实返回 null；脱离流水的实物可被对账发现 |

---

## 6 · 机制探测结论（开工前实测，决定了触发器写法）

| 问题 | 结论 |
|---|---|
| `ALTER TABLE ADD COLUMN` 能否带 `CHECK` | **能**（0002 已用过，本卡再验证） |
| UPSERT 的 INSERT 分支与 CHECK 的先后 | ⚠️ **SQLite 先校验要插入那一行的 CHECK，再判定唯一冲突**。把桶间转移的算术写进 UPSERT 的 INSERT 分支时，`available → reserved`（delta 为负）会被 `available_qty >= 0` 拦下，即使结果完全合法 |
| 正确写法 | **先 `INSERT OR IGNORE` 建零行，再 `UPDATE` 累加**。这样「对不存在的余额做扣减」仍然会因 CHECK 失败而整批回滚（正确行为），而合法的桶间转移可以通过 |
| 部分唯一索引带 `<>` 条件 | **可用**（`WHERE sn_normalized IS NOT NULL AND ownership='store' AND availability <> 'retired'`） |
| 同批次内守卫的可见性 | ⚠️ **后面的语句看得见前面语句的效果** —— 多行请求里，「已有库存」类守卫必须排除本次 requestId 的行（见 §4.6） |

### 新增踩坑

| 编号 | 坑 | 表现 |
|---|---|---|
| **P-19** | **同一 D1 批次内，守卫会看见本批刚写入的行** | B13 一个请求带两行时，第二行的「该商品已有库存」守卫命中第一行刚建的数据 → 整批被自己拦下；单行请求却正常，极易误判为「约束写错了」 |
| **P-20** | **UPSERT 的 INSERT 分支先过 CHECK，再判唯一冲突** | 桶间转移因负 delta 被 `>= 0` 拒绝，报错信息指向一个完全合法的余额 |
| **P-21** | `db.prepare(...).bind(...)` **本身不执行** | 夹具里漏了 `.run()`，INSERT 静默不生效；后续断言全部拿到 `null`，症状看起来像「外键坏了」 |

（P-19 与 P-20 已登记进 `docs/OPEN-ITEMS.md` §4；P-21 属测试夹具的笔误，一并记录以免重犯。）

---

## 7 · 口径、留白与冲突登记

本卡在 `contracts/v1` **冻结**的前提下施工，遇到契约没写或写得矛盾的地方，一律**记录**而不是自行扩写契约。

| 编号 | 事项 | 本卡处理 |
|---|---|---|
| **C-1** | `qty`（04 §2 L29「增量，可正可负」）与 `fromBucket` / `toBucket` 的组合语义，契约**未规定** | 由 T05a 定口径并明文记录：**`to_bucket` 桶 `+qty`，`from_bucket` 桶 `-qty`**；两者可同时出现（一笔桶间转移），也可只出现一个（进入或离开门店）。任何桶都可由 `sum(qty where to_bucket=B) - sum(qty where from_bucket=B)` 重算。**这是实现口径，不是契约内容**；若后续要改口径，须先改契约再改代码 |
| **C-2** | `actions.json` L305 声明 B12 输入为 `specs:Spec[]`（数组），而 `objects.json` L43 声明 `Product.specs` 为 `string` | **契约内部不一致，本卡不自行裁决**。实现按对象定义（string）落地，B12 接受 `string \| null`。需负责人裁定后统一（见 OPEN-ITEMS） |
| **C-3** | `OpeningLine` / `CostBasis` 的结构契约只给了类型名 | 本卡实现为最小结构（`productRef`、`qty`、`condition`、`assetCode`、`snRaw`、`unitCostCents`；`costBasis.kind ∈ known \| unknown`）并记录在 §4.7 与本节。**不是契约定义** |
| **C-4** | B12 输入未列 `category`，但 `Product.category` 非空 | 本卡取可选、缺省 `'未分类'`；未给契约外必填项 |
| **C-5** | **数量守恒无法用声明式约束表达** | 「余额 = 流水净和」跨表跨行聚合，SQL 的 `CHECK` 做不到。本卡改为三件事共同保证：①唯一的余额写入者（触发器）；②`reconcileProductBalance` 随时可重算对账；③测试断言两者一致。**影响**：它是一致性纪律，不是数据库强制 —— 若有人绕过转换器直写余额列，数据库不会自动拦住 |
| **C-6** | **「改实物状态必须写流水」同样是纪律而非约束** | 触发器无法检查同一批次里是否还有一条对应流水。补救：`findStockItemsWithoutMovements` 提供「有实无账」对账，测试已验证它能发现偏离。**后续卡（T06 采购、T08 预留、T10 交付）写库时必须成对出现** |
| **G-07** | `stateMachineGaps` 中 `Product` 的缺口，`owner: T05a`（「status 取值与停用语义未定义」） | 取值沿用 `enums.json` 的 `ActiveStatus`（`active` / `disabled`），不新增枚举。**停用语义本卡裁定为**：停用商品不得再产生新的库存与占用（B13 已实现「非 active 商品不得建期初」）；已有单据与既存库存不受影响，不自动清理、不自动取消。**这是本卡裁定，非规格原文**，若与负责人预期不符可改 |
| **G-12** | SN 台账是否单列导航 | **界面问题，本卡不决定**，留 T05b |

---

## 8 · 未完成 / 阻断

| 项 | 说明 |
|---|---|
| **B12 / B13 的 HTTP 路由未接** | 领域层已可用，但**没有**暴露成 `/api/v2/inventory/*`。原因：T03（身份与请求层）未做，动作入口没有鉴权 —— `storeId` / `actorUserId` 由调用方传入，若此刻开放路由，任何人都能直连。这与 T04 的处理一致（`runIdempotent` 同样未接路由）。**权限码已就位**：B12 → `inventory/product-edit`，B13 → `inventory/opening`（老板专属，`library/edit` 的 `doesNotGrant` 已明确不含它） |
| **`inventory.ts` 未与 `index.ts` 接线** | 证据：`wrangler deploy --dry-run` 体积与 T04 完全相同（99.52 KiB）。新代码不进入生产构建产物 |
| **0007 未应用到任何远端** | 生产 D1 的 `0004` / `0005` 是否已应用本身就未核实（OPEN-ITEMS T-06），**0007 更未应用**。在 T20 迁移演练与明确授权前不得 apply |
| **0007 的存量回填未在真实数据上验证** | 本地测试库在迁移执行时 `hardware` 为空，因此「`is_serialized=1` → `tracking_mode='item'`」与 `entity_id` 回填**没有可回填的行**。这条路径只在真实存量库上才会真正生效，**未被测试覆盖** |
| **预留只建了形状** | `stock_reservations` 表与「同一实物最多一条 active」的部分唯一索引已就位并验证，但**写占用的动作（B05）属 T08**。StockItem 的 `reserved` 状态目前只能由后续卡产生 |
| **采购 / 回收 / 退货三条入库路径未做** | 本卡的入库只有 `opening_balance` 一种来源。`purchase_receipt` / `quick_purchase`（T06）、`return_receipt`（T11）、回收取得（T14）都还需要各自的动作 |
| **数量件成本分摊未做** | `total_cost_cents` 在期初按「全行已知则求和、任一未知则 NULL」写入；**出库平均成本、最后一件带走剩余成本**（03 §7 L181）属 T06 |
| **T05b / T05c 未开始** | 界面与样本执行都留给后续子卡 |
| **旧写入口未收口** | `index.ts` 仍直接读写 `hardware` / `serial_numbers`，不经过 `runIdempotent`。与 T04 的同类遗留合并，归 T19 |
| **本地并发 ≠ 跨实例压测** | 沿用 T04 的结论：workerd 单线程调度，本卡的「并发」仍是同实例内请求同时在途 |

---

## 9 · 下一步

1. **T03**（身份、微信绑定与请求层）—— 仍是 T05b 之前最紧的前置：没有它，B12 / B13 无法安全地暴露成 HTTP 接口，界面也无从调用。
2. **T05b**（网页库存表格 / 逐件视图，小程序搜索 / 实物页）—— 依赖 T03 的接口装配。
3. **T05c**（执行「同型号不同实物、无 SN 二手、客户寄存、未知成本、重复 SN、数量守恒」样本）—— 本卡已把这些**约束**测通，但**样本数据**尚未落成契约 fixtures。
4. 待负责人裁定：**C-2**（`specs` 的数组 / 字符串冲突）、**G-07** 的停用语义口径、**C-1 / C-3** 是否需要升入契约。
