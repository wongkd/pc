/**
 * /api/v2 销售单路由（E06）。
 *
 * 为什么单独成文件（与 `routes/inventory-v2.ts`、`routes/quote-v2.ts` 同一理由）：
 * `validate-contracts.mjs` 第 10.6 节会把 `src/index.ts` 里所有 `'xx/yy'` 形态的字面量
 * 当成旧权限码，要求它们全部出现在 legacyPermissionMap 里。本文件里的新码
 * （`sales/order-view` / `sales/order-edit` / `sales/order-payment`）写进入口会让
 * 契约校验直接变红，所以整条链路留在本文件，入口只保留分发行。
 *
 * 承接的契约条目（前缀 /api/v2 由 conventions.api 声明）：
 *   · B03  POST /sales/quotes/:id/convert     权限 sales/quote-convert —— 报价转销售单
 *   · B04  POST /sales/orders                 权限 sales/order-edit    —— 创建零售与直接销售单
 *   · B05  POST /sales/orders/:id/confirm     权限 sales/order-edit    —— 确认成交（含预留）
 *   · B05  POST /sales/orders/:id/allocate    权限 sales/order-edit    —— 补分配缺口
 *   · B06  POST /sales/orders/:id/start-assembly 权限 sales/order-assembly —— 开始备料与装机
 *   · B07  POST /sales/orders/:id/checks      权限 sales/order-assembly —— 保存装机检测结果
 *   · B08  POST /sales/orders/:id/payments    权限 sales/order-payment —— 登记销售收款
 *   · B10  POST /sales/orders/:id/deliver     权限 sales/order-deliver —— 确认交付
 *   · R04  GET  /sales/orders                 权限 sales/order-view    —— 销售单列表
 *   · R04  GET  /sales/orders/:id             权限 sales/order-view    —— 销售单详情
 *          （详情里附带 fulfillment 装配看板：R04 的 result 本就是「完整处理视图」，
 *            uiRefs 含「办理交付」，装机检测与交付的事实随详情一起返回）
 *
 * ⚠️ 本模块必须排在 `quote-v2.ts` **之后**被调用：
 *      B03 的路径（/sales/quotes/:id/convert）与报价路由同前缀，但报价模块只认领
 *      `/sales/quotes`（精确）、`/sales/quotes/:id`（详情）与 save / issue / confirm 三条子路径，
 *      convert 不在其中 —— 它返回 null 后落到本模块。
 *      「报价详情」的正则不含斜杠，所以不会被它误吞。
 *
 * 本模块不做的事：
 *   · 不实现 B09（批准欠款交付）—— 属 E09 取消退款与账本那一刀；B10 收到欠款批准引用时明确拒绝；
 *   · 不实现 B11 取消、B17 退货、B18 退款 —— 各自属后续卡；
 *   · 不碰旧 /api/orders（旧订单页继续跑在旧链路）。
 */

import {
  QUOTE_PERMISSIONS,
  SALE_PERMISSIONS,
  grants,
  type PermissionHolder,
} from '../domains/access'
import { findErrorDefinition } from '../generated/error-codes'
import { appendReadableDiagnostic } from '../domains/operations'
import {
  CASH_METHODS,
  SALE_TRADE_STATES,
  approveCreditDelivery,
  approveReturnCredit,
  cancelSaleOrder,
  convertQuoteToOrder,
  querySaleOrderDetail,
  querySaleOrders,
  registerRefund,
  registerReturn,
  registerSalePayment,
  reserveSaleOrder,
  type AllocationChoice,
  type ApproveReturnCreditInput,
  type CancelOrderInput,
  type CashMethod,
  type ConfirmOrderInput,
  type ConvertQuoteInput,
  type CreditApprovalInput,
  type RefundInput,
  type RegisterReturnInput,
  type ReturnLineAllocation,
  type SalePaymentInput,
} from '../domains/sale'
import {
  createRetailOrder,
  deliverSaleOrder,
  queryFulfillmentBoard,
  saveAssemblyChecks,
  startAssembly,
  type CheckItemInput,
  type DeliverInput,
  type RetailLineInput,
  type RetailOrderInput,
  type SaveChecksInput,
  type StartAssemblyInput,
} from '../domains/assembly'

/** 只声明本模块用到的绑定，避免与入口的 Env 定义互相耦合。 */
export interface SalesRouteEnv {
  DB: D1Database
}

/** 与入口的 AuthContext 结构一致；本模块只读，不重新判定会话。 */
export interface SalesRouteContext extends PermissionHolder {
  userId: number
  storeId: number
}

const CONTRACT_VERSION = 'v1'
const PREFIX = '/api/v2'

