/**
 * /api/v2 售后维修路由（E10）。
 *
 * 与 routes/sales-v2.ts 同一理由：新权限码（service/view / service/edit / service/charge）
 * 不能写进 src/index.ts（validate-contracts 第 10.6 节会把入口里的 'xx/yy' 字面量当旧权限码），
 * 所以整条链路留在本文件，入口只保留分发行。
 *
 * 承接的契约条目（前缀 /api/v2 由 conventions.api 声明）：
 *   · B20  POST /service/orders                 权限 service/edit   —— 接修登记
 *   · B21  POST /service/orders/:id/diagnosis    权限 service/edit   —— 录入内部诊断
 *   · B21  POST /service/orders/:id/proposal     权限 service/edit   —— 录入维修方案
 *   · B22  POST /service/orders/:id/confirm-proposal 权限 service/edit —— 记录方案确认
 *   · B23  POST /service/orders/:id/replace      权限 service/edit   —— 换件（领用自有备件）
 *   · B24  POST /service/orders/:id/dispatch     权限 service/edit   —— 外送 / 返厂
 *   · B24  POST /service/orders/:id/receive-external 权限 service/edit —— 外送返回
 *   · B25  POST /service/orders/:id/retest       权限 service/edit   —— 复测通过
 *   · B25  POST /service/orders/:id/return       权限 service/edit   —— 归还客户
 *   · B41  POST /service/orders/:id/payments     权限 service/charge —— 登记售后收款
 *   · R09  GET  /service/orders                  权限 service/view   —— 工单列表
 *   · R09  GET  /service/orders/:id              权限 service/view   —— 工单详情
 *
 * 本模块只认领 /api/v2/service/ 前缀；不碰旧 /api 的任何路径。
 */

import {
  SERVICE_PERMISSIONS,
  grants,
  type PermissionHolder,
} from '../domains/access'
import { findErrorDefinition } from '../generated/error-codes'
import { appendReadableDiagnostic } from '../domains/operations'
import {
  confirmProposal,
  createServiceOrder,
  dispatchExternal,
  queryServiceOrderDetail,
  queryServiceOrders,
  receiveExternal,
  registerServicePayment,
  replacePart,
  retestDevice,
  returnDevice,
  saveDiagnosis,
  saveProposal,
  type ConfirmProposalInput,
  type DiagnosisInput,
  type DispatchInput,
  type IntakeInput,
  type ProposalInput,
  type ProposalItemInput,
  type ReceiveExternalInput,
  type ReplaceComponentInput,
  type ReplaceInput,
  type RetestInput,
  type ReturnDeviceInput,
  type ServicePaymentInput,
} from '../domains/service'

/** 只声明本模块用到的绑定。 */
export interface ServiceRouteEnv {
  DB: D1Database
}

export interface ServiceRouteContext extends PermissionHolder {
  userId: number
  storeId: number
}

const CONTRACT_VERSION = 'v1'
const PREFIX = '/api/v2'

const ORDERS_PATH = `${PREFIX}/service/orders`
const ORDER_DETAIL_PATH = /^\/api\/v2\/service\/orders\/([^/]+)$/
const ORDER_DIAGNOSIS_PATH = /^\/api\/v2\/service\/orders\/([^/]+)\/diagnosis$/
const ORDER_PROPOSAL_PATH = /^\/api\/v2\/service\/orders\/([^/]+)\/proposal$/
const ORDER_CONFIRM_PATH = /^\/api\/v2\/service\/orders\/([^/]+)\/confirm-proposal$/
const ORDER_REPLACE_PATH = /^\/api\/v2\/service\/orders\/([^/]+)\/replace$/
const ORDER_DISPATCH_PATH = /^\/api\/v2\/service\/orders\/([^/]+)\/dispatch$/
const ORDER_RECEIVE_EXTERNAL_PATH = /^\/api\/v2\/service\/orders\/([^/]+)\/receive-external$/
const ORDER_RETEST_PATH = /^\/api\/v2\/service\/orders\/([^/]+)\/retest$/
const ORDER_RETURN_PATH = /^\/api\/v2\/service\/orders\/([^/]+)\/return$/
const ORDER_PAYMENTS_PATH = /^\/api\/v2\/service\/orders\/([^/]+)\/payments$/

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

