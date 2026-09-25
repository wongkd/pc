/**
 * E09 · 账本领域：受控反冲账务分录（B34）+ 基础应收应付账本（读模型）。
 *
 * 契约依据（contracts/v1）：
 *   actions.json  B34  反冲账务分录 /finance/entries/:id/reverse（finance/reverse，owner_only）
 *   readActions   R12  GET /finance/overview、/finance/entries（finance/view）
 *   objects.json  CashEntry / SaleOrder / Purchase
 *   money-rules.json reversalPolicy（原笔保留 + 新增等额反向记录）
 *
 * ── 反冲与退款的边界（B34 vs B18）──
 *   B18 是「真实退款」：钱真的退回给客户，权限 sales/refund，语义「退货/取消后的现金结算」。
 *   B34 是「纠正误录」：录错了一笔收款/退款，用反向分录冲掉，权限 finance/reverse，
 *     界面分别标记（enums / money-rules reversalPolicy.distinction）。两者权限码不同，不互相替代。
 *
 * ── cash_net 的维护 ──
 *   sale_orders.cash_net_cents 是「净收现金」：B08 收款 +、B18 退款 −、B34 按被冲笔方向反向调整。
 *   反冲收款（in）→ cash_net 减；反冲退款（out）→ cash_net 加。列始终等于净收，不重算自流水。
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
import { balanceDirectionFor, CASH_METHODS, readOrder, type SaleOrderRow } from './sale'

// ─────────────────────────────── 入参 ───────────────────────────────

export interface ReverseEntryInput {
  reason: string
  correctionRef?: string | null
}

/** B33 采购付款输入。付款入口仍统一走 finance/payments。 */
export interface PurchasePaymentInput {
  amountCents: number
  method: string
  occurredAt?: string | null
  remark?: string | null
}

// ─────────────────────────────── 读辅助 ───────────────────────────────

interface CashEntryRow {
  id: string
  direction: string
  amount_cents: number
  method: string
  purpose: string
  allocation_type: string
  allocation_id: string | null
  sale_order_id: string | null
  counterparty_kind: string
  counterparty_ref: string | null
  reversal_of: string | null
}

async function readCashEntry(db: OperationsDb, storeId: number, entryId: string): Promise<CashEntryRow | null> {
  const row = await db
    .prepare(
      `SELECT id, direction, amount_cents, method, purpose, allocation_type, allocation_id,
              sale_order_id, counterparty_kind, counterparty_ref, reversal_of
       FROM cash_entries WHERE store_id = ? AND id = ?`,
    )
    .bind(storeId, entryId)
    .first<CashEntryRow>()
  return row ?? null
}

// ─────────────────────────────── B34 反冲账务分录 ───────────────────────────────

