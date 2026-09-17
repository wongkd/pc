// AUTO-GENERATED FROM contracts/v1 — DO NOT EDIT
// 生成命令：node contracts/tools/generate-dto.mjs
// 来源：contracts/v1/objects.json；字段与 nullable 以契约为准。
import type {
  ContractId, Cents, Instant, CalendarDate, JsonValue, JsonObject,
  ActiveStatus,
  ItemType,
  TrackingMode,
  StockCondition,
  OwnershipType,
  LocationKind,
  StockBucket,
  QuoteStatus,
  SaleTradeState,
  SaleFulfillmentState,
  SaleKind,
  LineSource,
  ReservationStatus,
  BalanceDirection,
  RecoveryState,
  ServiceState,
  WarrantyDecision,
  InspectionResult,
  InspectionDisposition,
  ChecklistItemState,
  ChecklistResult,
  CashDirection,
  CashMethod,
  CashVerificationState,
  OffsetState,
  FinancialDisposition,
  PaymentPurpose,
  AttachmentPurpose,
  AttachmentUploadState,
  AttachmentVisibility,
  OperationStatus,
  DocumentAudience,
  DocumentFormat,
  EntityType,
  TaskCategory,
  InventoryMovementSource,
  ServicePartDisposition,
  CounterpartyKind,
  ActionCode,
} from './enums'

// 持久对象默认另含 CommonFields；正式事件类对象另含 EventFields 的相关子集。
// 生成器不自动合并这两组字段，避免把读模型也套上持久字段；是否需要由各端按使用场景显式组合。
export interface CommonFields {
  id: ContractId // 不透明字符串，客户端不得解析主键
  storeId: ContractId // 由后端身份派生，忽略客户端传值
  version: number // 非负整数，每次有效写入 +1
  createdAt: Instant
  updatedAt: Instant
  createdBy: ContractId // 成员 ID，不是用户邮箱
}

export interface EventFields {
  occurredAt: Instant // 实际业务发生时间，与预约时间分开
  recordedAt: Instant // 记录写入时间
  actorId: ContractId
  requestId: string
  sourceType: EntityType
  sourceId: ContractId | null
}

/** 型号 / 服务项目主数据 */
export interface Product {
  sku: string
  name: string
  category: string
  brand: string | null
  specs: string | null
  trackingMode: TrackingMode
  requiresSn: boolean
  status: ActiveStatus
  defaultSalePriceCents: Cents // 单位：分
  warrantyTemplate: JsonObject | null
}

/** 型号 × 位置的数量余额 */
export interface StockBalance {
  productId: ContractId
  locationId: ContractId
  availableQty: number
  reservedQty: number
  quarantineQty: number
  totalCostCents: Cents | null // 单位：分
  costKnown: boolean
}

/** 逐件实物 */
export interface StockItem {
  assetCode: string // 内部唯一编号；二手必有，即使没有厂商 SN
  productId: ContractId
  condition: StockCondition
  snRaw: string | null // 原始显示值，保留大小写与符号
  snNormalized: string | null // 规范化检索值
  ownership: OwnershipType
  availability: StockBucket
  location: LocationKind
  acquisitionRef: ContractId | null
  acquisitionCostCents: Cents | null // 单位：分
  refurbishmentCostCents: Cents | null // 单位：分
  costKnown: boolean
  inspectionRef: ContractId | null
  warrantySnapshot: JsonObject | null
}

/** 客户 / 卖方 */
export interface Customer {
  displayName: string
  phone: string | null
  contactNote: string | null
  remarkInternal: string | null
}

/** 客户设备 */
export interface CustomerDevice {
  ownerCustomerId: ContractId
  deviceCode: string
  originalOrderId: ContractId | null // 外店设备可无原订单
  currentConfigurationId: ContractId | null
  custodyLocation: LocationKind
  stockItemRef: ContractId | null
}

/** 报价聚合头 */
export interface Quote {
  customerId: ContractId | null
  title: string
  currentRevision: number
}