function requireGrant(context: ServiceRouteContext, code: string): Response | null {
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

function asNullableInt(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value
}

function asBool(value: unknown): boolean | null {
  if (typeof value !== 'boolean') return null
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

function decodeId(rawId: string): string | null {
  try {
    return decodeURIComponent(rawId)
  } catch {
    return null
  }
}

// ────────────────────────────── 写结果 → 响应 ──────────────────────────────

const GENERIC_VALIDATION_MEANING = findErrorDefinition('VALIDATION_ERROR')?.meaning ?? '字段无效，或金额不是整数分'

type ServiceAction =
  | 'intake' | 'diagnosis' | 'proposal' | 'confirm' | 'replace'
  | 'dispatch' | 'receive-external' | 'retest' | 'return' | 'payment'

function guidanceFor(code: string, message: string, action: ServiceAction): string | null {
  if (code !== 'VALIDATION_ERROR') return null
  if (message !== GENERIC_VALIDATION_MEANING) return null
  if (action === 'intake') return '接修没有登记成功。最常见的是缺设备标识或客户描述'
  if (action === 'diagnosis') return '诊断没有保存。最常见的是工单不在「已接修」状态'
  if (action === 'proposal') return '方案没有保存。最常见的是工单不在检测中，或方案项里有没有填全的名称 / 数量 / 单价'
  if (action === 'confirm') return '方案确认没有成功。最常见的是确认的版本号对不上当前方案版本'
  if (action === 'replace') return '换件没有成功。最常见的是工单不在维修中，或领用的备件不在可用库存里'
  if (action === 'dispatch') return '外送没有成功。最常见的是工单不在「等待确认」状态'
  if (action === 'receive-external') return '外送返回没有登记成功。最常见的是工单不在「外送」状态'
  if (action === 'retest') return '复测没有通过。最常见的是费用还没结清 —— 先收款再复测通过'
  if (action === 'return') return '归还没有成功。最常见的是工单不在「待归还」状态，或费用未结清'
  if (action === 'payment') return '收款没有通过。最常见的是方案还没确认，或金额超过剩余应收'
  return null
}

interface WriteOutcome {
  operationId: string
  entityId: string | null
  entityVersion: number | null
  state: string | null
  effects: Record<string, unknown>
  summary: string
}

function writeResponse(result: Awaited<ReturnType<typeof createServiceOrder>>, action: ServiceAction): Response {
  if (result.ok) {
    const outcome = result.outcome
    const data: WriteOutcome = {
      operationId: result.requestId,
      entityId: outcome.entityId ?? null,
      entityVersion: outcome.version ?? null,
      state: typeof outcome.effects?.toState === 'string' ? (outcome.effects.toState as string) : null,
      effects: outcome.effects ?? {},
      summary: outcome.summary ?? '',
    }
    return ok(data, result.requestId)
  }
  const message = appendReadableDiagnostic(guidanceFor(result.code, result.message, action) ?? result.message, result.diagnostic)
  return fail(result.code, message, result.httpStatus, { requestId: result.requestId, currentVersion: result.currentVersion })
}

// ────────────────────────────── 路由 ──────────────────────────────

async function handleIntake(req: Request, env: ServiceRouteEnv, context: ServiceRouteContext): Promise<Response> {
  const denied = requireGrant(context, SERVICE_PERMISSIONS.edit)
  if (denied) return denied

  const { body, response } = await readJson(req)
  if (!body) return response!

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const accessories = Array.isArray(body.accessories)
    ? body.accessories.filter((v): v is string => typeof v === 'string')
    : null
  const input: IntakeInput = {
    customerId: asNullableInt(body.customerId),
    customerName: asText(body.customerName) ?? '',
    deviceCode: asText(body.deviceCode) ?? '',
    symptom: asText(body.symptom) ?? '',
    accessories,
    appearance: asText(body.appearance),
    originalOrderId: asText(body.originalOrderId),
    warrantyDecision: asText(body.warrantyDecision),
  }
  if (!input.symptom) {
    return fail('VALIDATION_ERROR', '缺客户描述（symptom）', 400, { requestId })
  }

  const result = await createServiceOrder(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B20', payloadHash: '' },
    input,
  )
  return writeResponse(result, 'intake')
}

async function handleDiagnosis(req: Request, env: ServiceRouteEnv, context: ServiceRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, SERVICE_PERMISSIONS.edit)
  if (denied) return denied
  const { body, response } = await readJson(req)
  if (!body) return response!
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)
  const orderId = decodeId(rawId)
  if (!orderId) return fail('VALIDATION_ERROR', '工单编号无法解析', 400, { requestId })

  const input: DiagnosisInput = { diagnosisNote: asText(body.diagnosisNote) ?? '' }
  const result = await saveDiagnosis(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B21', payloadHash: '' },
    orderId,
    input,
  )
  return writeResponse(result, 'diagnosis')
}

