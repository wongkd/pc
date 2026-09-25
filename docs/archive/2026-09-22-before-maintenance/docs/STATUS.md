# 当前状态

顾客 4Tab 专项（2026-09-22）：用户已确认“清爽版布局与图片 + 字体微调版细字体”。[整体规划与 65 张小任务](../../../plans/2026-09-22-customer-miniprogram-reset/README.md)及离线复制入口已交付；覆盖逐屏还原、顾客业务、配套 ERP、支付和分层验收。MP00–MP64 尚未实施，本轮未改生产代码或原图；独立素材、微信工具/真机与真实支付均未验收。规划检查见[本轮证据](../../../verification/2026-09-22-customer-4tab-plan/README.md)。

本轮专项收敛：[R02 工作台读模型](../../../verification/2026-09-22-R02-workbench/README.md) 已完成（读模型 + 路由 + 入口接线 + 契约行号证据平移 + 测试 + HTTP 验收；**由交接会话完成上一会话中断的收尾**）；同批 [B16 盘点录入与差异批准](../../../verification/2026-09-22-B16-count/README.md) 完成（迁移 0024）。本地后端全套 **351/351** 通过、契约校验 **3476 通过 / 0 失败**、端到端 HTTP **R02 59 项 + B16 37 项 0 失败**。前端（两卡均无页面）、微信真机、生产与远端迁移仍未在本轮验证。

更新：2026-09-22。当前阶段：ERP 优先。E01 核心四屏与 E01b 维修/回收原型已形成；**E02 开发基线、E04 客户主数据、E04b 商品/实物/期初库存、E05 报价闭环（ERP 侧）、E05b「顾客已确认」契约补态（B42）、E03 界面换肤（已实现页面全量覆盖，含订单/商品/SN/设置/占位）、E06 收款与预留（B03 转单 / B05 确认成交与占用 / B08 收款）、E07 采购到货（B14/B15 + B38 退供提升为正式动作）、E06/E07 补洞（报价行商品引用 + 数量件预留 + 订单号派生修复）、E08 装机检测与交付（B04 建单 / B06 备料 / B07 检测 / B10 交付，路由已接线）、E09 取消退货退款与账本（B09 欠款批准 / B11 取消 / B17 退货 / B43 批准贷项 / B18 退款 / B34 反冲 / R12 账本读，后端落地 + 前端最小入口 + 浏览器验收）、E10 售后维修与收款闭环（B20 接修 / B21 诊断方案 / B22 方案确认 / B23 换件扣备件 / B24 外送 / B25 复测归还 / B41 售后收款 / R09 工单读，归还闸门=费用结清，维修待收并入账本）、**E11 回收拆件与抵用收尾（B26 回收登记 / B27 验机估价 / B28 取得所有权 / B29 归还 / B44 拆件 / B33 回收付款 / R10 读；补齐缺失的 0018 迁移把流水来源枚举补到契约 16 值；修 3 个只在带损耗拆件路径爆的 bug；前端 /recovery 换真页面）、**E12 抵用额度（B31 建置换关联/应用折抵 + B32 撤销折抵 + R11 读；0021 建 trade_ins/offsets 两表；B33 付款守卫联动扣有效折抵防双重支付；R10 加 offsetCents；Q-04 找零按「两者都支持、默认保留」落地，复用 B33 不新增动作；后端 + 契约 + 迁移 + 测试 + HTTP 验收完成，前端由栋哥用 ChatGPT 实现）**、**F3 采购取消与采购付款（B37 取消未到数量、不改写订购量 + 0023 建 `purchase_cancellations` + B37 由 reserved 提升为正式动作、`ActionCode` 补 B37 + B33 支持 `purchase:<id>` 采购付款 + R12 流水补 `allocationType`/`allocationId`；两处实现级修复见卡）、**R02 工作台读模型**（无权限门槛读接口；一次快照读齐销售单/工单/回收单，metrics 与 tasks 同口径，不发成本/供应商/SN）、**B16 盘点录入与差异批准**（录入锁存账面不改库存，批准才写 `count_adjustment`；0024 建盘点草稿与盘点行表）**均已落地**；顾客侧分享页与 T03a 一起。