export function planReverseEntry(
  db: OperationsDb,
  ctx: OperationContext,
  entry: CashEntryRow,
  order: SaleOrderRow | null,
  reverseId: string,
  now: string,
): OperationPlan {
  const reverseDirection = entry.direction === 'in' ? 'out' : 'in'
  const nextOrderVersion = order ? order.version + 1 : null
  const nextCashNet = order
    ? entry.direction === 'in'
      ? order.cash_net_cents - entry.amount_cents
      : order.cash_net_cents + entry.amount_cents
    : null
  const nextBalance = order && nextCashNet !== null
    ? order.total_cents - order.return_credit_cents - nextCashNet - order.offset_net_cents
    : null
  const nextDirection = nextBalance !== null ? balanceDirectionFor(nextBalance) : null

  const statements: D1PreparedStatement[] = [
    guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM cash_entries WHERE store_id = ? AND id = ?)', ctx.storeId, entry.id),
    // 反冲笔本身不能再反冲；原笔不能被重复反冲（reversal_of 唯一指向）。
    guardStatement(
      db,
      'VALIDATION_ERROR',
      `EXISTS (SELECT 1 FROM cash_entries WHERE store_id = ? AND id = ? AND reversal_of IS NOT NULL)`,
      ctx.storeId,
      entry.id,
    ),
    guardStatement(
      db,
      'VALIDATION_ERROR',
      'EXISTS (SELECT 1 FROM cash_entries WHERE store_id = ? AND reversal_of = ?)',
      ctx.storeId,
      entry.id,
    ),
    db
      .prepare(
        `INSERT INTO cash_entries
           (id, store_id, direction, amount_cents, method, verification_state, verified_at,
            counterparty_kind, counterparty_ref, purpose, allocation_type, allocation_id,
            sale_order_id, occurred_at, remark, reversal_of, version, request_id, created_by)
         VALUES (?, ?, ?, ?, ?, 'unverified', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        reverseId,
        ctx.storeId,
        reverseDirection,
        entry.amount_cents,
        entry.method,
        entry.counterparty_kind,
        entry.counterparty_ref,
        entry.purpose,
        entry.allocation_type,
        entry.allocation_id,
        entry.sale_order_id,
        now,
        `反冲 ${entry.id}`,
        entry.id,
        ctx.requestId,
        ctx.actorUserId,
      ),
    guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM cash_entries WHERE store_id = ? AND id = ?)', ctx.storeId, reverseId),
  ]

  if (order && nextCashNet !== null && nextBalance !== null && nextDirection !== null) {
    statements.push(
      // 反冲收款时净收现金不能变负：cash_net 是净收，冲掉收款不该把「已退」冲成「倒欠现金」。
      guardStatement(
        db,
        'BALANCE_EXCEEDED',
        'EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND cash_net_cents < ?)',
        ctx.storeId,
        order.id,
        entry.direction === 'in' ? entry.amount_cents : 0,
      ),
      db
        .prepare(
          `UPDATE sale_orders
           SET cash_net_cents = ?, balance_cents = ?, balance_direction = ?,
               version = ?, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ?`,
        )
        .bind(nextCashNet, nextBalance, nextDirection, nextOrderVersion as number, ctx.actorUserId, now, ctx.storeId, order.id, order.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'sale_orders', 'id', order.id, nextOrderVersion as number),
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND balance_cents = ?)`,
        ctx.storeId,
        order.id,
        nextBalance,
      ),
      bumpVersionStatement(db, ctx, 'SaleOrder', order.id, nextOrderVersion as number),
    )
  }

  return {
    statements,
    outcome: {
      entityType: 'CashEntry',
      entityId: reverseId,
      version: 1,
      summary: `反冲 ${entry.direction === 'in' ? '收款' : '付款'} ${(entry.amount_cents / 100).toFixed(2)} 元（原笔 ${entry.id}）`,
      effects: {
        reverseEntryId: reverseId,
        reversedEntryId: entry.id,
        direction: reverseDirection,
        amountCents: entry.amount_cents,
        ...(order && nextBalance !== null ? { balanceCents: nextBalance } : {}),
      },
    },
    constraintCodes: {
      'cash_entries.reversal_of': 'VALIDATION_ERROR',
    },
  }
}

/** B34 入口。 */
export async function reverseEntry(
  db: OperationsDb,
  ctx: OperationContext,
  entryId: string,
  input: ReverseEntryInput,
): Promise<RunResult> {
  const action = 'B34'
  const reason = (input.reason ?? '').trim()
  if (!reason) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '反冲必须写明原因', retryable: false, httpStatus: 400 }
  }

  const payloadHash = await hashPayload({ entryId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const entry = await readCashEntry(db, ctx.storeId, entryId)
  if (!entry) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '资金分录不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  if (entry.reversal_of) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '这条分录本身就是反冲笔，不能再反冲', retryable: false, httpStatus: 400 }
  }

  // 挂销售单的分录反冲要连带重算订单余额；否则只写反向分录。
  let order: Awaited<ReturnType<typeof readOrder>> = null
  if (entry.purpose === 'sale_order' && entry.sale_order_id) {
    order = await readOrder(db, ctx.storeId, entry.sale_order_id)
    if (!order) {
      return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '这笔分录关联的销售单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
    }
  }

  const reverseId = `${ctx.requestId}::reverse`
  const now = new Date().toISOString()
  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const plan = planReverseEntry(db, context, entry, order, reverseId, now)
    if (reason) {
      plan.statements.push(
        db
          .prepare(
            `INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details)
             VALUES (?, ?, 'B34.reverse', 'CashEntry', ?, ?)`,
          )
          .bind(context.storeId, context.actorUserId, entryId, JSON.stringify({ reverseId, reason, correctionRef: (input.correctionRef ?? '').trim() || null, at: now })),
      )
    }
    return plan
  })
}