async function handleProposal(req: Request, env: ServiceRouteEnv, context: ServiceRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, SERVICE_PERMISSIONS.edit)
  if (denied) return denied
  const { body, response } = await readJson(req)
  if (!body) return response!
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)
  const orderId = decodeId(rawId)
  if (!orderId) return fail('VALIDATION_ERROR', '工单编号无法解析', 400, { requestId })

  const rawItems = Array.isArray(body.items) ? body.items : []
  const items: ProposalItemInput[] = []
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    items.push({
      name: asText(item.name) ?? '',
      qty: asInt(item.qty) ?? 0,
      unitPriceCents: asInt(item.unitPriceCents) ?? -1,
      chargeType: (asText(item.chargeType) === 'warranty' ? 'warranty' : 'charge') as ProposalItemInput['chargeType'],
    })
  }
  const input: ProposalInput = {
    items,
    chargeCents: asInt(body.chargeCents) ?? -1,
    warrantyDecision: asText(body.warrantyDecision),
  }
  const result = await saveProposal(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B21', payloadHash: '' },
    orderId,
    input,
  )
  return writeResponse(result, 'proposal')
}

async function handleConfirm(req: Request, env: ServiceRouteEnv, context: ServiceRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, SERVICE_PERMISSIONS.edit)
  if (denied) return denied
  const { body, response } = await readJson(req)
  if (!body) return response!
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)
  const orderId = decodeId(rawId)
  if (!orderId) return fail('VALIDATION_ERROR', '工单编号无法解析', 400, { requestId })

  const confirmedAt = asText(body.confirmedAt) ?? ''
  const accepted = asBool(body.accepted)
  if (accepted === null || !confirmedAt) {
    return fail('VALIDATION_ERROR', '缺 accepted 或 confirmedAt', 400, { requestId })
  }
  const input: ConfirmProposalInput = {
    proposalVersion: asInt(body.proposalVersion) ?? 0,
    confirmationMethod: asText(body.confirmationMethod) ?? '',
    confirmedAt,
    note: asText(body.note),
    accepted,
  }
  const result = await confirmProposal(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B22', payloadHash: '' },
    orderId,
    input,
  )
  return writeResponse(result, 'confirm')
}