const CONVERT_PATH = /^\/api\/v2\/sales\/quotes\/([^/]+)\/convert$/
const ORDERS_PATH = `${PREFIX}/sales/orders`
const ORDER_CONFIRM_PATH = /^\/api\/v2\/sales\/orders\/([^/]+)\/confirm$/
const ORDER_ALLOCATE_PATH = /^\/api\/v2\/sales\/orders\/([^/]+)\/allocate$/
const ORDER_PAYMENTS_PATH = /^\/api\/v2\/sales\/orders\/([^/]+)\/payments$/
const ORDER_START_ASSEMBLY_PATH = /^\/api\/v2\/sales\/orders\/([^/]+)\/start-assembly$/
const ORDER_CHECKS_PATH = /^\/api\/v2\/sales\/orders\/([^/]+)\/checks$/
const ORDER_DELIVER_PATH = /^\/api\/v2\/sales\/orders\/([^/]+)\/deliver$/
const ORDER_DETAIL_PATH = /^\/api\/v2\/sales\/orders\/([^/]+)$/
const ORDER_CREDIT_APPROVAL_PATH = /^\/api\/v2\/sales\/orders\/([^/]+)\/credit-approval$/
const ORDER_CANCEL_PATH = /^\/api\/v2\/sales\/orders\/([^/]+)\/cancel$/
const ORDER_REFUNDS_PATH = /^\/api\/v2\/sales\/orders\/([^/]+)\/refunds$/
const RETURNS_PATH = `${PREFIX}/sales/returns`
const RETURN_APPROVE_CREDIT_PATH = /^\/api\/v2\/sales\/returns\/([^/]+)\/approve-credit$/

// ────────────────────────────── 契约信封 ──────────────────────────────

function meta(requestId: string | null) {
  return { requestId, serverTime: new Date().toISOString(), contractVersion: CONTRACT_VERSION }
}

