/**
 * /api/v2 采购路由（E07/F4）。
 *
 * 为什么单独成文件（与 `routes/inventory-v2.ts`、`routes/quote-v2.ts` 同一理由）：
 * `validate-contracts.mjs` 第 10.6 节会把 `src/index.ts` 里所有 `'xx/yy'` 形态的字面量
 * 当成旧权限码，要求它们全部出现在 legacyPermissionMap 里。本文件里的新码
 * （`inventory/purchase-create`、`inventory/receipt`、`inventory/supplier-return`）
 * 写进入口会让契约校验直接变红，所以整条链路留在本文件，入口只保留分发行。
 *
 * 承接的契约条目（前缀 /api/v2 由 conventions.api 声明）：
 *   · B14  POST /inventory/purchases        权限 inventory/purchase-create —— 创建采购
 *   · B15  POST /inventory/receipts         权限 inventory/receipt         —— 到货入库
 *   · B37  POST /inventory/purchases/:id/cancel 权限 inventory/purchase-cancel —— 取消未到数量
 *   · B38  POST /inventory/supplier-returns 权限 inventory/supplier-return —— 退供
 *   · R08  GET  /inventory/purchases        权限 inventory/view           —— 采购列表
 *   · R08  GET  /inventory/purchases/:id    权限 inventory/view           —— 采购详情
 *
 * ⚠️ 路径前缀与 `inventory-v2.ts` 重叠（都在 /api/v2/inventory 下）。
 *    `inventory-v2.ts` 对自己的前缀有兜底 404，所以本模块**必须排在它前面**被调用
 *    （入口的调用顺序保证）—— 否则采购路径永远到不了这里。E05 已经踩过一次同类坑：
 *    后接链路被前一个模块的 404 吃掉。本模块只认领上面这几条精确路径，其余一律返回 null。
 *
 * 本模块不做的事：
 *   · 不写任何付款流水（B33 由 finance-v2 承载）；
 *   · 不碰旧 /api/purchases 之类路径（旧入口自己处理）。
 */

import {
  PURCHASE_PERMISSIONS,
  grants,
  type PermissionHolder,
} from '../domains/access'
import { findErrorDefinition } from '../generated/error-codes'
import { appendReadableDiagnostic } from '../domains/operations'
import {
  INSPECTION_DISPOSITIONS,
  PURCHASE_CANCEL_REASONS,
  STOCK_CONDITIONS,
  cancelPurchase,
  createPurchase,
  queryPurchaseDetail,
  queryPurchases,
  registerReceipt,
  returnToSupplier,
  type CreatePurchaseInput,
  type CancelPurchaseInput,
  type InspectionDisposition,
  type PurchaseLineInput,
  type ReceiptInput,
  type ReceiptLineInput,
  type StockCondition,
  type SupplierReturnInput,
  type SupplierReturnBucket,
} from '../domains/purchase'

/** 只声明本模块用到的绑定，避免与入口的 Env 定义互相耦合。 */
export interface PurchaseRouteEnv {
  DB: D1Database
}

/** 与入口的 AuthContext 结构一致；本模块只读，不重新判定会话。 */
export interface PurchaseRouteContext extends PermissionHolder {
  userId: number
  storeId: number
}

const CONTRACT_VERSION = 'v1'
const PREFIX = '/api/v2'

const PURCHASES_PATH = `${PREFIX}/inventory/purchases`
const PURCHASE_DETAIL_PATH = /^\/api\/v2\/inventory\/purchases\/([^/]+)$/
const PURCHASE_CANCEL_PATH = /^\/api\/v2\/inventory\/purchases\/([^/]+)\/cancel$/
const RECEIPTS_PATH = `${PREFIX}/inventory/receipts`
const SUPPLIER_RETURNS_PATH = `${PREFIX}/inventory/supplier-returns`

const SUPPLIER_RETURN_BUCKETS = ['available', 'quarantine'] as const

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