async function handleReplace(req: Request, env: ServiceRouteEnv, context: ServiceRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, SERVICE_PERMISSIONS.edit)
  if (denied) return denied
  const { body, response } = await readJson(req)
  if (!body) return response!
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)
  const orderId = decodeId(rawId)
  if (!orderId) return fail('VALIDATION_ERROR', '工单编号无法解析', 400, { requestId })

  const rawComponents = Array.isArray(body.components) ? body.components : []
  const components: ReplaceComponentInput[] = []
  for (const raw of rawComponents) {
    if (!raw || typeof raw !== 'object') continue
    const comp = raw as Record<string, unknown>
    components.push({
      oldComponentRef: asText(comp.oldComponentRef) ?? '',
      oldItemDisposition: asText(comp.oldItemDisposition) ?? '',
      newStockItem: asText(comp.newStockItem),
      qty: asInt(comp.qty) ?? undefined,
      costCents: asNullableInt(comp.costCents),
      chargeType: (asText(comp.chargeType) === 'warranty' ? 'warranty' : 'charge') as ReplaceComponentInput['chargeType'],
    })
  }
  const input: ReplaceInput = {
    components,
    approvedProposalVersion: asInt(body.approvedProposalVersion) ?? 0,
  }
  const result = await replacePart(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B23', payloadHash: '' },
    orderId,
    input,
  )
  return writeResponse(result, 'replace')
}

async function handleDispatch(req: Request, env: ServiceRouteEnv, context: ServiceRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, SERVICE_PERMISSIONS.edit)
  if (denied) return denied
  const { body, response } = await readJson(req)
  if (!body) return response!
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)
  const orderId = decodeId(rawId)
  if (!orderId) return fail('VALIDATION_ERROR', '工单编号无法解析', 400, { requestId })

  const input: DispatchInput = {
    receiver: asText(body.receiver) ?? '',
    logistics: asText(body.logistics),
    expectedReturnAt: asText(body.expectedReturnAt),
    note: asText(body.note),
  }
  const result = await dispatchExternal(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B24', payloadHash: '' },
    orderId,
    input,
  )
  return writeResponse(result, 'dispatch')
}

async function handleReceiveExternal(req: Request, env: ServiceRouteEnv, context: ServiceRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, SERVICE_PERMISSIONS.edit)
  if (denied) return denied
  const { body, response } = await readJson(req)
  if (!body) return response!
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)
  const orderId = decodeId(rawId)
  if (!orderId) return fail('VALIDATION_ERROR', '工单编号无法解析', 400, { requestId })

  const input: ReceiveExternalInput = { note: asText(body.note) }
  const result = await receiveExternal(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B24', payloadHash: '' },
    orderId,
    input,
  )
  return writeResponse(result, 'receive-external')
}

async function handleRetest(req: Request, env: ServiceRouteEnv, context: ServiceRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, SERVICE_PERMISSIONS.edit)
  if (denied) return denied
  const { body, response } = await readJson(req)
  if (!body) return response!
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)
  const orderId = decodeId(rawId)
  if (!orderId) return fail('VALIDATION_ERROR', '工单编号无法解析', 400, { requestId })

  const passed = asBool(body.passed)
  if (passed === null) return fail('VALIDATION_ERROR', '缺 passed（复测是否通过）', 400, { requestId })
  const input: RetestInput = { passed, note: asText(body.note) }
  const result = await retestDevice(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B25', payloadHash: '' },
    orderId,
    input,
  )
  return writeResponse(result, 'retest')
}

async function handleReturn(req: Request, env: ServiceRouteEnv, context: ServiceRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, SERVICE_PERMISSIONS.edit)
  if (denied) return denied
  const { body, response } = await readJson(req)
  if (!body) return response!
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)
  const orderId = decodeId(rawId)
  if (!orderId) return fail('VALIDATION_ERROR', '工单编号无法解析', 400, { requestId })

  const input: ReturnDeviceInput = {
    returnedTo: asText(body.returnedTo) ?? '',
    note: asText(body.note),
  }
  const result = await returnDevice(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B25', payloadHash: '' },
    orderId,
    input,
  )
  return writeResponse(result, 'return')
}