function ok(data: unknown, requestId: string | null = null, status = 200): Response {
  return new Response(JSON.stringify({ data, meta: meta(requestId) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fail(
  code: string,
  message: string,
  status: number,
  options: { requestId?: string | null; currentVersion?: number } = {},
): Response {
  const error: Record<string, unknown> = { code, message, retryable: isRetryable(code) }
  if (options.currentVersion !== undefined) error.currentVersion = options.currentVersion
  return new Response(JSON.stringify({ error, meta: meta(options.requestId ?? null) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function isRetryable(code: string): boolean {
  return code === 'AUTH_REQUIRED' || code === 'SESSION_REVOKED' || code === 'RATE_LIMITED' || code === 'SERVICE_UNAVAILABLE'
}

function requireGrant(context: SalesRouteContext, code: string): Response | null {
  return grants(context, code) ? null : fail('PERMISSION_DENIED', '无该动作权限', 403)
}

// ────────────────────────────── 入参解析 ──────────────────────────────

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function asInt(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value
}

/** requestId 缺失即拒绝：没有 requestId 就没有幂等（conventions.write.idempotencyHeader）。 */
function requireRequestId(body: Record<string, unknown>, req: Request): string | null {
  const fromBody = typeof body.requestId === 'string' ? body.requestId.trim() : ''
  const headerValue = req.headers.get('Idempotency-Key')
  const fromHeader = headerValue ? headerValue.trim() : ''
  if (fromBody && fromHeader && fromBody !== fromHeader) return null
  return fromBody || fromHeader || null
}

async function readJson(req: Request): Promise<{ body: Record<string, unknown> | null; response: Response | null }> {
  try {
    const parsed = (await req.json()) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { body: null, response: fail('VALIDATION_ERROR', '请求体必须是 JSON 对象', 400) }
    }
    return { body: parsed as Record<string, unknown>, response: null }
  } catch {
    return { body: null, response: fail('VALIDATION_ERROR', '请求体不是合法 JSON', 400) }
  }
}

function parseAllocationChoices(raw: unknown): { choices: AllocationChoice[]; problem: string | null } {
  if (raw === undefined || raw === null) return { choices: [], problem: null }
  if (!Array.isArray(raw)) return { choices: [], problem: 'allocationChoices 必须是数组' }
  const choices: AllocationChoice[] = []
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object') return { choices: [], problem: 'allocationChoices 的每一项必须是对象' }
    const value = item as Record<string, unknown>
    const position = asInt(value.position)
    if (position === null || position < 0) return { choices: [], problem: 'allocationChoices 每项必须有非负整数 position' }
    choices.push({ position, stockItemId: asText(value.stockItemId) })
  }
  return { choices, problem: null }
}

function parseLineProductMap(raw: unknown): { map: { position: number; productRef: string }[]; problem: string | null } {
  if (raw === undefined || raw === null) return { map: [], problem: null }
  if (!Array.isArray(raw)) return { map: [], problem: 'lineProductMap 必须是数组' }
  const map: { position: number; productRef: string }[] = []
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object') return { map: [], problem: 'lineProductMap 的每一项必须是对象' }
    const value = item as Record<string, unknown>
    const position = asInt(value.position)
    if (position === null || position < 0) return { map: [], problem: 'lineProductMap 每项必须有非负整数 position' }
    const productRef = asText(value.productRef)
    if (!productRef) return { map: [], problem: 'lineProductMap 每项必须有 productRef' }
    map.push({ position, productRef })
  }
  return { map, problem: null }
}

function parseConvertInput(body: Record<string, unknown>): { input: ConvertQuoteInput | null; problem: string | null } {
  const quoteVersion = asInt(body.quoteVersion)
  if (quoteVersion === null || quoteVersion < 1) return { input: null, problem: '必须指定要成交的报价版本号（quoteVersion）' }
  const { choices, problem } = parseAllocationChoices(body.allocationChoices)
  if (problem) return { input: null, problem }
  const { map, problem: mapProblem } = parseLineProductMap(body.lineProductMap)
  if (mapProblem) return { input: null, problem: mapProblem }
  const dueAtRaw = asText(body.dueAt)
  if (dueAtRaw && Number.isNaN(new Date(dueAtRaw).getTime())) return { input: null, problem: '交期不是合法时间' }
  return {
    input: { quoteVersion, dueAt: dueAtRaw, allocationChoices: choices, lineProductMap: map, note: asText(body.note) },
    problem: null,
  }
}

function parseConfirmInput(body: Record<string, unknown>): { input: ConfirmOrderInput | null; problem: string | null } {
  const { choices, problem } = parseAllocationChoices(body.allocationChoices)
  if (problem) return { input: null, problem }
  const dueAtRaw = asText(body.dueAt)
  if (dueAtRaw && Number.isNaN(new Date(dueAtRaw).getTime())) return { input: null, problem: '交期不是合法时间' }
  return { input: { dueAt: dueAtRaw, allocationChoices: choices, note: asText(body.note) }, problem: null }
}

function parsePaymentInput(body: Record<string, unknown>): { input: SalePaymentInput | null; problem: string | null } {
  const amountCents = asInt(body.amountCents)
  if (amountCents === null || amountCents <= 0) return { input: null, problem: '收款金额必须是正整数分' }
  const method = body.method
  if (typeof method !== 'string' || !(CASH_METHODS as readonly string[]).includes(method)) {
    return { input: null, problem: `收款方式只能是 ${CASH_METHODS.join(' / ')}` }
  }
  const occurredAt = asText(body.occurredAt)
  if (occurredAt && Number.isNaN(new Date(occurredAt).getTime())) return { input: null, problem: '收款时间不是合法时间' }
  const verificationState = body.verificationState === 'verified' ? 'verified' : 'unverified'
  return {
    input: { amountCents, method: method as CashMethod, occurredAt, remark: asText(body.remark), verificationState },
    problem: null,
  }
}

/** B04：零售行。只做形状校验，业务校验（来源约束 / 商品映射）在领域层。 */
function parseRetailLine(raw: unknown): { line: RetailLineInput | null; problem: string | null } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { line: null, problem: '每一行必须是对象' }
  const value = raw as Record<string, unknown>
  const qty = asInt(value.qty)
  const unitPriceCents = asInt(value.unitPriceCents)
  if (qty === null || unitPriceCents === null) return { line: null, problem: '每行的 qty 与 unitPriceCents 必须是整数' }
  const line: RetailLineInput = {
    source: typeof value.source === 'string' ? value.source : '',
    nameSnapshot: typeof value.nameSnapshot === 'string' ? value.nameSnapshot : '',
    specSnapshot: asText(value.specSnapshot),
    qty,
    unitPriceCents,
    productRef: asText(value.productRef),
    stockItemId: asText(value.stockItemId),
    warrantySnapshot: typeof value.warrantySnapshot === 'string' ? value.warrantySnapshot : null,
  }
  return { line, problem: null }
}

function parseRetailOrderInput(body: Record<string, unknown>): { input: RetailOrderInput | null; problem: string | null } {
  const kind = body.kind
  if (typeof kind !== 'string') return { input: null, problem: '必须指定 kind（retail / assembly）' }
  const customerSnapshot = body.customerSnapshot
  if (!customerSnapshot || typeof customerSnapshot !== 'object' || Array.isArray(customerSnapshot)) {
    return { input: null, problem: '必须给客户快照对象（customerSnapshot）' }
  }
  const snapshotJson = JSON.stringify(customerSnapshot)
  const name = (customerSnapshot as Record<string, unknown>).name
  if (typeof name !== 'string' || !name.trim()) {
    return { input: null, problem: '客户快照必须带 name（零售单没有客户档案可回查）' }
  }
  if (!Array.isArray(body.lines)) return { input: null, problem: 'lines 必须是数组' }
  const lines: RetailLineInput[] = []
  for (const raw of body.lines) {
    const { line, problem } = parseRetailLine(raw)
    if (problem || !line) return { input: null, problem: problem ?? '行数据无效' }
    lines.push(line)
  }
  const terms = body.terms
  if (terms !== undefined && terms !== null && (typeof terms !== 'object' || Array.isArray(terms))) {
    return { input: null, problem: 'terms 必须是对象' }
  }
  const discountCents = asInt(body.discountCents) ?? 0
  const dueAtRaw = asText(body.dueAt)
  if (dueAtRaw && Number.isNaN(new Date(dueAtRaw).getTime())) return { input: null, problem: '交期不是合法时间' }
  return {
    input: {
      kind,
      customerSnapshot: snapshotJson,
      lines,
      termsSnapshot: terms ? JSON.stringify(terms) : null,
      dueAt: dueAtRaw,
      note: asText(body.note),
      discountCents,
    },
    problem: null,
  }
}

function parseStartAssemblyInput(body: Record<string, unknown>): { input: StartAssemblyInput; problem: string | null } {
  return {
    input: { location: asText(body.location) ?? '', customerReceiptRef: asText(body.customerReceiptRef) },
    problem: null,
  }
}

function parseChecksInput(body: Record<string, unknown>): { input: SaveChecksInput | null; problem: string | null } {
  const configurationVersion = asInt(body.configurationVersion)
  if (configurationVersion === null) return { input: null, problem: '必须给 configurationVersion（非负整数）' }
  const templateVersion = asText(body.templateVersion)
  if (!templateVersion) return { input: null, problem: '必须给 templateVersion' }
  if (!Array.isArray(body.items)) return { input: null, problem: 'items 必须是数组' }
  const items: CheckItemInput[] = []
  for (const raw of body.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { input: null, problem: 'items 的每一项必须是对象' }
    const value = raw as Record<string, unknown>
    items.push({
      key: typeof value.key === 'string' ? value.key : '',
      label: typeof value.label === 'string' ? value.label : '',
      kind: typeof value.kind === 'string' ? value.kind : '',
      state: typeof value.state === 'string' ? value.state : '',
      note: typeof value.note === 'string' ? value.note : null,
      stockItemId: asText(value.stockItemId),
    })
  }
  const evidence = Array.isArray(body.resultEvidence)
    ? body.resultEvidence.filter((item): item is string => typeof item === 'string')
    : undefined
  return { input: { templateVersion, configurationVersion, items, resultEvidence: evidence }, problem: null }
}

function parseDeliverInput(body: Record<string, unknown>): { input: DeliverInput | null; problem: string | null } {
  const configurationVersion = asInt(body.configurationVersion)
  if (configurationVersion === null) return { input: null, problem: '必须给 configurationVersion（非负整数）' }
  const checklistVersion = asInt(body.checklistVersion)
  const deliveryNote = asText(body.deliveryNote)
  if (!deliveryNote) return { input: null, problem: '交付备注必填（交付给谁、怎么交的）' }
  return {
    input: {
      configurationVersion,
      checklistVersion,
      deliveryNote,
      receivedByNote: asText(body.receivedByNote),
      creditApprovalRef: asText(body.creditApprovalRef),
    },
    problem: null,
  }
}

function parseCreditApprovalInput(body: Record<string, unknown>): { input: CreditApprovalInput | null; problem: string | null } {
  const dueDate = asText(body.dueDate)
  if (!dueDate) return { input: null, problem: '欠款交付必须给到期日（dueDate）' }
  const reason = asText(body.reason)
  if (!reason) return { input: null, problem: '欠款交付必须写明原因' }
  return { input: { dueDate, reason }, problem: null }
}

function parseCancelInput(body: Record<string, unknown>): { input: CancelOrderInput | null; problem: string | null } {
  const reason = asText(body.reason)
  if (!reason) return { input: null, problem: '取消销售单必须写明原因' }
  return { input: { reason }, problem: null }
}

function parseReturnInput(body: Record<string, unknown>): { input: RegisterReturnInput | null; problem: string | null } {
  const originalOrderId = asText(body.originalOrderId)
  if (!originalOrderId) return { input: null, problem: '退货必须给原订单（originalOrderId）' }
  if (!Array.isArray(body.lineAllocations) || body.lineAllocations.length === 0) {
    return { input: null, problem: '退货必须给原行分配（lineAllocations）' }
  }
  const lineAllocations: ReturnLineAllocation[] = []
  for (const raw of body.lineAllocations) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { input: null, problem: 'lineAllocations 的每一项必须是对象' }
    const value = raw as Record<string, unknown>
    const position = asInt(value.position)
    const qty = asInt(value.qty)
    if (position === null || position < 0) return { input: null, problem: 'lineAllocations 每项必须有非负整数 position' }
    if (qty === null || qty <= 0) return { input: null, problem: 'lineAllocations 每项必须有正整数 qty' }
    lineAllocations.push({ position, qty })
  }
  const acceptedQty = asInt(body.acceptedQty)
  if (acceptedQty === null || acceptedQty <= 0) return { input: null, problem: '接收数量必须是正整数' }
  const creditCents = asInt(body.creditCents)
  if (creditCents === null || creditCents <= 0) return { input: null, problem: '退货贷项必须是正整数分' }
  const stockItemIds = Array.isArray(body.stockItemIds)
    ? body.stockItemIds.filter((item): item is string => typeof item === 'string')
    : []
  if (!Array.isArray(body.stockItemIds)) return { input: null, problem: 'stockItemIds 必须是数组' }
  const reason = asText(body.reason)
  if (!reason) return { input: null, problem: '退货必须写明原因' }
  return { input: { originalOrderId, lineAllocations, stockItemIds, reason, acceptedQty, creditCents }, problem: null }
}

function parseApproveCreditInput(body: Record<string, unknown>): { input: ApproveReturnCreditInput; problem: string | null } {
  return { input: { reason: asText(body.reason) }, problem: null }
}

function parseRefundInput(body: Record<string, unknown>): { input: RefundInput | null; problem: string | null } {
  const amountCents = asInt(body.amountCents)
  if (amountCents === null || amountCents <= 0) return { input: null, problem: '退款金额必须是正整数分' }
  const method = body.method
  if (typeof method !== 'string' || !(CASH_METHODS as readonly string[]).includes(method)) {
    return { input: null, problem: `退款方式只能是 ${CASH_METHODS.join(' / ')}` }
  }
  const returnRef = asText(body.returnRef)
  const adjustmentRef = asText(body.adjustmentRef)
  if (!returnRef && !adjustmentRef) return { input: null, problem: '退款必须关联退货单（returnRef）或调整（adjustmentRef），二者至少给一个' }
  const reason = asText(body.reason)
  if (!reason) return { input: null, problem: '退款必须写明原因' }
  const occurredAt = asText(body.occurredAt)
  if (occurredAt && Number.isNaN(new Date(occurredAt).getTime())) return { input: null, problem: '退款时间不是合法时间' }
  return { input: { amountCents, method: method as CashMethod, occurredAt, returnRef, adjustmentRef, reason }, problem: null }
}

// ────────────────────────────── 写结果 → 响应 ──────────────────────────────

const GENERIC_VALIDATION_MEANING = findErrorDefinition('VALIDATION_ERROR')?.meaning ?? '字段无效，或金额不是整数分'

/**
 * 给校验类失败补一句人能用的说明 —— 与 E04b/E05 的 guidanceFor 同一手法：
 * 守卫只把错误码带出异常，而「未付款不预留」「报价过期不能成交」这类
 * 最需要说清楚的情况，用户看到的却是「字段无效」。
 */
function guidanceFor(
  code: string,
  message: string,
  action: 'convert' | 'reserve' | 'payment' | 'retail' | 'assembly' | 'checks' | 'deliver'
    | 'credit' | 'cancel' | 'return' | 'refund' | 'approve-credit',
): string | null {
  if (code !== 'VALIDATION_ERROR') return null
  if (message !== GENERIC_VALIDATION_MEANING) return null
  if (action === 'convert') {
    return '报价没有通过转单校验。最常见的三种：这份报价已经转过单；版本不是已发出或顾客已确认；'
      + '或者报价已过期（先续期再成交）'
  }
  if (action === 'reserve') {
    return '成交没有通过校验。最常见的是还没收到定金 —— 未付款不预留；也可能是这单已被取消或关闭'
  }
  if (action === 'payment') {
    return '收款没有通过校验。最常见的是金额超过了这张单的剩余应收（可收上限 = max(余额, 0)）'
  }
  if (action === 'retail') {
    return '零售单没有建起来。最常见的是：新品行没选商品、二手行没指定实物，或者整单优惠超过了小计'
  }
  if (action === 'assembly') {
    return '备料没有开始。最常见的是这单还没确认成交，或者还有店有件没占住 —— 先收款成交、补齐缺口'
  }
  if (action === 'checks') {
    return '检测结果没有保存。最常见的是配置版本对不上（改过配置要重新检测），或者还有检查项没完成'
  }
  if (action === 'cancel') {
    return '取消没有通过。最常见的是这单已交付（只能走退货）、已取消或已关闭'
  }
  if (action === 'credit') {
    return '欠款批准没有通过。最常见的是这单还没成交，或已经结清不需要欠款'
  }
  if (action === 'return') {
    return '退货没有通过。最常见的是这单还没交付（未交付走取消），或累计退货贷项超过订单总额'
  }
  if (action === 'approve-credit') {
    return '批准贷项没有通过。最常见的是这张退货单已批准过，或累计退货贷项超过订单总额'
  }
  if (action === 'refund') {
    return '退款没有通过。最常见的是超过了可退现金上限（min(应退, 现金净收)）'
  }
  return '交付没有通过。交付闸门会逐项核：已成交、货已占住、需 SN 的已绑定、检测已通过、条款已固化、款项已结清'
}

interface WriteOutcome {
  operationId: string
  entityId: string | null
  entityVersion: number | null
  state: string | null
  effects: Record<string, unknown>
  summary: string
}

function writeResponse(
  result: Awaited<ReturnType<typeof convertQuoteToOrder>>,
  action: 'convert' | 'reserve' | 'payment' | 'retail' | 'assembly' | 'checks' | 'deliver'
    | 'credit' | 'cancel' | 'return' | 'refund' | 'approve-credit',
  state: string | null,
): Response {
  if (result.ok) {
    const outcome = result.outcome
    const data: WriteOutcome = {
      operationId: result.requestId,
      entityId: outcome.entityId ?? null,
      entityVersion: outcome.version ?? null,
      state,
      effects: outcome.effects ?? {},
      summary: outcome.summary ?? '',
    }
    return ok(data, result.requestId)
  }
  const message = appendReadableDiagnostic(guidanceFor(result.code, result.message, action) ?? result.message, result.diagnostic)
  return fail(result.code, message, result.httpStatus, { requestId: result.requestId, currentVersion: result.currentVersion })
}

// ────────────────────────────── 路由 ──────────────────────────────

async function handleConvert(req: Request, env: SalesRouteEnv, context: SalesRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, QUOTE_PERMISSIONS.convert)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parseConvertInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '成交数据无效', 400, { requestId })

  let quoteId = rawId
  try {
    quoteId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '报价单编号无法解析', 400, { requestId })
  }

  const result = await convertQuoteToOrder(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B03', payloadHash: '' },
    quoteId,
    input,
  )
  return writeResponse(result, 'convert', 'draft')
}

