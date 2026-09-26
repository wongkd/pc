/**
 * /api/v2 报价单路由（E05 报价闭环）。
 *
 * 为什么单独成文件（与 `routes/inventory-v2.ts` 同一理由）：
 * `validate-contracts.mjs` 第 10.6 节会把 `src/index.ts` 里所有 `'xx/yy'` 形态的字面量
 * 当成旧权限码，要求它们全部出现在 legacyPermissionMap 里。本文件里的新码
 * （`sales/quote-*`）写进入口会让契约校验直接变红，所以整条链路留在本文件，
 * 入口只保留「分发一行」。
 *
 * 承接的契约条目（前缀 /api/v2 由 conventions.api 声明）：
 *   · B01  POST /sales/quotes                 权限 sales/quote-edit  —— 创建报价草稿
 *   · B02  POST /sales/quotes/:id/save        权限 sales/quote-edit  —— 保存版本
 *   · B02  POST /sales/quotes/:id/issue       权限 sales/quote-edit  —— 发出（不可覆盖）
 *   · B42  POST /sales/quotes/:id/confirm     权限 sales/quote-edit  —— 记录顾客确认（E05b）
 *   · R05  GET  /sales/quotes                 权限 sales/quote-view  —— 列表与筛选
 *   · R05  GET  /sales/quotes/:id             权限 sales/quote-view  —— 指定版本详情
 *
 * ⚠️ `/api/v2/operations/:requestId`（R14）由 `inventory-v2.ts` 先行接管，
 *    入口的调用顺序保证它排在前面；本模块不重复实现，避免两条取数路径给出不同口径。
 *
 * 本模块不做的事：
 *   · 不动库存、不收款（R12/R13：未付款不锁库存不采购；确认 ≠ 付款、确认不锁库存）；
 *   · 不实现报价转销售单（B03 convert）——属收款/订单卡。
 */

import {
  QUOTE_PERMISSIONS,
  grants,
  type PermissionHolder,
} from '../domains/access'
import { findErrorDefinition } from '../generated/error-codes'
import { appendReadableDiagnostic } from '../domains/operations'
import {
  QUOTE_SETTINGS,
  QUOTE_CONFIRM_SOURCES,
  confirmQuote,
  createQuote,
  deleteDraftQuote,
  issueQuote,
  queryQuoteDetail,
  queryQuotes,
  saveQuote,
  type QuoteConfirmInput,
  type QuoteConfirmSource,
  type QuoteDraftInput,
  type QuoteIssueInput,
  type QuoteLineInput,
  type QuoteLineSource,
  type QuoteTermsInput,
} from '../domains/quote'

/** 只声明本模块用到的绑定，避免与入口的 Env 定义互相耦合。 */
export interface QuoteRouteEnv {
  DB: D1Database
}

/** 与入口的 AuthContext 结构一致；本模块只读，不重新判定会话。 */
export interface QuoteRouteContext extends PermissionHolder {
  userId: number
  storeId: number
}

const CONTRACT_VERSION = 'v1.1'
const PREFIX = '/api/v2'
const LINE_SOURCES = ['new', 'used', 'customer', 'service'] as const

const QUOTE_LIST_PATH = `${PREFIX}/sales/quotes`
const QUOTE_SAVE_PATH = /^\/api\/v2\/sales\/quotes\/([^/]+)\/save$/
const QUOTE_ISSUE_PATH = /^\/api\/v2\/sales\/quotes\/([^/]+)\/issue$/
const QUOTE_CONFIRM_PATH = /^\/api\/v2\/sales\/quotes\/([^/]+)\/confirm$/
const QUOTE_DELETE_DRAFT_PATH = /^\/api\/v2\/sales\/quotes\/([^/]+)\/delete-draft$/
const QUOTE_DETAIL_PATH = /^\/api\/v2\/sales\/quotes\/([^/]+)$/

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

