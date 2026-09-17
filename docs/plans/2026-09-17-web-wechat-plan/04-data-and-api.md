# 04 · 数据模型与双端接口契约

日期：2026-09-17。状态：接口设计草案，T01 冻结后实施；不是已存在 API。入口：[总览](./README.md)。

## 1. 契约边界

新业务 API 暂以 /api/v2 为前缀，既有 /api 读写保留到兼容任务完成。前端不得同时使用旧收款接口和新结算接口对同一新订单记账。历史单默认只读；需继续处理的旧单要先映射到新规则、核对期初应收 / 库存 / 预留，再开放写入。

所有 ID 对客户端视为不透明字符串，不根据单号解析数据库主键。金额以 Cents 结尾，数量为整数，version 为非负整数；UTC 时间用 ISO 8601，只有纯日历日期才用 YYYY-MM-DD。

数据库 snake_case，协议 camelCase，通过映射转换；两端不能直接消费数据库行。currency 首版固定 CNY，serverCalculated 的汇总不接受客户端覆盖。

## 2. 数据对象与最低字段

公共字段：id、storeId（由后端身份派生）、version、createdAt、updatedAt、createdBy。正式事件另有 occurredAt、recordedAt、actorId、requestId、sourceType / sourceId。后端校验子对象确实属于同店，不能只检查父单。

| 对象 | 最低业务字段 | 约束 / 关系 |
|---|---|---|
| Product 型号 | sku、name、category、brand、specs、trackingMode(quantity/item)、requiresSn、status、defaultSalePriceCents、warrantyTemplate | 复用 hardware 的映射，不直接按同名合并 |
| StockBalance 数量余额 | productId、locationId、availableQty、reservedQty、quarantineQty、totalCostCents、costKnown | 汇总可重算；不成为缺少流水的手改数字 |
| StockItem 逐件实物 | assetCode、productId、condition(new/used)、snRaw / snNormalized、ownership、availability、location、acquisitionRef、acquisitionCostCents、refurbishmentCostCents、costKnown、inspectionRef、warrantySnapshot | 二手必有内部编号；当前状态与完整事件历史并存 |
| Customer 客户 / 卖方 | displayName、phone 可空、contactNote、remarkInternal | 散客允许最少信息；卖方和买方不是同一个覆盖字段 |
| CustomerDevice 客户设备 | ownerCustomerId、deviceCode、originalOrderId 可空、currentConfigurationId、custodyLocation、stockItemRef 可空 | 客户财产不进入自有库存汇总 |
| Quote / QuoteVersion | customerId 可空、title、revision、status、validUntil、lines、discountCents、termsSnapshot | 已发版不可覆盖；输出只取指定 revision |
| SaleOrder | orderNo、customerSnapshot、quoteVersionId 可空、kind(assembly/retail)、tradeState、fulfillmentState、dueAt、configurationVersion、totalCents、adjustmentCents、cashNetCents、offsetNetCents、balanceCents | 资金汇总由有效流水计算 / 维护，含 version |
| SaleLine | productId 可空、source(new/used/customer/service)、nameSnapshot、qty、unitPriceCents、discountAllocationCents、netLineCents、warrantySnapshot、customerDeviceRef 可空 | new/used 成交时需商品映射；used 指定实物 |
| Reservation | orderId、lineId、stockItemId 或 quantityBucketRef、qty、status(active/released/consumed)、reason | 逐件有效唯一，数量不超库存；历史占用保留 |
| Purchase / Receipt | supplierRef、purchaseLines、orderedQty、receivedQty、cancelledQty、receiptLines、unitCostCents、inspectionDisposition、expectedAt | 部分到货分次 Receipt；入库关联采购来源 |
| InventoryMovement | productId、stockItemId 可空、qty、fromBucket / toBucket、costCents 可空、source、reversalOf 可空 | 每项业务副作用有唯一来源标识，能追溯 / 重算 |
| Checklist / TestRecord | entityRef、templateVersion、configurationVersion、items、result、performedAt、performedBy | 修改配置后旧结果不支持新配置交付 |
| Delivery | orderId、configurationSnapshotId、deliveredAt、receivedByNote、financialDisposition、creditApprovalId 可空 | 一张首版订单最多一条有效整体交付；成本逐行快照 |
| Recovery | sellerRef、items、initialEstimateCents、offerVersion、finalAcquisitionCents、receivedAt、acceptedAt、confirmationEvidence、state | 一单可多个独立实物；逐件成本分配和总金额相等 |
| RefurbishmentCost | stockItemId、category、amountCents、capitalizable、paymentEntryRef 可空、evidenceRef 可空 | 费用归属与实际付款不是同一字段，防重复计成本 |
| ServiceOrder | customerId、deviceId、symptom、intakeSnapshot、state、proposalVersion、confirmedChargeCents 可空、warrantyDecision、dueAt | 未确认费用不进入应收；外店设备可无原订单 |
| DeviceConfiguration / Change | deviceId、revision、components、effectiveAt、changeRef | 保留原交付快照与每次换件，不覆盖历史 |
| Return / Refund | originalOrderId、lineAllocations、stockItemIds、reason、acceptedQty、creditCents、refundEntryRef | 实物接收 / 贷项 / 现金退款各有状态与引用 |
| CashEntry | direction(in/out)、amountCents、method、counterpartyRef、allocation、occurredAt、verifiedAt 可空、reversalOf 可空 | 一笔实际资金一条记录，不能又在账本手录一份 |
| Offset | tradeInId、saleOrderId、recoveryId、amountCents、state、reversalOf 可空 | 非现金事件，同时作用双方余额 |
| Attachment | ownerEntityRef、purpose、objectKey、contentType、byteSize、width / height、sha256、uploadState、visibility | 业务记录只关联上传完成文件；不存公开永久访问地址 |
| Operation | requestId、actorId、storeId、action、entityRef、payloadHash、status、resultRef、resultVersion、errorCode | 关键动作的幂等和结果查询，不是客户端内存标志 |
| AuditEvent | entityRef、action、beforeSummary、afterSummary、reason、actorId、occurredAt | 脱敏，不能写 token / 客户密码 / 原始大请求 |
| WechatIdentity / Session | appId、openid、memberId、sessionVersion、revokedAt、lastSeenAt | 微信标识绑定内部成员，不自动拥有门店权限 |

