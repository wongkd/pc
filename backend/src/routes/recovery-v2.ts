/**
 * /api/v2 回收路由（E10）。
 *
 * 与 routes/sales-v2.ts / purchase-v2.ts / finance-v2.ts 同一理由单独成文件：
 * 新契约权限码（recovery/*）写进入口会被 validate-contracts 当成旧码判红，
 * 所以整条链路留在本文件，入口只保留分发行。
 *
 * 承接的契约条目（前缀 /api/v2 由 conventions.api 声明）：
 *   · B26  POST /recovery/orders                权限 recovery/edit     —— 回收登记
 *   · B27  POST /recovery/orders/:id/inspect、/offer 权限 recovery/edit —— 验机估价
 *   · B28  POST /recovery/orders/:id/acquire    权限 recovery/acquire  —— 取得所有权（老板专属）
 *   · B29  POST /recovery/orders/:id/return     权限 recovery/edit     —— 归还客户
 *   · B44  POST /recovery/orders/:id/teardown   权限 recovery/edit     —— 拆件入库
 *   · R10  GET  /recovery/orders、/recovery/orders/:id 权限 recovery/view —— 列表与详情
 */

import { grants, RECOVERY_PERMISSIONS, type PermissionHolder } from '../domains/access'
import { appendReadableDiagnostic } from '../domains/operations'
import {
  acquireRecovery,
  inspectOrOfferRecovery,
  payRecovery,
  queryRecoveryOrder,
  queryRecoveryOrders,
  registerRecovery,
  returnRecovery,
  teardownRecovery,
  type RecoveryAcquireInput,
  type RecoveryOfferInput,
  type RecoveryPaymentInput,
  type RecoveryRegisterInput,
  type RecoveryTeardownInput,
} from '../domains/recovery'

/** 只声明本模块用到的绑定，避免与入口的 Env 定义互相耦合。 */
export interface RecoveryRouteEnv {
  DB: D1Database
}

/** 与入口的 AuthContext 结构一致；本模块只读，不重新判定会话。 */
export interface RecoveryRouteContext extends PermissionHolder {
  userId: number
  storeId: number
}

const CONTRACT_VERSION = 'v1'
const PREFIX = '/api/v2'

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

function requireGrant(context: RecoveryRouteContext, code: string): Response | null {
  return grants(context, code) ? null : fail('PERMISSION_DENIED', '无该动作权限', 403)
}

// ────────────────────────────── 入参解析 ──────────────────────────────

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function asOptionalCents(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value
}

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

// ────────────────────────────── 入参模型 ──────────────────────────────

function parseRegisterInput(body: Record<string, unknown>): { input: RecoveryRegisterInput | null; problem: string | null } {
  const sellerName = asText(body.sellerName)
  if (!sellerName) return { input: null, problem: '卖方姓名不能为空' }
  const itemsRaw = body.items
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) return { input: null, problem: '回收单至少需要一件实物' }
  const items = itemsRaw.map((raw, index) => {
    const item = raw as Record<string, unknown>
    const condition = asText(item.condition)
    return {
      description: asText(item.description) ?? '',
      condition: condition === 'new' || condition === 'used' ? condition : undefined,
      snRaw: asText(item.snRaw),
      estimatedCents: typeof item.estimatedCents === 'number' ? item.estimatedCents : undefined,
    }
  })
  for (const [index, item] of items.entries()) {
    if (!item.description) return { input: null, problem: `第 ${index + 1} 件：描述不能为空` }
  }
  return {
    input: {
      sellerName,
      sellerPhone: asText(body.sellerPhone),
      sellerCustomerId: typeof body.sellerCustomerId === 'number' ? body.sellerCustomerId : undefined,
      items,
      initialEstimateCents: typeof body.initialEstimateCents === 'number' ? body.initialEstimateCents : undefined,
      note: asText(body.note),
    },
    problem: null,
  }
}

function parseAcquireInput(body: Record<string, unknown>): { input: RecoveryAcquireInput | null; problem: string | null } {
  const finalAcquisitionCents = body.finalAcquisitionCents
  if (typeof finalAcquisitionCents !== 'number' || !Number.isInteger(finalAcquisitionCents)) {
    return { input: null, problem: '最终收购价必须为整数分' }
  }
  const linesRaw = body.lines
  if (!Array.isArray(linesRaw) || linesRaw.length === 0) return { input: null, problem: '至少需要一行逐件成本' }
  const lines = linesRaw.map((raw) => {
    const line = raw as Record<string, unknown>
    const condition = asText(line.condition)
    return {
      recoveryItemId: asText(line.recoveryItemId) ?? '',
      productRef: asText(line.productRef) ?? '',
      assetCode: asText(line.assetCode),
      condition: condition === 'new' || condition === 'used' ? condition : undefined,
      snRaw: asText(line.snRaw),
      remark: asText(line.remark),
      costCents: typeof line.costCents === 'number' ? line.costCents : -1,
    }
  })
  return { input: { finalAcquisitionCents, lines, evidenceRef: asText(body.evidenceRef), note: asText(body.note) }, problem: null }
}

