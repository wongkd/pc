// AUTO-GENERATED FROM contracts/v1.1 — DO NOT EDIT
// 生成命令：node contracts/tools/generate-dto.mjs
// 来源：contracts/v1.1/enums.json；取值唯一来源，两端不得各自新增。

export type ContractId = string
export type Cents = number
export type Instant = string
export type CalendarDate = string
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject
export interface JsonObject { [key: string]: JsonValue }

/** 通用启停状态，对应现有 0001/0002 迁移的 CHECK 约束 */
export const ActiveStatus = {
  ACTIVE: "active",
  DISABLED: "disabled",
} as const
export type ActiveStatus = (typeof ActiveStatus)[keyof typeof ActiveStatus]
export const ActiveStatusValues: readonly ActiveStatus[] = Object.values(ActiveStatus)

/** 商品或服务行；服务行不可序列化、不可采购、不占库存 */
export const ItemType = {
  PRODUCT: "product",
  SERVICE: "service",
} as const
export type ItemType = (typeof ItemType)[keyof typeof ItemType]
export const ItemTypeValues: readonly ItemType[] = Object.values(ItemType)

/** 型号是否逐件管理是商品属性；二手一律 item，新品按商品决定 */
export const TrackingMode = {
  QUANTITY: "quantity",
  ITEM: "item",
} as const
export type TrackingMode = (typeof TrackingMode)[keyof typeof TrackingMode]
export const TrackingModeValues: readonly TrackingMode[] = Object.values(TrackingMode)

/** 成色。used 必须有内部唯一编号；无厂商 SN 的二手同样有内部编号 */
export const StockCondition = {
  NEW: "new",
  USED: "used",
} as const
export type StockCondition = (typeof StockCondition)[keyof typeof StockCondition]
export const StockConditionValues: readonly StockCondition[] = Object.values(StockCondition)

/** 逐件成色等级（B30 上架门槛七项之一，B30 契约修订补入）：全新 / 95新 / 9成新 / 8成新 / 7成新及以下。与 StockCondition（new/used 粗分）并存 —— 后者是入库分类，本枚举是会写进顾客报价单的细分成色，两者不是同一件事 */
export const ConditionGrade = {
  BRAND_NEW: "brand_new",
  LIKE_NEW: "like_new",
  EXCELLENT: "excellent",
  GOOD: "good",
  FAIR: "fair",
} as const
export type ConditionGrade = (typeof ConditionGrade)[keyof typeof ConditionGrade]
export const ConditionGradeValues: readonly ConditionGrade[] = Object.values(ConditionGrade)

/** 所有权。客户暂存、客供、送修均不属于可卖库存；外送自有维修件仍为 store，位置为 external */
export const OwnershipType = {
  STORE: "store",
  CUSTOMER: "customer",
  VENDOR: "vendor",
} as const
export type OwnershipType = (typeof OwnershipType)[keyof typeof OwnershipType]
export const OwnershipTypeValues: readonly OwnershipType[] = Object.values(OwnershipType)

/** 实物位置。位置与所有权、可用性分别记录，不能互相推断 */
export const LocationKind = {
  STORE: "store",
  CUSTOMER: "customer",
  EXTERNAL: "external",
  SUPPLIER: "supplier",
} as const
export type LocationKind = (typeof LocationKind)[keyof typeof LocationKind]
export const LocationKindValues: readonly LocationKind[] = Object.values(LocationKind)

/** 自有在库量 = available + reserved + quarantine，三类互斥；in_transit 不算在库；customer_custody 为他人财产另列；retired 含报废与退供后离店 */
export const StockBucket = {
  AVAILABLE: "available",
  RESERVED: "reserved",
  QUARANTINE: "quarantine",
  IN_TRANSIT: "in_transit",
  CUSTOMER_CUSTODY: "customer_custody",
  SOLD: "sold",
  RETIRED: "retired",
} as const
export type StockBucket = (typeof StockBucket)[keyof typeof StockBucket]
export const StockBucketValues: readonly StockBucket[] = Object.values(StockBucket)

