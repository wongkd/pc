/**
 * F3 · 采购付款 HTTP 回归：B33 purchase:<id>、采购应付读模型、老板权限、幂等与真实资金流水。
 *
 * 只使用本机内存 D1 + 真实 Worker 入口；不连接远端、不部署、不读生产数据。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'
import { seedProduct } from './lib/inventory.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER = { email: 'f3-owner@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: 'F3 付款门店' }
const OWNER_B = { email: 'f3-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: 'F3 另一门店' }

let env
let db
let owner
let otherStoreOwner
let noPermissionClerk
let legacyClerk

const json = async (response) => ({ status: response.status, body: await response.json() })

async function seedClerk({ userId, email, permissions = [] }) {
  await db.prepare(`INSERT INTO users (id, email, password_hash, status) VALUES (?, ?, ?, 'active')`)
    .bind(userId, email, await legacyPasswordHash(PASSWORD)).run()
  const member = await db.prepare(`INSERT INTO store_members (store_id, user_id, status, is_owner, created_by, updated_by)
    VALUES (1, ?, 'active', 0, 1, 1)`).bind(userId).run()
  const memberId = member.meta.last_row_id
  if (permissions.length) {
    const role = await db.prepare('INSERT INTO roles (store_id, code, name) VALUES (1, ?, ?)')
      .bind(`role-${userId}`, `角色 ${userId}`).run()
    for (const code of permissions) {
      await db.prepare('INSERT OR IGNORE INTO permissions (code, name) VALUES (?, ?)').bind(code, code).run()
      const permission = await db.prepare('SELECT id FROM permissions WHERE code = ?').bind(code).first()
      await db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)')
        .bind(role.meta.last_row_id, permission.id).run()
    }
    await db.prepare('INSERT INTO member_roles (member_id, role_id) VALUES (?, ?)')
      .bind(memberId, role.meta.last_row_id).run()
  }
  return { email, password: PASSWORD }
}

async function createPurchase(client, requestId, productRef, qtyOrdered, unitCostCents) {
  return json(await client.post('/api/v2/inventory/purchases', {
    requestId,
    supplierName: 'F3 供应商',
    lines: [{ productRef, nameSnapshot: 'F3 测试件', qtyOrdered, unitCostCents }],
  }))
}

async function detail(client, purchaseId) {
  return json(await client.get(`/api/v2/inventory/purchases/${encodeURIComponent(purchaseId)}`))
}

async function pay(client, requestId, sourceDocument, amountCents, extra = {}) {
  return json(await client.post('/api/v2/finance/payments', {
    requestId,
    sourceDocument,
    amountCents,
    method: 'bank',
    ...extra,
  }))
}

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER)
  await seedOwner(db, OWNER_B)
  owner = createClient(env.call, await login(env.call, OWNER))
  otherStoreOwner = createClient(env.call, await login(env.call, OWNER_B))
  noPermissionClerk = createClient(env.call, await login(env.call, await seedClerk({
    userId: 30, email: 'f3-no-permission@local.test',
  })))
  legacyClerk = createClient(env.call, await login(env.call, await seedClerk({
    userId: 31, email: 'f3-legacy@local.test', permissions: ['quote/edit', 'quote/view'],
  })))
})

after(async () => {
  await env?.dispose()
})

test('F3：采购应付、部分付款、幂等、超付拒绝与老板权限', async () => {
  const product = await seedProduct(db, { entityId: 'f3-payable-product', name: 'F3 采购付款测试件', trackingMode: 'quantity' })

  const beforeOverview = await json(await owner.get('/api/v2/finance/overview'))
  assert.equal(beforeOverview.status, 200, JSON.stringify(beforeOverview.body))
  assert.equal(beforeOverview.body.data.payable.totalCents, 0)

  const created = await createPurchase(owner, 'f3main-purchase', product.entityId, 3, 10_000)
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const purchaseId = created.body.data.entityId

  const initial = await detail(owner, purchaseId)
  assert.equal(initial.status, 200, JSON.stringify(initial.body))
  assert.equal(initial.body.data.purchase.payableCents, 30_000)
  assert.equal(initial.body.data.purchase.paidCents, 0)
  assert.equal(initial.body.data.purchase.remainingPayableCents, 30_000)

  const listed = await json(await owner.get('/api/v2/inventory/purchases'))
  const listedRow = listed.body.data.purchases.find((row) => row.id === purchaseId)
  assert.equal(listedRow.payableCents, 30_000)
  assert.equal(listedRow.remainingPayableCents, 30_000)

  const denied = await pay(noPermissionClerk, 'f3-denied', `purchase:${purchaseId}`, 1_000)
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED')
  const legacyDenied = await pay(legacyClerk, 'f3-legacy-denied', `purchase:${purchaseId}`, 1_000)
  assert.equal(legacyDenied.status, 403)
  assert.equal(legacyDenied.body.error.code, 'PERMISSION_DENIED')

  const part = await pay(owner, 'f3-pay-part', `purchase:${purchaseId}`, 12_000, { remark: 'F3 部分付款' })
  if (part.status !== 200) {
    console.log('F3 debug', JSON.stringify(await db.prepare('SELECT request_id, error_code, diagnostic FROM operation_failures ORDER BY id DESC LIMIT 3').all()))
  }
  assert.equal(part.status, 200, JSON.stringify(part.body))
  assert.equal(part.body.data.effects.payableCents, 30_000)
  assert.equal(part.body.data.effects.paidCents, 12_000)
  assert.equal(part.body.data.effects.remainingPayableCents, 18_000)

  const retry = await pay(owner, 'f3-pay-part', `purchase:${purchaseId}`, 12_000, { remark: 'F3 部分付款' })
  assert.equal(retry.status, 200, JSON.stringify(retry.body))
  assert.equal(retry.body.data.operationId, part.body.data.operationId)
  const mismatch = await pay(owner, 'f3-pay-part', `purchase:${purchaseId}`, 13_000)
  assert.equal(mismatch.status, 409, JSON.stringify(mismatch.body))
  assert.equal(mismatch.body.error.code, 'IDEMPOTENCY_MISMATCH')

  // BALANCE_EXCEEDED 在契约 errors.json 里钉死为 422（与 B08 超收、B09 超退同一口径），不是 400。
  const over = await pay(owner, 'f3-pay-over', `purchase:${purchaseId}`, 18_001)
  assert.equal(over.status, 422, JSON.stringify(over.body))
  assert.equal(over.body.error.code, 'BALANCE_EXCEEDED')

  const rest = await pay(owner, 'f3-pay-rest', { kind: 'purchase', id: purchaseId }, 18_000)
  assert.equal(rest.status, 200, JSON.stringify(rest.body))
  const paid = await detail(owner, purchaseId)
  assert.equal(paid.body.data.purchase.paidCents, 30_000)
  assert.equal(paid.body.data.purchase.remainingPayableCents, 0)

  const entries = await json(await owner.get('/api/v2/finance/entries?direction=out&limit=50'))
  const purchaseEntries = entries.body.data.entries.filter((entry) => entry.allocationId === purchaseId)
  assert.equal(purchaseEntries.length, 2)
  assert.ok(purchaseEntries.every((entry) => entry.direction === 'out' && entry.purpose === 'purchase'))
  assert.deepEqual(purchaseEntries.map((entry) => entry.amountCents).sort((a, b) => a - b), [12_000, 18_000])

  const afterOverview = await json(await owner.get('/api/v2/finance/overview'))
  assert.equal(afterOverview.body.data.payable.totalCents, 0)
  assert.equal(afterOverview.body.data.payable.purchaseCount, 0)

  const crossStore = await pay(otherStoreOwner, 'f3-cross-store', `purchase:${purchaseId}`, 1)
  assert.equal(crossStore.status, 404)
})

test('F3：成本未知的采购单不得登记付款', async () => {
  const product = await seedProduct(db, { entityId: 'f3-unknown-cost', name: 'F3 未知成本件', trackingMode: 'quantity' })
  const created = await createPurchase(owner, 'f3unknown-purchase', product.entityId, 1, undefined)
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const purchaseId = created.body.data.entityId
  const result = await pay(owner, 'f3-pay-unknown', `purchase:${purchaseId}`, 1)
  assert.equal(result.status, 400, JSON.stringify(result.body))
  assert.equal(result.body.error.code, 'VALIDATION_ERROR')
  assert.match(result.body.error.message, /成本未知/)
})

test('F3 并发采购付款不会突破应付余额，只有一笔流水落账', async () => {
  const product = await seedProduct(db, { entityId: 'f3-payment-race', name: 'F3 并发付款件', trackingMode: 'quantity' })
  const created = await createPurchase(owner, 'f3-race-purchase', product.entityId, 1, 10_000)
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const purchaseId = created.body.data.entityId

  const [left, right] = await Promise.all([
    pay(owner, 'f3-race-pay-left', `purchase:${purchaseId}`, 6_000),
    pay(owner, 'f3-race-pay-right', `purchase:${purchaseId}`, 6_000),
  ])
  const results = [left, right]
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 422])
  const rejected = results.find((result) => result.status === 422)
  assert.equal(rejected.body.error.code, 'BALANCE_EXCEEDED')

  const current = await detail(owner, purchaseId)
  assert.equal(current.body.data.purchase.paidCents, 6_000)
  assert.equal(current.body.data.purchase.remainingPayableCents, 4_000)
  const entries = await db.prepare(`SELECT COUNT(*) AS n, SUM(amount_cents) AS total FROM cash_entries
    WHERE store_id = 1 AND purpose = 'purchase' AND allocation_id = ?`).bind(purchaseId).first()
  assert.equal(entries.n, 1)
  assert.equal(entries.total, 6_000)
})