function parseTeardownInput(body: Record<string, unknown>): { input: RecoveryTeardownInput | null; problem: string | null } {
  const sourceStockItemId = asText(body.sourceStockItemId)
  if (!sourceStockItemId) return { input: null, problem: '缺少源实物 sourceStockItemId' }
  const outputsRaw = body.outputs
  if (!Array.isArray(outputsRaw) || outputsRaw.length === 0) return { input: null, problem: '至少需要一个产出件' }
  const outputs = outputsRaw.map((raw) => {
    const out = raw as Record<string, unknown>
    const condition = asText(out.condition)
    return {
      productRef: asText(out.productRef) ?? '',
      assetCode: asText(out.assetCode),
      condition: condition === 'new' || condition === 'used' ? condition : undefined,
      snRaw: asText(out.snRaw),
      remark: asText(out.remark),
      costCents: typeof out.costCents === 'number' ? out.costCents : -1,
    }
  })
  const scrapLines = Array.isArray(body.scrapLines)
    ? (body.scrapLines as Record<string, unknown>[]).map((raw) => ({
        description: asText(raw.description) ?? '',
        costCents: typeof raw.costCents === 'number' ? raw.costCents : 0,
      }))
    : []
  return {
    input: {
      sourceStockItemId,
      outputs,
      scrapLines,
      occurredAt: asText(body.occurredAt),
    },
    problem: null,
  }
}

// ────────────────────────────── 路由 handler ──────────────────────────────

function routeContext(context: RecoveryRouteContext, requestId: string, action: string) {
  return { storeId: context.storeId, actorUserId: context.userId, requestId, action, payloadHash: '' }
}

async function handleList(req: Request, env: RecoveryRouteEnv, context: RecoveryRouteContext): Promise<Response> {
  const denied = requireGrant(context, RECOVERY_PERMISSIONS.view)
  if (denied) return denied
  const url = new URL(req.url)
  const state = url.searchParams.get('state')
  const limitRaw = url.searchParams.get('limit')
  let limit: number | null = null
  if (limitRaw !== null && limitRaw !== '') {
    if (!/^\d+$/.test(limitRaw)) return fail('VALIDATION_ERROR', 'limit 必须是正整数', 400)
    limit = Number(limitRaw)
  }
  return ok({ orders: await queryRecoveryOrders(env.DB, context.storeId, { state, limit }) })
}

async function handleDetail(env: RecoveryRouteEnv, context: RecoveryRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, RECOVERY_PERMISSIONS.view)
  if (denied) return denied
  let orderId = rawId
  try {
    orderId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '回收单编号无法解析', 400)
  }
  const detail = await queryRecoveryOrder(env.DB, context.storeId, orderId)
  if (!detail) return fail('ENTITY_NOT_FOUND', '回收单不存在或不属于当前门店', 404)
  return ok(detail)
}

async function handleRegister(req: Request, env: RecoveryRouteEnv, context: RecoveryRouteContext): Promise<Response> {
  const denied = requireGrant(context, RECOVERY_PERMISSIONS.edit)
  if (denied) return denied
  const { body, response } = await readJson(req)
  if (!body) return response!
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)
  const { input, problem } = parseRegisterInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '回收登记数据无效', 400, { requestId })

  const result = await registerRecovery(env.DB, routeContext(context, requestId, 'B26'), input)
  if (result.ok) {
    const outcome = result.outcome
    return ok({
      operationId: result.requestId,
      entityId: outcome.entityId ?? null,
      entityVersion: outcome.version ?? null,
      state: 'received_for_inspection',
      effects: outcome.effects ?? {},
      summary: outcome.summary ?? '',
    }, result.requestId)
  }
  return fail(result.code, appendReadableDiagnostic(result.message, result.diagnostic), result.httpStatus, { requestId: result.requestId, currentVersion: result.currentVersion })
}

