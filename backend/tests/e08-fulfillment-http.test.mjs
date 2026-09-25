/**
 * E08 · 装机、检测与交付的 HTTP 接线（/api/v2/sales/orders* 新增四条）。
 *
 * 契约依据：
 *   actions.json B04（POST /sales/orders，sales/order-edit）
 *                B06（start-assembly，sales/order-assembly）
 *                B07（checks，sales/order-assembly）
 *                B10（deliver，sales/order-deliver）
 *   objects.json Checklist / TestRecord / Delivery / Reservation / StockItem
 *   enums.json   SaleFulfillmentState（waiting_stock → preparing → testing → ready_delivery → delivered）
 *                ChecklistResult（由检查项派生）
 *
 * 覆盖：
 *   1. 入口层：鉴权、权限（新码 sales/order-* 与旧码 quote/edit 等价）；
 *   2. B04 零售建单：商品映射闸、二手冲突闸、幂等复用、建单不写库存；
 *   3. B06 备料装机：未成交不能备料、货没占齐不能备料、waiting_stock → preparing → testing；
 *   4. B07 装机检测：结论由检查项派生、incomplete 不推进、failed 释放占用回缺口、
 *      passed 进待交付、配置版本对不上拒绝；
 *   5. B10 交付扣库：六项闸门逐项、扣库一次、成本快照、幂等复用、欠款路径明确拒绝；
 *   6. 零售跳过装机检测：B07 一次通过直达 ready_delivery。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'
import { seedProduct } from './lib/inventory.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER = { email: 'f-owner@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: '装机门店' }
const OWNER_B = { email: 'f-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: '别家门店' }

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

/** 播一件店有逐件实物（必须走库存流水，让 0007 的触发器维护余额）。 */
async function seedStockItem({ id, productId, assetCode, condition = 'used', sn }) {
  // SN 必须每件不同：0007 的部分唯一索引 uq_stock_items_store_owned_sn 是全店唯一，
  // 两件店有实物带同一个 SN 本身就该被拒 —— 夹具不能造出这种行。
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

/** 给「按数量卖」的商品播可用量。 */
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

/** B04：建一张销售单草稿。 */
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

/** B08 收款 → B05 确认成交。 */
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

/** B06 备料。 */
async function startAssembly(client, orderId, requestId, extra = {}) {
  return json(await client.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/start-assembly`, {
    requestId,
    location: 'store',
    ...extra,
  }))
}

/** B07 检测。 */
async function saveChecks(client, orderId, requestId, items, extra = {}) {
  return json(await client.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/checks`, {
    requestId,
    templateVersion: 'asm-v1',
    configurationVersion: 0,
    items,
    ...extra,
  }))
}