async function handleOrderList(req: Request, env: SalesRouteEnv, context: SalesRouteContext): Promise<Response> {
  const denied = requireGrant(context, SALE_PERMISSIONS.orderView)
  if (denied) return denied

  const url = new URL(req.url)
  const tradeState = url.searchParams.get('tradeState')
  if (tradeState && !(SALE_TRADE_STATES as readonly string[]).includes(tradeState)) {
    return fail('VALIDATION_ERROR', `tradeState 只能是 ${SALE_TRADE_STATES.join(' / ')}`, 400)
  }
  const limitRaw = url.searchParams.get('limit')
  let limit: number | null = null
  if (limitRaw !== null && limitRaw !== '') {
    if (!/^\d+$/.test(limitRaw)) return fail('VALIDATION_ERROR', 'limit 必须是正整数', 400)
    limit = Number(limitRaw)
  }

  const result = await querySaleOrders(env.DB, context.storeId, {
    tradeState,
    q: url.searchParams.get('q'),
    limit,
  })
  return ok(result)
}

async function handleOrderDetail(env: SalesRouteEnv, context: SalesRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, SALE_PERMISSIONS.orderView)
  if (denied) return denied

  let orderId = rawId
  try {
    orderId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '销售单编号无法解析', 400)
  }
  const detail = await querySaleOrderDetail(env.DB, context.storeId, orderId)
  // 跨店或不存在一律 404：不泄露别家门店有没有这张单。
  if (!detail) return fail('ENTITY_NOT_FOUND', '销售单不存在或不属于当前门店', 404)
  // R04 的 result 是「完整处理视图」（uiRefs 含「办理交付」）：装机检测与交付的事实
  // 随详情一起返回，前端不需要再发一次请求。读不到看板（理论不可能）时按原样返回。
  const board = await queryFulfillmentBoard(env.DB, context.storeId, orderId)
  return ok(board ? { ...detail, fulfillment: board } : detail)
}

