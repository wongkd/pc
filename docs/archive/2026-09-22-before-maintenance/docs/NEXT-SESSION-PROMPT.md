# 下一次从这里继续

顾客 4Tab 专项断点（2026-09-22）：整体规划完成，用户确认清爽版布局/图片配合微调版细字体；[任务选择器](../../../plans/2026-09-22-customer-miniprogram-reset/index.html)含 MP00–MP64 完整提示词。下一动作是执行 [MP00 测量与源码基线](../../../plans/2026-09-22-customer-miniprogram-reset/tasks/MP00.md)，不是直接改四屏。默认一会话一卡，按依赖、文件范围与截图门槛实施；旧 M00–M11 停止作为执行卡。尚缺独立素材，业务代码、微信工具/真机与支付未做。ERP 业务断点仍见下文，顾客卡不得覆盖。

开发辅助入口：桌面「PC Quote 开发进度台」已可用，详见[使用与回执协议](../../../design/2026-09-21-prompt-launcher/README.md)。本轮只交付工具；业务断点仍如下。接续业务的对话按实际 E 编号更新 progress 回执，网页自动读取；用户不需手动勾选。**回执已建立**：`docs/verification/progress/E06.json`、`E07.json` 均为 `verified`（建立与复核见[本轮复核记录](../../../verification/2026-09-21-receipts/README.md)）；E03–E05 仍由各自负责的对话回报。E08 的依赖（E06/E07）已核实满足，但**未开工**——网页会推荐 E08，推荐编号不代表已启动业务卡。

> **2026-09-22 凌晨 · 回执目录健康校验（只读，未开业务卡）**：在册回执已增至 **4 份**
> `E06 / E07 / E08 / E10`，全部 `verified`。已做结构体检，**六字段齐全、无非法 status、evidence 全部真实存在且不越界**；
> 但 **E06(4 项) / E08(7 项) / E10(1 项)** 的证据 mtime 晚于 updatedAt，触发「待复核」——
> 判为后续业务卡与并行会话的正常连带（如 E08 的 `contracts/v1/enums.json`、`App.tsx` 是被 E10 改的），**不是回退**。
> 消解方式是**由原负责会话重跑门禁后刷新 updatedAt**，本会话未代跑、未改任何状态。
> ⚠️ 本会话**没有**实际负责的 E 编号，故**未新建任何回执**；收到回执指令不构成开工依据。
> 脚本已固化：`node docs/verification/2026-09-22-receipts/check-receipts.mjs docs/verification/progress`。
> 全量见 [2026-09-22 回执校验记录](../../../verification/2026-09-22-receipts/README.md)。

更新：2026-09-22（R02 工作台读 + B16 盘点收工）。当前断点：E02 基线、E04 客户主数据、E04b 库存、E05 报价闭环（ERP 侧）、
E05b「顾客已确认」契约补态（B42）、E03 界面换肤、E06 收款与预留、E07 采购到货、
E06/E07 补洞（报价行商品引用 + 数量件预留 + 订单号派生修复）、E08 装机检测与交付、
E09 取消退货退款与账本、E10 售后维修与收款闭环、E11 回收拆件与抵用收尾、
E12 抵用额度（前端由栋哥用 ChatGPT 实现，浏览器验收待补）、
**F1 附件基础（B35：上传意图签发 + 字节写入与服务端实算校验 + 完成关联 + 孤立回收；0022 建 `attachments` 表；
`StorageAdapter` 抽象（内存＝测试替身／R2＝生产）；契约修订四处并销案 Attachment 状态机缺口）**、
**F2 隔离件判定（B19：`quarantine→available/retired` 两条去向 + 余额守恒 + 检查事实写 `audit_logs` +
放行必须有服务端实测的有效附件；未改契约、未新建迁移，复用 0018 的 `inspection_release`）**、
**F3 采购取消 + 采购付款（B37 取消未到数量、不改写订购量，0023 建 `purchase_cancellations`；
B33 支持 `purchase:<id>` 采购付款，账本应付扣除采购付款净额；B37 由 reserved 提升为正式动作、
`ActionCode` 补 B37；R12 流水补 `allocationType`/`allocationId`）**
均已完成并通过验收。
本轮实跑基线：后端 **351 用例 / 351 通过 / 0 失败**、端到端 **R02 59 项 + B16 37 项 HTTP，0 失败**；
契约校验 **3476 通过 / 0 失败**，四处生成物一致（`generate-dto --check`、`frontend/scripts/sync-contracts.mjs --check`、
`miniprogram/scripts/sync-contracts.mjs --check` 均过）。（上一版 307/3450 数字作废。）
✅ 上一轮记录的「`validate-contracts` 失败 1 项 + 全量套件 2 项失败」已由 F3 收尾销案：0023 已登记
`legacy-mapping.json`、生成物已重新生成、`f3-purchase-payment-http.test.mjs` 的断言已修正
（其中一处是**实现级 bug**：采购付款的「成本未知」守卫 `guardStatement` 极性写反，把正常单子全拦死；详见 F3 卡）。
⚠️ F1 / F2 / F3 都**无前端页面**；前端测试与浏览器验收未跑。

