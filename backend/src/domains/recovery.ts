/**
 * E10 · 回收拆件领域：回收登记（B26）、验机估价（B27）、取得所有权（B28）、
 * 归还客户（B29）、拆件入库（B44）、对外付款（B33 回收部分）与回收单读（R10）。
 *
 * 契约依据（contracts/v1）：
 *   actions.json  B26 回收登记 POST /recovery/orders（recovery/edit）
 *                 B27 验机估价 POST /recovery/orders/:id/inspect、/offer（recovery/edit）
 *                 B28 取得所有权 POST /recovery/orders/:id/acquire（recovery/acquire，owner_only）
 *                 B29 归还客户 POST /recovery/orders/:id/return（recovery/edit）
 *                 B44 拆件入库 POST /recovery/orders/:id/teardown（recovery/edit）
 *                 B33 登记对外付款 POST /finance/payments（finance/payment，owner_only）
 *                 R10 读 GET /recovery/orders、/recovery/orders/:id（recovery/view）
 *   objects.json  Recovery / RecoveryTeardown
 *   enums.json    RecoveryState、InventoryMovementSource（recovery_acquisition / conversion）
 *
 * 所有权边界（03 §4 / objects.json Recovery.rules）：
 *   B26 登记的实物是「客户暂存」（不建 stock_items，只在 recovery_items 里登记描述），
 *   不进自有库存、不计成本。只有 B28 取得所有权时才建 store 实物
 *   （ownership='store'、availability='quarantine' 待检，不自动可卖），
 *   逐件成本落到 stock_items.acquisition_cost_cents。
 *
 * 应付模型：payable_cents = final_acquisition_cents − paid_cents（表级 CHECK 强制）。
 *   B28 取得所有权时 payable 置为最终价、paid 为 0；B33 付款时 paid 增加、payable 同步减少。
 *
 * 拆件守恒（栋哥 2026-09-21 拍板「损耗单列报废」）：
 *   产出件成本 + 损耗 = 源整机成本，差额不为零整批回滚（recovery_teardowns 表级 CHECK）。
 *   损耗走 scrap 流水，不摊进产出件。
 *
 * 本模块不做鉴权：storeId / actorUserId 由调用方从会话派生（T03）。权限码见函数注释。
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
import { generateInternalCode, normalizeManufacturerSn } from './serial-codes'
import { listAttachedForOwner, type AttachmentView } from './attachment'
import { normalizeSn } from './inventory'

// ─────────────────────────────────────────────────────────────────────────────
// 枚举常量：取值必须与 contracts/v1/enums.json 逐字一致。
// ─────────────────────────────────────────────────────────────────────────────

export const RECOVERY_STATES = [
  'draft',
  'received_for_inspection',
  'inspecting',
  'offered',
  'acquired',
  'disassembled',
  'refurbishing',
  'ready_for_sale',
  'return_pending',
  'returned',
] as const
export type RecoveryState = (typeof RECOVERY_STATES)[number]

const CASH_METHODS = ['cash', 'wechat', 'alipay', 'bank', 'other'] as const
type CashMethod = (typeof CASH_METHODS)[number]

function nowIso(): string {
  return new Date().toISOString()
}

function isValidCents(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

/** FNV-1a 32 位 + 雪崩混合，与 sale.ts 的 orderNoFor 同一手法（回收单号 REC 前缀）。 */
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

