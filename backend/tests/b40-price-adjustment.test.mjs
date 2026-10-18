/** B40 商品挂牌价调整：老板动作、版本并发、幂等与历史快照边界。 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createInventoryEnv, ctx, resetInventory, scalar } from './lib/inventory.mjs'
let env
let db

before(async () => {
  env = await createInventoryEnv()
  db = env.db
})

after(async () => { await env?.dispose() })

test('B40 调整挂牌价：只推进商品版本并写审计，重复 requestId 复用', async () => {
  await resetInventory(db)
  await db.prepare(`INSERT INTO hardware
    (user_id, store_id, category, name, entity_id, tracking_mode, requires_sn, is_serialized, status, default_price_cents, item_type, version)
    VALUES (1, 1, '测试', 'B40 商品', 'b40-product', 'quantity', 0, 0, 'active', 10000, 'product', 1)`).run()
  const input = { productRef: 'b40-product', newPriceCents: 12345, reason: 'market_change', note: '本地验收', expectedVersion: 1 }
  const first = await env.inventory.adjustProductPrice(db, ctx('b40-price-1', 'B40'), input)
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.outcome.version, 2)
  const second = await env.inventory.adjustProductPrice(db, ctx('b40-price-1', 'B40'), input)
  assert.equal(second.ok, true)
  assert.equal(second.reused, true)
  assert.equal(await scalar(db, `SELECT default_price_cents FROM hardware WHERE entity_id = 'b40-product'`), 12345)
  assert.equal(await scalar(db, `SELECT version FROM hardware WHERE entity_id = 'b40-product'`), 2)
  assert.equal(await scalar(db, `SELECT COUNT(*) FROM audit_logs WHERE action = 'inventory_price_adjust' AND entity_id = 'b40-product'`), 1)
})

test('B40 版本冲突拒绝，历史版本不被静默覆盖', async () => {
  await resetInventory(db)
  await db.prepare(`INSERT INTO hardware
    (user_id, store_id, category, name, entity_id, tracking_mode, requires_sn, is_serialized, status, default_price_cents, item_type, version)
    VALUES (1, 1, '测试', 'B40 冲突', 'b40-conflict', 'quantity', 0, 0, 'active', 20000, 'product', 3)`).run()
  const result = await env.inventory.adjustProductPrice(db, ctx('b40-price-conflict', 'B40'), {
    productRef: 'b40-conflict', newPriceCents: 1, reason: 'correction', expectedVersion: 2,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'VERSION_CONFLICT')
  assert.equal(await scalar(db, `SELECT default_price_cents FROM hardware WHERE entity_id = 'b40-conflict'`), 20000)
})