> ⚠️ **并行会话冲突已收敛（2026-09-21 深夜，E10 收尾时代修）**：
> 回收拆件会话因撞车主动停手（见其项目日志），E10 收尾核实无人在写后，代修了它的全部遗留——
> legacyPermissionMap 证据行整体 +4 平移、Product specBasis 引文 718→722、manifest 重新生成、
> 小程序端 `MOVEMENT_SOURCE_LABELS` 补 `recovery_acquisition`/`inspection_release` 至 16 key。
> **回收卡的后端/契约内容未动**（recovery.ts、recovery-v2.ts、0020_recovery.sql、B44 等都是它的成果，等栋哥点刀后继续）。
> 迁移目录注意：0018（B19）文件缺失但被 0019/0020 头注释引用；当前链（0000–0017 + 0019 + 0020）本地实测自洽。
> 教训：**同一文件的多个 Edit 不能并行调用**（丢失更新），必须串行。

> ✅ **E06/E07 及其补洞均已收工**，契约与生成物**一致且干净**
> （`validate-contracts.mjs` 3309 通过 / 0 失败，`generate-dto --check` 与 `sync-contracts --check` 都通过）。
> 证据：[补洞卡](../../../verification/2026-09-21-E06E07-gapfix/README.md)、
> [E06](../../../verification/2026-09-21-E06/README.md)、[E07](../../../verification/2026-09-21-E07/README.md)。
> 三条已落地的结论，别再当未决项：
> ① B03（报价转销售单）已实现，且**成交前必须映射到商品**（映射不出整次拒绝，可用 `lineProductMap` 补）；
> ② 数量件（`tracking_mode='quantity'`）**付定金即锁库存**已生效，锁不满的差额才进缺口；
> ③ 订单号由 requestId **全串哈希**派生（旧实现只取前 8 位字符，公共前缀的 requestId 必然撞号，
> 且撞号会被 `guidanceFor` 报成「报价没有通过转单校验」，方向全错）。
>
> ✅ **E08（装机检测与交付）也已收工**（2026-09-21）：B04/B06/B07/B10 + 0016 迁移 + 前端 `/sales/fulfillment`
> 路由接线 + 浏览器验收 15 项。证据：[E08 卡](../../../verification/E08-current/README.md)。
> B07 检测失败已实现**逐件坏件隔离**（reserved → quarantine，来源 `inspection_quarantine`）；
> 但隔离件「出不了 quarantine」——B19 待检件判定仍缺，属库存域。
> 交付里 B09 欠款交付、CustomerDevice（E10）、检测附件（B35）三项缺口未实现，各自独立成卡。

## 开始前

