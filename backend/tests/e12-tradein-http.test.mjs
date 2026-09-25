/**
 * E12 · 抵用额度（置换折抵）的 HTTP 接线（/api/v2/trade-ins*）。
 *
 * 契约依据：
 *   actions.json B31（POST /trade-ins，tradein/create；POST /trade-ins/:id/apply-offset，tradein/offset）
 *                B32（POST /trade-ins/:id/reverse-offset，tradein/reverse）
 *                R11（GET /trade-ins/:id，tradein/view）
 *   objects.json Offset（tradeInId / saleOrderId / recoveryId / amountCents / state / reversalOf）
 *   enums.json  OffsetState（applied / reversed）
 *   money-rules.json offsetAmountCents = min(max(salesBalance,0), max(recoveryPayableRemaining,0))
 *   migrations/0021_tradein.sql 两张表
 *
 * 覆盖：
 *   1. 鉴权：tradein/view ← quote/view、tradein/create ← quote/edit（旧码等价）；
 *      offset / reverse 是 owner_only，旧码店员 403；
 *   2. 建关联：双方主体相同成功；主体不同 OWNERSHIP_INVALID；缺版本 VALIDATION_ERROR；
 *   3. 折抵：销售 balance 减少、offset_net 增加、offsets 落库；R11 读返回两端 + 有效折抵 + 剩余应付；
 *   4. D06：草稿订单的同客户有效折抵可先计入15%门槛，确认前不占库存；
 *   5. 部分折抵 + 累计不超额：同一回收应付可拆多笔，超出剩余应付 OFFSET_EXCEEDED；
 *   6. 超折抵（超过销售正余额）OFFSET_EXCEEDED；
 *   7. 找零（复用 B33）：折抵后剩余应付可现金付清，再付 BALANCE_EXCEEDED；
 *   8. 撤销折抵：offset_net 回退、balance 回加、有效折抵归零，且同一折抵不能撤销两次；
 *   9. 版本冲突 VERSION_CONFLICT；幂等复用。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'
import { seedProduct } from './lib/inventory.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER_A = { email: 'ti-owner-a@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: '折抵门店甲' }
const OWNER_B = { email: 'ti-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: '折抵门店乙' }

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

// ─────────────────────────── 请求助手 ───────────────────────────

const createTradeIn = async (client, requestId, body) =>
  json(await client.post('/api/v2/trade-ins', { requestId, ...body }))

const applyOffset = async (client, tradeInId, requestId, body) =>
  json(await client.post(`/api/v2/trade-ins/${encodeURIComponent(tradeInId)}/apply-offset`, { requestId, ...body }))

const reverseOffset = async (client, tradeInId, requestId, body) =>
  json(await client.post(`/api/v2/trade-ins/${encodeURIComponent(tradeInId)}/reverse-offset`, { requestId, ...body }))

const tradeInDetail = async (client, tradeInId) =>
  json(await client.get(`/api/v2/trade-ins/${encodeURIComponent(tradeInId)}`))

const payRecovery = async (client, requestId, body) =>
  json(await client.post('/api/v2/finance/payments', { requestId, ...body }))

const saleVersion = (orderId) => scalar('SELECT version FROM sale_orders WHERE id = ?', orderId)
const recoveryVersion = (orderId) => scalar('SELECT version FROM recovery_orders WHERE id = ?', orderId)

// ─────────────────────────── 夹具 ───────────────────────────

async function createCustomer(name, phone) {
  const r = await db.prepare(
    `INSERT INTO customers (store_id, name, phone, status, created_by, updated_by)
     VALUES (1, ?, ?, 'active', 1, 1)`,
  ).bind(name, phone).run()
  return r.meta.last_row_id
}

/**
 * 建一张已确认成交、尚有应收（balance>0）的销售单：
 * 报价（挂客户）→ 发出 → 转单 → 付定金 → 确认成交。
 */
