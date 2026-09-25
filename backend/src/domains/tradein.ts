/**
 * E12 · 抵用额度（置换折抵）领域：建立置换关联（B31 create）、应用折抵（B31 offset）、
 * 撤销折抵（B32 reverse）与置换单读（R11）。
 *
 * 契约依据（contracts/v1）：
 *   actions.json  B31 建立置换关联与应用折抵
 *                     POST /trade-ins               权限 tradein/create（default，旧 quote/edit 等价）
 *                     POST /trade-ins/:id/apply-offset 权限 tradein/offset（owner_only）
 *                 B32 撤销折抵 POST /trade-ins/:id/reverse-offset 权限 tradein/reverse（owner_only）
 *                 R11 读 GET /trade-ins/:id          权限 tradein/view（default，旧 quote/view 等价）
 *   objects.json  Offset（tradeInId / saleOrderId / recoveryId / amountCents / state / reversalOf）
 *   enums.json    OffsetState（applied / reversed；撤销折抵不自动归还实物）
 *   money-rules.json
 *     offsetNetCents = appliedOffsetsCents − reversedOffsetsCents
 *     salesBalanceCents = salesNetAccruedCents − cashNetReceivedCents − offsetNetCents
 *     recoveryPayableRemainingCents = finalAcquisitionCents + lawfulAdjustmentCents − validOffsetsCents − cashNetPaidCents
 *     offsetAmountCents = min(max(salesBalance, 0), max(recoveryPayableRemaining, 0))
 *
 * ── 硬边界（务必照做）──
 * 1. 折抵是「非现金事件」：不写 cash_entries，不生成虚构现金收 / 付。
 *    销售侧落在 sale_orders.offset_net_cents（净额，0017 已建列）；回收侧走 offsets 表聚合，
 *    recovery_orders 表本身不更新（0020 注释：本表只承载现金付款路径）。
 * 2. 双方交易主体须相同：sale_orders.customer_id 与 recovery_orders.seller_customer_id
 *    必须同为非空且相等，否则 OWNERSHIP_INVALID（不同主体代付首版不支持）。
 * 3. 部分折抵、累计不得超额：amount ≤ 销售正余额，且 ≤ 回收剩余应付（OFFSET_EXCEEDED）。
 * 4. 撤销折抵不搬动实物：原 offset 保留，新增 state='reversed' 的 offset（reversal_of 指向原笔）。
 * 5. 找零（Q-04）复用 B33 付款，不在本模块实现（见 recovery.ts 的 B33 守卫联动）。
 *
 * 本模块不做鉴权：storeId / actorUserId 由调用方从会话派生。权限码见函数注释。
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
import { balanceDirectionFor, readOrder, type SaleOrderRow } from './sale'

// ─────────────────────────────────────────────────────────────────────────────
// 枚举常量：取值必须与 contracts/v1/enums.json 逐字一致。
// ─────────────────────────────────────────────────────────────────────────────

const OFFSET_STATES = ['applied', 'reversed'] as const
type OffsetState = (typeof OFFSET_STATES)[number]

function nowIso(): string {
  return new Date().toISOString()
}

// ─────────────────────────────────────────────────────────────────────────────
// 入参与读辅助
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeInCreateInput {
  saleOrderId: string
  recoveryId: string
  saleOrderVersion: number
  recoveryVersion: number
}

export interface TradeInApplyInput {
  amountCents: number
  saleOrderVersion: number
  recoveryVersion: number
}

export interface TradeInReverseInput {
  offsetId: string
  reason: string
  saleOrderVersion: number
  recoveryVersion: number
}

interface RecoveryTradeinRow {
  id: string
  order_no: string
  seller_customer_id: number | null
  state: string
  final_acquisition_cents: number | null
  payable_cents: number
  paid_cents: number
  version: number
}

interface TradeInRow {
  id: string
  sale_order_id: string
  recovery_id: string
  state: string
  version: number
  created_at: string
}

interface OffsetRow {
  id: string
  trade_in_id: string
  sale_order_id: string
  recovery_id: string
  amount_cents: number
  state: string
  reversal_of: string | null
  reversed_reason: string | null
  created_at: string
}

async function readRecoveryForTradein(
  db: OperationsDb,
  storeId: number,
  recoveryId: string,
): Promise<RecoveryTradeinRow | null> {
  const row = await db
    .prepare(
      `SELECT id, order_no, seller_customer_id, state, final_acquisition_cents,
              payable_cents, paid_cents, version
       FROM recovery_orders WHERE store_id = ? AND id = ?`,
    )
    .bind(storeId, recoveryId)
    .first<RecoveryTradeinRow>()
  return row ?? null
}

async function readTradeIn(
  db: OperationsDb,
  storeId: number,
  tradeInId: string,
): Promise<TradeInRow | null> {
  const row = await db
    .prepare(
      `SELECT id, sale_order_id, recovery_id, state, version, created_at
       FROM trade_ins WHERE store_id = ? AND id = ?`,
    )
    .bind(storeId, tradeInId)
    .first<TradeInRow>()
  return row ?? null
}

async function readOffsets(
  db: OperationsDb,
  storeId: number,
  tradeInId: string,
): Promise<OffsetRow[]> {
  const result = await db
    .prepare(
      `SELECT id, trade_in_id, sale_order_id, recovery_id, amount_cents, state,
              reversal_of, reversed_reason, created_at
       FROM offsets WHERE store_id = ? AND trade_in_id = ? ORDER BY created_at, id`,
    )
    .bind(storeId, tradeInId)
    .all<OffsetRow>()
  return result.results ?? []
}

async function readRecoveryOffsets(
  db: OperationsDb,
  storeId: number,
  recoveryId: string,
): Promise<OffsetRow[]> {
  const result = await db
    .prepare(
      `SELECT id, trade_in_id, sale_order_id, recovery_id, amount_cents, state,
              reversal_of, reversed_reason, created_at
       FROM offsets WHERE store_id = ? AND recovery_id = ? ORDER BY created_at, id`,
    )
    .bind(storeId, recoveryId)
    .all<OffsetRow>()
  return result.results ?? []
}

/**
 * 回收侧「有效折抵」= SUM(applied) − SUM(reversed)。
 * 与 money-rules.json offsetNetCents 口径一致；销售侧另有 sale_orders.offset_net_cents 净额列。
 */
