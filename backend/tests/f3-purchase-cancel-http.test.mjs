/**
 * F3 · B37 取消采购 HTTP 回归：未到数量可取消、已到货 / 拒收不可再取消、
 * 采购恒等式（ordered = received + rejected + cancelled + pending）、
 * 与 B33 采购付款的「应付基数按未取消数量」联动、净付款冲突、权限与跨店。
 *
 * 契约依据：
 *   actions.json B37（inventory/purchase-cancel）—— operations / errors / notes 四条
 *   objects.json Purchase.derivedFields（pendingQty / receiptProgress）
 *   errors.json PURCHASE_CANCEL_EXCEEDED（422）、PURCHASE_PAYMENT_CONFLICT（409）
 *
 * 只使用本机内存 D1 + 真实 Worker 入口；不连接远端、不部署、不读生产数据。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'
import { seedProduct } from './lib/inventory.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER_A = { email: 'b37-owner-a@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: 'B37 门店甲' }
const OWNER_B = { email: 'b37-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: 'B37 门店乙' }

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
      await db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)')
        .bind(role.meta.last_row_id, permission.id).run()
    }
    await db.prepare('INSERT INTO member_roles (member_id, role_id) VALUES (?, ?)')
      .bind(memberId, role.meta.last_row_id).run()
  }
  return { email, password: PASSWORD }
}

const scalar = async (sql, ...params) => {
  const row = await db.prepare(sql).bind(...params).first()
  return row ? Object.values(row)[0] : null
}

async function createPurchase(client, requestId, productRef, qtyOrdered, unitCostCents) {
  return json(await client.post('/api/v2/inventory/purchases', {
    requestId,
    supplierName: 'B37 供应商',
    lines: [{ productRef, nameSnapshot: 'B37 采购件', qtyOrdered, unitCostCents }],
  }))
}

async function receive(client, requestId, purchaseId, purchaseLineId, productRef, qtyReceived) {
  return json(await client.post('/api/v2/inventory/receipts', {
    requestId,
    purchaseId,
    lines: [{ purchaseLineId, productRef, qtyReceived, disposition: 'available' }],
  }))
}

async function cancel(client, purchaseId, requestId, lines, reason = 'supplier_delay', note = '') {
  return json(await client.post(`/api/v2/inventory/purchases/${encodeURIComponent(purchaseId)}/cancel`, {
    requestId,
    lines,
    reason,
    note,
  }))
}

async function pay(client, requestId, sourceDocument, amountCents) {
  return json(await client.post('/api/v2/finance/payments', {
    requestId,
    sourceDocument,
    amountCents,
    method: 'bank',
  }))
}

async function detail(client, purchaseId) {
  return json(await client.get(`/api/v2/inventory/purchases/${encodeURIComponent(purchaseId)}`))
}

/** 建一张单行采购并取出采购行 id，减少每个用例的样板。 */
async function freshPurchase(entityId, name, qtyOrdered, unitCostCents = 12_000) {
  const product = await seedProduct(db, { entityId, name, trackingMode: 'quantity' })
  const created = await createPurchase(owner, `${entityId}-po`, product.entityId, qtyOrdered, unitCostCents)
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const purchaseId = created.body.data.entityId
  const before = await detail(owner, purchaseId)
  return { product, purchaseId, lineId: before.body.data.lines[0].id, before: before.body.data }
}

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER_A)
  await seedOwner(db, OWNER_B)
  owner = createClient(env.call, await login(env.call, OWNER_A))
  otherStoreOwner = createClient(env.call, await login(env.call, OWNER_B))
  noPermissionClerk = createClient(env.call, await login(env.call, await seedClerk({
    userId: 40, email: 'b37-no-permission@local.test',
  })))
  legacyClerk = createClient(env.call, await login(env.call, await seedClerk({
    userId: 41, email: 'b37-legacy@local.test', permissions: ['library/edit', 'library/view'],
  })))
})

after(async () => {
  await env?.dispose()
})

// ─────────────────────── 1. 取消未到数量与恒等式 ───────────────────────

