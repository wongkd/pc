/**
 * /api/v2 账本路由（E09）。
 *
 * 为什么单独成文件（与 `routes/sales-v2.ts`、`routes/purchase-v2.ts` 同一理由）：
 * `validate-contracts.mjs` 第 10.6 节会把 `src/index.ts` 里所有 `'xx/yy'` 形态的字面量
 * 当成旧权限码，要求它们全部出现在 legacyPermissionMap 里。本文件里的新码
 * （`finance/view`、`finance/reverse`）写进入口会让契约校验直接变红，
 * 所以整条链路留在本文件，入口只保留分发行。
 *
 * 承接的契约条目（前缀 /api/v2 由 conventions.api 声明）：
 *   · B34  POST /finance/entries/:id/reverse  权限 finance/reverse —— 受控反冲账务分录
 *   · R12  GET  /finance/overview             权限 finance/view    —— 汇总（现金流/应收/应付）
 *   · R12  GET  /finance/entries              权限 finance/view    —— 资金流水列表
 */

import {
  FINANCE_PERMISSIONS,
  grants,
  type PermissionHolder,
} from '../domains/access'
import {
  payPurchase,
  queryFinanceEntries,
  queryFinanceOverview,
  reverseEntry,
  type PurchasePaymentInput,
  type ReverseEntryInput,
} from '../domains/finance'
import { appendReadableDiagnostic } from '../domains/operations'
import { handleRecoveryPayment } from './recovery-v2'
import type { RecoveryPaymentInput } from '../domains/recovery'

/** 只声明本模块用到的绑定，避免与入口的 Env 定义互相耦合。 */
export interface FinanceRouteEnv {
  DB: D1Database
}

/** 与入口的 AuthContext 结构一致；本模块只读，不重新判定会话。 */
export interface FinanceRouteContext extends PermissionHolder {
  userId: number
  storeId: number
}

const CONTRACT_VERSION = 'v1'
const PREFIX = '/api/v2'

const OVERVIEW_PATH = `${PREFIX}/finance/overview`
const ENTRIES_PATH = `${PREFIX}/finance/entries`
const ENTRY_REVERSE_PATH = /^\/api\/v2\/finance\/entries\/([^/]+)\/reverse$/
const PAYMENTS_PATH = `${PREFIX}/finance/payments`

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

function requireGrant(context: FinanceRouteContext, code: string): Response | null {
  return grants(context, code) ? null : fail('PERMISSION_DENIED', '无该动作权限', 403)
}

// ────────────────────────────── 入参解析 ──────────────────────────────

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
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

function parseReverseInput(body: Record<string, unknown>): { input: ReverseEntryInput | null; problem: string | null } {
  const reason = asText(body.reason)
  if (!reason) return { input: null, problem: '反冲必须写明原因' }
  return { input: { reason, correctionRef: asText(body.correctionRef) }, problem: null }
}

// ────────────────────────────── 路由 ──────────────────────────────

async function handleOverview(env: FinanceRouteEnv, context: FinanceRouteContext): Promise<Response> {
  const denied = requireGrant(context, FINANCE_PERMISSIONS.view)
  if (denied) return denied
  return ok(await queryFinanceOverview(env.DB, context.storeId))
}

async function handleEntries(req: Request, env: FinanceRouteEnv, context: FinanceRouteContext): Promise<Response> {
  const denied = requireGrant(context, FINANCE_PERMISSIONS.view)
  if (denied) return denied

  const url = new URL(req.url)
  const direction = url.searchParams.get('direction')
  if (direction && direction !== 'in' && direction !== 'out') {
    return fail('VALIDATION_ERROR', 'direction 只能是 in 或 out', 400)
  }
  const limitRaw = url.searchParams.get('limit')
  let limit: number | null = null
  if (limitRaw !== null && limitRaw !== '') {
    if (!/^\d+$/.test(limitRaw)) return fail('VALIDATION_ERROR', 'limit 必须是正整数', 400)
    limit = Number(limitRaw)
  }

  return ok(await queryFinanceEntries(env.DB, context.storeId, { direction, limit }))
}

