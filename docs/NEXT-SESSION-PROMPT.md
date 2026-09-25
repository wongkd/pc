# 下一次从这里继续

更新：2026-09-26。P2 本地总集成见[总链回执](verification/2026-09-23-P2-erp-integration/README.md)。隔离 Cloudflare 预览只连 D1 `pc-erp-preview-20260924`，入口为 `https://pc-erp-preview.563838884.workers.dev/`。生产 0029 客户来源与 0030 D10 迁移已按顺序应用；Worker `a9b78a73-6b17-4de5-ba82-c1dbc4858187` 已部署到 100% 流量，详情见[生产回执](verification/2026-09-26-d10-production-release/README.md)。没有开期初窗口或写真实库存。生产登录后的员工页面、真实业务交易与 RC 整体验收仍未完成；旧 PDD 供应商密钥仍需管理员轮换。
总计划与可复制任务见[ERP 收口总计划](plans/2026-09-22-erp-rollout-master/README.md)；文件治理记录仍见[维护记录](verification/2026-09-22-repository-maintenance/README.md)。

## 当前范围决定

- **首发暂不包含 B39/B40**：动作保持 reserved；D01/D02 已冻结，后续实施不再要求老板填写；不得以其他库存动作或通用编辑代替。
- **经营规则已逐项核验**：见[实现与守卫回执](verification/2026-09-25-operating-rules/README.md)。D10 正式期初成本四分类与窗口规则已隔离验收，0029/0030 和 Worker 已生产上线，见[D10 / E04 生产回执](verification/2026-09-26-d10-production-release/README.md)。期初窗口尚未开启；若要正式建账，下一步先取得已审核的门店盘点表和店主选择的 1–7 天期限，再按单独操作顺序处理。未知成本销售例外、估值毛利单列报表和关窗后追加调整仍未实现，继续分开跟踪；顾客暂无订单质保快照读取入口；供应商真实退款、自动配送计费、延保购买/收费/履约及 B39/B40 首发均暂缓。不要把人工登记/报价文案当作支付服务或履约已接通。
- **B36 首发限报价 HTML 白名单快照**：PDF/图片和其他实体模板后续按逐实体顾客字段白名单扩展；R2 未配置时附件不具备跨进程持久性。
- **前端 lint 剩余治理**：本轮从 40 errors / 5 warnings 降至 9 / 3；分布见入口治理回执，按 effect 请求生命周期处理，不直接禁用规则。
- **生产重置后的页面续验部分完成**：[本轮回执](verification/2026-09-25-production-staff-acceptance/README.md)记录店主新登录和客户、报价、销售/收款、库存/采购、交付、售后、回收、账本的空态可见；没有写生产数据。员工登录/页面权限与真实业务闭环仍未验；不要为验收伪造单据。回执中的成员行数与重置计数还需只读核对。旧 PDD 变量已清出 Worker，供应商侧旧密钥仍需管理员轮换。小程序没有发布到微信平台。

## 接续方式

1. 先看 git status，保留已有修改；读 STATUS 后，按用户本次任务选一条业务线。
2. 只读对应任务 README 和相关源码；不要把本文件中的候选任务全部启动。
3. 改到某个大文件时按业务职责拆分并验证；清理完成不等于业务实现完成。

## 本轮新增断点（数据与附件上线保障）

2026-09-25 续验已匹配隔离源/恢复桶各 1 个对象与同一 D1 附件记录；但 Workers.dev `/health` 从 curl 和 Edge 都连接失败，无法完成应用 HTTP 与独立全量清单。详见[续验回执](plans/2026-09-25-data-attachment-go-live/drill-20260925/worker-http-followup-20260925.md)。

入口：[保障计划](plans/2026-09-25-data-attachment-go-live/README.md)。专用隔离环境已完成 29 项 D1 迁移、R2 CLI 远端对象读写、合成 D1+R2 一致点备份/恢复、SHA-256 与源 Worker 版本控制面回退；但应用 Worker 跨实例读写/并发、恢复 Worker 健康和完整对象清单仍未通过。生产 `pc-db` / `pc-attachments` 已实际投入 Worker 绑定，**不得用生产资源做演练或 canary**。生产附加 API 的真实上传/授权下载和应用层持久标记仍未验。生产当前状态与边界见[续验回执](verification/2026-09-25-production-runtime-browser-followup/README.md)。