function requireGrant(context: PurchaseRouteContext, code: string): Response | null {
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

function parsePurchaseInput(body: Record<string, unknown>): { input: CreatePurchaseInput | null; problem: string | null } {
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return { input: null, problem: '采购单至少要有一行' }
  }
  const lines: PurchaseLineInput[] = []
  for (const [index, raw] of (body.lines as unknown[]).entries()) {
    const at = `第 ${index + 1} 行`
    if (!raw || typeof raw !== 'object') return { input: null, problem: `${at}：行数据无效` }
    const line = raw as Record<string, unknown>
    const productRef = asText(line.productRef)
    if (!productRef) return { input: null, problem: `${at}：缺少商品` }
    const qtyOrdered = asInt(line.qtyOrdered)
    if (qtyOrdered === null || qtyOrdered < 1) return { input: null, problem: `${at}：订购数量必须是正整数` }
    let unitCostCents: number | null = null
    if (line.unitCostCents !== undefined && line.unitCostCents !== null) {
      const parsed = asInt(line.unitCostCents)
      if (parsed === null || parsed < 0) return { input: null, problem: `${at}：单件成本必须是非负整数分` }
      unitCostCents = parsed
    }
    lines.push({
      productRef,
      nameSnapshot: asText(line.nameSnapshot),
      specSnapshot: asText(line.specSnapshot),
      qtyOrdered,
      unitCostCents,
      costKnown: line.costKnown === undefined || line.costKnown === null ? unitCostCents !== null : Boolean(line.costKnown),
    })
  }
  return {
    input: {
      supplierName: asText(body.supplierName),
      supplierRef: asText(body.supplierRef),
      supplierNote: asText(body.supplierNote),
      saleOrderId: asText(body.saleOrderId),
      expectedAt: asText(body.expectedAt),
      note: asText(body.note),
      lines,
    },
    problem: null,
  }
}

function parseReceiptInput(body: Record<string, unknown>): { input: ReceiptInput | null; problem: string | null } {
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return { input: null, problem: '到货至少要有一行' }
  }
  const lines: ReceiptLineInput[] = []
  for (const [index, raw] of (body.lines as unknown[]).entries()) {
    const at = `第 ${index + 1} 行`
    if (!raw || typeof raw !== 'object') return { input: null, problem: `${at}：行数据无效` }
    const line = raw as Record<string, unknown>
    const productRef = asText(line.productRef)
    if (!productRef) return { input: null, problem: `${at}：缺少商品` }
    const disposition = line.disposition
    if (typeof disposition !== 'string' || !(INSPECTION_DISPOSITIONS as readonly string[]).includes(disposition)) {
      return { input: null, problem: `${at}：处置去向只能是 ${INSPECTION_DISPOSITIONS.join(' / ')}` }
    }
    // 成色：不传按新品。传了就必须是新 / 二手之一 —— 二手件被静默记成新品是数据错误，不是显示问题。
    let condition: StockCondition | null = null
    if (line.condition !== undefined && line.condition !== null && line.condition !== '') {
      if (typeof line.condition !== 'string' || !(STOCK_CONDITIONS as readonly string[]).includes(line.condition)) {
        return { input: null, problem: `${at}：成色只能是 ${STOCK_CONDITIONS.join(' / ')}` }
      }
      condition = line.condition as StockCondition
    }
    const qtyReceived = asInt(line.qtyReceived) ?? 0
    const qtyRejected = asInt(line.qtyRejected) ?? 0
    if (qtyReceived < 0 || qtyRejected < 0) return { input: null, problem: `${at}：数量不能为负` }
    let unitCostCents: number | null = null
    if (line.unitCostCents !== undefined && line.unitCostCents !== null) {
      const parsed = asInt(line.unitCostCents)
      if (parsed === null || parsed < 0) return { input: null, problem: `${at}：单件成本必须是非负整数分` }
      unitCostCents = parsed
    }
    const items = Array.isArray(line.items)
      ? (line.items as unknown[]).map((item) => {
          const value = (item ?? {}) as Record<string, unknown>
          return { assetCode: asText(value.assetCode), snRaw: asText(value.snRaw), remark: asText(value.remark) }
        })
      : []
    lines.push({
      purchaseLineId: asText(line.purchaseLineId),
      position: index,
      productRef,
      qtyReceived,
      qtyRejected,
      disposition: disposition as InspectionDisposition,
      unitCostCents,
      condition,
      costKnown: line.costKnown === undefined || line.costKnown === null ? unitCostCents !== null : Boolean(line.costKnown),
      items,
      batchRemark: asText(line.batchRemark),
    })
  }
  return {
    input: {
      purchaseId: asText(body.purchaseId),
      quickPurchaseNote: asText(body.quickPurchaseNote),
      occurredAt: asText(body.occurredAt),
      note: asText(body.note),
      lines,
    },
    problem: null,
  }
}