function requireGrant(context: QuoteRouteContext, code: string): Response | null {
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

function parseLines(raw: unknown): { lines: QuoteLineInput[] | null; problem: string | null } {
  if (raw === undefined || raw === null) return { lines: [], problem: null }
  if (!Array.isArray(raw)) return { lines: null, problem: 'lines 必须是数组' }
  const lines: QuoteLineInput[] = []
  for (const [index, item] of raw.entries()) {
    const at = `第 ${index + 1} 行`
    if (!item || typeof item !== 'object') return { lines: null, problem: `${at}：行数据无效` }
    const line = item as Record<string, unknown>
    const source = line.source
    if (typeof source !== 'string' || !(LINE_SOURCES as readonly string[]).includes(source)) {
      return { lines: null, problem: `${at}：来源只能是 new / used / customer / service` }
    }
    const nameSnapshot = asText(line.nameSnapshot)
    if (!nameSnapshot) return { lines: null, problem: `${at}：名称不能为空` }
    const qty = asInt(line.qty)
    if (qty === null) return { lines: null, problem: `${at}：数量必须是整数` }
    const unitPriceCents = asInt(line.unitPriceCents)
    if (unitPriceCents === null) return { lines: null, problem: `${at}：单价必须是整数分` }

    const warranty = line.warrantySnapshot
    if (warranty !== undefined && warranty !== null && (typeof warranty !== 'object' || Array.isArray(warranty))) {
      return { lines: null, problem: `${at}：warrantySnapshot 必须是对象` }
    }

    lines.push({
      source: source as QuoteLineSource,
      nameSnapshot,
      specSnapshot: asText(line.specSnapshot),
      qty,
      unitPriceCents,
      productRef: asText(line.productRef),
      stockItemId: asText(line.stockItemId),
      customerDeviceRef: asText(line.customerDeviceRef),
      warrantySnapshot: (warranty as Record<string, unknown> | null | undefined) ?? null,
    })
  }
  return { lines, problem: null }
}

function parseTerms(raw: unknown): { terms: QuoteTermsInput | null; problem: string | null } {
  if (raw === undefined || raw === null) return { terms: null, problem: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { terms: null, problem: 'terms 必须是对象' }
  const value = raw as Record<string, unknown>

  const budgetCents = value.budgetCents
  if (budgetCents !== undefined && budgetCents !== null) {
    if (typeof budgetCents !== 'number' || !Number.isInteger(budgetCents) || budgetCents < 0) {
      return { terms: null, problem: '预算金额必须是非负整数分' }
    }
  }
  const depositPercent = value.depositPercent
  if (depositPercent !== undefined && depositPercent !== null) {
    if (typeof depositPercent !== 'number' || !Number.isInteger(depositPercent) || depositPercent !== 15) {
      return { terms: null, problem: '首发预付款比例固定为 15%，不能通过报价条款修改' }
    }
  }

  let delivery: QuoteTermsInput['delivery'] = null
  if (value.delivery !== undefined && value.delivery !== null) {
    if (typeof value.delivery !== 'object' || Array.isArray(value.delivery)) {
      return { terms: null, problem: 'delivery 必须是对象' }
    }
    const rawDelivery = value.delivery as Record<string, unknown>
    const mode = rawDelivery.mode
    if (mode !== 'self_pickup' && mode !== 'delivery') {
      return { terms: null, problem: 'delivery.mode 只能是 self_pickup 或 delivery' }
    }
    const distanceKm = rawDelivery.distanceKm
    if (distanceKm !== undefined && distanceKm !== null && (typeof distanceKm !== 'number' || distanceKm < 0)) {
      return { terms: null, problem: 'delivery.distanceKm 必须是非负数' }
    }
    const feeCents = rawDelivery.feeCents
    if (feeCents !== undefined && feeCents !== null && (typeof feeCents !== 'number' || !Number.isInteger(feeCents) || feeCents < 0)) {
      return { terms: null, problem: 'delivery.feeCents 必须是非负整数分' }
    }
    if (typeof feeCents === 'number' && feeCents > 0) {
      return { terms: null, problem: '配送费必须作为单独的收费服务行计入应付；自动配送计费暂未开放' }
    }
    delivery = {
      mode,
      distanceKm: (distanceKm as number | null | undefined) ?? null,
      feeCents: (feeCents as number | null | undefined) ?? null,
      note: asText(rawDelivery.note),
    }
  }

  return {
    terms: {
      budgetCents: (budgetCents as number | null | undefined) ?? null,
      depositPercent: (depositPercent as number | null | undefined) ?? null,
      delivery,
      warranty: (value.warranty as Record<string, unknown> | null | undefined) ?? null,
      note: asText(value.note),
    },
    problem: null,
  }
}

/** 草稿入参（B01 与 B02 save 共用同一字段集，契约 B02 写明「编辑字段:同B01字段集」）。 */
function parseDraftInput(body: Record<string, unknown>): { input: QuoteDraftInput | null; problem: string | null } {
  const title = asText(body.title)
  if (!title) return { input: null, problem: '报价单标题不能为空' }

  let customerId: number | null = null
  if (body.customerId !== undefined && body.customerId !== null) {
    const parsed = asInt(body.customerId)
    if (parsed === null || parsed < 1) return { input: null, problem: '客户 ID 无效' }
    customerId = parsed
  }

  const { lines, problem: lineProblem } = parseLines(body.lines)
  if (!lines) return { input: null, problem: lineProblem }

  const { terms, problem: termProblem } = parseTerms(body.terms)
  if (termProblem) return { input: null, problem: termProblem }

  let discountCents = 0
  if (body.discountCents !== undefined && body.discountCents !== null) {
    const parsed = asInt(body.discountCents)
    if (parsed === null || parsed < 0) return { input: null, problem: '优惠金额必须是非负整数分' }
    discountCents = parsed
  }

  return {
    input: {
      customerId,
      title,
      lines,
      terms,
      discountCents,
      changeReason: asText(body.changeReason),
      feedbackSource: asText(body.feedbackSource),
    },
    problem: null,
  }
}

// ────────────────────────────── 写结果 → 响应 ──────────────────────────────

const GENERIC_VALIDATION_MEANING = findErrorDefinition('VALIDATION_ERROR')?.meaning ?? '字段无效，或金额不是整数分'

/**
 * 给校验类失败补一句人能用的说明 —— 与 E04b 的 guidanceFor 同一手法：
 * 守卫只把错误码带出异常，而「优惠不能超过小计」「已发出的版本不会被覆盖」这类
 * 最需要说清楚的情况，用户看到的却是「字段无效」。
 * 只在领域层没给出更具体文案时才替换，且文案写成「可能是」。
 */
function guidanceFor(code: string, message: string): string | null {
  if (code !== 'VALIDATION_ERROR') return null
  if (message !== GENERIC_VALIDATION_MEANING) return null
  return '报价单没有通过校验。最常见的三种：优惠金额超过了小计；某一行数量或单价不是正整数分；'
    + '这台的引用与行来源对不上（二手件必须指定具体实物、客供件必须指出来源设备）'
}

interface WriteOutcome {
  operationId: string
  entityId: string | null
  entityVersion: number | null
  state: string | null
  effects: Record<string, unknown>
  summary: string
  shareToken?: string
}

function writeResponse(
  result: Awaited<ReturnType<typeof createQuote>> & { shareToken?: string },
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
    // 分享凭证明文只在**本次**签发时出现；命中幂等记录时不再返回（0009 设计要点 5）。
    if (result.shareToken) data.shareToken = result.shareToken
    return ok(data, result.requestId)
  }
  const message = appendReadableDiagnostic(guidanceFor(result.code, result.message) ?? result.message, result.diagnostic)
  return fail(result.code, message, result.httpStatus, { requestId: result.requestId, currentVersion: result.currentVersion })
}

// ────────────────────────────── 路由 ──────────────────────────────

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

async function handleQuoteList(req: Request, env: QuoteRouteEnv, context: QuoteRouteContext): Promise<Response> {
  const denied = requireGrant(context, QUOTE_PERMISSIONS.view)
  if (denied) return denied

  const url = new URL(req.url)
  const status = url.searchParams.get('status')
  if (status && !['draft', 'issued', 'expired'].includes(status)) {
    return fail('VALIDATION_ERROR', 'status 只能是 draft / issued / expired', 400)
  }
  const limitRaw = url.searchParams.get('limit')
  let limit: number | null = null
  if (limitRaw !== null && limitRaw !== '') {
    if (!/^\d+$/.test(limitRaw)) return fail('VALIDATION_ERROR', 'limit 必须是正整数', 400)
    limit = Number(limitRaw)
  }

  const result = await queryQuotes(env.DB, context.storeId, {
    status,
    q: url.searchParams.get('q'),
    limit,
  })
  return ok({ quotes: result.quotes, totals: result.totals, settings: result.settings })
}

async function handleQuoteDetail(env: QuoteRouteEnv, context: QuoteRouteContext, rawId: string, revisionRaw: string | null): Promise<Response> {
  const denied = requireGrant(context, QUOTE_PERMISSIONS.view)
  if (denied) return denied

  let quoteId = rawId
  try {
    quoteId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '报价单编号无法解析', 400)
  }

  let revision: number | null = null
  if (revisionRaw !== null && revisionRaw !== '') {
    if (!/^\d+$/.test(revisionRaw)) return fail('VALIDATION_ERROR', 'revision 必须是非负整数', 400)
    revision = Number(revisionRaw)
  }

  const detail = await queryQuoteDetail(env.DB, context.storeId, quoteId, revision)
  // 跨店或不存在一律 404：不泄露别家门店有没有这份报价（03 §1）。
  if (!detail) return fail('ENTITY_NOT_FOUND', '报价单不存在或不属于当前门店', 404)
  return ok(detail)
}

