import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'
import { seedProduct } from './lib/inventory.mjs'

let env, db, client, noPermissionClient, readOnlyClient, productId
const json = async (response) => ({ status: response.status, body: await response.json() })

async function seedRecovered(id, state = 'acquired', inspectionRef = 'inspection-seed') {
  await db.prepare(`INSERT INTO recovery_orders (id, store_id, order_no, seller_snapshot, state, final_acquisition_cents, payable_cents, paid_cents, request_id, created_by, updated_by)
    VALUES (?, 1, ?, '{}', ?, 50000, 0, 50000, ?, 1, 1)`).bind(`recovery-${id}`, `REC-${id}`, state, `seed-${id}`).run()
  await db.prepare(`INSERT INTO stock_items (id, store_id, product_id, asset_code, condition, ownership, availability, location, acquisition_cost_cents, cost_known, inspection_ref, version)
    VALUES (?, 1, ?, ?, 'used', 'store', 'available', 'store', 50000, 1, ?, 1)`).bind(id, productId, `ASSET-${id}`, inspectionRef).run()
  await db.prepare(`INSERT INTO recovery_items (id, store_id, recovery_order_id, stock_item_id, description, request_id)
    VALUES (?, 1, ?, ?, '回收主机', ?)`).bind(`ri-${id}`, `recovery-${id}`, id, `seed-${id}`).run()
}

before(async () => {
  env = await createWorkerEnv(); db = env.db
  const owner = await seedOwner(db)
  client = createClient(env.call, await login(env.call, owner))
  const seedClerk = async (userId, email, permissions) => {
    await db.prepare(`INSERT INTO users (id, email, password_hash, status) VALUES (?, ?, ?, 'active')`)
      .bind(userId, email, await legacyPasswordHash('local-preview-pass')).run()
    const member = await db.prepare(`INSERT INTO store_members (store_id, user_id, status, is_owner, created_by, updated_by)
      VALUES (1, ?, 'active', 0, 1, 1)`).bind(userId).run()
    const role = await db.prepare('INSERT INTO roles (store_id, code, name) VALUES (1, ?, ?)')
      .bind(`b30-role-${userId}`, `B30 角色 ${userId}`).run()
    for (const code of permissions) {
      await db.prepare('INSERT OR IGNORE INTO permissions (code, name) VALUES (?, ?)').bind(code, code).run()
      const permission = await db.prepare('SELECT id FROM permissions WHERE code = ?').bind(code).first()
      await db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)')
        .bind(role.meta.last_row_id, permission.id).run()
    }
    await db.prepare('INSERT INTO member_roles (member_id, role_id) VALUES (?, ?)')
      .bind(member.meta.last_row_id, role.meta.last_row_id).run()
    return { email, password: 'local-preview-pass' }
  }
  noPermissionClient = createClient(env.call, await login(env.call, await seedClerk(71, 'b30-denied@local.test', [])))
  readOnlyClient = createClient(env.call, await login(env.call, await seedClerk(72, 'b30-readonly@local.test', ['inventory/item-view', 'inventory/refurbish'])))
  productId = (await seedProduct(db, { entityId: 'B30-PRODUCT', trackingMode: 'item', name: 'B30 商品' })).hardwareId
})
after(async () => env?.dispose())

test('B30 缺少上架门槛被 INSPECTION_REQUIRED 拦截', async () => {
  await seedRecovered('b30-gate', 'acquired', null)
  const result = await json(await client.post('/api/v2/inventory/items/b30-gate/make-available', {
    requestId: 'b30-gate-list', conditionGrade: 'good', salePriceCents: 89900, disclosureNote: '外壳轻微划痕', dataDisposed: true, warrantyTerm: '12', expectedVersion: 1,
  }))
  assert.equal(result.status, 422); assert.equal(result.body.error.code, 'INSPECTION_REQUIRED')
})

