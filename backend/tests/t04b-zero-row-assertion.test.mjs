/**
 * T04b · 04 §7 第 3 条的正面回答：
 * 「条件 UPDATE 影响 0 行并不天然是 SQL 错误」——所以要证明两件事：
 *   (1) 不设防时，这个洞会真的写出半截账（反例，证明它不是一个假想问题）；
 *   (2) 设防后，同样的场景整批中止、副作用为零。
 *
 * 顺带逐项验证三类断言手段在 D1 上确实生效：守卫表、CHECK 约束、唯一约束。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv, seedStore } from './lib/env.mjs'
import { makeDebit, resetDemo, scalar, seedBalance } from './lib/demo.mjs'

let env
let debit
const STORE = 1
const ACTOR = 1

before(async () => {
  env = await createTestEnv()
  await seedStore(env.db, { storeId: STORE, userId: ACTOR })
  debit = makeDebit(env, STORE, ACTOR)
})

after(async () => {
  await env?.dispose()
})

const insertFlow = (label, balanceId, qty, requestId) =>
  env.db
    .prepare('INSERT INTO demo_flows (id, balance_id, qty, request_id) VALUES (?, ?, ?, ?)')
    .bind(label, balanceId, qty, requestId)

const runBatch = async (statements) => {
  try {
    await env.db.batch(statements)
    return null
  } catch (error) {
    return error
  }
}

test('反例：不设防时「影响 0 行」会静默放过后续写入', async () => {
  await seedBalance(env.db, 90, 5, 1)

  const error = await runBatch([
    // 余量 5、要扣 10：条件不满足，影响 0 行，但 SQLite 不报错
    env.db
      .prepare(
        'UPDATE demo_balances SET available_qty = available_qty - ? WHERE id = ? AND available_qty >= ?',
      )
      .bind(10, 90, 10),
    insertFlow('naive-flow', 90, 10, 'req-naive'),
  ])

  assert.equal(error, null, '裸条件更新确实不会抛错')
  assert.equal(await scalar(env.db, 'SELECT available_qty FROM demo_balances WHERE id = 90'), 5, '余额没被扣')
  assert.equal(
    await scalar(env.db, 'SELECT COUNT(*) FROM demo_flows'),
    1,
    '但流水已经写进去了 —— 这正是必须堵住的半截账',
  )
})

test('设防后：同一场景被守卫拦下，整批回滚', async () => {
  await seedBalance(env.db, 91, 5, 1)
  const result = await debit('req-guarded-stock', { balanceId: 91, qty: 10, expectedVersion: 1 })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'STOCK_CONFLICT')
  assert.equal(await scalar(env.db, 'SELECT available_qty FROM demo_balances WHERE id = 91'), 5)
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM demo_flows'), 0, '流水不得留下')
})

test('CHECK 约束即断言：扣成负数会让整批失败', async () => {
  await seedBalance(env.db, 92, 5, 1)

  const error = await runBatch([
    env.db.prepare('UPDATE demo_balances SET available_qty = available_qty - ? WHERE id = ?').bind(10, 92),
    insertFlow('check-flow', 92, 10, 'req-check'),
  ])

  assert.ok(error, 'CHECK(available_qty >= 0) 必须报错')
  assert.match(String(error.message), /CHECK/i)
  assert.equal(await scalar(env.db, 'SELECT available_qty FROM demo_balances WHERE id = 92'), 5, '扣减回滚')
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM demo_flows'), 0, '流水回滚')
})

test('唯一约束即断言：版本日志重复插入会让整批失败', async () => {
  await resetDemo(env.db)

  const error = await runBatch([
    env.db
      .prepare(
        'INSERT INTO entity_version_log (entity_type, entity_id, version, request_id, store_id, actor_user_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind('DemoBalance', '93', 2, 'req-v-a', STORE, ACTOR),
    insertFlow('version-flow', 93, 1, 'req-v-a'),
    // 第二个客户端从同一个版本出发 —— 主键冲突，必须整批失败
    env.db
      .prepare(
        'INSERT INTO entity_version_log (entity_type, entity_id, version, request_id, store_id, actor_user_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind('DemoBalance', '93', 2, 'req-v-b', STORE, ACTOR),
  ])

  assert.ok(error, '版本日志主键冲突必须报错')
  assert.equal(
    await scalar(env.db, 'SELECT COUNT(*) FROM entity_version_log'),
    0,
    '第一条版本记录也要回滚',
  )
  assert.equal(
    await scalar(env.db, 'SELECT COUNT(*) FROM demo_flows'),
    0,
    '中间写入的流水必须一起回滚',
  )
})

test('守卫表在任何运行结束后都必须是空的', async () => {
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM assertion_guards'), 0)
})

test('失败动作不留下 operations 成功记录，只留脱敏诊断', async () => {
  await seedBalance(env.db, 94, 1, 1)
  const result = await debit('req-diag', { balanceId: 94, qty: 5, expectedVersion: 1 })

  assert.equal(result.ok, false)
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM operations'), 0)
  const failures = await scalar(
    env.db,
    "SELECT COUNT(*) FROM operation_failures WHERE request_id = 'req-diag' AND error_code = 'STOCK_CONFLICT'",
  )
  assert.equal(failures, 1, '失败诊断要记下来，且错误码正确')
})