function validOffsetCents(offsets: OffsetRow[]): number {
  let net = 0
  for (const offset of offsets) {
    net += offset.state === 'applied' ? offset.amount_cents : -offset.amount_cents
  }
  return net
}

// ─────────────────────────────────────────────────────────────────────────────
// B31 · 建立置换关联（POST /trade-ins）
// 权限：tradein/create（default，旧 quote/edit 等价）
// ─────────────────────────────────────────────────────────────────────────────

function planCreateTradeIn(
  db: OperationsDb,
  ctx: OperationContext,
  tradeInId: string,
  input: TradeInCreateInput,
): OperationPlan {
  const occurredAt = nowIso()
  return {
    statements: [
      // 双方主体一致；销售草稿也允许先建立有效折抵，以便折抵计入首次15%门槛。
      // 实际库存预留仍只在 B05 确认成交时尝试；回收单必须已取得所有权。
      guardStatement(
        db,
        'OWNERSHIP_INVALID',
        `NOT EXISTS (
           SELECT 1 FROM sale_orders s JOIN recovery_orders r ON s.store_id = r.store_id
           WHERE s.store_id = ? AND s.id = ? AND r.id = ?
             AND s.trade_state IN ('draft', 'confirmed')
             AND r.state = 'acquired'
             AND r.final_acquisition_cents IS NOT NULL
             AND s.customer_id IS NOT NULL
             AND r.seller_customer_id IS NOT NULL
             AND s.customer_id = r.seller_customer_id
         )`,
        ctx.storeId,
        input.saleOrderId,
        input.recoveryId,
      ),
      // 双方版本匹配（乐观锁：客户端必须基于最新状态建关联）。
      guardStatement(
        db,
        'VERSION_CONFLICT',
        'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND version = ?)',
        ctx.storeId,
        input.saleOrderId,
        input.saleOrderVersion,
      ),
      guardStatement(
        db,
        'VERSION_CONFLICT',
        'NOT EXISTS (SELECT 1 FROM recovery_orders WHERE store_id = ? AND id = ? AND version = ?)',
        ctx.storeId,
        input.recoveryId,
        input.recoveryVersion,
      ),
      db
        .prepare(
          `INSERT INTO trade_ins
             (id, store_id, sale_order_id, recovery_id, state, version, request_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
        )
        .bind(
          tradeInId,
          ctx.storeId,
          input.saleOrderId,
          input.recoveryId,
          ctx.requestId,
          ctx.actorUserId,
          occurredAt,
          occurredAt,
        ),
      guardStatement(
        db,
        'VALIDATION_ERROR',
        'NOT EXISTS (SELECT 1 FROM trade_ins WHERE store_id = ? AND id = ?)',
        ctx.storeId,
        tradeInId,
      ),
      bumpVersionStatement(db, ctx, 'TradeIn', tradeInId, 1),
    ],
    outcome: {
      entityType: 'TradeIn',
      entityId: tradeInId,
      version: 1,
      summary: '已建立置换关联',
      effects: { tradeInId, saleOrderId: input.saleOrderId, recoveryId: input.recoveryId },
    },
    constraintCodes: {
      'trade_ins.store_id, trade_ins.sale_order_id, trade_ins.recovery_id': 'VALIDATION_ERROR',
    },
  }
}

export async function createTradeIn(
  db: OperationsDb,
  ctx: OperationContext,
  input: TradeInCreateInput,
): Promise<RunResult> {
  const action = 'B31'
  if (!input.saleOrderId || !input.recoveryId) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '缺少销售单或回收单编号', retryable: false, httpStatus: 400 }
  }
  if (!Number.isInteger(input.saleOrderVersion) || !Number.isInteger(input.recoveryVersion)) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '双方版本必须是整数', retryable: false, httpStatus: 400 }
  }

  const payloadHash = await hashPayload({ saleOrderId: input.saleOrderId, recoveryId: input.recoveryId, saleOrderVersion: input.saleOrderVersion, recoveryVersion: input.recoveryVersion })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  // 提前读用于友好提示；权威校验在 SQL 守卫里。
  const sale = await readOrder(db, ctx.storeId, input.saleOrderId)
  if (!sale) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '销售单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  const recovery = await readRecoveryForTradein(db, ctx.storeId, input.recoveryId)
  if (!recovery) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '回收单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  if (sale.customer_id == null || recovery.seller_customer_id == null || sale.customer_id !== recovery.seller_customer_id) {
    return { ok: false, requestId: ctx.requestId, code: 'OWNERSHIP_INVALID', message: '销售单与回收单的客户主体不一致，首版不支持代付', retryable: false, httpStatus: 422 }
  }

  const tradeInId = `${ctx.requestId}::ti`
  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) => planCreateTradeIn(db, context, tradeInId, input))
}

// ─────────────────────────────────────────────────────────────────────────────
// B31 · 应用折抵（POST /trade-ins/:id/apply-offset）
// 权限：tradein/offset（owner_only）
// ─────────────────────────────────────────────────────────────────────────────

function planApplyOffset(
  db: OperationsDb,
  ctx: OperationContext,
  tradeIn: TradeInRow,
  sale: SaleOrderRow,
  recovery: RecoveryTradeinRow,
  input: TradeInApplyInput,
  offsetId: string,
): OperationPlan {
  const nextOffsetNet = sale.offset_net_cents + input.amountCents
  const nextBalance = sale.total_cents - sale.return_credit_cents - sale.cash_net_cents - nextOffsetNet
  const nextDirection = balanceDirectionFor(nextBalance)
  const nextSaleVersion = sale.version + 1
  const occurredAt = nowIso()

  return {
    statements: [
      // 置换关联仍有效。
      guardStatement(
        db,
        'ENTITY_NOT_FOUND',
        "NOT EXISTS (SELECT 1 FROM trade_ins WHERE store_id = ? AND id = ? AND state = 'active')",
        ctx.storeId,
        tradeIn.id,
      ),
      // 双方主体仍须相同（防建关联后被改）。
      guardStatement(
        db,
        'OWNERSHIP_INVALID',
        `NOT EXISTS (
           SELECT 1 FROM sale_orders s JOIN recovery_orders r ON s.store_id = r.store_id
           WHERE s.store_id = ? AND s.id = ? AND r.id = ?
             AND s.customer_id IS NOT NULL AND r.seller_customer_id IS NOT NULL
             AND s.customer_id = r.seller_customer_id
         )`,
        ctx.storeId,
        tradeIn.sale_order_id,
        tradeIn.recovery_id,
      ),
      // 销售侧：未取消/关闭，且折抵不超过销售正余额（OFFSET_EXCEEDED）。
      guardStatement(
        db,
        'OFFSET_EXCEEDED',
        `NOT EXISTS (
           SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ?
             AND trade_state IN ('draft', 'confirmed') AND balance_cents > 0 AND balance_cents >= ?
         )`,
        ctx.storeId,
        tradeIn.sale_order_id,
        input.amountCents,
      ),
      // 回收侧：剩余应付 = payable − 有效折抵，累计不得超额（OFFSET_EXCEEDED）。
      guardStatement(
        db,
        'OFFSET_EXCEEDED',
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
        tradeIn.recovery_id,
        input.amountCents,
      ),
      // 双方版本匹配（乐观锁）。
      guardStatement(
        db,
        'VERSION_CONFLICT',
        'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND version = ?)',
        ctx.storeId,
        tradeIn.sale_order_id,
        input.saleOrderVersion,
      ),
      guardStatement(
        db,
        'VERSION_CONFLICT',
        'NOT EXISTS (SELECT 1 FROM recovery_orders WHERE store_id = ? AND id = ? AND version = ?)',
        ctx.storeId,
        tradeIn.recovery_id,
        input.recoveryVersion,
      ),
      // 折抵凭据（applied）。
      db
        .prepare(
          `INSERT INTO offsets
             (id, store_id, trade_in_id, sale_order_id, recovery_id, amount_cents, state,
              version, request_id, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'applied', 1, ?, ?, ?)`,
        )
        .bind(
          offsetId,
          ctx.storeId,
          tradeIn.id,
          tradeIn.sale_order_id,
          tradeIn.recovery_id,
          input.amountCents,
          ctx.requestId,
          ctx.actorUserId,
          occurredAt,
        ),
      guardStatement(
        db,
        'VALIDATION_ERROR',
        'NOT EXISTS (SELECT 1 FROM offsets WHERE store_id = ? AND id = ?)',
        ctx.storeId,
        offsetId,
      ),
      // 销售侧：offset_net 累加、balance 重算（0017 的 CHECK 恒等式兜底）。
      db
        .prepare(
          `UPDATE sale_orders
           SET offset_net_cents = ?, balance_cents = ?, balance_direction = ?,
               version = ?, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ?`,
        )
        .bind(
          nextOffsetNet,
          nextBalance,
          nextDirection,
          nextSaleVersion,
          ctx.actorUserId,
          occurredAt,
          ctx.storeId,
          tradeIn.sale_order_id,
          sale.version,
        ),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'sale_orders', 'id', tradeIn.sale_order_id, nextSaleVersion),
      guardStatement(
        db,
        'VALIDATION_ERROR',
        'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND offset_net_cents = ?)',
        ctx.storeId,
        tradeIn.sale_order_id,
        nextOffsetNet,
      ),
      bumpVersionStatement(db, ctx, 'SaleOrder', tradeIn.sale_order_id, nextSaleVersion),
    ],
    outcome: {
      entityType: 'Offset',
      entityId: offsetId,
      version: 1,
      summary: `折抵 ${(input.amountCents / 100).toFixed(2)} 元（销售单 ${sale.order_no} ↔ 回收单 ${recovery.order_no}）`,
      effects: {
        offsetId,
        saleOrderId: tradeIn.sale_order_id,
        recoveryId: tradeIn.recovery_id,
        amountCents: input.amountCents,
        saleBalanceCents: nextBalance,
        saleOffsetNetCents: nextOffsetNet,
      },
    },
    constraintCodes: {
      'offsets.store_id, offsets.reversal_of': 'VALIDATION_ERROR',
    },
  }
}

export async function applyOffset(
  db: OperationsDb,
  ctx: OperationContext,
  tradeInId: string,
  input: TradeInApplyInput,
): Promise<RunResult> {
  const action = 'B31'
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '折抵金额必须是正整数分', retryable: false, httpStatus: 400 }
  }
  if (!Number.isInteger(input.saleOrderVersion) || !Number.isInteger(input.recoveryVersion)) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '双方版本必须是整数', retryable: false, httpStatus: 400 }
  }

  const payloadHash = await hashPayload({ tradeInId, amountCents: input.amountCents, saleOrderVersion: input.saleOrderVersion, recoveryVersion: input.recoveryVersion })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const tradeIn = await readTradeIn(db, ctx.storeId, tradeInId)
  if (!tradeIn) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '置换关联不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  const sale = await readOrder(db, ctx.storeId, tradeIn.sale_order_id)
  if (!sale) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '销售单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  const recovery = await readRecoveryForTradein(db, ctx.storeId, tradeIn.recovery_id)
  if (!recovery) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '回收单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }

  // 友好提示（权威校验在 SQL 守卫）。
  if (!['draft', 'confirmed'].includes(sale.trade_state) || sale.balance_cents <= 0 || input.amountCents > sale.balance_cents) {
    return { ok: false, requestId: ctx.requestId, code: 'OFFSET_EXCEEDED', message: '销售单没有可折抵的正余额，或折抵金额超出应收', retryable: false, httpStatus: 422 }
  }
  const recoveryOffsets = await readRecoveryOffsets(db, ctx.storeId, recovery.id)
  const recoveryRemaining = recovery.payable_cents - validOffsetCents(recoveryOffsets)
  if (input.amountCents > recoveryRemaining) {
    return { ok: false, requestId: ctx.requestId, code: 'OFFSET_EXCEEDED', message: '折抵金额超出回收剩余应付', retryable: false, httpStatus: 422 }
  }

  const offsetId = `${ctx.requestId}::off`
  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) => planApplyOffset(db, context, tradeIn, sale, recovery, input, offsetId))
}

// ─────────────────────────────────────────────────────────────────────────────
// B32 · 撤销折抵（POST /trade-ins/:id/reverse-offset）
// 权限：tradein/reverse（owner_only）
// ─────────────────────────────────────────────────────────────────────────────

function planReverseOffset(
  db: OperationsDb,
  ctx: OperationContext,
  tradeIn: TradeInRow,
  sale: SaleOrderRow,
  target: OffsetRow,
  input: TradeInReverseInput,
  reversalId: string,
): OperationPlan {
  const nextOffsetNet = sale.offset_net_cents - target.amount_cents
  const nextBalance = sale.total_cents - sale.return_credit_cents - sale.cash_net_cents - nextOffsetNet
  const nextDirection = balanceDirectionFor(nextBalance)
  const nextSaleVersion = sale.version + 1
  const occurredAt = nowIso()

  return {
    statements: [
      guardStatement(
        db,
        'ENTITY_NOT_FOUND',
        "NOT EXISTS (SELECT 1 FROM trade_ins WHERE store_id = ? AND id = ? AND state = 'active')",
        ctx.storeId,
        tradeIn.id,
      ),
      // 目标折抵必须是 applied 且属于本关联。
      guardStatement(
        db,
        'ENTITY_NOT_FOUND',
        "NOT EXISTS (SELECT 1 FROM offsets WHERE store_id = ? AND id = ? AND trade_in_id = ? AND state = 'applied')",
        ctx.storeId,
        input.offsetId,
        tradeIn.id,
      ),
      // 该折抵尚未被撤销（部分唯一索引 idx_offsets_reversal_unique 兜底）。
      guardStatement(
        db,
        'VALIDATION_ERROR',
        'EXISTS (SELECT 1 FROM offsets WHERE store_id = ? AND reversal_of = ?)',
        ctx.storeId,
        input.offsetId,
      ),
      // 销售单未被取消 / 关闭（撤销后余额加回才有意义）。
      guardStatement(
        db,
        'VALIDATION_ERROR',
        "NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND trade_state IN ('draft', 'confirmed'))",
        ctx.storeId,
        tradeIn.sale_order_id,
      ),
      // 双方版本匹配（乐观锁）。
      guardStatement(
        db,
        'VERSION_CONFLICT',
        'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND version = ?)',
        ctx.storeId,
        tradeIn.sale_order_id,
        input.saleOrderVersion,
      ),
      guardStatement(
        db,
        'VERSION_CONFLICT',
        'NOT EXISTS (SELECT 1 FROM recovery_orders WHERE store_id = ? AND id = ? AND version = ?)',
        ctx.storeId,
        tradeIn.recovery_id,
        input.recoveryVersion,
      ),
      // 反向记录（reversed），原笔保留在净和中。
      db
        .prepare(
          `INSERT INTO offsets
             (id, store_id, trade_in_id, sale_order_id, recovery_id, amount_cents, state,
              reversal_of, reversed_reason, reversed_at, version, request_id, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'reversed', ?, ?, ?, 1, ?, ?, ?)`,
        )
        .bind(
          reversalId,
          ctx.storeId,
          tradeIn.id,
          tradeIn.sale_order_id,
          tradeIn.recovery_id,
          target.amount_cents,
          input.offsetId,
          input.reason,
          occurredAt,
          ctx.requestId,
          ctx.actorUserId,
          occurredAt,
        ),
      guardStatement(
        db,
        'VALIDATION_ERROR',
        'NOT EXISTS (SELECT 1 FROM offsets WHERE store_id = ? AND id = ?)',
        ctx.storeId,
        reversalId,
      ),
      // 销售侧：offset_net 回退、balance 重算。
      db
        .prepare(
          `UPDATE sale_orders
           SET offset_net_cents = ?, balance_cents = ?, balance_direction = ?,
               version = ?, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ?`,
        )
        .bind(
          nextOffsetNet,
          nextBalance,
          nextDirection,
          nextSaleVersion,
          ctx.actorUserId,
          occurredAt,
          ctx.storeId,
          tradeIn.sale_order_id,
          sale.version,
        ),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'sale_orders', 'id', tradeIn.sale_order_id, nextSaleVersion),
      guardStatement(
        db,
        'VALIDATION_ERROR',
        'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND offset_net_cents = ?)',
        ctx.storeId,
        tradeIn.sale_order_id,
        nextOffsetNet,
      ),
      bumpVersionStatement(db, ctx, 'SaleOrder', tradeIn.sale_order_id, nextSaleVersion),
    ],
    outcome: {
      entityType: 'Offset',
      entityId: reversalId,
      version: 1,
      summary: `撤销折抵 ${(target.amount_cents / 100).toFixed(2)} 元（${input.reason}）`,
      effects: {
        reversalId,
        reversalOf: input.offsetId,
        saleOrderId: tradeIn.sale_order_id,
        recoveryId: tradeIn.recovery_id,
        amountCents: target.amount_cents,
        saleBalanceCents: nextBalance,
        saleOffsetNetCents: nextOffsetNet,
      },
    },
    constraintCodes: {
      'offsets.store_id, offsets.reversal_of': 'VALIDATION_ERROR',
    },
  }
}

export async function reverseOffset(
  db: OperationsDb,
  ctx: OperationContext,
  tradeInId: string,
  input: TradeInReverseInput,
): Promise<RunResult> {
  const action = 'B32'
  if (!input.offsetId) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '缺少要撤销的折抵编号', retryable: false, httpStatus: 400 }
  }
  if (!input.reason || !input.reason.trim()) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '撤销折抵必须写明原因', retryable: false, httpStatus: 400 }
  }
  if (!Number.isInteger(input.saleOrderVersion) || !Number.isInteger(input.recoveryVersion)) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '双方版本必须是整数', retryable: false, httpStatus: 400 }
  }

  const payloadHash = await hashPayload({ tradeInId, offsetId: input.offsetId, reason: input.reason, saleOrderVersion: input.saleOrderVersion, recoveryVersion: input.recoveryVersion })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const tradeIn = await readTradeIn(db, ctx.storeId, tradeInId)
  if (!tradeIn) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '置换关联不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  const sale = await readOrder(db, ctx.storeId, tradeIn.sale_order_id)
  if (!sale) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '销售单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  const offsets = await readOffsets(db, ctx.storeId, tradeIn.id)
  const target = offsets.find((o) => o.id === input.offsetId && o.state === 'applied')
  if (!target) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '要撤销的折抵不存在、已撤销或不属于该置换关联', retryable: false, httpStatus: 404 }
  }
  if (offsets.some((o) => o.reversal_of === input.offsetId)) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '该折抵已被撤销，不能重复撤销', retryable: false, httpStatus: 404 }
  }

  const reversalId = `${ctx.requestId}::rev`
  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) => planReverseOffset(db, context, tradeIn, sale, target, input, reversalId))
}

// ─────────────────────────────────────────────────────────────────────────────
// R11 · 置换单读（GET /trade-ins/:id）
// 权限：tradein/view（default，旧 quote/view 等价）
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeInOffsetView {
  id: string
  amountCents: number
  state: OffsetState
  reversalOf: string | null
  reversedReason: string | null
  createdAt: string
}

export interface TradeInDetail {
  id: string
  state: string
  version: number
  createdAt: string
  saleOrder: {
    id: string
    orderNo: string
    customerId: number | null
    tradeState: string
    totalCents: number
    cashNetCents: number
    offsetNetCents: number
    returnCreditCents: number
    balanceCents: number
    balanceDirection: string
    version: number
  }
  recovery: {
    id: string
    orderNo: string
    sellerCustomerId: number | null
    state: string
    finalAcquisitionCents: number | null
    payableCents: number
    paidCents: number
    version: number
  }
  offsets: TradeInOffsetView[]
  /** 本回收单有效折抵 = SUM(applied) − SUM(reversed)，跨其全部置换关联汇总。 */
  validOffsetCents: number
  /** 回收剩余应付 = payable − 有效折抵（找零 / 继续折抵的上限）。 */
  recoveryPayableRemainingCents: number
}

export async function queryTradeIn(
  db: OperationsDb,
  storeId: number,
  tradeInId: string,
): Promise<TradeInDetail | null> {
  const tradeIn = await readTradeIn(db, storeId, tradeInId)
  if (!tradeIn) return null

  const sale = await readOrder(db, storeId, tradeIn.sale_order_id)
  const recovery = await readRecoveryForTradein(db, storeId, tradeIn.recovery_id)
  const offsets = await readOffsets(db, storeId, tradeIn.id)
  const recoveryOffsets = recovery ? await readRecoveryOffsets(db, storeId, recovery.id) : []
  const valid = validOffsetCents(recoveryOffsets)

  return {
    id: tradeIn.id,
    state: tradeIn.state,
    version: tradeIn.version,
    createdAt: tradeIn.created_at,
    saleOrder: sale
      ? {
          id: sale.id,
          orderNo: sale.order_no,
          customerId: sale.customer_id,
          tradeState: sale.trade_state,
          totalCents: sale.total_cents,
          cashNetCents: sale.cash_net_cents,
          offsetNetCents: sale.offset_net_cents,
          returnCreditCents: sale.return_credit_cents,
          balanceCents: sale.balance_cents,
          balanceDirection: sale.balance_direction,
          version: sale.version,
        }
      : (null as unknown as TradeInDetail['saleOrder']),
    recovery: recovery
      ? {
          id: recovery.id,
          orderNo: recovery.order_no,
          sellerCustomerId: recovery.seller_customer_id,
          state: recovery.state,
          finalAcquisitionCents: recovery.final_acquisition_cents,
          payableCents: recovery.payable_cents,
          paidCents: recovery.paid_cents,
          version: recovery.version,
        }
      : (null as unknown as TradeInDetail['recovery']),
    offsets: offsets.map((o) => ({
      id: o.id,
      amountCents: o.amount_cents,
      state: o.state as OffsetState,
      reversalOf: o.reversal_of,
      reversedReason: o.reversed_reason,
      createdAt: o.created_at,
    })),
    validOffsetCents: valid,
    recoveryPayableRemainingCents: recovery ? recovery.payable_cents - valid : 0,
  }
}