export function recoveryOrderNoFor(requestId: string, now: string): string {
  const date = now.slice(0, 10).replace(/-/g, '')
  return `REC-${date}-${stableHash8(requestId)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// 入参与读辅助
// ─────────────────────────────────────────────────────────────────────────────

export interface RecoveryItemInput {
  description: string
  condition?: 'new' | 'used'
  snRaw?: string | null
  estimatedCents?: number | null
}

export interface RecoveryRegisterInput {
  sellerName: string
  sellerPhone?: string | null
  sellerCustomerId?: number | null
  items: RecoveryItemInput[]
  initialEstimateCents?: number | null
  note?: string | null
}

export interface RecoveryOfferInput {
  estimatedCents?: number | null
  itemPrices?: { recoveryItemId: string; estimatedCents: number }[]
  note?: string | null
}

export interface RecoveryAcquireLine {
  recoveryItemId: string
  productRef: string
  assetCode?: string | null
  condition?: 'new' | 'used'
  snRaw?: string | null
  remark?: string | null
  costCents: number
}

export interface RecoveryAcquireInput {
  finalAcquisitionCents: number
  lines: RecoveryAcquireLine[]
  evidenceRef?: string | null
  note?: string | null
}

export interface TeardownOutput {
  productRef: string
  assetCode?: string | null
  condition?: 'new' | 'used'
  snRaw?: string | null
  remark?: string | null
  costCents: number
}

export interface ScrapLine {
  description: string
  costCents: number
}

export interface RecoveryTeardownInput {
  sourceStockItemId: string
  outputs: TeardownOutput[]
  scrapLines?: ScrapLine[]
  occurredAt?: string | null
}

export interface RecoveryPaymentInput {
  amountCents: number
  method: CashMethod
  occurredAt?: string | null
  remark?: string | null
}

interface RecoveryOrderRow {
  id: string
  order_no: string
  seller_customer_id: number | null
  seller_snapshot: string
  state: string
  initial_estimate_cents: number | null
  offer_version: number
  final_acquisition_cents: number | null
  payable_cents: number
  paid_cents: number
  received_at: string | null
  accepted_at: string | null
  confirmation_evidence_ref: string | null
  note: string
  version: number
  created_at: string
}

interface RecoveryItemRow {
  id: string
  stock_item_id: string | null
  description: string
  condition: string
  sn_raw: string | null
  estimated_cents: number | null
  acquired_cost_cents: number | null
}

async function readRecoveryOrder(
  db: OperationsDb,
  storeId: number,
  orderId: string,
): Promise<RecoveryOrderRow | null> {
  const row = await db
    .prepare(
      `SELECT id, order_no, seller_customer_id, seller_snapshot, state,
              initial_estimate_cents, offer_version, final_acquisition_cents,
              payable_cents, paid_cents, received_at, accepted_at,
              confirmation_evidence_ref, note, version, created_at
       FROM recovery_orders WHERE store_id = ? AND id = ?`,
    )
    .bind(storeId, orderId)
    .first<RecoveryOrderRow>()
  return row ?? null
}

async function readRecoveryItems(
  db: OperationsDb,
  storeId: number,
  orderId: string,
): Promise<RecoveryItemRow[]> {
  const result = await db
    .prepare(
      `SELECT id, stock_item_id, description, condition, sn_raw, estimated_cents, acquired_cost_cents
       FROM recovery_items WHERE store_id = ? AND recovery_order_id = ? ORDER BY id`,
    )
    .bind(storeId, orderId)
    .all<RecoveryItemRow>()
  return result.results ?? []
}

interface ResolvedProduct {
  hardwareId: number
  entityId: string
  name: string
  trackingMode: 'quantity' | 'item'
}

async function loadProducts(
  db: OperationsDb,
  storeId: number,
  refs: string[],
): Promise<Map<string, ResolvedProduct>> {
  if (refs.length === 0) return new Map()
  const placeholders = refs.map(() => '?').join(', ')
  const result = await db
    .prepare(
      `SELECT id, entity_id, name, COALESCE(tracking_mode, 'quantity') AS tracking_mode
       FROM hardware WHERE store_id = ? AND entity_id IN (${placeholders})`,
    )
    .bind(storeId, ...refs)
    .all<{ id: number; entity_id: string; name: string; tracking_mode: string }>()

  const map = new Map<string, ResolvedProduct>()
  for (const row of result.results ?? []) {
    map.set(row.entity_id, {
      hardwareId: row.id,
      entityId: row.entity_id,
      name: row.name,
      trackingMode: row.tracking_mode === 'item' ? 'item' : 'quantity',
    })
  }
  return map
}

// ─────────────────────────────────────────────────────────────────────────────
// B26 · 回收登记（POST /recovery/orders）
// 权限：recovery/edit
// ─────────────────────────────────────────────────────────────────────────────

export function validateRegisterInput(input: RecoveryRegisterInput): string | null {
  if (!input.sellerName || !input.sellerName.trim()) return '卖方姓名不能为空'
  if (!Array.isArray(input.items) || input.items.length === 0) return '回收单至少需要一件实物'
  for (const [index, item] of input.items.entries()) {
    if (!item.description || !item.description.trim()) return `第 ${index + 1} 件：描述不能为空`
    if (item.condition && item.condition !== 'new' && item.condition !== 'used') {
      return `第 ${index + 1} 件：condition 取值无效`
    }
    if (item.estimatedCents !== undefined && item.estimatedCents !== null) {
      if (!isValidCents(item.estimatedCents)) return `第 ${index + 1} 件：estimatedCents 必须为非负整数分`
    }
  }
  if (input.initialEstimateCents !== undefined && input.initialEstimateCents !== null) {
    if (!isValidCents(input.initialEstimateCents)) return 'initialEstimateCents 必须为非负整数分'
  }
  return null
}

export function planRegisterRecovery(
  db: OperationsDb,
  ctx: OperationContext,
  input: RecoveryRegisterInput,
  orderId: string,
  orderNo: string,
  now: string,
): OperationPlan {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO recovery_orders
           (id, store_id, order_no, seller_customer_id, seller_snapshot, state,
            initial_estimate_cents, offer_version, final_acquisition_cents, payable_cents, paid_cents,
            received_at, note, version, request_id, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'received_for_inspection', ?, 0, NULL, 0, 0, ?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .bind(
        orderId,
        ctx.storeId,
        orderNo,
        input.sellerCustomerId ?? null,
        JSON.stringify({ name: input.sellerName.trim(), phone: (input.sellerPhone ?? '').trim() }),
        input.initialEstimateCents ?? null,
        now,
        (input.note ?? '').trim(),
        ctx.requestId,
        ctx.actorUserId,
        ctx.actorUserId,
        now,
        now,
      ),
    guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM recovery_orders WHERE store_id = ? AND id = ?)', ctx.storeId, orderId),
  ]

  const itemIds: string[] = []
  for (const [index, item] of input.items.entries()) {
    const itemId = `${ctx.requestId}::item::${index}`
    itemIds.push(itemId)
    statements.push(
      db
        .prepare(
          `INSERT INTO recovery_items
             (id, store_id, recovery_order_id, stock_item_id, description, condition, sn_raw,
              estimated_cents, acquired_cost_cents, request_id)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?)`,
        )
        .bind(
          itemId,
          ctx.storeId,
          orderId,
          item.description.trim(),
          item.condition ?? 'used',
          item.snRaw ? normalizeSn(item.snRaw) : null,
          item.estimatedCents ?? null,
          ctx.requestId,
        ),
    )
  }

  statements.push(bumpVersionStatement(db, ctx, 'Recovery', orderId, 1))

  return {
    statements,
    outcome: {
      entityType: 'Recovery',
      entityId: orderId,
      version: 1,
      summary: `回收登记 ${input.items.length} 件，单号 ${orderNo}`,
      effects: { orderNo, itemIds },
    },
    constraintCodes: {
      'recovery_orders.store_id, recovery_orders.order_no': 'VALIDATION_ERROR',
    },
  }
}

/** B26 入口。 */
export async function registerRecovery(
  db: OperationsDb,
  ctx: OperationContext,
  input: RecoveryRegisterInput,
): Promise<RunResult> {
  const invalid = validateRegisterInput(input)
  if (invalid) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: invalid, retryable: false, httpStatus: 400 }
  }
  const orderId = `${ctx.requestId}::rec`
  const now = nowIso()
  const orderNo = recoveryOrderNoFor(ctx.requestId, now)
  const resolved: OperationContext = { ...ctx, payloadHash: await hashPayload(input) }
  return runIdempotent(db, resolved, (context) => planRegisterRecovery(db, context, input, orderId, orderNo, now))
}

// ─────────────────────────────────────────────────────────────────────────────
// B27 · 验机与估价（POST /recovery/orders/:id/inspect、/offer）
// 权限：recovery/edit
// ─────────────────────────────────────────────────────────────────────────────

export function planInspectRecovery(
  db: OperationsDb,
  ctx: OperationContext,
  order: RecoveryOrderRow,
  nextVersion: number,
): OperationPlan {
  return {
    statements: [
      guardStatement(db, 'VALIDATION_ERROR', `NOT EXISTS (SELECT 1 FROM recovery_orders WHERE store_id = ? AND id = ? AND state = 'received_for_inspection')`, ctx.storeId, order.id),
      db
        .prepare(
          `UPDATE recovery_orders SET state = 'inspecting', version = ?, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ?`,
        )
        .bind(nextVersion, ctx.actorUserId, nowIso(), ctx.storeId, order.id, order.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'recovery_orders', 'id', order.id, nextVersion),
      bumpVersionStatement(db, ctx, 'Recovery', order.id, nextVersion),
    ],
    outcome: {
      entityType: 'Recovery',
      entityId: order.id,
      version: nextVersion,
      summary: `开始验机 ${order.order_no}`,
      effects: { state: 'inspecting' },
    },
  }
}

export function planOfferRecovery(
  db: OperationsDb,
  ctx: OperationContext,
  order: RecoveryOrderRow,
  input: RecoveryOfferInput,
  nextVersion: number,
  totalEstimate: number | null,
): OperationPlan {
  const statements: D1PreparedStatement[] = [
    guardStatement(db, 'VALIDATION_ERROR', `NOT EXISTS (SELECT 1 FROM recovery_orders WHERE store_id = ? AND id = ? AND state IN ('received_for_inspection', 'inspecting'))`, ctx.storeId, order.id),
    db
      .prepare(
        `UPDATE recovery_orders
         SET state = 'offered', offer_version = ?, initial_estimate_cents = ?,
             version = ?, updated_by = ?, updated_at = ?
         WHERE store_id = ? AND id = ? AND version = ?`,
      )
      .bind(order.offer_version + 1, totalEstimate, nextVersion, ctx.actorUserId, nowIso(), ctx.storeId, order.id, order.version),
    assertRowVersionStatement(db, 'VERSION_CONFLICT', 'recovery_orders', 'id', order.id, nextVersion),
    bumpVersionStatement(db, ctx, 'Recovery', order.id, nextVersion),
  ]

  for (const price of input.itemPrices ?? []) {
    statements.push(
      db
        .prepare(
          `UPDATE recovery_items SET estimated_cents = ?
           WHERE store_id = ? AND id = ? AND recovery_order_id = ?`,
        )
        .bind(price.estimatedCents, ctx.storeId, price.recoveryItemId, order.id),
      guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM recovery_items WHERE store_id = ? AND id = ? AND estimated_cents = ?)', ctx.storeId, price.recoveryItemId, price.estimatedCents),
    )
  }

  return {
    statements,
    outcome: {
      entityType: 'Recovery',
      entityId: order.id,
      version: nextVersion,
      summary: `估价 ${order.order_no}，版本 ${order.offer_version + 1}`,
      effects: { offerVersion: order.offer_version + 1, totalEstimate },
    },
  }
}

/** B27 入口：mode = 'inspect' | 'offer'。 */
export async function inspectOrOfferRecovery(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  mode: 'inspect' | 'offer',
  input: RecoveryOfferInput,
): Promise<RunResult> {
  const action = 'B27'
  const payloadHash = await hashPayload({ orderId, mode, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const order = await readRecoveryOrder(db, ctx.storeId, orderId)
  if (!order) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '回收单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }

  const nextVersion = order.version + 1

  if (mode === 'inspect') {
    const resolved: OperationContext = { ...ctx, action, payloadHash }
    return runIdempotent(db, resolved, (context) => planInspectRecovery(db, context, order, nextVersion))
  }

  let totalEstimate: number | null = input.estimatedCents ?? null
  if (input.itemPrices && input.itemPrices.length > 0) {
    const sum = input.itemPrices.reduce((acc, p) => acc + p.estimatedCents, 0)
    totalEstimate = sum
  }
  if (totalEstimate !== null && !isValidCents(totalEstimate)) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '估价金额必须为非负整数分', retryable: false, httpStatus: 400 }
  }

  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) => planOfferRecovery(db, context, order, input, nextVersion, totalEstimate))
}

// ─────────────────────────────────────────────────────────────────────────────
// B28 · 取得所有权（POST /recovery/orders/:id/acquire）
// 权限：recovery/acquire（老板专属）
// ─────────────────────────────────────────────────────────────────────────────

export function validateAcquireInput(input: RecoveryAcquireInput): string | null {
  if (!isValidCents(input.finalAcquisitionCents)) return '最终收购价必须为非负整数分'
  if (!Array.isArray(input.lines) || input.lines.length === 0) return '至少需要一行逐件成本'
  let sum = 0
  for (const [index, line] of input.lines.entries()) {
    if (!line.recoveryItemId) return `第 ${index + 1} 行：缺少 recoveryItemId`
    if (!line.productRef) return `第 ${index + 1} 行：缺少商品引用 productRef`
    if (!isValidCents(line.costCents)) return `第 ${index + 1} 行：costCents 必须为非负整数分`
    sum += line.costCents
  }
  if (sum !== input.finalAcquisitionCents) {
    return `逐件成本之和（${sum}）不等于最终收购价（${input.finalAcquisitionCents}）`
  }
  return null
}

export function planAcquireRecovery(
  db: OperationsDb,
  ctx: OperationContext,
  order: RecoveryOrderRow,
  input: RecoveryAcquireInput,
  products: Map<string, ResolvedProduct>,
  items: RecoveryItemRow[],
  nextVersion: number,
  now: string,
): OperationPlan {
  const itemById = new Map(items.map((i) => [i.id, i]))
  const statements: D1PreparedStatement[] = [
    guardStatement(db, 'VALIDATION_ERROR', `NOT EXISTS (SELECT 1 FROM recovery_orders WHERE store_id = ? AND id = ? AND state = 'offered')`, ctx.storeId, order.id),
  ]

  const acquiredItemIds: string[] = []
  const movementIds: string[] = []

  for (const [index, line] of input.lines.entries()) {
    const item = itemById.get(line.recoveryItemId)
    if (!item) {
      // 预读阶段已校验；此处防御性守卫。
      statements.push(guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM recovery_items WHERE store_id = ? AND id = ? AND recovery_order_id = ?)', ctx.storeId, line.recoveryItemId, order.id))
      continue
    }
    const product = products.get(line.productRef)
    if (!product) {
      statements.push(guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM hardware WHERE store_id = ? AND entity_id = ?)', ctx.storeId, line.productRef))
      continue
    }

    const stockItemId = `${ctx.requestId}::item::${index}`
    const assetCode = (line.assetCode ?? '').trim() || generateInternalCode('IT', ctx.storeId, now)
    const snNormalized = normalizeManufacturerSn(line.snRaw)

    statements.push(
      db
        .prepare(
          `INSERT INTO stock_items
             (id, store_id, product_id, asset_code, condition, sn_raw, sn_normalized, remark,
              ownership, availability, inspection_status, location, acquisition_ref,
              acquisition_cost_cents, cost_known, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'store', 'quarantine', 'pending', 'store', ?, ?, 1, ?)`,
        )
        .bind(
          stockItemId,
          ctx.storeId,
          product.hardwareId,
          assetCode,
          line.condition ?? 'used',
          line.snRaw ?? null,
          snNormalized,
          line.remark?.trim() ?? input.note?.trim() ?? '',
          order.id,
          line.costCents,
          ctx.actorUserId,
        ),
      guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM stock_items WHERE store_id = ? AND id = ?)', ctx.storeId, stockItemId),
      db
        .prepare(
          `INSERT INTO inventory_movements
             (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
              source, occurred_at, actor_user_id, request_id)
           VALUES (?, ?, ?, ?, 1, NULL, 'quarantine', ?, 'recovery_acquisition', ?, ?, ?)`,
        )
        .bind(`${ctx.requestId}::mov-${index}`, ctx.storeId, product.hardwareId, stockItemId, line.costCents, now, ctx.actorUserId, ctx.requestId),
      db
        .prepare(
          `UPDATE recovery_items SET stock_item_id = ?, acquired_cost_cents = ?
           WHERE store_id = ? AND id = ? AND recovery_order_id = ?`,
        )
        .bind(stockItemId, line.costCents, ctx.storeId, item.id, order.id),
    )
    acquiredItemIds.push(stockItemId)
    movementIds.push(`${ctx.requestId}::mov-${index}`)
  }

  statements.push(
    db
      .prepare(
        `UPDATE recovery_orders
         SET state = 'acquired', final_acquisition_cents = ?, payable_cents = ?,
             accepted_at = ?, confirmation_evidence_ref = ?,
             version = ?, updated_by = ?, updated_at = ?
         WHERE store_id = ? AND id = ? AND version = ?`,
      )
      .bind(input.finalAcquisitionCents, input.finalAcquisitionCents, now, input.evidenceRef ?? null, nextVersion, ctx.actorUserId, now, ctx.storeId, order.id, order.version),
    assertRowVersionStatement(db, 'VERSION_CONFLICT', 'recovery_orders', 'id', order.id, nextVersion),
    guardStatement(
      db,
      'VALIDATION_ERROR',
      'NOT EXISTS (SELECT 1 FROM recovery_orders WHERE store_id = ? AND id = ? AND payable_cents = ?)',
      ctx.storeId,
      order.id,
      input.finalAcquisitionCents,
    ),
    bumpVersionStatement(db, ctx, 'Recovery', order.id, nextVersion),
  )

  return {
    statements,
    outcome: {
      entityType: 'Recovery',
      entityId: order.id,
      version: nextVersion,
      summary: `取得所有权 ${order.order_no}，收购价 ${(input.finalAcquisitionCents / 100).toFixed(2)} 元`,
      effects: { orderNo: order.order_no, acquiredItemIds, movementIds, payableCents: input.finalAcquisitionCents },
    },
    constraintCodes: {
      'stock_items.store_id, stock_items.asset_code': 'VALIDATION_ERROR',
      'stock_items.store_id, stock_items.sn_normalized': 'SERIAL_MISMATCH',
    },
  }
}

/** B28 入口。 */
export async function acquireRecovery(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: RecoveryAcquireInput,
): Promise<RunResult> {
  const action = 'B28'
  const invalid = validateAcquireInput(input)
  if (invalid) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: invalid, retryable: false, httpStatus: 400 }
  }

  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const order = await readRecoveryOrder(db, ctx.storeId, orderId)
  if (!order) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '回收单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }

  const items = await readRecoveryItems(db, ctx.storeId, orderId)
  const products = await loadProducts(db, ctx.storeId, [...new Set(input.lines.map((l) => l.productRef))])
  for (const [index, line] of input.lines.entries()) {
    if (!products.has(line.productRef)) {
      return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: `第 ${index + 1} 行商品不存在或不属于本店`, retryable: false, httpStatus: 404 }
    }
    if (!items.some((i) => i.id === line.recoveryItemId)) {
      return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: `第 ${index + 1} 行回收明细不存在或不属于本单`, retryable: false, httpStatus: 404 }
    }
  }

  const nextVersion = order.version + 1
  const now = nowIso()
  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) => planAcquireRecovery(db, context, order, input, products, items, nextVersion, now))
}

// ─────────────────────────────────────────────────────────────────────────────
// B29 · 归还客户（POST /recovery/orders/:id/return）
// 权限：recovery/edit
// ─────────────────────────────────────────────────────────────────────────────

export async function returnRecovery(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  reason: string,
): Promise<RunResult> {
  const action = 'B29'
  const trimmed = (reason ?? '').trim()
  if (!trimmed) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '归还必须写明原因', retryable: false, httpStatus: 400 }
  }

  const payloadHash = await hashPayload({ orderId, reason })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const order = await readRecoveryOrder(db, ctx.storeId, orderId)
  if (!order) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '回收单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }

  const nextVersion = order.version + 1
  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) => ({
    statements: [
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `NOT EXISTS (SELECT 1 FROM recovery_orders WHERE store_id = ? AND id = ? AND state IN ('received_for_inspection', 'inspecting', 'offered'))`,
        ctx.storeId,
        order.id,
      ),
      db
        .prepare(
          `UPDATE recovery_orders SET state = 'returned', note = ?, version = ?, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ?`,
        )
        .bind(trimmed, nextVersion, ctx.actorUserId, nowIso(), ctx.storeId, order.id, order.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'recovery_orders', 'id', order.id, nextVersion),
      bumpVersionStatement(db, ctx, 'Recovery', order.id, nextVersion),
    ],
    outcome: {
      entityType: 'Recovery',
      entityId: order.id,
      version: nextVersion,
      summary: `归还客户 ${order.order_no}：${trimmed}`,
      effects: { state: 'returned', reason: trimmed },
    },
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// B44 · 拆件入库（POST /recovery/orders/:id/teardown）
// 权限：recovery/edit
// ─────────────────────────────────────────────────────────────────────────────

export function validateTeardownInput(input: RecoveryTeardownInput): string | null {
  if (!input.sourceStockItemId) return '缺少源实物 sourceStockItemId'
  if (!Array.isArray(input.outputs) || input.outputs.length === 0) return '至少需要一个产出件'
  let outputSum = 0
  for (const [index, out] of input.outputs.entries()) {
    if (!out.productRef) return `产出件 ${index + 1}：缺少商品引用 productRef`
    if (!isValidCents(out.costCents)) return `产出件 ${index + 1}：costCents 必须为非负整数分`
    outputSum += out.costCents
  }
  let scrapSum = 0
  const scrapLines = input.scrapLines ?? []
  // ⚠️ 这里刻意用索引循环而不是 `for (const [index, scrap] of scrapLines)`：
  //    在 miniflare/workerd 里那样写会抛 ".for is not iterable"（E11 收尾实测 500），
  //    即使 scrapLines 打印出来就是一个普通数组（Array.isArray 为 true、length 正确）。
  //    同一函数里 `for (const [index, out] of input.outputs.entries())` 却正常，
  //    所以这不是「数组不能迭代」，而是这个具体写法在 workerd 上踩坑。别改回去。
  for (let index = 0; index < scrapLines.length; index += 1) {
    const scrap = scrapLines[index]
    if (!isValidCents(scrap.costCents)) return `损耗 ${index + 1}：costCents 必须为非负整数分`
    scrapSum += scrap.costCents
  }
  // 守恒由表级 CHECK 兜底，这里只做快速提示；差额校验在 plan 里用 SQL 断言。
  return null
}

export function planTeardownRecovery(
  db: OperationsDb,
  ctx: OperationContext,
  order: RecoveryOrderRow,
  source: { id: string; productId: number; costCents: number },
  input: RecoveryTeardownInput,
  products: Map<string, ResolvedProduct>,
  teardownId: string,
  nextVersion: number,
  occurredAt: string,
): OperationPlan {
  const outputSum = input.outputs.reduce((acc, o) => acc + o.costCents, 0)
  const scrapSum = (input.scrapLines ?? []).reduce((acc, s) => acc + s.costCents, 0)

  const statements: D1PreparedStatement[] = [
    guardStatement(db, 'VALIDATION_ERROR', `NOT EXISTS (SELECT 1 FROM recovery_orders WHERE store_id = ? AND id = ? AND state = 'acquired')`, ctx.storeId, order.id),
    guardStatement(
      db,
      'OWNERSHIP_INVALID',
      `NOT EXISTS (SELECT 1 FROM stock_items WHERE store_id = ? AND id = ? AND ownership = 'store' AND availability = 'quarantine')`,
      ctx.storeId,
      source.id,
    ),
    // 守恒断言：产出 + 损耗必须等于源成本（表级 CHECK 也会兜底，这里让错误码更明确）。
    // ⚠️ guardStatement 会把这段文本拼进 `INSERT INTO assertion_guards (code) SELECT ? WHERE <这里>`，
    //    所以只能写布尔条件，不能写 `SELECT 1 WHERE ...`（会拼出 SQL 语法错误，E11 收尾实测）。
    guardStatement(db, 'VALIDATION_ERROR', '? <> ?', outputSum + scrapSum, source.costCents),
    // 源整机退役：quarantine → retired，来源 conversion（拆件）。
    db
      .prepare(
        `UPDATE stock_items SET availability = 'retired', version = version + 1, updated_at = ?
         WHERE store_id = ? AND id = ?`,
      )
      .bind(occurredAt, ctx.storeId, source.id),
    db
      .prepare(
        `INSERT INTO inventory_movements
           (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
            source, occurred_at, actor_user_id, request_id)
         VALUES (?, ?, ?, ?, 1, 'quarantine', 'retired', ?, 'conversion', ?, ?, ?)`,
      )
      .bind(`${ctx.requestId}::src-retired`, ctx.storeId, source.productId, source.id, source.costCents, occurredAt, ctx.actorUserId, ctx.requestId),
  ]

  const outputIds: string[] = []
  for (const [index, out] of input.outputs.entries()) {
    const product = products.get(out.productRef)
    if (!product) {
      statements.push(guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM hardware WHERE store_id = ? AND entity_id = ?)', ctx.storeId, out.productRef))
      continue
    }
    const stockItemId = `${ctx.requestId}::out::${index}`
    const assetCode = (out.assetCode ?? '').trim() || generateInternalCode('IT', ctx.storeId, occurredAt)
    const snNormalized = normalizeManufacturerSn(out.snRaw)
    statements.push(
      db
        .prepare(
          `INSERT INTO stock_items
             (id, store_id, product_id, asset_code, condition, sn_raw, sn_normalized, remark,
              ownership, availability, inspection_status, location, acquisition_ref,
              acquisition_cost_cents, cost_known, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'store', 'quarantine', 'pending', 'store', ?, ?, 1, ?)`,
        )
        .bind(
          stockItemId,
          ctx.storeId,
          product.hardwareId,
          assetCode,
          out.condition ?? 'used',
          out.snRaw ?? null,
          snNormalized,
          out.remark?.trim() ?? '',
          order.id,
          out.costCents,
          ctx.actorUserId,
        ),
      guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM stock_items WHERE store_id = ? AND id = ?)', ctx.storeId, stockItemId),
      db
        .prepare(
          `INSERT INTO inventory_movements
             (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
              source, occurred_at, actor_user_id, request_id)
           VALUES (?, ?, ?, ?, 1, NULL, 'quarantine', ?, 'conversion', ?, ?, ?)`,
        )
        .bind(`${ctx.requestId}::out-mov-${index}`, ctx.storeId, product.hardwareId, stockItemId, out.costCents, occurredAt, ctx.actorUserId, ctx.requestId),
    )
    outputIds.push(stockItemId)
  }

  // 损耗单列报废：scrap 流水，不建实物。
  const scrapLines = input.scrapLines ?? []
  for (let index = 0; index < scrapLines.length; index += 1) {
    const scrap = scrapLines[index]
    if (scrap.costCents <= 0) continue
    statements.push(
      db
        .prepare(
          // ⚠️ from_bucket 必须是 NULL，不能写 'quarantine'：源整机退役那一条已经把
          // quarantine 减掉了，损耗再写一次 quarantine → retired 会把同一个桶减成负数，
          // 撞 stock_balances 的 CHECK (quarantine_qty >= 0) 让整批回滚（E11 收尾实测）。
          // 损耗是「残余价值报废」的成本记录，不是实物桶移动，不参与余额三列。
          `INSERT INTO inventory_movements
             (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
              source, occurred_at, actor_user_id, request_id)
           VALUES (?, ?, ?, ?, 1, NULL, 'retired', ?, 'scrap', ?, ?, ?)`,
        )
        .bind(`${ctx.requestId}::scrap-${index}`, ctx.storeId, source.productId, source.id, scrap.costCents, occurredAt, ctx.actorUserId, ctx.requestId),
    )
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO recovery_teardowns
           (id, store_id, recovery_order_id, source_stock_item_id, outputs_json, scrap_json,
            source_cost_cents, output_cost_cents, scrap_cost_cents, occurred_at,
            version, request_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        teardownId,
        ctx.storeId,
        order.id,
        source.id,
        JSON.stringify(input.outputs.map((o, i) => ({ ...o, stockItemId: `${ctx.requestId}::out::${i}` }))),
        JSON.stringify(input.scrapLines ?? []),
        source.costCents,
        outputSum,
        scrapSum,
        occurredAt,
        ctx.requestId,
        ctx.actorUserId,
      ),
    db
      .prepare(
        `UPDATE recovery_orders SET state = 'disassembled', version = ?, updated_by = ?, updated_at = ?
         WHERE store_id = ? AND id = ? AND version = ?`,
      )
      .bind(nextVersion, ctx.actorUserId, occurredAt, ctx.storeId, order.id, order.version),
    assertRowVersionStatement(db, 'VERSION_CONFLICT', 'recovery_orders', 'id', order.id, nextVersion),
    bumpVersionStatement(db, ctx, 'Recovery', order.id, nextVersion),
  )

  return {
    statements,
    outcome: {
      entityType: 'Recovery',
      entityId: order.id,
      version: nextVersion,
      summary: `拆件 ${order.order_no}：${input.outputs.length} 件产出${scrapSum > 0 ? `、损耗 ${(scrapSum / 100).toFixed(2)} 元` : ''}`,
      effects: { teardownId, outputIds, scrapCostCents: scrapSum },
    },
    constraintCodes: {
      'stock_items.store_id, stock_items.asset_code': 'VALIDATION_ERROR',
      'recovery_teardowns.output_cost_cents': 'VALIDATION_ERROR',
    },
  }
}

/** B44 入口。 */
export async function teardownRecovery(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: RecoveryTeardownInput,
): Promise<RunResult> {
  const action = 'B44'
  const invalid = validateTeardownInput(input)
  if (invalid) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: invalid, retryable: false, httpStatus: 400 }
  }

  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const order = await readRecoveryOrder(db, ctx.storeId, orderId)
  if (!order) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '回收单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }

  const sourceRow = await db
    .prepare(
      `SELECT si.id, si.product_id, COALESCE(si.acquisition_cost_cents, 0) AS cost_cents
       FROM stock_items si WHERE si.store_id = ? AND si.id = ?`,
    )
    .bind(ctx.storeId, input.sourceStockItemId)
    .first<{ id: string; product_id: number; cost_cents: number }>()
  if (!sourceRow) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '源实物不存在或不属于本店', retryable: false, httpStatus: 404 }
  }

  const products = await loadProducts(db, ctx.storeId, [...new Set(input.outputs.map((o) => o.productRef))])
  for (const [index, out] of input.outputs.entries()) {
    if (!products.has(out.productRef)) {
      return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: `产出件 ${index + 1} 商品不存在或不属于本店`, retryable: false, httpStatus: 404 }
    }
  }

  const outputSum = input.outputs.reduce((acc, o) => acc + o.costCents, 0)
  const scrapSum = (input.scrapLines ?? []).reduce((acc, s) => acc + s.costCents, 0)
  if (outputSum + scrapSum !== sourceRow.cost_cents) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: `产出成本 ${outputSum} + 损耗 ${scrapSum} = ${outputSum + scrapSum}，不等于源整机成本 ${sourceRow.cost_cents}`,
      retryable: false,
      httpStatus: 400,
    }
  }

  const teardownId = `${ctx.requestId}::teardown`
  const nextVersion = order.version + 1
  const occurredAt = input.occurredAt && !Number.isNaN(new Date(input.occurredAt).getTime()) ? input.occurredAt : nowIso()
  // ⚠️ 字段名必须在这里转成 plan 的驼峰口径：SQL 查出来的是 product_id / cost_cents，
  // 直接把整行传进去的话 plan 里读的 source.productId 恒为 undefined，
  // 绑到 D1 就是 "D1_TYPE_ERROR: Type 'undefined' not supported"（E11 收尾实测 500）。
  const source = { id: sourceRow.id, productId: sourceRow.product_id, costCents: sourceRow.cost_cents }
  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) =>
    planTeardownRecovery(db, context, order, source, input, products, teardownId, nextVersion, occurredAt),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// B33 · 登记对外付款（POST /finance/payments）—— 回收应付部分
// 权限：finance/payment（老板专属）
// ─────────────────────────────────────────────────────────────────────────────

export function planPayRecovery(
  db: OperationsDb,
  ctx: OperationContext,
  order: RecoveryOrderRow,
  input: RecoveryPaymentInput,
  entryId: string,
  occurredAt: string,
): OperationPlan {
  const nextVersion = order.version + 1
  const nextPaid = order.paid_cents + input.amountCents
  const nextPayable = order.payable_cents - input.amountCents

  return {
    statements: [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM recovery_orders WHERE store_id = ? AND id = ?)', ctx.storeId, order.id),
      // 超付：付款不能超过「剩余应付」。E12 起剩余应付 = payable − 有效折抵（offsets 净额），
      // 否则客户折抵后还能再付一遍现金 = 双重支付。
      guardStatement(
        db,
        'BALANCE_EXCEEDED',
        `EXISTS (
           SELECT 1 FROM recovery_orders r
           WHERE r.store_id = ? AND r.id = ?
             AND r.payable_cents - (
               COALESCE((SELECT SUM(o.amount_cents) FROM offsets o
                          WHERE o.store_id = r.store_id AND o.recovery_id = r.id AND o.state = 'applied'), 0)
               - COALESCE((SELECT SUM(o.amount_cents) FROM offsets o
                            WHERE o.store_id = r.store_id AND o.recovery_id = r.id AND o.state = 'reversed'), 0)
             ) < ?
         )`,
        ctx.storeId,
        order.id,
        input.amountCents,
      ),
      db
        .prepare(
          `INSERT INTO cash_entries
             (id, store_id, direction, amount_cents, method, verification_state, verified_at,
              counterparty_kind, counterparty_ref, purpose, allocation_type, allocation_id,
              sale_order_id, occurred_at, remark, reversal_of, version, request_id, created_by)
           VALUES (?, ?, 'out', ?, ?, 'unverified', NULL, 'customer', ?, 'recovery', 'recovery', ?, NULL, ?, ?, NULL, 1, ?, ?)`,
        )
        .bind(
          entryId,
          ctx.storeId,
          input.amountCents,
          input.method,
          order.seller_customer_id === null ? null : String(order.seller_customer_id),
          order.id,
          occurredAt,
          (input.remark ?? '').trim(),
          ctx.requestId,
          ctx.actorUserId,
        ),
      guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM cash_entries WHERE store_id = ? AND id = ?)', ctx.storeId, entryId),
      db
        .prepare(
          `UPDATE recovery_orders SET paid_cents = ?, payable_cents = ?, version = ?, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ?`,
        )
        .bind(nextPaid, nextPayable, nextVersion, ctx.actorUserId, occurredAt, ctx.storeId, order.id, order.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'recovery_orders', 'id', order.id, nextVersion),
      guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM recovery_orders WHERE store_id = ? AND id = ? AND payable_cents = ?)', ctx.storeId, order.id, nextPayable),
      bumpVersionStatement(db, ctx, 'Recovery', order.id, nextVersion),
    ],
    outcome: {
      entityType: 'Recovery',
      entityId: order.id,
      version: nextVersion,
      summary: `回收付款 ${(input.amountCents / 100).toFixed(2)} 元（${input.method}），应付余额 ${(nextPayable / 100).toFixed(2)} 元`,
      effects: { orderNo: order.order_no, cashEntryId: entryId, paidCents: nextPaid, payableCents: nextPayable },
    },
    constraintCodes: {
      'cash_entries.reversal_of': 'VALIDATION_ERROR',
    },
  }
}

/** B33 入口（回收付款）。 */
export async function payRecovery(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: RecoveryPaymentInput,
): Promise<RunResult> {
  const action = 'B33'
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '付款金额必须是正整数分', retryable: false, httpStatus: 400 }
  }
  if (!(CASH_METHODS as readonly string[]).includes(input.method)) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '付款方式只能是 cash / wechat / alipay / bank / other', retryable: false, httpStatus: 400 }
  }

  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const order = await readRecoveryOrder(db, ctx.storeId, orderId)
  if (!order) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '回收单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }

  const entryId = `${ctx.requestId}::pay`
  const occurredAt = input.occurredAt && !Number.isNaN(new Date(input.occurredAt).getTime()) ? input.occurredAt : nowIso()
  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) => planPayRecovery(db, context, order, input, entryId, occurredAt))
}

// ─────────────────────────────────────────────────────────────────────────────
// R10 · 回收单读（GET /recovery/orders、/recovery/orders/:id）
// 权限：recovery/view
// ─────────────────────────────────────────────────────────────────────────────

export interface RecoveryOrderView {
  id: string
  orderNo: string
  seller: { customerId: number | null; name: string; phone: string }
  state: RecoveryState
  initialEstimateCents: number | null
  offerVersion: number
  finalAcquisitionCents: number | null
  payableCents: number
  paidCents: number
  /** E12：有效折抵净额 = SUM(applied offsets) − SUM(reversed offsets)。 */
  offsetCents: number
  receivedAt: string | null
  acceptedAt: string | null
  note: string
  version: number
  createdAt: string
}

export interface RecoveryItemView {
  id: string
  stockItemId: string | null
  description: string
  condition: string
  snRaw: string | null
  estimatedCents: number | null
  acquiredCostCents: number | null
}

export interface RecoveryOrderDetail extends RecoveryOrderView {
  items: RecoveryItemView[]
  attachments: AttachmentView[]
  tradeIns: { id: string; saleOrderId: string; saleOrderNo: string }[]
}

function parseSeller(snapshot: string): { name: string; phone: string } {
  try {
    const parsed = JSON.parse(snapshot)
    return { name: parsed?.name ?? '', phone: parsed?.phone ?? '' }
  } catch {
    return { name: '', phone: '' }
  }
}

export async function queryRecoveryOrders(
  db: OperationsDb,
  storeId: number,
  filter: { state?: string | null; limit?: number | null } = {},
): Promise<RecoveryOrderView[]> {
  const limit = Number.isInteger(filter.limit) && (filter.limit as number) > 0 ? Math.min(filter.limit as number, 100) : 50
  const conditions = ['r.store_id = ?']
  const params: (string | number)[] = [storeId]
  if (filter.state) {
    conditions.push('r.state = ?')
    params.push(filter.state)
  }

  const rows = await db
    .prepare(
      `SELECT r.id, r.order_no, r.seller_customer_id, r.seller_snapshot, r.state, r.initial_estimate_cents,
              r.offer_version, r.final_acquisition_cents, r.payable_cents, r.paid_cents,
              r.received_at, r.accepted_at, r.note, r.version, r.created_at,
              COALESCE((SELECT SUM(o.amount_cents) FROM offsets o
                         WHERE o.store_id = r.store_id AND o.recovery_id = r.id AND o.state = 'applied'), 0)
              - COALESCE((SELECT SUM(o.amount_cents) FROM offsets o
                           WHERE o.store_id = r.store_id AND o.recovery_id = r.id AND o.state = 'reversed'), 0) AS offset_cents
       FROM recovery_orders r
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
    )
    .bind(...params, limit)
    .all<RecoveryOrderRow & { offset_cents: number }>()

  return (rows.results ?? []).map((row) => {
    const seller = parseSeller(row.seller_snapshot)
    return {
      id: row.id,
      orderNo: row.order_no,
      seller: { customerId: row.seller_customer_id, name: seller.name, phone: seller.phone },
      state: row.state as RecoveryState,
      initialEstimateCents: row.initial_estimate_cents,
      offerVersion: row.offer_version,
      finalAcquisitionCents: row.final_acquisition_cents,
      payableCents: row.payable_cents,
      paidCents: row.paid_cents,
      offsetCents: row.offset_cents ?? 0,
      receivedAt: row.received_at,
      acceptedAt: row.accepted_at,
      note: row.note,
      version: row.version,
      createdAt: row.created_at,
    }
  })
}