本轮证据：[R02 工作台读模型](../../../verification/2026-09-22-R02-workbench/README.md)、[B16 盘点录入与差异批准](../../../verification/2026-09-22-B16-count/README.md)。上一批：[F3 采购取消与采购付款](../../../verification/2026-09-22-F3-purchase-cancel-payment/README.md)。再上一批：[F1 附件基础](../../../verification/F1-current/README.md)、[F2 隔离件判定](../../../verification/2026-09-22-F2-b19/README.md)。再上一批：[E10 售后维修与收款闭环](../../../verification/E10-current/README.md)。上一批：[E09 取消退货退款与账本](../../../verification/E09-current/README.md)。再上一批：[E08 装机检测与交付（含总集成）](../../../verification/E08-current/README.md)。再上一批：[E06/E07 补洞](../../../verification/2026-09-21-E06E07-gapfix/README.md)（同批：[E06 收款与预留](../../../verification/2026-09-21-E06/README.md)、[E07 采购到货](../../../verification/2026-09-21-E07/README.md)）。再上一轮：[E03 界面换肤收尾](../../../verification/2026-09-21-E03/README.md)。历史证据：[E05b 确认态](../../../verification/2026-09-19-E05b-confirm/README.md)、[E05 报价](../../../verification/2026-09-19-E05-quote/README.md)、[E04b 库存](../../../verification/2026-09-19-E04b-inventory/README.md)、[E04 客户](../../../verification/2026-09-19-E04-customers/README.md)、[E00 规划核对](../../../verification/2026-09-19-E00/README.md)、[E01 原型](../../../verification/2026-09-19-E01/README.md)、[E01b 服务](../../../verification/2026-09-19-E01b-service/README.md)、[E01b 回收](../../../verification/2026-09-19-E01b-recovery/README.md)。历史记录的测试次数不代表本轮重跑。

## 用户最新方向

- 单门店、老板与少量店员；装机销售为主，兼顾零售、维修、回收置换。
- 先做好 ERP，后接顾客下单小程序；完整首版必须包含回收拆件/抵用/维修。
- 用户已否定当前 ERP 美观度。旧配色和历史视觉验收不作为新设计约束。
- **新版视觉已定：以 `design/2026-09-19-erp-core/v2` 的彩色方向为准**（2026-09-21 栋哥明确「彩色的那版才是新版」）。
  更早的 `design/2026-09-17-style-exploration`（apple / OCE / MUJI / v3 奶油白森林绿）是过程探索，不作为当前新版。
- 原始需求以[需求对照](../../../plans/2026-09-19-erp-first/00-requirements.md)所列 MD 的已确认规则为依据。
- E01 规划与[参考图分析](../../../plans/2026-09-19-erp-first/05-reference-analysis.md)仍是提案；视觉方向已定（见上），
  但**原型只覆盖 6 屏**：`v2` 四屏（工作台 / 报价 / 订单 / 库存）+ E01b 两屏（维修 / 回收）；
  **商品管理、SN 台账、系统设置、模块占位四类没有稿**（见 [OPEN-ITEMS](../../../OPEN-ITEMS.md) G-22），
  这几屏的稿由栋哥之后另找人画。**2026-09-21 裁定：先把功能代码写好，不纠结视觉。**

## 本地实现事实

