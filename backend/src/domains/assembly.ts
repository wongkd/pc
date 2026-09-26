/**
 * E08 · 装机、检测与交付：B04 零售建单、B06 备料装机、B07 装机检测、B10 确认交付。
 *
 * 契约依据（contracts/v1）：
 *   actions.json  B04  POST /sales/orders（sales/order-edit）—— 创建零售与直接销售单
 *                 B06  POST /sales/orders/:id/start-assembly（sales/order-assembly）
 *                 B07  POST /sales/orders/:id/checks（sales/order-assembly）
 *                 B10  POST /sales/orders/:id/deliver（sales/order-deliver）
 *   objects.json  SaleOrder / SaleLine / Checklist / TestRecord / Delivery / Reservation
 *   enums.json    SaleFulfillmentState（waiting_stock → preparing → testing → ready_delivery → delivered）
 *                 ChecklistResult / ChecklistItemState / FinancialDisposition
 *   money-rules.json collectableCents / balanceDirection / discountAllocation
 *
 * ── 四条硬边界在这份代码里的落点 ──
 *
 * 1.「收款和交付两次动作独立可追溯」（04-delivery.md E08 行）
 *    尾款走既有的 B08（registerSalePayment），交付走 B10。两次独立的 runIdempotent 调用、
 *    两个独立 batch。交付失败只回滚交付那一批；已经收过的钱照旧成立 ——
 *    与 E06「预留失败不吞掉已收的钱」是同一条结构结论，不需要任何补偿代码。
 *
 * 2.「交付才扣库，扣库一次」（R07 / objects.json Delivery.rules）
 *    本文件里唯一的库存扣减在 planDeliver：reserved → sold 的流水 + stock_items.availability='sold'，
 *    由 0007 的触发器同步 stock_balances，CHECK (available_qty >= 0) 是扣穿时的整批回滚兜底。
 *    B04 不扣（草稿）、B06 不扣（备料不改变任何桶的数量）、B07 不扣（检测不通过只释放占用）。
 *
 * 3.「客供不扣自有货」（03 §4 R03）
 *    source='customer' 的行售价为 0 且没有 stock_item_id（0013 的 CHECK），
 *    在 coverage 里根本不参与「要不要占货」的判定，交付时永远不会去扣一件不存在的店有货。
 *
 * 4.「未付款不预留」仍然成立（E06 的定金闸没动）
 *    零售单同样要先 B08 收款、再 B05 确认成交占用，然后才谈得上 B10 交付。
 *    B04 只生成草稿，一行库存都不写 —— 零售不是「跳过收款」，只是跳过报价与装机检测。
 *
 * ── 本卡明确不做、且不假装做了的事（详见验证目录 INTEGRATION.md 的底座缺口） ──
 *   · B09 批准欠款交付：E09（2026-09-21）已实现，B10 的交付闸门随之改为接受
 *     creditApprovalRef —— 余额未结清时必须挂有效欠款批准凭证，否则拒绝。
 *   · 故障件隔离（quarantine）已实现逐件隔离（2026-09-21 补）：失败的检查项带 stockItemId 时，
 *     该件 reserved → quarantine（来源 inspection_quarantine），其余占用整单释放；
 *     数量件坏件无法逐件隔离，仍整单释放回 available。隔离件「出不了 quarantine」的判定
 *     属库存域 B19「待检件判定」，不在本卡。
 *   · CustomerDevice（交付后设备归属）：0010 的 customer_devices 不是契约的 CustomerDevice
 *     （无 custodyLocation / stockItemRef / originalOrderId），归属结构归 E10。本卡不建。
 *   · 检测附件（resultEvidence）：Attachment 仍无落地结构（B35 未实现），收到非空引用明确拒绝。
 */

import {
  allocateDiscount,
  orderNoFor,
  readOrder,
  readSaleLines,
  readStockItems,
  requiredDepositCents,
  type SaleLineRow,
  type SaleOrderRow,
  type StockItemRow,
} from './sale'
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
import { QUOTE_SETTINGS } from './quote'
import {
  containsExtensionWarrantyCommitment,
  EXTENSION_WARRANTY_DEFERRED_MESSAGE,
  isExtensionWarrantyLine,
} from './warranty'

const MAX_LINES = 200

const CHECK_RESULTS = ['incomplete', 'passed', 'failed'] as const
export type CheckResult = (typeof CHECK_RESULTS)[number]

const CHECK_ITEM_STATES = ['pending', 'pass', 'fail'] as const
export type CheckItemState = (typeof CHECK_ITEM_STATES)[number]

const CHECK_ITEM_KINDS = ['check', 'test'] as const
export type CheckItemKind = (typeof CHECK_ITEM_KINDS)[number]

/** 需要店有货的销售行：新品与二手。客供件与服务行不占库存。 */
const STOCK_REQUIRING_SOURCES = ['new', 'used'] as const

const SALE_KINDS = ['retail', 'assembly'] as const

/** 本文件会带出来的错误码都在契约 errors.json 里，这里只是收敛成字面量联合。 */
type FailCode =
  | 'VALIDATION_ERROR'
  | 'ENTITY_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'STOCK_CONFLICT'
  | 'CHECKLIST_INCOMPLETE'
  | 'SERIAL_MISMATCH'
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

// ─────────────────────────────── 读辅助 ───────────────────────────────

interface ReservationRow {
  id: string
  stock_item_id: string | null
  quantity_bucket_ref: string | null
  line_ref: string
  qty: number
  status: string
}

async function readActiveReservations(
  db: OperationsDb,
  storeId: number,
  orderId: string,
): Promise<ReservationRow[]> {
  const result = await db
    .prepare(
      `SELECT id, stock_item_id, quantity_bucket_ref, line_ref, qty, status
       FROM stock_reservations WHERE store_id = ? AND order_ref = ? AND status = 'active'`,
    )
    .bind(storeId, orderId)
    .all<ReservationRow>()
  return result.results ?? []
}

/** 逐件占用：这一行指定的实物当前是否有一条有效占用。 */
function isItemReserved(reservations: readonly ReservationRow[], stockItemId: string): boolean {
  return reservations.some((row) => row.stock_item_id === stockItemId)
}

/** 数量件占用：这一行按数量已经锁住了多少件。 */
function reservedQtyForLine(reservations: readonly ReservationRow[], lineRef: string): number {
  let total = 0
  for (const row of reservations) {
    if (row.status !== 'active' || !row.quantity_bucket_ref) continue
    if (row.line_ref === lineRef) total += Number(row.qty ?? 0)
  }
  return total
}

/**
 * 交付 / 备料共用的「货齐不齐」预读：逐件行看实物占用，数量件行看已锁数量。
 * 只读，用于友好提示；真正的硬闸在 plan 的守卫与 CHECK 里（§7 第 2 条）。
 */
export interface CoverageGap {
  lineId: string
  position: number
  nameSnapshot: string
  qty: number
  reservedQty: number
  shortageQty: number
}

export async function readCoverageGaps(
  db: OperationsDb,
  storeId: number,
  order: SaleOrderRow,
  lines: readonly SaleLineRow[],
): Promise<CoverageGap[]> {
  const reservations = await readActiveReservations(db, storeId, order.id)
  const gaps: CoverageGap[] = []
  for (const line of lines) {
    if (!(STOCK_REQUIRING_SOURCES as readonly string[]).includes(line.source)) continue
    const reservedQty = line.stock_item_id
      ? (isItemReserved(reservations, line.stock_item_id) ? 1 : 0)
      : reservedQtyForLine(reservations, line.id)
    const shortageQty = Math.max(0, line.qty - reservedQty)
    if (shortageQty > 0) {
      gaps.push({
        lineId: line.id,
        position: line.position,
        nameSnapshot: line.name_snapshot,
        qty: line.qty,
        reservedQty,
        shortageQty,
      })
    }
  }
  return gaps
}