test('B37：取消未到数量——恒等式、进度派生、不改写订购量与幂等重放', async () => {
  const { purchaseId, lineId, before } = await freshPurchase('b37-basic', 'B37 基础件', 5)
  assert.equal(before.purchase.orderedQty, 5)
  assert.equal(before.purchase.pendingQty, 5)
  assert.equal(before.purchase.payableCents, 60_000)

  const cancelled = await cancel(owner, purchaseId, 'b37-basic-cancel', [{ purchaseLineId: lineId, qty: 2 }], 'supplier_delay', '档口缺货')
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
  assert.equal(cancelled.body.data.effects.cancelledQty, 2)
  assert.equal(cancelled.body.data.effects.pendingQty, 3)

  const after = await detail(owner, purchaseId)
  assert.equal(after.body.data.purchase.cancelledQty, 2)
  assert.equal(after.body.data.purchase.pendingQty, 3, '在途 = 订购 5 − 已取消 2')
  assert.equal(after.body.data.purchase.progress, '尚未到货', '还有 3 件在途，不是「已取消」')
  assert.equal(after.body.data.lines[0].cancelledQty, 2)
  assert.equal(after.body.data.lines[0].qtyOrdered, 5, '取消不改写订购量，历史必须可回溯')
  assert.equal(after.body.data.purchase.payableCents, 36_000, 'B33 应付基数按未取消数量收缩：剩 3 件')

  const listed = await json(await owner.get('/api/v2/inventory/purchases'))
  const row = listed.body.data.purchases.find((item) => item.id === purchaseId)
  assert.equal(row.cancelledQty, 2)
  assert.equal(row.pendingQty, 3)
  assert.equal(row.payableCents, 36_000)

  // 台账落事件、订购量不动、且取消不是库存动作
  assert.equal(await scalar('SELECT COUNT(*) FROM purchase_cancellations WHERE store_id = 1 AND purchase_id = ?', purchaseId), 1)
  assert.equal(await scalar('SELECT qty_cancelled FROM purchase_cancellations WHERE store_id = 1 AND purchase_id = ?', purchaseId), 2)
  assert.equal(await scalar('SELECT reason FROM purchase_cancellations WHERE store_id = 1 AND purchase_id = ?', purchaseId), 'supplier_delay')
  assert.equal(await scalar('SELECT qty_ordered FROM purchase_lines WHERE store_id = 1 AND id = ?', lineId), 5)
  assert.equal(await scalar('SELECT COUNT(*) FROM inventory_movements WHERE store_id = 1'), 0, '取消只减在途，不写任何库存流水')

  // 幂等：同 requestId 同载荷 → 复用原结果，不重复落台账
  const retry = await cancel(owner, purchaseId, 'b37-basic-cancel', [{ purchaseLineId: lineId, qty: 2 }], 'supplier_delay', '档口缺货')
  assert.equal(retry.status, 200, JSON.stringify(retry.body))
  assert.equal(retry.body.data.operationId, cancelled.body.data.operationId)
  assert.equal(await scalar('SELECT COUNT(*) FROM purchase_cancellations WHERE store_id = 1 AND purchase_id = ?', purchaseId), 1)

  // 同 requestId 改载荷 → 409
  const mismatch = await cancel(owner, purchaseId, 'b37-basic-cancel', [{ purchaseLineId: lineId, qty: 1 }], 'supplier_delay', '档口缺货')
  assert.equal(mismatch.status, 409, JSON.stringify(mismatch.body))
  assert.equal(mismatch.body.error.code, 'IDEMPOTENCY_MISMATCH')
})

// ─────────────────────── 2. 已处置数量不可再取消 ───────────────────────

test('B37：已到货 / 拒收的数量不能再取消；取消不动已入库可用量', async () => {
  const { product, purchaseId, lineId } = await freshPurchase('b37-received', 'B37 已到货件', 4)

  const receipt = await receive(owner, 'b37-received-r1', purchaseId, lineId, product.entityId, 2)
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body))

  const mid = await detail(owner, purchaseId)
  assert.equal(mid.body.data.purchase.receivedQty, 2)
  assert.equal(mid.body.data.purchase.pendingQty, 2)
  assert.equal(mid.body.data.purchase.progress, '部分到货')

  // 可取消只有 2 件（4 − 已到 2），要取消 3 件必须被拒
  const over = await cancel(owner, purchaseId, 'b37-received-over', [{ purchaseLineId: lineId, qty: 3 }])
  assert.equal(over.status, 422, JSON.stringify(over.body))
  assert.equal(over.body.error.code, 'PURCHASE_CANCEL_EXCEEDED')

  const ok = await cancel(owner, purchaseId, 'b37-received-ok', [{ purchaseLineId: lineId, qty: 2 }], 'customer_cancelled')
  assert.equal(ok.status, 200, JSON.stringify(ok.body))

  const done = await detail(owner, purchaseId)
  assert.equal(done.body.data.purchase.cancelledQty, 2)
  assert.equal(done.body.data.purchase.pendingQty, 0)
  assert.equal(done.body.data.purchase.progress, '到货完成')

  // 已经到货的 2 件始终留在可用量里（取消只动在途）
  assert.equal(await scalar(
    'SELECT available_qty FROM stock_balances WHERE store_id = 1 AND product_id = ? AND location_id = ?',
    product.hardwareId,
    'store',
  ), 2)

  // 一件都不剩可取消，再取消就超
  const empty = await cancel(owner, purchaseId, 'b37-received-empty', [{ purchaseLineId: lineId, qty: 1 }])
  assert.equal(empty.status, 422, JSON.stringify(empty.body))
  assert.equal(empty.body.error.code, 'PURCHASE_CANCEL_EXCEEDED')
})

