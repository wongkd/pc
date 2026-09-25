/**
 * E10 · 售后维修与收款闭环：B20 接修、B21 检测方案、B22 方案确认、B23 换件、B24 外送、
 * B25 复测归还、B41 售后收款 + R09 读模型。
 *
 * 契约依据（contracts/v1）：
 *   actions.json  B20  POST /service/orders（service/edit）
 *                 B21  POST /service/orders/:id/diagnosis + /proposal（service/edit）
 *                 B22  POST /service/orders/:id/confirm-proposal（service/edit）
 *                 B23  POST /service/orders/:id/replace（service/edit）
 *                 B24  POST /service/orders/:id/dispatch + /receive-external（service/edit）
 *                 B25  POST /service/orders/:id/retest + /return（service/edit）
 *                 B41  POST /service/orders/:id/payments（service/charge）
 *   objects.json  ServiceOrder / CustomerDevice / DeviceConfiguration / DeviceChange
 *   enums.json    ServiceState（received→…→returned）；LocationKind；WarrantyDecision；ConfirmationMethod
 *   money-rules   balanceDirectionFor（余额方向）
 *
 * ── 四条硬边界在这份代码里的落点 ──
 *
 * 1.「客户财产不计自有库存」（R03）
 *    接修（B20）把设备写进 customer_device_custody（custodyLocation='store'），
 *    不进 stock_items / stock_balances。只有换件（B23）领用自有备件时才碰自有库存。
 *
 * 2.「未确认费用不进入应收」（objects.json ServiceOrder.rules 第 1 条）
 *    confirmed_charge_cents 在方案确认（B22）前恒为 NULL，balance 恒为 0；
 *    收款（B41）只允许在方案确认后发生（守卫 confirmed_charge_cents 非空）。
 *
 * 3.「归还闸门：费用结清才归还」（栋哥 2026-09-21 拍板，首版不做欠款归还）
 *    B25 复测通过要进入 ready_return 时校验 balance_cents = 0，否则拒绝。
 *
 * 4.「换件扣自有备件，独立于销售交付」（03 §4）
 *    备件从 available 扣（source=service_part_consumption，available→sold），
 *    记维修成本；旧件去向（oldItemDisposition）记录在 device_changes.components_json。
 *
 * 5.「收款与归还两次动作独立可追溯」
 *    B41（收款）与 B25（归还）是两次独立 runIdempotent，钱收了、货还没还，账依然成立。
 */

import {
  assertRowVersionStatement,
  bumpVersionStatement,
  guardStatement,
  hashPayload,
  queryOperation,
  runIdempotent,
  type OperationContext,
  type OperationPlan,
  type OperationsDb,
  type RunResult,
} from './operations'
import { generateInternalCode } from './serial-codes'
import { listAttachedForOwner, type AttachmentView } from './attachment'
import { balanceDirectionFor, CASH_METHODS } from './sale'

// ─────────────────────────────── 常量与工具 ───────────────────────────────

const SERVICE_STATES = [
  'received',
  'diagnosing',
  'awaiting_approval',
  'repairing',
  'outsourced',
  'retesting',
  'ready_return',
  'returned',
  'closed',
] as const
export type ServiceState = (typeof SERVICE_STATES)[number]

const CONFIRMATION_METHODS = ['phone', 'wechat', 'in_person', 'other'] as const

const WARRANTY_DECISIONS = ['in_warranty', 'out_of_warranty', 'undetermined'] as const

const CUSTODY_LOCATIONS = ['store', 'customer', 'external', 'supplier'] as const

const OLD_ITEM_DISPOSITIONS = ['return_to_customer', 'scrapped', 'quarantine', 'return_to_supplier'] as const

const MAX_LINES = 200

type FailCode =
  | 'VALIDATION_ERROR'
  | 'ENTITY_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'STOCK_CONFLICT'
  | 'BALANCE_EXCEEDED'
  | 'OWNERSHIP_INVALID'

interface Failure {
  ok: false
  requestId: string
  code: FailCode
  message: string
  retryable: false
  httpStatus: number
}

function fail(requestId: string, code: FailCode, message: string, httpStatus: number): Failure {
  return { ok: false, requestId, code, message, retryable: false, httpStatus }
}

/** 维修工单号：SV- 前缀 + 日期 + requestId 全串哈希（对齐 sale.orderNoFor 的防撞号口径）。 */
export function serviceOrderNoFor(requestId: string, now: string): string {
  const date = now.slice(0, 10).replace(/-/g, '')
  return `SV-${date}-${stableHash8(requestId)}`
}

/** 与 sale.ts 的 stableHash8 同一实现，避免跨文件复制产生两套哈希。 */
function stableHash8(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d) >>> 0
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x846ca68b) >>> 0
  hash ^= hash >>> 16
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

// ─────────────────────────────── 读辅助 ───────────────────────────────

export interface ServiceOrderRow {
  id: string
  order_no: string
  customer_id: number | null
  device_id: string
  symptom: string
  intake_snapshot: string
  state: string
  proposal_version: number | null
  confirmed_charge_cents: number | null
  warranty_decision: string | null
  due_at: string | null
  cash_net_cents: number
  balance_cents: number
  balance_direction: string
  note: string
  version: number
  created_at: string
  updated_at: string
}

export async function readServiceOrder(
  db: OperationsDb,
  storeId: number,
  orderId: string,
): Promise<ServiceOrderRow | null> {
  const row = await db
    .prepare(
      `SELECT id, order_no, customer_id, device_id, symptom, intake_snapshot, state,
              proposal_version, confirmed_charge_cents, warranty_decision, due_at,
              cash_net_cents, balance_cents, balance_direction, note, version, created_at, updated_at
       FROM service_orders WHERE store_id = ? AND id = ?`,
    )
    .bind(storeId, orderId)
    .first<ServiceOrderRow>()
  return row ?? null
}