这些是逻辑对象，不意味着每个对象必须独占一张新表。T01 先编制旧表→新模型映射；按任务增量建表 / 字段，不在 v2 旁完整复制第二套互不相通的 ERP。

## 3. 读取接口

统一成功结构：data、meta；meta 至少有 requestId、serverTime、contractVersion。列表 data 含 items、nextCursor、hasMore、total（需要展示总数时）以及 filters。cursor 为不透明值，默认 limit 20，上限 100；统一稳定排序。

| 方法 / 路径（均在 /api/v2） | 参数 | data 关键字段 |
|---|---|---|
| GET /me | 无 | user、store、permissions、sessionVersion、capabilities |
| GET /workbench | category、view、q、cursor、limit、scope(open/today/overdue) | metrics、tasks、filters、generatedAt；各数字含 filterTarget |
| GET /search | q、type、cursor | groups(customers/orders/devices/items)、脱敏摘要、target |
| GET /sales/orders / :id | filters 或 id | 列表摘要 / 完整处理视图，version、allowedActions、blockers |
| GET /sales/quotes / :id | 状态、id / revision | 草稿或指定报价版 |
| GET /inventory | q、condition、availability、location、cursor | 型号汇总 / 二手逐件，权限决定 cost 字段是否存在 |
| GET /inventory/items/:id | id | 来源、状态、有效占用、检验、质保、事件 |
| GET /inventory/purchases / :id | filters 或 id | 采购、实到、在途、拒收 / 取消 |
| GET /service/orders / :id | filters 或 id | 工单、设备、方案、费用、步骤、允许动作 |
| GET /recovery/orders / :id | filters 或 id | 接收、估价、最终价、所有权、整备和应付 |
| GET /trade-ins/:id | id | 两端单据、有效折抵、应收 / 应付与处理状态 |
| GET /finance/overview / entries | from、to、direction、method、category | 汇总或流水，明确成交 / 现金 / 折抵不同列 |
| GET /customers/:id / devices/:id | id | 联系、单据、配置变更；按权限分域返回 |
| GET /operations/:requestId | requestId | status(pending/succeeded/failed)、resultRef、error |