async function handleQuoteCreate(req: Request, env: QuoteRouteEnv, context: QuoteRouteContext): Promise<Response> {
  const denied = requireGrant(context, QUOTE_PERMISSIONS.edit)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parseDraftInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '报价数据无效', 400, { requestId })

  const result = await createQuote(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B01', payloadHash: '' },
    input,
  )
  return writeResponse(result, 'draft')
}

async function handleQuoteSave(req: Request, env: QuoteRouteEnv, context: QuoteRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, QUOTE_PERMISSIONS.edit)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const expectedVersion = asInt(body.expectedVersion)
  if (expectedVersion === null || expectedVersion < 1) {
    return fail('VALIDATION_ERROR', '保存必须带 expectedVersion（当前报价头版本）', 400, { requestId })
  }

  const { input, problem } = parseDraftInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '报价数据无效', 400, { requestId })

  let quoteId = rawId
  try {
    quoteId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '报价单编号无法解析', 400, { requestId })
  }

  const result = await saveQuote(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B02', payloadHash: '' },
    quoteId,
    input,
    expectedVersion,
  )
  return writeResponse(result, 'draft')
}

async function handleQuoteIssue(req: Request, env: QuoteRouteEnv, context: QuoteRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, QUOTE_PERMISSIONS.edit)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const expectedVersion = asInt(body.expectedVersion)
  const validUntil = body.validUntil === undefined || body.validUntil === null ? null : asText(body.validUntil)
  if (body.validUntil !== undefined && body.validUntil !== null && !validUntil) {
    return fail('VALIDATION_ERROR', 'validUntil 必须是合法的时间字符串', 400, { requestId })
  }

  let quoteId = rawId
  try {
    quoteId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '报价单编号无法解析', 400, { requestId })
  }

  const input: QuoteIssueInput = { expectedVersion, validUntil }
  const result = await issueQuote(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B02', payloadHash: '' },
    quoteId,
    input,
  )
  return writeResponse(result, 'issued')
}