| 能力 | 当前状态与证据 |
|---|---|
| 商品与库存 | **已接真实接口**：`/api/v2/inventory` 的型号汇总、逐件实物与单件明细，商品建档/修订（B12，幂等 + 版本），期初建账（B13，老板专属）。库存页数据全部来自服务端，成本列按权限由服务端决定是否返回。[E04b](../../../verification/2026-09-19-E04b-inventory/README.md) |
| 报价闭环（ERP 侧） | **已接真实接口**：`/api/v2/sales/quotes*` 建草稿（B01）、保存/发出（B02，发出后不可覆盖）、列表与详情（R05）、过期判定与手动续期、**记录顾客确认（B42，E05b：issued → confirmed，来源小程序/微信/线下，确认 ≠ 付款、确认不锁库存，确认后本版本不可改）**；客户外键已补（0011，同店复合外键）；分享凭证随发出签发（只存摘要，校验未实现）；打印脱敏。[E05b](../../../verification/2026-09-19-E05b-confirm/README.md)、[E05](../../../verification/2026-09-19-E05-quote/README.md) |
| 客户台账 | **已接真实接口**：建档/编辑/归档、设备登记与增删改、按手机号归集订单。[E04](../../../verification/2026-09-19-E04-customers/README.md) |
| 隔离开发环境 | **已具备**：`npm --prefix backend run dev:local` 用 miniflare 跑真实 Worker 入口 + 内存 D1 + 演示数据（含商品与期初）；前端 dev 的 `/api` 默认打到它。 |
| 契约一致性 | **C-01 保持关闭**：实跑 **3476 项通过 / 0 项失败**（R02/B16 后基线）。旧记的「3239 项」是 E04b 时代数字，**已作废**（E04b 曾因入口顶部 +2 行把 25 处证据行整体 +2）。**R02 又在入口顶部 +2 行** ⇒ 26 处绝对行号引用整体 +2，已用 `verify-evidence-lines.mjs` 逐条复验落点确实落在权限守卫上；legacy-mapping 登记 0011 的过渡表名 |
| 旧报价工具 | 源码有本地存储、云端读取/自动保存、模板、打印/导出及转订单；本轮只核源码，未登录验证 |
| 旧商品管理页 | `/inventory/products` 仍在，走旧 `/api/products` 与 `library/*` 权限，管理分类品牌下拉与参考价等旧列；**E04b/E05 未改动它**；E03 只统一了视觉，职责边界未动 |
| 新工作台与库存 | E01 v2 原型覆盖工作台/报价/订单/库存；E01b 补维修与回收拆件。**仍是原型与演示数据** |
| **新版视觉（E03）** | **已落地并覆盖全部已实现页面**：`frontend/src/styles/erp-polish.css` 沿用 `erp-core/v2` 的彩色方向，本轮补齐订单 / 商品 / SN 台账 / 系统设置 / 模块占位五类（SN 与占位页此前**没有任何样式**）；旧报价编辑器与顾客打印**刻意保持原样**（Q01 裁定）。E06/E07 新页面直接建在这套彩色口径上。[E03](../../../verification/2026-09-21-E03/README.md) |
| **销售单与收款（E06）** | **已接真实接口**：`/api/v2/sales/orders*` 与 `/sales/quotes/:id/convert`。B03 报价转销售单（冲突预检，不写占用；**成交前每行必须映射到商品**，映射不出整次拒绝，可用 `lineProductMap` 补）、B05 确认成交与补分配（**定金闸：未付款不预留**；逐件占用靠 0007 的部分唯一索引兜底；**数量件按可用量占用**，锁不满的进缺口）、B08 登记销售收款（`BALANCE_EXCEEDED` 防超收）、R04 列表与详情。界面 `/sales/orders`（顶栏「开单」→ 订单处理）。[E06](../../../verification/2026-09-21-E06/README.md)、[补洞](../../../verification/2026-09-21-E06E07-gapfix/README.md) |
| **采购到货（E07）** | **已接真实接口**：`/api/v2/inventory/purchases|receipts|supplier-returns`。B14 缺件采购（快捷供应商不建档）、B15 分批到货（**5 件到 3 件在途剩 2**、拒收不进可用、逐件要编号）、**B38 退供（本轮由 reserved 提升为正式动作，enums 补 ActionCode）**、R08 列表与详情。界面 `/inventory/purchases`（旧深链 `/purchases` 同页）。[E07](../../../verification/2026-09-21-E07/README.md) |
| **装机检测与交付（E08）** | **已接真实接口 + 路由已接线**：B04 创建零售/装机单（建单不写库存）、B06 备料装机（`waiting_stock→preparing→testing`）、B07 检测结论由检查项派生（**失败项逐件隔离进 quarantine**，来源 `inspection_quarantine`）、B10 确认交付（六项闸门 + **交付才扣库一次**，成本快照如实记录）。界面 `/sales/fulfillment`。缺口：B09 欠款交付（**已由 E09 补上**）/ B19 隔离件出 quarantine / CustomerDevice / 检测附件。[E08](../../../verification/E08-current/README.md) |
| **取消退货退款与账本（E09）** | **已接真实接口 + 路由已接线**：B09 欠款批准（owner，快照欠款余额，交付挂凭证 `credit_approved`）、B11 取消（释放占用、余额转门店待退）、B17 登记退货（pending，实物 sold→quarantine）、B43 批准贷项（owner，approved 才计入应退）、B18 现金退款（owner，只对已批准贷项）、B34 反冲（owner，反向分录 + 重算余额）、R12 账本汇总与流水。界面：订单页收尾动作区 + 账本页 `/finance`（原占位页换真页面）。R04 详情补 `returns` 列表与 `returnCreditCents`（读模型扩展）。取消单退款（adjustmentRef）未做——「调整」实体未实现，不伪造入口。[E09](../../../verification/E09-current/README.md) |
| **售后维修与收款闭环（E10）** | **已接真实接口 + 路由已接线**：B20 接修登记（散客/客户，客户财产落保管不计自有库存）、B21 诊断/方案（版本化）、B22 方案确认（接受→产生应收；拒绝→待归还、应收归 0）、B23 换件（**领用自有备件 available→sold**，来源 `service_part_consumption`；现买现入复用 E07 的 B14/B15）、B24 外送/返回（custody store↔external）、B25 复测/归还（**归还闸门：费用结清才放行**）、B41 售后收款（防超收）、R09 列表/详情（allowedActions 服务端派生）。0019 迁移建 4 表（`customer_device_custody` / `service_orders` / `device_configurations` / `device_changes`），收款复用 `cash_entries`。界面 `/after-sales`；账本汇总卡拆「销售待收」+「维修待收」两行。[E10](../../../verification/E10-current/README.md) |
| **回收拆件与抵用收尾（E11）** | **已接真实接口 + 路由已接线**：B26 回收登记（客户暂存物，`ownership=customer`、不进自有库存不计成本）、B27 验机/估价（offerVersion）、B28 取得所有权（**逐件成本之和必须等于最终价**，实物转 `store/quarantine` 待检不自动可卖）、B29 归还、B44 拆件（**守恒：产出成本+损耗=源成本**，损耗单列报废不摊进产出件）、B33 回收付款（`/finance/payments`，超付拒绝；采购付款由 F3 扩展）、R10 列表/详情。**补齐此前缺失的 0018 迁移**（重建 inventory_movements 把流水来源枚举从 14 值补到契约 16 值）。0020 建 3 表（`recovery_orders` / `recovery_items` / `recovery_teardowns`）。界面 `/recovery`（原 T02a 占位换真页面）。[E11](../../../verification/E11-current/README.md) |
| **抵用额度（E12，后端部分）** | **已接真实接口 + 路由已接线**：B31 建立置换关联（`POST /trade-ins`）与应用折抵（`POST /trade-ins/:id/apply-offset`，金额=min(销售正余额, 回收剩余应付)，双方客户主体须相同否则 OWNERSHIP_INVALID，部分折抵累计不超 OFFSET_EXCEEDED）、B32 撤销折抵（`POST /trade-ins/:id/reverse-offset`，原笔保留+新增 reversed 笔，不搬实物）、R11 读（`GET /trade-ins/:id`）。0021 建 `trade_ins`/`offsets` 两表；折抵是非现金事件不写 cash_entries，销售侧落 `sale_orders.offset_net_cents`、回收侧走 offsets 表聚合；B33 付款守卫联动扣有效折抵防双重支付；R10 加 `offsetCents`。Q-04 找零按「两者都支持、默认保留」落地（复用 B33，不新增动作）。**前端由栋哥用 ChatGPT 实现（方案 B），浏览器验收待补**。[E12](../../../verification/E12-current/README.md) |
| **附件基础（F1 / B35）** | **后端已落地并通过 HTTP 验收**：签发上传意图（`POST /attachments/upload-intents` → 一次性凭证 + 24h 保留期）、写入字节（`PUT .../:id/blob`，服务端**实算** sha256 + 魔数嗅探真实 mime + 实际字节数，三项与声明不符即拒绝）、完成关联（`POST .../:id/complete`，归属必须存在且**同店**）。0022 建 `attachments` 表；`domains/storage.ts` 提供 `StorageAdapter`（内存实现＝测试替身／R2＝生产，迁移时加 COS 实现即可）；两段式顺序固定为「先写对象存储、再更新 D1」；幂等 + 重复完成保护两层；孤立上传按 24h 保留期惰性回收。**契约修订四处**（补 `AttachmentUploadState` 转换表、B35 补 `PUT .../blob` 通道与 stateMachine、objects 登记表名、legacy-mapping 登记），原 `stateMachineGaps` 中 Attachment 那条销案。**无前端页面**（读取由接修/回收详情卡接入）。⚠️ R2 远端桶未建、顾客端读图依赖备案域名。[F1](../../../verification/F1-current/README.md) |
| **采购取消与采购付款（F3 / B37 + B33）** | **已接真实接口并通过 HTTP 验收**：B37 `POST /api/v2/inventory/purchases/:id/cancel`（权限 `inventory/purchase-cancel`，旧码 `library/edit` 等价）只取消**未到数量**，`0023` 建 `purchase_cancellations` 逐行记事件、**不改写 `qty_ordered`**，恒等式 `ordered = received + rejected + cancelled + pending` 由到货明细与取消事件共同派生；已到货 / 拒收数量不可再取消（422 `PURCHASE_CANCEL_EXCEEDED`）；取消收缩 B33 应付基数；有净付款时拒绝取消（409 `PURCHASE_PAYMENT_CONFLICT`，不落台账）。B33 `/api/v2/finance/payments` 支持 `purchase:<id>` 与 `{kind:'purchase',id}`，按已知成本算应付 / 已付 / 剩余，部分付款、超付拒绝、幂等齐备；R12 流水读模型补回 `allocationType` / `allocationId`，每笔付款可追溯到具体采购单（此前只有 `saleOrderId`，采购 / 回收 / 维修付款在账本里全部断链）。**契约**：B37 由 `supplementaryActions` 的 reserved 提升为 `frozen` 正式动作、`ActionCode` 补 B37、`legacy-mapping` 登记 0023、新增两个错误码；未提升 `contractVersion`。⚠️ **无前端页面**（取消未到数量、登记采购付款两个入口都未做）。[F3](../../../verification/2026-09-22-F3-purchase-cancel-payment/README.md) |
| 库存与幂等基础 | 领域代码 + HTTP 路由 + 界面已通；**采购/到货/退供已接路由（E07）**；盘点/报损/整备仍无路由。0015 起 `stock_reservations` 同时支持逐件与数量件占用（`quantityBucketRef`）：逐件靠部分唯一索引、数量件靠 `stock_balances` 的 `CHECK (available_qty >= 0)` 兜底。[T04](../../../verification/2026-09-17-T04/README.md)、[T05a](../../../verification/2026-09-18-T05a/README.md) |
| 身份与请求层 | 基础已有，顾客归属和全链路联调未完。[T03a](../../../verification/2026-09-18-T03a/README.md)、[T03b](../../../verification/2026-09-18-T03b/README.md) |
| 新版报价 | 0009 报价头/版本/行/分享表 + 0011 客户外键 + 0012 确认态；**HTTP 路由、ERP 界面与「确认成交（转销售单）」已通**。顾客侧分享校验（Q-09）未实现。[E05](../../../verification/2026-09-19-E05-quote/README.md)、[E06](../../../verification/2026-09-21-E06/README.md) |
| 顾客端 | 四 tab 壳与专属报价网页原型保留；真实登录授权、下单支付和真机闭环未完成。[Q01 原型](../../../design/2026-09-19-customer-quote/v1/README.md) |
| 采购/维修/回收/账本 | 旧模块、局部基础或占位并存，不能按菜单存在判定完成 |