TaskReadModel 最低字段：taskId、entityType、entityId、entityVersion、category、title、customerDisplay、deviceSummary、photoKind、photoUrl 可空、dueAt 可空、deadlineText、blockerSummary、amountSummary、primaryAction、detailTarget。sourceType 不限制为 sale，维修和回收不能伪造 orderId。

allowedActions 每项含 code、label、enabled、blockers；blocker 含 code、message、targetField / targetPage。禁用原因必须可读。GET 返回的许可不保证稍后 POST 成功，POST 仍读最新状态校验。

Workbench 的读数和列表应在同一读取快照 / 一致性窗口形成，响应含 generatedAt；前端不得把第一批旧指标和第二批新列表随意拼成“完全一致”结果。

## 4. 写入统一约定

请求包含 requestId（客户端在用户确认一个动作时生成并保留）、expectedVersion（已有实体）、业务字段。requestId 同时可放 Idempotency-Key 头，但两处若都存在必须相同。门店 / 操作人由会话取得，忽略或拒绝客户端伪造。

成功返回 data：operationId、entityId、entityVersion、state、effects（关联 receipt / reservation / delivery / entry 等 ID）、summary、allowedActions；meta 同上。资金 / 库存异步查询期间用 202 + pending，不先显示完成；首版业务尽量同步事务完成。

错误返回 error：code、message、fieldErrors、currentVersion 可空、retryable、operationId；meta 含 requestId。code 决定程序行为，message 是中文说明，不能靠包含某段中文来分支。

## 5. 动作目录与字段

以下以 POST 为默认；每个动作均遵守 requestId / expectedVersion。金额输出全部服务端重算。Bxx 对应[任务卡](./05-implementation-tasks.md)中的测试目标。

