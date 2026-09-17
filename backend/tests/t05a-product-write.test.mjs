/**
 * T05a · B12 建立与修改商品主数据（POST /inventory/products）。
 * 权限码 inventory/product-edit 由请求层装配，本层不鉴权（T03）。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createInventoryEnv, ctx, resetInventory, rows, scalar, seedProduct, STORE } from './lib/inventory.mjs'

let env
let db
let write

before(async () => {
  env = await createInventoryEnv()
  db = env.db
  write = (requestId, input, action = 'B12') => env.inventory.writeProduct(db, ctx(requestId, action), input)
})

after(async () => {
  await env?.dispose()
})

test('建立商品：写入幂等记录与版本日志，逐件属性与旧列同步', async () => {
  await resetInventory(db)
  const result = await write('req-prod-1', {
    name: '测试显卡 RTX-0001',
    sku: 'GPU-0001',
    category: '显卡',
    trackingMode: 'item',
    requiresSn: true,
    specs: '12G / GDDR7',
    defaultSalePriceCents: 459900,
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.reused, false)
  assert.equal(result.outcome.entityType, 'Product')
  assert.equal(result.outcome.version, 1)

  const row = await rows(
    db,
    `SELECT sku, name, category, tracking_mode, requires_sn, is_serialized, specs, version, default_price_cents
     FROM hardware WHERE store_id = ? AND entity_id = ?`,
    STORE,
    result.outcome.entityId,
  )
  assert.deepEqual(row[0], {
    sku: 'GPU-0001',
    name: '测试显卡 RTX-0001',
    category: '显卡',
    tracking_mode: 'item',
    requires_sn: 1,
    is_serialized: 1,
    specs: '12G / GDDR7',
    version: 1,
    default_price_cents: 459900,
  })
  assert.equal(await scalar(db, "SELECT COUNT(*) FROM operations WHERE status = 'succeeded'"), 1)
  assert.equal(
    await scalar(db, `SELECT COUNT(*) FROM entity_version_log WHERE entity_type = 'Product' AND entity_id = ?`, result.outcome.entityId),
    1,
  )
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM assertion_guards'), 0)
})

test('同 requestId 同载荷：复用原结果，不重复建档', async () => {
  await resetInventory(db)
  const input = { name: '复用商品', sku: 'GPU-REUSE', trackingMode: 'quantity', requiresSn: false }

  const first = await write('req-prod-reuse', input)
  const second = await write('req-prod-reuse', input)

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.reused, true, '第二次必须复用而不是重放')
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM hardware', ), 1)
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM operations'), 1)
})

test('同 requestId 改载荷：IDEMPOTENCY_MISMATCH，且不产生新商品', async () => {
  await resetInventory(db)
  const first = await write('req-prod-mismatch', { name: '商品 A', sku: 'GPU-A', trackingMode: 'quantity', requiresSn: false })
  const second = await write('req-prod-mismatch', { name: '商品 B', sku: 'GPU-B', trackingMode: 'quantity', requiresSn: false })

  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.code, 'IDEMPOTENCY_MISMATCH')
  assert.equal(second.httpStatus, 409)
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM hardware'), 1, '不得建立第二个商品')
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM operations'), 1)
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM operation_failures'), 1, '失败要留下脱敏诊断')
})

test('SKU 重复被拒，且不留半截记录', async () => {
  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-sku-a', sku: 'GPU-DUP' })

  const result = await write('req-prod-dup', {
    name: '撞号商品',
    sku: 'GPU-DUP',
    trackingMode: 'quantity',
    requiresSn: false,
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'VALIDATION_ERROR')
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM hardware'), 1)
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM operations'), 0, '失败动作不留幂等成功记录')
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM assertion_guards'), 0)
})

test('修改商品：推进版本并写版本日志', async () => {
  await resetInventory(db)
  const created = await write('req-prod-edit-1', { name: '待改名商品', sku: 'GPU-EDIT', trackingMode: 'quantity', requiresSn: false })
  const entityId = created.outcome.entityId

  const updated = await write('req-prod-edit-2', {
    productRef: entityId,
    expectedVersion: 1,
    name: '已改名商品',
    sku: 'GPU-EDIT',
    trackingMode: 'quantity',
    requiresSn: false,
    defaultSalePriceCents: 199900,
  })

  assert.equal(updated.ok, true, JSON.stringify(updated))
  assert.equal(updated.outcome.version, 2)
  assert.equal(await scalar(db, 'SELECT name FROM hardware WHERE entity_id = ?', entityId), '已改名商品')
  assert.equal(await scalar(db, 'SELECT version FROM hardware WHERE entity_id = ?', entityId), 2)
  assert.equal(
    await scalar(db, `SELECT COUNT(*) FROM entity_version_log WHERE entity_type = 'Product' AND entity_id = ?`, entityId),
    2,
  )
})

test('关键属性已发生业务后不得改写：改 trackingMode 被拒且无副作用', async () => {
  await resetInventory(db)
  const created = await write('req-prod-lock-1', { name: '已建账商品', sku: 'GPU-LOCK', trackingMode: 'quantity', requiresSn: false })
  const entityId = created.outcome.entityId

  // 让该商品发生业务：期初建账一件
  const opening = await env.inventory.createOpening(db, ctx('req-prod-lock-open', 'B13'), {
    approvedCountRef: '实盘单 LC-001',
    costBasis: { kind: 'known' },
    lines: [{ productRef: entityId, qty: 2, unitCostCents: 100000 }],
  })
  assert.equal(opening.ok, true, JSON.stringify(opening))

  const before = await scalar(db, 'SELECT version FROM hardware WHERE entity_id = ?', entityId)
  const blocked = await write('req-prod-lock-2', {
    productRef: entityId,
    expectedVersion: before,
    name: '已建账商品',
    trackingMode: 'item',
    requiresSn: true,
  })

  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'VALIDATION_ERROR')
  assert.equal(await scalar(db, 'SELECT tracking_mode FROM hardware WHERE entity_id = ?', entityId), 'quantity', '不得静默改写')
  assert.equal(await scalar(db, 'SELECT version FROM hardware WHERE entity_id = ?', entityId), before, '版本也不得推进')
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM assertion_guards'), 0)
})

test('版本不匹配：VERSION_CONFLICT，无副作用', async () => {
  await resetInventory(db)
  const created = await write('req-prod-ver-1', { name: '版本商品', sku: 'GPU-VER', trackingMode: 'quantity', requiresSn: false })
  const entityId = created.outcome.entityId

  const conflict = await write('req-prod-ver-2', {
    productRef: entityId,
    expectedVersion: 7,
    name: '版本商品改名',
    trackingMode: 'quantity',
    requiresSn: false,
  })

  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'VERSION_CONFLICT')
  assert.equal(conflict.httpStatus, 409)
  assert.equal(await scalar(db, 'SELECT name FROM hardware WHERE entity_id = ?', entityId), '版本商品')
  assert.equal(await scalar(db, 'SELECT version FROM hardware WHERE entity_id = ?', entityId), 1)
})

test('参数非法：在拼 SQL 之前就被拦住，不落库', async () => {
  await resetInventory(db)
  const noName = await write('req-prod-bad-1', { name: '   ', trackingMode: 'quantity', requiresSn: false })
  assert.equal(noName.ok, false)
  assert.equal(noName.code, 'VALIDATION_ERROR')

  const noVersion = await write('req-prod-bad-2', { productRef: 'nope', name: '无版本', trackingMode: 'quantity', requiresSn: false })
  assert.equal(noVersion.ok, false)
  assert.equal(noVersion.code, 'VALIDATION_ERROR')

  const badPrice = await write('req-prod-bad-3', {
    name: '浮点价格',
    trackingMode: 'quantity',
    requiresSn: false,
    defaultSalePriceCents: 12.5,
  })
  assert.equal(badPrice.ok, false)
  assert.equal(badPrice.code, 'VALIDATION_ERROR')

  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM hardware'), 0)
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM operations'), 0)
})

test('修改不存在的商品：ENTITY_NOT_FOUND', async () => {
  await resetInventory(db)
  const missing = await write('req-prod-404', {
    productRef: 'prod-does-not-exist',
    expectedVersion: 1,
    name: '幽灵商品',
    trackingMode: 'quantity',
    requiresSn: false,
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'ENTITY_NOT_FOUND')
  assert.equal(missing.httpStatus, 404)
})