export async function queryRecoveryOrder(
  db: OperationsDb,
  storeId: number,
  orderId: string,
): Promise<RecoveryOrderDetail | null> {
  const row = await readRecoveryOrder(db, storeId, orderId)
  if (!row) return null

  const items = await readRecoveryItems(db, storeId, orderId)
  const attachments = await listAttachedForOwner(db, storeId, 'recovery_order', row.id)
  const tradeIns = await db.prepare(
    `SELECT t.id, t.sale_order_id, s.order_no AS sale_order_no
       FROM trade_ins t JOIN sale_orders s ON s.store_id = t.store_id AND s.id = t.sale_order_id
      WHERE t.store_id = ? AND t.recovery_id = ? ORDER BY t.created_at ASC, t.id ASC`,
  ).bind(storeId, orderId).all<{ id: string; sale_order_id: string; sale_order_no: string }>()
  const offsetRow = await db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(o.amount_cents) FROM offsets o
                    WHERE o.store_id = ? AND o.recovery_id = ? AND o.state = 'applied'), 0)
         - COALESCE((SELECT SUM(o.amount_cents) FROM offsets o
                      WHERE o.store_id = ? AND o.recovery_id = ? AND o.state = 'reversed'), 0) AS offset_cents`,
    )
    .bind(storeId, orderId, storeId, orderId)
    .first<{ offset_cents: number | null }>()
  const seller = parseSeller(row.seller_snapshot)

  return {
    id: row.id,
    orderNo: row.order_no,
    seller: { customerId: row.seller_customer_id, name: seller.name, phone: seller.phone },
    state: row.state as RecoveryState,
    initialEstimateCents: row.initial_estimate_cents,
    offerVersion: row.offer_version,
    finalAcquisitionCents: row.final_acquisition_cents,
    payableCents: row.payable_cents,
    paidCents: row.paid_cents,
    offsetCents: offsetRow?.offset_cents ?? 0,
    receivedAt: row.received_at,
    acceptedAt: row.accepted_at,
    note: row.note,
    version: row.version,
    createdAt: row.created_at,
    items: items.map((i) => ({
      id: i.id,
      stockItemId: i.stock_item_id,
      description: i.description,
      condition: i.condition,
      snRaw: i.sn_raw,
      estimatedCents: i.estimated_cents,
      acquiredCostCents: i.acquired_cost_cents,
    })),
    attachments,
    tradeIns: (tradeIns.results ?? []).map((tradeIn) => ({ id: tradeIn.id, saleOrderId: tradeIn.sale_order_id, saleOrderNo: tradeIn.sale_order_no })),
  }
}