// ─────────────── 3. 与 B33 采购付款的应付基数联动 ───────────────

test('B37：取消收缩应付基数（不能给已取消数量付款）；已有净付款则拒绝取消', async () => {
  const { purchaseId, lineId } = await freshPurchase('b37-payable', 'B37 应付联动件', 4, 5_000)
  assert.equal((await detail(owner, purchaseId)).body.data.purchase.payableCents, 20_000)

  const cancelled = await cancel(owner, purchaseId, 'b37-payable-cancel', [{ purchaseLineId: lineId, qty: 1 }])
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
  const afterCancel = await detail(owner, purchaseId)
  assert.equal(afterCancel.body.data.purchase.payableCents, 15_000, '4 件里取消 1 件 → 应付只剩 3 件')

  // 契约 B37 notes 第 4 条：B33 应付基数按未取消数量，不能为已取消数量付款。
  const over = await pay(owner, 'b37-payable-over', `purchase:${purchaseId}`, 20_000)
  assert.equal(over.status, 422, JSON.stringify(over.body))
  assert.equal(over.body.error.code, 'BALANCE_EXCEEDED')

  const fine = await pay(owner, 'b37-payable-ok', `purchase:${purchaseId}`, 15_000)
  assert.equal(fine.status, 200, JSON.stringify(fine.body))

  // 已有净付款 → 本首版不把付款冲销并入取消，直接拒绝（409），且不落台账
  const blocked = await cancel(owner, purchaseId, 'b37-payable-blocked', [{ purchaseLineId: lineId, qty: 1 }])
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body))
  assert.equal(blocked.body.error.code, 'PURCHASE_PAYMENT_CONFLICT')
  assert.equal(await scalar('SELECT COUNT(*) FROM purchase_cancellations WHERE store_id = 1 AND purchase_id = ?', purchaseId), 1)
})

test('B33/B34/B37：多笔采购付款逐笔冲销，净付款归零后才能取消；原流水均保留', async () => {
  const { purchaseId, lineId } = await freshPurchase('b37-reversal-flow', '冲销后取消件', 3, 12_000)
  assert.equal((await pay(owner, 'b37-reversal-pay-1', `purchase:${purchaseId}`, 12_000)).status, 200)
  assert.equal((await pay(owner, 'b37-reversal-pay-2', `purchase:${purchaseId}`, 12_000)).status, 200)

  const originals = []
  for (const requestId of ['b37-reversal-pay-1', 'b37-reversal-pay-2']) {
    const entry = await db.prepare('SELECT id FROM cash_entries WHERE store_id = 1 AND request_id = ?').bind(requestId).first()
    assert.ok(entry?.id)
    originals.push(entry.id)
  }

  const reverse = async (entryId, requestId) => json(await owner.post(
    `/api/v2/finance/entries/${encodeURIComponent(entryId)}/reverse`,
    { requestId, reason: '供应商已实际退回预付款', correctionRef: `supplier-refund-${requestId}` },
  ))
  const firstReverse = await reverse(originals[0], 'b37-reversal-r1')
  assert.equal(firstReverse.status, 200, JSON.stringify(firstReverse.body))
  const firstRetry = await reverse(originals[0], 'b37-reversal-r1')
  assert.equal(firstRetry.status, 200)
  assert.equal(firstRetry.body.data.operationId, firstReverse.body.data.operationId)

  const stillPaid = await detail(owner, purchaseId)
  assert.equal(stillPaid.body.data.purchase.paidCents, 12_000)
  const blocked = await cancel(owner, purchaseId, 'b37-reversal-blocked', [{ purchaseLineId: lineId, qty: 1 }])
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body))
  assert.equal(blocked.body.error.code, 'PURCHASE_PAYMENT_CONFLICT')

  const secondReverse = await reverse(originals[1], 'b37-reversal-r2')
  assert.equal(secondReverse.status, 200, JSON.stringify(secondReverse.body))
  const zeroNet = await detail(owner, purchaseId)
  assert.equal(zeroNet.body.data.purchase.paidCents, 0)
  assert.equal(zeroNet.body.data.purchase.remainingPayableCents, 36_000)

  const cancelled = await cancel(owner, purchaseId, 'b37-reversal-cancel', [{ purchaseLineId: lineId, qty: 1 }])
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
  const after = await detail(owner, purchaseId)
  assert.equal(after.body.data.purchase.cancelledQty, 1)
  assert.equal(after.body.data.purchase.payableCents, 24_000)
  assert.equal(after.body.data.purchase.paidCents, 0)

  const rows = await db.prepare(`SELECT direction, amount_cents, reversal_of FROM cash_entries
    WHERE store_id = 1 AND allocation_type = 'purchase' AND allocation_id = ? ORDER BY created_at, id`).bind(purchaseId).all()
  assert.equal(rows.results.length, 4)
  assert.equal(rows.results.filter((row) => row.direction === 'out' && row.reversal_of === null).length, 2)
  assert.equal(rows.results.filter((row) => row.direction === 'in' && row.reversal_of !== null).length, 2)
  assert.ok(rows.results.filter((row) => row.direction === 'in').every((row) => row.amount_cents === 12_000))
  assert.equal(await scalar('SELECT SUM(qty_cancelled) FROM purchase_cancellations WHERE store_id = 1 AND purchase_id = ?', purchaseId), 1)
})

