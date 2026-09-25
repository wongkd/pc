/**
 * T04a · 一致性基础设施：结构、断言守卫、幂等记录。
 *
 * 跑在真实 workerd + 真实 D1 上（miniflare），被测代码经 esbuild 打包后直接调用。
 * 跑法：npm --prefix backend test
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv, seedStore } from './lib/env.mjs'
import { makeDebit, scalar, seedBalance } from './lib/demo.mjs'

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

test('迁移与结构：0006 的四处对象都已建立', async () => {
  assert.ok(env.migrations.length >= 7, `迁移文件数应 >= 7，实际 ${env.migrations.length}`)
  const names = await env.db
    .prepare(
      `SELECT name FROM sqlite_master WHERE name IN
         ('operations','assertion_guards','entity_version_log','operation_failures','assertion_guards_abort')
       ORDER BY name`,
    )
    .all()
  const found = names.results.map((r) => r.name).sort()
  assert.deepEqual(found, [
    'assertion_guards',
    'assertion_guards_abort',
    'entity_version_log',
    'operation_failures',
    'operations',
  ])
})

test('数据库失败诊断不会被通用 VALIDATION_ERROR 吞掉', () => {
  assert.equal(
    env.demo.readableDiagnostic('UNIQUE constraint failed: sale_orders.store_id, sale_orders.order_no'),
    '订单号已存在（订单号生成冲突）',
  )
  assert.equal(
    env.demo.readableDiagnostic('FOREIGN KEY constraint failed'),
    '关联对象不存在，或不属于当前门店',
  )
  assert.equal(
    env.demo.appendReadableDiagnostic('报价没有通过转单校验', 'UNIQUE constraint failed: sale_orders.store_id, sale_orders.order_no'),
    '报价没有通过转单校验（具体原因：订单号已存在（订单号生成冲突））',
  )
})

test('守卫表在静息状态必须为空', async () => {
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM assertion_guards'), 0)
})

test('正常路径：扣减、流水、幂等记录、版本日志各一笔', async () => {
  await seedBalance(env.db, 1, 10, 1)
  const result = await debit('req-ok-1', { balanceId: 1, qty: 3, expectedVersion: 1 })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.reused, false)
  assert.equal(result.outcome.version, 2)

  assert.equal(await scalar(env.db, 'SELECT available_qty FROM demo_balances WHERE id = 1'), 7)
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM demo_flows'), 1)
  assert.equal(await scalar(env.db, "SELECT COUNT(*) FROM operations WHERE status = 'succeeded'"), 1)
  assert.equal(
    await scalar(env.db, "SELECT COUNT(*) FROM entity_version_log WHERE entity_type = 'DemoBalance'"),
    1,
  )
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM assertion_guards'), 0)
})

test('同 requestId 同载荷：复用原结果，副作用不叠加', async () => {
  await seedBalance(env.db, 2, 10, 1)
  const input = { balanceId: 2, qty: 4, expectedVersion: 1 }

  const first = await debit('req-reuse-1', input)
  const second = await debit('req-reuse-1', input)

  assert.equal(first.ok, true)
  assert.equal(first.reused, false)
  assert.equal(second.ok, true)
  assert.equal(second.reused, true, '第二次必须复用而不是重放')

  assert.equal(await scalar(env.db, 'SELECT available_qty FROM demo_balances WHERE id = 2'), 6)
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM demo_flows'), 1, '流水不得重复')
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM operations'), 1)
})

test('同 requestId 改载荷：IDEMPOTENCY_MISMATCH，且不产生副作用', async () => {
  await seedBalance(env.db, 3, 10, 1)
  const first = await debit('req-mismatch-1', { balanceId: 3, qty: 2, expectedVersion: 1 })
  // 只改金额，requestId 不动
  const second = await debit('req-mismatch-1', { balanceId: 3, qty: 9, expectedVersion: 1 })

  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.code, 'IDEMPOTENCY_MISMATCH')
  assert.equal(second.httpStatus, 409)

  assert.equal(
    await scalar(env.db, 'SELECT available_qty FROM demo_balances WHERE id = 3'),
    8,
    '不得重复扣减',
  )
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM demo_flows'), 1)
  assert.equal(
    await scalar(env.db, 'SELECT COUNT(*) FROM operation_failures'),
    1,
    '失败要留下脱敏诊断，但不进 operations',
  )
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM operations'), 1)
})

test('版本不匹配：VERSION_CONFLICT，无任何副作用', async () => {
  await seedBalance(env.db, 4, 10, 5)
  const result = await debit('req-version-1', { balanceId: 4, qty: 1, expectedVersion: 2 })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'VERSION_CONFLICT')
  assert.equal(result.httpStatus, 409)
  assert.equal(await scalar(env.db, 'SELECT available_qty FROM demo_balances WHERE id = 4'), 10)
  assert.equal(await scalar(env.db, 'SELECT version FROM demo_balances WHERE id = 4'), 5)
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM demo_flows'), 0)
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM operations'), 0, '失败动作不留幂等成功记录')
})

test('余量不足：STOCK_CONFLICT，无任何副作用', async () => {
  await seedBalance(env.db, 5, 2, 1)
  const result = await debit('req-stock-1', { balanceId: 5, qty: 10, expectedVersion: 1 })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'STOCK_CONFLICT')
  assert.equal(await scalar(env.db, 'SELECT available_qty FROM demo_balances WHERE id = 5'), 2)
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM demo_flows'), 0)
})

test('批次中途失败：整批回滚，业务副作用为零', async () => {
  await seedBalance(env.db, 6, 10, 1)
  const result = await debit('req-tail-1', {
    balanceId: 6,
    qty: 3,
    expectedVersion: 1,
    failTail: true,
  })

  assert.equal(result.ok, false, '末尾的重复主键必须让整批失败')
  assert.equal(await scalar(env.db, 'SELECT available_qty FROM demo_balances WHERE id = 6'), 10, '扣减必须回滚')
  assert.equal(await scalar(env.db, 'SELECT version FROM demo_balances WHERE id = 6'), 1, '版本必须回滚')
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM demo_flows'), 0, '流水必须回滚')
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM operations'), 0, '幂等记录必须回滚')
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM entity_version_log'), 0, '版本日志必须回滚')
  assert.equal(await scalar(env.db, 'SELECT COUNT(*) FROM assertion_guards'), 0)
})