// ─────────────────────────────── B33 采购付款 ───────────────────────────────

interface PurchasePaymentTarget {
  id: string
  purchase_no: string
  supplier_ref: string | null
  supplier_name: string
  version: number
  payable_cents: number
  paid_cents: number
  unknown_cost_lines: number
}

async function readPurchasePaymentTarget(
  db: OperationsDb,
  storeId: number,
  purchaseId: string,
): Promise<PurchasePaymentTarget | null> {
  const row = await db
    .prepare(
      `SELECT p.id, p.purchase_no, p.supplier_ref, p.supplier_name, p.version,
              COALESCE(SUM(CASE
                WHEN l.cost_known = 1 AND l.unit_cost_cents IS NOT NULL
                THEN (l.qty_ordered - COALESCE((SELECT SUM(pc.qty_cancelled)
                                               FROM purchase_cancellations pc
                                               WHERE pc.store_id = l.store_id AND pc.purchase_line_id = l.id), 0)) * l.unit_cost_cents
                ELSE 0 END), 0) AS payable_cents,
              COALESCE((SELECT SUM(CASE WHEN e.direction = 'out' THEN e.amount_cents ELSE -e.amount_cents END)
                        FROM cash_entries e
                        WHERE e.store_id = p.store_id AND e.purpose = 'purchase'
                          AND e.allocation_type = 'purchase' AND e.allocation_id = p.id), 0) AS paid_cents,
              COALESCE(SUM(CASE
                WHEN (l.qty_ordered - COALESCE((SELECT SUM(pc.qty_cancelled)
                                                FROM purchase_cancellations pc
                                                WHERE pc.store_id = l.store_id AND pc.purchase_line_id = l.id), 0)) > 0
                     AND (l.cost_known <> 1 OR l.unit_cost_cents IS NULL) THEN 1 ELSE 0 END), 0) AS unknown_cost_lines
       FROM purchase_orders p
       LEFT JOIN purchase_lines l ON l.store_id = p.store_id AND l.purchase_id = p.id
       WHERE p.store_id = ? AND p.id = ?
       GROUP BY p.id, p.purchase_no, p.supplier_ref, p.supplier_name, p.version`,
    )
    .bind(storeId, purchaseId)
    .first<PurchasePaymentTarget>()
  return row ?? null
}