/** 逐件交付的移动成本快照：取得成本 + 整备成本。未知成本为 null，不写 0（R01）。 */
async function readItemCosts(
  db: OperationsDb,
  storeId: number,
  itemIds: readonly string[],
): Promise<Map<string, { costCents: number | null; costKnown: boolean }>> {
  const out = new Map<string, { costCents: number | null; costKnown: boolean }>()
  if (itemIds.length === 0) return out
  const placeholders = itemIds.map(() => '?').join(', ')
  const result = await db
    .prepare(
      `SELECT id, acquisition_cost_cents, refurbishment_cost_cents, cost_known
       FROM stock_items WHERE store_id = ? AND id IN (${placeholders})`,
    )
    .bind(storeId, ...itemIds)
    .all<{ id: string; acquisition_cost_cents: number | null; refurbishment_cost_cents: number | null; cost_known: number }>()
  for (const row of result.results ?? []) {
    const known = row.cost_known === 1 && row.acquisition_cost_cents !== null
    out.set(row.id, {
      costCents: known
        ? (row.acquisition_cost_cents as number) + (row.refurbishment_cost_cents ?? 0)
        : null,
      costKnown: known,
    })
  }
  return out
}

// ─────────────────────────────── B04 创建零售与直接销售单 ───────────────────────────────

export interface RetailLineInput {
  source: string
  nameSnapshot: string
  specSnapshot?: string | null
  qty: number
  unitPriceCents: number
  /** 商品引用（hardware.entity_id）。new 行必填；used 行由实物反推。 */
  productRef?: string | null
  /** 二手件必须指定具体实物。 */
  stockItemId?: string | null
  warrantySnapshot?: string | null
}

export interface RetailOrderInput {
  kind: string
  /** 已在路由层校验过形状的客户快照 JSON（契约 CustomerSnapshot 形状）。 */
  customerSnapshot: string
  lines: RetailLineInput[]
  /** 条款快照 JSON；交付闸门「条款固化」读它是否为空。 */
  termsSnapshot: string | null
  dueAt: string | null
  note: string | null
  /** 整单优惠（分）。契约 B04 的行字段含 discountAllocationCents，这里按 money-rules 分摊。 */
  discountCents: number
}

interface ResolvedRetailLine {
  source: string
  nameSnapshot: string
  specSnapshot: string | null
  qty: number
  unitPriceCents: number
  productId: number | null
  stockItemId: string | null
  warrantySnapshot: string | null
}

function parseRetailLines(
  input: RetailOrderInput,
  requestId: string,
): { lines: RetailLineInput[] } | { problem: Failure } {
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return { problem: fail(requestId, 'VALIDATION_ERROR', '零售单至少要有一行', 400) }
  }
  if (input.lines.length > MAX_LINES) {
    return { problem: fail(requestId, 'VALIDATION_ERROR', `销售行最多 ${MAX_LINES} 行`, 400) }
  }
  for (const [index, line] of input.lines.entries()) {
    const at = `第 ${index + 1} 行`
    if (typeof line.source !== 'string'
      || !['new', 'used', 'customer', 'service'].includes(line.source)) {
      return { problem: fail(requestId, 'VALIDATION_ERROR', `${at}来源只能是 new / used / customer / service`, 400) }
    }
    if (typeof line.nameSnapshot !== 'string' || !line.nameSnapshot.trim()) {
      return { problem: fail(requestId, 'VALIDATION_ERROR', `${at}缺名称`, 400) }
    }
    if (isExtensionWarrantyLine(line.nameSnapshot) || isExtensionWarrantyLine(line.specSnapshot)) {
      return { problem: fail(requestId, 'VALIDATION_ERROR', `${at}${EXTENSION_WARRANTY_DEFERRED_MESSAGE}`, 400) }
    }
    if (containsExtensionWarrantyCommitment(line.warrantySnapshot)) {
      return { problem: fail(requestId, 'VALIDATION_ERROR', `${at}${EXTENSION_WARRANTY_DEFERRED_MESSAGE}`, 400) }
    }
    if (!Number.isInteger(line.qty) || line.qty <= 0) {
      return { problem: fail(requestId, 'VALIDATION_ERROR', `${at}数量必须是正整数`, 400) }
    }
    if (!Number.isInteger(line.unitPriceCents) || line.unitPriceCents < 0) {
      return { problem: fail(requestId, 'VALIDATION_ERROR', `${at}单价必须是整数分`, 400) }
    }
    if (line.source === 'used' && (!line.stockItemId || !line.stockItemId.trim())) {
      return { problem: fail(requestId, 'VALIDATION_ERROR', `${at}二手件必须指定实物`, 400) }
    }
    if (line.source === 'used' && line.qty !== 1) {
      return { problem: fail(requestId, 'VALIDATION_ERROR', `${at}二手件一次只能卖 1 件`, 400) }
    }
    if (line.source === 'customer' && (line.unitPriceCents !== 0 || line.qty !== 1)) {
      return {
        problem: fail(
          requestId,
          'VALIDATION_ERROR',
          `${at}客供件本身不带价（售价 0）且数量为 1，装机服务费请另列一行`,
          400,
        ),
      }
    }
    if (line.source === 'new' && (!line.productRef || !line.productRef.trim())) {
      return {
        problem: fail(
          requestId,
          'VALIDATION_ERROR',
          `${at}新品必须选商品 —— 直接零售没有报价环节兜底，不能再补映射`,
          400,
        ),
      }
    }
  }
  return { lines: input.lines }
}

/**
 * 解析零售行的商品主键。
 * new 行按 productRef（hardware.entity_id）查；used 行按实物反推 ——
 * 与 B03/B05 的口径一致：商品主键由实物给出，不从名称猜。
 */
async function resolveRetailProducts(
  db: OperationsDb,
  storeId: number,
  lines: readonly RetailLineInput[],
): Promise<{ lines: ResolvedRetailLine[]; items: Map<string, StockItemRow>; missing: string[] }> {
  const refs = [...new Set(
    lines.map((line) => (line.productRef ?? '').trim()).filter((value) => value !== ''),
  )]
  const itemIds = [...new Set(
    lines.map((line) => (line.stockItemId ?? '').trim()).filter((value) => value !== ''),
  )]
  const byRef = new Map<string, number>()
  if (refs.length > 0) {
    const placeholders = refs.map(() => '?').join(', ')
    const result = await db
      .prepare(`SELECT id, entity_id FROM hardware WHERE store_id = ? AND entity_id IN (${placeholders})`)
      .bind(storeId, ...refs)
      .all<{ id: number; entity_id: string }>()
    for (const row of result.results ?? []) byRef.set(row.entity_id, row.id)
  }
  const items = await readStockItems(db, storeId, itemIds)

  const missing: string[] = []
  const resolved: ResolvedRetailLine[] = lines.map((line, index) => {
    let productId: number | null = null
    if (line.source === 'used') {
      const item = line.stockItemId ? items.get(line.stockItemId.trim()) : undefined
      if (!item) missing.push(`第 ${index + 1} 行「${line.nameSnapshot}」指定的实物不存在或不属于本店`)
      else productId = item.product_id
    } else if (line.source === 'new') {
      productId = byRef.get((line.productRef ?? '').trim()) ?? null
      if (productId === null) missing.push(`第 ${index + 1} 行「${line.nameSnapshot}」选的商品不存在`)
    }
    return {
      source: line.source,
      nameSnapshot: line.nameSnapshot.trim(),
      specSnapshot: line.specSnapshot?.trim() ? line.specSnapshot.trim() : null,
      qty: line.qty,
      unitPriceCents: line.unitPriceCents,
      productId,
      stockItemId: line.source === 'used' ? (line.stockItemId ?? '').trim() : null,
      warrantySnapshot: line.warrantySnapshot ?? null,
    }
  })
  return { lines: resolved, items, missing }
}