/** B10 交付。 */
async function deliver(client, orderId, requestId, extra = {}) {
  return json(await client.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/deliver`, {
    requestId,
    configurationVersion: 0,
    deliveryNote: '本人到店自提',
    ...extra,
  }))
}

/** 一份能通过检测的最小检查项。 */
const passItems = () => [
  { key: 'appearance', label: '外观无划痕', kind: 'check', state: 'pass' },
  { key: 'cable', label: '线材整理', kind: 'check', state: 'pass' },
  { key: 'boot', label: '点亮', kind: 'test', state: 'pass' },
  { key: 'burn', label: '烤机 30 分钟', kind: 'test', state: 'pass' },
]

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER)
  await seedOwner(db, OWNER_B)
  a = createClient(env.call, await login(env.call, OWNER))
  b = createClient(env.call, await login(env.call, OWNER_B))
  clerk = createClient(env.call, await login(env.call, await seedClerk({ userId: 10, email: 'f-noperm@local.test' })))
  legacyClerk = createClient(env.call, await login(env.call, await seedClerk({
    userId: 11,
    email: 'f-legacy@local.test',
    permissions: ['quote/edit', 'quote/view'],
  })))
})

after(async () => {
  await env?.dispose()
})

// ─────────────────────────── 入口与鉴权 ───────────────────────────

test('无权限店员不能建零售单、备料、记检测、交付；有旧码的店员可以走完整链路', async () => {
  const deniedCreate = await json(await clerk.post('/api/v2/sales/orders', {
    requestId: 'denied-create',
    kind: 'retail',
    customerSnapshot: { name: '某人' },
    lines: [{ source: 'service', nameSnapshot: '服务', qty: 1, unitPriceCents: 1 }],
  }))
  assert.equal(deniedCreate.status, 403)
  assert.equal(deniedCreate.body.error.code, 'PERMISSION_DENIED')

  const deniedAssembly = await json(await clerk.post('/api/v2/sales/orders/o-x/start-assembly', {
    requestId: 'denied-assembly', location: 'store',
  }))
  assert.equal(deniedAssembly.status, 403)

  const deniedChecks = await json(await clerk.post('/api/v2/sales/orders/o-x/checks', {
    requestId: 'denied-checks', templateVersion: 'v', configurationVersion: 0, items: [],
  }))
  assert.equal(deniedChecks.status, 403)

  const deniedDeliver = await json(await clerk.post('/api/v2/sales/orders/o-x/deliver', {
    requestId: 'denied-deliver', configurationVersion: 0, deliveryNote: 'x',
  }))
  assert.equal(deniedDeliver.status, 403)

  // 只有旧码 quote/edit 的店员：备料权限按 legacySource = quote/edit 等价放行。
  const product = await seedProduct(db, { entityId: 'e08-perm', name: '权限链路新品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 5, 'e08-perm-stock')
  const created = await createOrder(legacyClerk, 'e08-perm-order', {
    lines: [{ source: 'new', nameSnapshot: '新品', qty: 1, unitPriceCents: 100_000, productRef: product.entityId }],
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const orderId = created.body.data.entityId
  await payAndConfirm(legacyClerk, orderId, 100_000, 'e08-perm')

  const assembly = await startAssembly(legacyClerk, orderId, 'e08-perm-assembly')
  assert.equal(assembly.status, 200, JSON.stringify(assembly.body))
  assert.equal(assembly.body.data.effects.toState, 'preparing')

  const checks = await saveChecks(legacyClerk, orderId, 'e08-perm-checks', passItems())
  assert.equal(checks.status, 200, JSON.stringify(checks.body))
  assert.equal(checks.body.data.effects.toState, 'ready_delivery')

  const delivered = await deliver(legacyClerk, orderId, 'e08-perm-deliver')
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body))
})

// ─────────────────────────── B04 零售建单 ───────────────────────────

test('B04：零售单建草稿，不写任何库存；同一 requestId 重复提交复用结果', async () => {
  const product = await seedProduct(db, { entityId: 'b04-qty', name: 'B04 数量新品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 3, 'b04-qty-stock')
  const itemId = await seedStockItem({ id: 'si-b04-used', productId: product.hardwareId, assetCode: 'AC-B04-1' })

  const payload = {
    requestId: 'b04-create',
    kind: 'retail',
    customerSnapshot: { name: '李小姐', phone: '13800002222' },
    lines: [
      { source: 'new', nameSnapshot: '内存条 32G', qty: 2, unitPriceCents: 60_000, productRef: product.entityId },
      { source: 'used', nameSnapshot: '二手显卡', qty: 1, unitPriceCents: 100_000, stockItemId: itemId },
      { source: 'service', nameSnapshot: '装机服务费', qty: 1, unitPriceCents: 20_000 },
    ],
    discountCents: 10_000,
  }
  const first = await json(await a.post('/api/v2/sales/orders', payload))
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.data.state, 'draft')
  const orderId = first.body.data.entityId
  assert.match(first.body.data.summary, /零售单/)

  // 建单不写库存：实物仍可取、数量件可用量不变、没有任何占用记录
  // （可用量 4 = 数量件播的 3 + 二手实物入库的 1，两件都还在店里）
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId), 'available')
  assert.equal((await readBalance(product.hardwareId)).available_qty, 4)
  assert.equal(await scalar('SELECT COUNT(*) FROM stock_reservations WHERE order_ref = ?', orderId), 0)

  // 金额：小计 240000 − 优惠 10000 = 230000
  const detail = await json(await a.get(`/api/v2/sales/orders/${encodeURIComponent(orderId)}`))
  assert.equal(detail.body.data.order.totalCents, 230_000)
  assert.equal(detail.body.data.order.tradeState, 'draft')
  assert.equal(detail.body.data.order.kind, 'retail')
  assert.equal(detail.body.data.lines.length, 3)

  const second = await json(await a.post('/api/v2/sales/orders', payload))
  assert.equal(second.status, 200)
  assert.equal(second.body.data.entityId, orderId, '同 requestId 幂等复用，不重复建单')
  const orders = await scalar('SELECT COUNT(*) FROM sale_orders WHERE store_id = 1 AND order_no IS NOT NULL AND request_id = ?', 'b04-create')
  assert.equal(orders, 1)
})

test('B04：新品没选商品、二手没指定实物、客供件带价、优惠超过小计都会被拒绝', async () => {
  const noProduct = await createOrder(a, 'b04-noproduct', {
    lines: [{ source: 'new', nameSnapshot: '临时行', qty: 1, unitPriceCents: 50_000 }],
  })
  assert.equal(noProduct.status, 400)
  assert.match(noProduct.body.error.message, /必须选商品/)

  const noItem = await createOrder(a, 'b04-noitem', {
    lines: [{ source: 'used', nameSnapshot: '二手没指实物', qty: 1, unitPriceCents: 50_000 }],
  })
  assert.equal(noItem.status, 400)
  assert.match(noItem.body.error.message, /必须指定实物/)

  const pricedCustomer = await createOrder(a, 'b04-customer', {
    lines: [{ source: 'customer', nameSnapshot: '客供件', qty: 1, unitPriceCents: 1 }],
  })
  assert.equal(pricedCustomer.status, 400)
  assert.match(pricedCustomer.body.error.message, /客供件本身不带价/)

  const overDiscount = await createOrder(a, 'b04-overdiscount', {
    lines: [{ source: 'service', nameSnapshot: '服务费', qty: 1, unitPriceCents: 10_000 }],
    discountCents: 20_000,
  })
  assert.equal(overDiscount.status, 400)
  assert.match(overDiscount.body.error.message, /优惠不能超过小计/)

  const extensionWarranty = await createOrder(a, 'b04-extension-warranty', {
    lines: [{ source: 'service', nameSnapshot: '延保 6 个月', qty: 1, unitPriceCents: 15900 }],
  })
  assert.equal(extensionWarranty.status, 400)
  assert.match(extensionWarranty.body.error.message, /延保选购、收费和订单履约暂未开放/)
  assert.equal(await scalar('SELECT COUNT(*) FROM sale_orders WHERE request_id = ?', 'b04-extension-warranty'), 0)
})

test('B04：指定已被占用的二手实物 → STOCK_CONFLICT，不生成半张单', async () => {
  const product = await seedProduct(db, { entityId: 'b04-conflict', name: '冲突品', trackingMode: 'item', requiresSn: 1 })
  const itemId = await seedStockItem({ id: 'si-b04-conflict', productId: product.hardwareId, assetCode: 'AC-B04-C1', sn: null })
  await db.prepare(`UPDATE stock_items SET availability = 'reserved' WHERE id = ?`).bind(itemId).run()

  const created = await createOrder(a, 'b04-conflict', {
    lines: [{ source: 'used', nameSnapshot: '被占的二手件', qty: 1, unitPriceCents: 90_000, stockItemId: itemId }],
  })
  assert.equal(created.status, 409)
  assert.equal(created.body.error.code, 'STOCK_CONFLICT')
  assert.equal(await scalar('SELECT COUNT(*) FROM sale_lines WHERE stock_item_id = ?', itemId), 0)
})

// ─────────────────────────── B06 备料装机 ───────────────────────────

test('B06：未成交不能备料；货没占齐不能备料', async () => {
  const product = await seedProduct(db, { entityId: 'b06-nopay', name: 'B06 未付款品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 2, 'b06-nopay-stock')
  const created = await createOrder(a, 'b06-nopay', {
    lines: [{ source: 'new', nameSnapshot: '新品', qty: 1, unitPriceCents: 100_000, productRef: product.entityId }],
  })
  const orderId = created.body.data.entityId

  const notConfirmed = await startAssembly(a, orderId, 'b06-nopay-assembly')
  assert.equal(notConfirmed.status, 400)
  assert.match(notConfirmed.body.error.message, /已成交|确认成交/)

  await payAndConfirm(a, orderId, 100_000, 'b06-nopay')

  const shortStock = await createOrder(a, 'b06-short', {
    lines: [{ source: 'new', nameSnapshot: '不够卖的新品', qty: 2, unitPriceCents: 100_000, productRef: product.entityId }],
  })
  const shortOrderId = shortStock.body.data.entityId
  await payAndConfirm(a, shortOrderId, 200_000, 'b06-short')

  const notReserved = await startAssembly(a, shortOrderId, 'b06-short-assembly')
  assert.equal(notReserved.status, 400)
  assert.match(notReserved.body.error.message, /还没占齐|差/)
})

test('B06：成交后备料 → preparing；再点一次 → testing（备料完成提交检测）', async () => {
  const product = await seedProduct(db, { entityId: 'b06-ok', name: 'B06 正常品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 5, 'b06-ok-stock')
  const created = await createOrder(a, 'b06-ok', {
    lines: [{ source: 'new', nameSnapshot: '新品整机', qty: 1, unitPriceCents: 200_000, productRef: product.entityId }],
  })
  const orderId = created.body.data.entityId
  await payAndConfirm(a, orderId, 200_000, 'b06-ok')

  const first = await startAssembly(a, orderId, 'b06-ok-assembly-1')
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.data.effects.toState, 'preparing')
  assert.equal(await scalar('SELECT fulfillment_state FROM sale_orders WHERE id = ?', orderId), 'preparing')

  const second = await startAssembly(a, orderId, 'b06-ok-assembly-2')
  assert.equal(second.status, 200, JSON.stringify(second.body))
  assert.equal(second.body.data.effects.toState, 'testing')

  // 备料不扣库存：占用还在，可用量没有变化
  const balance = await readBalance(product.hardwareId)
  assert.equal(balance.available_qty, 4)
  assert.equal(balance.reserved_qty, 1)
})

test('B06：单里有客供件时必须给接收引用', async () => {
  const product = await seedProduct(db, { entityId: 'b06-cust', name: 'B06 客供品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 2, 'b06-cust-stock')
  const created = await createOrder(a, 'b06-cust', {
    kind: 'assembly',
    lines: [
      { source: 'new', nameSnapshot: '主板', qty: 1, unitPriceCents: 80_000, productRef: product.entityId },
      { source: 'customer', nameSnapshot: '客户自备显卡', qty: 1, unitPriceCents: 0 },
    ],
  })
  const orderId = created.body.data.entityId
  await payAndConfirm(a, orderId, 80_000, 'b06-cust')

  const denied = await startAssembly(a, orderId, 'b06-cust-assembly')
  assert.equal(denied.status, 422)
  assert.equal(denied.body.error.code, 'OWNERSHIP_INVALID')
  assert.match(denied.body.error.message, /客供件接收引用/)

  const ok = await startAssembly(a, orderId, 'b06-cust-assembly-2', { customerReceiptRef: '客户 9-21 到店交付' })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  // 客供件接收事实落审计，不写库存流水
  assert.equal(await scalar(
    `SELECT COUNT(*) FROM audit_logs WHERE entity_id = ? AND action = 'B06.customer-receipt'`, orderId,
  ), 1)
})

// ─────────────────────────── B07 装机检测 ───────────────────────────

test('B07：结论由检查项派生 —— 有未完成项时只存事实不推进，结果不会变成「通过」', async () => {
  const product = await seedProduct(db, { entityId: 'b07-derive', name: 'B07 派生品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 5, 'b07-derive-stock')
  const created = await createOrder(a, 'b07-derive', {
    lines: [{ source: 'new', nameSnapshot: '整机', qty: 1, unitPriceCents: 200_000, productRef: product.entityId }],
  })
  const orderId = created.body.data.entityId
  await payAndConfirm(a, orderId, 200_000, 'b07-derive')
  await startAssembly(a, orderId, 'b07-derive-assembly-1')
  await startAssembly(a, orderId, 'b07-derive-assembly-2')

  const wrongConfig = await saveChecks(a, orderId, 'b07-wrong-config', passItems(), { configurationVersion: 3 })
  assert.equal(wrongConfig.status, 409)
  assert.equal(wrongConfig.body.error.code, 'VERSION_CONFLICT')

  // 结论由检查项派生（enums.json ChecklistResult.desc）：客户端报不了「通过」，
  // 有 pending 项就是 incomplete —— 服务端不会替人把烤机勾上。
  const partial = await saveChecks(a, orderId, 'b07-partial', [
    { key: 'boot', label: '点亮', kind: 'test', state: 'pass' },
    { key: 'burn', label: '烤机', kind: 'test', state: 'pending' },
  ])
  assert.equal(partial.status, 200, JSON.stringify(partial.body))
  assert.equal(partial.body.data.effects.result, 'incomplete')
  assert.equal(await scalar('SELECT fulfillment_state FROM sale_orders WHERE id = ?', orderId), 'testing', '未完成不推进')

  // 一项都不交不构成一次检测记录
  const empty = await saveChecks(a, orderId, 'b07-empty', [])
  assert.equal(empty.status, 422)
  assert.equal(empty.body.error.code, 'CHECKLIST_INCOMPLETE')

  const passed = await saveChecks(a, orderId, 'b07-pass', passItems())
  assert.equal(passed.status, 200, JSON.stringify(passed.body))
  assert.equal(passed.body.data.effects.result, 'passed')
  assert.equal(passed.body.data.effects.toState, 'ready_delivery')

  // 增量合并：只改一项时其它项不丢（契约 changedItems 的增量语义）
  const second = await json(await a.get(`/api/v2/sales/orders/${encodeURIComponent(orderId)}`))
  assert.equal(second.body.data.fulfillment.latestChecklist.items.length, 4)
})

test('B07：还有未通过项却报「通过」→ 服务端按事实派生，交付时被 CHECKLIST_INCOMPLETE 拦下', async () => {
  const product = await seedProduct(db, { entityId: 'b07-incomplete', name: 'B07 矛盾品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 5, 'b07-incomplete-stock')
  const created = await createOrder(a, 'b07-incomplete', {
    lines: [{ source: 'new', nameSnapshot: '整机', qty: 1, unitPriceCents: 200_000, productRef: product.entityId }],
  })
  const orderId = created.body.data.entityId
  await payAndConfirm(a, orderId, 200_000, 'b07-incomplete')
  await startAssembly(a, orderId, 'b07-incomplete-a1')
  await startAssembly(a, orderId, 'b07-incomplete-a2')

  // 只报点亮通过、烤机失败：结论按事实是 failed，不能推进到待交付
  const saved = await saveChecks(a, orderId, 'b07-incomplete-checks', [
    { key: 'boot', label: '点亮', kind: 'test', state: 'pass' },
    { key: 'burn', label: '烤机', kind: 'test', state: 'fail' },
  ])
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.data.effects.result, 'failed')

  // 检测没过 → 回到待备料；这张单现在根本不在交付阶段，交付直接被拦
  assert.equal(await scalar('SELECT fulfillment_state FROM sale_orders WHERE id = ?', orderId), 'waiting_stock')
  const denied = await deliver(a, orderId, 'b07-incomplete-deliver')
  assert.equal(denied.status, 400)
  assert.match(denied.body.error.message, /交付阶段/)
})

test('B07：检测不通过 → 释放占用、回到待备料、库存数量回到可用桶', async () => {
  const product = await seedProduct(db, { entityId: 'b07-fail', name: 'B07 失败品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 5, 'b07-fail-stock')
  const created = await createOrder(a, 'b07-fail', {
    lines: [{ source: 'new', nameSnapshot: '整机', qty: 2, unitPriceCents: 200_000, productRef: product.entityId }],
  })
  const orderId = created.body.data.entityId
  await payAndConfirm(a, orderId, 400_000, 'b07-fail')
  await startAssembly(a, orderId, 'b07-fail-a1')
  await startAssembly(a, orderId, 'b07-fail-a2')

  assert.equal((await readBalance(product.hardwareId)).reserved_qty, 2)

  const failed = await saveChecks(a, orderId, 'b07-fail-checks', [
    { key: 'boot', label: '点亮', kind: 'test', state: 'pass' },
    { key: 'burn', label: '烤机', kind: 'test', state: 'fail', note: '烤机 10 分钟死机' },
  ])
  assert.equal(failed.status, 200, JSON.stringify(failed.body))
  assert.equal(failed.body.data.effects.result, 'failed')
  assert.equal(failed.body.data.effects.toState, 'waiting_stock')

  assert.equal(await scalar('SELECT fulfillment_state FROM sale_orders WHERE id = ?', orderId), 'waiting_stock')
  assert.equal(
    await scalar(`SELECT COUNT(*) FROM stock_reservations WHERE order_ref = ? AND status = 'active'`, orderId),
    0, '占用已释放',
  )
  const balance = await readBalance(product.hardwareId)
  assert.equal(balance.available_qty, 5, '数量回到可用桶，不漏库存')
  assert.equal(balance.reserved_qty, 0)

  // 缺口重新出现：详情里能看到
  const detail = await json(await a.get(`/api/v2/sales/orders/${encodeURIComponent(orderId)}`))
  assert.equal(detail.body.data.shortage.length, 1)
  assert.equal(detail.body.data.shortage[0].shortageQty, 2)
})

test('B07：逐件坏件失败 → 隔离进 quarantine（不回流 available）；数量件照旧整单释放', async () => {
  const usedProduct = await seedProduct(db, { entityId: 'b07-quar', name: 'B07 隔离二手件', trackingMode: 'item' })
  const itemId = await seedStockItem({ id: 'si-b07-quar', productId: usedProduct.hardwareId, assetCode: 'AC-B07-Q1' })
  const qtyProduct = await seedProduct(db, { entityId: 'b07-quar-qty', name: 'B07 隔离数量件', trackingMode: 'quantity' })
  await seedQuantityStock(qtyProduct.hardwareId, 5, 'b07-quar-qty-stock')

  const created = await createOrder(a, 'b07-quarantine', {
    kind: 'assembly',
    lines: [
      { source: 'used', nameSnapshot: '二手显卡', qty: 1, unitPriceCents: 100_000, stockItemId: itemId },
      { source: 'new', nameSnapshot: '内存条', qty: 1, unitPriceCents: 30_000, productRef: qtyProduct.entityId },
    ],
  })
  const orderId = created.body.data.entityId
  await payAndConfirm(a, orderId, 130_000, 'b07-quarantine')
  await startAssembly(a, orderId, 'b07-quarantine-a1')
  await startAssembly(a, orderId, 'b07-quarantine-a2')

  // 占用成立：逐件实物 reserved、数量件 reserved 1
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId), 'reserved')
  assert.equal((await readBalance(qtyProduct.hardwareId)).reserved_qty, 1)

  const failed = await saveChecks(a, orderId, 'b07-quarantine-checks', [
    { key: 'appearance', label: '外观无划痕', kind: 'check', state: 'pass' },
    { key: 'boot', label: '点亮', kind: 'test', state: 'fail', note: '显卡花屏', stockItemId: itemId },
  ])
  assert.equal(failed.status, 200, JSON.stringify(failed.body))
  assert.equal(failed.body.data.effects.result, 'failed')
  assert.equal(failed.body.data.effects.toState, 'waiting_stock')

  // 逐件坏件 → 隔离：实物 quarantine、reserved→quarantine 流水、来源 inspection_quarantine
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId), 'quarantine')
  assert.equal(
    await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE stock_item_id = ? AND source = 'inspection_quarantine'`, itemId),
    1,
  )
  assert.equal(
    await scalar(`SELECT from_bucket FROM inventory_movements WHERE stock_item_id = ? AND source = 'inspection_quarantine'`, itemId),
    'reserved',
  )
  assert.equal(
    await scalar(`SELECT to_bucket FROM inventory_movements WHERE stock_item_id = ? AND source = 'inspection_quarantine'`, itemId),
    'quarantine',
  )
  // 不回流 available：二手件余额 available 0、quarantine 1、reserved 0
  const usedBalance = await readBalance(usedProduct.hardwareId)
  assert.equal(usedBalance.available_qty, 0)
  assert.equal(usedBalance.reserved_qty, 0)
  assert.equal(usedBalance.quarantine_qty, 1)

  // 数量件照旧整单释放：available 回到 5、reserved 0
  const qtyBalance = await readBalance(qtyProduct.hardwareId)
  assert.equal(qtyBalance.available_qty, 5)
  assert.equal(qtyBalance.reserved_qty, 0)

  // 占用全部释放、无 active；订单回到待备料
  assert.equal(await scalar(`SELECT COUNT(*) FROM stock_reservations WHERE order_ref = ? AND status = 'active'`, orderId), 0)
  assert.equal(await scalar('SELECT fulfillment_state FROM sale_orders WHERE id = ?', orderId), 'waiting_stock')
})