/** 报价状态。发出后修改形成新版本，不覆盖原客户版本。confirmed 表示顾客已确认该版本：确认 ≠ 付款、确认不锁库存（R12）；确认后本版本不可再改，要改必须出新版本重新发出并重新确认（R10） */
export const QuoteStatus = {
  DRAFT: "draft",
  ISSUED: "issued",
  CONFIRMED: "confirmed",
  CONVERTED: "converted",
  EXPIRED: "expired",
  CLOSED: "closed",
} as const
export type QuoteStatus = (typeof QuoteStatus)[keyof typeof QuoteStatus]
export const QuoteStatusValues: readonly QuoteStatus[] = Object.values(QuoteStatus)

/** 销售单交易状态。支付状态不在此枚举，由流水与余额计算 */
export const SaleTradeState = {
  DRAFT: "draft",
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
  CLOSED: "closed",
} as const
export type SaleTradeState = (typeof SaleTradeState)[keyof typeof SaleTradeState]
export const SaleTradeStateValues: readonly SaleTradeState[] = Object.values(SaleTradeState)

/** 履约状态。ready_delivery 表示已到交付处理阶段，不表示已满足全部交付闸门 */
export const SaleFulfillmentState = {
  WAITING_STOCK: "waiting_stock",
  PREPARING: "preparing",
  TESTING: "testing",
  READY_DELIVERY: "ready_delivery",
  DELIVERED: "delivered",
} as const
export type SaleFulfillmentState = (typeof SaleFulfillmentState)[keyof typeof SaleFulfillmentState]
export const SaleFulfillmentStateValues: readonly SaleFulfillmentState[] = Object.values(SaleFulfillmentState)

/** 装机或零售。零售直接进入 ready_delivery，不要求装机与烤机，但走同一交付动作 */
export const SaleKind = {
  ASSEMBLY: "assembly",
  RETAIL: "retail",
} as const
export type SaleKind = (typeof SaleKind)[keyof typeof SaleKind]
export const SaleKindValues: readonly SaleKind[] = Object.values(SaleKind)

/** 销售行来源。new/used 成交时需商品映射；used 必须指定具体实物；customer 为客户自带件，默认售价与成本为 0；service 为服务费行 */
export const LineSource = {
  NEW: "new",
  USED: "used",
  CUSTOMER: "customer",
  SERVICE: "service",
} as const
export type LineSource = (typeof LineSource)[keyof typeof LineSource]
export const LineSourceValues: readonly LineSource[] = Object.values(LineSource)

/** 占位状态。同一逐件实物同一时刻最多一条 active；数量件累计不得超过可用量。历史占用保留不删除 */
export const ReservationStatus = {
  ACTIVE: "active",
  RELEASED: "released",
  CONSUMED: "consumed",
} as const
export type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus]
export const ReservationStatusValues: readonly ReservationStatus[] = Object.values(ReservationStatus)

/** 余额方向。大于 0 为客户待付，等于 0 为结清，小于 0 为门店待退；界面不得显示为负尾款 */
export const BalanceDirection = {
  CLIENT_DUE: "client_due",
  SETTLED: "settled",
  STORE_DUE: "store_due",
} as const
export type BalanceDirection = (typeof BalanceDirection)[keyof typeof BalanceDirection]
export const BalanceDirectionValues: readonly BalanceDirection[] = Object.values(BalanceDirection)

/** 回收单主状态。所有权仅在 acquired 且接收确认完成时转为门店，不能由「已付款」推断；disassembled 为拆件完成态（B44），拆出零件各走待检判定 */
export const RecoveryState = {
  DRAFT: "draft",
  RECEIVED_FOR_INSPECTION: "received_for_inspection",
  INSPECTING: "inspecting",
  OFFERED: "offered",
  ACQUIRED: "acquired",
  DISASSEMBLED: "disassembled",
  REFURBISHING: "refurbishing",
  READY_FOR_SALE: "ready_for_sale",
  RETURN_PENDING: "return_pending",
  RETURNED: "returned",
} as const
export type RecoveryState = (typeof RecoveryState)[keyof typeof RecoveryState]
export const RecoveryStateValues: readonly RecoveryState[] = Object.values(RecoveryState)