export function planCreateRetailOrder(
  db: OperationsDb,
  ctx: OperationContext,
  order: SaleOrderRow,
  lines: readonly ResolvedRetailLine[],
): OperationPlan {
  const allocations = allocateDiscount(
    lines.map((line, index) => ({ position: index, unitPriceCents: line.unitPriceCents, qty: line.qty })),
    order.discount_cents,
  )
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO sale_orders
           (id, store_id, order_no, quote_id, quote_revision, customer_id, customer_snapshot, kind,
            trade_state, fulfillment_state, due_at, configuration_version,
            subtotal_cents, discount_cents, adjustment_cents, total_cents,
            cash_net_cents, offset_net_cents, balance_cents, balance_direction,
            note, terms_snapshot, version, request_id, created_by, updated_by)
         VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?,
                 'draft', 'waiting_stock', ?, 0,
                 ?, ?, 0, ?, 0, 0, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(
        order.id,
        ctx.storeId,
        order.order_no,
        order.customer_snapshot,
        order.kind,
        order.due_at,
        order.subtotal_cents,
        order.discount_cents,
        order.total_cents,
        order.balance_cents,
        order.balance_direction,
        order.note,
        order.terms_snapshot,
        ctx.requestId,
        ctx.actorUserId,
        ctx.actorUserId,
      ),
    guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ?)', ctx.storeId, order.id),
  ]
  for (const [index, line] of lines.entries()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO sale_lines
             (id, store_id, sale_order_id, position, product_id, source, name_snapshot, spec_snapshot,
              qty, unit_price_cents, discount_allocation_cents, net_line_cents,
              warranty_snapshot, stock_item_id, customer_device_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .bind(
          `${ctx.requestId}::line-${index}`,
          ctx.storeId,
          order.id,
          index,
          line.productId,
          line.source,
          line.nameSnapshot,
          line.specSnapshot ?? '',
          line.qty,
          line.unitPriceCents,
          allocations[index],
          line.unitPriceCents * line.qty - allocations[index],
          line.warrantySnapshot,
          line.stockItemId,
        ),
    )
  }
  return {
    statements,
    outcome: {
      entityType: 'SaleOrder',
      entityId: order.id,
      version: 1,
      summary: `新建${order.kind === 'retail' ? '零售' : '直接销售'}单 ${order.order_no}`,
      effects: { lineCount: lines.length, totalCents: order.total_cents },
    },
  }
}

/** B04 入口。重放保护放在业务预读之前（E05b 的教训：先查幂等，再谈业务）。 */
export async function createRetailOrder(
  db: OperationsDb,
  ctx: OperationContext,
  input: RetailOrderInput,
): Promise<RunResult> {
  const action = 'B04'
  const payloadHash = await hashPayload({ input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  if (!(SALE_KINDS as readonly string[]).includes(input.kind)) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', 'kind 只能是 retail 或 assembly', 400)
  }
  if (typeof input.customerSnapshot !== 'string' || !input.customerSnapshot.trim()) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '必须带客户快照（customerSnapshot）', 400)
  }
  if (input.termsSnapshot !== null && typeof input.termsSnapshot !== 'string') {
    return fail(ctx.requestId, 'VALIDATION_ERROR', 'termsSnapshot 必须是字符串或 null', 400)
  }
  if (!Number.isInteger(input.discountCents) || input.discountCents < 0) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '整单优惠必须是整数分', 400)
  }
  if (input.dueAt !== null && Number.isNaN(new Date(input.dueAt).getTime())) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '交期不是合法时间', 400)
  }

  const parsed = parseRetailLines(input, ctx.requestId)
  if ('problem' in parsed) return parsed.problem

  const resolved = await resolveRetailProducts(db, ctx.storeId, parsed.lines)
  if (resolved.missing.length > 0) {
    return fail(
      ctx.requestId,
      'VALIDATION_ERROR',
      `${resolved.missing.join('；')}。成交前必须选好商品`,
      400,
    )
  }

  // 二手实物必须现在就可占：B04 不预留，但把「这台其实已经被别的单占了」提前说清楚，
  // 免得店员收了钱才发现要退款（B03 的同一预检口径）。
  for (const [index, line] of resolved.lines.entries()) {
    if (line.source !== 'used') continue
    const item = line.stockItemId ? resolved.items.get(line.stockItemId) : undefined
    if (!item || item.ownership !== 'store' || item.availability !== 'available') {
      return fail(
        ctx.requestId,
        'STOCK_CONFLICT',
        `第 ${index + 1} 行「${line.nameSnapshot}」指定的实物当前不可占用`,
        409,
      )
    }
  }

  const subtotal = resolved.lines.reduce((sum, line) => sum + line.unitPriceCents * line.qty, 0)
  if (input.discountCents > subtotal) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '整单优惠不能超过小计', 400)
  }
  const total = subtotal - input.discountCents

  const now = new Date().toISOString()
  const orderId = `${ctx.requestId}::sale`
  const orderNo = orderNoFor(ctx.requestId, now)
  const dueAt = input.dueAt && !Number.isNaN(new Date(input.dueAt).getTime())
    ? new Date(input.dueAt).toISOString()
    : null
  // 条款快照：B04 的 terms 由调用方给出。没给就按门店默认固化 ——
  // 交付闸门「条款固化」要求这一列非空，零售单不能因为是「直接卖」就跳过。
  const termsSnapshot = input.termsSnapshot && input.termsSnapshot.trim()
    ? input.termsSnapshot
    : JSON.stringify({ depositPercent: QUOTE_SETTINGS.depositPercent })

  const order: SaleOrderRow = {
    id: orderId,
    order_no: orderNo,
    quote_id: null,
    quote_revision: null,
    customer_id: null,
    customer_snapshot: input.customerSnapshot,
    kind: input.kind,
    trade_state: 'draft',
    fulfillment_state: 'waiting_stock',
    due_at: dueAt,
    configuration_version: 0,
    subtotal_cents: subtotal,
    discount_cents: input.discountCents,
    adjustment_cents: 0,
    total_cents: total,
    cash_net_cents: 0,
    offset_net_cents: 0,
    return_credit_cents: 0,
    balance_cents: total,
    balance_direction: total > 0 ? 'client_due' : 'settled',
    note: (input.note ?? '').trim(),
    terms_snapshot: termsSnapshot,
    version: 1,
    created_at: now,
    updated_at: now,
  }

  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) =>
    planCreateRetailOrder(db, context, order, resolved.lines),
  )
}

// ─────────────────────────────── B06 开始备料与装机 ───────────────────────────────

export interface StartAssemblyInput {
  /** 领料位置（契约 StockLocation）。备料从本店拿件，其它取值没有业务含义。 */
  location: string
  /** 客供件接收引用。单里有客供件时必填，作为「已接收」这条事实的凭据。 */
  customerReceiptRef?: string | null
}

/**
 * B06 入口。
 *
 * 状态推进（enums.json SaleFulfillmentState 的两条 B06 出边）：
 *   waiting_stock → preparing（开始备料）
 *   preparing → testing（备料完成，提交检测）
 * 同一个动作按当前阶段自动推进到下一阶段，调用方不需要传「推进到哪」。
 *
 * 守卫（enums.json B06 的 guard「所需店有件已预留，客供件已接收」）：
 *   · 交易已确认（B05 定金闸过了，货才锁得住）；
 *   · 每一行需要店有货的行都已足额占用 —— 没占齐就走采购/补分配，不能空手开始装机；
 *   · 单里有客供件时必须给出接收引用，否则装到一半发现机器不在店里。
 */