interface CustomerDeviceRow {
  id: string
  owner_customer_id: number | null
  device_code: string
  manufacturer_sn: string | null
  original_order_id: string | null
  current_configuration_id: string | null
  custody_location: string
  stock_item_ref: string | null
}

async function readCustomerDevice(
  db: OperationsDb,
  storeId: number,
  deviceId: string,
): Promise<CustomerDeviceRow | null> {
  const row = await db
    .prepare(
      `SELECT id, owner_customer_id, device_code, manufacturer_sn, original_order_id, current_configuration_id,
              custody_location, stock_item_ref
       FROM customer_device_custody WHERE store_id = ? AND id = ?`,
    )
    .bind(storeId, deviceId)
    .first<CustomerDeviceRow>()
  return row ?? null
}

// ─────────────────────────────── B20 接修登记 ───────────────────────────────

export interface IntakeInput {
  customerId: number | null
  customerName: string
  deviceCode: string
  symptom: string
  accessories?: string[] | null
  appearance?: string | null
  originalOrderId?: string | null
  warrantyDecision?: string | null
}

/** B20 入口：建客户设备保管 + 维修工单（received）。 */
export async function createServiceOrder(
  db: OperationsDb,
  ctx: OperationContext,
  input: IntakeInput,
): Promise<RunResult> {
  const action = 'B20'
  const payloadHash = await hashPayload({ input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const manufacturerSn = (input.deviceCode ?? '').trim() || null
  const symptom = (input.symptom ?? '').trim()
  if (!symptom) return fail(ctx.requestId, 'VALIDATION_ERROR', '必须填客户描述（symptom）', 400)
  const customerName = (input.customerName ?? '').trim()
  if (input.customerId === null && !customerName) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '散客必须填客户称呼（customerName）', 400)
  }
  if (input.warrantyDecision !== null && input.warrantyDecision !== undefined
    && !(WARRANTY_DECISIONS as readonly string[]).includes(input.warrantyDecision)) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', 'warrantyDecision 取值不合法', 400)
  }

  const now = new Date().toISOString()
  const deviceCode = generateInternalCode('DV', ctx.storeId, now)
  const deviceId = `${ctx.requestId}::device`
  const orderId = `${ctx.requestId}::order`
  const orderNo = serviceOrderNoFor(ctx.requestId, now)
  const intakeSnapshot = JSON.stringify({
    customerName,
    accessories: Array.isArray(input.accessories) ? input.accessories : [],
    appearance: (input.appearance ?? '').trim() || null,
    intakePhotos: [],
  })

  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements = [
      db
        .prepare(
          `INSERT INTO customer_device_custody
             (id, store_id, owner_customer_id, device_code, manufacturer_sn, original_order_id,
              current_configuration_id, custody_location, stock_item_ref, version, request_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'store', NULL, 1, ?, ?)`,
        )
        .bind(
          deviceId,
          context.storeId,
          input.customerId,
          deviceCode,
          manufacturerSn,
          (input.originalOrderId ?? '').trim() || null,
          context.requestId,
          context.actorUserId,
        ),
      guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM customer_device_custody WHERE store_id = ? AND id = ?)', context.storeId, deviceId),
      db
        .prepare(
          `INSERT INTO service_orders
             (id, store_id, order_no, customer_id, device_id, symptom, intake_snapshot, state,
              proposal_version, confirmed_charge_cents, warranty_decision, due_at,
              cash_net_cents, balance_cents, balance_direction, note, version, request_id, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'received', NULL, NULL, ?, NULL, 0, 0, 'settled', '', 1, ?, ?, ?)`,
        )
        .bind(
          orderId,
          context.storeId,
          orderNo,
          input.customerId,
          deviceId,
          symptom,
          intakeSnapshot,
          input.warrantyDecision ?? null,
          context.requestId,
          context.actorUserId,
          context.actorUserId,
        ),
      guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ?)', context.storeId, orderId),
    ]
    return {
      statements,
      outcome: {
        entityType: 'ServiceOrder',
        entityId: orderId,
        version: 1,
        summary: `接修登记 ${orderNo}（${deviceCode}）`,
        effects: { orderNo, deviceId, state: 'received' },
      },
    }
  })
}

// ─────────────────────────────── B21 录入检测与维修方案 ───────────────────────────────

export interface DiagnosisInput {
  diagnosisNote: string
}

/** B21a：received → diagnosing（内部诊断与客户描述分开，objects.json ServiceOrder）。 */
export async function saveDiagnosis(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: DiagnosisInput,
): Promise<RunResult> {
  const action = 'B21'
  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const note = (input.diagnosisNote ?? '').trim()
  if (!note) return fail(ctx.requestId, 'VALIDATION_ERROR', '必须填内部诊断说明（diagnosisNote）', 400)

  const order = await readServiceOrder(db, ctx.storeId, orderId)
  if (!order) return fail(ctx.requestId, 'ENTITY_NOT_FOUND', '维修工单不存在或不属于当前门店', 404)
  if (order.state !== 'received') {
    return fail(ctx.requestId, 'VALIDATION_ERROR', `工单当前是「${order.state}」，不能开始检测`, 400)
  }

  const now = new Date().toISOString()
  const nextVersion = order.version + 1
  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements = [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ?)', context.storeId, order.id),
      guardStatement(db, 'VERSION_CONFLICT', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ? AND version = ?)', context.storeId, order.id, order.version),
      db
        .prepare(
          `UPDATE service_orders
           SET state = 'diagnosing', note = ?, version = version + 1, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ? AND state = 'received'`,
        )
        .bind(note, context.actorUserId, now, context.storeId, order.id, order.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'service_orders', 'id', order.id, nextVersion),
      bumpVersionStatement(db, context, 'ServiceOrder', order.id, nextVersion),
      db
        .prepare(
          `INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details)
           VALUES (?, ?, 'B21.diagnosis', 'ServiceOrder', ?, ?)`,
        )
        .bind(context.storeId, context.actorUserId, order.id, JSON.stringify({ diagnosisNote: note, at: now })),
    ]
    return {
      statements,
      outcome: {
        entityType: 'ServiceOrder',
        entityId: order.id,
        version: nextVersion,
        summary: `已录入内部诊断，进入检测`,
        effects: { fromState: 'received', toState: 'diagnosing' },
      },
    }
  })
}