/** 报价版本，发出后不可覆盖 */
export interface QuoteVersion {
  quoteId: ContractId
  revision: number
  status: QuoteStatus
  validUntil: CalendarDate | null
  lines: JsonValue[]
  discountCents: Cents // 单位：分
  termsSnapshot: JsonObject
  issuedAt: Instant | null
}

/** 销售单 */
export interface SaleOrder {
  orderNo: string
  customerSnapshot: JsonObject
  quoteVersionId: ContractId | null
  kind: SaleKind
  tradeState: SaleTradeState
  fulfillmentState: SaleFulfillmentState
  dueAt: Instant | null
  configurationVersion: number
  totalCents: Cents // 单位：分
  adjustmentCents: Cents // 单位：分
  cashNetCents: Cents // 单位：分
  offsetNetCents: Cents // 单位：分
  balanceCents: Cents // 单位：分
  balanceDirection: BalanceDirection
}

/** 销售行 */
export interface SaleLine {
  productId: ContractId | null
  source: LineSource
  nameSnapshot: string
  qty: number
  unitPriceCents: Cents // 单位：分
  discountAllocationCents: Cents // 单位：分
  netLineCents: Cents // 单位：分
  warrantySnapshot: JsonObject | null
  customerDeviceRef: ContractId | null
}

/** 预留 / 占用 */
export interface Reservation {
  orderId: ContractId
  lineId: ContractId
  stockItemId: ContractId | null // 逐件占用时必填
  quantityBucketRef: string | null // 数量件占用时必填
  qty: number
  status: ReservationStatus
  reason: string | null
}

/** 采购单 */
export interface Purchase {
  supplierRef: ContractId | null
  supplierNote: string | null // 散采说明；不要求先在供应商模块建档
  purchaseLines: JsonValue[]
  orderedQty: number
  receivedQty: number
  cancelledQty: number
  expectedAt: Instant | null
}

/** 到货验收（一次到货一条） */
export interface Receipt {
  purchaseId: ContractId | null // 快速采购时可为 null
  quickPurchaseNote: string | null
  receiptLines: JsonValue[]
  unitCostCents: Cents | null // 单位：分
  inspectionDisposition: InspectionDisposition
  receivedAt: Instant
}

/** 库存流水 */
export interface InventoryMovement {
  productId: ContractId
  stockItemId: ContractId | null
  qty: number // 增量，可正可负
  fromBucket: StockBucket | null
  toBucket: StockBucket | null
  costCents: Cents | null // 单位：分
  source: InventoryMovementSource
  reversalOf: ContractId | null
}

/** 装机检查单（打包、外观、SN 核对等） */
export interface Checklist {
  entityRef: JsonObject
  templateVersion: string
  configurationVersion: number
  items: JsonValue[]
  result: ChecklistResult
  performedAt: Instant | null
  performedBy: ContractId | null
}

/** 检测记录（点亮、烤机等） */
export interface TestRecord {
  entityRef: JsonObject
  templateVersion: string
  configurationVersion: number
  items: JsonValue[]
  result: ChecklistResult
  performedAt: Instant | null
  performedBy: ContractId | null
}

/** 交付记录 */
export interface Delivery {
  orderId: ContractId
  configurationSnapshotId: ContractId
  deliveredAt: Instant
  receivedByNote: string | null
  financialDisposition: FinancialDisposition
  creditApprovalId: ContractId | null
}

/** 回收单 */
export interface Recovery {
  sellerRef: ContractId
  items: JsonValue[]
  initialEstimateCents: Cents | null // 单位：分
  offerVersion: number | null
  finalAcquisitionCents: Cents | null // 单位：分
  receivedAt: Instant | null
  acceptedAt: Instant | null
  confirmationEvidence: ContractId | null
  state: RecoveryState
}

/** 整备成本 */
export interface RefurbishmentCost {
  stockItemId: ContractId
  category: string
  amountCents: Cents // 单位：分
  capitalizable: boolean // 是否计入该件可归属成本
  paymentEntryRef: ContractId | null
  evidenceRef: ContractId | null
}

