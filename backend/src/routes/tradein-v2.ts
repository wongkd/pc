/**
 * /api/v2 抵用额度（置换折抵）路由（E12）。
 *
 * 与 routes/recovery-v2.ts / finance-v2.ts 同一理由单独成文件：
 * 新契约权限码（tradein/*）写进入口会被 validate-contracts 当成旧码判红，
 * 所以整条链路留在本文件，入口只保留分发行。
 *
 * 承接的契约条目（前缀 /api/v2 由 conventions.api 声明）：
 *   · B31  POST /trade-ins                     权限 tradein/create —— 建立置换关联
 *   · B31  POST /trade-ins/:id/apply-offset    权限 tradein/offset —— 应用折抵（老板专属）
 *   · B32  POST /trade-ins/:id/reverse-offset  权限 tradein/reverse —— 撤销折抵（老板专属）
 *   · R11  GET  /trade-ins/:id                 权限 tradein/view —— 置换单详情
 */

import { grants, TRADEIN_PERMISSIONS, type PermissionHolder } from '../domains/access'
import { appendReadableDiagnostic } from '../domains/operations'
import {
  applyOffset,
  createTradeIn,
  queryTradeIn,
  reverseOffset,
  type TradeInApplyInput,
  type TradeInCreateInput,
  type TradeInReverseInput,
} from '../domains/tradein'

/** 只声明本模块用到的绑定，避免与入口的 Env 定义互相耦合。 */
export interface TradeinRouteEnv {
  DB: D1Database
}

/** 与入口的 AuthContext 结构一致；本模块只读，不重新判定会话。 */
export interface TradeinRouteContext extends PermissionHolder {
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

function requireGrant(context: TradeinRouteContext, code: string): Response | null {
  return grants(context, code) ? null : fail('PERMISSION_DENIED', '无该动作权限', 403)
}

// ────────────────────────────── 入参解析 ──────────────────────────────

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function asRequiredVersion(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
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

function parseVersions(body: Record<string, unknown>): { saleOrderVersion: number | null; recoveryVersion: number | null } {
  return {
    saleOrderVersion: asRequiredVersion(body.saleOrderVersion),
    recoveryVersion: asRequiredVersion(body.recoveryVersion),
  }
}

// ────────────────────────────── 路由 handler ──────────────────────────────

function routeContext(context: TradeinRouteContext, requestId: string, action: string) {
  return { storeId: context.storeId, actorUserId: context.userId, requestId, action, payloadHash: '' }
}

function finish(result: Awaited<ReturnType<typeof createTradeIn>>): Response {
  if (result.ok) {
    const outcome = result.outcome
    return ok({
      operationId: result.requestId,
      entityId: outcome.entityId ?? null,
      entityVersion: outcome.version ?? null,
      state: null,
      effects: outcome.effects ?? {},
      summary: outcome.summary ?? '',
    }, result.requestId)
  }
  return fail(result.code, appendReadableDiagnostic(result.message, result.diagnostic), result.httpStatus, { requestId: result.requestId, currentVersion: result.currentVersion })
}

async function handleDetail(env: TradeinRouteEnv, context: TradeinRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, TRADEIN_PERMISSIONS.view)
  if (denied) return denied
  let tradeInId = rawId
  try {
    tradeInId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '置换单编号无法解析', 400)
  }
  const detail = await queryTradeIn(env.DB, context.storeId, tradeInId)
  if (!detail) return fail('ENTITY_NOT_FOUND', '置换单不存在或不属于当前门店', 404)
  return ok(detail)
}

async function handleCreate(req: Request, env: TradeinRouteEnv, context: TradeinRouteContext): Promise<Response> {
  const denied = requireGrant(context, TRADEIN_PERMISSIONS.create)
  if (denied) return denied
  const { body, response } = await readJson(req)
  if (!body) return response!
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const saleOrderId = asText(body.saleOrderId)
  const recoveryId = asText(body.recoveryId)
  if (!saleOrderId || !recoveryId) return fail('VALIDATION_ERROR', '缺少 saleOrderId 或 recoveryId', 400, { requestId })
  const { saleOrderVersion, recoveryVersion } = parseVersions(body)
  if (saleOrderVersion == null || recoveryVersion == null) {
    return fail('VALIDATION_ERROR', '缺少 saleOrderVersion 或 recoveryVersion（双方版本必须为正整数）', 400, { requestId })
  }

  const input: TradeInCreateInput = { saleOrderId, recoveryId, saleOrderVersion, recoveryVersion }
  const result = await createTradeIn(env.DB, routeContext(context, requestId, 'B31'), input)
  return finish(result)
}