test('B37 并发取消同一采购行的超量请求只允许一个提交', async () => {
  const { purchaseId, lineId } = await freshPurchase('b37-cancel-race', '并发取消件', 3)
  const [left, right] = await Promise.all([
    cancel(owner, purchaseId, 'b37-cancel-race-left', [{ purchaseLineId: lineId, qty: 2 }]),
    cancel(owner, purchaseId, 'b37-cancel-race-right', [{ purchaseLineId: lineId, qty: 2 }]),
  ])
  const results = [left, right]
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 422])
  const rejected = results.find((result) => result.status === 422)
  assert.equal(rejected.body.error.code, 'PURCHASE_CANCEL_EXCEEDED')
  const current = await detail(owner, purchaseId)
  assert.equal(current.body.data.purchase.cancelledQty, 2)
  assert.equal(current.body.data.purchase.pendingQty, 1)
  assert.equal(await scalar('SELECT COUNT(*) FROM purchase_cancellations WHERE store_id = 1 AND purchase_id = ?', purchaseId), 1)
})

// ─────────────────────── 4. 权限、跨店与入参校验 ───────────────────────

test('B37：无权限 403、旧码 library/edit 放行、跨店 404 与入参校验', async () => {
  const { purchaseId, lineId } = await freshPurchase('b37-auth', 'B37 权限件', 3)

  const denied = await cancel(noPermissionClerk, purchaseId, 'b37-auth-denied', [{ purchaseLineId: lineId, qty: 1 }])
  assert.equal(denied.status, 403, JSON.stringify(denied.body))
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED')

  const crossStore = await cancel(otherStoreOwner, purchaseId, 'b37-auth-cross', [{ purchaseLineId: lineId, qty: 1 }])
  assert.equal(crossStore.status, 404, JSON.stringify(crossStore.body))
  assert.equal(crossStore.body.error.code, 'ENTITY_NOT_FOUND')

  const badReason = await cancel(owner, purchaseId, 'b37-auth-reason', [{ purchaseLineId: lineId, qty: 1 }], 'because')
  assert.equal(badReason.status, 400, JSON.stringify(badReason.body))
  assert.equal(badReason.body.error.code, 'VALIDATION_ERROR')

  const badQty = await cancel(owner, purchaseId, 'b37-auth-qty', [{ purchaseLineId: lineId, qty: 0 }])
  assert.equal(badQty.status, 400, JSON.stringify(badQty.body))

  const dupLine = await cancel(owner, purchaseId, 'b37-auth-dup', [
    { purchaseLineId: lineId, qty: 1 },
    { purchaseLineId: lineId, qty: 1 },
  ])
  assert.equal(dupLine.status, 400, JSON.stringify(dupLine.body))

  const emptyLines = await cancel(owner, purchaseId, 'b37-auth-empty', [])
  assert.equal(emptyLines.status, 400, JSON.stringify(emptyLines.body))

  // 旧码兼容：library/edit 视同 inventory/purchase-cancel（access.ts LEGACY_EQUIVALENT）
  const legacyAllowed = await cancel(legacyClerk, purchaseId, 'b37-auth-legacy', [{ purchaseLineId: lineId, qty: 1 }], 'other')
  assert.equal(legacyAllowed.status, 200, JSON.stringify(legacyAllowed.body))
  assert.equal((await detail(owner, purchaseId)).body.data.purchase.cancelledQty, 1)

  // 入参被拒的这几次不能留下任何台账
  assert.equal(await scalar('SELECT COUNT(*) FROM purchase_cancellations WHERE store_id = 1 AND purchase_id = ?', purchaseId), 1)
})