test('B30 非资本化整备不进入件成本；同 requestId 重放不重复入账', async () => {
  await seedRecovered('b30-cost')
  const payload = { requestId: 'b30-cost-expense', category: '清洁', amountCents: 3000, capitalizable: false }
  const first = await json(await client.post('/api/v2/inventory/items/b30-cost/refurbishments', payload))
  const replay = await json(await client.post('/api/v2/inventory/items/b30-cost/refurbishments', payload))
  assert.equal(first.status, 200); assert.equal(replay.status, 200)
  const row = await db.prepare(`SELECT refurbishment_cost_cents FROM stock_items WHERE id='b30-cost'`).first()
  const costs = await db.prepare(`SELECT count(*) AS n FROM refurbishment_costs WHERE stock_item_id='b30-cost'`).first()
  assert.equal(row.refurbishment_cost_cents, 0); assert.equal(costs.n, 1)
})

test('B30 可资本化整备累加件成本，所有门槛齐备后上架', async () => {
  await seedRecovered('b30-ready')
  const repair = await json(await client.post('/api/v2/inventory/items/b30-ready/refurbishments', { requestId: 'b30-ready-repair', category: '更换风扇', amountCents: 8000, capitalizable: true }))
  assert.equal(repair.status, 200)
  const listed = await json(await client.post('/api/v2/inventory/items/b30-ready/make-available', {
    requestId: 'b30-ready-list', conditionGrade: 'excellent', salePriceCents: 89900, disclosureNote: '接口轻微使用痕迹', dataDisposed: true, warrantyTerm: '12', expectedVersion: 2,
  }))
  assert.equal(listed.status, 200)
  const item = await db.prepare(`SELECT refurbishment_cost_cents, sale_price_cents, condition_grade FROM stock_items WHERE id='b30-ready'`).first()
  const order = await db.prepare(`SELECT state FROM recovery_orders WHERE id='recovery-b30-ready'`).first()
  assert.deepEqual(item, { refurbishment_cost_cents: 8000, sale_price_cents: 89900, condition_grade: 'excellent' }); assert.equal(order.state, 'ready_for_sale')
})

test('B30 已拆件回收单不能整备', async () => {
  await seedRecovered('b30-split', 'disassembled')
  const result = await json(await client.post('/api/v2/inventory/items/b30-split/refurbishments', { requestId: 'b30-split-refurb', category: '清洁', amountCents: 100, capitalizable: true }))
  assert.equal(result.status, 422); assert.equal(result.body.error.code, 'OWNERSHIP_INVALID')
})

test('B30 写权限由服务端拦截，拒绝时没有成本或版本副作用', async () => {
  await seedRecovered('b30-denied')
  const result = await json(await noPermissionClient.post('/api/v2/inventory/items/b30-denied/refurbishments', {
    requestId: 'b30-denied-refurb', category: '清洁', amountCents: 1000, capitalizable: true,
  }))
  assert.equal(result.status, 403)
  assert.equal(result.body.error.code, 'PERMISSION_DENIED')
  const costs = await db.prepare("SELECT COUNT(*) AS n FROM refurbishment_costs WHERE stock_item_id='b30-denied'").first()
  const item = await db.prepare("SELECT refurbishment_cost_cents, version FROM stock_items WHERE id='b30-denied'").first()
  assert.equal(costs.n, 0)
  assert.equal(item.refurbishment_cost_cents, null)
  assert.equal(item.version, 1)
})

test('B30 财务付款引用不存在或不属于付款流水时拒绝且不留整备记录', async () => {
  await seedRecovered('b30-invalid-payment-ref')
  await db.prepare(`INSERT INTO cash_entries
    (id, store_id, direction, amount_cents, method, counterparty_kind, counterparty_ref, purpose,
     allocation_type, allocation_id, sale_order_id, occurred_at, remark, reversal_of, request_id, created_by)
    VALUES ('cash-b30-inbound-ref', 1, 'in', 5000, 'cash', 'supplier', '维修档口', 'purchase',
      'purchase', 'purchase-b30-inbound-ref', NULL, '2026-09-25T00:00:00.000Z', '付款冲销入账', NULL, 'cash-b30-inbound-ref-request', 1)`).run()
  for (const [requestId, paymentEntryRef] of [
    ['b30-invalid-payment-ref-missing', 'cash-b30-does-not-exist'],
    ['b30-invalid-payment-ref-inbound', 'cash-b30-inbound-ref'],
  ]) {
    const result = await json(await client.post('/api/v2/inventory/items/b30-invalid-payment-ref/refurbishments', {
      requestId, category: '更换风扇', amountCents: 5000, capitalizable: true,
      paymentEntryRef, evidenceRef: '发票-2026-0925',
    }))
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'VALIDATION_ERROR')
  }
  const malformed = await json(await client.post('/api/v2/inventory/items/b30-invalid-payment-ref/refurbishments', {
    requestId: 'b30-invalid-payment-ref-object', category: '更换风扇', amountCents: 5000, capitalizable: true,
    paymentEntryRef: { id: 'cash-b30-inbound-ref' },
  }))
  assert.equal(malformed.status, 400)
  assert.equal(malformed.body.error.code, 'VALIDATION_ERROR')
  const costs = await db.prepare("SELECT COUNT(*) AS n FROM refurbishment_costs WHERE stock_item_id='b30-invalid-payment-ref'").first()
  const item = await db.prepare("SELECT refurbishment_cost_cents, version FROM stock_items WHERE id='b30-invalid-payment-ref'").first()
  assert.equal(costs.n, 0)
  assert.equal(item.refurbishment_cost_cents, null)
  assert.equal(item.version, 1)
})

