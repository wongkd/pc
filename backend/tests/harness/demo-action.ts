/**
 * T04 测试专用的演示动作（不属于生产代码）。
 *
 * 它刻意写成将来业务动作的形状：乐观锁 → 余量断言 → 版本推进 → 条件更新 →
 * 断言更新生效 → 写流水。业务动作由 T05 之后的卡片各自实现，这里只用来
 * 把一致性机制压到真实 D1 上跑。
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
  type OperationQueryResult,
  type OperationsDb,
} from '../../src/domains/operations'

export {
  runIdempotent,
  queryOperation,
  hashPayload,
  bumpVersionStatement,
  guardStatement,
  assertRowVersionStatement,
}
export type { OperationContext, OperationPlan, OperationQueryResult, OperationsDb }

export interface DemoDebitInput {
  balanceId: number
  qty: number
  expectedVersion: number
  /** 故意在批次末尾追加一条必然失败的语句，用于验证整批回滚。 */
  failTail?: boolean
}

/**
 * 从余额扣减数量、推进版本、写一条流水。
 * 覆盖三类断言：版本匹配、余量充足、条件更新必须生效。
 */
export function planDebit(
  db: OperationsDb,
  ctx: OperationContext,
  input: DemoDebitInput,
): OperationPlan {
  const { balanceId, qty, expectedVersion } = input
  const nextVersion = expectedVersion + 1
  const flowId = `${ctx.requestId}#flow`

  const statements = [
    // 1. 版本必须匹配 —— 提前给出精确错误码（并发兜底在版本日志的唯一键上）
    guardStatement(
      db,
      'VERSION_CONFLICT',
      'NOT EXISTS (SELECT 1 FROM demo_balances WHERE id = ? AND version = ?)',
      balanceId,
      expectedVersion,
    ),
    // 2. 余量必须充足
    guardStatement(
      db,
      'STOCK_CONFLICT',
      'NOT EXISTS (SELECT 1 FROM demo_balances WHERE id = ? AND available_qty >= ?)',
      balanceId,
      qty,
    ),
    // 3. 版本推进：主键冲突即并发失败
    bumpVersionStatement(db, ctx, 'DemoBalance', String(balanceId), nextVersion),
    // 4. 条件更新
    db
      .prepare(
        'UPDATE demo_balances SET available_qty = available_qty - ?, version = ? WHERE id = ? AND version = ?',
      )
      .bind(qty, nextVersion, balanceId, expectedVersion),
    // 5. 断言上一步确实生效 —— 若影响 0 行，这里会把静默失败变成硬错误
    assertRowVersionStatement(db, 'VERSION_CONFLICT', 'demo_balances', 'id', balanceId, nextVersion),
    // 6. 业务流水（每项副作用都要有唯一来源标识）
    db
      .prepare('INSERT INTO demo_flows (id, balance_id, qty, request_id) VALUES (?, ?, ?, ?)')
      .bind(flowId, balanceId, qty, ctx.requestId),
  ]

  if (input.failTail) {
    // 同一主键再插一次 → 唯一约束失败 → 整个批次回滚
    statements.push(
      db
        .prepare('INSERT INTO demo_flows (id, balance_id, qty, request_id) VALUES (?, ?, ?, ?)')
        .bind(flowId, balanceId, qty, ctx.requestId),
    )
  }

  return {
    statements,
    outcome: {
      entityType: 'DemoBalance',
      entityId: String(balanceId),
      version: nextVersion,
      summary: `扣减 ${qty}`,
      effects: { flowId },
    },
    constraintCodes: { 'demo_flows.id': 'VALIDATION_ERROR' },
  }
}

export interface DemoReserveInput {
  itemId: number
  orderId: string
}

/**
 * demo 动作：把一个实物占给某张单。
 *
 * 唯一索引 ux_demo_reservations_active_item 就是断言：同一实物同时只能有一条 active。
 * 两个不同的 requestId 各自来抢，第二个必然撞唯一约束 —— 这正是 §7 第 7 条
 * 「不同 ID 重复交付仍由业务唯一约束拒绝」的形态。
 */
export function planReserve(
  db: OperationsDb,
  ctx: OperationContext,
  input: DemoReserveInput,
): OperationPlan {
  const reservationId = `${ctx.requestId}#reservation`
  return {
    statements: [
      db
        .prepare(
          'INSERT INTO demo_reservations (id, item_id, order_id, status) VALUES (?, ?, ?, ?)',
        )
        .bind(reservationId, input.itemId, input.orderId, 'active'),
    ],
    outcome: {
      entityType: 'DemoReservation',
      entityId: reservationId,
      version: 1,
      summary: `占用实物 ${input.itemId}`,
    },
    constraintCodes: { 'demo_reservations.item_id': 'STOCK_CONFLICT' },
  }
}
