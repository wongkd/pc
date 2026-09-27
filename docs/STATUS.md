# 当前状态

2026-09-28 已发布：按需页面切换修复、HTTP附件编号兼容、独立商城商品管理和图片裁切已上线；生产 D1 已应用0034。Worker 版本及线上只读核验见[本轮回执](verification/2026-09-28-catalog-navigation/README.md)。员工登录后的操作尚未验收；小程序生产 API 地址及门店ID仍未配置。

历史版本（2026-09-27）：仓库 V2 与客户查询提交 `463895c`、迁移外键修复 `3874cfe` 已推送 `origin/main`。当时生产 Worker `3d9ad66b-5609-4a7e-bd5a-27f789b54a26` 流量 100%；D1 已应用 `0032`、`0033`。详情见[仓库与客户查询发布回执](verification/2026-09-27-warehouse-customer-release/README.md)。临时 VPS 与域名路由现状见[核验回执](verification/2026-09-28-vps-domain-routing/README.md)。
本文是代码入口与已有证据的摘要，历史测试数不代表本轮重新通过。

| 范围 | 当前事实与证据 |
|---|---|
| 二手配件仓库重规划 | U00–U05 已部署，生产 `0032` 已应用。分类库存、逐件登记、检测状态与补录、采购 / 回收 / 报价衔接已通过隔离 Worker/API 与窄屏、桌面和键盘验收；生产登录后的员工操作仍待只读验收。迁移重建前已有 1 条盘点行外键指向流水，本次修复后保留引用、触发器和余额；生产外键检查为空。详见[方案](plans/2026-09-27-used-parts-inventory/README.md)及[发布回执](verification/2026-09-27-warehouse-customer-release/README.md)。 |
| 低配置性能优化 | P00–P06 与收口版本见[历史发布回执](verification/2026-09-27-performance-release/README.md)，生产已应用 `0031`。客户台账现按 50 条游标分页并按页聚合订单，报价选客支持搜索和续载；`0033` 已应用并随新版本部署。性能基准及 1/3 Mbps 弱网结果见[本地复测回执](verification/2026-09-27-customer-performance/README.md)，仅证明开发服务和合成数据下的结果。单核 1 GB 容量、共享出口、真并发写入一致性与微信真机仍未测；抽象数据访问层、附件分流实现暂缓。 |
| 发布与工作树基线 | 集成提交 `463895c` 和迁移修复 `3874cfe` 已快进推送 `origin/main`；生产 Worker `3d9ad66b-5609-4a7e-bd5a-27f789b54a26` 当前为 100%。未提交的历史文档索引、日志和截图仍保留，未混入发布代码；详情见[发布回执](verification/2026-09-27-warehouse-customer-release/README.md)。 |
| 配件收发流程 V2 | 已将库存、采购到货、收旧件和销售交付聚合到“仓库”入口，并简化报价、回收详情和置换主要操作。V1 基线与 V2 生产发布证据见[V2 回执](verification/2026-09-26-v2-item-flow-release/README.md)；无迁移或生产业务数据写入。批次出库余量、旧 SN 台账、维修耗件映射和真实员工流程仍未闭环。 |
| 商品建档、期初库存与仓库日志 | 分类改为固定下拉并支持其他自定义；导航已改为“仓库”，增加默认折叠、库存可见成员可读的近 50 条操作日志。合并版已加入随时逐商品登记已有库存；商品先建档，库存失败可稍后补录。生产未开启旧期初窗口、未写库存。细节见[仓库体验发布回执](verification/2026-09-26-warehouse-refresh/README.md)、[轻量化改造记录](plans/2026-09-26-lightweight-stock-entry/README.md)和[合并发布回执](verification/2026-09-26-consolidated-release/README.md)。 |
| 经营规则 D01–D10 | [规则逐项核验](verification/2026-09-25-operating-rules/README.md)：15%预付款门槛与库存预留有后端守卫；已核实净收款及同客户同销售单有效折抵均可计入，未付款不占货。老板退款登记须确认实际已退款；B18 是人工核实记账，不是支付渠道证明，未知结果不得调用。报价条款进订单快照，但顾客暂无订单详情读取；基础质保按版本留档。D10 成本四分类、盘点行防重和窗口规则已隔离验收；生产 `0029/0030` 历史应用见[D10 回执](verification/2026-09-26-d10-production-release/README.md)，当前生产迁移状态以[最新发布回执](verification/2026-09-27-warehouse-customer-release/README.md)为准。窗口仍未开启、真实库存未录入。未知成本销售例外、估值毛利单列报表和关闭后的追加调整仍未实现；B39/B40、供应商真实退款/贷项、自动配送计费、延保选购收费/履约仍暂缓。 |
| 自动编号与追溯 | 用户已确认“内部自动编号 + 厂家 SN 可选扫码 + 备注；耗材按批次编号 + 备注”。首版源码已接入期初库存、采购到货、维修设备、回收取得/拆件及库存查询；隔离预览 D1 已应用 0027、0028，生产迁移状态另行核实。批次只记录入库数量，未按批次追踪出库余量；旧 SN 台账仍独立。见[方案与当前边界](plans/2026-09-24-auto-serial/README.md) |
| 网页视觉 | 彩色 [Core V2](design/2026-09-19-erp-core/v2/README.md) 已定；[E03](verification/2026-09-21-E03/README.md) 是历史页面覆盖记录。旧报价编辑器已移除；新版 A4 打印仍待 QT03 实看。回收页已补分步操作指引并发布，详见[回执](verification/2026-09-25-recovery-guidance-release/README.md) |
| 客户 / 库存 / 报价 | E04、E04b、E05、E05b 已有真实接口与本地证据，见[索引](verification/README.md) |
| 管理员测试数据清理 | B45 未发出报价草稿与 B46 无业务引用商品清理已随合并版发布；入口在设置“清理草稿与空商品”，报价页和仓库页也有就近入口。登录后删除流程未做业务验收，没有删除任何生产记录。库存实物、流水、顾客设备交接与交易历史保留。详见[本次 UI 发布回执](verification/2026-09-26-inventory-ui-cleanup-release/README.md)、[原清理功能回执](verification/2026-09-26-admin-data-cleanup/README.md)。 |
| 报价新建模板 A+B | QT01/QT02 已本地实现；列表读模型缺陷已单独修复，详见[独立回执](verification/2026-09-25-quote-list-work-revision/README.md)。本机正式页面独立重载后列表与详情均为工作版本 v1、2 行、应付 ¥779.99。A4 正式打印模板已按用户确认字段、质保规则及报价日期起算 24 小时有效期更新；报价行支持顾客可见备注，二手配件默认质保改为 1 个月。本轮新建编辑器改为具名响应式字段组，A4 分页重复表头并保护明细行和签字区；前端 build 通过。E05、定向前端测试与 build 的既有证据见回执。系统打印预览实看与取消状态待 Edge 验收，**QT03 未放行**。见[A4 最终版说明](design/2026-09-25-quote-print-a4/README.md)与[本机打印续验](verification/2026-09-25-quote-list-work-revision/print-followup.md)；保留[原续验与截图](verification/2026-09-24-quote-templates-ab/QT03-followup.md)；C/D 不在本期 |
| 销售 / 采购 / 交付 / 售后 / 回收 / 账本 | E06–E11 已有实现与分卡验证；[报价引用与数量件预留补洞](verification/2026-09-21-E06E07-gapfix/README.md)已完成。本地同 Worker/D1 浏览器续验已补销售到交付、售后完整链、回收验机到折抵、客户新增/编辑及刷新回读和实际单据失败恢复；不代表整体验收、远端或生产放行，见[浏览器续验](verification/2026-09-25-web-browser-acceptance/README.md) |
| P2 ERP 总集成 | [本地总链](verification/2026-09-23-P2-erp-integration/README.md)已在同一真实 Worker / 内存 D1 串行通过报价确认、成交缺货、采购到货付款、补占用、装机交付、售后、回收抵用与账本；并修复确认报价无法转单。后端 360/360、前端 test/build 与契约迁移门禁本轮通过；不等于浏览器、远端或生产验收 |
| 抵用 E12 / FE-D | [回收单详情入口](verification/2026-09-24-FE-D-E/README.md)：隔离预览已完成关联同客户销售单、¥850 折抵、¥851 超额拒绝及撤销，余额与历史状态符合预期；回收登记已补客户档案选择并提交 `sellerCustomerId`。预览 D1 0027/0028 已应用以匹配新部署代码；生产和微信端未验收 |
| 导航 FE-E | 客户台账已列入主导航下的常用页面；六项主导航不增加；`/customers` 从批量占位路由映射排除。本地浏览器已完成列表、详情、刷新与返回，详见[FE-D/E](verification/2026-09-24-FE-D-E/README.md) |
| 附件 / 隔离件 / 整备上架 | [FE-A–C](verification/2026-09-24-FE-A-C/README.md)已在本地浏览器完成主链；本轮补了附件权限/并发/未知结果重试、B19 无附件退役页面回归、B30 付款流水与凭据引用校验/展示。专用隔离 D1/R2 已做合成恢复；源与恢复桶当前各报 1 个对象，精确 key 的 72 字节读回 SHA 与 D1 一致。隔离 Workers.dev `/health` 在 curl 与 Edge 均连接失败，应用上传/跨实例/权限/并发/持久化标记、恢复服务健康及 API 全量清单未验，详见[续验记录](plans/2026-09-25-data-attachment-go-live/drill-20260925/worker-http-followup-20260925.md) |
| R13 客户/设备读 | v2 `/customers/:id`、`/devices/:id` 已落地并有本地 HTTP 证据；旧 `/api` 保留兼容。销售只读看联系/单据索引/设备归属，配置历史须售后查看权限且已脱敏，见[核查记录](verification/2026-09-22-BE03-R13/README.md) |
| 工作台 R02 / 盘点 B16 | 今天页使用 `/api/v2/workbench`；本轮 R02 Worker HTTP 18/18、前端工作台/采购/履约/售后/回收与契约夹具 44/44、build 通过，补了失败重试、演示图片隔离和主动作跳转。B16 批准下降盘点会被服务端拒绝，避免替代暂缓的 B39 报损。真实浏览器故障注入与远端/生产仍未验，见 [R02 UI](verification/2026-09-25-workbench-live-api/README.md) 与 [B16](verification/2026-09-22-B16-count/README.md) |
| 采购付款 / 取消 B33/B34/B37 | 本地 HTTP 已补权限、并发付款/取消、逐笔冲销后净额归零再取消；采购页未知写入现在能查操作结果并按终态刷新或保留表单。本地前端回归通过；浏览器故障注入和远端/生产仍未验收，见[F3](verification/2026-09-22-F3-purchase-cancel-payment/README.md) |
| 整备上架 B30 | 本地浏览器已验证整备与上架主链；本轮补验成本权限、并发累加、付款流水必须为本店支出流水、财务凭据读回及页面提交，并验证幂等重放不重复入账。此动作只引用既有付款流水/凭据，不自动创建现金流水；浏览器故障注入与远端/生产仍未验收，见[B30/B36](verification/2026-09-22-B30-B36/README.md) |
| 单据生成 B36 | 当前首发边界定为报价 HTML 白名单快照；本地 Attachment、版本追溯、同店权限下载和敏感字段过滤已通过本地 HTTP 专项。PDF/图片及报价以外实体模板暂缓，扩展时逐实体冻结顾客白名单。R2 未配置时本地存储不跨进程持久。见[本轮回执](verification/2026-09-22-B30-B36/README.md) |
| 报损 / 改价 B39/B40 | 首发暂缓、动作保持 reserved；[D01/D02 规则已冻结](plans/2026-09-23-owner-decisions/README.md)，无需重新拍板。B16 向下盘点批准与 v2/旧版通用商品改售价均被服务端拦截；商品建档初始价和报价新版本定价不属于商品主数据改价动作。详见[本轮核验](verification/2026-09-25-operating-rules/README.md) |
| 顾客 4Tab | 排版见[排版接续入口](verification/customer-4tab/2026-09-23-layout-rework/README.md)：113/113 与类型/结构/样式/契约检查通过；390 四页、320 部分与 430 首页/商城已实看，375、完整尺寸矩阵、叠加偏差表及真机未完成，**MP15 仍未放行**。**MP16 已实现**（[回执](verification/customer-4tab/MP16/README.md)，M 档 123/123）：三档环境、正式版不得连测试/演示环境、真实模式缺 HTTPS 地址即报错不降级、顾客存储 `pc-customer:` 前缀与员工端隔离。**MP17 契约与迁移已落地**（[回执](verification/customer-4tab/MP17/README.md)，C 档门禁全绿 + 后端 360 用例）：新增 `CustomerIdentity` / `CustomerSession` 与迁移 0026，顾客与内部成员是两条独立链路；单店绑定、认领走微信验证手机号或店员确认、会话 30 天。**顾客登录实现（MP18）未开始**；微信实连因无备案域名阻塞，0026 未应用远端。真实记录与支付未接通。支付前置已完成盘点与契约设计草案，见[支付前置方案](plans/2026-09-23-payment-prerequisites/README.md)；MP56–MP59 因上游未接、主体/商户号未就绪、D06/D09规则尚未落实到契约与页面**暂不具备开工条件**。 |
| 收口与上线顺序 | [总计划](plans/2026-09-22-erp-rollout-master/README.md)已把后端、网页前端、测试部署和小程序数据汇合分阶段，并提供可复制任务；计划完成不等于这些任务已实施 |
| Cloudflare 隔离预览 | `https://pc-erp-preview.563838884.workers.dev/` 接入独立预览 Worker，只连测试 D1 `pc-erp-preview-20260924`；生产 ERP 子域已切到生产 Worker。专用隔离环境的 29 项迁移、合成 D1+R2 备份恢复、SHA 与 Worker 控制面回退通过；应用端跨实例附件写读/并发、恢复 Worker 健康和完整对象清单仍未完成。R2 桶摘要计数与直接 GET 不一致。详见[数据与附件保障计划](plans/2026-09-25-data-attachment-go-live/README.md)及[隔离演练](plans/2026-09-25-data-attachment-go-live/drill-20260925/README.md)，隔离演练不得使用生产 `pc-db` / `pc-attachments` |
| 生产运行时与数据 | [生产重置回执](verification/2026-09-25-production-reset-release/README.md)记录此前清理业务行与保留账号/权限；当前 Worker、D1 迁移和绑定见[仓库与客户查询发布回执](verification/2026-09-27-warehouse-customer-release/README.md)。期初窗口仍为未开启；生产登录后的员工权限、真实业务流程、应用附件 R2 和 RC 整体验收仍未完成。旧供应商密钥仍应由管理员轮换。|
| 文件治理与旧工具下线 | [生产重置发布回执](verification/2026-09-25-production-reset-release/README.md)：旧报价编辑器/订单页与旧前端 API 已移除，旧接口线上返回 410（后端旧处理函数仍保留在入口文件，被退役守卫挡住）；旧店员小程序四页与两个详情分包已删除，顾客端四页保留。网页构建、页面结构和契约门禁通过，单元及浏览器测试本轮未运行；Cloudflare 发布完成。小程序尚未在微信平台上传/审核/发布 |
| 上线托管与备案（2026-09-25 拍板） | 方案见[托管与备案方案](plans/2026-09-25-hosting-and-filing/README.md)：采用**主线＝国内轻量＋域名过户＋备案主体变更**（约 ¥68–158/年）＋**备选＝微信云托管 CloudRun + `wx.cloud.callContainer` 免备案过渡**。已排除微信云开发（¥239/年且运行时/数据库锁定）、小转售商机器（2026-09-25 实测交付不出 IP、自营 NAT 机端口 5 次重试全 refused）、NAT 机（共享 IP 不能备案，含 #server-2880「10 年传家宝」）。⚠️ **阻塞项**：`huangqidong.cn` 备案状态口径冲突——栋哥 2026-09-25 口述"已备案、主体为个人"，但[上线前置清单](plans/2026-09-22-go-live-prerequisites/README.md)记载该域名未在国内备案；且小程序关联域名必须与小程序主办者一致，**个人备案域名不能直接用于个体户小程序**。全部执行动作（过户/买机/备案/认证/部署）**一件未做** |