function parseSupplierReturnInput(body: Record<string, unknown>): { input: SupplierReturnInput | null; problem: string | null } {
  const qty = asInt(body.qty)
  if (qty === null || qty < 1) return { input: null, problem: '退供数量必须是正整数' }
  const reason = asText(body.reason)
  if (!reason) return { input: null, problem: '退供必须填写原因' }
  const fromBucket = (body.fromBucket ?? 'available') as string
  if (!(SUPPLIER_RETURN_BUCKETS as readonly string[]).includes(fromBucket)) {
    return { input: null, problem: '退供只能从可取（available）或待处理（quarantine）库存出发' }
  }
  let unitCostCents: number | null = null
  if (body.unitCostCents !== undefined && body.unitCostCents !== null) {
    const parsed = asInt(body.unitCostCents)
    if (parsed === null || parsed < 0) return { input: null, problem: '单件成本必须是非负整数分' }
    unitCostCents = parsed
  }
  return {
    input: {
      purchaseId: asText(body.purchaseId),
      stockItemId: asText(body.stockItemId),
      productRef: asText(body.productRef),
      qty,
      fromBucket: fromBucket as SupplierReturnBucket,
      reason,
      supplierName: asText(body.supplierName),
      unitCostCents,
      costKnown: body.costKnown === undefined || body.costKnown === null ? unitCostCents !== null : Boolean(body.costKnown),
      occurredAt: asText(body.occurredAt),
    },
    problem: null,
  }
}

function parsePurchaseCancelInput(body: Record<string, unknown>): { input: CancelPurchaseInput | null; problem: string | null } {
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return { input: null, problem: '取消明细至少要有一行' }
  }
  const reason = asText(body.reason)
  if (!reason || !(PURCHASE_CANCEL_REASONS as readonly string[]).includes(reason)) {
    return { input: null, problem: `取消原因只能是 ${PURCHASE_CANCEL_REASONS.join(' / ')}` }
  }
  const lines = [] as CancelPurchaseInput['lines']
  for (const [index, raw] of (body.lines as unknown[]).entries()) {
    const at = `第 ${index + 1} 行`
    if (!raw || typeof raw !== 'object') return { input: null, problem: `${at}：行数据无效` }
    const line = raw as Record<string, unknown>
    const purchaseLineId = asText(line.purchaseLineId)
    const qty = asInt(line.qty)
    if (!purchaseLineId) return { input: null, problem: `${at}：缺少 purchaseLineId` }
    if (qty === null || qty < 1) return { input: null, problem: `${at}：取消数量必须是正整数` }
    lines.push({ purchaseLineId, qty })
  }
  return {
    input: { lines, reason: reason as CancelPurchaseInput['reason'], note: asText(body.note), occurredAt: asText(body.occurredAt) },
    problem: null,
  }
}

// ────────────────────────────── 写结果 → 响应 ──────────────────────────────

const GENERIC_VALIDATION_MEANING = findErrorDefinition('VALIDATION_ERROR')?.meaning ?? '字段无效，或金额不是整数分'

/**
 * 给校验类失败补一句人能用的说明 —— 与 E04b/E05 的 guidanceFor 同一手法。
 * 只在领域层没给出更具体文案时才替换，且文案写成「可能是」。
 */
function guidanceFor(code: string, message: string, action: 'purchase' | 'receipt' | 'purchase-cancel' | 'supplier-return'): string | null {
  if (code !== 'VALIDATION_ERROR') return null
  if (message !== GENERIC_VALIDATION_MEANING) return null
  if (action === 'receipt') {
    return '到货没有通过校验。最常见的三种：本次实收 + 拒收超过了采购单订购量（超量要先改采购量或另建追加采购）；'
      + '逐件商品没给够数量对应的内部编号；或者处置去向与填写的数量不匹配（不进库的去向要把数量填在拒收里）'
  }
  if (action === 'supplier-return') {
    return '退供没有通过校验。最常见的是可退数量不够：本店该型号的可取 + 待处理库存已经少于你要退的数量'
  }
  if (action === 'purchase-cancel') {
    return '取消采购没有通过校验。只能取消尚未到货、拒收或已取消的数量；采购已有净付款时需先处理付款冲销'
  }
  return '采购单没有通过校验。最常见的两种：供应商名称与已建档供应商都没填；或者某一行缺商品、数量不是正整数'
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
  result: Awaited<ReturnType<typeof createPurchase>>,
  action: 'purchase' | 'receipt' | 'purchase-cancel' | 'supplier-return',
): Response {
  if (result.ok) {
    const outcome = result.outcome
    const data: WriteOutcome = {
      operationId: result.requestId,
      entityId: outcome.entityId ?? null,
      entityVersion: outcome.version ?? null,
      state: null,
      effects: outcome.effects ?? {},
      summary: outcome.summary ?? '',
    }
    return ok(data, result.requestId)
  }
  const message = appendReadableDiagnostic(guidanceFor(result.code, result.message, action) ?? result.message, result.diagnostic)
  return fail(result.code, message, result.httpStatus, { requestId: result.requestId, currentVersion: result.currentVersion })
}

// ────────────────────────────── 路由 ──────────────────────────────