/** 维修工单状态。接修无原销售单也可成立；取消后不能让设备凭空消失 */
export const ServiceState = {
  RECEIVED: "received",
  DIAGNOSING: "diagnosing",
  AWAITING_APPROVAL: "awaiting_approval",
  REPAIRING: "repairing",
  OUTSOURCED: "outsourced",
  RETESTING: "retesting",
  READY_RETURN: "ready_return",
  RETURNED: "returned",
  CLOSED: "closed",
} as const
export type ServiceState = (typeof ServiceState)[keyof typeof ServiceState]
export const ServiceStateValues: readonly ServiceState[] = Object.values(ServiceState)

/** 维修质保判定的人工结论，不由系统自动判定；日期只提供线索 */
export const WarrantyDecision = {
  IN_WARRANTY: "in_warranty",
  OUT_OF_WARRANTY: "out_of_warranty",
  UNDETERMINED: "undetermined",
} as const
export type WarrantyDecision = (typeof WarrantyDecision)[keyof typeof WarrantyDecision]
export const WarrantyDecisionValues: readonly WarrantyDecision[] = Object.values(WarrantyDecision)

/** 本店对整备上架件承诺的质保月数（B30 上架门槛七项之一，B30 契约修订补入）。值是月数的字符串形式，便于与「质保至 YYYY-MM-DD」互算；不由系统自动判定，与 WarrantyDecision（维修时的质保判定）不是同一件事 */
export const WarrantyTerm = {
  3: "3",
  6: "6",
  12: "12",
  24: "24",
} as const
export type WarrantyTerm = (typeof WarrantyTerm)[keyof typeof WarrantyTerm]
export const WarrantyTermValues: readonly WarrantyTerm[] = Object.values(WarrantyTerm)

/** 客户确认维修方案的方式。记录的是真实联系渠道，不由系统判定（E10 契约修订补入，B22 引用） */
export const ConfirmationMethod = {
  PHONE: "phone",
  WECHAT: "wechat",
  IN_PERSON: "in_person",
  OTHER: "other",
} as const
export type ConfirmationMethod = (typeof ConfirmationMethod)[keyof typeof ConfirmationMethod]
export const ConfirmationMethodValues: readonly ConfirmationMethod[] = Object.values(ConfirmationMethod)

/** 待检件的检测结论 */
export const InspectionResult = {
  PASS: "pass",
  FAIL: "fail",
} as const
export type InspectionResult = (typeof InspectionResult)[keyof typeof InspectionResult]
export const InspectionResultValues: readonly InspectionResult[] = Object.values(InspectionResult)

/** 待检通过后的处置去向。进入 available 才可卖 */
export const InspectionDisposition = {
  AVAILABLE: "available",
  QUARANTINE: "quarantine",
  RETURN_TO_SUPPLIER: "return_to_supplier",
  RETURN_TO_CUSTOMER: "return_to_customer",
  SCRAPPED: "scrapped",
} as const
export type InspectionDisposition = (typeof InspectionDisposition)[keyof typeof InspectionDisposition]
export const InspectionDispositionValues: readonly InspectionDisposition[] = Object.values(InspectionDisposition)

/** 检查项事实记录。checkbox 是已完成事实的记录，不能代替真正测试 */
export const ChecklistItemState = {
  PENDING: "pending",
  PASS: "pass",
  FAIL: "fail",
} as const
export type ChecklistItemState = (typeof ChecklistItemState)[keyof typeof ChecklistItemState]
export const ChecklistItemStateValues: readonly ChecklistItemState[] = Object.values(ChecklistItemState)

/** 整单检查结论，由检查项派生 */
export const ChecklistResult = {
  INCOMPLETE: "incomplete",
  PASSED: "passed",
  FAILED: "failed",
} as const
export type ChecklistResult = (typeof ChecklistResult)[keyof typeof ChecklistResult]
export const ChecklistResultValues: readonly ChecklistResult[] = Object.values(ChecklistResult)