// ─────────────────────────── B10 交付 ───────────────────────────

test('B10：六项闸门逐项拦截 —— 未结清、没到阶段、缺 SN', async () => {
  const product = await seedProduct(db, { entityId: 'b10-gate', name: 'B10 闸门品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 5, 'b10-gate-stock')
  const created = await createOrder(a, 'b10-gate', {
    lines: [{ source: 'new', nameSnapshot: '整机', qty: 1, unitPriceCents: 200_000, productRef: product.entityId }],
  })
  const orderId = created.body.data.entityId

  const unpaid = await deliver(a, orderId, 'b10-unpaid')
  assert.equal(unpaid.status, 400)
  assert.match(unpaid.body.error.message, /已成交|确认成交/)

  await payAndConfirm(a, orderId, 100_000, 'b10-gate') // 只收一半，留尾款

  const partialPaid = await deliver(a, orderId, 'b10-partial')
  assert.equal(partialPaid.status, 400)
  assert.match(partialPaid.body.error.message, /还没到交付阶段|交付阶段/)

  await startAssembly(a, orderId, 'b10-gate-a1')
  await startAssembly(a, orderId, 'b10-gate-a2')
  await saveChecks(a, orderId, 'b10-gate-checks', passItems())

  const balanceDue = await deliver(a, orderId, 'b10-balance')
  assert.equal(balanceDue.status, 400)
  assert.match(balanceDue.body.error.message, /尾款还没结清/)

  const withCredit = await deliver(a, orderId, 'b10-credit', { creditApprovalRef: '老板口头同意' })
  assert.equal(withCredit.status, 400)
  assert.match(withCredit.body.error.message, /欠款批准凭证不存在|批准欠款交付/, '欠款交付必须挂有效的 B09 批准凭证，随便填一句口头同意不算数')
})

test('B10：厂家 SN 可选；逐件实物已有内部编号即可交付', async () => {
  const product = await seedProduct(db, { entityId: 'b10-sn', name: 'B10 需SN品', trackingMode: 'item', requiresSn: 1 })
  const itemId = await seedStockItem({ id: 'si-b10-sn', productId: product.hardwareId, assetCode: 'AC-B10-SN', sn: null })
  const created = await createOrder(a, 'b10-sn', {
    kind: 'retail',
    lines: [{ source: 'used', nameSnapshot: '二手整机', qty: 1, unitPriceCents: 150_000, stockItemId: itemId }],
  })
  const orderId = created.body.data.entityId
  await payAndConfirm(a, orderId, 150_000, 'b10-sn')
  await saveChecks(a, orderId, 'b10-sn-checks', passItems()) // 零售单跳过装机检测

  const ok = await deliver(a, orderId, 'b10-sn-deliver')
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  const deliveredItem = await db.prepare('SELECT sn_normalized FROM stock_items WHERE id = ?').bind(itemId).first()
  assert.equal(deliveredItem.sn_normalized, null)
})

test('B10：零售跳过装机检测，一次通过即到待交付；交付扣库一次、成本快照、幂等复用', async () => {
  const product = await seedProduct(db, { entityId: 'b10-retail', name: 'B10 零售新品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 4, 'b10-retail-stock')
  const usedProduct = await seedProduct(db, { entityId: 'b10-used', name: 'B10 二手件', trackingMode: 'item', requiresSn: 1 })
  const usedId = await seedStockItem({ id: 'si-b10-used', productId: usedProduct.hardwareId, assetCode: 'AC-B10-U1' })

  const created = await createOrder(a, 'b10-retail', {
    lines: [
      { source: 'new', nameSnapshot: '内存条', qty: 2, unitPriceCents: 30_000, productRef: product.entityId },
      { source: 'used', nameSnapshot: '二手显卡', qty: 1, unitPriceCents: 100_000, stockItemId: usedId },
    ],
  })
  const orderId = created.body.data.entityId
  await payAndConfirm(a, orderId, 160_000, 'b10-retail')
  assert.equal((await readBalance(product.hardwareId)).reserved_qty, 2)

  // 零售单不要求先备料：核对结果一次通过直达待交付
  const checks = await saveChecks(a, orderId, 'b10-retail-checks', passItems())
  assert.equal(checks.status, 200, JSON.stringify(checks.body))
  assert.equal(checks.body.data.effects.toState, 'ready_delivery')

  const delivered = await deliver(a, orderId, 'b10-retail-deliver')
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body))
  assert.equal(delivered.body.data.state, 'delivered')
  const snapshot = delivered.body.data.effects.costSnapshot
  assert.equal(snapshot.length, 2)
  assert.equal(snapshot.find((row) => row.source === 'used').costCents, 50_000, '逐件成本 = 取得成本（快照固化）')
  assert.equal(snapshot.find((row) => row.source === 'new').costKnown, false, '数量件成本未知，不填 0')

  // 扣库一次：实物 sold、数量归零、占用结清
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', usedId), 'sold')
  const balance = await readBalance(product.hardwareId)
  assert.equal(balance.available_qty, 2)
  assert.equal(balance.reserved_qty, 0, '扣库把预留数量转走')
  assert.equal(
    await scalar(`SELECT COUNT(*) FROM stock_reservations WHERE order_ref = ? AND status = 'consumed'`, orderId),
    2,
  )
  assert.equal(
    await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE request_id = ? AND source = 'delivery'`, 'b10-retail-deliver'),
    2,
  )
  assert.equal(await scalar(`SELECT COUNT(*) FROM sale_deliveries WHERE sale_order_id = ?`, orderId), 1)
  assert.equal(await scalar('SELECT fulfillment_state FROM sale_orders WHERE id = ?', orderId), 'delivered')

  // 幂等复用：同一 requestId 再交付一次，不再扣库
  const again = await deliver(a, orderId, 'b10-retail-deliver')
  assert.equal(again.status, 200)
  assert.equal(again.body.data.operationId, delivered.body.data.operationId)
  assert.equal(await scalar(`SELECT COUNT(*) FROM sale_deliveries WHERE sale_order_id = ?`, orderId), 1)
  assert.equal(
    await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE request_id = ? AND source = 'delivery'`, 'b10-retail-deliver'),
    2, '流水没有多出第二条',
  )

  // 已交付的单不能再交付（换 requestId 也不行）
  const third = await deliver(a, orderId, 'b10-retail-deliver-3')
  assert.equal(third.status, 400)
  assert.match(third.body.error.message, /交付过|不会交付第二次/)
})

test('B10：跨店交付一律 404', async () => {
  const product = await seedProduct(db, { entityId: 'b10-cross', name: '跨店品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 1, 'b10-cross-stock')
  const created = await createOrder(a, 'b10-cross', {
    lines: [{ source: 'new', nameSnapshot: '整机', qty: 1, unitPriceCents: 100_000, productRef: product.entityId }],
  })
  const orderId = created.body.data.entityId
  await payAndConfirm(a, orderId, 100_000, 'b10-cross')
  await saveChecks(a, orderId, 'b10-cross-checks', passItems())

  const cross = await deliver(b, orderId, 'b10-cross-deliver')
  assert.equal(cross.status, 404)
  assert.equal(cross.body.error.code, 'ENTITY_NOT_FOUND')
})

test('R04 详情带装配看板：检测记录、交付记录、缺口都在详情里', async () => {
  const product = await seedProduct(db, { entityId: 'b10-board', name: '看板品', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 5, 'b10-board-stock')
  const created = await createOrder(a, 'b10-board', {
    lines: [{ source: 'new', nameSnapshot: '整机', qty: 1, unitPriceCents: 200_000, productRef: product.entityId }],
  })
  const orderId = created.body.data.entityId
  await payAndConfirm(a, orderId, 200_000, 'b10-board')
  await startAssembly(a, orderId, 'b10-board-a1')
  await startAssembly(a, orderId, 'b10-board-a2')
  await saveChecks(a, orderId, 'b10-board-checks', passItems())
  await deliver(a, orderId, 'b10-board-deliver')

  const detail = await json(await a.get(`/api/v2/sales/orders/${encodeURIComponent(orderId)}`))
  const board = detail.body.data.fulfillment
  assert.ok(board, '详情里应有 fulfillment 看板')
  assert.equal(board.order.fulfillmentState, 'delivered')
  assert.equal(board.checklists.length, 1)
  assert.equal(board.checklists[0].result, 'passed')
  assert.equal(board.checklists[0].itemCount, 4)
  assert.ok(board.delivery, '交付后应有交付记录')
  assert.equal(board.delivery.financialDisposition, 'settled_in_full')
  assert.equal(board.gaps.length, 0)
})