| 用户要继续的工作 | 下一条动作 |
|---|---|
| 装机报价新建模板 A+B | [列表工作版本读模型修复与续验回执](verification/2026-09-25-quote-list-work-revision/README.md)：E05/E05b/P2 与报价页定向测试通过，正式本机页面独立重载列表、详情均显示 v1 / 2 行 / ¥779.99。新建编辑器已重排为具名响应式字段组，A4 打印分页补上重复表头与行/签字区防拆，本轮 build 通过。下一步在 Edge 系统打印预览核对实际分页、明细/条款并取消预览；该项完成前 QT03 保持未放行。见[A4最终版说明](design/2026-09-25-quote-print-a4/README.md)和[本机打印续验](verification/2026-09-25-quote-list-work-revision/print-followup.md)。保留[旧续验和截图](verification/2026-09-24-quote-templates-ab/QT03-followup.md)，不扩展 C/D。 |
| 自动序列号 | 用户已确认内部自动编号、厂家 SN 选填、备注及耗材按批次编号。源码已接入首批入口；下一步按[自动编号方案](plans/2026-09-24-auto-serial/README.md)完成静态审查后，在用户要求验证时依序跑迁移、后端与前端门禁并记录结果。旧 SN 台账与新库存不可直接合并计库存；批次余量归属、标签打印和历史映射仍待后续定范围 |
| 生产重置 / 旧工具下线 | 已完成并发布，旧接口 handler 函数仍留在 `backend/src/index.ts` 且生产路由返回 410；物理删除源代码尚未做。生产店主登录和业务页空态已核对，详见[部分验收回执](verification/2026-09-25-production-staff-acceptance/README.md)。员工角色页权限、真实业务闭环和微信平台发布仍未完成。 |
| 回收置换操作指引 | 已补回收分步提示、置换同客户/单据/金额核对说明和关联编号；前端测试 210/210、build 通过，Worker `68917714-5b4e-4786-8ef6-507d9b015b40` 已发布 100%，生产首页资源名核对通过。员工账号下的生产操作验收仍待完成，详见[发布回执](verification/2026-09-25-recovery-guidance-release/README.md)。 |
| 网页前端美化 | 已按顾客小程序黑白/米色基准更新共享样式与报价表单，桌面/手机代表页截图见[视觉统一回执](verification/2026-09-25-web-visual-unification/README.md)。仍待用户视觉反馈、其余页面/弹层状态验收及生产员工账号下的业务验收。 |
| 前端 lint 治理 | 当前 9 errors / 3 warnings，集中历史订单、商品、设置、折抵面板与今天页；见入口治理回执。结合异步请求取消、竞态、权限与页面回归处理，不改 B39/B40 等业务语义 |
| FE-A–C 附件 / 隔离件 / 整备上架 | 本地浏览器主链与附件页面/API回归已完成；隔离 R2 CLI 读写及源/恢复单对象 SHA 对账已验证。源、恢复 Worker `/health` 在当前网络均不可达；下一步需用获准且能访问 Workers.dev 的网络，验证应用上传、跨实例读、并发、授权下载、`storageKind`/`storagePersistent` 与恢复服务健康，并取 API 完整对象清单。详见[HTTP 与对象清单续验](plans/2026-09-25-data-attachment-go-live/drill-20260925/worker-http-followup-20260925.md) |
| 今天工作台 R02 | 本地 Worker HTTP 18/18、工作台/采购/履约/售后/回收/契约夹具前端回归 44/44 与 build 通过；主动作现可进入对应业务页并携带单号。下一步在同一隔离 Worker + 前端会话实看交付、缺货采购、维修、回收跳转/返回，并注入工作台接口失败；不部署。见[回执](verification/2026-09-25-workbench-live-api/README.md) |
| B36 单据生成 | 报价 HTML 已保存为可追溯 `document_export` 附件；同店权限下载与脱敏文件 HTTP 专项通过。R2 未配置时是进程内存存储（`storagePersistent=false`）；Cloudflare/生产未应用 0028。下一步如继续扩展，先逐实体冻结顾客白名单并添加相应模板；PDF/图片仍明确不支持。回执：[B30/B36](verification/2026-09-22-B30-B36/README.md) |
| 顾客 4Tab | 分两条：①排版——先读[排版接续入口](verification/customer-4tab/2026-09-23-layout-rework/README.md)，只处理剩余比例/素材差异，再补 375 与缺失尺寸、叠加偏差表；MP15 仍 blocked。②地基——**MP16、MP17 已完成**（[MP16](verification/customer-4tab/MP16/README.md) / [MP17](verification/customer-4tab/MP17/README.md)），下一张做 **MP18 顾客登录服务端**（`domains/customer-identity.ts`、`routes/customer-auth.ts`、`index.ts` 接线、`tests/customer-identity*.mjs`）；动接线前先复核 contracts/v1、index.ts、migrations 的时间戳与 diff。不要重复已完成导航修复或全库盘点。 |
| R13 客户/设备详情 | 已完成：v2 路径保留旧接口兼容，销售读设备归属、售后读配置历史；DTO 已排除成本/SN/备件引用。证据见[BE-03/R13 核查](verification/2026-09-22-BE03-R13/README.md) |
| FE-06 接修/回收附件 | 本地 Worker/浏览器上传与详情列表已验收；本轮专用 R2 的远端对象读写、D1+对象恢复及单对象 SHA 对账已验。应用 Worker 的跨实例写读、并发、授权下载、持久化标记和恢复服务健康仍待验；当前网络对 Workers.dev 报 TLS 握手失败 / `ERR_CONNECTION_CLOSED`，详见[隔离续验回执](plans/2026-09-25-data-attachment-go-live/drill-20260925/worker-http-followup-20260925.md) |
| FE-D/E 折抵主链 | 已在隔离预览浏览器完成客户关联、回收所有权、建立销售单置换关联、¥850 折抵、¥851 超额拒绝和撤销复核；仅生产/微信端未验收。记录见[FE-D/E 回执](verification/2026-09-24-FE-D-E/README.md) |
| RC-UI-01 员工权限与整体验收 | 本地同一 Worker/D1 浏览器续验已完成销售到交付、售后完整链、回收验机到折抵、客户新增/编辑/刷新回读，以及真实业务单据上的失败恢复；过程与单号见[续验记录](verification/2026-09-25-web-browser-acceptance/README.md)。原整体验收仍未通过：员工页面级权限显示/隐藏与验收矩阵其余缺项待补。结合[员工权限复验](verification/2026-09-25-staff-permissions/README.md)和[原验收矩阵](verification/2026-09-25-release-candidate-acceptance/README.md)继续；本地结果不代表远端/生产已验。 |
| 客户台账异常态与远端验收 | 本地客户专项 15/15、全量 188 通过/16 跳过、build 通过；预览 D1 已只读确认应用到 0028，但首页仍引用旧包 `index-UObqBHyK.js`。先等用户明确授权发布当前工作区到隔离预览；Edge `/customers` 登录页已保留待用户手动登录，随后验客户列表/详情失败重试、设备保存/删除恢复。见[本轮记录](verification/2026-09-25-exception-states/README.md) |
| P2 总链复验 | 后端单链已固化为 `backend/tests/p2-erp-flow.test.mjs` 并进入全量；后续改报价、销售、采购、交付、售后、回收、抵用或账本时必须保留该回归 |
| 经营规则 D01–D10 | [逐项核验回执](verification/2026-09-25-operating-rules/README.md)：D10 生产迁移和 Worker 已上线；期初窗口仍未开启。要录真实库存，先取得审核后的门店盘点表和店主选定的 1–7 天期限。未知成本销售例外、估值毛利单列报表、关窗后追加调整仍未实现，见[生产回执](verification/2026-09-26-d10-production-release/README.md)。订单快照已保留基础质保条款；如做顾客端，先实现受顾客身份约束的订单质保读取并验白名单。延保购买/收费/履约仍暂缓；其他冻结规则照既定口径，不重新确认或绕行 |
| 多对话框继续开发 | 按[ERP 收口总计划](plans/2026-09-22-erp-rollout-master/README.md)分后端、前端、只读核查三条通道；后端和前端各自串行 |
| 顾客真实支付（MP56–MP59） | 仍暂不具备开工条件；D06/D09经营口径已解锁，先按[支付前置方案](plans/2026-09-23-payment-prerequisites/README.md)完成上游、行政资质和契约技术方案。顾客文案按15%预付款，禁止复用旧无条件不退条款 |
| 上线托管与备案（①+② 组合） | 2026-09-25 已拍板，方案与成本/材料/阶段表见[托管与备案方案](plans/2026-09-25-hosting-and-filing/README.md)。主线＝国内轻量＋域名过户＋备案主体变更；备选＝CloudRun 免备案过渡。**下一步只有两件**：① 栋哥核实 `huangqidong.cn` 备案号与主体（当前唯一阻塞项）；② AI 做后端存储层抽象＋Docker 化，使同一套代码可跑本地/云托管/轻量（不部署、不花钱、不碰 contracts/v1 与 migrations 与 index.ts 接线）。已排除云开发、小转售商机器、NAT 机 |

## 每次收尾

- 按[工程指南](engineering/README.md)跑对应检查，前端 test/build 串行。
- 契约/迁移/入口属于单点区，先核实是否有人写入；改后重生成、同步两端、跑门禁。
- STATUS 只写当前事实，本文件只写下一动作；不追加历代回执、整段命令和历史通过数。
- [进度台](design/2026-09-21-prompt-launcher/README.md)回执必须对应实际负责的卡；源码/证据变化后不能沿用旧 verified。
- 本轮已按用户授权完成生产 D1 迁移和 Worker 发布，并复核当前路由/绑定；这些操作不代表 RC 整体验收通过。本轮之后不自动追加生产写入、发布或迁移；无提交。