async function handleOrderReserve(
  req: Request,
  env: SalesRouteEnv,
  context: SalesRouteContext,
  rawId: string,
  markConfirmed: boolean,
): Promise<Response> {
  const denied = requireGrant(context, SALE_PERMISSIONS.orderEdit)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parseConfirmInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '成交数据无效', 400, { requestId })

  let orderId = rawId
  try {
    orderId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '销售单编号无法解析', 400, { requestId })
  }

  const result = await reserveSaleOrder(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B05', payloadHash: '' },
    orderId,
    input,
    markConfirmed,
  )
  return writeResponse(result, 'reserve', markConfirmed ? 'confirmed' : null)
}

async function handleOrderPayment(req: Request, env: SalesRouteEnv, context: SalesRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, SALE_PERMISSIONS.orderPayment)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parsePaymentInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '收款数据无效', 400, { requestId })

  let orderId = rawId
  try {
    orderId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '销售单编号无法解析', 400, { requestId })
  }

  const result = await registerSalePayment(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B08', payloadHash: '' },
    orderId,
    input,
  )
  return writeResponse(result, 'payment', null)
}

// ────────────────────────────── E08 · B04 / B06 / B07 / B10 ──────────────────────────────

async function handleCreateRetail(req: Request, env: SalesRouteEnv, context: SalesRouteContext): Promise<Response> {
  const denied = requireGrant(context, SALE_PERMISSIONS.orderEdit)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parseRetailOrderInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '零售单数据无效', 400, { requestId })

  const result = await createRetailOrder(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B04', payloadHash: '' },
    input,
  )
  return writeResponse(result, 'retail', 'draft')
}