export interface ProposalInput {
  items: ProposalItemInput[]
  chargeCents: number
  warrantyDecision?: string | null
}

export interface ProposalItemInput {
  name: string
  qty: number
  unitPriceCents: number
  chargeType: 'charge' | 'warranty'
}

/** B21b：diagnosing → awaiting_approval（形成方案版本 + 报价，等待客户确认）。 */
export async function saveProposal(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: ProposalInput,
): Promise<RunResult> {
  const action = 'B21'
  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '维修方案至少要有一项', 400)
  }
  if (input.items.length > MAX_LINES) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', `维修方案最多 ${MAX_LINES} 项`, 400)
  }
  for (const [index, item] of input.items.entries()) {
    const at = `第 ${index + 1} 项`
    if (typeof item.name !== 'string' || !item.name.trim()) return fail(ctx.requestId, 'VALIDATION_ERROR', `${at}缺名称`, 400)
    if (!Number.isInteger(item.qty) || item.qty <= 0) return fail(ctx.requestId, 'VALIDATION_ERROR', `${at}数量必须是正整数`, 400)
    if (!Number.isInteger(item.unitPriceCents) || item.unitPriceCents < 0) return fail(ctx.requestId, 'VALIDATION_ERROR', `${at}单价必须是整数分`, 400)
    if (item.chargeType !== 'charge' && item.chargeType !== 'warranty') return fail(ctx.requestId, 'VALIDATION_ERROR', `${at}chargeType 只能是 charge / warranty`, 400)
  }
  if (!Number.isInteger(input.chargeCents) || input.chargeCents < 0) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '维修收费必须是整数分', 400)
  }
  if (input.warrantyDecision !== null && input.warrantyDecision !== undefined
    && !(WARRANTY_DECISIONS as readonly string[]).includes(input.warrantyDecision)) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', 'warrantyDecision 取值不合法', 400)
  }

  const order = await readServiceOrder(db, ctx.storeId, orderId)
  if (!order) return fail(ctx.requestId, 'ENTITY_NOT_FOUND', '维修工单不存在或不属于当前门店', 404)
  if (order.state !== 'diagnosing' && order.state !== 'awaiting_approval') {
    return fail(ctx.requestId, 'VALIDATION_ERROR', `工单当前是「${order.state}」，不能录入方案`, 400)
  }

  const proposalVersion = (order.proposal_version ?? 0) + 1
  const now = new Date().toISOString()
  const nextVersion = order.version + 1
  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements = [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ?)', context.storeId, order.id),
      guardStatement(db, 'VERSION_CONFLICT', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ? AND version = ?)', context.storeId, order.id, order.version),
      db
        .prepare(
          `UPDATE service_orders
           SET state = 'awaiting_approval', proposal_version = ?, note = ?, version = version + 1,
               updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ?`,
        )
        .bind(proposalVersion, JSON.stringify({ items: input.items, chargeCents: input.chargeCents, warrantyDecision: input.warrantyDecision ?? null }), context.actorUserId, now, context.storeId, order.id, order.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'service_orders', 'id', order.id, nextVersion),
      bumpVersionStatement(db, context, 'ServiceOrder', order.id, nextVersion),
      db
        .prepare(
          `INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details)
           VALUES (?, ?, 'B21.proposal', 'ServiceOrder', ?, ?)`,
        )
        .bind(context.storeId, context.actorUserId, order.id, JSON.stringify({ proposalVersion, items: input.items, chargeCents: input.chargeCents, at: now })),
    ]
    return {
      statements,
      outcome: {
        entityType: 'ServiceOrder',
        entityId: order.id,
        version: nextVersion,
        summary: `已录入维修方案第 ${proposalVersion} 版（合计 ${(input.chargeCents / 100).toFixed(2)} 元），等待客户确认`,
        effects: { fromState: order.state, toState: 'awaiting_approval', proposalVersion, chargeCents: input.chargeCents },
      },
    }
  })
}

// ─────────────────────────────── B22 记录方案确认 ───────────────────────────────

export interface ConfirmProposalInput {
  proposalVersion: number
  confirmationMethod: string
  confirmedAt: string
  note?: string | null
  accepted: boolean
}

