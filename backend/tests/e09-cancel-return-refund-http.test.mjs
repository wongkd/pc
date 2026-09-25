/**
 * E09 · 取消、退货、退款、欠款交付与账本的 HTTP 接线（/api/v2/sales/orders*、/sales/returns*、/finance/*）。
 *
 * 契约依据：
 *   actions.json B09（POST /sales/orders/:id/credit-approval，sales/order-credit-approval，owner_only）
 *                B11（POST /sales/orders/:id/cancel，sales/order-edit）
 *                B17（POST /sales/returns，sales/return-create）
 *                B43（POST /sales/returns/:id/approve-credit，sales/refund，owner_only）
 *                B18（POST /sales/orders/:id/refunds，sales/refund，owner_only）
 *                B34（POST /finance/entries/:id/reverse，finance/reverse，owner_only）
 *   readActions R12（GET /finance/overview、/finance/entries，finance/view）
 *   objects.json ReturnRecord / Refund / CashEntry
 *   enums.json  CreditState（pending / approved）/ FinancialDisposition
 *   money-rules.json refundableCashCents / partialReturn / reversalPolicy
 *
 * 覆盖：
 *   1. 入口鉴权：owner_only 动作（欠款批准/退款/反冲）无权限店员 403；旧码店员可读账本、可取消；
 *   2. B09 欠款批准：未成交/已结清被拒；批准快照欠款余额；B10 挂凭证交付 credit_approved；
 *   3. B11 取消：释放占用、return_credit 全额冲销、余额转门店待退、幂等复用；
 *   4. B17 退货：只对已交付开放、跨单实物被拒、累计贷项超总额 422、sold→quarantine；
 *   5. B43 批准贷项：pending→approved 才计入应退；
 *   6. B18 退款：只对 approved 贷项退款、超上限 422、cash_net 减少 + out 流水；
 *   7. B34 反冲：反向分录 + cash_net 反向调整、防重复反冲、反冲笔不能再反冲；
 *   8. 账本读：overview 汇总与 entries 列表方向过滤。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'
import { seedProduct } from './lib/inventory.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER = { email: 'e09-owner@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: '装机门店' }
const OWNER_B = { email: 'e09-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: '别家门店' }

let env
let db
let a
let b
let clerk
let legacyClerk

const json = async (response) => ({ status: response.status, body: await response.json() })

async function seedClerk({ userId, email, storeId = 1, permissions = [] }) {
  await db.prepare(`INSERT INTO users (id, email, password_hash, status) VALUES (?, ?, ?, 'active')`)
    .bind(userId, email, await legacyPasswordHash(PASSWORD)).run()
  const member = await db.prepare(`INSERT INTO store_members (store_id, user_id, status, is_owner, created_by, updated_by)
    VALUES (?, ?, 'active', 0, 1, 1)`).bind(storeId, userId).run()
  const memberId = member.meta.last_row_id
  if (permissions.length) {
    const role = await db.prepare('INSERT INTO roles (store_id, code, name) VALUES (?, ?, ?)')
      .bind(storeId, `role-${userId}`, `角色 ${userId}`).run()
    for (const code of permissions) {
      await db.prepare('INSERT OR IGNORE INTO permissions (code, name) VALUES (?, ?)').bind(code, code).run()
      const permission = await db.prepare('SELECT id FROM permissions WHERE code = ?').bind(code).first()
      await db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)')
        .bind(role.meta.last_row_id, permission.id).run()
    }
    await db.prepare('INSERT INTO member_roles (member_id, role_id) VALUES (?, ?)')
      .bind(memberId, role.meta.last_row_id).run()
  }
  return { email, password: PASSWORD, memberId }
}

const scalar = async (sql, ...params) => {
  const row = await db.prepare(sql).bind(...params).first()
  return row ? Object.values(row)[0] : null
}

const readBalance = async (productId) =>
  db
    .prepare(
      `SELECT available_qty, reserved_qty, quarantine_qty FROM stock_balances
       WHERE store_id = 1 AND product_id = ? AND location_id = 'store'`,
    )
    .bind(productId)
    .first()

async function seedStockItem({ id, productId, assetCode, condition = 'used', sn }) {
  const normalized = sn === undefined ? `SN-${assetCode}` : sn
  await db.prepare(
    `INSERT INTO stock_items
       (id, store_id, product_id, asset_code, condition, ownership, availability, location,
        sn_raw, sn_normalized, acquisition_cost_cents, cost_known, version)
     VALUES (?, 1, ?, ?, ?, 'store', 'available', 'store', ?, ?, 50000, 1, 1)`,
  ).bind(id, productId, assetCode, condition, normalized, normalized).run()
  await db.prepare(
    `INSERT INTO inventory_movements
       (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
        source, occurred_at, actor_user_id, request_id)
     VALUES (?, 1, ?, ?, 1, NULL, 'available', 50000, 'opening_balance', ?, 1, ?)`,
  ).bind(`${id}::seed`, productId, id, new Date().toISOString(), `${id}::seed-req`).run()
  return id
}

async function seedQuantityStock(productId, qty, requestId) {
  await db
    .prepare(
      `INSERT INTO inventory_movements
         (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
          source, occurred_at, actor_user_id, request_id)
       VALUES (?, 1, ?, NULL, ?, NULL, 'available', NULL, 'opening_balance', ?, 1, ?)`,
    )
    .bind(`${requestId}::mv`, productId, qty, new Date().toISOString(), requestId)
    .run()
}

async function createOrder(client, requestId, { kind = 'retail', lines, discountCents = 0, terms = null }) {
  return json(await client.post('/api/v2/sales/orders', {
    requestId,
    kind,
    customerSnapshot: { name: '陈先生', phone: '13800001111' },
    lines,
    terms,
    discountCents,
  }))
}

async function payAndConfirm(client, orderId, amountCents, tag) {
  const paid = await json(await client.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/payments`, {
    requestId: `${tag}-pay`,
    amountCents,
    method: 'wechat',
    verificationState: 'verified',
  }))
  assert.equal(paid.status, 200, JSON.stringify(paid.body))
  const confirmed = await json(await client.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/confirm`, {
    requestId: `${tag}-confirm`,
  }))
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
  return confirmed
}

async function saveChecks(client, orderId, requestId, items) {
  return json(await client.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/checks`, {
    requestId,
    templateVersion: 'asm-v1',
    configurationVersion: 0,
    items,
  }))
}

async function deliver(client, orderId, requestId, extra = {}) {
  return json(await client.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/deliver`, {
    requestId,
    configurationVersion: 0,
    deliveryNote: '本人到店自提',
    ...extra,
  }))
}

const passItems = () => [
  { key: 'appearance', label: '外观无划痕', kind: 'check', state: 'pass' },
  { key: 'cable', label: '线材整理', kind: 'check', state: 'pass' },
  { key: 'boot', label: '点亮', kind: 'test', state: 'pass' },
  { key: 'burn', label: '烤机 30 分钟', kind: 'test', state: 'pass' },
]

const approveCredit = async (client, orderId, requestId, body) =>
  json(await client.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/credit-approval`, {
    requestId, ...body,
  }))

const cancelOrder = async (client, orderId, requestId, body) =>
  json(await client.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/cancel`, {
    requestId, ...body,
  }))

const registerReturn = async (client, requestId, body) =>
  json(await client.post('/api/v2/sales/returns', { requestId, ...body }))

const approveReturnCredit = async (client, returnId, requestId, body = {}) =>
  json(await client.post(`/api/v2/sales/returns/${encodeURIComponent(returnId)}/approve-credit`, {
    requestId, ...body,
  }))

const refund = async (client, orderId, requestId, body) =>
  json(await client.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/refunds`, {
    requestId, ...body,
  }))

const reverseEntry = async (client, entryId, requestId, body) =>
  json(await client.post(`/api/v2/finance/entries/${encodeURIComponent(entryId)}/reverse`, {
    requestId, ...body,
  }))

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER)
  await seedOwner(db, OWNER_B)
  a = createClient(env.call, await login(env.call, OWNER))
  b = createClient(env.call, await login(env.call, OWNER_B))
  clerk = createClient(env.call, await login(env.call, await seedClerk({ userId: 20, email: 'e09-noperm@local.test' })))
  legacyClerk = createClient(env.call, await login(env.call, await seedClerk({
    userId: 21,
    email: 'e09-legacy@local.test',
    permissions: ['quote/edit', 'quote/view'],
  })))
})

after(async () => {
  await env?.dispose()
})

// ─────────────────────────── 入口与鉴权 ───────────────────────────

test('owner_only 动作对无权限店员 403；旧码店员可读账本、可取消', async () => {
  const deniedCredit = await approveCredit(clerk, 'o-x', 'denied-credit', { dueDate: '2099-01-01', reason: 'x' })
  assert.equal(deniedCredit.status, 403)
  assert.equal(deniedCredit.body.error.code, 'PERMISSION_DENIED')

  const deniedRefund = await refund(clerk, 'o-x', 'denied-refund', { amountCents: 1, method: 'cash', adjustmentRef: 'x', reason: 'x' })
  assert.equal(deniedRefund.status, 403)

  const deniedReturn = await registerReturn(clerk, 'denied-return', {
    originalOrderId: 'o-x', lineAllocations: [{ position: 0, qty: 1 }], stockItemIds: [], reason: 'x', acceptedQty: 1, creditCents: 1,
  })
  assert.equal(deniedReturn.status, 403)

  const deniedReverse = await reverseEntry(clerk, 'ce-x', 'denied-reverse', { reason: 'x' })
  assert.equal(deniedReverse.status, 403)

  const deniedOverview = await json(await clerk.get('/api/v2/finance/overview'))
  assert.equal(deniedOverview.status, 403)

  // 旧码 quote/view 等价 finance/view：旧码店员能读账本。
  const overview = await json(await legacyClerk.get('/api/v2/finance/overview'))
  assert.equal(overview.status, 200, JSON.stringify(overview.body))

  // 旧码 quote/edit 等价 sales/order-edit：取消放行（订单不存在，落到 404 而非 403）。
  const cancel404 = await cancelOrder(legacyClerk, 'o-x', 'legacy-cancel', { reason: 'x' })
  assert.equal(cancel404.status, 404)
})

// ─────────────────────────── B09 欠款批准 ───────────────────────────

test('B09：未成交单、已结清单都不能批准欠款交付', async () => {
  const product = await seedProduct(db, { entityId: 'e09-b09-gate', name: 'B09 闸门品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 3, 'e09-b09-gate-stock')

  // 未成交：草稿单批准被拒
  const draftOrder = await createOrder(a, 'e09-b09-draft', {
    lines: [{ source: 'new', nameSnapshot: '整机', qty: 1, unitPriceCents: 200_000, productRef: product.entityId }],
  })
  const draftId = draftOrder.body.data.entityId
  const notConfirmed = await approveCredit(a, draftId, 'e09-b09-draft-credit', { dueDate: '2099-01-01', reason: '客户月底结清' })
  assert.equal(notConfirmed.status, 400)
  assert.match(notConfirmed.body.error.message, /已成交/)

  // 已结清：付全款后余额为 0，批准被拒
  const settledOrder = await createOrder(a, 'e09-b09-settled', {
    lines: [{ source: 'new', nameSnapshot: '整机', qty: 1, unitPriceCents: 200_000, productRef: product.entityId }],
  })
  const settledId = settledOrder.body.data.entityId
  await payAndConfirm(a, settledId, 200_000, 'e09-b09-settled')
  const noDebt = await approveCredit(a, settledId, 'e09-b09-settled-credit', { dueDate: '2099-01-01', reason: 'x' })
  assert.equal(noDebt.status, 400)
  assert.match(noDebt.body.error.message, /结清|不需要欠款/)
})

test('B09→B10：批准欠款交付后，交付挂凭证成功，financial_disposition = credit_approved', async () => {
  const product = await seedProduct(db, { entityId: 'e09-b09-ok', name: 'B09 欠款品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 5, 'e09-b09-ok-stock')
  const created = await createOrder(a, 'e09-b09-ok', {
    lines: [{ source: 'new', nameSnapshot: '整机', qty: 1, unitPriceCents: 200_000, productRef: product.entityId }],
  })
  const orderId = created.body.data.entityId
  await payAndConfirm(a, orderId, 100_000, 'e09-b09-ok') // 付一半，留 100000 尾款
  await saveChecks(a, orderId, 'e09-b09-ok-checks', passItems())

  // 乱填口头同意不算数
  const bogus = await deliver(a, orderId, 'e09-b09-bogus', { creditApprovalRef: '老板口头同意' })
  assert.equal(bogus.status, 400)
  assert.match(bogus.body.error.message, /欠款批准凭证不存在|批准欠款交付/)

  // 老板批准欠款
  const approval = await approveCredit(a, orderId, 'e09-b09-ok-credit', { dueDate: '2099-01-01', reason: '客户月底结清' })
  assert.equal(approval.status, 200, JSON.stringify(approval.body))
  const approvalId = approval.body.data.effects.creditApprovalId
  assert.ok(approvalId, '批准后返回 creditApprovalId')

  // 快照落库：欠款余额 = 100000，不改订单余额
  assert.equal(
    await scalar('SELECT balance_cents FROM sale_credit_approvals WHERE id = ?', approvalId),
    100_000,
  )
  assert.equal(await scalar('SELECT balance_cents FROM sale_orders WHERE id = ?', orderId), 100_000)

  // 挂凭证交付成功
  const delivered = await deliver(a, orderId, 'e09-b09-ok-deliver', { creditApprovalRef: approvalId })
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body))
  assert.equal(delivered.body.data.state, 'delivered')
  assert.equal(
    await scalar('SELECT financial_disposition FROM sale_deliveries WHERE sale_order_id = ?', orderId),
    'credit_approved',
  )
  assert.equal(await scalar('SELECT credit_approval_id FROM sale_deliveries WHERE sale_order_id = ?', orderId), approvalId)
})

// ─────────────────────────── B11 取消销售单 ───────────────────────────

test('B11：取消释放占用、return_credit 全额冲销、余额转门店待退、幂等复用', async () => {
  const product = await seedProduct(db, { entityId: 'e09-b11', name: 'B11 取消品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 5, 'e09-b11-stock')
  const created = await createOrder(a, 'e09-b11', {
    lines: [{ source: 'new', nameSnapshot: '整机', qty: 1, unitPriceCents: 200_000, productRef: product.entityId }],
  })
  const orderId = created.body.data.entityId
  await payAndConfirm(a, orderId, 100_000, 'e09-b11') // 收一半定金，占库存

  assert.equal((await readBalance(product.hardwareId)).reserved_qty, 1, '成交后占用 1 件')
  assert.equal((await readBalance(product.hardwareId)).available_qty, 4)

  const cancelled = await cancelOrder(a, orderId, 'e09-b11-cancel', { reason: '客户改主意' })
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
  assert.equal(cancelled.body.data.state, 'cancelled')

  // 余额：return_credit = total，balance = -cash_net = -100000（门店待退）
  assert.equal(await scalar('SELECT trade_state FROM sale_orders WHERE id = ?', orderId), 'cancelled')
  assert.equal(await scalar('SELECT return_credit_cents FROM sale_orders WHERE id = ?', orderId), 200_000)
  assert.equal(await scalar('SELECT balance_cents FROM sale_orders WHERE id = ?', orderId), -100_000)
  assert.equal(await scalar('SELECT balance_direction FROM sale_orders WHERE id = ?', orderId), 'store_due')

  // 占用释放：无 active，数量回到可用桶
  assert.equal(await scalar(`SELECT COUNT(*) FROM stock_reservations WHERE order_ref = ? AND status = 'active'`, orderId), 0)
  assert.equal((await readBalance(product.hardwareId)).available_qty, 5)
  assert.equal((await readBalance(product.hardwareId)).reserved_qty, 0)

  // 取消不写任何 out 现金流（退多少钱走 B18 由人填）
  assert.equal(await scalar(`SELECT COUNT(*) FROM cash_entries WHERE sale_order_id = ? AND direction = 'out'`, orderId), 0)

  // 幂等复用：同 requestId 再取消不重复推进
  const again = await cancelOrder(a, orderId, 'e09-b11-cancel', { reason: '客户改主意' })
  assert.equal(again.status, 200)
  assert.equal(again.body.data.operationId, cancelled.body.data.operationId)

  // 换 requestId 再取消 → 已取消被拒
  const third = await cancelOrder(a, orderId, 'e09-b11-cancel-2', { reason: 'x' })
  assert.equal(third.status, 400)
  assert.match(third.body.error.message, /取消过/)
})

test('B11：已交付的订单不能取消，请走退货', async () => {
  const product = await seedProduct(db, { entityId: 'e09-b11-delivered', name: 'B11 已交付品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 3, 'e09-b11-delivered-stock')
  const created = await createOrder(a, 'e09-b11-delivered', {
    lines: [{ source: 'new', nameSnapshot: '整机', qty: 1, unitPriceCents: 200_000, productRef: product.entityId }],
  })
  const orderId = created.body.data.entityId
  await payAndConfirm(a, orderId, 200_000, 'e09-b11-delivered')
  await saveChecks(a, orderId, 'e09-b11-delivered-checks', passItems())
  await deliver(a, orderId, 'e09-b11-delivered-deliver')

  const cancelled = await cancelOrder(a, orderId, 'e09-b11-delivered-cancel', { reason: 'x' })
  assert.equal(cancelled.status, 400)
  assert.match(cancelled.body.error.message, /退货/)
})

// ─────────────────────────── B17 登记退货 ───────────────────────────

test('B17：只对已交付开放、跨单实物被拒、累计贷项超总额 422', async () => {
  const qty = await seedProduct(db, { entityId: 'e09-b17-edge', name: 'B17 数量品', trackingMode: 'quantity' })
  await seedQuantityStock(qty.hardwareId, 5, 'e09-b17-edge-stock')
  const used = await seedProduct(db, { entityId: 'e09-b17-used', name: 'B17 二手件', trackingMode: 'item' })
  const itemId = await seedStockItem({ id: 'si-e09-b17', productId: used.hardwareId, assetCode: 'AC-E09-B17' })

  // 未交付：退货被拒
  const undelivered = await createOrder(a, 'e09-b17-undelivered', {
    lines: [{ source: 'new', nameSnapshot: '整机', qty: 1, unitPriceCents: 100_000, productRef: qty.entityId }],
  })
  const undeliveredId = undelivered.body.data.entityId
  await payAndConfirm(a, undeliveredId, 100_000, 'e09-b17-undelivered')
  const denied = await registerReturn(a, 'e09-b17-undelivered-return', {
    originalOrderId: undeliveredId,
    lineAllocations: [{ position: 0, qty: 1 }],
    stockItemIds: [],
    reason: '客户退',
    acceptedQty: 1,
    creditCents: 50_000,
  })
  assert.equal(denied.status, 400)
  assert.match(denied.body.error.message, /已交付/)

  // 一张已交付、带一件二手实物的单
  const deliveredOrder = await createOrder(a, 'e09-b17-delivered', {
    lines: [
      { source: 'used', nameSnapshot: '二手显卡', qty: 1, unitPriceCents: 100_000, stockItemId: itemId },
      { source: 'new', nameSnapshot: '内存条', qty: 1, unitPriceCents: 60_000, productRef: qty.entityId },
    ],
  })
  const orderId = deliveredOrder.body.data.entityId
  await payAndConfirm(a, orderId, 160_000, 'e09-b17-delivered')
  await saveChecks(a, orderId, 'e09-b17-delivered-checks', passItems())
  await deliver(a, orderId, 'e09-b17-delivered-deliver')
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId), 'sold')

  // 跨单实物：指定一件不属于这张单的实物被拒
  const cross = await registerReturn(a, 'e09-b17-cross', {
    originalOrderId: orderId,
    lineAllocations: [{ position: 0, qty: 1 }],
    stockItemIds: ['si-别的单'],
    reason: '退',
    acceptedQty: 1,
    creditCents: 10_000,
  })
  assert.equal(cross.status, 400)
  assert.match(cross.body.error.message, /不属于这张单/)

  // 累计贷项超总额：60+100=160 总额，退 200000 超 → 422
  const over = await registerReturn(a, 'e09-b17-over', {
    originalOrderId: orderId,
    lineAllocations: [{ position: 0, qty: 1 }],
    stockItemIds: [itemId],
    reason: '退',
    acceptedQty: 1,
    creditCents: 200_000,
  })
  assert.equal(over.status, 422)
  assert.equal(over.body.error.code, 'BALANCE_EXCEEDED')
})

// ─────────────────────────── B17 → B43 → B18 完整链路 ───────────────────────────

test('B17→B43→B18：登记退货 pending → 老板批准 → 现金退款，库存进隔离、余额归零', async () => {
  const qty = await seedProduct(db, { entityId: 'e09-rt-qty', name: '退货链路数量品', trackingMode: 'quantity' })
  await seedQuantityStock(qty.hardwareId, 4, 'e09-rt-qty-stock')
  const used = await seedProduct(db, { entityId: 'e09-rt-used', name: '退货链路二手件', trackingMode: 'item' })
  const itemId = await seedStockItem({ id: 'si-e09-rt', productId: used.hardwareId, assetCode: 'AC-E09-RT' })

  const created = await createOrder(a, 'e09-rt', {
    lines: [
      { source: 'used', nameSnapshot: '二手显卡', qty: 1, unitPriceCents: 100_000, stockItemId: itemId },
      { source: 'new', nameSnapshot: '内存条', qty: 2, unitPriceCents: 30_000, productRef: qty.entityId },
    ],
  })
  const orderId = created.body.data.entityId
  await payAndConfirm(a, orderId, 160_000, 'e09-rt')
  await saveChecks(a, orderId, 'e09-rt-checks', passItems())
  await deliver(a, orderId, 'e09-rt-deliver')

  // B17 登记退货：二手件回店，贷项 pending，暂不计入应退
  const returned = await registerReturn(a, 'e09-rt-return', {
    originalOrderId: orderId,
    lineAllocations: [{ position: 0, qty: 1 }],
    stockItemIds: [itemId],
    reason: '显卡花屏',
    acceptedQty: 1,
    creditCents: 100_000,
  })
  assert.equal(returned.status, 200, JSON.stringify(returned.body))
  const returnId = returned.body.data.effects.returnId
  assert.equal(returned.body.data.effects.creditState, 'pending')

  // 实物 sold → quarantine（source=return_receipt），不回流可卖
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId), 'quarantine')
  const quarantineBalance = await readBalance(used.hardwareId)
  assert.equal(quarantineBalance.available_qty, 0)
  assert.equal(quarantineBalance.quarantine_qty, 1)
  assert.equal(
    await scalar(`SELECT from_bucket FROM inventory_movements WHERE stock_item_id = ? AND source = 'return_receipt'`, itemId),
    'sold',
  )

  // pending 不计入应退：余额仍是 0
  assert.equal(await scalar('SELECT return_credit_cents FROM sale_orders WHERE id = ?', orderId), 0)
  assert.equal(await scalar('SELECT balance_cents FROM sale_orders WHERE id = ?', orderId), 0)

  // 未批准不能退款
  const premature = await refund(a, orderId, 'e09-rt-refund-early', {
    amountCents: 100_000, method: 'wechat', returnRef: returnId, reason: '退显卡款',
  })
  assert.equal(premature.status, 400)
  assert.match(premature.body.error.message, /还没批准/)

  // B43 老板批准贷项
  const approved = await approveReturnCredit(a, returnId, 'e09-rt-approve')
  assert.equal(approved.status, 200, JSON.stringify(approved.body))
  assert.equal(approved.body.data.effects.creditState, 'approved')

  // 批准后 return_credit 生效、余额转门店待退
  assert.equal(await scalar('SELECT return_credit_cents FROM sale_orders WHERE id = ?', orderId), 100_000)
  assert.equal(await scalar('SELECT balance_cents FROM sale_orders WHERE id = ?', orderId), -100_000)
  assert.equal(await scalar('SELECT balance_direction FROM sale_orders WHERE id = ?', orderId), 'store_due')

  // 重复批准被拒
  const reApproved = await approveReturnCredit(a, returnId, 'e09-rt-approve-2')
  assert.equal(reApproved.status, 400)
  assert.match(reApproved.body.error.message, /重复批准|approved/)

  // B18 现金退款：退 100000，cash_net 减、余额归零
  const refunded = await refund(a, orderId, 'e09-rt-refund', {
    amountCents: 100_000, method: 'wechat', returnRef: returnId, reason: '退显卡款',
  })
  assert.equal(refunded.status, 200, JSON.stringify(refunded.body))
  assert.equal(refunded.body.data.effects.balanceCents, 0)

  assert.equal(await scalar('SELECT cash_net_cents FROM sale_orders WHERE id = ?', orderId), 60_000)
  assert.equal(await scalar('SELECT balance_cents FROM sale_orders WHERE id = ?', orderId), 0)
  assert.equal(await scalar('SELECT COUNT(*) FROM sale_refunds WHERE sale_order_id = ?', orderId), 1)
  assert.equal(
    await scalar(`SELECT amount_cents FROM cash_entries WHERE sale_order_id = ? AND direction = 'out'`, orderId),
    100_000,
  )
  const refundEntry = await db.prepare(`SELECT verification_state, verified_at FROM cash_entries WHERE sale_order_id = ? AND direction = 'out'`)
    .bind(orderId).first()
  assert.equal(refundEntry.verification_state, 'verified', 'B18 退款分录只表示已由经办人核实实际退款完成')
  assert.ok(refundEntry.verified_at)

  // 超上限：余额已 0，再退被拒 422
  const over = await refund(a, orderId, 'e09-rt-refund-over', {
    amountCents: 1, method: 'cash', adjustmentRef: '多退', reason: 'x',
  })
  assert.equal(over.status, 422)
  assert.equal(over.body.error.code, 'BALANCE_EXCEEDED')
})

test('B17/B43 跨店 404', async () => {
  const qty = await seedProduct(db, { entityId: 'e09-cross', name: '跨店品', trackingMode: 'quantity' })
  await seedQuantityStock(qty.hardwareId, 1, 'e09-cross-stock')
  const created = await createOrder(a, 'e09-cross', {
    lines: [{ source: 'new', nameSnapshot: '整机', qty: 1, unitPriceCents: 100_000, productRef: qty.entityId }],
  })
  const orderId = created.body.data.entityId
  await payAndConfirm(a, orderId, 100_000, 'e09-cross')
  await saveChecks(a, orderId, 'e09-cross-checks', passItems())
  await deliver(a, orderId, 'e09-cross-deliver')

  const crossReturn = await registerReturn(b, 'e09-cross-return', {
    originalOrderId: orderId,
    lineAllocations: [{ position: 0, qty: 1 }],
    stockItemIds: [],
    reason: 'x',
    acceptedQty: 1,
    creditCents: 1,
  })
  assert.equal(crossReturn.status, 404)

  const crossApprove = await approveReturnCredit(b, 'rt-别的店', 'e09-cross-approve')
  assert.equal(crossApprove.status, 404)
})

// ─────────────────────────── B34 反冲 ───────────────────────────

test('B34：反冲收款 → cash_net 减 + 反向分录；防重复反冲；反冲笔不能再反冲', async () => {
  const product = await seedProduct(db, { entityId: 'e09-b34', name: 'B34 反冲品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 5, 'e09-b34-stock')
  const created = await createOrder(a, 'e09-b34', {
    lines: [{ source: 'new', nameSnapshot: '整机', qty: 1, unitPriceCents: 200_000, productRef: product.entityId }],
  })
  const orderId = created.body.data.entityId
  await payAndConfirm(a, orderId, 100_000, 'e09-b34')

  // 收款分录 id = `${tag}-pay::cash`
  const entryId = 'e09-b34-pay::cash'
  assert.equal(await scalar(`SELECT amount_cents FROM cash_entries WHERE id = ?`, entryId), 100_000)
  assert.equal(await scalar('SELECT cash_net_cents FROM sale_orders WHERE id = ?', orderId), 100_000)

  // 反冲收款：cash_net 归零，余额回 200000
  const reversed = await reverseEntry(a, entryId, 'e09-b34-reverse', { reason: '录错了，不是这单的收款' })
  assert.equal(reversed.status, 200, JSON.stringify(reversed.body))
  assert.equal(reversed.body.data.effects.reversedEntryId, entryId)
  assert.equal(reversed.body.data.effects.direction, 'out')
  assert.equal(await scalar('SELECT cash_net_cents FROM sale_orders WHERE id = ?', orderId), 0)
  assert.equal(await scalar('SELECT balance_cents FROM sale_orders WHERE id = ?', orderId), 200_000)
  // 原笔保留 + 新增反向分录，reversal_of 指向原笔
  assert.equal(await scalar(`SELECT direction FROM cash_entries WHERE reversal_of = ?`, entryId), 'out')

  // 同一原笔不能被重复反冲（reversal_of 已指向它，SQL 守卫拦下）
  const dup = await reverseEntry(a, entryId, 'e09-b34-reverse-dup', { reason: 'x' })
  assert.equal(dup.status, 400)
  assert.equal(dup.body.error.code, 'VALIDATION_ERROR')
  // 没有多出第二条反向分录
  assert.equal(await scalar(`SELECT COUNT(*) FROM cash_entries WHERE reversal_of = ?`, entryId), 1)

  // 反冲笔本身不能再反冲
  const reverseId = reversed.body.data.effects.reverseEntryId
  const reverseTheReverse = await reverseEntry(a, reverseId, 'e09-b34-reverse-r', { reason: 'x' })
  assert.equal(reverseTheReverse.status, 400)
  assert.match(reverseTheReverse.body.error.message, /反冲笔/)
})

// ─────────────────────────── 账本读 ───────────────────────────

test('R12：账本汇总与资金流水（含方向过滤）', async () => {
  const product = await seedProduct(db, { entityId: 'e09-ledger', name: '账本品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 3, 'e09-ledger-stock')
  const created = await createOrder(a, 'e09-ledger', {
    lines: [{ source: 'new', nameSnapshot: '整机', qty: 1, unitPriceCents: 200_000, productRef: product.entityId }],
  })
  const orderId = created.body.data.entityId
  await payAndConfirm(a, orderId, 100_000, 'e09-ledger')

  const overview = await json(await a.get('/api/v2/finance/overview'))
  assert.equal(overview.status, 200, JSON.stringify(overview.body))
  assert.equal(typeof overview.body.data.cash.inTotalCents, 'number')
  assert.equal(typeof overview.body.data.cash.outTotalCents, 'number')
  assert.equal(typeof overview.body.data.cash.netCents, 'number')
  assert.ok(overview.body.data.receivable.orderCount >= 1, '有一张欠款单在应收里')
  assert.ok(overview.body.data.receivable.totalCents >= 100_000, '应收至少含这张单的 100000')

  const entries = await json(await a.get('/api/v2/finance/entries?direction=in'))
  assert.equal(entries.status, 200, JSON.stringify(entries.body))
  assert.ok(Array.isArray(entries.body.data.entries))
  assert.ok(entries.body.data.entries.length >= 1)
  for (const entry of entries.body.data.entries) {
    assert.equal(entry.direction, 'in')
  }

  const badDirection = await json(await a.get('/api/v2/finance/entries?direction=sideways'))
  assert.equal(badDirection.status, 400)
})