test('B30 付款流水与凭据引用可追溯，且不伪造第二笔现金流水并受成本权限保护', async () => {
  await seedRecovered('b30-finance')
  await db.prepare(`INSERT INTO cash_entries
    (id, store_id, direction, amount_cents, method, counterparty_kind, counterparty_ref, purpose,
     allocation_type, allocation_id, sale_order_id, occurred_at, remark, reversal_of, request_id, created_by)
    VALUES ('cash-b30-ref', 1, 'out', 5000, 'cash', 'supplier', '维修档口', 'purchase',
      'purchase', 'purchase-b30-ref', NULL, '2026-09-25T00:00:00.000Z', '实际付款', NULL, 'cash-b30-ref-request', 1)`).run()
  const cashCount = (await db.prepare('SELECT COUNT(*) AS n FROM cash_entries').first()).n
  const recorded = await json(await client.post('/api/v2/inventory/items/b30-finance/refurbishments', {
    requestId: 'b30-finance-refurb', category: '更换风扇', amountCents: 5000, capitalizable: true,
    paymentEntryRef: 'cash-b30-ref', evidenceRef: '发票-2026-0915',
  }))
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body))
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM cash_entries').first()).n, cashCount)

  const detail = await json(await client.get('/api/v2/inventory/items/b30-finance'))
  assert.equal(detail.status, 200)
  assert.deepEqual(detail.body.data.refurbishmentCosts.map((cost) => ({
    amountCents: cost.amountCents, capitalizable: cost.capitalizable,
    paymentEntryRef: cost.paymentEntryRef, evidenceRef: cost.evidenceRef,
  })), [{ amountCents: 5000, capitalizable: true, paymentEntryRef: 'cash-b30-ref', evidenceRef: '发票-2026-0915' }])

  const readOnly = await json(await readOnlyClient.get('/api/v2/inventory/items/b30-finance'))
  assert.equal(readOnly.status, 200)
  assert.equal(Object.hasOwn(readOnly.body.data, 'refurbishmentCosts'), false)
  assert.equal(Object.hasOwn(readOnly.body.data.item, 'acquisitionCostCents'), false)
})

test('B30 并发登记两笔独立整备均保留，成本累计没有丢写', async () => {
  await seedRecovered('b30-race')
  const [left, right] = await Promise.all([
    client.post('/api/v2/inventory/items/b30-race/refurbishments', {
      requestId: 'b30-race-left', category: '清洁', amountCents: 2000, capitalizable: true,
    }).then(json),
    client.post('/api/v2/inventory/items/b30-race/refurbishments', {
      requestId: 'b30-race-right', category: '换电池', amountCents: 9000, capitalizable: true,
    }).then(json),
  ])
  const results = [left, right]
  assert.deepEqual(results.map((result) => result.status), [200, 200])
  const costs = await db.prepare("SELECT COUNT(*) AS n, SUM(amount_cents) AS total FROM refurbishment_costs WHERE stock_item_id='b30-race'").first()
  const item = await db.prepare("SELECT refurbishment_cost_cents, version FROM stock_items WHERE id='b30-race'").first()
  assert.equal(costs.n, 2)
  assert.equal(item.refurbishment_cost_cents, costs.total)
  assert.equal(item.refurbishment_cost_cents, 11_000)
  assert.equal(item.version, 3)
})