async function handleStartAssembly(
  req: Request,
  env: SalesRouteEnv,
  context: SalesRouteContext,
  rawId: string,
): Promise<Response> {
  const denied = requireGrant(context, SALE_PERMISSIONS.orderAssembly)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  let orderId = rawId
  try {
    orderId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '销售单编号无法解析', 400, { requestId })
  }

  const { input } = parseStartAssemblyInput(body)
  const result = await startAssembly(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B06', payloadHash: '' },
    orderId,
    input,
  )
  return writeResponse(result, 'assembly', null)
}

async function handleSaveChecks(
  req: Request,
  env: SalesRouteEnv,
  context: SalesRouteContext,
  rawId: string,
): Promise<Response> {
  const denied = requireGrant(context, SALE_PERMISSIONS.orderAssembly)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parseChecksInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '检测结果无效', 400, { requestId })

  let orderId = rawId
  try {
    orderId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '销售单编号无法解析', 400, { requestId })
  }

  const result = await saveAssemblyChecks(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B07', payloadHash: '' },
    orderId,
    input,
  )
  return writeResponse(result, 'checks', null)
}

async function handleDeliver(
  req: Request,
  env: SalesRouteEnv,
  context: SalesRouteContext,
  rawId: string,
): Promise<Response> {
  const denied = requireGrant(context, SALE_PERMISSIONS.orderDeliver)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parseDeliverInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '交付数据无效', 400, { requestId })

  let orderId = rawId
  try {
    orderId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '销售单编号无法解析', 400, { requestId })
  }

  const result = await deliverSaleOrder(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B10', payloadHash: '' },
    orderId,
    input,
  )
  return writeResponse(result, 'deliver', 'delivered')
}

