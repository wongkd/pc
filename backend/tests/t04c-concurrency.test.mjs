/**
 * T04c · 并发、重复动作与「写成功但响应丢失」的恢复。
 *
 * 目标（04 §7 第 5、7 条 / 契约 unknownResultProcedure）：
 *   · 两个客户端竞争同一资源，只有一个有效结果，不留部分账；
 *   · 同一 requestId 被真正并发提交时，副作用仍然恰好一次；
 *   · 响应丢失后，客户端能靠查询与同 ID 同载荷重发安全恢复。
 *
 * 说明：本地 D1 由 workerd 串行调度，因此这里的「并发」是两条请求同时在途、
 * 由数据库约束决出唯一胜者 —— 这正是要验证的机制；不代表已做过跨机房压测。
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

const reserve = async (requestId, input) => {
  const ctx = {
    storeId: STORE,
    actorUserId: ACTOR,
    requestId,
    action: 'demo.reserve',
    payloadHash: await env.demo.hashPayload(input),
  }
  return env.demo.runIdempotent(env.db, ctx, (context) =>
    env.demo.planReserve(env.db, context, input),
  )
}

test('并发：两个客户端从同一版本抢同一资源，只有一个生效', async () => {
  await seedBalance(env.db, 100, 10, 1)
  const input = { balanceId: 100, qty: 3, expectedVersion: 1 }

  const [a, b] = await Promise.all([debit('req-race-a', input), debit('req-race-b', input)])

  const winners = [a, b].filter((r) => r.ok)
  const losers = [a, b].filter((r) => !r.ok)
  assert.equal(winners.length, 1, `应恰好一个成功，实际 ${winners.length}`)
  assert.equal(losers.length, 1)
  assert.equal(losers[0].code, 'VERSION_CONFLICT')

  assert.equal(await scalar(env.db, 'SELECT available_qty FROM demo_balances WHERE id = 100'), 7, '只扣一次')
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM demo_flows'), 1, '只有一条流水')
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM entity_version_log'), 1, '只推进一次版本')
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM operations'), 1, '只有一条成功记录')
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM assertion_guards'), 0)
})

test('并发：同一 requestId 被同时提交两次，副作用仍然恰好一次', async () => {
  await seedBalance(env.db, 101, 10, 1)
  const input = { balanceId: 101, qty: 2, expectedVersion: 1 }

  const [a, b] = await Promise.all([debit('req-same-id', input), debit('req-same-id', input)])

  assert.ok(a.ok && b.ok, `两次都应返回成功，实际 a=${JSON.stringify(a)} b=${JSON.stringify(b)}`)
  assert.equal(await scalar(env.db, 'SELECT available_qty FROM demo_balances WHERE id = 101'), 8, '不得扣两次')
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM demo_flows'), 1)
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM operations'), 1)
})

test('不同 requestId 抢同一实物：业务唯一约束拒绝第二个', async () => {
  await resetDemo(env.db)

  const first = await reserve('req-item-a', { itemId: 777, orderId: 'SO-A' })
  const second = await reserve('req-item-b', { itemId: 777, orderId: 'SO-B' })

  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(second.ok, false, '同一实物不能有两条有效占用')
  assert.equal(second.code, 'STOCK_CONFLICT')
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM demo_reservations'), 1)

  // 释放之后可以重新占用
  await env.db
    .prepare("UPDATE demo_reservations SET status = 'released' WHERE item_id = 777")
    .run()
  const third = await reserve('req-item-c', { itemId: 777, orderId: 'SO-C' })
  assert.equal(third.ok, true, '原占用释放后应能再次占用')
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM demo_reservations'), 2)
  assert.equal(await scalar(env.db, `SELECT COUNT(*) FROM demo_reservations WHERE status = 'active'`), 1)
})

test('写成功但响应丢失：查询可恢复结果，重发复用不重复扣减', async () => {
  await seedBalance(env.db, 102, 10, 1)
  const input = { balanceId: 102, qty: 2, expectedVersion: 1 }

  const first = await debit('req-lost-1', input)
  assert.equal(first.ok, true, '服务端其实已经成功')
  const payloadHash = await env.demo.hashPayload(input)

  // 客户端没收到响应 —— 先查，不贸然换 ID 重发
  const queried = await env.demo.queryOperation(env.db, STORE, 'req-lost-1', {
    action: 'demo.debit',
    payloadHash,
  })
  assert.equal(queried.found, true)
  assert.equal(queried.status, 'succeeded')
  assert.equal(queried.mismatch, false)
  assert.equal(queried.outcome.entityId, '102')
  assert.equal(queried.outcome.version, 2)

  // 确需重发时用同 ID 同载荷
  const retry = await debit('req-lost-1', input)
  assert.equal(retry.ok, true)
  assert.equal(retry.reused, true, '必须复用原结果')

  assert.equal(await scalar(env.db, 'SELECT available_qty FROM demo_balances WHERE id = 102'), 8)
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM demo_flows'), 1)
})

test('查询未知 requestId：如实返回 found=false，不编造结果', async () => {
  const result = await env.demo.queryOperation(env.db, STORE, 'req-never-happened')
  assert.equal(result.found, false)
  assert.equal(result.outcome, undefined)
})

test('查询时载荷不一致：如实标出 mismatch', async () => {
  await seedBalance(env.db, 103, 10, 1)
  const input = { balanceId: 103, qty: 1, expectedVersion: 1 }
  await debit('req-mismatch-query', input)

  const wrong = await env.demo.queryOperation(env.db, STORE, 'req-mismatch-query', {
    action: 'demo.debit',
    payloadHash: await env.demo.hashPayload({ ...input, qty: 5 }),
  })
  assert.equal(wrong.found, true)
  assert.equal(wrong.mismatch, true)
})

test('失败之后用新 requestId 重试：允许，且不会留下失败请求的残留', async () => {
  await seedBalance(env.db, 104, 10, 1)

  const failed = await debit('req-retry-fail', { balanceId: 104, qty: 99, expectedVersion: 1 })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'STOCK_CONFLICT')

  const retried = await debit('req-retry-ok', { balanceId: 104, qty: 4, expectedVersion: 1 })
  assert.equal(retried.ok, true, '换新 ID 用正确金额应当成功')
  assert.equal(await scalar(env.db, 'SELECT available_qty FROM demo_balances WHERE id = 104'), 6)
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM demo_flows'), 1, '失败那次不得留下流水')
})