async function createConfirmedOrder({ customerId, tag, totalCents = 100_000, depositCents = 15_000 }) {
  const product = await seedProduct(db, { entityId: `p-${tag}`, name: `折抵商品 ${tag}`, trackingMode: 'quantity' })
  const create = await json(await a.post('/api/v2/sales/quotes', {
    requestId: `${tag}-c`,
    title: `折抵测试 ${tag}`,
    customerId,
    lines: [{ source: 'new', nameSnapshot: '新品 CPU', qty: 1, unitPriceCents: totalCents, productRef: product.entityId }],
  }))
  assert.equal(create.status, 200, JSON.stringify(create.body))
  const quoteId = create.body.data.entityId
  const issue = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/issue`, {
    requestId: `${tag}-i`, expectedVersion: create.body.data.entityVersion,
  }))
  assert.equal(issue.status, 200, JSON.stringify(issue.body))
  const revision = issue.body.data.effects.revision
  const conv = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/convert`, {
    requestId: `${tag}-conv`, quoteVersion: revision,
  }))
  assert.equal(conv.status, 200, JSON.stringify(conv.body))
  const orderId = conv.body.data.entityId
  if (depositCents > 0) {
    const paid = await json(await a.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/payments`, {
      requestId: `${tag}-pay`, amountCents: depositCents, method: 'wechat', verificationState: 'verified',
    }))
    assert.equal(paid.status, 200, JSON.stringify(paid.body))
  }
  const confirmed = await json(await a.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/confirm`, {
    requestId: `${tag}-confirm`,
  }))
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
  return { orderId }
}

/** 建一张含可用数量库存的草稿销售单，供检验折抵先计入 D06 门槛。 */
async function createDraftOrder({ customerId, tag, totalCents = 100_000 }) {
  const product = await seedProduct(db, { entityId: `p-${tag}`, name: `草稿折抵商品 ${tag}`, trackingMode: 'quantity' })
  await db.prepare(
    `INSERT INTO inventory_movements
       (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
        source, occurred_at, actor_user_id, request_id)
     VALUES (?, 1, ?, NULL, 1, NULL, 'available', NULL, 'opening_balance', ?, 1, ?)`,
  ).bind(`${tag}-stock`, product.hardwareId, new Date().toISOString(), `${tag}-stock-req`).run()

  const created = await json(await a.post('/api/v2/sales/quotes', {
    requestId: `${tag}-quote`, title: `草稿折抵 ${tag}`, customerId,
    lines: [{ source: 'new', nameSnapshot: `折抵商品 ${tag}`, qty: 1, unitPriceCents: totalCents, productRef: product.entityId }],
  }))
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const quoteId = created.body.data.entityId
  const issued = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/issue`, {
    requestId: `${tag}-issue`, expectedVersion: created.body.data.entityVersion,
  }))
  assert.equal(issued.status, 200, JSON.stringify(issued.body))
  const converted = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/convert`, {
    requestId: `${tag}-convert`, quoteVersion: issued.body.data.effects.revision,
  }))
  assert.equal(converted.status, 200, JSON.stringify(converted.body))
  return { orderId: converted.body.data.entityId, productId: product.hardwareId }
}

/** 建一张已取得所有权、有应付（payable>0）的回收单。 */
async function toAcquiredRecovery({ customerId, tag, finalCents = 80_000 }) {
  const reg = await json(await a.post('/api/v2/recovery/orders', {
    requestId: `${tag}-reg`,
    sellerName: `${tag} 客户`,
    sellerPhone: '13800000000',
    sellerCustomerId: customerId,
    items: [{ description: '旧整机', condition: 'used', snRaw: `SN-${tag}` }],
    initialEstimateCents: finalCents,
  }))
  assert.equal(reg.status, 200, JSON.stringify(reg.body))
  const orderId = reg.body.data.entityId
  await json(await a.post(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}/inspect`, { requestId: `${tag}-inspect`, note: '' }))
  const detail = await json(await a.get(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}`))
  const itemId = detail.body.data.items[0].id
  await json(await a.post(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}/offer`, {
    requestId: `${tag}-offer`, itemPrices: [{ recoveryItemId: itemId, estimatedCents: finalCents }],
  }))
  const acquired = await json(await a.post(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}/acquire`, {
    requestId: `${tag}-acquire`, finalAcquisitionCents: finalCents,
    lines: [{ recoveryItemId: itemId, productRef: 'p-used-host', assetCode: `AST-${tag}`, snRaw: `SN-${tag}`, costCents: finalCents }],
  }))
  assert.equal(acquired.status, 200, JSON.stringify(acquired.body))
  return { orderId }
}

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER_A)
  await seedOwner(db, OWNER_B)
  a = createClient(env.call, await login(env.call, OWNER_A))
  b = createClient(env.call, await login(env.call, OWNER_B))
  clerk = createClient(env.call, await login(env.call, await seedClerk({ userId: 30, email: 'ti-noperm@local.test' })))
  legacyClerk = createClient(env.call, await login(env.call, await seedClerk({
    userId: 31,
    email: 'ti-legacy@local.test',
    permissions: ['quote/edit', 'quote/view'],
  })))

  await seedProduct(db, { entityId: 'p-used-host', name: '回收整机', trackingMode: 'item' })
})