// ────────────────────────────── E09 · B09 / B11 / B17 / B43 / B18 ──────────────────────────────

async function handleCreditApproval(
  req: Request,
  env: SalesRouteEnv,
  context: SalesRouteContext,
  rawId: string,
): Promise<Response> {
  const denied = requireGrant(context, SALE_PERMISSIONS.creditApproval)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parseCreditApprovalInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '欠款批准数据无效', 400, { requestId })

  let orderId = rawId
  try {
    orderId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '销售单编号无法解析', 400, { requestId })
  }

  const result = await approveCreditDelivery(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B09', payloadHash: '' },
    orderId,
    input,
  )
  return writeResponse(result, 'credit', null)
}

async function handleCancelOrder(
  req: Request,
  env: SalesRouteEnv,
  context: SalesRouteContext,
  rawId: string,
): Promise<Response> {
  const denied = requireGrant(context, SALE_PERMISSIONS.orderEdit)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parseCancelInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '取消数据无效', 400, { requestId })

  let orderId = rawId
  try {
    orderId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '销售单编号无法解析', 400, { requestId })
  }

  const result = await cancelSaleOrder(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B11', payloadHash: '' },
    orderId,
    input,
  )
  return writeResponse(result, 'cancel', 'cancelled')
}

async function handleRegisterReturn(
  req: Request,
  env: SalesRouteEnv,
  context: SalesRouteContext,
): Promise<Response> {
  const denied = requireGrant(context, SALE_PERMISSIONS.returnCreate)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parseReturnInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '退货数据无效', 400, { requestId })

  const result = await registerReturn(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B17', payloadHash: '' },
    input,
  )
  return writeResponse(result, 'return', null)
}