export function planPayPurchase(
  db: OperationsDb,
  ctx: OperationContext,
  purchase: PurchasePaymentTarget,
  input: PurchasePaymentInput,
  entryId: string,
  occurredAt: string,
): OperationPlan {
  const nextVersion = purchase.version + 1
  const nextPaid = purchase.paid_cents + input.amountCents
  const nextRemaining = Math.max(purchase.payable_cents - nextPaid, 0)

  return {
    statements: [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM purchase_orders WHERE store_id = ? AND id = ?)', ctx.storeId, purchase.id),
      guardStatement(
        db,
        'VERSION_CONFLICT',
        'NOT EXISTS (SELECT 1 FROM purchase_orders WHERE store_id = ? AND id = ? AND version = ?)',
        ctx.storeId,
        purchase.id,
        purchase.version,
      ),
      // 成本未知时无法确认应付金额，禁止把已知部分当成整张采购单的最终应付。
      // ⚠️ guardStatement 是「条件为真即中止」，所以这里必须是 EXISTS（存在成本未知的行才拦），
      //    写成 NOT EXISTS 会反过来把「成本齐全」的正常单子全拦死（F3 实测复现）。
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `EXISTS (SELECT 1 FROM purchase_lines
                WHERE store_id = ? AND purchase_id = ?
                  AND (cost_known <> 1 OR unit_cost_cents IS NULL))`,
        ctx.storeId,
        purchase.id,
      ),
      // 付款额度按服务端当前采购应付减去既有采购付款净额计算，不能超付。
      guardStatement(
        db,
        'BALANCE_EXCEEDED',
        `EXISTS (
           SELECT 1 FROM purchase_orders p
           WHERE p.store_id = ? AND p.id = ?
             AND ? > (
               COALESCE((SELECT SUM((l.qty_ordered - COALESCE((SELECT SUM(pc.qty_cancelled)
                                                               FROM purchase_cancellations pc
                                                               WHERE pc.store_id = l.store_id AND pc.purchase_line_id = l.id), 0)) * l.unit_cost_cents)
                         FROM purchase_lines l
                         WHERE l.store_id = p.store_id AND l.purchase_id = p.id
                           AND l.cost_known = 1 AND l.unit_cost_cents IS NOT NULL), 0)
               - COALESCE((SELECT SUM(CASE WHEN e.direction = 'out' THEN e.amount_cents ELSE -e.amount_cents END)
                           FROM cash_entries e
                           WHERE e.store_id = p.store_id AND e.purpose = 'purchase'
                             AND e.allocation_type = 'purchase' AND e.allocation_id = p.id), 0)
             )
         )`,
        ctx.storeId,
        purchase.id,
        input.amountCents,
      ),
      db
        .prepare(
          `INSERT INTO cash_entries
             (id, store_id, direction, amount_cents, method, verification_state, verified_at,
              counterparty_kind, counterparty_ref, purpose, allocation_type, allocation_id,
              sale_order_id, occurred_at, remark, reversal_of, version, request_id, created_by)
           VALUES (?, ?, 'out', ?, ?, 'unverified', NULL, 'supplier', ?, 'purchase', 'purchase', ?, NULL, ?, ?, NULL, 1, ?, ?)`
        )
        .bind(
          entryId,
          ctx.storeId,
          input.amountCents,
          input.method,
          purchase.supplier_ref ?? purchase.supplier_name,
          purchase.id,
          occurredAt,
          (input.remark ?? '').trim(),
          ctx.requestId,
          ctx.actorUserId,
        ),
      guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM cash_entries WHERE store_id = ? AND id = ?)', ctx.storeId, entryId),
      db
        .prepare(
          `UPDATE purchase_orders
           SET version = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ?`,
        )
        .bind(nextVersion, occurredAt, ctx.storeId, purchase.id, purchase.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'purchase_orders', 'id', purchase.id, nextVersion),
      bumpVersionStatement(db, ctx, 'Purchase', purchase.id, nextVersion),
    ],
    outcome: {
      entityType: 'Purchase',
      entityId: purchase.id,
      version: nextVersion,
      summary: `采购付款 ${(input.amountCents / 100).toFixed(2)} 元（${input.method}），剩余应付 ${(nextRemaining / 100).toFixed(2)} 元`,
      effects: {
        purchaseNo: purchase.purchase_no,
        cashEntryId: entryId,
        payableCents: purchase.payable_cents,
        paidCents: nextPaid,
        remainingPayableCents: nextRemaining,
      },
    },
    constraintCodes: {
      'cash_entries.reversal_of': 'VALIDATION_ERROR',
    },
  }
}