export async function startAssembly(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: StartAssemblyInput,
): Promise<RunResult> {
  const action = 'B06'
  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  if (input.location !== 'store') {
    return fail(
      ctx.requestId,
      'VALIDATION_ERROR',
      '领料位置只能是 store（备料从本店拿件）；客供件走 customerReceiptRef',
      400,
    )
  }

  const order = await readOrder(db, ctx.storeId, orderId)
  if (!order) {
    return fail(ctx.requestId, 'ENTITY_NOT_FOUND', '销售单不存在或不属于当前门店', 404)
  }
  if (order.trade_state !== 'confirmed') {
    return fail(
      ctx.requestId,
      'VALIDATION_ERROR',
      `只有已成交的单能备料，这张单目前是「${order.trade_state}」；先收款并确认成交`,
      400,
    )
  }
  if (order.fulfillment_state !== 'waiting_stock' && order.fulfillment_state !== 'preparing') {
    return fail(
      ctx.requestId,
      'VALIDATION_ERROR',
      `这张单已在「${order.fulfillment_state}」阶段，不需要再备料`,
      400,
    )
  }

  const lines = await readSaleLines(db, ctx.storeId, orderId)
  const gaps = await readCoverageGaps(db, ctx.storeId, order, lines)
  if (gaps.length > 0) {
    const detail = gaps
      .map((gap) => `${gap.nameSnapshot} 还差 ${gap.shortageQty} 件`)
      .join('；')
    return fail(
      ctx.requestId,
      'VALIDATION_ERROR',
      `店有件还没占齐：${detail}。先去「库存 → 缺件处理」补货，或补分配实物`,
      400,
    )
  }

  const customerLines = lines.filter((line) => line.source === 'customer')
  const receiptRef = (input.customerReceiptRef ?? '').trim()
  if (customerLines.length > 0 && !receiptRef) {
    return fail(
      ctx.requestId,
      'OWNERSHIP_INVALID',
      '这张单里有客供件，开始备料前必须先填客供件接收引用（机器确实拿到手里了）',
      422,
    )
  }

  const toState = order.fulfillment_state === 'waiting_stock' ? 'preparing' : 'testing'
  const nextVersion = order.version + 1
  const now = new Date().toISOString()

  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements: D1PreparedStatement[] = [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ?)', context.storeId, order.id),
      guardStatement(
        db,
        'VERSION_CONFLICT',
        'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND version = ?)',
        context.storeId,
        order.id,
        order.version,
      ),
      // 只在仍是预期阶段时推进：并发下另一个 B06 已把它推进到下一阶段时，这里 0 行命中。
      db
        .prepare(
          `UPDATE sale_orders
           SET fulfillment_state = ?, version = version + 1, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ? AND fulfillment_state = ?`,
        )
        .bind(toState, context.actorUserId, now, context.storeId, order.id, order.version, order.fulfillment_state),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'sale_orders', 'id', order.id, nextVersion),
      bumpVersionStatement(db, context, 'SaleOrder', order.id, nextVersion),
    ]
    if (receiptRef) {
      // 客供件「已接收」这条事实落审计：契约 B06 的 effects 里 InventoryMovement 指的是
      // 客供件入店，而 customer_custody 桶没有落地结构（E10 的 CustomerDevice），
      // 所以这里只记事实，不写一条语义不成立的库存流水。
      statements.push(
        db
          .prepare(
            `INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details)
             VALUES (?, ?, 'B06.customer-receipt', 'SaleOrder', ?, ?)`,
          )
          .bind(
            context.storeId,
            context.actorUserId,
            order.id,
            JSON.stringify({ customerReceiptRef: receiptRef, at: now }),
          ),
      )
    }
    return {
      statements,
      outcome: {
        entityType: 'SaleOrder',
        entityId: order.id,
        version: nextVersion,
        summary: toState === 'preparing'
          ? `已开始备料，领料位置：本店`
          : `备料完成，进入检测`,
        effects: { fromState: order.fulfillment_state, toState },
      },
    }
  })
}

// ─────────────────────────────── B07 保存装机检测结果 ───────────────────────────────

export interface CheckItemInput {
  key: string
  label: string
  kind: string
  state: string
  note?: string | null
  /** 逐件坏件隔离：检测不通过时指向具体坏掉的实物（可选；数量件与未命名实物不填）。 */
  stockItemId?: string | null
}

export interface SaveChecksInput {
  templateVersion: string
  configurationVersion: number
  items: CheckItemInput[]
  resultEvidence?: string[]
}

interface StoredCheckItem {
  key: string
  label: string
  kind: CheckItemKind
  state: CheckItemState
  note: string
  stockItemId: string | null
}

interface ChecklistRow {
  id: string
  checklist_version: number
  configuration_version: number
  items_json: string
  result: string
}

async function readLatestChecklist(
  db: OperationsDb,
  storeId: number,
  orderId: string,
): Promise<ChecklistRow | null> {
  return (await db
    .prepare(
      `SELECT id, checklist_version, configuration_version, items_json, result
       FROM sale_checklists WHERE store_id = ? AND sale_order_id = ?
       ORDER BY checklist_version DESC LIMIT 1`,
    )
    .bind(storeId, orderId)
    .first<ChecklistRow>()) ?? null
}

/**
 * 合并检查项（契约 B07 的 changedItems 是增量语义）：
 *   · 上一份检查单与本次配置版本相同 → 按 key 合并，客户端只发改过的项也能完整保留其它项；
 *   · 配置版本变了（改配 / 换件）→ 全部重来，旧项不继承（Checklist.rules 第 2 条「失效」）。
 */
function mergeItems(previous: ChecklistRow | null, incoming: CheckItemInput[], configurationVersion: number): StoredCheckItem[] {
  const merged = new Map<string, StoredCheckItem>()
  if (previous && previous.configuration_version === configurationVersion) {
    try {
      const parsed = JSON.parse(previous.items_json) as StoredCheckItem[]
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.key === 'string') {
            // 旧记录可能没有 stockItemId 字段，归一化成 null，不让历史数据崩掉合并。
            merged.set(item.key, {
              key: item.key,
              label: item.label ?? '',
              kind: item.kind,
              state: item.state,
              note: item.note ?? '',
              stockItemId: item.stockItemId ?? null,
            })
          }
        }
      }
    } catch {
      // 上一份记录坏了就当没有：重新按本次提交建，不编造历史。
    }
  }
  for (const item of incoming) {
    merged.set(item.key, {
      key: item.key,
      label: item.label,
      kind: item.kind as CheckItemKind,
      state: item.state as CheckItemState,
      note: (item.note ?? '').trim(),
      stockItemId: (item.stockItemId ?? '').trim() || null,
    })
  }
  return [...merged.values()]
}

function deriveResult(items: readonly StoredCheckItem[]): CheckResult {
  if (items.some((item) => item.state === 'fail')) return 'failed'
  if (items.length > 0 && items.every((item) => item.state === 'pass')) return 'passed'
  return 'incomplete'
}

/**
 * B07 入口。
 *
 * 结论由检查项派生（enums.json ChecklistResult.desc「由检查项派生」），不由客户端报：
 *   任一项 fail → failed；全部 pass → passed；否则 incomplete。
 * 「结果 = passed 但还有项没勾」会在 plan 里被 CHECKLIST_INCOMPLETE 守卫拦下 ——
 * 「不能勾中就假装已经服务器保存」（02 §6）的反向：也不能「没勾完就报通过」。
 *
 * 状态推进（enums.json SaleFulfillmentState 的 B07 出边）：
 *   · passed：assembly 单从 testing → ready_delivery；retail 单从 waiting_stock / preparing
 *     直达 ready_delivery（B04 notes：零售跳过装机与检测）。
 *   · failed：回到 waiting_stock（释放占用、缺口重现，见 plan）。
 *   · incomplete：只记录事实，不推进。
 */