1. 读 README、AGENTS、[STATUS](../../../STATUS.md)。
2. 读[规划总览](../../../plans/2026-09-19-erp-first/README.md)，先核对 [00 原始需求](../../../plans/2026-09-19-erp-first/00-requirements.md)。
3. 读上一卡[验证记录](../../../verification/2026-09-21-E07/README.md)（含实测缺陷与未验证清单）。
4. 执行 `git rev-parse`、`status`、`log`，保护已有未提交修改。只读相关源码，不递归扫描依赖和备份。
5. 起本地环境：`npm --prefix backend run dev:local` + `npm --prefix frontend run dev`。**不要在 dev 里连生产**。
   页面入口：报价 `/sales/quotes`、订单处理 `/sales/orders`、缺件采购 `/inventory/purchases`（旧深链 `/purchases`）。

## 用户已确认，不再反复问

- 单门店，老板与少量店员；装机销售、配件零售、维修、回收置换。
- 当前先做好 ERP，小程序是顾客下单端。
- 必须按用户整理的需求 MD 规划；不能拿通用 ERP 功能表替代。
- 现有 ERP 很丑、用户不满意。旧奶油白/深绿和衬线标题不再是必须继承的视觉。
- 回收旧机拆件入库，不整机转卖；抵用可拆分/找零/无有效期；质保按来源；配送按驾车距离。
- 旧报价打印入口保留；可用代码复用。
- **E05 四项裁定（2026-09-19）**：①契约无「顾客已确认」态，本轮不做确认动作；②只做 ERP 侧，顾客侧与 T03a 一起；
  ③到期提醒站内真实可用 + 规则参数化（微信订阅消息现在推不出去）；④客户接口用契约正牌码 `sales/order-*`，旧码保留兼容。
  ——其中①已由 **E05b（同日）契约修订补上**：QuoteStatus 新增 `confirmed`，动作 B42「记录顾客确认」
  （POST `/sales/quotes/:id/confirm`，迁移 0012），ERP 端入口与口径见
  [E05b 验证记录](../../../verification/2026-09-19-E05b-confirm/README.md)。顾客侧调用 B42（来源 miniprogram）仍留给 T03a 之后。

## 下一动作（先拍板再动）

**栋哥 2026-09-21 的裁定**：「我到时候再用其他AI来画（那几屏的稿），**先把功能代码写好**」
—— 即**先做功能、不纠结视觉**；没有原型稿的页面，视觉稿他之后另找人画。

功能现状（后端域）：**已有** 身份/会话/权限、库存、报价、客户、**销售单与收款（E06）**、**采购到货（E07）**、
**装机交付（E08）**、**取消退款与账本（E09）**、**售后维修（E10）**、**回收拆件（E11，含 B33 回收付款）**、
**抵用额度（E12，后端）**、**附件基础（F1 / B35）**；
**仅剩空白** 顾客侧分享校验（Q-09）。
✅ **隔离件出 quarantine（B19）已于 2026-09-22 完成（F2 卡）**：待检件可判定放行（`→available`）
或报废离店（`→retired`）；检查事实写 `audit_logs`、`stock_items.inspection_ref` 回填；
放行必须带服务端实测过的有效附件。见 [F2 卡](../../../verification/2026-09-22-F2-b19/README.md)。
✅ **采购取消与采购付款（B37 / B33）已于 2026-09-22 完成（F3 卡）**：`POST /inventory/purchases/:id/cancel`
只取消**未到数量**、**不改写订购量**（恒等式 `ordered = received + rejected + cancelled + pending` 派生），
已到货 / 拒收数量不可再取消（422）；`/finance/payments` 支持 `purchase:<id>`，部分付款 / 超付拒绝 / 幂等 /
老板权限齐备，R12 流水补回 `allocationType`/`allocationId`，每笔采购付款都能追溯到具体采购单。
见 [F3 卡](../../../verification/2026-09-22-F3-purchase-cancel-payment/README.md)。

候选下一刀（**等栋哥点，别自己开工**）：