/** 维修工单 */
export interface ServiceOrder {
  customerId: ContractId | null
  deviceId: ContractId
  symptom: string // 客户描述，与内部诊断分开
  intakeSnapshot: JsonObject
  state: ServiceState
  proposalVersion: number | null
  confirmedChargeCents: Cents | null // 单位：分
  warrantyDecision: WarrantyDecision | null
  dueAt: Instant | null
}

/** 设备配置版本 */
export interface DeviceConfiguration {
  deviceId: ContractId
  revision: number
  components: JsonValue[]
  effectiveAt: Instant
  changeRef: ContractId | null
}

/** 换件 / 改配置事件 */
export interface DeviceChange {
  deviceId: ContractId
  fromRevision: number
  toRevision: number
  components: JsonValue[]
  effectiveAt: Instant
  changeRef: ContractId | null
}

/** 退货接收与贷项 */
export interface ReturnRecord {
  originalOrderId: ContractId
  lineAllocations: JsonValue[] // 原行 / 数量 / 实物分配
  stockItemIds: JsonValue[]
  reason: string
  acceptedQty: number
  creditCents: Cents // 单位：分
  refundEntryRef: ContractId | null
}

/** 现金退款 */
export interface Refund {
  originalOrderId: ContractId
  returnRef: ContractId | null
  adjustmentRef: ContractId | null
  amountCents: Cents // 单位：分
  method: CashMethod
  occurredAt: Instant
  reason: string
}

/** 资金流水 */
export interface CashEntry {
  direction: CashDirection
  amountCents: Cents // 单位：分
  method: CashMethod
  counterpartyRef: JsonObject
  counterpartyKind: CounterpartyKind
  allocation: JsonObject // 订单 / 采购 / 回收 / 维修分摊
  purpose: PaymentPurpose
  occurredAt: Instant
  verifiedAt: Instant | null
  verificationState: CashVerificationState
  reversalOf: ContractId | null
}

/** 置换折抵（非现金事件） */
export interface Offset {
  tradeInId: ContractId
  saleOrderId: ContractId
  recoveryId: ContractId
  amountCents: Cents // 单位：分
  state: OffsetState
  reversalOf: ContractId | null
}

/** 附件（照片 / 文件） */
export interface Attachment {
  ownerEntityRef: JsonObject
  purpose: AttachmentPurpose
  objectKey: string
  contentType: string
  byteSize: number
  width: number | null
  height: number | null
  sha256: string | null
  uploadState: AttachmentUploadState
  visibility: AttachmentVisibility
}

/** 关键动作的幂等与结果查询记录 */
export interface Operation {
  requestId: string
  actorId: ContractId
  storeId: ContractId
  action: ActionCode
  entityRef: JsonObject
  payloadHash: string
  status: OperationStatus
  resultRef: ContractId | null
  resultVersion: number | null
  errorCode: string | null
}

/** 审计事件 */
export interface AuditEvent {
  entityRef: JsonObject
  action: string
  beforeSummary: JsonObject | null
  afterSummary: JsonObject | null
  reason: string | null
  actorId: ContractId
  occurredAt: Instant
}

/** 微信身份绑定 */
export interface WechatIdentity {
  appId: string
  openid: string
  memberId: ContractId
  sessionVersion: number
  revokedAt: Instant | null
  lastSeenAt: Instant | null
}

/** 登录会话 */
export interface Session {
  memberId: ContractId
  sessionVersion: number
  issuedAt: Instant
  expiresAt: Instant
  revokedAt: Instant | null
}

/** 待办读模型，由业务单据派生，不另存一份可随意修改的任务状态 */
export interface TaskReadModel {
  taskId: ContractId
  entityType: EntityType
  entityId: ContractId
  entityVersion: number
  category: TaskCategory
  title: string
  customerDisplay: string | null
  deviceSummary: string | null
  photoKind: AttachmentPurpose | null
  photoUrl: string | null
  dueAt: Instant | null
  deadlineText: string | null
  blockerSummary: string | null
  amountSummary: JsonObject | null
  primaryAction: JsonObject
  detailTarget: string
}