export async function saveAssemblyChecks(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: SaveChecksInput,
): Promise<RunResult> {
  const action = 'B07'
  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  if (typeof input.templateVersion !== 'string' || !input.templateVersion.trim()) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '必须给检查单模板版本（templateVersion）', 400)
  }
  if (!Number.isInteger(input.configurationVersion) || input.configurationVersion < 0) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', 'configurationVersion 必须是非负整数', 400)
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return fail(ctx.requestId, 'CHECKLIST_INCOMPLETE', '至少要有一项检查记录', 422)
  }
  if (input.items.length > MAX_LINES) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', `检查项最多 ${MAX_LINES} 项`, 400)
  }
  const seenKeys = new Set<string>()
  for (const [index, item] of input.items.entries()) {
    const at = `第 ${index + 1} 项`
    if (typeof item.key !== 'string' || !item.key.trim()) {
      return fail(ctx.requestId, 'VALIDATION_ERROR', `${at}缺 key`, 400)
    }
    if (seenKeys.has(item.key)) {
      return fail(ctx.requestId, 'VALIDATION_ERROR', `${at}key 重复（${item.key}）`, 400)
    }
    seenKeys.add(item.key)
    if (typeof item.label !== 'string' || !item.label.trim()) {
      return fail(ctx.requestId, 'VALIDATION_ERROR', `${at}缺名称`, 400)
    }
    if (!(CHECK_ITEM_KINDS as readonly string[]).includes(item.kind)) {
      return fail(ctx.requestId, 'VALIDATION_ERROR', `${at}kind 只能是 check 或 test`, 400)
    }
    if (!(CHECK_ITEM_STATES as readonly string[]).includes(item.state)) {
      return fail(ctx.requestId, 'VALIDATION_ERROR', `${at}state 只能是 pending / pass / fail`, 400)
    }
  }
  const evidence = input.resultEvidence ?? []
  if (evidence.length > 0) {
    return fail(
      ctx.requestId,
      'VALIDATION_ERROR',
      '检测附件（resultEvidence）依赖 B35 附件上传，尚未实现；先不要提交照片引用',
      400,
    )
  }

  const order = await readOrder(db, ctx.storeId, orderId)
  if (!order) {
    return fail(ctx.requestId, 'ENTITY_NOT_FOUND', '销售单不存在或不属于当前门店', 404)
  }
  if (order.trade_state !== 'confirmed') {
    return fail(ctx.requestId, 'VALIDATION_ERROR', `这张单目前是「${order.trade_state}」，不能记录检测结果`, 400)
  }
  if (order.fulfillment_state === 'delivered') {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '这张单已经交付，检测结果不再变更', 400)
  }
  // 改配置让检测失效（Checklist.rules 第 2 条）：配置版本对不上就拒绝，
  // 不把旧配置的结论偷偷挂到新配置上。
  if (input.configurationVersion !== order.configuration_version) {
    return fail(
      ctx.requestId,
      'VERSION_CONFLICT',
      `检测结果对应的是配置第 ${input.configurationVersion} 版，这张单当前是第 ${order.configuration_version} 版；改过配置就要重新检测`,
      409,
    )
  }
  if (order.kind === 'assembly' && order.fulfillment_state === 'waiting_stock') {
    return fail(
      ctx.requestId,
      'VALIDATION_ERROR',
      '还没开始备料：先「开始备料」，装完机再记检测结果',
      400,
    )
  }

  const previous = await readLatestChecklist(db, ctx.storeId, orderId)
  const items = mergeItems(previous, input.items, input.configurationVersion)
  const result = deriveResult(items)

  // 逐件坏件隔离：失败的检查项若指向具体实物，检测不通过时隔离该件而不是整单释放。
  // 收集去重后校验每一项都确实是这张单的实物行（防止乱隔离别单/别家的货）。
  // 不校验「有没有 active 占用」—— 隔离 SQL 本身是条件式（只在仍 reserved 时生效），
  // 已隔离 / 已释放的件命中 0 行，不重复落账，幂等安全。
  const quarantineItemIds = result === 'failed'
    ? [...new Set(
        items
          .filter((item) => item.state === 'fail' && item.stockItemId)
          .map((item) => item.stockItemId as string),
      )]
    : []
  if (quarantineItemIds.length > 0) {
    const lines = await readSaleLines(db, ctx.storeId, orderId)
    const lineItemIds = new Set(
      lines.map((line) => line.stock_item_id).filter((value): value is string => Boolean(value)),
    )
    for (const itemId of quarantineItemIds) {
      if (!lineItemIds.has(itemId)) {
        return fail(
          ctx.requestId,
          'VALIDATION_ERROR',
          `检查项关联的实物「${itemId}」不属于这张单，不能隔离`,
          400,
        )
      }
    }
  }

  // 「结论 = passed 但仍有未勾/未过项」是自相矛盾，直接拒绝。
  if (result === 'passed' && items.some((item) => item.state !== 'pass')) {
    return fail(ctx.requestId, 'CHECKLIST_INCOMPLETE', '还有检查项没有通过，不能记成「通过」', 422)
  }
  if (result === 'passed' && order.kind === 'assembly' && order.fulfillment_state !== 'testing') {
    return fail(
      ctx.requestId,
      'VALIDATION_ERROR',
      `装机单要通过检测得先进入检测阶段，这张单目前在「${order.fulfillment_state}」；备料完成后点「提交检测」`,
      400,
    )
  }

  const checklistVersion = (previous?.checklist_version ?? 0) + 1
  const now = new Date().toISOString()
  const checklistId = `${ctx.requestId}::checks`
  const nextVersion = order.version + 1
  const toState: string | null = result === 'passed'
    ? 'ready_delivery'
    : result === 'failed' ? 'waiting_stock' : null

  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements: D1PreparedStatement[] = [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ?)', context.storeId, order.id),
      guardStatement(
        db,
        'VERSION_CONFLICT',
        'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND version = ?)',
        context.storeId,
        order.id,
        order.version,
      ),
      db
        .prepare(
          `INSERT INTO sale_checklists
             (id, store_id, sale_order_id, checklist_version, template_version, configuration_version,
              items_json, result, performed_at, performed_by, version, request_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .bind(
          checklistId,
          context.storeId,
          order.id,
          checklistVersion,
          input.templateVersion.trim(),
          input.configurationVersion,
          JSON.stringify(items),
          result,
          now,
          context.actorUserId,
          context.requestId,
        ),
      // 检查单版本唯一：并发提交时后到的一批整批回滚，重新读取再提交。
      guardStatement(
        db,
        'VERSION_CONFLICT',
        `NOT EXISTS (SELECT 1 FROM sale_checklists
                     WHERE store_id = ? AND sale_order_id = ? AND checklist_version = ?)`,
        context.storeId,
        order.id,
        checklistVersion,
      ),
    ]

    if (toState) {
      statements.push(
        db
          .prepare(
            `UPDATE sale_orders
             SET fulfillment_state = ?, version = version + 1, updated_by = ?, updated_at = ?
             WHERE store_id = ? AND id = ? AND version = ? AND fulfillment_state = ?`,
          )
          .bind(
            toState,
            context.actorUserId,
            now,
            context.storeId,
            order.id,
            order.version,
            order.fulfillment_state,
          ),
        assertRowVersionStatement(db, 'VERSION_CONFLICT', 'sale_orders', 'id', order.id, nextVersion),
        bumpVersionStatement(db, context, 'SaleOrder', order.id, nextVersion),
      )
    }

    if (result === 'failed') {
      // 检测不通过：占用全部释放，回到待备料，缺口重新出现。
      // 逐件坏件（失败的检查项指向了具体实物）→ 隔离进 quarantine，不回流 available，
      //   防止已知坏件被再次卖出（账实一致）；其余占用（数量件、未命名实物的失败项）
      //   → 整单释放回 available。
      statements.push(
        db
          .prepare(
            `UPDATE stock_reservations
             SET status = 'released', closed_at = ?, version = version + 1
             WHERE store_id = ? AND order_ref = ? AND status = 'active'`,
          )
          .bind(now, context.storeId, order.id),
      )

      // 逐件坏件隔离：reserved → quarantine 流水（来源 inspection_quarantine）+ 实物改 quarantine。
      // 条件式写入：只在「该件仍 reserved」时生效，已隔离 / 已释放的件命中 0 行，不重复落账。
      quarantineItemIds.forEach((itemId, index) => {
        statements.push(
          db
            .prepare(
              `INSERT INTO inventory_movements
                 (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
                  source, occurred_at, actor_user_id, request_id)
               SELECT ?, si.store_id, si.product_id, si.id, 1, 'reserved', 'quarantine', NULL,
                      'inspection_quarantine', ?, ?, ?
               FROM stock_items si
               WHERE si.store_id = ? AND si.id = ? AND si.availability = 'reserved'`,
            )
            .bind(
              `${context.requestId}::q-mv-${index}`,
              now,
              context.actorUserId,
              context.requestId,
              context.storeId,
              itemId,
            ),
          db
            .prepare(
              `UPDATE stock_items SET availability = 'quarantine', version = version + 1, updated_at = ?
               WHERE store_id = ? AND id = ? AND availability = 'reserved'`,
            )
            .bind(now, context.storeId, itemId),
        )
      })
      statements.push(
        db
          .prepare(
            `INSERT INTO inventory_movements
               (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
                source, occurred_at, actor_user_id, request_id)
             SELECT ?, si.store_id, si.product_id, si.id, 1, 'reserved', 'available', NULL,
                    'unreservation', ?, ?, ?
             FROM stock_items si
             WHERE si.store_id = ? AND si.availability = 'reserved' AND si.id IN (
               SELECT stock_item_id FROM stock_reservations
               WHERE store_id = ? AND order_ref = ? AND status = 'released' AND closed_at = ?
                 AND stock_item_id IS NOT NULL)`,
          )
          .bind(
            `${context.requestId}::unrsv-mv`,
            now,
            context.actorUserId,
            context.requestId,
            context.storeId,
            context.storeId,
            order.id,
            now,
          ),
        // 条件更新后实物必须真的回到 available：状态卡在 reserved 会让这张单永远占不到货。
        db
          .prepare(
            `UPDATE stock_items SET availability = 'available', version = version + 1, updated_at = ?
             WHERE store_id = ? AND availability = 'reserved' AND id IN (
               SELECT stock_item_id FROM stock_reservations
               WHERE store_id = ? AND order_ref = ? AND status = 'released' AND closed_at = ?
                 AND stock_item_id IS NOT NULL)`,
          )
          .bind(now, context.storeId, context.storeId, order.id, now),
      )
      // 逐件占用释放后，对应的实物必须离开 reserved（要么回 available，要么隔离进 quarantine）；
      // 状态卡在 reserved 会让这张单永远占不到货。
      statements.push(
        guardStatement(
          db,
          'STOCK_CONFLICT',
          `EXISTS (SELECT 1 FROM stock_reservations r JOIN stock_items si ON si.id = r.stock_item_id
                   WHERE r.store_id = ? AND r.order_ref = ? AND r.status = 'released' AND r.closed_at = ?
                     AND r.stock_item_id IS NOT NULL AND si.availability = 'reserved')`,
          context.storeId,
          order.id,
          now,
        ),
      )
      // 数量件释放：把锁走的数量还回可用桶。没有这一条，释放一次库存就漏一次 ——
      // stock_balances 只由流水触发器维护，改占用记录不会自己把数量加回去。
      // 商品主键从销售行取（stock_reservations 没有商品列）。
      statements.push(
        db
          .prepare(
            `INSERT INTO inventory_movements
               (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
                source, occurred_at, actor_user_id, request_id)
             SELECT ?, r.store_id, l.product_id, NULL, SUM(r.qty), 'reserved', 'available', NULL,
                    'unreservation', ?, ?, ?
             FROM stock_reservations r
               JOIN sale_lines l ON l.store_id = r.store_id AND l.id = r.line_ref
             WHERE r.store_id = ? AND r.order_ref = ? AND r.status = 'released' AND r.closed_at = ?
               AND r.quantity_bucket_ref IS NOT NULL
             GROUP BY l.product_id`,
          )
          .bind(
            `${context.requestId}::unrsv-qmv`,
            now,
            context.actorUserId,
            context.requestId,
            context.storeId,
            order.id,
            now,
          ),
      )
    }

    return {
      statements,
      outcome: {
        entityType: 'SaleOrder',
        entityId: order.id,
        version: toState ? nextVersion : order.version,
        summary: result === 'passed'
          ? '检测通过，可以办理交付'
          : result === 'failed'
            ? '检测不通过：已释放占用，回到待备料'
            : `已保存 ${items.length} 项检查记录（未全部完成）`,
        effects: {
          checklistId,
          checklistVersion,
          result,
          itemCount: items.length,
          ...(toState ? { toState } : {}),
        },
      },
    }
  })
}

// ─────────────────────────────── B10 确认交付 ───────────────────────────────

export interface DeliverInput {
  configurationVersion: number
  checklistVersion: number | null
  deliveryNote: string
  receivedByNote?: string | null
  creditApprovalRef?: string | null
}

export interface DeliveryLineSnapshot {
  position: number
  nameSnapshot: string
  source: string
  qty: number
  stockItemId: string | null
  costCents: number | null
  costKnown: boolean
}

/**
 * B10 入口。
 *
 * 交付闸门（03 §7 / objects.json Delivery.rules 第 2 条），逐条落点：
 *   1. 订单有效            → trade_state = 'confirmed'
 *   2. 实物来源解决        → 每一行需要店有货的行都已足额占用（coverage 无缺口）
 *   3. 有效预留未失效      → 同上（占用以 stock_reservations.status='active' 为准）
 *   4. 逐件实物有内部编号；厂家 SN 可选
 *   5. 检查通过            → assembly 单必须有本配置版本的 passed 检查单；retail 单跳过
 *   6. 条款固化            → terms_snapshot 非空（B03 / B04 都会固化）
 *   7. 款项结清或有批准欠款 → 余额 ≤ 0；欠款路径需要 B09，本卡未实现，明确拒绝
 *   8. 同订单未交付过      → sale_deliveries 的 UNIQUE(store_id, sale_order_id)
 *
 * 交付 = 交付记录 + 库存出库 + 成本快照，一个 batch 里同时成立；
 * 中间任一条语句失败整批回滚，不会出现「单交付了、货还在仓库」的半截账。
 */
export async function deliverSaleOrder(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: DeliverInput,
): Promise<RunResult> {
  const action = 'B10'
  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  if (!Number.isInteger(input.configurationVersion) || input.configurationVersion < 0) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', 'configurationVersion 必须是非负整数', 400)
  }
  if (typeof input.deliveryNote !== 'string' || !input.deliveryNote.trim()) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '交付备注必填（交付给谁、怎么交的）', 400)
  }

  const order = await readOrder(db, ctx.storeId, orderId)
  if (!order) {
    return fail(ctx.requestId, 'ENTITY_NOT_FOUND', '销售单不存在或不属于当前门店', 404)
  }
  if (order.trade_state !== 'confirmed') {
    return fail(
      ctx.requestId,
      'VALIDATION_ERROR',
      `只有已成交的单能交付，这张单目前是「${order.trade_state}」`,
      400,
    )
  }
  if (order.fulfillment_state === 'delivered') {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '这张单已经交付过，不会交付第二次', 400)
  }
  if (order.fulfillment_state !== 'ready_delivery') {
    return fail(
      ctx.requestId,
      'VALIDATION_ERROR',
      `这张单还在「${order.fulfillment_state}」，没到交付阶段；${order.kind === 'retail' ? '零售单记录核对结果后' : '检测通过后'}才能交付`,
      400,
    )
  }
  // 配置版本对不上 = 交付的不是谈好的那一版（契约 B10 inputs + Checklist.rules 第 3 条）。
  if (input.configurationVersion !== order.configuration_version) {
    return fail(
      ctx.requestId,
      'VERSION_CONFLICT',
      `要交付的是配置第 ${input.configurationVersion} 版，这张单当前是第 ${order.configuration_version} 版`,
      409,
    )
  }
  if (!order.terms_snapshot || !order.terms_snapshot.trim()) {
    return fail(ctx.requestId, 'VALIDATION_ERROR', '这张单没有条款快照，不能交付（条款必须先固化）', 400)
  }

  const lines = await readSaleLines(db, ctx.storeId, orderId)

  // 闸门 2/3：实物来源与有效预留。
  const gaps = await readCoverageGaps(db, ctx.storeId, order, lines)
  if (gaps.length > 0) {
    const detail = gaps.map((gap) => `${gap.nameSnapshot} 还差 ${gap.shortageQty} 件`).join('；')
    return fail(ctx.requestId, 'VALIDATION_ERROR', `还有货没占住，不能交付：${detail}`, 400)
  }

  // 闸门 5：检查通过。零售单按 B04 notes 跳过装机与检测，不要求检查单。
  let checklistVersion: number | null = null
  if (order.kind === 'assembly') {
    const latest = await readLatestChecklist(db, ctx.storeId, orderId)
    if (!latest || latest.result !== 'passed' || latest.configuration_version !== order.configuration_version) {
      return fail(
        ctx.requestId,
        'CHECKLIST_INCOMPLETE',
        '这张单还没有「通过」的装机检测记录；先检测通过再交付',
        422,
      )
    }
    if (input.checklistVersion !== null && input.checklistVersion !== latest.checklist_version) {
      return fail(
        ctx.requestId,
        'VERSION_CONFLICT',
        `要交付的检查单是第 ${input.checklistVersion} 版，最新通过的是第 ${latest.checklist_version} 版；刷新后再交付`,
        409,
      )
    }
    checklistVersion = latest.checklist_version
  } else if (input.checklistVersion !== null) {
    return fail(
      ctx.requestId,
      'VALIDATION_ERROR',
      '零售单不走装机检测，不要传 checklistVersion',
      400,
    )
  }

  // 闸门 7：款项结清，或有老板批准的欠款（B09）。
  // B09 批准的是「当时欠款余额」快照，B10 交付时以 creditApprovalRef 引用它做凭证。
  const balance = order.balance_cents
  const creditRef = (input.creditApprovalRef ?? '').trim()
  let creditApprovalId: string | null = null
  if (balance > 0) {
    if (!creditRef) {
      return fail(
        ctx.requestId,
        'VALIDATION_ERROR',
        `尾款还没结清（待收 ${(balance / 100).toFixed(2)} 元），先收款再交付，或由老板批准欠款交付`,
        400,
      )
    }
    const approval = await db
      .prepare(`SELECT id FROM sale_credit_approvals WHERE store_id = ? AND id = ? AND sale_order_id = ?`)
      .bind(ctx.storeId, creditRef, orderId)
      .first<{ id: string }>()
    if (!approval) {
      return fail(
        ctx.requestId,
        'VALIDATION_ERROR',
        '欠款批准凭证不存在，或不属于这张单；请老板先执行「批准欠款交付」',
        400,
      )
    }
    creditApprovalId = approval.id
  } else if (creditRef) {
    return fail(
      ctx.requestId,
      'VALIDATION_ERROR',
      '这张单已经结清，不需要欠款批准凭证；请去掉 creditApprovalRef',
      400,
    )
  }

  // 内部编号由 stock_items 的 NOT NULL + CHECK 保证；厂家 SN 可选。
  const itemIds = lines
    .map((line) => line.stock_item_id)
    .filter((value): value is string => Boolean(value))
  // 成本快照（逐件行）：交付当时的取得 + 整备成本。未知成本照实记 costKnown=false。
  const costs = await readItemCosts(db, ctx.storeId, itemIds)
  // 出库流水必须有商品主键；行上没落商品时按实物反推（与 B03/B05 同一口径），
  // 两边都没有就不能交付 —— 那说明这行连「卖的是什么」都说不清。
  const itemIndex = await readStockItems(db, ctx.storeId, itemIds)
  for (const line of lines) {
    if (!(STOCK_REQUIRING_SOURCES as readonly string[]).includes(line.source)) continue
    const productId = line.product_id ?? (line.stock_item_id ? itemIndex.get(line.stock_item_id)?.product_id : undefined)
    if (productId === null || productId === undefined) {
      return fail(
        ctx.requestId,
        'VALIDATION_ERROR',
        `第 ${line.position + 1} 行「${line.name_snapshot}」解析不出商品，不能交付`,
        400,
      )
    }
  }
  const snapshot: DeliveryLineSnapshot[] = lines.map((line) => {
    const cost = line.stock_item_id ? costs.get(line.stock_item_id) : undefined
    return {
      position: line.position,
      nameSnapshot: line.name_snapshot,
      source: line.source,
      qty: line.qty,
      stockItemId: line.stock_item_id,
      costCents: cost?.costCents ?? null,
      costKnown: cost?.costKnown ?? false,
    }
  })
  const productIdFor = (line: SaleLineRow): number =>
    (line.product_id ?? (line.stock_item_id ? itemIndex.get(line.stock_item_id)?.product_id : undefined)) as number

  const now = new Date().toISOString()
  const deliveryId = `${ctx.requestId}::delivery`
  const nextVersion = order.version + 1

  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements: D1PreparedStatement[] = [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ?)', context.storeId, order.id),
      guardStatement(
        db,
        'VERSION_CONFLICT',
        'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND version = ?)',
        context.storeId,
        order.id,
        order.version,
      ),
      // 闸门 8 的一半：状态不能再是已交付。另一半在 UNIQUE(store_id, sale_order_id)。
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND fulfillment_state = 'delivered')`,
        context.storeId,
        order.id,
      ),
      // 闸门 7 的服务端复算：余额以数据库为准，不信任预读。
      //   有欠款 → 必须挂着有效欠款批准；已结清 → 不得再挂欠款批准。
      ...(balance > 0
        ? [
            guardStatement(
              db,
              'BALANCE_EXCEEDED',
              `EXISTS (SELECT 1 FROM sale_orders
                       WHERE store_id = ? AND id = ? AND balance_cents > 0
                         AND NOT EXISTS (SELECT 1 FROM sale_credit_approvals
                                         WHERE store_id = ? AND id = ? AND sale_order_id = ?))`,
              context.storeId,
              order.id,
              context.storeId,
              creditApprovalId as string,
              order.id,
            ),
          ]
        : [
            guardStatement(
              db,
              'BALANCE_EXCEEDED',
              'EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND balance_cents > 0)',
              context.storeId,
              order.id,
            ),
          ]),
      // 闸门 2/3 的服务端复算：占用必须在（预读之后到写入之前可能被人释放）。
      ...lines
        .filter((line) => line.stock_item_id)
        .map((line) =>
          guardStatement(
            db,
            'STOCK_CONFLICT',
            `NOT EXISTS (SELECT 1 FROM stock_reservations
                         WHERE store_id = ? AND order_ref = ? AND stock_item_id = ? AND status = 'active')`,
            context.storeId,
            order.id,
            line.stock_item_id as string,
          ),
        ),
      db
        .prepare(
          `INSERT INTO sale_deliveries
             (id, store_id, sale_order_id, configuration_version, checklist_version,
              delivery_note, received_by_note, financial_disposition, credit_approval_id,
              cost_snapshot_json, delivered_at, delivered_by, version, request_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .bind(
          deliveryId,
          context.storeId,
          order.id,
          input.configurationVersion,
          checklistVersion,
          input.deliveryNote.trim(),
          (input.receivedByNote ?? '').trim(),
          balance > 0 ? 'credit_approved' : 'settled_in_full',
          creditApprovalId,
          JSON.stringify({ configurationVersion: input.configurationVersion, lines: snapshot }),
          now,
          context.actorUserId,
          context.requestId,
        ),
    ]

    // 逐件行：占用 → 已售（实物与流水同时改，扣库一次）。
    for (const line of lines) {
      if (!line.stock_item_id) continue
      const cost = costs.get(line.stock_item_id)
      statements.push(
        db
          .prepare(
            `UPDATE stock_items SET availability = 'sold', version = version + 1, updated_at = ?
             WHERE store_id = ? AND id = ? AND availability = 'reserved'`,
          )
          .bind(now, context.storeId, line.stock_item_id),
        guardStatement(
          db,
          'STOCK_CONFLICT',
          `NOT EXISTS (SELECT 1 FROM stock_items WHERE store_id = ? AND id = ? AND availability = 'sold')`,
          context.storeId,
          line.stock_item_id,
        ),
        db
          .prepare(
            `INSERT INTO inventory_movements
               (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
                source, occurred_at, actor_user_id, request_id)
             VALUES (?, ?, ?, ?, 1, 'reserved', 'sold', ?, 'delivery', ?, ?, ?)`,
          )
          .bind(
            `${context.requestId}::d-mv-${line.position}`,
            context.storeId,
            productIdFor(line),
            line.stock_item_id,
            cost?.costCents ?? null,
            now,
            context.actorUserId,
            context.requestId,
          ),
        db
          .prepare(
            `UPDATE stock_reservations SET status = 'consumed', closed_at = ?, version = version + 1
             WHERE store_id = ? AND order_ref = ? AND stock_item_id = ? AND status = 'active'`,
          )
          .bind(now, context.storeId, order.id, line.stock_item_id),
      )
    }

    // 数量件行：按数量出库。同一行的占用记录一并结清。
    for (const line of lines) {
      if (line.stock_item_id) continue
      if (!(STOCK_REQUIRING_SOURCES as readonly string[]).includes(line.source)) continue
      statements.push(
        db
          .prepare(
            `INSERT INTO inventory_movements
               (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
                source, occurred_at, actor_user_id, request_id)
             VALUES (?, ?, ?, NULL, ?, 'reserved', 'sold', NULL, 'delivery', ?, ?, ?)`,
          )
          .bind(
            `${context.requestId}::d-qmv-${line.position}`,
            context.storeId,
            productIdFor(line),
            line.qty,
            now,
            context.actorUserId,
            context.requestId,
          ),
        db
          .prepare(
            `UPDATE stock_reservations SET status = 'consumed', closed_at = ?, version = version + 1
             WHERE store_id = ? AND order_ref = ? AND line_ref = ? AND status = 'active'
               AND quantity_bucket_ref IS NOT NULL`,
          )
          .bind(now, context.storeId, order.id, line.id),
      )
    }

    statements.push(
      db
        .prepare(
          `UPDATE sale_orders
           SET fulfillment_state = 'delivered', version = version + 1, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ? AND fulfillment_state = 'ready_delivery'`,
        )
        .bind(context.actorUserId, now, context.storeId, order.id, order.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'sale_orders', 'id', order.id, nextVersion),
      bumpVersionStatement(db, context, 'SaleOrder', order.id, nextVersion),
      // 交付记录必须真的落库：INSERT 影响行数不可查，用守卫确认（T04 的核心教训）。
      guardStatement(
        db,
        'VALIDATION_ERROR',
        'NOT EXISTS (SELECT 1 FROM sale_deliveries WHERE store_id = ? AND sale_order_id = ?)',
        context.storeId,
        order.id,
      ),
    )

    return {
      statements,
      outcome: {
        entityType: 'SaleOrder',
        entityId: order.id,
        version: nextVersion,
        summary: `已交付 ${order.order_no}，扣库 ${snapshot.filter((row) => row.stockItemId || row.source === 'new').length} 行`,
        effects: {
          deliveryId,
          configurationVersion: input.configurationVersion,
          checklistVersion,
          costSnapshot: snapshot,
        },
      },
    }
  })
}

// ─────────────────────────────── 装配看板（读模型） ───────────────────────────────

export interface FulfillmentChecklistRow {
  id: string
  checklistVersion: number
  templateVersion: string
  configurationVersion: number
  result: string
  itemCount: number
  failCount: number
  performedAt: string
  performedByName: string
}

export interface FulfillmentBoard {
  order: {
    id: string
    orderNo: string
    kind: string
    tradeState: string
    fulfillmentState: string
    configurationVersion: number
    totalCents: number
    balanceCents: number
    balanceDirection: string
    isFullyPaid: boolean
    requiredDepositCents: number
    version: number
    customerName: string
  }
  gaps: CoverageGap[]
  missingSnItems: string[]
  checklists: FulfillmentChecklistRow[]
  latestChecklist: {
    id: string
    checklistVersion: number
    result: string
    configurationVersion: number
    items: StoredCheckItem[]
  } | null
  delivery: {
    id: string
    configurationVersion: number
    checklistVersion: number | null
    deliveryNote: string
    receivedByNote: string
    financialDisposition: string
    deliveredAt: string
  } | null
}

/**
 * 装配看板：装机检测与交付页需要的全部事实，一次读齐。
 * 与 querySaleOrderDetail 同一原则 —— 界面口径由服务端给，前端不算账。
 */
export async function queryFulfillmentBoard(
  db: OperationsDb,
  storeId: number,
  orderId: string,
): Promise<FulfillmentBoard | null> {
  const order = await readOrder(db, storeId, orderId)
  if (!order) return null
  const lines = await readSaleLines(db, storeId, orderId)

  // 兼容旧响应字段：内部编号由数据库约束保证，厂家 SN 不作为交付门槛。
  const missingSnItems: string[] = []

  const checklistRows = await db
    .prepare(
      `SELECT c.id, c.checklist_version, c.template_version, c.configuration_version,
              c.items_json, c.result, c.performed_at, u.email AS performed_by_email
       FROM sale_checklists c LEFT JOIN users u ON u.id = c.performed_by
       WHERE c.store_id = ? AND c.sale_order_id = ?
       ORDER BY c.checklist_version DESC`,
    )
    .bind(storeId, orderId)
    .all<{
      id: string
      checklist_version: number
      template_version: string
      configuration_version: number
      items_json: string
      result: string
      performed_at: string
      performed_by_email: string | null
    }>()

  const checklists: FulfillmentChecklistRow[] = []
  let latestChecklist: FulfillmentBoard['latestChecklist'] = null
  for (const row of checklistRows.results ?? []) {
    let items: StoredCheckItem[] = []
    try {
      const parsed = JSON.parse(row.items_json) as StoredCheckItem[]
      if (Array.isArray(parsed)) items = parsed
    } catch {
      items = []
    }
    const entry: FulfillmentChecklistRow = {
      id: row.id,
      checklistVersion: row.checklist_version,
      templateVersion: row.template_version,
      configurationVersion: row.configuration_version,
      result: row.result,
      itemCount: items.length,
      failCount: items.filter((item) => item.state === 'fail').length,
      performedAt: row.performed_at,
      performedByName: row.performed_by_email ?? '',
    }
    checklists.push(entry)
    if (!latestChecklist) {
      latestChecklist = {
        id: row.id,
        checklistVersion: row.checklist_version,
        result: row.result,
        configurationVersion: row.configuration_version,
        items,
      }
    }
  }

  const deliveryRow = (await db
    .prepare(
      `SELECT id, configuration_version, checklist_version, delivery_note, received_by_note,
              financial_disposition, delivered_at
       FROM sale_deliveries WHERE store_id = ? AND sale_order_id = ?`,
    )
    .bind(storeId, orderId)
    .first<{
      id: string
      configuration_version: number
      checklist_version: number | null
      delivery_note: string
      received_by_note: string
      financial_disposition: string
      delivered_at: string
    }>()) ?? null

  let customerName = ''
  try {
    const parsed = JSON.parse(order.customer_snapshot) as Record<string, unknown>
    customerName = typeof parsed.name === 'string' ? parsed.name : ''
  } catch {
    customerName = ''
  }

  return {
    order: {
      id: order.id,
      orderNo: order.order_no,
      kind: order.kind,
      tradeState: order.trade_state,
      fulfillmentState: order.fulfillment_state,
      configurationVersion: order.configuration_version,
      totalCents: order.total_cents,
      balanceCents: order.balance_cents,
      balanceDirection: order.balance_direction,
      isFullyPaid: order.total_cents > 0 && order.balance_cents <= 0,
      requiredDepositCents: requiredDepositCents(order.total_cents, order.terms_snapshot),
      version: order.version,
      customerName,
    },
    // 已交付的单不再显示缺口：占用已随交付结清，按「行数量 − 已锁数量」算会把
    // 已经交出去的货又算成「缺货」，界面会误导人去补货。
    gaps: order.fulfillment_state === 'delivered' ? [] : await readCoverageGaps(db, storeId, order, lines),
    missingSnItems,
    checklists,
    latestChecklist,
    delivery: deliveryRow
      ? {
          id: deliveryRow.id,
          configurationVersion: deliveryRow.configuration_version,
          checklistVersion: deliveryRow.checklist_version,
          deliveryNote: deliveryRow.delivery_note,
          receivedByNote: deliveryRow.received_by_note,
          financialDisposition: deliveryRow.financial_disposition,
          deliveredAt: deliveryRow.delivered_at,
        }
      : null,
  }
}