| 编号 / 路径 | 必填业务输入 | 服务端结果 |
|---|---|---|
| B01 /sales/quotes | customer / title 可选、lines、terms、validUntil 可空 | 新草稿；最少草稿可先为空，发出 / 成交才要求完整 |
| B02 /sales/quotes/:id/save、/issue | revision、编辑字段；issue 需完整配置 / 条款 | 新草稿版本或不可变已发版本 |
| B03 /sales/quotes/:id/convert | quoteVersion、customerSnapshot、dueAt、allocationChoices | 销售单、现货预留、缺口；指定二手冲突则整体失败 |
| B04 /sales/orders | kind、customerSnapshot、lines、terms、dueAt 可空 | 零售 / 直接销售草稿，再调用 confirm |
| B05 /sales/orders/:id/confirm、/allocate | 最新行数据或候选实物 / 数量分配 | 成交 / 补占用，服务端缺口 |
| B06 /sales/orders/:id/start-assembly | 领料位置、客供件接收引用 | 备料事实 / 阶段，不扣销量 |
| B07 /sales/orders/:id/checks | templateVersion、configurationVersion、changedItems、resultEvidence | 保存检查结果，刷新 version 与阻断项 |
| B08 /sales/orders/:id/payments | amountCents、method、occurredAt、remark 可选 | CashEntry + 订单余额；不要再 POST 账本复制 |
| B09 /sales/orders/:id/credit-approval | dueDate、reason | 老板批准的当时余额与条件 |
| B10 /sales/orders/:id/deliver | configurationVersion、checklistVersion、deliveryNote、creditApprovalRef 可空 | 交付、库存出库、成本快照、设备拥有关系 |
| B11 /sales/orders/:id/cancel | reason | 释放占用，预收转换待退，不自动现金退款 |
| B12 /inventory/products | sku 可系统生成、name、trackingMode、requiresSn、specs | 型号；关键属性已发生业务后修改需专门规则 |
| B13 /inventory/openings | approvedCountRef、lines、costBasis | 期初数量 / 实物 / 成本与审计；不是日常入库捷径 |
| B14 /inventory/purchases | supplier、lines(qty、unitCostCents)、expectedAt | 采购与在途 / 应付约定 |
| B15 /inventory/receipts | purchaseId 或 quickPurchase、lines(actualQty、snCodes、cost、disposition) | 原子入库、SN、流水、采购实到，不自动占用 |
| B16 /inventory/counts、/:id/approve | 范围与截止序号 / 实盘；批准需差异理由 | 盘点草稿或差异调整事件 |
| B17 /sales/returns | 原销售单、原行 / 实物 / 数量、reason、creditCents | 退货接收待检与贷项；后端校验累计上限 |
| B18 /sales/orders/:id/refunds | amountCents、method、occurredAt、returnRef 或 adjustmentRef、reason | 现金退款，关联既有应退，不自动处理实物 |
| B19 /inventory/items/:id/inspection | result(pass/fail)、findings、evidence、disposition | 待检→可卖或继续隔离；所需证据未完成则拒绝 |
| B20 /service/orders | customer、device、symptom、accessories、appearance、intakePhotos | 接修与客户设备保管，不加自有库存 |
| B21 /service/orders/:id/diagnosis、/proposal | 检测结果或处理项目 / 价格 / 质保依据 | 诊断 / 新方案版本 |
| B22 /service/orders/:id/confirm-proposal | proposalVersion、confirmationMethod、confirmedAt、note | 已确认收费与可执行方案 |
| B23 /service/orders/:id/replace | oldComponentRef、newStockItem / qty、oldItemDisposition、approvedProposalVersion | 备件消耗、配置新版本、成本与事件，原快照保留 |
| B24 /service/orders/:id/dispatch、/receive-external | 接收方、物流、预期返回 / 实到事实 | 外部位置 / 返回待复测 |
| B25 /service/orders/:id/retest、/return | 复测结果 / 附件、归还备注、结算依据 | 复测 / 归还客户，费用闸门；收款走共用资金服务 |
| B26 /recovery/orders | seller、items、initialEstimate、intake / custody | 回收登记、客户暂存，可保存待验机 |
| B27 /recovery/orders/:id/inspect、/offer | 检测结果 / offerVersion、逐件价、最终条件 | 检测记录 / 新估价版，不改所有权 |
| B28 /recovery/orders/:id/acquire | offerVersion、receivedEvidence、sellerConfirmation | 原子取得所有权、逐件成本、待整备库存、应付 |
| B29 /recovery/orders/:id/return | 未收购事实、归还确认、附件 | 客户暂存物归还，无采购成本 |
| B30 /inventory/items/:id/refurbishments、/make-available | 明细成本 / 检测、成色、披露、质保、标价 | 整备事件 / 可卖门槛达成 |
| B31 /trade-ins、/:id/apply-offset | saleOrderId、recoveryId / 双方 expectedVersion、amountCents | 关联置换 / 原子折抵双方余额与唯一凭据 |
| B32 /trade-ins/:id/reverse-offset | offsetId、reason、双方版本 | 双方冲销，保留历史，不自动搬动实物 |
| B33 /finance/payments | counterparty、sourceDocument、amountCents、method、occurredAt | 采购 / 回收付款；付款额度按应付验证 |
| B34 /finance/entries/:id/reverse | reason、correctionRef 可选 | 受控冲销与相关余额重算；错误录入的账务纠正，不冒充真实退款 |
| B35 /attachments/upload-intents、/:id/complete | ownerEntityRef、purpose、mime、byteSize / 文件完整性 | 临时上传凭证 / 验证后可关联附件 |
| B36 /documents | entityRef、snapshotVersion、audience(customer/internal)、format | 生成安全输出结果 / 任务，不自动发给任何人 |

未明确的补充动作（如采购取消、报损、退供、普通价格调整）在对应任务先补入契约表和样本再实现，不允许用通用 PUT status 绕过业务。售后收款可采用 /service/orders/:id/payments 语义入口，复用同一资金服务；T01 冻结路径，不能由两端独立取名。

## 6. 标准错误码