/** 资金方向。一笔实际资金一条记录 */
export const CashDirection = {
  IN: "in",
  OUT: "out",
} as const
export type CashDirection = (typeof CashDirection)[keyof typeof CashDirection]
export const CashDirectionValues: readonly CashDirection[] = Object.values(CashDirection)

/** 人工登记方式，不代表支付平台确认到账 */
export const CashMethod = {
  CASH: "cash",
  WECHAT: "wechat",
  ALIPAY: "alipay",
  BANK: "bank",
  OTHER: "other",
} as const
export type CashMethod = (typeof CashMethod)[keyof typeof CashMethod]
export const CashMethodValues: readonly CashMethod[] = Object.values(CashMethod)

/** 登记微信 / 支付宝收款后的人工对账标记 */
export const CashVerificationState = {
  UNVERIFIED: "unverified",
  VERIFIED: "verified",
} as const
export type CashVerificationState = (typeof CashVerificationState)[keyof typeof CashVerificationState]
export const CashVerificationStateValues: readonly CashVerificationState[] = Object.values(CashVerificationState)

/** 折抵状态。撤销折抵不自动归还实物 */
export const OffsetState = {
  APPLIED: "applied",
  REVERSED: "reversed",
} as const
export type OffsetState = (typeof OffsetState)[keyof typeof OffsetState]
export const OffsetStateValues: readonly OffsetState[] = Object.values(OffsetState)

/** 交付时的资金处置：结清，或老板明确批准欠款交付。缺陷单不能用第三个值绕过 */
export const FinancialDisposition = {
  SETTLED_IN_FULL: "settled_in_full",
  CREDIT_APPROVED: "credit_approved",
} as const
export type FinancialDisposition = (typeof FinancialDisposition)[keyof typeof FinancialDisposition]
export const FinancialDispositionValues: readonly FinancialDisposition[] = Object.values(FinancialDisposition)

/** 退货贷项的审批状态。退货登记后为 pending（待老板审批），经 B43 批准转为 approved 才计入应退；B18 现金退款只能对 approved 贷项执行 */
export const CreditState = {
  PENDING: "pending",
  APPROVED: "approved",
} as const
export type CreditState = (typeof CreditState)[keyof typeof CreditState]
export const CreditStateValues: readonly CreditState[] = Object.values(CreditState)

/** 付款 / 收款项对应的业务来源类型 */
export const PaymentPurpose = {
  SALE_ORDER: "sale_order",
  SERVICE_ORDER: "service_order",
  PURCHASE: "purchase",
  RECOVERY: "recovery",
} as const
export type PaymentPurpose = (typeof PaymentPurpose)[keyof typeof PaymentPurpose]
export const PaymentPurposeValues: readonly PaymentPurpose[] = Object.values(PaymentPurpose)

/** 附件用途：型号示意、接修证据、回收证据、交付证据、生成的单据文件 */
export const AttachmentPurpose = {
  PRODUCT_REFERENCE: "product_reference",
  SERVICE_INTAKE: "service_intake",
  RECOVERY_EVIDENCE: "recovery_evidence",
  DELIVERY_EVIDENCE: "delivery_evidence",
  DOCUMENT_EXPORT: "document_export",
} as const
export type AttachmentPurpose = (typeof AttachmentPurpose)[keyof typeof AttachmentPurpose]
export const AttachmentPurposeValues: readonly AttachmentPurpose[] = Object.values(AttachmentPurpose)

/** 上传状态。业务记录只能关联 attached；孤立上传按保留期清理 */
export const AttachmentUploadState = {
  PENDING: "pending",
  UPLOADED: "uploaded",
  ATTACHED: "attached",
  FAILED: "failed",
  ORPHANED: "orphaned",
} as const
export type AttachmentUploadState = (typeof AttachmentUploadState)[keyof typeof AttachmentUploadState]
export const AttachmentUploadStateValues: readonly AttachmentUploadState[] = Object.values(AttachmentUploadState)

/** 可见范围，与客户输出白名单配合 */
export const AttachmentVisibility = {
  INTERNAL: "internal",
  CUSTOMER_SHARED: "customer_shared",
} as const
export type AttachmentVisibility = (typeof AttachmentVisibility)[keyof typeof AttachmentVisibility]
export const AttachmentVisibilityValues: readonly AttachmentVisibility[] = Object.values(AttachmentVisibility)