/** B22 入口：awaiting_approval → repairing（接受）或 ready_return（拒绝 / 无需维修）。 */
export async function confirmProposal(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: ConfirmProposalInput,
): Promise<RunResult> {
  const action = 'B22'
  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  if (!(CONFIRMATION_METHODS as readonly string[]).includes(input.confirmationMethod)) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '确认方式只能是 phone / wechat / in_person / other', 400)
  }
  if (!Number.isInteger(input.proposalVersion) || input.proposalVersion <= 0) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', 'proposalVersion 必须是正整数', 400)
  }
  if (Number.isNaN(new Date(input.confirmedAt).getTime())) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '确认时间不合法', 400)
  }

  const order = await readServiceOrder(db, ctx.storeId, orderId)
  if (!order) return fail(ctx.requestId, 'ENTITY_NOT_FOUND', '维修工单不存在或不属于当前门店', 404)
  if (order.state !== 'awaiting_approval') {
    return fail(ctx.requestId, 'VALIDATION_ERROR', `工单当前是「${order.state}」，不能记录方案确认`, 400)
  }
  if (order.proposal_version !== input.proposalVersion) {
    return fail(ctx.requestId, 'VERSION_CONFLICT', `要确认的是方案第 ${input.proposalVersion} 版，当前是第 ${order.proposal_version} 版`, 409)
  }

  // 从 note（方案快照）里取出已确认收费金额。方案保存时已把 items/chargeCents 写进 note。
  let confirmedCharge = 0
  try {
    const parsed = JSON.parse(order.note) as { chargeCents?: number }
    if (Number.isInteger(parsed.chargeCents)) confirmedCharge = parsed.chargeCents
  } catch {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '方案快照损坏，无法确认收费', 400)
  }

  const now = new Date().toISOString()
  const nextVersion = order.version + 1
  const toState = input.accepted ? 'repairing' : 'ready_return'
  // 拒绝维修 / 无需维修：没有应收，confirmed_charge_cents 归零（否则违反余额恒等式 CHECK）。
  const nextConfirmedCharge = input.accepted ? confirmedCharge : 0
  const nextBalance = nextConfirmedCharge
  const nextDirection = balanceDirectionFor(nextBalance)

  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements = [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ?)', context.storeId, order.id),
      guardStatement(db, 'VERSION_CONFLICT', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ? AND version = ?)', context.storeId, order.id, order.version),
      db
        .prepare(
          `UPDATE service_orders
           SET state = ?, confirmed_charge_cents = ?, cash_net_cents = 0, balance_cents = ?,
               balance_direction = ?, version = version + 1, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ? AND state = 'awaiting_approval'`,
        )
        .bind(toState, nextConfirmedCharge, nextBalance, nextDirection, context.actorUserId, now, context.storeId, order.id, order.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'service_orders', 'id', order.id, nextVersion),
      bumpVersionStatement(db, context, 'ServiceOrder', order.id, nextVersion),
      db
        .prepare(
          `INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details)
           VALUES (?, ?, 'B22.confirm', 'ServiceOrder', ?, ?)`,
        )
        .bind(context.storeId, context.actorUserId, order.id, JSON.stringify({ proposalVersion: input.proposalVersion, confirmationMethod: input.confirmationMethod, accepted: input.accepted, confirmedCharge, at: now })),
    ]
    return {
      statements,
      outcome: {
        entityType: 'ServiceOrder',
        entityId: order.id,
        version: nextVersion,
        summary: input.accepted
          ? `方案已确认（${(confirmedCharge / 100).toFixed(2)} 元），开始维修`
          : `客户拒绝维修 / 无需维修，转待归还`,
        effects: { fromState: 'awaiting_approval', toState, confirmedChargeCents: nextConfirmedCharge },
      },
    }
  })
}

// ─────────────────────────────── B23 换件 ───────────────────────────────

export interface ReplaceComponentInput {
  oldComponentRef: string
  oldItemDisposition: string
  newStockItem?: string | null
  qty?: number
  costCents?: number | null
  chargeType: 'charge' | 'warranty'
}

export interface ReplaceInput {
  components: ReplaceComponentInput[]
  approvedProposalVersion: number
}