## 工程与验证边界

- 本目录是 Git 仓库，当前有大量用户已有未提交变化，不能混合提交或重置。
- 本轮（F3 采购取消与采购付款，2026-09-22）改动范围：契约 4 处（`enums.json` 补 `ActionCode` B37 并销
  `pending` 项、`actions.json` B37 由 supplementary 提升为正式动作、`errors.json` 补两个错误码、
  `legacy-mapping.json` 登记 `purchase_cancellations` + sources + revisionNote）+ 迁移 1 个
  （`0023_purchase_cancellations.sql`）+ 后端 4 个（`domains/purchase.ts` B37 领域、`routes/purchase-v2.ts`
  取消路由、`domains/access.ts` 权限码与旧码等价、`domains/finance.ts` 采购付款 + 本轮两处修复）
  + 测试 2 个（新增 `f3-purchase-cancel-http.test.mjs` 4 项、修正 `f3-purchase-payment-http.test.mjs` 断言）
  + 验收脚本与 README。**三处生成物全部重新生成**（`contracts/generated`、两端端内副本、
  `backend/src/generated/error-codes.ts`）。
  本轮实跑：后端 **311 用例 / 0 失败**（原 307 + B37 4）、契约校验 **3464 通过 / 0 失败**（原 3450）、
  端到端 HTTP **42 项 / 0 失败**、`check:migrations` 0000–0023 连续。
  **未跑**前端测试与浏览器验收（本卡无前端改动、无新页面），未访问生产，未部署，未应用远端迁移。
  已知未验证：0023 的远端应用状态；前端取消 / 付款入口；取消不退已付款（无付款冲销动作）。
  本轮修掉两个实现级问题：①`guardStatement` 极性写反 —— 采购付款的「成本未知」守卫写成 `NOT EXISTS`，
  把成本齐全的正常单子全拦死（前置检查遮住了它，现象是「成本未知用例通过、正常用例失败」）；
  ②R12 账本流水读模型只返回 `sale_order_id`，丢了契约 `CashEntry.allocation` 的采购 / 回收 / 维修分摊。