| HTTP / code | 含义 | 客户端处理 |
|---|---|---|
| 400 VALIDATION_ERROR | 字段无效 / 金额不是整数分 | 字段附近提示，保留输入 |
| 401 AUTH_REQUIRED / SESSION_REVOKED | 登录失效 / 被撤权 | 清身份缓存，登录后重新取数据 |
| 403 PERMISSION_DENIED | 无该动作权限 | 说明需老板处理，不重试 |
| 404 ENTITY_NOT_FOUND | 不存在或不属于当前可见范围 | 返回列表，不泄露其他店实体是否存在 |
| 409 VERSION_CONFLICT | 对象已更新 | 展示最新摘要 / diff，用户确认后重新提交 |
| 409 STOCK_CONFLICT | 无足量 / 指定实物被占 | 提示具体行，换件 / 重新分配 |
| 409 IDEMPOTENCY_MISMATCH | 同 ID 不同动作 / 载荷 | 中止，记录诊断，不能自动换 ID 重复扣款 |
| 422 CHECKLIST_INCOMPLETE / SERIAL_MISMATCH | 交付材料不足 | 跳到对应核对项 |
| 422 BALANCE_EXCEEDED / OFFSET_EXCEEDED | 超收 / 超退 / 超折抵 | 刷新余额并更正金额 |
| 422 OWNERSHIP_INVALID / INSPECTION_REQUIRED | 非店有 / 未验机 | 展示回收 / 检测前置步骤 |
| 429 RATE_LIMITED | 请求过频 | 按响应等待提示，不批量重复写 |
| 503 SERVICE_UNAVAILABLE | 暂不可用 | 读可重试，写先查 operation |

网络超时本身无可信 HTTP code，必须进入“结果未知”。禁止所有失败统一 toast 后立即关闭表单。

## 7. 数据库一致性与幂等实施要求

Cloudflare 官方说明 D1 的 batch 中语句按顺序执行，某条失败会使整批中止 / 回滚；它覆盖的是该批次，并不自动保护批次之前的读取。详见[官方 D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)。

本方案的实现推导：

1. 每个关键写动作在同一业务服务构建事务批次；幂等记录、有效版本断言、条件更新、子记录、账 / 库事件和成功结果一起写入。
2. version 和余量校验必须在 SQL 条件、约束或触发器内完成；JS 中提前读取只用于友好提示。
3. 条件 UPDATE 影响 0 行并不天然是 SQL 错误。T04 必须设计能让断言失败主动中止整个批次的数据库机制，并测试“更新 0 行但后续流水不能继续插入”。
4. 唯一约束覆盖 requestId、有效逐件预留、有效整体交付、来源事件去重。数量预留和折抵用条件扣减 / 约束，保证非负和累计不超额。
5. 不使用 Worker 内存锁解决跨实例并发；不写依赖传统长连接 BEGIN / COMMIT 的伪事务；不得以“失败后再补几次 SQL”代替首版一致性。
6. 幂等键按门店 + requestId 唯一，记录动作、身份与载荷摘要。关键账务 / 库存成功凭据随单据保留，不能短时间过期后再次执行原动作。
7. 同 ID 同载荷返回原结果；同 ID 改载荷报冲突；不同 ID 重复交付仍由业务唯一约束拒绝。
8. 事务失败留下的业务副作用必须为零；可单独写脱敏失败诊断，但不能把失败审计误当成功账务。
9. 资金成功、上传失败等跨系统动作采用先上传验证后关联 / 查询恢复；对象存储不能与 D1 假装同一事务。清理孤立上传需明确保留期与引用检查。

T04 是进入真实库存 / 金额实现的强制前置关口。若本地 D1 行为无法满足方案，不可让低端模型把关键写操作改为前端串行凑合；须记录具体失败并调整实现设计。

## 8. 微信登录与绑定设计

电脑现有老板登录 → 生成有期限、一次使用的绑定码（建议 10 分钟，数据库存摘要、限尝试次数）→ 小程序取得微信登录 code 并提交 code / 绑定码 → 服务端校验微信身份与码 → 绑定到指定门店成员 → 返回本系统短期会话。

