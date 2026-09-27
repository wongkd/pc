/** U02/U05 · B47 补录的真实 Worker API、来源读回、状态与幂等边界。 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'
import { seedProduct } from './lib/inventory.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER = { email: 'u02-backfill-owner@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: '补录验收店' }
let env
let db
let owner
let viewOnly

const json = async (response) => ({ status: response.status, body: await response.json() })

async function seedViewOnlyClerk() {
  const userId = 3
  const email = 'u02-backfill-view@local.test'
  await db.prepare(`INSERT INTO users (id, email, password_hash, status) VALUES (?, ?, ?, 'active')`)
    .bind(userId, email, await legacyPasswordHash(PASSWORD)).run()
  const member = await db.prepare(`INSERT INTO store_members (store_id, user_id, status, is_owner, created_by, updated_by)
    VALUES (1, ?, 'active', 0, 1, 1)`).bind(userId).run()
  const role = await db.prepare('INSERT INTO roles (store_id, code, name) VALUES (1, ?, ?)')
    .bind('u02-backfill-viewer', '只看库存').run()
  await db.prepare('INSERT OR IGNORE INTO permissions (code, name) VALUES (?, ?)')
    .bind('inventory/view', '库存查看').run()
  const permission = await db.prepare('SELECT id FROM permissions WHERE code = ?').bind('inventory/view').first()
  await db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)')
    .bind(role.meta.last_row_id, permission.id).run()
  await db.prepare('INSERT INTO member_roles (member_id, role_id) VALUES (?, ?)')
    .bind(member.meta.last_row_id, role.meta.last_row_id).run()
  return { email, password: PASSWORD }
}

const writeBackfill = (client, requestId, input) => client.post('/api/v2/inventory/backfills', { requestId, ...input })

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER)
  owner = createClient(env.call, await login(env.call, OWNER))
  viewOnly = createClient(env.call, await login(env.call, await seedViewOnlyClerk()))
})

after(async () => {
  await env?.dispose()
})

test('B47：逐件补录进入待检测，详情可回查批次和行，重复提交不增加库存', async () => {
  const product = await seedProduct(db, { entityId: 'u02-backfill-cpu', name: 'i5-12400F', category: 'CPU', trackingMode: 'item' })
  const input = {
    batchRef: 'u02-batch-cpu-1',
    note: '货架整理',
    lines: [{ lineRef: 'u02-line-cpu-1', productRef: product.entityId, qty: 1, condition: 'used', snRaw: 'CPU-SN-U02-1',
      remark: '散片', costBasis: 'known_actual', unitCostCents: 43_000 }],
  }
  const created = await json(await writeBackfill(owner, 'u02-backfill-request-1', input))
  assert.equal(created.status, 200, JSON.stringify({ body: created.body,
    diagnostic: await db.prepare('SELECT diagnostic FROM operation_failures WHERE store_id = 1 AND request_id = ?').bind('u02-backfill-request-1').first() }))
  const backfillId = created.body.data.entityId
  const stockItem = await db.prepare(`SELECT id, condition, availability, inspection_status, acquisition_ref,
      acquisition_cost_cents, cost_known, remark FROM stock_items WHERE store_id = 1 AND acquisition_ref = ?`)
    .bind(backfillId).first()
  assert.ok(stockItem)
  assert.deepEqual({ condition: stockItem.condition, availability: stockItem.availability, inspectionStatus: stockItem.inspection_status },
    { condition: 'used', availability: 'quarantine', inspectionStatus: 'pending' })
  assert.equal(stockItem.acquisition_cost_cents, 43_000)
  assert.equal(stockItem.cost_known, 1)
  assert.equal(stockItem.remark, '散片')

  const detail = await json(await owner.get(`/api/v2/inventory/items/${encodeURIComponent(stockItem.id)}`))
  assert.equal(detail.status, 200, JSON.stringify(detail.body))
  assert.deepEqual({ kind: detail.body.data.sourceRecord.kind, recordId: detail.body.data.sourceRecord.recordId,
    batchRef: detail.body.data.backfill.batchRef, lineRef: detail.body.data.backfill.lineRef },
  { kind: 'stock_backfill', recordId: backfillId, batchRef: input.batchRef, lineRef: 'u02-line-cpu-1' })

  const replay = await json(await writeBackfill(owner, 'u02-backfill-request-1', input))
  assert.equal(replay.status, 200, JSON.stringify(replay.body))
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM stock_items WHERE store_id = 1 AND acquisition_ref = ?')
    .bind(backfillId).first().then((row) => row.count), 1)

  const reusedBatch = await json(await writeBackfill(owner, 'u02-backfill-request-2', input))
  assert.equal(reusedBatch.status, 409)
  assert.equal(reusedBatch.body.error.code, 'IDEMPOTENCY_MISMATCH')

  const repeatedSn = await json(await writeBackfill(owner, 'u02-backfill-request-3', {
    ...input,
    batchRef: 'u02-batch-cpu-2',
    lines: input.lines.map((line) => ({ ...line, lineRef: 'u02-line-cpu-2' })),
  }))
  assert.equal(repeatedSn.status, 422)
  assert.equal(repeatedSn.body.error.code, 'SERIAL_MISMATCH')
})

test('B47：数量型号可分批增加余额，查看权限不能执行补录', async () => {
  const product = await seedProduct(db, { entityId: 'u02-backfill-cable', name: 'USB-C 线材', category: '线材', trackingMode: 'quantity' })
  const denied = await json(await writeBackfill(viewOnly, 'u02-backfill-denied', {
    batchRef: 'u02-batch-denied', lines: [{ lineRef: 'u02-line-denied', productRef: product.entityId, qty: 2, costBasis: 'unknown' }],
  }))
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED')

  const first = await json(await writeBackfill(owner, 'u02-backfill-qty-1', {
    batchRef: 'u02-batch-cable-1', note: null,
    lines: [{ lineRef: 'u02-line-cable-1', productRef: product.entityId, qty: 2, costBasis: 'unknown' }],
  }))
  assert.equal(first.status, 200, JSON.stringify({ body: first.body,
    diagnostic: await db.prepare('SELECT diagnostic FROM operation_failures WHERE store_id = 1 AND request_id = ?').bind('u02-backfill-qty-1').first() }))
  const second = await json(await writeBackfill(owner, 'u02-backfill-qty-2', {
    batchRef: 'u02-batch-cable-2', note: '第二批',
    lines: [{ lineRef: 'u02-line-cable-2', productRef: product.entityId, qty: 3, costBasis: 'unknown' }],
  }))
  assert.equal(second.status, 200, JSON.stringify(second.body))
  const listing = await json(await owner.get('/api/v2/inventory/stock-items?category=%E7%BA%BF%E6%9D%90'))
  assert.equal(listing.status, 200, JSON.stringify(listing.body))
  assert.equal(listing.body.data.quantityProducts.find((row) => row.id === product.entityId).ownOnHandQty, 5)
  assert.equal(listing.body.data.items.length, 0, '数量余额不能伪造成逐件实物')
})