async function handlePayment(req: Request, env: ServiceRouteEnv, context: ServiceRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, SERVICE_PERMISSIONS.charge)
  if (denied) return denied
  const { body, response } = await readJson(req)
  if (!body) return response!
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)
  const orderId = decodeId(rawId)
  if (!orderId) return fail('VALIDATION_ERROR', '工单编号无法解析', 400, { requestId })

  const input: ServicePaymentInput = {
    amountCents: asInt(body.amountCents) ?? 0,
    method: asText(body.method) ?? '',
    occurredAt: asText(body.occurredAt) ?? '',
    remark: asText(body.remark),
  }
  const result = await registerServicePayment(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B41', payloadHash: '' },
    orderId,
    input,
  )
  return writeResponse(result, 'payment')
}

async function handleList(req: Request, env: ServiceRouteEnv, context: ServiceRouteContext): Promise<Response> {
  const denied = requireGrant(context, SERVICE_PERMISSIONS.view)
  if (denied) return denied
  const url = new URL(req.url)
  const state = url.searchParams.get('state')
  const orders = await queryServiceOrders(env.DB, context.storeId, { state, q: url.searchParams.get('q'), limit: 50 })
  return ok({ orders }, null)
}

async function handleDetail(req: Request, env: ServiceRouteEnv, context: ServiceRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, SERVICE_PERMISSIONS.view)
  if (denied) return denied
  const orderId = decodeId(rawId)
  if (!orderId) return fail('VALIDATION_ERROR', '工单编号无法解析', 400)
  const detail = await queryServiceOrderDetail(env.DB, context.storeId, orderId)
  if (!detail) return fail('ENTITY_NOT_FOUND', '维修工单不存在或不属于当前门店', 404)
  return ok({ order: detail }, null)
}

/**
 * 分发入口。返回 null 表示「不是本模块的路径」。
 * 只认领 /api/v2/service/ 前缀，与其他模块路径无重叠。
 */
export async function routeServiceV2(
  req: Request,
  env: ServiceRouteEnv,
  context: ServiceRouteContext,
): Promise<Response | null> {
  const path = new URL(req.url).pathname
  if (!path.startsWith(`${PREFIX}/service/`)) return null

  if (path === ORDERS_PATH) {
    if (req.method === 'GET') return handleList(req, env, context)
    if (req.method === 'POST') return handleIntake(req, env, context)
    return fail('VALIDATION_ERROR', '该方法不支持', 405)
  }

  const diagnosisMatch = ORDER_DIAGNOSIS_PATH.exec(path)
  if (diagnosisMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleDiagnosis(req, env, context, diagnosisMatch[1])
  }

  const proposalMatch = ORDER_PROPOSAL_PATH.exec(path)
  if (proposalMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleProposal(req, env, context, proposalMatch[1])
  }

  const confirmMatch = ORDER_CONFIRM_PATH.exec(path)
  if (confirmMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleConfirm(req, env, context, confirmMatch[1])
  }

  const replaceMatch = ORDER_REPLACE_PATH.exec(path)
  if (replaceMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleReplace(req, env, context, replaceMatch[1])
  }

  const dispatchMatch = ORDER_DISPATCH_PATH.exec(path)
  if (dispatchMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleDispatch(req, env, context, dispatchMatch[1])
  }

  const receiveExternalMatch = ORDER_RECEIVE_EXTERNAL_PATH.exec(path)
  if (receiveExternalMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleReceiveExternal(req, env, context, receiveExternalMatch[1])
  }

  const retestMatch = ORDER_RETEST_PATH.exec(path)
  if (retestMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleRetest(req, env, context, retestMatch[1])
  }

  const returnMatch = ORDER_RETURN_PATH.exec(path)
  if (returnMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleReturn(req, env, context, returnMatch[1])
  }

  const paymentMatch = ORDER_PAYMENTS_PATH.exec(path)
  if (paymentMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handlePayment(req, env, context, paymentMatch[1])
  }

  const detailMatch = ORDER_DETAIL_PATH.exec(path)
  if (detailMatch) {
    if (req.method !== 'GET') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleDetail(req, env, context, detailMatch[1])
  }

  return fail('VALIDATION_ERROR', '该方法不支持', 405)
}