- 本轮（F1 附件基础，2026-09-22）改动范围：契约 4 处（`enums.json` 补 `AttachmentUploadState` 状态机、
  `actions.json` B35 补 `PUT /attachments/upload-intents/:id/blob` operation 与 `stateMachine`、`objects.json`
  登记 `attachments` 表、`legacy-mapping.json` 登记表 + sources + 移出 `objectsWithoutLegacyTable`）
  + 迁移 1 个（`0022_attachments.sql`）+ 后端新增 4 个（`domains/storage.ts`、`domains/attachment.ts`、
  `routes/attach-v2.ts`、`tests/f1-attachments.test.mjs`）+ 后端修改 3 个（`domains/access.ts` 权限码与旧码等价、
  `index.ts` 接线、`wrangler.toml` R2 绑定）+ 验收脚本与 README。
  **入口加了 4 行**（import 注释+import、BUCKET 注释+字段），`actions.json` 的 **15 条 evidence 行号与 1 条
  specBasis 行号整体 +4** 并逐条复验落点确实落在权限守卫行上。
  本轮实跑：后端 **287 用例**（原 268 + F1 19）、契约校验 **3450 通过 / 0 失败**（原 3441）、契约六件套全绿、
  HTTP 端到端 **28 项 / 0 失败**、check-doc-links **185 链接 0 断链**。
  **未跑**前端测试与浏览器验收（本卡无前端改动、无新页面），未访问生产，未部署，未应用远端迁移。
  已知未验证：R2 真实读写（远端桶未建）、`listAttachedForOwner` 尚无 HTTP 路径、width/height 未做服务端实算。