/** B23 入口：repairing → retesting，领用自有备件（available→sold），记录换件事件与配置版本。 */
export async function replacePart(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: ReplaceInput,
): Promise<RunResult> {
  const action = 'B23'
  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  if (!Array.isArray(input.components) || input.components.length === 0) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '换件至少要有一项', 400)
  }
  if (input.components.length > MAX_LINES) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', `换件最多 ${MAX_LINES} 项`, 400)
  }
  for (const [index, comp] of input.components.entries()) {
    const at = `第 ${index + 1} 项`
    if (typeof comp.oldComponentRef !== 'string' || !comp.oldComponentRef.trim()) return fail(ctx.requestId, 'VALIDATION_ERROR', `${at}缺旧件引用（oldComponentRef）`, 400)
    if (!(OLD_ITEM_DISPOSITIONS as readonly string[]).includes(comp.oldItemDisposition)) return fail(ctx.requestId, 'VALIDATION_ERROR', `${at}旧件去向不合法`, 400)
    if (comp.chargeType !== 'charge' && comp.chargeType !== 'warranty') return fail(ctx.requestId, 'VALIDATION_ERROR', `${at}chargeType 只能是 charge / warranty`, 400)
    if (comp.newStockItem) {
      const qty = comp.qty ?? 1
      if (!Number.isInteger(qty) || qty <= 0) return fail(ctx.requestId, 'VALIDATION_ERROR', `${at}数量必须是正整数`, 400)
    }
  }
  if (!Number.isInteger(input.approvedProposalVersion) || input.approvedProposalVersion <= 0) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', 'approvedProposalVersion 必须是正整数', 400)
  }

  const order = await readServiceOrder(db, ctx.storeId, orderId)
  if (!order) return fail(ctx.requestId, 'ENTITY_NOT_FOUND', '维修工单不存在或不属于当前门店', 404)
  if (order.state !== 'repairing') {
    return fail(ctx.requestId, 'VALIDATION_ERROR', `工单当前是「${order.state}」，不能换件`, 400)
  }
  if (order.proposal_version !== input.approvedProposalVersion) {
    return fail(ctx.requestId, 'VERSION_CONFLICT', `换件依据的方案是第 ${input.approvedProposalVersion} 版，当前是第 ${order.proposal_version} 版`, 409)
  }

  // 领用的自有备件必须先核实都在 available，且读取成本。
  const stockItemIds = [...new Set(
    input.components.map((c) => (c.newStockItem ?? '').trim()).filter((v) => v !== ''),
  )]
  const costMap = new Map<string, { costCents: number | null }>()
  if (stockItemIds.length > 0) {
    const placeholders = stockItemIds.map(() => '?').join(', ')
    const rows = await db
      .prepare(
        `SELECT id, acquisition_cost_cents, refurbishment_cost_cents, cost_known
         FROM stock_items WHERE store_id = ? AND id IN (${placeholders}) AND availability = 'available'`,
      )
      .bind(ctx.storeId, ...stockItemIds)
      .all<{ id: string; acquisition_cost_cents: number | null; refurbishment_cost_cents: number | null; cost_known: number }>()
    for (const row of rows.results ?? []) {
      const known = row.cost_known === 1 && row.acquisition_cost_cents !== null
      costMap.set(row.id, {
        costCents: known ? (row.acquisition_cost_cents as number) + (row.refurbishment_cost_cents ?? 0) : null,
      })
    }
    for (const itemId of stockItemIds) {
      if (!costMap.has(itemId)) {
        return fail(ctx.requestId, 'STOCK_CONFLICT', `备件「${itemId}」不存在或不在可用库存里`, 409)
      }
    }
  }

  // 配置版本：接修时没有初始配置版本，换件从 1 起。
  const fromRevision = await readMaxConfigurationRevision(db, ctx.storeId, order.device_id)
  const toRevision = fromRevision + 1
  const now = new Date().toISOString()
  const nextVersion = order.version + 1
  const changeId = `${ctx.requestId}::change`
  const configurationId = `${ctx.requestId}::config`
  const componentsJson = JSON.stringify(
    input.components.map((comp) => ({
      oldComponentRef: comp.oldComponentRef.trim(),
      oldItemDisposition: comp.oldItemDisposition,
      newStockItem: (comp.newStockItem ?? '').trim() || null,
      qty: comp.newStockItem ? (comp.qty ?? 1) : 0,
      costCents: comp.newStockItem ? (costMap.get((comp.newStockItem ?? '').trim())?.costCents ?? null) : null,
      chargeType: comp.chargeType,
    })),
  )

  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements = [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ?)', context.storeId, order.id),
      guardStatement(db, 'VERSION_CONFLICT', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ? AND version = ?)', context.storeId, order.id, order.version),
      db
        .prepare(
          `INSERT INTO device_changes
             (id, store_id, device_id, service_order_id, from_revision, to_revision, components_json,
              effective_at, change_ref, version, request_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
        )
        .bind(changeId, context.storeId, order.device_id, order.id, fromRevision, toRevision, componentsJson, now, context.requestId, context.actorUserId),
      guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM device_changes WHERE store_id = ? AND id = ?)', context.storeId, changeId),
      db
        .prepare(
          `INSERT INTO device_configurations
             (id, store_id, device_id, revision, components_json, effective_at, change_ref, version, request_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(configurationId, context.storeId, order.device_id, toRevision, componentsJson, now, changeId, context.requestId, context.actorUserId),
      guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM device_configurations WHERE store_id = ? AND id = ?)', context.storeId, configurationId),
      db
        .prepare(
          `UPDATE customer_device_custody
           SET current_configuration_id = ?, version = version + 1, updated_at = ?
           WHERE store_id = ? AND id = ?`,
        )
        .bind(configurationId, now, context.storeId, order.device_id),
    ]

    // 领用自有备件：available → sold，来源 service_part_consumption，记维修成本。
    for (const [index, comp] of input.components.entries()) {
      if (!comp.newStockItem) continue
      const itemId = comp.newStockItem.trim()
      const cost = costMap.get(itemId)?.costCents ?? null
      statements.push(
        db
          .prepare(
            `UPDATE stock_items SET availability = 'sold', version = version + 1, updated_at = ?
             WHERE store_id = ? AND id = ? AND availability = 'available'`,
          )
          .bind(now, context.storeId, itemId),
        guardStatement(
          db,
          'STOCK_CONFLICT',
          `NOT EXISTS (SELECT 1 FROM stock_items WHERE store_id = ? AND id = ? AND availability = 'sold')`,
          context.storeId,
          itemId,
        ),
        db
          .prepare(
            `INSERT INTO inventory_movements
               (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
                source, occurred_at, actor_user_id, request_id)
             SELECT ?, si.store_id, si.product_id, si.id, ?, 'available', 'sold', ?,
                    'service_part_consumption', ?, ?, ?
             FROM stock_items si WHERE si.store_id = ? AND si.id = ?`,
          )
          .bind(
            `${context.requestId}::r-mv-${index}`,
            comp.qty ?? 1,
            cost,
            now,
            context.actorUserId,
            context.requestId,
            context.storeId,
            itemId,
          ),
      )
    }

    statements.push(
      db
        .prepare(
          `UPDATE service_orders
           SET state = 'retesting', version = version + 1, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ? AND state = 'repairing'`,
        )
        .bind(context.actorUserId, now, context.storeId, order.id, order.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'service_orders', 'id', order.id, nextVersion),
      bumpVersionStatement(db, context, 'ServiceOrder', order.id, nextVersion),
    )

    return {
      statements,
      outcome: {
        entityType: 'ServiceOrder',
        entityId: order.id,
        version: nextVersion,
        summary: `换件完成，进入复测`,
        effects: { fromState: 'repairing', toState: 'retesting', changeId, toRevision },
      },
    }
  })
}