/** B33 入口（采购付款）。付款写入 cash_entries，采购已付从流水净额重算。 */
export async function payPurchase(
  db: OperationsDb,
  ctx: OperationContext,
  purchaseId: string,
  input: PurchasePaymentInput,
): Promise<RunResult> {
  const action = 'B33'
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '付款金额必须是正整数分', retryable: false, httpStatus: 400 }
  }
  if (!(CASH_METHODS as readonly string[]).includes(input.method)) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '付款方式只能是 cash / wechat / alipay / bank / other', retryable: false, httpStatus: 400 }
  }

  const payloadHash = await hashPayload({ purchaseId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const purchase = await readPurchasePaymentTarget(db, ctx.storeId, purchaseId)
  if (!purchase) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '采购单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  if (purchase.unknown_cost_lines > 0) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '采购单还有成本未知的行，补齐成本后才能付款', retryable: false, httpStatus: 400 }
  }

  const entryId = `${ctx.requestId}::purchase-pay`
  const occurredAt = input.occurredAt && !Number.isNaN(new Date(input.occurredAt).getTime())
    ? new Date(input.occurredAt).toISOString()
    : new Date().toISOString()
  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) => planPayPurchase(db, context, purchase, input, entryId, occurredAt))
}

// ─────────────────────────────── 账本读模型 ───────────────────────────────

export interface FinanceOverview {
  cash: {
    inTotalCents: number
    outTotalCents: number
    netCents: number
  }
  receivable: {
    orderCount: number
    totalCents: number
    serviceCount: number
    serviceTotalCents: number
  }
  payable: {
    purchaseCount: number
    totalCents: number
  }
}

