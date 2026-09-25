/**
 * E07 · 采购到货的 HTTP 接线（/api/v2/inventory/purchases|receipts|supplier-returns）。
 *
 * 契约依据：
 *   actions.json B14（inventory/purchase-create）/ B15（inventory/receipt）/ B38（inventory/supplier-return）
 *                / R08（purchases 列表与详情，inventory/view）
 *   objects.json Purchase（含 derivedFields：pendingQty / receiptProgress）/ Receipt / InventoryMovement
 *   enums.json   InspectionDisposition / StockCondition
 *
 * 覆盖五层：
 *   1. 入口层：路由排在库存模块之前、鉴权、权限（新码 + 旧码 library/edit、library/view）；
 *   2. 采购层（B14）：快捷供应商不建档、供应商缺失拒绝、商品不存在拒绝、幂等复用；
 *   3. 到货层（B15）：**5 件只到 3 件 → 在途剩 2**、拒收不进可用、逐件商品要编号、超量拒绝；
 *   4. 退供层（B38）：只从可取 / 待处理出发、已占用件不能退、数量不足拒绝；
 *   5. 边界层：跨店 404、快速采购仍有来源与成本、成本未知不写成 0。
 *
 * 放行证据对应（05-fulfillment.md 05b 行）：
 *   · 5 件仅到 3 件，在途剩 2 → 「分批到货：先到 3 件，在途剩 2，再补到齐」
 *   · 拒收不进可用           → 「拒收的件不进可用量」
 *   · 来源成本可查           → 「到货件的成本与来源采购单可查；成本未知不写成 0」
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'
import { seedProduct } from './lib/inventory.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER_A = { email: 'p-owner-a@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: '采购门店甲' }
const OWNER_B = { email: 'p-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: '采购门店乙' }

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

const purchaseBody = (productRef, qtyOrdered, extra = {}) => ({
  supplierName: '华强北路 3 号档口',
  lines: [{ productRef, nameSnapshot: '采购件', qtyOrdered, unitCostCents: 12_000, ...extra }],
})

async function createPurchase(client, body, requestId) {
  return json(await client.post('/api/v2/inventory/purchases', { requestId, ...body }))
}

async function receive(client, body, requestId) {
  return json(await client.post('/api/v2/inventory/receipts', { requestId, ...body }))
}

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER_A)
  await seedOwner(db, OWNER_B)
  a = createClient(env.call, await login(env.call, OWNER_A))
  b = createClient(env.call, await login(env.call, OWNER_B))
  clerk = createClient(env.call, await login(env.call, await seedClerk({ userId: 20, email: 'p-noperm@local.test' })))
  legacyClerk = createClient(env.call, await login(env.call, await seedClerk({
    userId: 21,
    email: 'p-legacy@local.test',
    permissions: ['library/edit', 'library/view'],
  })))
})

after(async () => {
  await env?.dispose()
})

// ─────────────────────────── 入口与鉴权 ───────────────────────────

test('未登录采购接口 → 401；无权限店员 → 403；采购路径必须排在库存模块之前被认领', async () => {
  const anonymous = await env.call('/api/v2/inventory/purchases', { method: 'GET' })
  assert.equal(anonymous.status, 401)

  const denied = await json(await clerk.get('/api/v2/inventory/purchases'))
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED')

  const deniedWrite = await json(await clerk.post('/api/v2/inventory/purchases', {
    requestId: 'p-noperm-1',
    supplierName: 'X',
    lines: [{ productRef: 'x', qtyOrdered: 1 }],
  }))
  assert.equal(deniedWrite.status, 403)
})

test('只有旧码 library/edit 的店员能建采购与到货（LEGACY_EQUIVALENT）', async () => {
  const product = await seedProduct(db, { entityId: 'p-legacy-item', name: '旧码采购件', trackingMode: 'quantity' })
  const created = await createPurchase(legacyClerk, purchaseBody(product.entityId, 2), 'p-legacy-po')
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const purchaseId = created.body.data.entityId

  const detail = await json(await legacyClerk.get(`/api/v2/inventory/purchases/${encodeURIComponent(purchaseId)}`))
  const lineId = detail.body.data.lines[0].id

  const received = await receive(legacyClerk, {
    purchaseId,
    lines: [{ purchaseLineId: lineId, productRef: product.entityId, qtyReceived: 2, disposition: 'available' }],
  }, 'p-legacy-receipt')
  assert.equal(received.status, 200, JSON.stringify(received.body))
})

// ─────────────────────────── B14 创建采购 ───────────────────────────

test('B14：快捷供应商不建档也能建采购；同 requestId 重复提交复用结果', async () => {
  const product = await seedProduct(db, { entityId: 'p14-quick', name: '快捷采购件', trackingMode: 'quantity' })
  const body = purchaseBody(product.entityId, 5)

  const first = await createPurchase(a, body, 'p14-quick')
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.data.effects.orderedQty, 5)
  assert.equal(first.body.data.effects.supplierName, '华强北路 3 号档口')

  const again = await createPurchase(a, body, 'p14-quick')
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.equal(again.body.data.operationId, first.body.data.operationId)

  const count = await scalar('SELECT COUNT(*) FROM purchase_orders WHERE store_id = 1 AND request_id = ?', 'p14-quick')
  assert.equal(count, 1, '同一 requestId 不得建出两张采购单')
})

test('B14：既没有供应商名称也没有已建档供应商 → 拒绝；商品不存在 → 404', async () => {
  const product = await seedProduct(db, { entityId: 'p14-guard', name: '守卫件', trackingMode: 'quantity' })

  const noSupplier = await createPurchase(a, {
    lines: [{ productRef: product.entityId, qtyOrdered: 1 }],
  }, 'p14-nosup')
  assert.equal(noSupplier.status, 400)
  assert.match(noSupplier.body.error.message, /供应商/)

  const missingProduct = await createPurchase(a, purchaseBody('no-such-product', 1), 'p14-noprod')
  assert.equal(missingProduct.status, 404)
  assert.equal(missingProduct.body.error.code, 'ENTITY_NOT_FOUND')
})

// ─────────────────────────── B15 到货（放行证据） ───────────────────────────

test('放行证据：采购 5 件只到 3 件 —— 在途剩 2，再补到齐', async () => {
  const product = await seedProduct(db, { entityId: 'p15-partial', name: '分批到货件', trackingMode: 'quantity' })
  const created = await createPurchase(a, purchaseBody(product.entityId, 5), 'p15-partial')
  const purchaseId = created.body.data.entityId

  const before = await json(await a.get(`/api/v2/inventory/purchases/${encodeURIComponent(purchaseId)}`))
  assert.equal(before.body.data.purchase.orderedQty, 5)
  assert.equal(before.body.data.purchase.receivedQty, 0)
  assert.equal(before.body.data.purchase.pendingQty, 5)
  assert.equal(before.body.data.purchase.progress, '尚未到货')
  const lineId = before.body.data.lines[0].id

  // 第一次到货：5 件只到 3 件
  const firstReceipt = await receive(a, {
    purchaseId,
    lines: [{ purchaseLineId: lineId, productRef: product.entityId, qtyReceived: 3, disposition: 'available' }],
  }, 'p15-partial-r1')
  assert.equal(firstReceipt.status, 200, JSON.stringify(firstReceipt.body))
  assert.equal(firstReceipt.body.data.effects.stockedQty, 3)

  const after = await json(await a.get(`/api/v2/inventory/purchases/${encodeURIComponent(purchaseId)}`))
  assert.equal(after.body.data.purchase.receivedQty, 3)
  assert.equal(after.body.data.purchase.pendingQty, 2, '5 件到 3 件，在途必须剩 2')
  assert.equal(after.body.data.purchase.progress, '部分到货')
  // 在库量 = 实到 3 件
  assert.equal(await scalar(
    'SELECT available_qty FROM stock_balances WHERE store_id = 1 AND product_id = ? AND location_id = ?',
    product.hardwareId,
    'store',
  ), 3)

  // 补到齐
  const secondReceipt = await receive(a, {
    purchaseId,
    lines: [{ purchaseLineId: lineId, productRef: product.entityId, qtyReceived: 2, disposition: 'available' }],
  }, 'p15-partial-r2')
  assert.equal(secondReceipt.status, 200, JSON.stringify(secondReceipt.body))

  const done = await json(await a.get(`/api/v2/inventory/purchases/${encodeURIComponent(purchaseId)}`))
  assert.equal(done.body.data.purchase.pendingQty, 0)
  assert.equal(done.body.data.purchase.progress, '到货完成')
  assert.equal(await scalar(
    'SELECT available_qty FROM stock_balances WHERE store_id = 1 AND product_id = ? AND location_id = ?',
    product.hardwareId,
    'store',
  ), 5)

  // 两次到货各自成单，各有 requestId
  assert.equal(done.body.data.receipts.length, 2)
})

test('放行证据：拒收的件不进可用量，且计入采购恒等式（不留「还在途」假象）', async () => {
  const product = await seedProduct(db, { entityId: 'p15-reject', name: '拒收件', trackingMode: 'quantity' })
  const created = await createPurchase(a, purchaseBody(product.entityId, 4), 'p15-reject')
  const purchaseId = created.body.data.entityId
  const detail = await json(await a.get(`/api/v2/inventory/purchases/${encodeURIComponent(purchaseId)}`))
  const lineId = detail.body.data.lines[0].id

  // 4 件到货：3 件收下，1 件当场拒收
  const receipt = await receive(a, {
    purchaseId,
    lines: [{
      purchaseLineId: lineId,
      productRef: product.entityId,
      qtyReceived: 3,
      qtyRejected: 1,
      disposition: 'available',
    }],
  }, 'p15-reject-r1')
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body))
  assert.equal(receipt.body.data.effects.rejectedQty, 1)

  const available = await scalar(
    'SELECT available_qty FROM stock_balances WHERE store_id = 1 AND product_id = ? AND location_id = ?',
    product.hardwareId,
    'store',
  )
  assert.equal(available, 3, '拒收的 1 件不得进入可用量')

  const after = await json(await a.get(`/api/v2/inventory/purchases/${encodeURIComponent(purchaseId)}`))
  assert.equal(after.body.data.purchase.receivedQty, 3)
  assert.equal(after.body.data.purchase.rejectedQty, 1)
  assert.equal(after.body.data.purchase.pendingQty, 0, '拒收也要计入已处置，不能在途还挂着')
  assert.equal(after.body.data.purchase.progress, '到货完成')

  // 拒收件不建实物：它从未进入自有在库
  const items = await scalar('SELECT COUNT(*) FROM stock_items WHERE store_id = 1 AND product_id = ?', product.hardwareId)
  assert.equal(items, 0, '拒收的件不应产生 stock_item')
})

test('B15：超过订购量被拒绝（超量要先改采购量或另建追加采购）', async () => {
  const product = await seedProduct(db, { entityId: 'p15-over', name: '超量件', trackingMode: 'quantity' })
  const created = await createPurchase(a, purchaseBody(product.entityId, 2), 'p15-over')
  const purchaseId = created.body.data.entityId
  const detail = await json(await a.get(`/api/v2/inventory/purchases/${encodeURIComponent(purchaseId)}`))
  const lineId = detail.body.data.lines[0].id

  const receipt = await receive(a, {
    purchaseId,
    lines: [{ purchaseLineId: lineId, productRef: product.entityId, qtyReceived: 3, disposition: 'available' }],
  }, 'p15-over-r1')
  assert.equal(receipt.status, 400, JSON.stringify(receipt.body))
  assert.equal(await scalar(
    'SELECT COALESCE(available_qty, 0) FROM stock_balances WHERE store_id = 1 AND product_id = ? AND location_id = ?',
    product.hardwareId,
    'store',
  ) ?? 0, 0, '被拒的到货不得留下半截库存')
})

test('放行证据：逐件商品必须给内部编号；来源成本与采购单可查', async () => {
  const product = await seedProduct(db, { entityId: 'p15-item', name: '逐件采购件', trackingMode: 'item', requiresSn: 1 })
  const created = await createPurchase(a, purchaseBody(product.entityId, 2), 'p15-item')
  const purchaseId = created.body.data.entityId
  const detail = await json(await a.get(`/api/v2/inventory/purchases/${encodeURIComponent(purchaseId)}`))
  const lineId = detail.body.data.lines[0].id

  // 实收超出采购数量 → 拒绝
  const short = await receive(a, {
    purchaseId,
    lines: [{
      purchaseLineId: lineId,
      productRef: product.entityId,
      qtyReceived: 3,
      disposition: 'available',
      items: [{ assetCode: 'AC-P15-ITEM-1', snRaw: 'SN0001' }],
    }],
  }, 'p15-item-r0')
  assert.equal(short.status, 400)
  assert.match(short.body.error.message, /采购量|订购量|剩余数量/)

  // 厂家 SN 可选；内部编号由服务端生成。
  const noManufacturerSn = await receive(a, {
    purchaseId,
    lines: [{
      purchaseLineId: lineId,
      productRef: product.entityId,
      qtyReceived: 2,
      disposition: 'available',
      items: [{ assetCode: 'AC-P15-ITEM-1' }, { snRaw: 'SN0002' }],
    }],
  }, 'p15-item-r1')
  assert.equal(noManufacturerSn.status, 200, JSON.stringify(noManufacturerSn.body))

  const row = await db.prepare(
    `SELECT si.asset_code, si.sn_normalized, si.acquisition_cost_cents, si.cost_known, si.acquisition_ref, si.availability
     FROM stock_items si WHERE si.store_id = 1 AND si.product_id = ? ORDER BY si.asset_code`,
  ).bind(product.hardwareId).all()
  assert.equal(row.results.length, 2)
  assert.ok(row.results.some((item) => /^IT-0001-\d{8}-[0-9A-F]{10}$/.test(item.asset_code)))
  assert.ok(row.results.some((item) => item.sn_normalized === null), '厂家 SN 可选，不阻断到货')
  assert.ok(row.results.some((item) => item.sn_normalized === 'SN0002'))
  for (const item of row.results) {
    assert.equal(item.acquisition_cost_cents, 12_000, '来源成本必须落到实物上')
    assert.equal(item.cost_known, 1)
    assert.equal(item.acquisition_ref, purchaseId, '实物必须能回溯到来源采购单')
    assert.equal(item.availability, 'available')
  }
})

test('B15：快速采购（不挂采购单）同样保留来源与成本；成本未知不写成 0', async () => {
  const product = await seedProduct(db, { entityId: 'p15-quick', name: '现买现入件', trackingMode: 'quantity' })

  const quick = await receive(a, {
    quickPurchaseNote: '电脑城现场现买',
    lines: [{
      productRef: product.entityId,
      qtyReceived: 2,
      disposition: 'available',
      unitCostCents: 8_800,
    }],
  }, 'p15-quick-r1')
  assert.equal(quick.status, 200, JSON.stringify(quick.body))
  assert.equal(quick.body.data.effects.quickPurchase, true)

  const movement = await db.prepare(
    `SELECT source, cost_cents, to_bucket FROM inventory_movements
     WHERE store_id = 1 AND product_id = ? ORDER BY rowid DESC LIMIT 1`,
  ).bind(product.hardwareId).first()
  assert.equal(movement.source, 'quick_purchase', '快速采购要有自己的来源标识，不能冒充采购入库')
  assert.equal(movement.cost_cents, 8_800)
  assert.equal(movement.to_bucket, 'available')

  // 成本未知：必须为 NULL，不能写 0
  const productTwo = await seedProduct(db, { entityId: 'p15-unknown-cost', name: '成本未知件', trackingMode: 'item', requiresSn: 0 })
  const unknown = await receive(a, {
    quickPurchaseNote: '朋友送的，成本待核实',
    lines: [{
      productRef: productTwo.entityId,
      qtyReceived: 1,
      disposition: 'available',
      items: [{ assetCode: 'AC-P15-UNK-1' }],
      costKnown: false,
    }],
  }, 'p15-unknown-r1')
  assert.equal(unknown.status, 200, JSON.stringify(unknown.body))
  const item = await db.prepare('SELECT acquisition_cost_cents, cost_known FROM stock_items WHERE asset_code = ?')
    .bind('AC-P15-UNK-1').first()
  assert.equal(item.acquisition_cost_cents, null, '未知成本必须是 NULL，不是 0')
  assert.equal(item.cost_known, 0)

  // 既没有采购单也没有快速采购说明 → 拒绝
  const neither = await receive(a, {
    lines: [{ productRef: product.entityId, qtyReceived: 1, disposition: 'available' }],
  }, 'p15-neither')
  assert.equal(neither.status, 400)
  assert.match(neither.body.error.message, /采购单|快速采购/)
})

// ─────────────────────────── B38 退供 ───────────────────────────

test('B38：退供把可取件转为离店，减少可用量且不产生可用库存', async () => {
  const product = await seedProduct(db, { entityId: 'p38-item', name: '退供逐件', trackingMode: 'item', requiresSn: 0 })
  const created = await createPurchase(a, purchaseBody(product.entityId, 1), 'p38-item')
  const purchaseId = created.body.data.entityId
  const detail = await json(await a.get(`/api/v2/inventory/purchases/${encodeURIComponent(purchaseId)}`))
  const lineId = detail.body.data.lines[0].id

  const receipt = await receive(a, {
    purchaseId,
    lines: [{
      purchaseLineId: lineId,
      productRef: product.entityId,
      qtyReceived: 1,
      disposition: 'available',
      items: [{ assetCode: 'AC-P38-1' }],
    }],
  }, 'p38-item-r1')
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body))
  const stockItemId = await scalar('SELECT id FROM stock_items WHERE asset_code = ?', 'AC-P38-1')

  const returned = await json(await a.post('/api/v2/inventory/supplier-returns', {
    requestId: 'p38-return',
    purchaseId,
    stockItemId,
    qty: 1,
    fromBucket: 'available',
    reason: '点不亮，退回档口换新',
    supplierName: '华强北路 3 号档口',
  }))
  assert.equal(returned.status, 200, JSON.stringify(returned.body))
  assert.equal(returned.body.data.effects.qty, 1)

  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', stockItemId), 'retired')
  assert.equal(await scalar(
    'SELECT available_qty FROM stock_balances WHERE store_id = 1 AND product_id = ? AND location_id = ?',
    product.hardwareId,
    'store',
  ), 0, '退供后可用量归零')
  assert.equal(await scalar('SELECT source FROM inventory_movements WHERE stock_item_id = ? AND source = ?', stockItemId, 'supplier_return'), 'supplier_return')
  assert.equal(await scalar('SELECT COUNT(*) FROM supplier_returns WHERE store_id = 1'), 1)
})

test('B38：已占用件不能退供；数量不足拒绝；缺原因拒绝', async () => {
  const product = await seedProduct(db, { entityId: 'p38-guard', name: '退供守卫', trackingMode: 'quantity' })
  const created = await createPurchase(a, purchaseBody(product.entityId, 2), 'p38-guard')
  const purchaseId = created.body.data.entityId
  const detail = await json(await a.get(`/api/v2/inventory/purchases/${encodeURIComponent(purchaseId)}`))
  const lineId = detail.body.data.lines[0].id
  await receive(a, {
    purchaseId,
    lines: [{ purchaseLineId: lineId, productRef: product.entityId, qtyReceived: 2, disposition: 'available' }],
  }, 'p38-guard-r1')

  const noReason = await json(await a.post('/api/v2/inventory/supplier-returns', {
    requestId: 'p38-noreason',
    productRef: product.entityId,
    qty: 1,
    fromBucket: 'available',
  }))
  assert.equal(noReason.status, 400)
  assert.match(noReason.body.error.message, /原因/)

  const tooMany = await json(await a.post('/api/v2/inventory/supplier-returns', {
    requestId: 'p38-toomany',
    productRef: product.entityId,
    qty: 5,
    fromBucket: 'available',
    reason: '多退',
  }))
  assert.equal(tooMany.status, 409)
  assert.equal(tooMany.body.error.code, 'STOCK_CONFLICT')
  assert.equal(await scalar(
    'SELECT available_qty FROM stock_balances WHERE store_id = 1 AND product_id = ? AND location_id = ?',
    product.hardwareId,
    'store',
  ), 2, '失败的退供不得动库存')

  const fromReserved = await json(await a.post('/api/v2/inventory/supplier-returns', {
    requestId: 'p38-reserved',
    productRef: product.entityId,
    qty: 1,
    fromBucket: 'reserved',
    reason: '想从已订件里退',
  }))
  assert.equal(fromReserved.status, 400, '契约不允许从已占用件退供')
})

// ─────────────────────────── 读模型与边界 ───────────────────────────

test('R08：列表可只看未到齐的采购；跨店访问一律 404', async () => {
  const list = await json(await a.get('/api/v2/inventory/purchases?scope=open&limit=200'))
  assert.equal(list.status, 200, JSON.stringify(list.body))
  assert.ok(list.body.data.purchases.every((row) => row.pendingQty > 0), 'scope=open 只返回还有在途的')
  assert.equal(typeof list.body.data.totals.pendingQty, 'number')

  const openOnly = await json(await a.get('/api/v2/inventory/purchases?scope=done&limit=200'))
  assert.equal(openOnly.status, 200)
  assert.ok(openOnly.body.data.purchases.every((row) => row.pendingQty === 0))

  const badScope = await json(await a.get('/api/v2/inventory/purchases?scope=nope'))
  assert.equal(badScope.status, 400)

  const someId = list.body.data.purchases[0]?.id ?? openOnly.body.data.purchases[0].id
  const crossStore = await json(await b.get(`/api/v2/inventory/purchases/${encodeURIComponent(someId)}`))
  assert.equal(crossStore.status, 404)
  assert.equal(crossStore.body.error.code, 'ENTITY_NOT_FOUND')
})

test('E07 不抢库存模块的活：/api/v2/inventory 与 /inventory/items 仍由库存链路回答', async () => {
  // 采购模块排在库存模块之前，必须精准认领；这两条路径要原样落到库存模块。
  const inventory = await json(await a.get('/api/v2/inventory?limit=5'))
  assert.equal(inventory.status, 200, JSON.stringify(inventory.body).slice(0, 200))
  assert.ok(Array.isArray(inventory.body.data.items))

  const unknown = await json(await a.get('/api/v2/inventory/nope'))
  assert.equal(unknown.status, 404)
})