async function handleQuoteConfirm(req: Request, env: QuoteRouteEnv, context: QuoteRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, QUOTE_PERMISSIONS.edit)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const source = body.source
  if (typeof source !== 'string' || !(QUOTE_CONFIRM_SOURCES as readonly string[]).includes(source)) {
    return fail('VALIDATION_ERROR', '确认来源只能是 miniprogram / wechat / offline', 400, { requestId })
  }
  const expectedVersion = asInt(body.expectedVersion)
  const note = asText(body.note)

  let quoteId = rawId
  try {
    quoteId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '报价单编号无法解析', 400, { requestId })
  }

  const input: QuoteConfirmInput = { expectedVersion, source: source as QuoteConfirmSource, note }
  const result = await confirmQuote(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B42', payloadHash: '' },
    quoteId,
    input,
  )
  return writeResponse(result, 'confirmed')
}

async function handleQuoteDraftDelete(req: Request, env: QuoteRouteEnv, context: QuoteRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, 'store/manage')
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)
  const reason = asText(body.reason)
  if (!reason || reason.length > 200) return fail('VALIDATION_ERROR', '请填写不超过 200 字的清理原因', 400, { requestId })

  let quoteId = rawId
  try {
    quoteId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '报价单编号无法解析', 400, { requestId })
  }

  const result = await deleteDraftQuote(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B45', payloadHash: '' },
    quoteId,
    reason,
  )
  return writeResponse(result, 'deleted')
}

/**
 * 分发入口。返回 null 表示「不是本模块的路径」，由调用方继续走原来的 404。
 */
export async function routeQuoteV2(req: Request, env: QuoteRouteEnv, context: QuoteRouteContext): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname
  if (!path.startsWith(`${PREFIX}/`)) return null

  // 同一路径承载两个契约动作：R05 读列表（GET）与 B01 建草稿（POST）。
  if (path === QUOTE_LIST_PATH) {
    if (req.method === 'GET') return handleQuoteList(req, env, context)
    if (req.method === 'POST') return handleQuoteCreate(req, env, context)
    return fail('VALIDATION_ERROR', '该方法不支持', 405)
  }

  const saveMatch = QUOTE_SAVE_PATH.exec(path)
  if (saveMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleQuoteSave(req, env, context, saveMatch[1])
  }

  const issueMatch = QUOTE_ISSUE_PATH.exec(path)
  if (issueMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleQuoteIssue(req, env, context, issueMatch[1])
  }

  const confirmMatch = QUOTE_CONFIRM_PATH.exec(path)
  if (confirmMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleQuoteConfirm(req, env, context, confirmMatch[1])
  }

  const deleteDraftMatch = QUOTE_DELETE_DRAFT_PATH.exec(path)
  if (deleteDraftMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleQuoteDraftDelete(req, env, context, deleteDraftMatch[1])
  }

  const detailMatch = QUOTE_DETAIL_PATH.exec(path)
  if (detailMatch) {
    if (req.method !== 'GET') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleQuoteDetail(env, context, detailMatch[1], url.searchParams.get('revision'))
  }

  return null
}

export { QUOTE_SETTINGS }