/** 基础账本汇总（R12 /finance/overview，权限 finance/view）。 */
export async function queryFinanceOverview(db: OperationsDb, storeId: number): Promise<FinanceOverview> {
  const cash = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_cents ELSE 0 END), 0) AS in_total,
              COALESCE(SUM(CASE WHEN direction = 'out' THEN amount_cents ELSE 0 END), 0) AS out_total
       FROM cash_entries WHERE store_id = ?`,
    )
    .bind(storeId)
    .first<{ in_total: number; out_total: number }>()

  const receivable = await db
    .prepare(
      `SELECT COUNT(*) AS order_count, COALESCE(SUM(balance_cents), 0) AS total
       FROM sale_orders WHERE store_id = ? AND balance_cents > 0`,
    )
    .bind(storeId)
    .first<{ order_count: number; total: number }>()

  // 维修待收（E10 并入账本）：已确认收费且未结清的维修工单。
  const serviceReceivable = await db
    .prepare(
      `SELECT COUNT(*) AS service_count, COALESCE(SUM(balance_cents), 0) AS service_total
       FROM service_orders
       WHERE store_id = ? AND confirmed_charge_cents IS NOT NULL AND balance_cents > 0`,
    )
    .bind(storeId)
    .first<{ service_count: number; service_total: number }>()

  // 应付：按采购单汇总成本，并扣除采购付款流水净额；成本未知的行不进入可付款额度。
  const payable = await db
    .prepare(
      `SELECT COUNT(*) AS purchase_count,
              COALESCE(SUM(total_cents - paid_cents), 0) AS total
       FROM (
         SELECT p.id,
                COALESCE(SUM(CASE
                  WHEN l.cost_known = 1 AND l.unit_cost_cents IS NOT NULL
                  THEN (l.qty_ordered - COALESCE((SELECT SUM(pc.qty_cancelled)
                                                 FROM purchase_cancellations pc
                                                 WHERE pc.store_id = l.store_id AND pc.purchase_line_id = l.id), 0)) * l.unit_cost_cents
                  ELSE 0 END), 0) AS total_cents,
                COALESCE((SELECT SUM(CASE WHEN e.direction = 'out' THEN e.amount_cents ELSE -e.amount_cents END)
                          FROM cash_entries e
                          WHERE e.store_id = p.store_id AND e.purpose = 'purchase'
                            AND e.allocation_type = 'purchase' AND e.allocation_id = p.id), 0) AS paid_cents
         FROM purchase_orders p
         JOIN purchase_lines l ON l.store_id = p.store_id AND l.purchase_id = p.id
         WHERE p.store_id = ?
         GROUP BY p.id
       ) purchase_totals
       WHERE total_cents - paid_cents > 0`,
    )
    .bind(storeId)
    .first<{ purchase_count: number; total: number }>()

  const inTotal = Number(cash?.in_total ?? 0)
  const outTotal = Number(cash?.out_total ?? 0)

  return {
    cash: { inTotalCents: inTotal, outTotalCents: outTotal, netCents: inTotal - outTotal },
    receivable: {
      orderCount: Number(receivable?.order_count ?? 0),
      totalCents: Number(receivable?.total ?? 0),
      serviceCount: Number(serviceReceivable?.service_count ?? 0),
      serviceTotalCents: Number(serviceReceivable?.service_total ?? 0),
    },
    payable: {
      purchaseCount: Number(payable?.purchase_count ?? 0),
      totalCents: Number(payable?.total ?? 0),
    },
  }
}

export interface FinanceEntryRow {
  id: string
  direction: string
  amountCents: number
  method: string
  purpose: string
  counterpartyKind: string
  saleOrderId: string | null
  /**
   * 契约 CashEntry.allocation（订单 / 采购 / 回收 / 维修分摊）。
   * 只给 sale_order_id 会让「这笔钱挂在哪张采购单 / 回收单上」在账本里断链——采购与回收付款的
   * sale_order_id 都是 NULL，光看流水看不出对应单据，应付/回收对账就无从下手。
   */
  allocationType: string
  allocationId: string | null
  occurredAt: string
  verificationState: string
  remark: string
  reversalOf: string | null
}

export interface FinanceEntriesResult {
  entries: FinanceEntryRow[]
  totals: { inTotalCents: number; outTotalCents: number }
}

export interface FinanceEntriesFilter {
  direction?: string | null
  limit?: number | null
}

/** 资金流水列表（R12 /finance/entries，权限 finance/view）。 */
export async function queryFinanceEntries(
  db: OperationsDb,
  storeId: number,
  filter: FinanceEntriesFilter = {},
): Promise<FinanceEntriesResult> {
  const limit = Number.isInteger(filter.limit) && (filter.limit as number) > 0 ? Math.min(filter.limit as number, 200) : 50
  const conditions: string[] = ['store_id = ?']
  const params: (string | number)[] = [storeId]
  if (filter.direction === 'in' || filter.direction === 'out') {
    conditions.push('direction = ?')
    params.push(filter.direction)
  }

  const rows = await db
    .prepare(
      `SELECT id, direction, amount_cents, method, purpose, counterparty_kind,
              sale_order_id, allocation_type, allocation_id, occurred_at, verification_state, remark, reversal_of
       FROM cash_entries
       WHERE ${conditions.join(' AND ')}
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(...params, limit)
    .all<{
      id: string
      direction: string
      amount_cents: number
      method: string
      purpose: string
      counterparty_kind: string
      sale_order_id: string | null
      allocation_type: string
      allocation_id: string | null
      occurred_at: string
      verification_state: string
      remark: string
      reversal_of: string | null
    }>()

  const totals = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_cents ELSE 0 END), 0) AS in_total,
              COALESCE(SUM(CASE WHEN direction = 'out' THEN amount_cents ELSE 0 END), 0) AS out_total
       FROM cash_entries WHERE store_id = ?`,
    )
    .bind(storeId)
    .first<{ in_total: number; out_total: number }>()

  return {
    entries: (rows.results ?? []).map((row) => ({
      id: row.id,
      direction: row.direction,
      amountCents: row.amount_cents,
      method: row.method,
      purpose: row.purpose,
      counterpartyKind: row.counterparty_kind,
      saleOrderId: row.sale_order_id,
      allocationType: row.allocation_type,
      allocationId: row.allocation_id,
      occurredAt: row.occurred_at,
      verificationState: row.verification_state,
      remark: row.remark,
      reversalOf: row.reversal_of,
    })),
    totals: { inTotalCents: Number(totals?.in_total ?? 0), outTotalCents: Number(totals?.out_total ?? 0) },
  }
}
