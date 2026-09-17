/**
 * T04 测试共用夹具：演示表的清理、播种与动作调用封装。
 * 仅测试使用，不属于生产代码。
 */

export const DEMO_TABLES = [
  'demo_reservations',
  'demo_flows',
  'demo_balances',
  'operations',
  'entity_version_log',
  'operation_failures',
  'assertion_guards',
]

export async function resetDemo(db) {
  for (const table of DEMO_TABLES) {
    await db.prepare(`DELETE FROM ${table}`).run()
  }
}

export async function seedBalance(db, id, availableQty, version = 1) {
  await resetDemo(db)
  await db
    .prepare('INSERT INTO demo_balances (id, available_qty, version) VALUES (?, ?, ?)')
    .bind(id, availableQty, version)
    .run()
}

export async function scalar(db, sql, ...params) {
  const row = await db.prepare(sql).bind(...params).first()
  return row ? Object.values(row)[0] : null
}

export async function rows(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all()
  return result.results ?? []
}

/**
 * 把一次写动作封装成可调用函数，走完整的幂等执行器。
 */
export function makeDebit(env, storeId, actorUserId) {
  return async function debit(requestId, input, overrides = {}) {
    const ctx = {
      storeId,
      actorUserId,
      requestId,
      action: overrides.action ?? 'demo.debit',
      payloadHash: overrides.payloadHash ?? (await env.demo.hashPayload(input)),
    }
    return env.demo.runIdempotent(env.db, ctx, (context) =>
      env.demo.planDebit(env.db, context, input),
    )
  }
}