> **2026-09-22 16:20 更新（本条最新）**：**R02 工作台读模型已收尾完成** —— 上一会话建好代码与验收后中断，
> 交接会话补完「行号证据逐条复核 → 重跑全部门禁 → 验证卡 + 回执」，见 [R02 卡](../../../verification/2026-09-22-R02-workbench/README.md)；
> **B16 盘点录入与差异批准同日完成**，见 [B16 卡](../../../verification/2026-09-22-B16-count/README.md)。两卡都**无前端页面**。
> **B30 整备与上架已开工**：栋哥已拍板四项语义（成色五档 / 披露 = 自由文本 + 数据处置勾选 / 质保月数 / 逐件标价落库），
> **契约与迁移已完成且门禁全绿**（契约校验 3506、迁移 0025、旧表映射 71/71、迁移 SQL 实跑可应用）；
> **领域 / 路由 / 测试 / 验收未做** —— 接续清单见 [B30 实施记录](../../../plans/2026-09-22-B30-refurbishment/README.md) 第四节。
> ⚠️ 这张卡此前迟迟没落地，是因为 B30 **引用了三个从未被定义的契约元素**（`ConditionGrade` / `Disclosure` / `WarrantyTerm`），
> 且标价字段在 `StockItem` 里根本不存在 —— 已补齐并留修订痕迹。
> ⇒ **剩余主动作只剩 B36 生成单据**；**读接口缺口已清零**（R02 是最后一条）。