async function readMaxConfigurationRevision(
  db: OperationsDb,
  storeId: number,
  deviceId: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT MAX(revision) AS max_rev FROM device_configurations WHERE store_id = ? AND device_id = ?`)
    .bind(storeId, deviceId)
    .first<{ max_rev: number | null }>()
  return Number(row?.max_rev ?? 0)
}

// ─────────────────────────────── B24 外送与返回 ───────────────────────────────

export interface DispatchInput {
  receiver: string
  logistics?: string | null
  expectedReturnAt?: string | null
  note?: string | null
}

/** B24a：awaiting_approval → outsourced（外送 / 返厂）。 */
export async function dispatchExternal(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: DispatchInput,
): Promise<RunResult> {
  const action = 'B24'
  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const receiver = (input.receiver ?? '').trim()
  if (!receiver) return fail(ctx.requestId, 'VALIDATION_ERROR', '必须填外送接收方（receiver）', 400)

  const order = await readServiceOrder(db, ctx.storeId, orderId)
  if (!order) return fail(ctx.requestId, 'ENTITY_NOT_FOUND', '维修工单不存在或不属于当前门店', 404)
  if (order.state !== 'awaiting_approval') {
    return fail(ctx.requestId, 'VALIDATION_ERROR', `工单当前是「${order.state}」，不能外送`, 400)
  }

  const now = new Date().toISOString()
  const nextVersion = order.version + 1
  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements = [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ?)', context.storeId, order.id),
      guardStatement(db, 'VERSION_CONFLICT', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ? AND version = ?)', context.storeId, order.id, order.version),
      db
        .prepare(
          `UPDATE service_orders
           SET state = 'outsourced', version = version + 1, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ? AND state = 'awaiting_approval'`,
        )
        .bind(context.actorUserId, now, context.storeId, order.id, order.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'service_orders', 'id', order.id, nextVersion),
      bumpVersionStatement(db, context, 'ServiceOrder', order.id, nextVersion),
      db
        .prepare(
          `UPDATE customer_device_custody
           SET custody_location = 'external', version = version + 1, updated_at = ?
           WHERE store_id = ? AND id = ?`,
        )
        .bind(now, context.storeId, order.device_id),
      db
        .prepare(
          `INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details)
           VALUES (?, ?, 'B24.dispatch', 'ServiceOrder', ?, ?)`,
        )
        .bind(context.storeId, context.actorUserId, order.id, JSON.stringify({ receiver, logistics: input.logistics ?? null, expectedReturnAt: input.expectedReturnAt ?? null, note: input.note ?? null, at: now })),
    ]
    return {
      statements,
      outcome: {
        entityType: 'ServiceOrder',
        entityId: order.id,
        version: nextVersion,
        summary: `已外送（${receiver}）`,
        effects: { fromState: 'awaiting_approval', toState: 'outsourced' },
      },
    }
  })
}

export interface ReceiveExternalInput {
  note?: string | null
}

/** B24b：outsourced → retesting（外送件返回待复测）。 */
export async function receiveExternal(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: ReceiveExternalInput,
): Promise<RunResult> {
  const action = 'B24'
  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const order = await readServiceOrder(db, ctx.storeId, orderId)
  if (!order) return fail(ctx.requestId, 'ENTITY_NOT_FOUND', '维修工单不存在或不属于当前门店', 404)
  if (order.state !== 'outsourced') {
    return fail(ctx.requestId, 'VALIDATION_ERROR', `工单当前是「${order.state}」，不能登记外送返回`, 400)
  }

  const now = new Date().toISOString()
  const nextVersion = order.version + 1
  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements = [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ?)', context.storeId, order.id),
      guardStatement(db, 'VERSION_CONFLICT', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ? AND version = ?)', context.storeId, order.id, order.version),
      db
        .prepare(
          `UPDATE service_orders
           SET state = 'retesting', version = version + 1, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ? AND state = 'outsourced'`,
        )
        .bind(context.actorUserId, now, context.storeId, order.id, order.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'service_orders', 'id', order.id, nextVersion),
      bumpVersionStatement(db, context, 'ServiceOrder', order.id, nextVersion),
      db
        .prepare(
          `UPDATE customer_device_custody
           SET custody_location = 'store', version = version + 1, updated_at = ?
           WHERE store_id = ? AND id = ?`,
        )
        .bind(now, context.storeId, order.device_id),
      db
        .prepare(
          `INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details)
           VALUES (?, ?, 'B24.receive-external', 'ServiceOrder', ?, ?)`,
        )
        .bind(context.storeId, context.actorUserId, order.id, JSON.stringify({ note: input.note ?? null, at: now })),
    ]
    return {
      statements,
      outcome: {
        entityType: 'ServiceOrder',
        entityId: order.id,
        version: nextVersion,
        summary: `外送件已返回，进入复测`,
        effects: { fromState: 'outsourced', toState: 'retesting' },
      },
    }
  })
}

// ─────────────────────────────── B25 复测与归还 ───────────────────────────────

export interface RetestInput {
  passed: boolean
  note?: string | null
}

/** B25a：retesting → ready_return（复测通过且费用结清）。 */
export async function retestDevice(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: RetestInput,
): Promise<RunResult> {
  const action = 'B25'
  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const order = await readServiceOrder(db, ctx.storeId, orderId)
  if (!order) return fail(ctx.requestId, 'ENTITY_NOT_FOUND', '维修工单不存在或不属于当前门店', 404)
  if (order.state !== 'retesting') {
    return fail(ctx.requestId, 'VALIDATION_ERROR', `工单当前是「${order.state}」，不能记录复测`, 400)
  }
  if (!input.passed) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '复测未通过：先继续维修，通过后再登记', 400)
  }
  // 归还闸门（栋哥拍板：严格收齐才归还）。复测通过进入待归还前，费用必须结清。
  if (order.balance_cents > 0) {
    return fail(
      ctx.requestId,
      'BALANCE_EXCEEDED',
      `维修费还没结清（待收 ${(order.balance_cents / 100).toFixed(2)} 元），先收款再复测通过`,
      409,
    )
  }

  const now = new Date().toISOString()
  const nextVersion = order.version + 1
  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements = [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ?)', context.storeId, order.id),
      guardStatement(db, 'VERSION_CONFLICT', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ? AND version = ?)', context.storeId, order.id, order.version),
      db
        .prepare(
          `UPDATE service_orders
           SET state = 'ready_return', version = version + 1, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ? AND state = 'retesting'`,
        )
        .bind(context.actorUserId, now, context.storeId, order.id, order.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'service_orders', 'id', order.id, nextVersion),
      bumpVersionStatement(db, context, 'ServiceOrder', order.id, nextVersion),
      db
        .prepare(
          `INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details)
           VALUES (?, ?, 'B25.retest', 'ServiceOrder', ?, ?)`,
        )
        .bind(context.storeId, context.actorUserId, order.id, JSON.stringify({ passed: true, note: input.note ?? null, at: now })),
    ]
    return {
      statements,
      outcome: {
        entityType: 'ServiceOrder',
        entityId: order.id,
        version: nextVersion,
        summary: `复测通过，可以归还`,
        effects: { fromState: 'retesting', toState: 'ready_return' },
      },
    }
  })
}

export interface ReturnDeviceInput {
  returnedTo: string
  note?: string | null
}

/** B25b：ready_return → returned（记录实际归还人与时间）。 */
export async function returnDevice(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: ReturnDeviceInput,
): Promise<RunResult> {
  const action = 'B25'
  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const returnedTo = (input.returnedTo ?? '').trim()
  if (!returnedTo) return fail(ctx.requestId, 'VALIDATION_ERROR', '必须填实际归还人（returnedTo）', 400)

  const order = await readServiceOrder(db, ctx.storeId, orderId)
  if (!order) return fail(ctx.requestId, 'ENTITY_NOT_FOUND', '维修工单不存在或不属于当前门店', 404)
  if (order.state !== 'ready_return') {
    return fail(ctx.requestId, 'VALIDATION_ERROR', `工单当前是「${order.state}」，不能归还`, 400)
  }
  if (order.balance_cents > 0) {
    return fail(ctx.requestId, 'BALANCE_EXCEEDED', '费用未结清，不能归还', 409)
  }

  const now = new Date().toISOString()
  const nextVersion = order.version + 1
  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements = [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ?)', context.storeId, order.id),
      guardStatement(db, 'VERSION_CONFLICT', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ? AND version = ?)', context.storeId, order.id, order.version),
      db
        .prepare(
          `UPDATE service_orders
           SET state = 'returned', version = version + 1, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ? AND state = 'ready_return'`,
        )
        .bind(context.actorUserId, now, context.storeId, order.id, order.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'service_orders', 'id', order.id, nextVersion),
      bumpVersionStatement(db, context, 'ServiceOrder', order.id, nextVersion),
      db
        .prepare(
          `UPDATE customer_device_custody
           SET custody_location = 'customer', version = version + 1, updated_at = ?
           WHERE store_id = ? AND id = ?`,
        )
        .bind(now, context.storeId, order.device_id),
      db
        .prepare(
          `INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details)
           VALUES (?, ?, 'B25.return', 'ServiceOrder', ?, ?)`,
        )
        .bind(context.storeId, context.actorUserId, order.id, JSON.stringify({ returnedTo, note: input.note ?? null, at: now })),
    ]
    return {
      statements,
      outcome: {
        entityType: 'ServiceOrder',
        entityId: order.id,
        version: nextVersion,
        summary: `已归还客户（${returnedTo}）`,
        effects: { fromState: 'ready_return', toState: 'returned' },
      },
    }
  })
}

// ─────────────────────────────── B41 售后收款 ───────────────────────────────

export interface ServicePaymentInput {
  amountCents: number
  method: string
  occurredAt: string
  remark?: string | null
}

/** B41 入口：登记售后收款，更新工单余额（复用 B08 资金字段，purpose=service_order）。 */
export async function registerServicePayment(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: ServicePaymentInput,
): Promise<RunResult> {
  const action = 'B41'
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '收款金额必须是正整数分', 400)
  }
  if (!(CASH_METHODS as readonly string[]).includes(input.method)) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '收款方式不合法', 400)
  }
  if (Number.isNaN(new Date(input.occurredAt).getTime())) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '收款时间不合法', 400)
  }

  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const order = await readServiceOrder(db, ctx.storeId, orderId)
  if (!order) return fail(ctx.requestId, 'ENTITY_NOT_FOUND', '维修工单不存在或不属于当前门店', 404)
  if (order.confirmed_charge_cents === null) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '方案还没确认，没有应收金额，不能收款', 400)
  }

  const amount = input.amountCents
  const nextCashNet = order.cash_net_cents + amount
  const nextBalance = (order.confirmed_charge_cents as number) - nextCashNet
  const nextDirection = balanceDirectionFor(nextBalance)
  const nextVersion = order.version + 1
  const entryId = `${ctx.requestId}::cash`
  const occurredAt = new Date(input.occurredAt).toISOString()

  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements = [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ?)', context.storeId, order.id),
      guardStatement(db, 'VERSION_CONFLICT', 'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ? AND version = ?)', context.storeId, order.id, order.version),
      // 超收：可收上限 = max(余额, 0)。
      guardStatement(
        db,
        'BALANCE_EXCEEDED',
        `EXISTS (SELECT 1 FROM service_orders
                 WHERE store_id = ? AND id = ?
                   AND ? > max(COALESCE(confirmed_charge_cents, 0) - cash_net_cents, 0))`,
        context.storeId,
        order.id,
        amount,
      ),
      db
        .prepare(
          `INSERT INTO cash_entries
             (id, store_id, direction, amount_cents, method, verification_state, verified_at,
              counterparty_kind, counterparty_ref, purpose, allocation_type, allocation_id,
              sale_order_id, occurred_at, remark, reversal_of, version, request_id, created_by)
           VALUES (?, ?, 'in', ?, ?, 'unverified', NULL, 'customer', ?, 'service_order', 'service_order', ?, NULL, ?, ?, NULL, 1, ?, ?)`,
        )
        .bind(
          entryId,
          context.storeId,
          amount,
          input.method,
          order.customer_id === null ? null : String(order.customer_id),
          order.id,
          occurredAt,
          (input.remark ?? '').trim(),
          context.requestId,
          context.actorUserId,
        ),
      guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM cash_entries WHERE store_id = ? AND id = ?)', context.storeId, entryId),
      db
        .prepare(
          `UPDATE service_orders
           SET cash_net_cents = ?, balance_cents = ?, balance_direction = ?,
               version = version + 1, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ?`,
        )
        .bind(nextCashNet, nextBalance, nextDirection, context.actorUserId, occurredAt, context.storeId, order.id, order.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'service_orders', 'id', order.id, nextVersion),
      guardStatement(
        db,
        'VALIDATION_ERROR',
        'NOT EXISTS (SELECT 1 FROM service_orders WHERE store_id = ? AND id = ? AND balance_cents = ?)',
        context.storeId,
        order.id,
        nextBalance,
      ),
      bumpVersionStatement(db, context, 'ServiceOrder', order.id, nextVersion),
    ]
    return {
      statements,
      outcome: {
        entityType: 'ServiceOrder',
        entityId: order.id,
        version: nextVersion,
        summary: `登记维修收款 ${(amount / 100).toFixed(2)} 元（${input.method}）`,
        effects: {
          orderNo: order.order_no,
          cashEntryId: entryId,
          cashNetCents: nextCashNet,
          balanceCents: nextBalance,
          balanceDirection: nextDirection,
        },
      },
    }
  })
}

// ─────────────────────────────── R09 读模型 ───────────────────────────────

export interface ServiceOrderSummary {
  id: string
  orderNo: string
  customerName: string
  deviceCode: string
  manufacturerSn: string | null
  symptom: string
  state: string
  confirmedChargeCents: number | null
  balanceCents: number
  version: number
  createdAt: string
}

export async function queryServiceOrders(
  db: OperationsDb,
  storeId: number,
  filter: { state?: string | null; q?: string | null; limit?: number | null },
): Promise<ServiceOrderSummary[]> {
  const limit = Number.isInteger(filter.limit) && (filter.limit as number) > 0 ? Math.min(filter.limit as number, 200) : 50
  const conditions = ['so.store_id = ?']
  const params: (string | number)[] = [storeId]
  if (filter.state) {
    conditions.push('so.state = ?')
    params.push(filter.state)
  }
  if (filter.q?.trim()) {
    conditions.push(`(d.device_code LIKE ? OR COALESCE(d.manufacturer_sn, '') LIKE ? OR so.order_no LIKE ? OR so.symptom LIKE ? OR so.intake_snapshot LIKE ?)`)
    const term = `%${filter.q.trim()}%`
    params.push(term, term, term, term, term)
  }
  const rows = await db
    .prepare(
      `SELECT so.id, so.order_no, so.symptom, so.state, so.confirmed_charge_cents,
              so.balance_cents, so.version, so.created_at, so.intake_snapshot,
              d.device_code, d.manufacturer_sn
       FROM service_orders so
         JOIN customer_device_custody d ON d.id = so.device_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY so.created_at DESC, so.id DESC
       LIMIT ?`,
    )
    .bind(...params, limit)
    .all<{
      id: string
      order_no: string
      symptom: string
      state: string
      confirmed_charge_cents: number | null
      balance_cents: number
      version: number
      created_at: string
      intake_snapshot: string
      device_code: string
      manufacturer_sn: string | null
    }>()

  return (rows.results ?? []).map((row) => {
    let customerName = ''
    try {
      const parsed = JSON.parse(row.intake_snapshot) as { customerName?: string }
      customerName = typeof parsed.customerName === 'string' ? parsed.customerName : ''
    } catch {
      customerName = ''
    }
    return {
      id: row.id,
      orderNo: row.order_no,
      customerName,
      deviceCode: row.device_code,
      manufacturerSn: row.manufacturer_sn,
      symptom: row.symptom,
      state: row.state,
      confirmedChargeCents: row.confirmed_charge_cents,
      balanceCents: row.balance_cents,
      version: row.version,
      createdAt: row.created_at,
    }
  })
}

export interface ServiceOrderDetail {
  id: string
  orderNo: string
  customerId: number | null
  customerName: string
  deviceCode: string
  manufacturerSn: string | null
  symptom: string
  intakeSnapshot: Record<string, unknown>
  state: string
  proposalVersion: number | null
  confirmedChargeCents: number | null
  warrantyDecision: string | null
  cashNetCents: number
  balanceCents: number
  balanceDirection: string
  note: string
  version: number
  createdAt: string
  allowedActions: string[]
  attachments: AttachmentView[]
}

export async function queryServiceOrderDetail(
  db: OperationsDb,
  storeId: number,
  orderId: string,
): Promise<ServiceOrderDetail | null> {
  const order = await readServiceOrder(db, storeId, orderId)
  if (!order) return null
  const device = await readCustomerDevice(db, storeId, order.device_id)
  const attachments = await listAttachedForOwner(db, storeId, 'service_order', order.id)

  let intakeSnapshot: Record<string, unknown> = {}
  let customerName = ''
  try {
    const parsed = JSON.parse(order.intake_snapshot) as Record<string, unknown>
    intakeSnapshot = parsed
    customerName = typeof parsed.customerName === 'string' ? parsed.customerName : ''
  } catch {
    intakeSnapshot = {}
  }

  return {
    id: order.id,
    orderNo: order.order_no,
    customerId: order.customer_id,
    customerName,
    deviceCode: device?.device_code ?? '',
    manufacturerSn: device?.manufacturer_sn ?? null,
    symptom: order.symptom,
    intakeSnapshot,
    state: order.state,
    proposalVersion: order.proposal_version,
    confirmedChargeCents: order.confirmed_charge_cents,
    warrantyDecision: order.warranty_decision,
    cashNetCents: order.cash_net_cents,
    balanceCents: order.balance_cents,
    balanceDirection: order.balance_direction,
    note: order.note,
    version: order.version,
    createdAt: order.created_at,
    allowedActions: allowedActionsFor(order),
    attachments,
  }
}

/** 每个状态允许的动作（B20–B25 / B41），供前端渲染动作按钮。 */
function allowedActionsFor(order: ServiceOrderRow): string[] {
  switch (order.state) {
    case 'received':
      return ['diagnosis']
    case 'diagnosing':
      return ['proposal']
    case 'awaiting_approval':
      return ['confirm-proposal', 'dispatch']
    case 'repairing':
      return ['replace']
    case 'outsourced':
      return ['receive-external']
    case 'retesting':
      return ['retest', 'payment']
    case 'ready_return':
      return ['return', 'payment']
    case 'returned':
    case 'closed':
      return []
    default:
      return []
  }
}