- 本轮（E11 回收拆件与抵用收尾，2026-09-22）改动范围：迁移 1 处（**补 0018**）+ 后端 4 个
  （`domains/recovery.ts` 修 3 bug、`routes/finance-v2.ts` 接 B33、`routes/recovery-v2.ts` 付款出口、
  `domains/access.ts` 补 finance/payment）+ 契约 1 处（legacy-mapping 登记中转表）+ 前端 3 个
  （`recovery-api.ts`、`WorkbenchRecoveryPage.tsx`、`App.tsx`）+ 后端测试与两个验收脚本。
  本轮实跑：后端 **257 用例**（原 245 + E11 12）、前端 **170 用例**、build 通过、
  端到端 HTTP **34 项 + 浏览器 28 项 / 0 失败**；契约六件套全绿、check-doc-links 175 链接 0 断链；
  lint 仍 39 项既有失败、本轮新增 0。截图已生成但**本轮会话模型读不了图，未逐张肉眼确认**。
- 本轮（E10 售后维修与收款闭环）改动范围：契约 3 处（B41 主 actions / ConfirmationMethod 枚举 / 四对象建表映射）
  + 后端 5 个（`0019_service_core.sql`、`domains/service.ts`、`routes/service-v2.ts`、`index.ts` 接线、
  `domains/finance.ts` 维修待收并入）+ 前端 8 个（`service-api.ts`、`WorkbenchServicePage.tsx` 新建、
  `finance-api.ts` + `WorkbenchFinancePage.tsx` + 两个测试、`inventory-view.ts` + 测试标签表 16 key、`App.tsx`、`erpNavigation.ts`）
  + 验收脚本两个与 README。