| 候选 | 内容 | 前置与依赖 |
|---|---|---|
| ~~**装机与交付 / 零售（E08）**~~ | ✅ **已完成（2026-09-21）**：B04/B06/B07/B10 + 0016 + `/sales/fulfillment`。见 [E08 卡](../../../verification/E08-current/README.md) | — |
| ~~**取消退款与销售账本（E09）**~~ | ✅ **已完成（2026-09-21 晚）**：B09/B11/B17/B43/B18/B34/R12 后端 + 订单页收尾动作区 + 账本页 `/finance` + 浏览器验收 22+13 项。见 [E09 卡](../../../verification/E09-current/README.md)。**注意**：取消单退款（adjustmentRef）未做，「调整」实体未实现，要补先定契约语义 | — |
| ~~**售后维修（E10）**~~ | ✅ **已完成（2026-09-21 深夜）**：B20 接修 / B21 诊断方案 / B22 方案确认 / B23 换件扣备件 / B24 外送 / B25 复测归还（**归还闸门=费用结清**）/ B41 售后收款 / R09 + 0019 迁移 4 表 + `/after-sales` 前端 + 维修待收并入账本。端到端 28+19 项 0 失败。见 [E10 卡](../../../verification/E10-current/README.md)。**注意**：结清后「登记收款」按钮仍显示（服务端 422 兜底）；现买现入复用 E07 的 B14/B15，未单独串演 | — |
| ~~**回收拆件 + 抵用额度（E11）**~~ | ✅ **已完成（2026-09-22）**：B26 登记 / B27 验机估价 / B28 取得所有权 / B29 归还 / B44 拆件 / B33 回收付款 / R10 读；补齐 0018 迁移（流水来源枚举到契约 16 值）；修 3 个拆件 bug；`/recovery` 真页面。端到端 34+28 项 0 失败。见 [E11 卡](../../../verification/E11-current/README.md)。**注意**：抵用额度（B31/B32）未做，报价不能改价（G-27），B33 只接回收单 | — |
| **F1 附件基础（B35）** | ✅ **后端已完成（2026-09-22）**：上传意图签发 + 字节写入与服务端实算校验（sha256 / 魔数真实 mime / 实际大小）+ 完成关联 + 孤立回收；0022 建 `attachments` 表；`StorageAdapter` 抽象（内存＝测试替身／R2＝生产）；契约修订四处。端到端 **28 项 0 失败**。见 [F1 卡](../../../verification/F1-current/README.md)。⚠️ **无前端页面**（读取归接修 / 回收详情卡）；R2 远端桶未建、顾客端读图依赖备案域名 | — |
| ~~**隔离件出 quarantine（B19 库存域）**~~ | ✅ **已完成（2026-09-22，F2）**：`POST /api/v2/inventory/items/:id/inspection` + 领域逻辑 + 后端测试 18 项 + 端到端验收 37 项，均 0 失败。`quarantine→available / →retired` 两条去向、余额守恒由流水触发器保证、重复判定与假证据都拦得住；检查事实写 `audit_logs`、`inspection_ref` 回填；放行必须有服务端实测（`upload_state='attached'`、同店、挂在本件）的有效附件。**未改契约、未新建迁移**（复用 0018 的 `inspection_release`）。见 [F2 卡](../../../verification/2026-09-22-F2-b19/README.md)。**未做**：前端入口（留 ChatGPT）、报损单独立实体 | — |
| **F3 采购取消 + 采购付款（B37 / B33）** | ✅ **已完成（2026-09-22）**：B37 `POST /inventory/purchases/:id/cancel`（只取消未到数量、不改写订购量、已到货 / 拒收不可再取消、有净付款则 409 拒绝）+ 0023 建 `purchase_cancellations` + 契约把 B37 由 reserved 提升为正式动作（`ActionCode` 补 B37、两个新错误码）+ B33 采购付款（`purchase:<id>` 或 `{kind,id}`）+ R12 流水补 `allocationType` / `allocationId`。后端测试 4 项、端到端 **42 项 0 失败**。见 [F3 卡](../../../verification/2026-09-22-F3-purchase-cancel-payment/README.md)。⚠️ **无前端页面**（取消未到数量入口、登记采购付款入口都未做，留 ChatGPT）；取消**不退已付款**（无付款冲销动作） | — |
| ~~**抵用额度（B31/B32 折抵）**~~ | ✅ **后端已完成（2026-09-22，E12）**：B31 建关联/折抵（min(销售正余额, 回收剩余应付)、双方主体相同、部分折抵累计不超）+ B32 撤销 + R11 读 + 0021 建 trade_ins/offsets + B33 付款守卫扣有效折抵 + R10 加 offsetCents；Q-04 找零「两者都支持默认保留」。**前端由栋哥用 ChatGPT 实现（方案 B）**，完成后补浏览器验收再标 verified | 后端见 [E12 卡](../../../verification/E12-current/README.md)；前端待 ChatGPT |
| **顾客侧分享页 Q-09** | 报价闭环最后一段；顾客确认直接调 B42（来源 miniprogram） | 依赖 T03a 顾客身份；会动契约与小程序 |
| **不撞契约的收敛** | 客户台账顶栏入口（G-21）、旧商品页与新库存页边界（G-20）、演示样本不进构建产物（D-E）；~~错误提示吞掉真因~~ **T-11 已于 2026-09-22 收敛**（新版 v2 写响应附上可读数据库诊断，见 [T-11 证据](../../../verification/2026-09-22-T11/README.md)） | 只处理 G-20/G-21/D-E；T-11 不再是未决项 |
| ~~**工作台读接口（R02）**~~ | ✅ **已完成（2026-09-22）**：读模型 + 路由 + 入口接线（顶部 +2 行）+ 契约行号证据整体 +2（已用 `verify-evidence-lines.mjs` 逐条复验落点）；一次快照读齐销售单/工单/回收单，`metrics` 与 `tasks` 同口径，响应里没有成本/供应商/SN。后端 351/351、端到端 **59 项 0 失败**。见 [R02 卡](../../../verification/2026-09-22-R02-workbench/README.md)。**未做**：前端「今天」页仍用演示数据（属 D-E） | — |
| ~~**B16 盘点录入与差异批准**~~ | ✅ **已完成（2026-09-22）**：录入锁存账面但**不改库存**、批准才写 `count_adjustment` 差异流水；0024 建 `inventory_counts` / `inventory_count_lines`。端到端 **37 项 0 失败**。见 [B16 卡](../../../verification/2026-09-22-B16-count/README.md)。**未做**：盘点入口前端；逐件实物盘点（本卡只做数量口径） | — |
| **B30 整备与上架（下一刀候选）** | `POST /inventory/items/:id/refurbishments`（记整备事件）+ `POST /inventory/items/:id/make-available`（上架门槛），权限 `inventory/refurbish`（**已存在**，`library/edit` 等价）。门槛：逐件编号 / 成色 / 检测 / 成本 / 披露 / 标价 / 质保**齐备**，缺项 `INSPECTION_REQUIRED`；状态机 `acquired → refurbishing → ready_for_sale`（enums 已有三条转换）。需新建 `refurbishment_costs` **明细表**（`stock_items.refurbishment_cost_cents` 汇总列 0007 已有，契约 `RefurbishmentCost.tables` 为空）。⚠️ **开工前必须核实**：契约 guard 把 `acquired→refurbishing` 写作「仅对**拆出的单件**」，而栋哥拍板口径是「只对**未拆件**的实物生效」—— 措辞冲突，须先判定以哪个为准 | 栋哥已拍板口径；动契约（登记表名）+ 迁移 **0025**；照 F2 / B16 的做法**大概率不用改 `index.ts`**（两条路径在 `/api/v2/inventory` 前缀下，由 `inventory-v2.ts` 认领） |