async function handleAction(
  req: Request,
  env: RecoveryRouteEnv,
  context: RecoveryRouteContext,
  rawId: string,
  action: 'inspect' | 'offer' | 'acquire' | 'return' | 'teardown',
): Promise<Response> {
  let orderId = rawId
  try {
    orderId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '回收单编号无法解析', 400)
  }
  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const ctx = routeContext(context, requestId, action === 'acquire' ? 'B28' : action === 'teardown' ? 'B44' : 'B27')

  if (action === 'inspect' || action === 'offer') {
    const denied = requireGrant(context, RECOVERY_PERMISSIONS.edit)
    if (denied) return denied
    const input: RecoveryOfferInput = {
      estimatedCents: typeof body.estimatedCents === 'number' ? body.estimatedCents : undefined,
      itemPrices: Array.isArray(body.itemPrices)
        ? (body.itemPrices as Record<string, unknown>[]).map((raw) => ({
            recoveryItemId: asText(raw.recoveryItemId) ?? '',
            estimatedCents: typeof raw.estimatedCents === 'number' ? raw.estimatedCents : 0,
          }))
        : undefined,
      note: asText(body.note),
    }
    const result = await inspectOrOfferRecovery(env.DB, ctx, orderId, action, input)
    return finish(result)
  }

  if (action === 'acquire') {
    const denied = requireGrant(context, RECOVERY_PERMISSIONS.acquire)
    if (denied) return denied
    const { input, problem } = parseAcquireInput(body)
    if (!input) return fail('VALIDATION_ERROR', problem ?? '收购数据无效', 400, { requestId })
    const result = await acquireRecovery(env.DB, ctx, orderId, input)
    return finish(result)
  }

  if (action === 'return') {
    const denied = requireGrant(context, RECOVERY_PERMISSIONS.edit)
    if (denied) return denied
    const reason = asText(body.reason)
    if (!reason) return fail('VALIDATION_ERROR', '归还必须写明原因', 400, { requestId })
    const result = await returnRecovery(env.DB, routeContext(context, requestId, 'B29'), orderId, reason)
    return finish(result)
  }

  if (action === 'teardown') {
    const denied = requireGrant(context, RECOVERY_PERMISSIONS.edit)
    if (denied) return denied
    const { input, problem } = parseTeardownInput(body)
    if (!input) return fail('VALIDATION_ERROR', problem ?? '拆件数据无效', 400, { requestId })
    const result = await teardownRecovery(env.DB, ctx, orderId, input)
    return finish(result)
  }

  return fail('VALIDATION_ERROR', '未知动作', 400)
}

function finish(result: Awaited<ReturnType<typeof registerRecovery>>): Response {
  if (result.ok) {
    const outcome = result.outcome
    return ok({
      operationId: result.requestId,
      entityId: outcome.entityId ?? null,
      entityVersion: outcome.version ?? null,
      state: outcome.effects?.state ?? null,
      effects: outcome.effects ?? {},
      summary: outcome.summary ?? '',
    }, result.requestId)
  }
  return fail(result.code, appendReadableDiagnostic(result.message, result.diagnostic), result.httpStatus, { requestId: result.requestId, currentVersion: result.currentVersion })
}

// ────────────────────────────── 付款（B33）── 供 /finance/payments 复用的出口 ──────────────────────────────

/**
 * 回收付款出口（B33）：由 finance-v2.ts 的 /finance/payments 分发调用。
 *
 * 为什么不由本模块自己接 /finance/payments：契约 B33 的路径与权限（finance/payment）
 * 都在 finance 域，回收模块只提供「回收单应付」这一条付款实现；采购付款仍未实现，
 * 由 finance-v2 拒绝，不在这里伪造入口。
 */
export async function handleRecoveryPayment(
  env: RecoveryRouteEnv,
  context: RecoveryRouteContext,
  requestId: string,
  orderId: string,
  input: RecoveryPaymentInput,
): Promise<Response> {
  const result = await payRecovery(env.DB, routeContext(context, requestId, 'B33'), orderId, input)
  return finish(result)
}

// ────────────────────────────── 分发 ──────────────────────────────

const ORDERS_PATH = `${PREFIX}/recovery/orders`
const ORDER_DETAIL_PATH = /^\/api\/v2\/recovery\/orders\/([^/]+)$/
const ORDER_ACTION_PATH = /^\/api\/v2\/recovery\/orders\/([^/]+)\/(inspect|offer|acquire|return|teardown)$/

export async function routeRecoveryV2(
  req: Request,
  env: RecoveryRouteEnv,
  context: RecoveryRouteContext,
): Promise<Response | null> {
  const path = new URL(req.url).pathname
  if (!path.startsWith(`${PREFIX}/recovery`)) return null

  if (path === ORDERS_PATH) {
    if (req.method === 'GET') return handleList(req, env, context)
    if (req.method === 'POST') return handleRegister(req, env, context)
    return fail('VALIDATION_ERROR', '该方法不支持', 405)
  }

  const actionMatch = ORDER_ACTION_PATH.exec(path)
  if (actionMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleAction(req, env, context, actionMatch[1], actionMatch[2] as 'inspect' | 'offer' | 'acquire' | 'return' | 'teardown')
  }

  const detailMatch = ORDER_DETAIL_PATH.exec(path)
  if (detailMatch) {
    if (req.method !== 'GET') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleDetail(env, context, detailMatch[1])
  }

  if (path.startsWith(`${PREFIX}/recovery`)) {
    return fail('ENTITY_NOT_FOUND', '接口不存在', 404)
  }
  return null
}