/** 关键动作的幂等与结果查询状态；不是客户端内存标志 */
export const OperationStatus = {
  PENDING: "pending",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
} as const
export type OperationStatus = (typeof OperationStatus)[keyof typeof OperationStatus]
export const OperationStatusValues: readonly OperationStatus[] = Object.values(OperationStatus)

/** 输出对象。customer 走白名单字段，internal 才可含成本与内部备注 */
export const DocumentAudience = {
  CUSTOMER: "customer",
  INTERNAL: "internal",
} as const
export type DocumentAudience = (typeof DocumentAudience)[keyof typeof DocumentAudience]
export const DocumentAudienceValues: readonly DocumentAudience[] = Object.values(DocumentAudience)

/** 输出格式；小程序不依赖 DOM 库生成 */
export const DocumentFormat = {
  PDF: "pdf",
  HTML: "html",
  IMAGE: "image",
} as const
export type DocumentFormat = (typeof DocumentFormat)[keyof typeof DocumentFormat]
export const DocumentFormatValues: readonly DocumentFormat[] = Object.values(DocumentFormat)

/** 待办主键 entityType + entityId 的第一段。维修与回收不得伪造 sale_order */
export const EntityType = {
  SALE_ORDER: "sale_order",
  QUOTE: "quote",
  PURCHASE_ORDER: "purchase_order",
  STOCK_ITEM: "stock_item",
  SERVICE_ORDER: "service_order",
  RECOVERY_ORDER: "recovery_order",
  TRADE_IN: "trade_in",
  CUSTOMER: "customer",
  CUSTOMER_DEVICE: "customer_device",
  DELIVERY: "delivery",
  MEMBER: "member",
} as const
export type EntityType = (typeof EntityType)[keyof typeof EntityType]
export const EntityTypeValues: readonly EntityType[] = Object.values(EntityType)

/** 待办类别。卡点优先于后续动作，一个单据默认只有一条当前主待办；新增类别必须先改本契约 */
export const TaskCategory = {
  DELIVERY: "delivery",
  STOCK_SHORTAGE: "stock_shortage",
  SERVICE: "service",
  RECOVERY: "recovery",
  COLLECTION: "collection",
} as const
export type TaskCategory = (typeof TaskCategory)[keyof typeof TaskCategory]
export const TaskCategoryValues: readonly TaskCategory[] = Object.values(TaskCategory)

/** 每个库存副作用的唯一来源标识。conversion 对应整机拆件（B44，2026-09-21 E10 起启用）；inspection_release 对应待检件判定通过放回可卖（B19）；未列出的来源必须先补契约再实现 */
export const InventoryMovementSource = {
  PURCHASE_RECEIPT: "purchase_receipt",
  QUICK_PURCHASE: "quick_purchase",
  OPENING_BALANCE: "opening_balance",
  RECOVERY_ACQUISITION: "recovery_acquisition",
  RESERVATION: "reservation",
  UNRESERVATION: "unreservation",
  ASSEMBLY_PICK: "assembly_pick",
  DELIVERY: "delivery",
  RETURN_RECEIPT: "return_receipt",
  SERVICE_PART_CONSUMPTION: "service_part_consumption",
  SCRAP: "scrap",
  SUPPLIER_RETURN: "supplier_return",
  COUNT_ADJUSTMENT: "count_adjustment",
  CONVERSION: "conversion",
  INSPECTION_QUARANTINE: "inspection_quarantine",
  INSPECTION_RELEASE: "inspection_release",
} as const
export type InventoryMovementSource = (typeof InventoryMovementSource)[keyof typeof InventoryMovementSource]
export const InventoryMovementSourceValues: readonly InventoryMovementSource[] = Object.values(InventoryMovementSource)