async function handleApproveReturnCredit(
  req: Request,
  env: SalesRouteEnv,
  context: SalesRouteContext,
  rawId: string,
): Promise<Response> {
  const denied = requireGrant(context, SALE_PERMISSIONS.refund)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input } = parseApproveCreditInput(body)

  let returnId = rawId
  try {
    returnId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '退货单编号无法解析', 400, { requestId })
  }

  const result = await approveReturnCredit(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B43', payloadHash: '' },
    returnId,
    input,
  )
  return writeResponse(result, 'approve-credit', 'approved')
}

async function handleRegisterRefund(
  req: Request,
  env: SalesRouteEnv,
  context: SalesRouteContext,
  rawId: string,
): Promise<Response> {
  const denied = requireGrant(context, SALE_PERMISSIONS.refund)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parseRefundInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '退款数据无效', 400, { requestId })

  let orderId = rawId
  try {
    orderId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '销售单编号无法解析', 400, { requestId })
  }

  const result = await registerRefund(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B18', payloadHash: '' },
    orderId,
    input,
  )
  return writeResponse(result, 'refund', null)
}

/**
 * 分发入口。返回 null 表示「不是本模块的路径」。
 *
 * ⚠️ 兜底 404 只覆盖 `/api/v2/sales/` —— 报价链路（`/api/v2/sales/quotes*`）由
 * `quote-v2.ts` 先处理；本模块排在它之后，所以不会抢走它的路径。
 */
export async function routeSalesV2(
  req: Request,
  env: SalesRouteEnv,
  context: SalesRouteContext,
): Promise<Response | null> {
  const path = new URL(req.url).pathname
  if (!path.startsWith(`${PREFIX}/`)) return null

  const convertMatch = CONVERT_PATH.exec(path)
  if (convertMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleConvert(req, env, context, convertMatch[1])
  }

  if (path === ORDERS_PATH) {
    // B04（新建零售单）在 E08 接上：POST 建草稿，不预留（未付款不预留）。
    if (req.method === 'GET') return handleOrderList(req, env, context)
    if (req.method === 'POST') return handleCreateRetail(req, env, context)
    return fail('VALIDATION_ERROR', '该方法不支持', 405)
  }

  const confirmMatch = ORDER_CONFIRM_PATH.exec(path)
  if (confirmMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleOrderReserve(req, env, context, confirmMatch[1], true)
  }

  const allocateMatch = ORDER_ALLOCATE_PATH.exec(path)
  if (allocateMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleOrderReserve(req, env, context, allocateMatch[1], false)
  }

  const paymentMatch = ORDER_PAYMENTS_PATH.exec(path)
  if (paymentMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleOrderPayment(req, env, context, paymentMatch[1])
  }

  const startAssemblyMatch = ORDER_START_ASSEMBLY_PATH.exec(path)
  if (startAssemblyMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleStartAssembly(req, env, context, startAssemblyMatch[1])
  }

  const checksMatch = ORDER_CHECKS_PATH.exec(path)
  if (checksMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleSaveChecks(req, env, context, checksMatch[1])
  }

  const deliverMatch = ORDER_DELIVER_PATH.exec(path)
  if (deliverMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleDeliver(req, env, context, deliverMatch[1])
  }

  const creditApprovalMatch = ORDER_CREDIT_APPROVAL_PATH.exec(path)
  if (creditApprovalMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleCreditApproval(req, env, context, creditApprovalMatch[1])
  }

  const cancelMatch = ORDER_CANCEL_PATH.exec(path)
  if (cancelMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleCancelOrder(req, env, context, cancelMatch[1])
  }

  const refundsMatch = ORDER_REFUNDS_PATH.exec(path)
  if (refundsMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleRegisterRefund(req, env, context, refundsMatch[1])
  }

  if (path === RETURNS_PATH) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleRegisterReturn(req, env, context)
  }

  const returnApproveCreditMatch = RETURN_APPROVE_CREDIT_PATH.exec(path)
  if (returnApproveCreditMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleApproveReturnCredit(req, env, context, returnApproveCreditMatch[1])
  }

  const detailMatch = ORDER_DETAIL_PATH.exec(path)
  if (detailMatch) {
    if (req.method !== 'GET') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleOrderDetail(env, context, detailMatch[1])
  }

  if (path.startsWith(`${PREFIX}/sales/orders`)) {
    return fail('ENTITY_NOT_FOUND', '接口不存在', 404)
  }
  return null
}
