import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient } from './lib/worker.mjs'

const PASSWORD = 'local-preview-pass'
const ownerA = { email: 'd10-owner-a@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: 'D10 正式门店甲' }
const ownerB = { email: 'd10-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: 'D10 正式门店乙' }
const ownerC = { email: 'd10-owner-c@local.test', password: PASSWORD, storeId: 3, userId: 3, storeName: 'D10 正式门店丙' }
const previewOwner = { email: 'd10-preview-owner@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: 'D10 隔离预览门店' }

let formalEnv
let previewEnv
let db
let formalClients = new Map()
let previewClient

async function json(response) {
  return { status: response.status, body: await response.json() }
}

async function clientFor(env, owner) {
  await seedOwner(env.db, owner)
  return createClient(env.call, await login(env.call, owner))
}

async function createProduct(client, requestId, { trackingMode = 'quantity', sku = requestId } = {}) {
  const result = await json(await client.post('/api/v2/inventory/products', {
    name: `D10 商品 ${requestId}`,
    sku,
    category: '配件',
    trackingMode,
    requiresSn: trackingMode === 'item',
    requestId,
  }))
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body.data.entityId
}

async function openWindow(client, requestId, durationDays = 7) {
  return json(await client.post('/api/v2/inventory/openings', {
    command: 'open_window', durationDays, requestId,
  }))
}

before(async () => {
  formalEnv = await createWorkerEnv({ bindings: { INVENTORY_OPENING_MODE: 'formal' } })
  previewEnv = await createWorkerEnv({ bindings: { INVENTORY_OPENING_MODE: 'preview' } })
  db = formalEnv.db
  formalClients.set(1, await clientFor(formalEnv, ownerA))
  formalClients.set(2, await clientFor(formalEnv, ownerB))
  formalClients.set(3, await clientFor(formalEnv, ownerC))
  previewClient = await clientFor(previewEnv, previewOwner)
})

after(async () => {
  await Promise.all([formalEnv?.dispose(), previewEnv?.dispose()])
})

test('D10 正式期初：成本四分类、窗口期限、行级防重和首笔流水关闭', async () => {
  const client = formalClients.get(1)
  const productActual = await createProduct(client, 'd10-product-actual')
  const productEstimate = await createProduct(client, 'd10-product-estimate')
  const productUnknown = await createProduct(client, 'd10-product-unknown')
  const productZero = await createProduct(client, 'd10-product-zero')
  const productItemEstimate = await createProduct(client, 'd10-product-item-estimate', { trackingMode: 'item' })

  const beforeWindow = await json(await client.post('/api/v2/inventory/openings', {
    requestId: 'd10-opening-before-window', approvedCountRef: 'D10-COUNT-01',
    lines: [{ approvedCountLineRef: 'A-01', productRef: productActual, qty: 1, costBasis: 'known_actual', unitCostCents: 500, costEvidenceRef: 'INV-1' }],
  }))
  assert.equal(beforeWindow.body.error.code, 'VALIDATION_ERROR')
  assert.match(beforeWindow.body.error.message, /窗口|期限|关闭/)
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM inventory_openings WHERE request_id = ?')
    .bind('d10-opening-before-window').first()).n, 0)

  const tooLong = await openWindow(client, 'd10-window-too-long', 8)
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.body.error.code, 'VALIDATION_ERROR')

  const opened = await openWindow(client, 'd10-window-open', 7)
  assert.equal(opened.status, 200, JSON.stringify(opened.body))
  const replay = await openWindow(client, 'd10-window-open', 7)
  assert.equal(replay.status, 200, '同 requestId 的窗口开启请求应安全复用')
  assert.equal(replay.body.data.entityId, opened.body.data.entityId)

  const badActual = await json(await client.post('/api/v2/inventory/openings', {
    requestId: 'd10-bad-actual', approvedCountRef: 'D10-COUNT-01',
    lines: [{ approvedCountLineRef: 'A-01', productRef: productActual, qty: 1, costBasis: 'known_actual', unitCostCents: 0, costEvidenceRef: 'INV-1' }],
  }))
  assert.equal(badActual.status, 400)
  assert.match(badActual.body.error.message, /实际成本|真实零成本/)

  const missingLineRef = await json(await client.post('/api/v2/inventory/openings', {
    requestId: 'd10-missing-line-ref', approvedCountRef: 'D10-COUNT-01',
    lines: [{ productRef: productActual, qty: 1, costBasis: 'known_actual', unitCostCents: 500, costEvidenceRef: 'INV-1' }],
  }))
  assert.equal(missingLineRef.status, 400)
  assert.match(missingLineRef.body.error.message, /盘点明细行引用/)

  const duplicateLineRefs = await json(await client.post('/api/v2/inventory/openings', {
    requestId: 'd10-duplicate-line-refs', approvedCountRef: 'D10-DUP-COUNT',
    lines: [
      { approvedCountLineRef: 'DUP-01', productRef: productActual, qty: 1, costBasis: 'known_actual', unitCostCents: 500, costEvidenceRef: 'INV-1' },
      { approvedCountLineRef: 'DUP-01', productRef: productEstimate, qty: 1, costBasis: 'known_actual', unitCostCents: 500, costEvidenceRef: 'INV-2' },
    ],
  }))
  assert.equal(duplicateLineRefs.status, 400)
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM inventory_opening_lines WHERE approved_count_ref = ?')
    .bind('D10-DUP-COUNT').first()).n, 0, '重复导入必须整批回滚')

  const formalOpening = await json(await client.post('/api/v2/inventory/openings', {
    requestId: 'd10-formal-opening',
    approvedCountRef: 'D10-COUNT-01',
    note: '老板确认只计门店自有现存库存',
    lines: [
      { approvedCountLineRef: 'A-01', productRef: productActual, qty: 2, costBasis: 'known_actual', unitCostCents: 10000, costEvidenceRef: '采购票据 INV-100' },
      { approvedCountLineRef: 'A-02', productRef: productEstimate, qty: 2, costBasis: 'assessed_estimate', unitCostCents: 9000, costEvidenceRef: '老板估值：近月同款成交', costAssessedAt: '2026-09-20' },
      { approvedCountLineRef: 'A-03', productRef: productUnknown, qty: 3, costBasis: 'unknown' },
      { approvedCountLineRef: 'A-04', productRef: productZero, qty: 1, costBasis: 'zero_cost', unitCostCents: 0, costEvidenceRef: '供应商赠品记录 G-1' },
      { approvedCountLineRef: 'A-05', productRef: productItemEstimate, qty: 1, condition: 'used', costBasis: 'assessed_estimate', unitCostCents: 35000, costEvidenceRef: '老板估值：近月二手成交', costAssessedAt: '2026-09-22' },
    ],
  }))
  assert.equal(formalOpening.status, 200, JSON.stringify(formalOpening.body))
  assert.equal(formalOpening.body.meta.contractVersion, 'v2')

  const actual = (await json(await client.get(`/api/v2/inventory?productRef=${encodeURIComponent(productActual)}`))).body.data
  assert.equal(actual.items[0].totalCostCents, 20000)
  assert.equal(actual.items[0].costKnown, true)
  assert.equal(actual.batches[0].costBasis, 'known_actual')
  assert.equal(actual.batches[0].unitCostCents, 10000)

  const estimate = (await json(await client.get(`/api/v2/inventory?productRef=${encodeURIComponent(productEstimate)}`))).body.data
  assert.equal(estimate.items[0].totalCostCents, null, '估值不能并入实际库存成本总额')
  assert.equal(estimate.items[0].costKnown, false)
  assert.equal(estimate.batches[0].costBasis, 'assessed_estimate')
  assert.equal(estimate.batches[0].unitCostCents, null)
  assert.equal(estimate.batches[0].estimatedUnitCostCents, 9000)
  assert.equal(estimate.batches[0].costAssessedAt, '2026-09-20')

  const unknown = (await json(await client.get(`/api/v2/inventory?productRef=${encodeURIComponent(productUnknown)}`))).body.data
  assert.equal(unknown.items[0].totalCostCents, null)
  assert.equal(unknown.batches[0].costBasis, 'unknown')
  assert.equal(unknown.batches[0].unitCostCents, null)
  assert.equal(unknown.batches[0].estimatedUnitCostCents, null)

  const zero = (await json(await client.get(`/api/v2/inventory?productRef=${encodeURIComponent(productZero)}`))).body.data
  assert.equal(zero.items[0].totalCostCents, 0)
  assert.equal(zero.items[0].costKnown, true)
  assert.equal(zero.batches[0].costBasis, 'zero_cost')
  assert.equal(zero.batches[0].unitCostCents, 0)

  const itemEstimate = (await json(await client.get(`/api/v2/inventory?productRef=${encodeURIComponent(productItemEstimate)}`))).body.data
  assert.equal(itemEstimate.lotItems[0].acquisitionCostCents, null)
  assert.equal(itemEstimate.lotItems[0].assessedEstimateCents, 35000)
  assert.equal(itemEstimate.lotItems[0].costBasis, undefined)
  assert.equal(itemEstimate.lotItems[0].acquisitionCostBasis, 'assessed_estimate')
  assert.equal(itemEstimate.lotItems[0].costKnown, false)

  const storedEstimates = await db.prepare(`SELECT unit_cost_cents, estimated_unit_cost_cents, cost_known, cost_basis,
      approved_count_ref, approved_count_line_ref
    FROM inventory_opening_lines WHERE approved_count_ref = ? ORDER BY approved_count_line_ref`)
    .bind('D10-COUNT-01').all()
  assert.equal(storedEstimates.results.length, 5)
  assert.deepEqual(storedEstimates.results.map((line) => line.approved_count_line_ref), ['A-01', 'A-02', 'A-03', 'A-04', 'A-05'])
  const estimateLine = storedEstimates.results.find((line) => line.approved_count_line_ref === 'A-02')
  assert.equal(estimateLine.unit_cost_cents, null)
  assert.equal(estimateLine.estimated_unit_cost_cents, 9000)
  assert.equal(estimateLine.cost_known, 0)

  const businessProduct = await db.prepare('SELECT id FROM hardware WHERE store_id = ? AND entity_id = ?')
    .bind(ownerA.storeId, productActual).first()
  await db.prepare(`INSERT INTO inventory_movements
      (id, store_id, product_id, qty, from_bucket, source, occurred_at, actor_user_id, request_id)
    VALUES ('d10-first-business-movement', ?, ?, 1, 'available', 'count_adjustment', datetime('now'), ?, 'd10-first-business-movement')`)
    .bind(ownerA.storeId, businessProduct.id, ownerA.userId).run()

  const closed = (await json(await client.get('/api/v2/inventory'))).body.data.openingWindow
  assert.equal(closed.status, 'closed')
  assert.equal(closed.closeReason, 'first_business_movement')
  const cannotReopen = await openWindow(client, 'd10-window-reopen', 2)
  assert.equal(cannotReopen.status, 400)
  assert.match(cannotReopen.body.error.message, /已经开启过|不能重新开启/)
})