## 验收与环境边界

- 各模块当时的实跑结果在[验证索引](verification/README.md)；历史材料按需读。
- 前端 lint 本轮实测 9 errors + 3 warnings（开工为 40 + 5），尚未全绿；分布见本轮入口治理回执。
- 本地默认 Worker + 内存 D1/附件；Cloudflare 预览只连独立测试 D1。附件接口在正式/预览变量启用时要求 R2 绑定。专用隔离环境已核实真实 R2 CLI 读写与恢复 Worker 绑定；生产 D1/R2 绑定与路由已确认，生产完整恢复、Worker 回退、应用层 R2 canary 和员工权限矩阵仍未验证。
- 既有本地验证记录中的前端 build 通过；本轮生产店主登录成功，今天页、库存、采购、售后、回收、账本、客户、报价、销售与交付列表均实看空态。此次生产只读验收边界见[续验回执](verification/2026-09-25-production-staff-acceptance/README.md)；真实业务闭环仍没有数据可验。本地业务链见[续验记录](verification/2026-09-25-web-browser-acceptance/README.md)。
- 员工权限前置数据已复验：本地预览内存库新增 `sales` 演示角色种子；未传 `roleId` 邀请、接受、重新登录及逐域 HTTP 权限 30 项通过。生产设置页显示 5 种角色说明和当前成员状态；员工实际会话、菜单显隐和服务端拒绝仍未验证，见[本地复验](verification/2026-09-25-staff-permissions/README.md)与[生产续验](verification/2026-09-25-production-staff-acceptance/README.md)。
- 本轮合并发布回执见[记录](verification/2026-09-26-consolidated-release/README.md)：Worker `18d061cd-e8ee-4343-bec2-312b6a3c8e82` 为 100%，线上 JS/CSS 文件名与本地构建一致；未做本轮生产登录后的业务流程验收。D10 / E04 历史发布见[旧回执](verification/2026-09-26-d10-production-release/README.md)。
- 微信工具、iOS/Android、真实支付、跨实例并发与恢复演练不由网页测试代替。
- 当前发布代码已提交为 `8b75245` 并部署。没有应用数据库迁移、没有开启期初窗口，也没有写客户、库存或其他生产业务行。原有未跟踪日志和截图继续保留在工作区，未加入提交。

- 网页全局视觉已按顾客小程序白底黑字、细线、小圆角和米色点缀统一，并随合并版部署；代表页桌面/手机实拍见[视觉统一回执](verification/2026-09-25-web-visual-unification/README.md)。该回执截图是较早版本，本轮没有重新进行全页面视觉验收。

下一动作只见[交接](NEXT-SESSION-PROMPT.md)，未解决的问题只见[OPEN-ITEMS](OPEN-ITEMS.md)。