再次登录只提交新的微信 code，由后端确认已有绑定。openid 不是业务 token，微信身份没有绑定则显示待绑定；不由客户端传角色或 storeId 获权。AppSecret 与 session_key 仅后端持有，不下发、不写客户端 / 日志。

拟定接口：POST /auth/wechat/login（code、bindingCode 可选）；POST /auth/wechat/binding-codes（老板指定 memberId）；POST /auth/logout；GET /me。会话复用现有撤销 / token_version 机制前先测试适配，不能把小程序直接接到注册即老板的流程。

退出、撤权、解绑导致本地受限缓存清除；绑定码不写历史业务备注，不允许截图里长期暴露。小程序登录失败可重试获取新 code；不能重放用过的 code。

该流程是拟定方案。官方入口：[小程序登录](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/login.html)。本轮检索工具未能读取微信页面，T03 必须实际打开官方文档并核对 API、请求参数、基础库与错误；没有替用户注册或配置小程序。

## 9. 图片、扫码、导出与跨端同步

照片分型号示意 / 接修证据 / 回收证据 / 交付证据。默认单张客户端压缩后目标不超过 2MB、每单常规不超过 12 张，这是产品预算，不是微信平台上限。原图保留策略、账单和存储服务在 T16 确定。上传服务校验类型、大小、归属；外链不能随意由客户端指定。

扫码只获取编号候选，服务端查询身份和商品，不把二维码里的任意 URL 当可信业务链接自动打开。扫码取消不报错；无权限 / 重复 / 找不到 / 多匹配都有可继续入口；SN 可手输，普通文字 SN 不默认支持 OCR。

输出：电脑优先可靠 A4 打印 / PDF / 图片；小程序通过安全输出快照与服务端文件生成路径取得文件，按平台能力打开文档或保存图片。不能调用浏览器 html2canvas / window.print 作为小程序导出实现。文件生成可后置异步任务，但 UI 显示真实进度。

同步首版用进入页面、恢复前台、成功写入后重新读取，以及用户刷新；电脑前台可每 30 秒刷新只读待办，隐藏时停止。小程序首版不常驻轮询，不实现 WebSocket 全量协同编辑。所有正式提交都携带 version，读数延迟不得造成错误交易。

草稿按账号 / 门店 / 实体隔离，优先服务端草稿；本地只保存未提交部分与必要 requestId。登录退出清理；遇到他人新版本须展示冲突，不自动用本地旧稿覆盖。

官方复核入口：[网络能力](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)、[扫码](https://developers.weixin.qq.com/miniprogram/dev/api/device/scan/wx.scanCode.html)、[媒体选择](https://developers.weixin.qq.com/miniprogram/dev/api/media/video/wx.chooseMedia.html)、[分包](https://developers.weixin.qq.com/miniprogram/dev/framework/app-service/subpackages.html)。这些页面本轮未读取成功；包体上限、权限声明、域名配置和基础库支持必须在实施记录中重新验证。

## 10. 兼容、迁移与配置

- 未读实际结构前不根据“存在 0000–0005 文件”判断生产迁移已执行；历史回执显示过迁移追踪不一致，实施时重新核验，不能照旧回执补写 migration 表。
- 旧 source_item_id 指 hardware；旧 SN 的 current_customer 字段不能直接覆盖成永久所有权历史。建立映射、事件回填和只读归档策略。
- 前端旧 unitPrice 元 → 新 unitPriceCents 分由专门适配器做，非法 / 超精度 / 缺失标异常；不让同一字段随调用方变化单位。
- 旧直接改履约状态的写入口对迁入 v2 的单据必须禁止或调用同一动作服务；不能保留绕过交付库存校验的旁路。
- 开发 / 验收 / 生产分别配置 API 域名、D1、文件空间、小程序版本；日志只含诊断 ID 和脱敏摘要。
- 当前配置中的明文凭据需在建版本基线前移到环境密钥配置并由所有者安排轮换；不在本方案、Git diff、截图或测试样本复制值。
- 每次迁移只新增版本文件，有前置结构检查、数据映射报告和本地恢复演练。不得为了本地验证运行 deploy 或远程迁移。