**注意**：B03（报价转销售单）**已由 E06 完成**；报价行商品引用与数量件预留**已由补洞卡完成**
（见[补洞卡](../../../verification/2026-09-21-E06E07-gapfix/README.md)），都不是未决项了。

## 视觉现状（2026-09-21 已定，别再当成未决）

- **新版视觉 = `docs/design/2026-09-19-erp-core/v2` 的彩色方向**（栋哥 2026-09-21 明确「彩色的那版才是新版」）。
  更早的 `design/2026-09-17-style-exploration`（apple / OCE / MUJI / v3 奶油绿）是过程探索，**不是**当前新版。
- ⚠️ **但 v2 原型只画了 4 屏**：`v2/app.js` 第 8 行的
  `titles = { workbench:'工作台', quote:'报价编辑', order:'订单详情', inventory:'库存' }`；
  加上 E01b 的 `售后维修` / `回收拆件` 两个独立原型，**整个原型体系一共 6 屏**。
  ⇒ **商品管理、SN 台账、系统设置、模块占位这四类页面在生产里存在，但原型里没有稿。**
- E03 落地在 `frontend/src/styles/erp-polish.css`：其中**订单页有 v2 稿可对**；
  上面那四类是**按 v2 的色板与面板尺度推导的**（`#d4e9df` / `#dce6f4` / `#f4dfc4` / `#e0d9f2`、20px 圆角、28px 标题、`#f9fafc` 表头），
  **不是照稿搬**。见 [E03 验证记录](../../../verification/2026-09-21-E03/README.md)。
- 生产前端从来不是 v2 的像素级复刻：v2 是静态原型（CSP `connect-src 'none'`），
  E03 的定位是「把 v2 的**视觉语言**变成 React 公共组件」，布局按业务需要走。
- **旧报价编辑器与顾客打印刻意保持原样**（Q01 裁定）——看到蓝绿渐变按钮和胶囊圆角不是漏改，别去「修」。
- 无稿四屏的视觉稿由栋哥之后另找人画；**在那之前不要为了「更贴近 v2」去大改这四屏的样式**。
- 客户台账暂无顶栏入口（G-21）；`/inventory/products` 与 `/inventory` 的职责边界未裁定（G-20）。

## 边界与红线

- 未付款不预留不采购；已收款库存冲突不能删除收款；交付才正常销售扣库。**E05 全程未写库存，后续卡也不得破坏。**
- 顾客不能拿到成本、供应商、SN、内部备注及他人资料，且必须在服务端按角色过滤，不能只靠前端隐藏。
  E05 的做法是**响应里根本没有这些字段**（不是查出来再删）。
- 金额用整数分；库存与资金动作要幂等、可追溯，写动作遵循 T04 的「约束即断言」。
- 新权限码**不要写进 `backend/src/index.ts`**（校验器第 10.6 节会把入口里的 `'xx/yy'` 字面量当旧权限码）；
  也**不要让某个 v2 路由模块对整个 `/api/v2` 兜底 404** —— `/api/v2` 下已有三条链路，
  各自只认领自己的前缀（库存 `/inventory*`、报价 `/sales/quotes*`、销售单 `/sales/orders*`），
  否则后接的链路永远不会被调用（E05 实测）。