/** 换下旧件的去向。旧件待检测不等于已收购，也不默认变为店有二手库存 */
export const ServicePartDisposition = {
  RETURN_TO_CUSTOMER: "return_to_customer",
  SUPPLIER_RETURN: "supplier_return",
  SCRAPPED: "scrapped",
  ACQUIRED: "acquired",
} as const
export type ServicePartDisposition = (typeof ServicePartDisposition)[keyof typeof ServicePartDisposition]
export const ServicePartDispositionValues: readonly ServicePartDisposition[] = Object.values(ServicePartDisposition)

/** 资金往来主体类型；双方当前交易主体须相同，不同主体代付首版不支持 */
export const CounterpartyKind = {
  CUSTOMER: "customer",
  SUPPLIER: "supplier",
  STAFF: "staff",
  OTHER: "other",
} as const
export type CounterpartyKind = (typeof CounterpartyKind)[keyof typeof CounterpartyKind]
export const CounterpartyKindValues: readonly CounterpartyKind[] = Object.values(CounterpartyKind)

/** 动作编号语义见 04 §5；路径、请求与响应结构、权限映射由 T01b 冻结。补充动作（采购取消、报损、退供、价格调整、盘点等）由对应任务先补入本枚举再实现。B42（记录顾客确认）为 2026-09-19 E05b 契约修订新增；B38（退供）为 2026-09-21 E07 契约修订由 supplementaryActions 提升为正式动作，路径 /inventory/supplier-returns、权限 inventory/supplier-return。B37（取消采购）为 2026-09-22 F3 契约修订由 supplementaryActions 的 reserved 提升为正式动作，路径 /inventory/purchases/:id/cancel、权限 inventory/purchase-cancel；B39（报损）、B40（价格调整）仍在 supplementaryActions 保持 reserved；B43（批准退货贷项）为 2026-09-21 E09 契约修订新增，路径 /sales/returns/:id/approve-credit、权限 sales/refund。B41（售后收款）为 2026-09-21 E10 契约修订由 supplementaryActions 的 specified 提升为正式动作，路径 /service/orders/:id/payments、权限 service/charge，复用 B08 资金字段（method 用 CashMethod 枚举）；B44（拆件入库）为 2026-09-21 E10 契约修订新增，路径 /recovery/orders/:id/teardown、权限 recovery/edit；B45（清理未发出报价草稿）、B46（清理未引用商品档案）为 2026-09-26 v1.1 契约修订新增，权限 store/manage。 */
export const ActionCode = {
  B01: "B01",
  B02: "B02",
  B03: "B03",
  B04: "B04",
  B05: "B05",
  B06: "B06",
  B07: "B07",
  B08: "B08",
  B09: "B09",
  B10: "B10",
  B11: "B11",
  B12: "B12",
  B13: "B13",
  B14: "B14",
  B15: "B15",
  B16: "B16",
  B17: "B17",
  B18: "B18",
  B19: "B19",
  B20: "B20",
  B21: "B21",
  B22: "B22",
  B23: "B23",
  B24: "B24",
  B25: "B25",
  B26: "B26",
  B27: "B27",
  B28: "B28",
  B29: "B29",
  B30: "B30",
  B31: "B31",
  B32: "B32",
  B33: "B33",
  B34: "B34",
  B35: "B35",
  B36: "B36",
  B37: "B37",
  B38: "B38",
  B41: "B41",
  B42: "B42",
  B43: "B43",
  B44: "B44",
  B45: "B45",
  B46: "B46",
} as const
export type ActionCode = (typeof ActionCode)[keyof typeof ActionCode]
export const ActionCodeValues: readonly ActionCode[] = Object.values(ActionCode)

/** 顾客微信身份的认领状态：unclaimed=已建立微信身份但未关联门店客户档案；claimed=已关联；rejected=认领被驳回（验证手机号不匹配或店员否决）。 */
export const CustomerClaimStatus = {
  UNCLAIMED: "unclaimed",
  CLAIMED: "claimed",
  REJECTED: "rejected",
} as const
export type CustomerClaimStatus = (typeof CustomerClaimStatus)[keyof typeof CustomerClaimStatus]
export const CustomerClaimStatusValues: readonly CustomerClaimStatus[] = Object.values(CustomerClaimStatus)