async function handleReverse(
  req: Request,
  env: FinanceRouteEnv,
  context: FinanceRouteContext,
  rawId: string,
): Promise<Response> {
  const denied = requireGrant(context, FINANCE_PERMISSIONS.reverse)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parseReverseInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '反冲数据无效', 400, { requestId })

  let entryId = rawId
  try {
    entryId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '资金分录编号无法解析', 400, { requestId })
  }

  const result = await reverseEntry(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B34', payloadHash: '' },
    entryId,
    input,
  )
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

/**
 * B33 付款来源：`purchase:<采购单号>` / `recovery:<回收单号>` 字符串，
 * 或 { kind, id } / { type, ref } 对象。
 * 认不出来的写法直接拒绝，不猜。
 */
function parseSourceDocument(value: unknown): { kind: string; id: string } | null {
  if (typeof value === 'string') {
    const matched = /^([A-Za-z_][A-Za-z0-9_-]*):(.+)$/.exec(value.trim())
    return matched ? { kind: matched[1], id: matched[2] } : null
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>
    const kind = asText(raw.kind) ?? asText(raw.type)
    const id = asText(raw.id) ?? asText(raw.ref)
    if (kind && id) return { kind, id }
  }
  return null
}

async function handlePayment(req: Request, env: FinanceRouteEnv, context: FinanceRouteContext): Promise<Response> {
  const denied = requireGrant(context, FINANCE_PERMISSIONS.payment)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const source = parseSourceDocument(body.sourceDocument)
  if (!source) {
    return fail('VALIDATION_ERROR', 'sourceDocument 必须是 "purchase:<采购单号>" / "recovery:<回收单号>" 或 { kind, id }', 400, { requestId })
  }
  if (source.kind !== 'recovery' && source.kind !== 'purchase') {
    return fail('VALIDATION_ERROR', `付款来源 ${source.kind} 尚未接入：B33 目前只支持采购单或回收单`, 400, { requestId })
  }

  const amountCents = body.amountCents
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents)) {
    return fail('VALIDATION_ERROR', 'amountCents 必须为整数分', 400, { requestId })
  }
  const method = asText(body.method)
  if (!method) return fail('VALIDATION_ERROR', '缺少付款方式 method', 400, { requestId })

  let sourceId = source.id
  try {
    sourceId = decodeURIComponent(source.id)
  } catch {
    return fail('VALIDATION_ERROR', `${source.kind === 'purchase' ? '采购单' : '回收单'}编号无法解析`, 400, { requestId })
  }

  if (source.kind === 'recovery') {
    const input: RecoveryPaymentInput = {
      amountCents,
      method: method as RecoveryPaymentInput['method'],
      occurredAt: asText(body.occurredAt),
      remark: asText(body.remark),
    }
    return handleRecoveryPayment(env, context, requestId, sourceId, input)
  }

  const purchaseInput: PurchasePaymentInput = {
    amountCents,
    method,
    occurredAt: asText(body.occurredAt),
    remark: asText(body.remark),
  }
  const result = await payPurchase(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B33', payloadHash: '' },
    sourceId,
    purchaseInput,
  )
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

/**
 * 分发入口。返回 null 表示「不是本模块的路径」。
 */
export async function routeFinanceV2(
  req: Request,
  env: FinanceRouteEnv,
  context: FinanceRouteContext,
): Promise<Response | null> {
  const path = new URL(req.url).pathname
  if (!path.startsWith(`${PREFIX}/finance`)) return null

  if (path === OVERVIEW_PATH) {
    if (req.method !== 'GET') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleOverview(env, context)
  }

  if (path === ENTRIES_PATH) {
    if (req.method !== 'GET') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleEntries(req, env, context)
  }

  if (path === PAYMENTS_PATH) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handlePayment(req, env, context)
  }

  const reverseMatch = ENTRY_REVERSE_PATH.exec(path)
  if (reverseMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleReverse(req, env, context, reverseMatch[1])
  }

  if (path.startsWith(`${PREFIX}/finance`)) {
    return fail('ENTITY_NOT_FOUND', '接口不存在', 404)
  }
  return null
}