after(async () => {
  await env?.dispose()
})

// ─────────────────────────── 鉴权 ───────────────────────────

test('鉴权：tradein/view、create 旧码等价；offset/reverse 老板专属', async () => {
  // 无权限店员读 / 建关联都 403。
  const deniedCreate = await createTradeIn(clerk, 'ti-auth-deny', {
    saleOrderId: 'so-x', recoveryId: 'ro-x', saleOrderVersion: 1, recoveryVersion: 1,
  })
  assert.equal(deniedCreate.status, 403)
  assert.equal(deniedCreate.body.error.code, 'PERMISSION_DENIED')

  // 建两个客户 + 销售单 + 回收单，供旧码店员建关联。
  const customerId = await createCustomer('鉴权客户', '13900000001')
  const { orderId } = await createConfirmedOrder({ customerId, tag: 'ti-auth', totalCents: 100_000, depositCents: 15_000 })
  const { orderId: recoveryId } = await toAcquiredRecovery({ customerId, tag: 'ti-auth', finalCents: 50_000 })

  // 旧码 quote/edit → tradein/create：能建关联。
  const created = await createTradeIn(legacyClerk, 'ti-auth-legacy', {
    saleOrderId: orderId, recoveryId,
    saleOrderVersion: await saleVersion(orderId), recoveryVersion: await recoveryVersion(recoveryId),
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const tradeInId = created.body.data.entityId

  // 旧码 quote/view → tradein/view：能读详情。
  const detail = await tradeInDetail(legacyClerk, tradeInId)
  assert.equal(detail.status, 200, JSON.stringify(detail.body))

  // offset / reverse 是 owner_only：旧码店员 403。
  const deniedOffset = await applyOffset(legacyClerk, tradeInId, 'ti-auth-legacy-off', {
    amountCents: 1_000, saleOrderVersion: await saleVersion(orderId), recoveryVersion: await recoveryVersion(recoveryId),
  })
  assert.equal(deniedOffset.status, 403)
  assert.equal(deniedOffset.body.error.code, 'PERMISSION_DENIED')
})

// ─────────────────────────── 建关联 ───────────────────────────

test('建关联：双方主体不同 → OWNERSHIP_INVALID', async () => {
  const customerA = await createCustomer('客户甲', '13900000011')
  const customerB = await createCustomer('客户乙', '13900000012')
  const { orderId } = await createConfirmedOrder({ customerId: customerA, tag: 'ti-own-a', totalCents: 100_000, depositCents: 15_000 })
  const { orderId: recoveryId } = await toAcquiredRecovery({ customerId: customerB, tag: 'ti-own-b', finalCents: 50_000 })

  const created = await createTradeIn(a, 'ti-own-mismatch', {
    saleOrderId: orderId, recoveryId,
    saleOrderVersion: await saleVersion(orderId), recoveryVersion: await recoveryVersion(recoveryId),
  })
  assert.equal(created.status, 422, JSON.stringify(created.body))
  assert.equal(created.body.error.code, 'OWNERSHIP_INVALID')
})

test('建关联：缺版本 → VALIDATION_ERROR', async () => {
  const customerId = await createCustomer('版本客户', '13900000013')
  const { orderId } = await createConfirmedOrder({ customerId, tag: 'ti-ver', totalCents: 100_000, depositCents: 15_000 })
  const { orderId: recoveryId } = await toAcquiredRecovery({ customerId, tag: 'ti-ver', finalCents: 50_000 })

  const created = await createTradeIn(a, 'ti-ver-missing', {
    saleOrderId: orderId, recoveryId,
  })
  assert.equal(created.status, 400)
  assert.equal(created.body.error.code, 'VALIDATION_ERROR')
})

// ─────────────────────────── 折抵 + 找零 + 撤销 ───────────────────────────

test('D06：有效折抵可先计入草稿15%门槛；未达门槛不预留，达标后确认才预留', async () => {
  const tag = 'ti-deposit-offset'
  const customerId = await createCustomer('预付款折抵客户', '13900000028')
  const { orderId, productId } = await createDraftOrder({ customerId, tag })

  const blockedConfirm = await json(await a.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/confirm`, {
    requestId: `${tag}-confirm-before-offset`,
  }))
  assert.equal(blockedConfirm.status, 400, JSON.stringify(blockedConfirm.body))
  assert.equal(blockedConfirm.body.error.code, 'VALIDATION_ERROR')
  assert.equal(await scalar('SELECT trade_state FROM sale_orders WHERE id = ?', orderId), 'draft')
  let stock = await db.prepare(
    "SELECT available_qty, reserved_qty FROM stock_balances WHERE store_id = 1 AND product_id = ? AND location_id = 'store'",
  ).bind(productId).first()
  assert.equal(stock.available_qty, 1)
  assert.equal(stock.reserved_qty, 0)

  const { orderId: recoveryId } = await toAcquiredRecovery({ customerId, tag, finalCents: 15_000 })
  const created = await createTradeIn(a, `${tag}-link`, {
    saleOrderId: orderId, recoveryId, saleOrderVersion: await saleVersion(orderId), recoveryVersion: await recoveryVersion(recoveryId),
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const tradeInId = created.body.data.entityId
  const applied = await applyOffset(a, tradeInId, `${tag}-apply`, {
    amountCents: 15_000, saleOrderVersion: await saleVersion(orderId), recoveryVersion: await recoveryVersion(recoveryId),
  })
  assert.equal(applied.status, 200, JSON.stringify(applied.body))
  const balances = await db.prepare(
    'SELECT cash_net_cents, offset_net_cents, balance_cents FROM sale_orders WHERE id = ?',
  ).bind(orderId).first()
  assert.equal(balances.cash_net_cents, 0, '折抵不得冒充现金收款')
  assert.equal(balances.offset_net_cents, 15_000)
  assert.equal(balances.balance_cents, 85_000)

  const cancelWithOffset = await json(await a.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/cancel`, {
    requestId: `${tag}-cancel-with-offset`, reason: '核对取消边界',
  }))
  assert.equal(cancelWithOffset.status, 400, JSON.stringify(cancelWithOffset.body))
  assert.match(cancelWithOffset.body.error.message, /先撤销关联的置换折抵/)
  assert.equal(await scalar('SELECT trade_state FROM sale_orders WHERE id = ?', orderId), 'draft')

  const confirmed = await json(await a.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/confirm`, {
    requestId: `${tag}-confirm-after-offset`,
  }))
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
  assert.equal(await scalar('SELECT trade_state FROM sale_orders WHERE id = ?', orderId), 'confirmed')
  stock = await db.prepare(
    "SELECT available_qty, reserved_qty FROM stock_balances WHERE store_id = 1 AND product_id = ? AND location_id = 'store'",
  ).bind(productId).first()
  assert.equal(stock.available_qty, 0)
  assert.equal(stock.reserved_qty, 1)
})

test('折抵成功：销售 balance 减少、offset_net 增加，R11 返回两端 + 剩余应付', async () => {
  const customerId = await createCustomer('折抵客户', '13900000021')
  const { orderId } = await createConfirmedOrder({ customerId, tag: 'ti-off-ok', totalCents: 100_000, depositCents: 15_000 })
  const { orderId: recoveryId } = await toAcquiredRecovery({ customerId, tag: 'ti-off-ok', finalCents: 80_000 })

  const sv0 = await saleVersion(orderId)
  const rv0 = await recoveryVersion(recoveryId)

  const created = await createTradeIn(a, 'ti-off-ok-create', {
    saleOrderId: orderId, recoveryId, saleOrderVersion: sv0, recoveryVersion: rv0,
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const tradeInId = created.body.data.entityId

  // 折抵 50_000（销售余额 85_000、回收应付 80_000，取小 = 80_000，50_000 合法）。
  const applied = await applyOffset(a, tradeInId, 'ti-off-ok-apply', {
    amountCents: 50_000, saleOrderVersion: sv0, recoveryVersion: rv0,
  })
  assert.equal(applied.status, 200, JSON.stringify(applied.body))

  // 销售侧：offset_net 50_000，balance = 100_000 - 0 - 15_000 - 50_000 = 35_000。
  const sale = await db.prepare(
    'SELECT offset_net_cents, balance_cents, balance_direction, cash_net_cents FROM sale_orders WHERE id = ?',
  ).bind(orderId).first()
  assert.equal(sale.offset_net_cents, 50_000)
  assert.equal(sale.balance_cents, 35_000)
  assert.equal(sale.balance_direction, 'client_due')

  // 回收侧：R10 带 offsetCents = 50_000。
  const recoveryDetail = await json(await a.get(`/api/v2/recovery/orders/${encodeURIComponent(recoveryId)}`))
  assert.equal(recoveryDetail.body.data.offsetCents, 50_000)
  assert.deepEqual(recoveryDetail.body.data.tradeIns.map((tradeIn) => tradeIn.id), [tradeInId])

  // R11 读：两端 + 有效折抵 + 剩余应付 = 80_000 - 50_000 = 30_000。
  const detail = await tradeInDetail(a, tradeInId)
  assert.equal(detail.status, 200, JSON.stringify(detail.body))
  assert.equal(detail.body.data.validOffsetCents, 50_000)
  assert.equal(detail.body.data.recoveryPayableRemainingCents, 30_000)
  assert.equal(detail.body.data.saleOrder.balanceCents, 35_000)
  assert.equal(detail.body.data.offsets.length, 1)
  assert.equal(detail.body.data.offsets[0].state, 'applied')
})

test('部分折抵：累计不得超额，超出剩余应付 OFFSET_EXCEEDED', async () => {
  const customerId = await createCustomer('部分折抵客户', '13900000022')
  const { orderId } = await createConfirmedOrder({ customerId, tag: 'ti-off-part', totalCents: 200_000, depositCents: 30_000 })
  const { orderId: recoveryId } = await toAcquiredRecovery({ customerId, tag: 'ti-off-part', finalCents: 80_000 })

  const sv0 = await saleVersion(orderId)
  const rv0 = await recoveryVersion(recoveryId)
  const created = await createTradeIn(a, 'ti-off-part-create', {
    saleOrderId: orderId, recoveryId, saleOrderVersion: sv0, recoveryVersion: rv0,
  })
  const tradeInId = created.body.data.entityId

  // 第一笔折抵 30_000。
  const first = await applyOffset(a, tradeInId, 'ti-off-part-1', {
    amountCents: 30_000, saleOrderVersion: sv0, recoveryVersion: rv0,
  })
  assert.equal(first.status, 200, JSON.stringify(first.body))

  // 第二笔折抵 40_000（累计 70_000 ≤ 80_000）。折抵后销售 version 已 +1，需重查。
  const sv1 = await saleVersion(orderId)
  const second = await applyOffset(a, tradeInId, 'ti-off-part-2', {
    amountCents: 40_000, saleOrderVersion: sv1, recoveryVersion: rv0,
  })
  assert.equal(second.status, 200, JSON.stringify(second.body))

  // 第三笔 20_000：剩余应付只剩 10_000，超出 → OFFSET_EXCEEDED。
  const sv2 = await saleVersion(orderId)
  const third = await applyOffset(a, tradeInId, 'ti-off-part-3', {
    amountCents: 20_000, saleOrderVersion: sv2, recoveryVersion: rv0,
  })
  assert.equal(third.status, 422, JSON.stringify(third.body))
  assert.equal(third.body.error.code, 'OFFSET_EXCEEDED')

  const detail = await tradeInDetail(a, tradeInId)
  assert.equal(detail.body.data.validOffsetCents, 70_000)
  assert.equal(detail.body.data.recoveryPayableRemainingCents, 10_000)
})

test('超折抵（超过销售正余额）→ OFFSET_EXCEEDED', async () => {
  const customerId = await createCustomer('超折抵客户', '13900000023')
  // 销售 total 100_000，定金 15_000 → 余额 85_000；回收应付 200_000。
  const { orderId } = await createConfirmedOrder({ customerId, tag: 'ti-off-over', totalCents: 100_000, depositCents: 15_000 })
  const { orderId: recoveryId } = await toAcquiredRecovery({ customerId, tag: 'ti-off-over', finalCents: 200_000 })

  const sv0 = await saleVersion(orderId)
  const rv0 = await recoveryVersion(recoveryId)
  const created = await createTradeIn(a, 'ti-off-over-create', {
    saleOrderId: orderId, recoveryId, saleOrderVersion: sv0, recoveryVersion: rv0,
  })
  const tradeInId = created.body.data.entityId

  // 折抵 90_000 > 销售余额 85_000 → OFFSET_EXCEEDED。
  const applied = await applyOffset(a, tradeInId, 'ti-off-over-apply', {
    amountCents: 90_000, saleOrderVersion: sv0, recoveryVersion: rv0,
  })
  assert.equal(applied.status, 422, JSON.stringify(applied.body))
  assert.equal(applied.body.error.code, 'OFFSET_EXCEEDED')
})

test('找零（复用 B33）：折抵后剩余应付可现金付清，再付超 BALANCE_EXCEEDED', async () => {
  const customerId = await createCustomer('找零客户', '13900000024')
  const { orderId } = await createConfirmedOrder({ customerId, tag: 'ti-change', totalCents: 100_000, depositCents: 20_000 })
  const { orderId: recoveryId } = await toAcquiredRecovery({ customerId, tag: 'ti-change', finalCents: 80_000 })

  const sv0 = await saleVersion(orderId)
  const rv0 = await recoveryVersion(recoveryId)
  const created = await createTradeIn(a, 'ti-change-create', {
    saleOrderId: orderId, recoveryId, saleOrderVersion: sv0, recoveryVersion: rv0,
  })
  const tradeInId = created.body.data.entityId

  // 折抵 50_000，回收剩余应付 = 30_000。
  const applied = await applyOffset(a, tradeInId, 'ti-change-apply', {
    amountCents: 50_000, saleOrderVersion: sv0, recoveryVersion: rv0,
  })
  assert.equal(applied.status, 200, JSON.stringify(applied.body))

  // 找零：付掉剩余 30_000（不能超过 payable - 有效折抵 = 30_000）。
  const change = await payRecovery(a, 'ti-change-cashback', {
    sourceDocument: `recovery:${recoveryId}`, amountCents: 30_000, method: 'cash',
  })
  assert.equal(change.status, 200, JSON.stringify(change.body))

  // 再付 1 分：剩余应付已 0 → BALANCE_EXCEEDED（扣了折抵，不再是 80_000 的现金口径）。
  const overPay = await payRecovery(a, 'ti-change-overpay', {
    sourceDocument: `recovery:${recoveryId}`, amountCents: 1, method: 'cash',
  })
  assert.equal(overPay.status, 422, JSON.stringify(overPay.body))
  assert.equal(overPay.body.error.code, 'BALANCE_EXCEEDED')

  // 详情：回收剩余应付归 0。
  const detail = await tradeInDetail(a, tradeInId)
  assert.equal(detail.body.data.recoveryPayableRemainingCents, 0)
})

test('撤销折抵：offset_net 回退、balance 回加、有效折抵归零，同一笔不能撤销两次', async () => {
  const customerId = await createCustomer('撤销客户', '13900000025')
  const { orderId } = await createConfirmedOrder({ customerId, tag: 'ti-rev', totalCents: 100_000, depositCents: 15_000 })
  const { orderId: recoveryId } = await toAcquiredRecovery({ customerId, tag: 'ti-rev', finalCents: 80_000 })

  const sv0 = await saleVersion(orderId)
  const rv0 = await recoveryVersion(recoveryId)
  const created = await createTradeIn(a, 'ti-rev-create', {
    saleOrderId: orderId, recoveryId, saleOrderVersion: sv0, recoveryVersion: rv0,
  })
  const tradeInId = created.body.data.entityId

  const applied = await applyOffset(a, tradeInId, 'ti-rev-apply', {
    amountCents: 50_000, saleOrderVersion: sv0, recoveryVersion: rv0,
  })
  assert.equal(applied.status, 200, JSON.stringify(applied.body))
  const offsetId = applied.body.data.entityId

  // 撤销折抵。
  const sv1 = await saleVersion(orderId)
  const reversed = await reverseOffset(a, tradeInId, 'ti-rev-reverse', {
    offsetId, reason: '客户反悔', saleOrderVersion: sv1, recoveryVersion: rv0,
  })
  assert.equal(reversed.status, 200, JSON.stringify(reversed.body))

  const sale = await db.prepare('SELECT offset_net_cents, balance_cents FROM sale_orders WHERE id = ?').bind(orderId).first()
  assert.equal(sale.offset_net_cents, 0)
  assert.equal(sale.balance_cents, 85_000)

  const detail = await tradeInDetail(a, tradeInId)
  assert.equal(detail.body.data.validOffsetCents, 0)
  assert.equal(detail.body.data.recoveryPayableRemainingCents, 80_000)
  assert.equal(detail.body.data.offsets.length, 2)
  assert.ok(detail.body.data.offsets.some((o) => o.state === 'reversed'))

  // 同一笔折抵不能再撤销一次（部分唯一索引兜底）。
  const sv2 = await saleVersion(orderId)
  const again = await reverseOffset(a, tradeInId, 'ti-rev-reverse-again', {
    offsetId, reason: '再次撤销', saleOrderVersion: sv2, recoveryVersion: rv0,
  })
  assert.equal(again.status, 404, JSON.stringify(again.body))
})

// ─────────────────────────── 版本冲突与幂等 ───────────────────────────

test('折抵版本冲突 → VERSION_CONFLICT', async () => {
  const customerId = await createCustomer('版本冲突客户', '13900000026')
  const { orderId } = await createConfirmedOrder({ customerId, tag: 'ti-vc', totalCents: 100_000, depositCents: 15_000 })
  const { orderId: recoveryId } = await toAcquiredRecovery({ customerId, tag: 'ti-vc', finalCents: 80_000 })

  const sv0 = await saleVersion(orderId)
  const rv0 = await recoveryVersion(recoveryId)
  const created = await createTradeIn(a, 'ti-vc-create', {
    saleOrderId: orderId, recoveryId, saleOrderVersion: sv0, recoveryVersion: rv0,
  })
  const tradeInId = created.body.data.entityId

  // 用过期版本折抵 → VERSION_CONFLICT。
  const applied = await applyOffset(a, tradeInId, 'ti-vc-apply', {
    amountCents: 10_000, saleOrderVersion: sv0 - 1, recoveryVersion: rv0,
  })
  assert.equal(applied.status, 409, JSON.stringify(applied.body))
  assert.equal(applied.body.error.code, 'VERSION_CONFLICT')
})

test('幂等：同 requestId 重复折抵复用原凭据，不产生第二条 offset', async () => {
  const customerId = await createCustomer('幂等客户', '13900000027')
  const { orderId } = await createConfirmedOrder({ customerId, tag: 'ti-idem', totalCents: 100_000, depositCents: 15_000 })
  const { orderId: recoveryId } = await toAcquiredRecovery({ customerId, tag: 'ti-idem', finalCents: 80_000 })

  const sv0 = await saleVersion(orderId)
  const rv0 = await recoveryVersion(recoveryId)
  const created = await createTradeIn(a, 'ti-idem-create', {
    saleOrderId: orderId, recoveryId, saleOrderVersion: sv0, recoveryVersion: rv0,
  })
  const tradeInId = created.body.data.entityId

  const first = await applyOffset(a, tradeInId, 'ti-idem-apply', {
    amountCents: 20_000, saleOrderVersion: sv0, recoveryVersion: rv0,
  })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const offsetId = first.body.data.entityId

  const second = await applyOffset(a, tradeInId, 'ti-idem-apply', {
    amountCents: 20_000, saleOrderVersion: sv0, recoveryVersion: rv0,
  })
  assert.equal(second.status, 200, JSON.stringify(second.body))
  assert.equal(second.body.data.entityId, offsetId)

  const count = await scalar('SELECT COUNT(*) FROM offsets WHERE store_id = 1 AND trade_in_id = ? AND state = ?', tradeInId, 'applied')
  assert.equal(count, 1)
})