async function handlePurchaseList(req: Request, env: PurchaseRouteEnv, context: PurchaseRouteContext): Promise<Response> {
  const denied = requireGrant(context, 'inventory/view')
  if (denied) return denied

  const url = new URL(req.url)
  const scope = url.searchParams.get('scope')
  if (scope && scope !== 'open' && scope !== 'done') {
    return fail('VALIDATION_ERROR', 'scope 只能是 open 或 done', 400)
  }
  const limitRaw = url.searchParams.get('limit')
  let limit: number | null = null
  if (limitRaw !== null && limitRaw !== '') {
    if (!/^\d+$/.test(limitRaw)) return fail('VALIDATION_ERROR', 'limit 必须是正整数', 400)
    limit = Number(limitRaw)
  }

  const result = await queryPurchases(env.DB, context.storeId, {
    scope,
    q: url.searchParams.get('q'),
    saleOrderId: url.searchParams.get('saleOrderId'),
    limit,
  })
  return ok(result)
}

async function handlePurchaseDetail(env: PurchaseRouteEnv, context: PurchaseRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, 'inventory/view')
  if (denied) return denied

  let purchaseId = rawId
  try {
    purchaseId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '采购单编号无法解析', 400)
  }
  const detail = await queryPurchaseDetail(env.DB, context.storeId, purchaseId)
  // 跨店或不存在一律 404：不泄露别家门店有没有这张采购单。
  if (!detail) return fail('ENTITY_NOT_FOUND', '采购单不存在或不属于当前门店', 404)
  return ok(detail)
}

async function handlePurchaseCreate(req: Request, env: PurchaseRouteEnv, context: PurchaseRouteContext): Promise<Response> {
  const denied = requireGrant(context, PURCHASE_PERMISSIONS.create)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parsePurchaseInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '采购数据无效', 400, { requestId })

  const result = await createPurchase(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B14', payloadHash: '' },
    input,
  )
  return writeResponse(result, 'purchase')
}

async function handleReceiptCreate(req: Request, env: PurchaseRouteEnv, context: PurchaseRouteContext): Promise<Response> {
  const denied = requireGrant(context, PURCHASE_PERMISSIONS.receipt)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parseReceiptInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '到货数据无效', 400, { requestId })

  const result = await registerReceipt(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B15', payloadHash: '' },
    input,
  )
  return writeResponse(result, 'receipt')
}

async function handleSupplierReturn(req: Request, env: PurchaseRouteEnv, context: PurchaseRouteContext): Promise<Response> {
  const denied = requireGrant(context, PURCHASE_PERMISSIONS.supplierReturn)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parseSupplierReturnInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '退供数据无效', 400, { requestId })

  const result = await returnToSupplier(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B38', payloadHash: '' },
    input,
  )
  return writeResponse(result, 'supplier-return')
}

async function handlePurchaseCancel(req: Request, env: PurchaseRouteEnv, context: PurchaseRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, PURCHASE_PERMISSIONS.cancel)
  if (denied) return denied

  let purchaseId = rawId
  try {
    purchaseId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '采购单编号无法解析', 400)
  }

  const { body, response } = await readJson(req)
  if (!body) return response!
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parsePurchaseCancelInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '取消采购数据无效', 400, { requestId })

  const result = await cancelPurchase(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B37', payloadHash: '' },
    purchaseId,
    input,
  )
  return writeResponse(result, 'purchase-cancel')
}

/**
 * 分发入口。返回 null 表示「不是本模块的路径」，由调用方继续走后面的模块。
 *
 * ⚠️ 只认领三条精确路径。`/api/v2/inventory` 下的其它路径（型号汇总、实物、商品、期初）
 * 属于 `inventory-v2.ts`，本模块一律返回 null，不抢它的活。
 */
export async function routePurchaseV2(
  req: Request,
  env: PurchaseRouteEnv,
  context: PurchaseRouteContext,
): Promise<Response | null> {
  const path = new URL(req.url).pathname
  if (!path.startsWith(`${PREFIX}/`)) return null

  if (path === PURCHASES_PATH) {
    if (req.method === 'GET') return handlePurchaseList(req, env, context)
    if (req.method === 'POST') return handlePurchaseCreate(req, env, context)
    return fail('VALIDATION_ERROR', '该方法不支持', 405)
  }

  const detailMatch = PURCHASE_DETAIL_PATH.exec(path)
  if (detailMatch) {
    if (req.method !== 'GET') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handlePurchaseDetail(env, context, detailMatch[1])
  }

  if (path === RECEIPTS_PATH) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleReceiptCreate(req, env, context)
  }

  const cancelMatch = PURCHASE_CANCEL_PATH.exec(path)
  if (cancelMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handlePurchaseCancel(req, env, context, cancelMatch[1])
  }

  if (path === SUPPLIER_RETURNS_PATH) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleSupplierReturn(req, env, context)
  }

  return null
}