/** 旧客户档案的认领方式。wechat-phone=以微信 getPhoneNumber 返回的已验证手机号匹配；clerk-confirm=店员在 ERP 人工确认关联。刻意不含「顾客自填手机号」—— 自填号码可冒领他人档案。 */
export const CustomerClaimMethod = {
  WECHAT_PHONE: "wechat-phone",
  CLERK_CONFIRM: "clerk-confirm",
} as const
export type CustomerClaimMethod = (typeof CustomerClaimMethod)[keyof typeof CustomerClaimMethod]
export const CustomerClaimMethodValues: readonly CustomerClaimMethod[] = Object.values(CustomerClaimMethod)

/** 员工记录客户首次来源渠道；为空表示未记录，不影响建档、报价或交易。 */
export const CustomerSourceChannel = {
  WALK_IN: "walk_in",
  PHONE: "phone",
  WECHAT: "wechat",
  REFERRAL: "referral",
  MINI_PROGRAM: "mini_program",
  OTHER: "other",
} as const
export type CustomerSourceChannel = (typeof CustomerSourceChannel)[keyof typeof CustomerSourceChannel]
export const CustomerSourceChannelValues: readonly CustomerSourceChannel[] = Object.values(CustomerSourceChannel)

// ── 状态机（取值与转换均由契约冻结；守卫文案仅供展示，程序分支依据 from/to/action）──
export interface StateTransition {
  from: string
  to: string
  action: string | null
  guard: string
}
export const STATE_MACHINES: Record<string, { initial: string; transitions: StateTransition[] }> = {
  "QuoteStatus": {
    initial: "draft",
    transitions: [
      { from: "draft", to: "issued", action: "B02", guard: "完整配置与条款" },
      { from: "issued", to: "issued", action: "B02", guard: "发出后修改形成新版本，不覆盖原客户版本" },
      { from: "issued", to: "confirmed", action: "B42", guard: "顾客确认当前已发出且未过期的版本；确认后本版本不可再改，要改必须出新版本重新发出并重新确认" },
      { from: "issued", to: "converted", action: "B03", guard: "成交时固化 quoteVersion 到销售单" },
      { from: "confirmed", to: "converted", action: "B03", guard: "已确认版本成交同样固化 quoteVersion 到销售单（2026-09-21 E06 补：E05b 新增 confirmed 态时未同步这条出口，而「顾客确认后成交」是主路径）" },
      { from: "issued", to: "expired", action: null, guard: "超过 validUntil" },
      { from: "draft", to: "closed", action: null, guard: "未在本方案中明确，实现前须补" },
      { from: "issued", to: "closed", action: null, guard: "未在本方案中明确，实现前须补" },
    ]
  },
  "SaleTradeState": {
    initial: "draft",
    transitions: [
      { from: "draft", to: "confirmed", action: "B03|B05", guard: "商品行映射、最终价格与质保、客户承诺完整；指定二手件冲突则整次失败" },
      { from: "confirmed", to: "confirmed", action: "B05", guard: "补分配缺件不改变交易状态" },
      { from: "draft", to: "cancelled", action: "B11", guard: "未交付，说明原因" },
      { from: "confirmed", to: "cancelled", action: "B11", guard: "未交付，释放占用；预收转为应退，不自动现金退款" },
      { from: "confirmed", to: "closed", action: null, guard: "03 未明确 closed 进入条件，实现前须补契约" },
    ]
  },
  "SaleFulfillmentState": {
    initial: "waiting_stock",
    transitions: [
      { from: "waiting_stock", to: "preparing", action: "B06", guard: "所需店有件已预留，客供件已接收" },
      { from: "waiting_stock", to: "ready_delivery", action: "B07", guard: "零售单跳过装机与检测；按商品要求记录 SN 与质保" },
      { from: "preparing", to: "testing", action: "B06", guard: "备料完成后提交检测" },
      { from: "testing", to: "ready_delivery", action: "B07", guard: "检测通过；附件打包等收尾项仍可待办" },
      { from: "testing", to: "waiting_stock", action: "B07", guard: "检测不通过：隔离故障件、释放该件预留并重新形成缺口" },
      { from: "ready_delivery", to: "delivered", action: "B10", guard: "全部交付闸门同时满足" },
    ]
  },
  "RecoveryState": {
    initial: "draft",
    transitions: [
      { from: "draft", to: "received_for_inspection", action: "B26", guard: "登记卖方、实物与暂存事实" },
      { from: "received_for_inspection", to: "inspecting", action: "B27", guard: "开始验机" },
      { from: "inspecting", to: "offered", action: "B27", guard: "形成估价版本，不改变所有权" },
      { from: "inspecting", to: "return_pending", action: "B29", guard: "谈不成，准备归还" },
      { from: "offered", to: "acquired", action: "B28", guard: "最终价、验机结论、双方确认与接收事实齐备；原子取得所有权" },
      { from: "offered", to: "return_pending", action: "B29", guard: "客户放弃出售" },
      { from: "acquired", to: "disassembled", action: "B44", guard: "整机拆件入库：源件退役、产出件新建待检、损耗单列报废（不整机转卖）" },
      { from: "acquired", to: "refurbishing", action: "B30", guard: "需要整备（仅对拆出的单件）" },
      { from: "acquired", to: "ready_for_sale", action: "B30", guard: "无需整备时直接补齐上架门槛" },
      { from: "refurbishing", to: "ready_for_sale", action: "B30", guard: "逐件编号、成色、检测、成本、披露、标价、质保齐备" },
      { from: "return_pending", to: "returned", action: "B29", guard: "归还附件与实物确认，不产生采购成本与可卖库存" },
    ]
  },
  "ServiceState": {
    initial: "received",
    transitions: [
      { from: "received", to: "diagnosing", action: "B21", guard: "开始检测" },
      { from: "diagnosing", to: "awaiting_approval", action: "B21", guard: "形成方案版本并等待客户确认" },
      { from: "awaiting_approval", to: "repairing", action: "B22", guard: "客户确认方案后领用收费配件" },
      { from: "awaiting_approval", to: "outsourced", action: "B24", guard: "外送或返厂" },
      { from: "awaiting_approval", to: "ready_return", action: "B22", guard: "无需维修或客户拒绝，费用按已确认检测约定处理" },
      { from: "repairing", to: "retesting", action: "B23", guard: "换件完成，记录旧件去向" },
      { from: "outsourced", to: "retesting", action: "B24", guard: "外送件返回待复测；寄出不等于已归还客户" },
      { from: "retesting", to: "ready_return", action: "B25", guard: "复测通过且费用结清或有有效欠款批准" },
      { from: "ready_return", to: "returned", action: "B25", guard: "记录实际归还人与时间" },
      { from: "returned", to: "closed", action: null, guard: "未在本方案中明确，实现前须补" },
    ]
  },
  "AttachmentUploadState": {
    initial: "pending",
    transitions: [
      { from: "pending", to: "uploaded", action: "B35", guard: "字节已写入存储，服务端实算 sha256 与真实 mime 校验通过" },
      { from: "pending", to: "failed", action: "B35", guard: "上传中断或校验不通过（声明与实际不符）；保留失败原因，不占有效存储" },
      { from: "uploaded", to: "attached", action: "B35", guard: "完成确认时归属实体校验通过且属于同店，业务记录才可引用" },
      { from: "pending", to: "orphaned", action: null, guard: "超过保留期仍未完成上传，等待清理" },
      { from: "uploaded", to: "orphaned", action: null, guard: "超过保留期仍未关联任何业务实体，等待清理" },
    ]
  },
}

// ── 库存桶规则（自有在库 = available + reserved + quarantine）──
export const OWN_ON_HAND_BUCKETS: readonly StockBucket[] = ["available","reserved","quarantine"]
export const EXCLUDED_BUCKETS: readonly StockBucket[] = ["in_transit","customer_custody","sold","retired"]

// ── 待补枚举（尚未定义取值，实现对应任务前必须先补契约）──
export const PENDING_ENUM_NAMES: readonly string[] = ["CountState","StockAdjustmentReason","PurchaseCancelReason","PriceAdjustmentReason","TradeInState"]