- ⚠️ **`/api/v2/inventory` 前缀下现在有两个模块**：采购链路（`routes/purchase-v2.ts`，认领
  `/inventory/purchases`、`/inventory/receipts`、`/inventory/supplier-returns` 三条精确路径）
  与库存模块（`routes/inventory-v2.ts`，对该前缀有兜底 404）。**入口里采购必须排在库存之前**，
  否则采购路径会被那个 404 吃掉（E07 实测）。
- 改入口（`backend/src/index.ts`）必重跑 `validate-contracts.mjs`，并把 `actions.json` 里
  legacyPermissionMap 的证据行号**整体按新增行数平移**。本轮（E06/E07）在入口顶部加了 4 行
  （2 行注释 + 2 行 import）、在分发处加了 12 行，证据行整体 **+4**（分发处那段在文档末尾，不影响行号）。
  做法：先数清插入点在证据行之前还是之后，再统一 `+N`，然后重跑校验器逐条复验。
- 生产/测试隔离、远端迁移状态未核实（0004–0014 均未应用远端）；**不自动部署、不应用远端迁移、不提交、不外发**。
- 原型与本地预览的演示数据必须标明；不能伪造支付、落库或交付成功。
- 看不到截图就明说看不到；不要把「文件存在」当成「界面已验收」。

## 保留复用

- `backend/src/routes/quote-v2.ts` / `inventory-v2.ts`（v2 分发样板：各自认领前缀、契约信封、权限、guidanceFor）。
- `backend/src/domains/access.ts`（新码 + 旧码兼容表，`grants()`/`grantsAny()`）。
- `backend/src/domains/quote.ts`（B01/B02 的 plan 写法、issue 的重放保护位置、过期判定）。
- T04 幂等、T05a 库存领域、T03 身份/请求层、`backend/tests/lib/worker.mjs`、`backend/scripts/dev-server.mjs`。
- E05 浏览器验收脚本 `docs/verification/2026-09-19-E05-quote/verify-quote.cjs`（含 popup 打印取证、4xx/5xx 全量记录）；
  E05b 确认链路验收 `docs/verification/2026-09-19-E05b-confirm/verify-confirm.cjs`（更精简的样板）。
- **E03 视觉验收脚本 `docs/verification/2026-09-21-E03/verify-e03.cjs`**：断言打在 computed style 上（不是整页文本），
  并带「旧报价编辑器蓝绿渐变按钮未被污染」的回归断言 —— 以后改 UI 照这个写。
- **E05b 补契约新动作的流程**（B42 先例）：enums.json（值 + 状态机转换 + ActionCode）→ objects.json（字段 + 规则）→
  **主 actions 数组**（不是 supplementaryActions）→ legacy-mapping 登记过渡表 → generate-dto + sync-contracts 重新生成。
  uiRefs 只认已登记页面；`guardStatement` 条件为真即中止，别把 EXISTS/NOT EXISTS 写反。
  **E07 的 B38 就是按这条流程把 reserved 提升为正式动作的第二个先例**（见 E07 验证记录）。
- **E06/E07 新增的可复用样板**：
  - `backend/src/domains/sale.ts`：定金闸（`requiredDepositCents`）、逐件占用三步（INSERT 占用 → 条件 UPDATE 实物 → 守卫确认）、
    `allocateDiscount`（money-rules 的向下取整 + 最大余数）、`balanceDirectionFor` / `collectableCents`。
  - `backend/src/domains/purchase.ts`：`pendingQty` / `receiptProgress` 派生口径、拒收不建实物不写流水、
    到货成本继承采购行、`planReturnToSupplier` 的「只减不增」写法。
  - `backend/src/routes/purchase-v2.ts`：**同前缀下多模块共存的样板**（只认领精确路径 + 返回 null 让位 + 入口顺序）。
  - 前端 `WorkbenchSalesPage.tsx` / `WorkbenchPurchasePage.tsx`：彩色版页面样板（指标卡用 `wb-inv-totals`、
    表格用 `wb-quote-table` + 页面作用域类 `wb-sales-page` / `wb-purchase-page`）。
  - 浏览器验收脚本 `docs/verification/2026-09-21-E06/verify-sales.cjs`（端到端：报价转单 → 收款 → 成交 → 采购到货）。