test('D10 正式期初：过截止时间后拒绝写入且不能重新开启', async () => {
  const client = formalClients.get(2)
  const productRef = await createProduct(client, 'd10-expired-product')
  const opened = await openWindow(client, 'd10-expired-window', 1)
  assert.equal(opened.status, 200, JSON.stringify(opened.body))
  await db.prepare(`UPDATE inventory_opening_windows
    SET closes_at = datetime('now', '-1 second') WHERE store_id = ?`).bind(ownerB.storeId).run()

  const state = (await json(await client.get('/api/v2/inventory'))).body.data.openingWindow
  assert.equal(state.status, 'expired')
  const lateOpening = await json(await client.post('/api/v2/inventory/openings', {
    requestId: 'd10-opening-after-expiry', approvedCountRef: 'D10-COUNT-LATE',
    lines: [{ approvedCountLineRef: 'L-1', productRef, qty: 1, costBasis: 'unknown' }],
  }))
  assert.equal(lateOpening.body.error.code, 'VALIDATION_ERROR')
  const reopen = await openWindow(client, 'd10-expired-reopen', 1)
  assert.equal(reopen.status, 400)
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM inventory_openings WHERE request_id = ?')
    .bind('d10-opening-after-expiry').first()).n, 0)
})

test('D10 正式期初：已有正式库存流水后不能首次打开窗口', async () => {
  const client = formalClients.get(3)
  const productRef = await createProduct(client, 'd10-before-cutover-product')
  const product = await db.prepare('SELECT id FROM hardware WHERE store_id = ? AND entity_id = ?')
    .bind(ownerC.storeId, productRef).first()
  await db.prepare(`INSERT INTO inventory_movements
      (id, store_id, product_id, qty, to_bucket, source, occurred_at, actor_user_id, request_id)
    VALUES ('d10-preexisting-business-movement', ?, ?, 1, 'available', 'count_adjustment', datetime('now'), ?, 'd10-preexisting-business-movement')`)
    .bind(ownerC.storeId, product.id, ownerC.userId).run()
  const opened = await openWindow(client, 'd10-window-open-too-late', 1)
  assert.equal(opened.status, 400)
  assert.match(opened.body.error.message, /正式库存流水|不能再开启/)
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM inventory_opening_windows WHERE store_id = ?')
    .bind(ownerC.storeId).first()).n, 0)
})