async function handleApplyOffset(
  req: Request,
  env: TradeinRouteEnv,
  context: TradeinRouteContext,
  rawId: string,
): Promise<Response> {
  const denied = requireGrant(context, TRADEIN_PERMISSIONS.offset)
  if (denied) return denied
  const { body, response } = await readJson(req)
  if (!body) return response!
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  let tradeInId = rawId
  try {
    tradeInId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '置换单编号无法解析', 400, { requestId })
  }

  const amountCents = body.amountCents
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents <= 0) {
    return fail('VALIDATION_ERROR', 'amountCents 必须为正整数分', 400, { requestId })
  }
  const { saleOrderVersion, recoveryVersion } = parseVersions(body)
  if (saleOrderVersion == null || recoveryVersion == null) {
    return fail('VALIDATION_ERROR', '缺少 saleOrderVersion 或 recoveryVersion（双方版本必须为正整数）', 400, { requestId })
  }

  const input: TradeInApplyInput = { amountCents, saleOrderVersion, recoveryVersion }
  const result = await applyOffset(env.DB, routeContext(context, requestId, 'B31'), tradeInId, input)
  return finish(result)
}

async function handleReverseOffset(
  req: Request,
  env: TradeinRouteEnv,
  context: TradeinRouteContext,
  rawId: string,
): Promise<Response> {
  const denied = requireGrant(context, TRADEIN_PERMISSIONS.reverse)
  if (denied) return denied
  const { body, response } = await readJson(req)
  if (!body) return response!
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  let tradeInId = rawId
  try {
    tradeInId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '置换单编号无法解析', 400, { requestId })
  }

  const offsetId = asText(body.offsetId)
  const reason = asText(body.reason)
  if (!offsetId) return fail('VALIDATION_ERROR', '缺少要撤销的折抵编号 offsetId', 400, { requestId })
  if (!reason) return fail('VALIDATION_ERROR', '撤销折抵必须写明原因 reason', 400, { requestId })
  const { saleOrderVersion, recoveryVersion } = parseVersions(body)
  if (saleOrderVersion == null || recoveryVersion == null) {
    return fail('VALIDATION_ERROR', '缺少 saleOrderVersion 或 recoveryVersion（双方版本必须为正整数）', 400, { requestId })
  }

  const input: TradeInReverseInput = { offsetId, reason, saleOrderVersion, recoveryVersion }
  const result = await reverseOffset(env.DB, routeContext(context, requestId, 'B32'), tradeInId, input)
  return finish(result)
}

// ────────────────────────────── 分发 ──────────────────────────────

const TRADEINS_PATH = `${PREFIX}/trade-ins`
const DETAIL_PATH = /^\/api\/v2\/trade-ins\/([^/]+)$/
const APPLY_PATH = /^\/api\/v2\/trade-ins\/([^/]+)\/apply-offset$/
const REVERSE_PATH = /^\/api\/v2\/trade-ins\/([^/]+)\/reverse-offset$/

export async function routeTradeinV2(
  req: Request,
  env: TradeinRouteEnv,
  context: TradeinRouteContext,
): Promise<Response | null> {
  const path = new URL(req.url).pathname
  if (!path.startsWith(`${PREFIX}/trade-ins`)) return null

  if (path === TRADEINS_PATH) {
    if (req.method === 'POST') return handleCreate(req, env, context)
    return fail('VALIDATION_ERROR', '该方法不支持', 405)
  }

  const applyMatch = APPLY_PATH.exec(path)
  if (applyMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleApplyOffset(req, env, context, applyMatch[1])
  }

  const reverseMatch = REVERSE_PATH.exec(path)
  if (reverseMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleReverseOffset(req, env, context, reverseMatch[1])
  }

  const detailMatch = DETAIL_PATH.exec(path)
  if (detailMatch) {
    if (req.method !== 'GET') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleDetail(env, context, detailMatch[1])
  }

  if (path.startsWith(`${PREFIX}/trade-ins`)) {
    return fail('ENTITY_NOT_FOUND', '接口不存在', 404)
  }
  return null
}