## 前端两个坑（本轮实测，改 UI 时别再踩）

1. **不要把 `.wb-inv-head` 用在 `<thead>` 上**：那个类带 `display: grid` + `grid-template-columns`，
   是给 `div` 版表格行用的。用在 thead 上会让表头变 grid，整表列宽崩掉（列头竖排成单字、金额被截断）。
   `<thead>` 不要加类名。
2. **effect 里不要同步 setState**：`react-hooks/set-state-in-effect` 会报错，
   而 lint 基线是 39 项（35 error + 4 warning），**新增任何一项都会被当成回归**。
   正确写法见 `WorkbenchInventoryPage.tsx` / `WorkbenchSalesPage.tsx`：在 effect 内用
   `fetch(...).then(...)`，把 setState 放在回调里；加载态由初始值与事件处理设置。

## 收工必跑

```
npm --prefix backend test                 # R02/B16 后基线 351 用例 / 0 失败（原 334 + R02 17）
npm --prefix frontend test                # 基线 16 文件 170 用例（R02/B16 未改前端）
npm --prefix frontend run build
npm --prefix frontend run lint            # 39 项既有失败，不得说成通过；新增必须为 0
node contracts/tools/validate-contracts.mjs        # R02/B16 后基线 3476 通过 / 0 失败
node contracts/tools/generate-dto.mjs --check
node frontend/scripts/sync-contracts.mjs --check
node miniprogram/scripts/sync-contracts.mjs --check   # ⚠️ 三处生成物都要比，漏这条会漏掉小程序端漂移
node contracts/tools/check-client-parity.mjs
node backend/scripts/sync-error-codes.mjs --check
node scripts/check-doc-links.mjs
node docs/verification/2026-09-21-E06/verify-sales.cjs       # 32 项 / 0 失败
node docs/verification/2026-09-21-E07/verify-purchase.cjs    # 14 项 / 0 失败
node docs/verification/E08-current/verify-e08.cjs            # 25 项 / 0 失败（HTTP）
node docs/verification/E08-current/verify-e08-browser.cjs    # 15 项 / 0 失败（浏览器）
node docs/verification/E09-current/verify-e09.cjs            # 22 项 / 0 失败（HTTP）
node docs/verification/E09-current/verify-e09-browser.cjs    # 13 项 / 0 失败（浏览器）
node docs/verification/E10-current/verify-e10.cjs            # 28 项 / 0 失败（HTTP）
node docs/verification/E10-current/verify-e10-browser.cjs    # 19 项 / 0 失败（浏览器）
node docs/verification/E12-current/verify-e12.cjs            # 17 项 / 0 失败（HTTP；前端由 ChatGPT 做，无浏览器脚本）
node docs/verification/F1-current/verify-f1.cjs              # 28 项 / 0 失败（HTTP；F1 无前端页面，无浏览器脚本）
node docs/verification/2026-09-22-F2-b19/verify-b19.cjs      # 37 项 / 0 失败（HTTP；F2 无前端页面，无浏览器脚本）
node docs/verification/2026-09-22-F3-purchase-cancel-payment/verify-f3.cjs  # 42 项 / 0 失败（HTTP；F3 无前端页面，无浏览器脚本）
node docs/verification/2026-09-22-B16-count/verify-b16.cjs    # 37 项 / 0 失败（HTTP；B16 无前端页面）
node docs/verification/2026-09-22-R02-workbench/verify-r02.cjs  # 59 项 / 0 失败（HTTP；R02 无前端页面）
```

改了网页 UI 还要跑浏览器验收并**实际看图**，不能只看 json 里的通过数。
验收脚本会自己起前后端（端口 E06: 8816/5204、E07: 8817/5205、E09: 8819/5207、E10: 8821/5210），跑完记得看图确认没破版。