- 本轮实跑：后端 **245 用例**、前端 16 文件 **170 用例**、前端 build 通过、
  端到端 HTTP **28 项 + 浏览器 19 项 / 0 失败**，6 张截图均已实际查看；
  契约门禁**全绿**：契约校验 **3423 通过 / 0 失败**、generate-dto / sync-contracts --check、
  check-client-parity、sync-error-codes、check-doc-links（174 链接 0 断链）均通过
  （收尾时代修收敛了并行回收卡的全部遗留：证据行 +4 平移、specBasis 引文、manifest 重新生成、小程序端标签表补齐）；
  **不跑**微信工具，未访问生产，未部署，未应用远端迁移。
- 前端 lint 仍有 39 项既有失败（35 error + 4 warning），本轮新增 0 项，不得说成通过。
- 远端迁移现状未核实（0004–0020 是否应用未知）；生产/测试是否隔离仍未验证，联调/发布前重新核实。
- 定金、退款、抵用额度与平台资格按原需求记录；本轮未作法律/平台实时核验。

开发辅助工具：[电脑开发进度台](../../../design/2026-09-21-prompt-launcher/README.md)已在本机实现，读取登记的源码线索、历史记录与 AI 进度回执；支持完整蓝图和一键复制下一步。工具验证不代表业务卡新增完成。

当前断点见[交接](../../../NEXT-SESSION-PROMPT.md)，未解决项见[OPEN-ITEMS](../../../OPEN-ITEMS.md)。