test('D10 隔离预览保留旧格式，拒绝新分类并不回填成本类型', async () => {
  const productRef = await createProduct(previewClient, 'd10-preview-product')
  const oldFormat = await json(await previewClient.post('/api/v2/inventory/openings', {
    requestId: 'd10-preview-old-opening', approvedCountRef: 'D10-PREVIEW-COUNT',
    costBasis: { kind: 'known' }, lines: [{ productRef, qty: 2, unitCostCents: 6000 }],
  }))
  assert.equal(oldFormat.status, 200, JSON.stringify(oldFormat.body))
  const legacyRow = await previewEnv.db.prepare(`SELECT cost_basis, estimated_unit_cost_cents, approved_count_line_ref
    FROM inventory_opening_lines WHERE opening_id = ?`).bind(oldFormat.body.data.entityId).first()
  assert.equal(legacyRow.cost_basis, null)
  assert.equal(legacyRow.estimated_unit_cost_cents, null)
  assert.equal(legacyRow.approved_count_line_ref, null)

  const newFormat = await json(await previewClient.post('/api/v2/inventory/openings', {
    requestId: 'd10-preview-new-opening', approvedCountRef: 'D10-PREVIEW-COUNT-2',
    lines: [{ approvedCountLineRef: 'L-1', productRef: await createProduct(previewClient, 'd10-preview-new-product'), qty: 1, costBasis: 'zero_cost', unitCostCents: 0, costEvidenceRef: '赠与记录' }],
  }))
  assert.equal(newFormat.status, 409)
  assert.equal(newFormat.body.error.code, 'VALIDATION_ERROR')
  const windows = await previewEnv.db.prepare('SELECT COUNT(*) AS n FROM inventory_opening_windows WHERE store_id = ?')
    .bind(previewOwner.storeId).first()
  assert.equal(windows.n, 0, '预览绝不能开启正式窗口')
})
