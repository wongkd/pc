/**
 * E06 · 销售单与收款的 HTTP 接线（/api/v2/sales/orders*、/api/v2/sales/quotes/:id/convert）。
 *
 * 契约依据：
 *   actions.json B03（convert，sales/quote-convert）/ B05（confirm | allocate，sales/order-edit）
 *                / B08（payments，sales/order-payment）/ R04（orders 列表与详情，sales/order-view）
 *   objects.json SaleOrder / SaleLine / Reservation / CashEntry
 *   money-rules.json collectableCents（不超收）/ balanceDirection / discountAllocation
 *
 * 覆盖六层：
 *   1. 入口层：路由、鉴权、权限（新码 + 旧码等价 quote/edit、quote/view）；
 *   2. 转单层（B03）：状态闸、过期闸、重复转单闸、商品映射闸、优惠分摊；
 *   3. 收款层（B08）：幂等复用、改载荷冲突、超收拒绝、余额与方向派生；
 *   4. 预留层（B05）：未付款不预留；收款后占用成功；实物状态随之变化；
 *   5. 并发层（放行证据 3）：两个订单抢同一件实物，只有一个成功，**失败那一单的收款仍留账**；
 *   6. 边界层：跨店 404、已取消单不能占用、缺件清单正确。
 *
 * 放行证据对应（docs/plans/2026-09-19-erp-first/ai-tasks/05-fulfillment.md 05a 行）：
 *   · 未付款不预留采购      → 「未付款不预留：收款前确认成交被拒绝」
 *   · 重复收款只记一次      → 「同一 requestId 重复收款复用结果，资金流水只多一条」
 *   · 抢最后实物仅一单成功  → 「并发抢最后一件：只一单预留成功，失败单收款仍留账」
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'
import { seedProduct } from './lib/inventory.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER_A = { email: 's-owner-a@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: '销售门店甲' }
const OWNER_B = { email: 's-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: '销售门店乙' }

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

/**
 * 播一件店有实物。
 *
 * ⚠️ 必须同时写一条入库流水：stock_balances 的三个桶只由 inventory_movements 的触发器维护
 * （0007 §3 设计要点），只 INSERT stock_items 会让实物游离在余额之外 ——
 * available_qty 还是 0，之后任意一次 available → reserved 都会把余额减成负数并被
 * CHECK (available_qty >= 0) 拦下。那不是被测代码的问题，是夹具没走真实入库路径。
 */
async function seedStockItem({ id, productId, assetCode, availability = 'available', condition = 'used' }) {
  await db.prepare(
    `INSERT INTO stock_items
       (id, store_id, product_id, asset_code, condition, ownership, availability, location,
        acquisition_cost_cents, cost_known, version)
     VALUES (?, 1, ?, ?, ?, 'store', ?, 'store', 50000, 1, 1)`,
  ).bind(id, productId, assetCode, condition, availability).run()

  if (availability === 'available' || availability === 'quarantine') {
    await db.prepare(
      `INSERT INTO inventory_movements
         (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
          source, occurred_at, actor_user_id, request_id)
       VALUES (?, 1, ?, ?, 1, NULL, ?, 50000, 'opening_balance', ?, 1, ?)`,
    ).bind(`${id}::seed`, productId, id, availability, new Date().toISOString(), `${id}::seed-req`).run()
  }
  return id
}

/**
 * 给「按数量卖」的商品播可用量。
 *
 * 与 seedStockItem 同一个道理：必须走库存流水，让 0007 的触发器去改 stock_balances。
 * 直接 INSERT stock_balances 是契约 StockBalance.rules 明令禁止的「缺少流水的手改数字」，
 * 而且会绕过触发器，把触发器本身的问题盖掉。
 */
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

const readBalance = async (productId) =>
  db
    .prepare(
      `SELECT available_qty, reserved_qty FROM stock_balances
       WHERE store_id = 1 AND product_id = ? AND location_id = 'store'`,
    )
    .bind(productId)
    .first()

/**
 * 建一份已发出的报价。
 * lines 直接给契约的报价行字段（source / nameSnapshot / qty / unitPriceCents / stockItemId / productRef）。
 */
async function createIssuedQuote(client, { requestId, lines, discountCents = 0, validUntil = null }) {
  const create = await json(await client.post('/api/v2/sales/quotes', {
    requestId: `${requestId}-c`,
    title: `销售测试 ${requestId}`,
    lines,
    discountCents,
  }))
  assert.equal(create.status, 200, JSON.stringify(create.body))
  const quoteId = create.body.data.entityId
  const issue = await json(await client.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/issue`, {
    requestId: `${requestId}-i`,
    expectedVersion: create.body.data.entityVersion,
    validUntil,
  }))
  assert.equal(issue.status, 200, JSON.stringify(issue.body))
  return { quoteId, revision: issue.body.data.effects.revision }
}

/** 报价行：二手件（必须指定实物）。 */
const usedLine = (stockItemId, unitPriceCents = 100_000) => ({
  source: 'used',
  nameSnapshot: '二手显卡 RTX 4060',
  specSnapshot: '拆机件',
  qty: 1,
  unitPriceCents,
  stockItemId,
})

/** 报价行：新品数量件（必须给商品映射，成交后进入缺口）。 */
const newLine = (productRef, unitPriceCents = 200_000, qty = 1) => ({
  source: 'new',
  nameSnapshot: '新品 CPU i5-14600KF',
  specSnapshot: '',
  qty,
  unitPriceCents,
  productRef,
})

/** 转单：B03。 */
async function convert(client, quoteId, quoteVersion, extra = {}) {
  return json(await client.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/convert`, {
    requestId: extra.requestId ?? `conv-${quoteId}`,
    quoteVersion,
    ...extra,
  }))
}

/** 收款：B08。 */
async function pay(client, orderId, amountCents, requestId) {
  return json(await client.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/payments`, {
    requestId,
    amountCents,
    method: 'wechat',
    verificationState: 'verified',
  }))
}

/** 确认成交：B05 confirm。 */
async function confirm(client, orderId, requestId, extra = {}) {
  return json(await client.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/confirm`, {
    requestId,
    ...extra,
  }))
}

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER_A)
  await seedOwner(db, OWNER_B)
  a = createClient(env.call, await login(env.call, OWNER_A))
  b = createClient(env.call, await login(env.call, OWNER_B))
  clerk = createClient(env.call, await login(env.call, await seedClerk({ userId: 10, email: 's-noperm@local.test' })))
  legacyClerk = createClient(env.call, await login(env.call, await seedClerk({
    userId: 11,
    email: 's-legacy@local.test',
    permissions: ['quote/edit', 'quote/view'],
  })))
})

after(async () => {
  await env?.dispose()
})

// ─────────────────────────── 入口与鉴权 ───────────────────────────

test('未登录访问销售单 → 401；无权限店员 → 403（契约信封）', async () => {
  const anonymous = await env.call('/api/v2/sales/orders', { method: 'GET' })
  assert.equal(anonymous.status, 401)

  const denied = await json(await clerk.get('/api/v2/sales/orders'))
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED')

  const deniedConvert = await json(await clerk.post('/api/v2/sales/quotes/q-x/convert', {
    requestId: 'x-1',
    quoteVersion: 1,
  }))
  assert.equal(deniedConvert.status, 403)
})

test('只有旧码 quote/edit + quote/view 的店员走完整转单与收款链路（LEGACY_EQUIVALENT）', async () => {
  const product = await seedProduct(db, { entityId: 'legacy-cpu', name: '旧码新品', trackingMode: 'quantity' })
  const itemId = await seedStockItem({ id: 'si-legacy-1', productId: product.hardwareId, assetCode: 'AC-LEG-1' })
  const { quoteId, revision } = await createIssuedQuote(legacyClerk, {
    requestId: 'legacy-flow',
    lines: [usedLine(itemId, 80_000), newLine(product.entityId, 120_000)],
  })

  const converted = await convert(legacyClerk, quoteId, revision, { requestId: 'legacy-conv' })
  assert.equal(converted.status, 200, JSON.stringify(converted.body))
  const orderId = converted.body.data.entityId

  const paid = await pay(legacyClerk, orderId, 30_000, 'legacy-pay')
  assert.equal(paid.status, 200, JSON.stringify(paid.body))

  const confirmed = await confirm(legacyClerk, orderId, 'legacy-confirm')
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
  assert.equal(confirmed.body.data.state, 'confirmed')
})

// ─────────────────────────── B03 转单 ───────────────────────────

test('B03：已发出报价转单成功，优惠按声明分摊，新品无实物行进入缺口', async () => {
  const product = await seedProduct(db, { entityId: 'b03-cpu', name: 'B03 新品', trackingMode: 'quantity' })
  const itemId = await seedStockItem({ id: 'si-b03-1', productId: product.hardwareId, assetCode: 'AC-B03-1' })
  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b03-flow',
    lines: [usedLine(itemId, 100_000), newLine(product.entityId, 300_000)],
    discountCents: 20_000,
  })

  const converted = await convert(a, quoteId, revision, { requestId: 'b03-conv' })
  assert.equal(converted.status, 200, JSON.stringify(converted.body))
  const orderId = converted.body.data.entityId
  assert.equal(converted.body.data.state, 'draft')

  const detail = await json(await a.get(`/api/v2/sales/orders/${encodeURIComponent(orderId)}`))
  assert.equal(detail.status, 200, JSON.stringify(detail.body))
  const order = detail.body.data.order

  // 小计 400000 − 优惠 20000 = 380000；余额 = 总额 − 已收 − 折抵
  assert.equal(order.subtotalCents, 400_000)
  assert.equal(order.discountCents, 20_000)
  assert.equal(order.totalCents, 380_000)
  assert.equal(order.balanceCents, 380_000)
  assert.equal(order.balanceDirection, 'client_due')
  assert.equal(order.tradeState, 'draft')

  // 行级分摊之和必须等于整单优惠（money-rules.json discountAllocation.invariant）
  const allocated = detail.body.data.lines.reduce((sum, line) => sum + line.discountAllocationCents, 0)
  assert.equal(allocated, 20_000)
  for (const line of detail.body.data.lines) {
    assert.equal(line.netLineCents, line.unitPriceCents * line.qty - line.discountAllocationCents)
  }

  // 缺件 = 没有实物可直接占的店有新品行
  assert.equal(detail.body.data.shortage.length, 1)
  assert.equal(detail.body.data.shortage[0].position, 1)

  // 转单后报价版本变为已转单
  const version = await scalar(
    'SELECT status FROM quote_versions WHERE store_id = 1 AND quote_id = ? AND revision = ?',
    quoteId,
    revision,
  )
  assert.equal(version, 'converted')

  // 转单本身不写任何库存：实物仍可取
  const availability = await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId)
  assert.equal(availability, 'available')
})

test('B03：同一份报价不能转两次单', async () => {
  const product = await seedProduct(db, { entityId: 'b03-dup', name: 'B03 重复', trackingMode: 'quantity' })
  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b03-dup',
    lines: [newLine(product.entityId, 100_000)],
  })
  const first = await convert(a, quoteId, revision, { requestId: 'b03-dup-1' })
  assert.equal(first.status, 200, JSON.stringify(first.body))

  const second = await convert(a, quoteId, revision, { requestId: 'b03-dup-2' })
  assert.equal(second.status, 400)
  assert.equal(second.body.error.code, 'VALIDATION_ERROR')
  assert.match(second.body.error.message, /已发出或顾客已确认/, '第二次应因状态已转单而被拒')

  const orders = await scalar('SELECT COUNT(*) FROM sale_orders WHERE store_id = 1 AND quote_id = ?', quoteId)
  assert.equal(orders, 1)
})

test('B03：草稿报价不能成交；过期报价不能成交', async () => {
  const draft = await json(await a.post('/api/v2/sales/quotes', {
    requestId: 'b03-draft',
    title: '未发出的草稿',
    lines: [{ source: 'service', nameSnapshot: '装机服务费', qty: 1, unitPriceCents: 20_000 }],
  }))
  assert.equal(draft.status, 200)
  const draftId = draft.body.data.entityId
  const onDraft = await convert(a, draftId, 1, { requestId: 'b03-draft-conv' })
  assert.equal(onDraft.status, 400)
  assert.match(onDraft.body.error.message, /状态是「draft」/)

  const product = await seedProduct(db, { entityId: 'b03-expired', name: '过期新品', trackingMode: 'quantity' })
  const past = new Date(Date.now() - 3600_000).toISOString()
  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b03-expired',
    lines: [newLine(product.entityId, 100_000)],
    validUntil: past,
  })
  const onExpired = await convert(a, quoteId, revision, { requestId: 'b03-expired-conv' })
  assert.equal(onExpired.status, 400)
  assert.match(onExpired.body.error.message, /过期|续期|已发出/)
})

test('B03：新品行没选商品 → 明确拒绝，不再静默记成缺口（契约「成交前必须映射到商品」）', async () => {
  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b03-nomap',
    lines: [{ source: 'new', nameSnapshot: '临时行 无商品', qty: 1, unitPriceCents: 50_000 }],
  })
  const converted = await convert(a, quoteId, revision, { requestId: 'b03-nomap-conv' })
  assert.equal(converted.status, 400)
  assert.equal(converted.body.error.code, 'VALIDATION_ERROR')
  assert.match(converted.body.error.message, /还没选商品/)
  const orders = await scalar(
    'SELECT COUNT(*) FROM sale_orders WHERE store_id = 1 AND request_id = ?',
    'b03-nomap-conv::sale',
  )
  assert.equal(orders, 0, '拒单时不得留下半张销售单')
})

test('B03：新品行选了商品 → product_id 落地，缺口按「有商品但没实物」算', async () => {
  const product = await seedProduct(db, { entityId: 'b03-mapped', name: '映射新品', trackingMode: 'quantity' })
  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b03-mapped',
    lines: [newLine(product.entityId, 120_000)],
  })
  const converted = await convert(a, quoteId, revision, { requestId: 'b03-mapped-conv' })
  assert.equal(converted.status, 200, JSON.stringify(converted.body))
  assert.equal(converted.body.data.effects.shortageCount, 1, '有商品、没实物 → 进缺口，采购页拿它去补货')
  const orderId = converted.body.data.entityId
  const productId = await scalar(
    'SELECT product_id FROM sale_lines WHERE sale_order_id = ? AND source = ?',
    orderId,
    'new',
  )
  assert.equal(productId, product.hardwareId, '按报价行的商品引用解析出商品主键，不再留 NULL')
  const detail = await json(await a.get(`/api/v2/sales/orders/${encodeURIComponent(orderId)}`))
  assert.equal(detail.body.data.shortage.length, 1)
  assert.equal(detail.body.data.shortage[0].nameSnapshot, '新品 CPU i5-14600KF')
})

test('B03：转单时用 lineProductMap 补映射（报价行没带引用时的补救路）', async () => {
  const product = await seedProduct(db, { entityId: 'b03-late', name: '后补映射品', trackingMode: 'quantity' })
  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b03-late',
    lines: [{ source: 'new', nameSnapshot: '后补映射行', qty: 2, unitPriceCents: 30_000 }],
  })
  const converted = await convert(a, quoteId, revision, {
    requestId: 'b03-late-conv',
    lineProductMap: [{ position: 0, productRef: product.entityId }],
  })
  assert.equal(converted.status, 200, JSON.stringify(converted.body))
  const orderId = converted.body.data.entityId
  const productId = await scalar(
    'SELECT product_id FROM sale_lines WHERE sale_order_id = ? AND source = ?',
    orderId,
    'new',
  )
  assert.equal(productId, product.hardwareId)
  // 补映射只落在 sale_lines：契约「发出后不可覆盖」，已发出的报价版本不许回头改写。
  const refOnQuote = await scalar(
    'SELECT product_ref FROM quote_lines WHERE quote_id = ? AND revision = ? AND position = 0',
    quoteId,
    revision,
  )
  assert.equal(refOnQuote, null, '报价版本保持原样，补映射不回头写报价行')
})

test('B03：被别的订单占用的二手实物，转单直接失败（不生成半张单）', async () => {
  const product = await seedProduct(db, { entityId: 'b03-conflict', name: '冲突品', trackingMode: 'quantity' })
  const itemId = await seedStockItem({ id: 'si-b03-conflict', productId: product.hardwareId, assetCode: 'AC-CONF-1' })
  await db.prepare(`UPDATE stock_items SET availability = 'reserved' WHERE id = ?`).bind(itemId).run()

  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b03-conflict',
    lines: [usedLine(itemId, 90_000)],
  })
  const converted = await convert(a, quoteId, revision, { requestId: 'b03-conflict-conv' })
  assert.equal(converted.status, 409)
  assert.equal(converted.body.error.code, 'STOCK_CONFLICT')
  const orders = await scalar('SELECT COUNT(*) FROM sale_orders WHERE store_id = 1 AND request_id = ?', 'b03-conflict-conv::sale')
  assert.equal(orders, 0, '预检失败时不得留下销售单')
})

// ─────────────────────────── B08 收款 ───────────────────────────

test('B08：重复收款只记一次（同 requestId 复用结果）', async () => {
  const product = await seedProduct(db, { entityId: 'b08-idem', name: '幂等品', trackingMode: 'quantity' })
  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b08-idem',
    lines: [newLine(product.entityId, 100_000)],
  })
  const converted = await convert(a, quoteId, revision, { requestId: 'b08-idem-conv' })
  const orderId = converted.body.data.entityId

  const first = await pay(a, orderId, 15_000, 'b08-idem-pay')
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const second = await pay(a, orderId, 15_000, 'b08-idem-pay')
  assert.equal(second.status, 200, JSON.stringify(second.body))
  assert.equal(second.body.data.operationId, first.body.data.operationId)

  const entries = await scalar('SELECT COUNT(*) FROM cash_entries WHERE store_id = 1 AND sale_order_id = ?', orderId)
  assert.equal(entries, 1, '同一 requestId 重复提交不得形成两笔资金流水')
  const cashNet = await scalar('SELECT cash_net_cents FROM sale_orders WHERE id = ?', orderId)
  assert.equal(cashNet, 15_000)
})

test('B08：同 requestId 改载荷 → IDEMPOTENCY_MISMATCH；超收 → BALANCE_EXCEEDED', async () => {
  const product = await seedProduct(db, { entityId: 'b08-guard', name: '守卫品', trackingMode: 'quantity' })
  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b08-guard',
    lines: [newLine(product.entityId, 60_000)],
  })
  const converted = await convert(a, quoteId, revision, { requestId: 'b08-guard-conv' })
  const orderId = converted.body.data.entityId

  const first = await pay(a, orderId, 10_000, 'b08-guard-pay')
  assert.equal(first.status, 200)
  const mismatched = await pay(a, orderId, 20_000, 'b08-guard-pay')
  assert.equal(mismatched.status, 409, JSON.stringify(mismatched.body))
  assert.equal(mismatched.body.error.code, 'IDEMPOTENCY_MISMATCH')

  const overpaid = await pay(a, orderId, 90_000, 'b08-guard-over')
  assert.equal(overpaid.status, 422, JSON.stringify(overpaid.body))
  assert.equal(overpaid.body.error.code, 'BALANCE_EXCEEDED')

  const balance = await scalar('SELECT balance_cents FROM sale_orders WHERE id = ?', orderId)
  assert.equal(balance, 50_000)
})

test('B08：付清后余额方向变为 settled，界面口径不显示负尾款', async () => {
  const product = await seedProduct(db, { entityId: 'b08-settled', name: '结清品', trackingMode: 'quantity' })
  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b08-settled',
    lines: [newLine(product.entityId, 48_000)],
  })
  const converted = await convert(a, quoteId, revision, { requestId: 'b08-settled-conv' })
  const orderId = converted.body.data.entityId

  await pay(a, orderId, 48_000, 'b08-settled-pay')
  const detail = await json(await a.get(`/api/v2/sales/orders/${encodeURIComponent(orderId)}`))
  assert.equal(detail.body.data.order.balanceCents, 0)
  assert.equal(detail.body.data.order.balanceDirection, 'settled')
  assert.equal(detail.body.data.order.isFullyPaid, true)
})

// ─────────────────────────── B05 预留（含放行证据） ───────────────────────────

test('未付款不预留：收款前确认成交被拒绝，实物保持可取', async () => {
  const product = await seedProduct(db, { entityId: 'b05-nopay', name: '未付款品', trackingMode: 'quantity' })
  const itemId = await seedStockItem({ id: 'si-b05-nopay', productId: product.hardwareId, assetCode: 'AC-NOPAY-1' })
  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b05-nopay',
    lines: [usedLine(itemId, 100_000)],
  })
  const converted = await convert(a, quoteId, revision, { requestId: 'b05-nopay-conv' })
  const orderId = converted.body.data.entityId

  const denied = await confirm(a, orderId, 'b05-nopay-confirm')
  assert.equal(denied.status, 400, JSON.stringify(denied.body))
  assert.equal(denied.body.error.code, 'VALIDATION_ERROR')
  assert.match(denied.body.error.message, /未付款不预留|定金/)

  const availability = await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId)
  assert.equal(availability, 'available')
  const reservations = await scalar('SELECT COUNT(*) FROM stock_reservations WHERE order_ref = ?', orderId)
  assert.equal(reservations, 0)
  const tradeState = await scalar('SELECT trade_state FROM sale_orders WHERE id = ?', orderId)
  assert.equal(tradeState, 'draft')
})

test('收到定金后确认成交：占用成立、实物转 reserved、履约状态不变（B05 只锁货不装机）', async () => {
  const product = await seedProduct(db, { entityId: 'b05-ok', name: '正常品', trackingMode: 'quantity' })
  const itemId = await seedStockItem({ id: 'si-b05-ok', productId: product.hardwareId, assetCode: 'AC-OK-1' })
  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b05-ok',
    lines: [usedLine(itemId, 100_000)],
  })
  const converted = await convert(a, quoteId, revision, { requestId: 'b05-ok-conv' })
  const orderId = converted.body.data.entityId

  const orderTerms = JSON.parse(await scalar('SELECT terms_snapshot FROM sale_orders WHERE id = ?', orderId))
  const lineWarranty = JSON.parse(await scalar('SELECT warranty_snapshot FROM sale_lines WHERE sale_order_id = ?', orderId))
  assert.ok(orderTerms.warrantyPolicyLines.some((line) => line.includes('延保') && line.includes('暂未开放选购')))
  assert.equal(lineWarranty.months, 1, '订单商品保修来自已发报价的行快照')
  const detailBeforePayment = await json(await a.get(`/api/v2/sales/orders/${encodeURIComponent(orderId)}`))
  assert.ok(detailBeforePayment.body.data.warrantyPolicyLines.some((line) => line.includes('延保')))
  assert.deepEqual(detailBeforePayment.body.data.lines[0].warrantySnapshot, lineWarranty)

  const paid = await pay(a, orderId, 15_000, 'b05-ok-pay')
  assert.equal(paid.status, 200, JSON.stringify(paid.body))

  const confirmed = await confirm(a, orderId, 'b05-ok-confirm')
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
  assert.equal(confirmed.body.data.state, 'confirmed')
  assert.equal(confirmed.body.data.effects.reservedCount, 1)

  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId), 'reserved')
  assert.equal(await scalar('SELECT COUNT(*) FROM stock_reservations WHERE stock_item_id = ? AND status = ?', itemId, 'active'), 1)
  assert.equal(await scalar('SELECT trade_state FROM sale_orders WHERE id = ?', orderId), 'confirmed')
  // 履约阶段不动：B05 只锁货，备料与装机是 B06。
  assert.equal(await scalar('SELECT fulfillment_state FROM sale_orders WHERE id = ?', orderId), 'waiting_stock')
  // 库存流水与余额同步
  assert.equal(await scalar('SELECT COUNT(*) FROM inventory_movements WHERE stock_item_id = ? AND source = ?', itemId, 'reservation'), 1)
  assert.equal(await scalar(
    'SELECT reserved_qty FROM stock_balances WHERE store_id = 1 AND product_id = ? AND location_id = ?',
    product.hardwareId,
    'store',
  ), 1)
})

test('B05：预付款固定 15%，不足一分按分向上取整且未核实收款不达门槛', async () => {
  const product = await seedProduct(db, { entityId: 'b05-rounding', name: '定金边界品', trackingMode: 'quantity' })
  const itemId = await seedStockItem({ id: 'si-b05-rounding', productId: product.hardwareId, assetCode: 'AC-ROUND-1' })
  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b05-rounding',
    lines: [usedLine(itemId, 10_001)],
  })
  const converted = await convert(a, quoteId, revision, { requestId: 'b05-rounding-conv' })
  const orderId = converted.body.data.entityId
  assert.equal(converted.status, 200, JSON.stringify(converted.body))

  const pending = await json(await a.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/payments`, {
    requestId: 'b05-rounding-pending', amountCents: 1_501, method: 'wechat', verificationState: 'unverified',
  }))
  assert.equal(pending.status, 200, JSON.stringify(pending.body))
  assert.match(pending.body.data.summary, /待核实.*未计入已收/)
  assert.equal(await scalar('SELECT cash_net_cents FROM sale_orders WHERE id = ?', orderId), 0)
  assert.equal(await scalar('SELECT balance_cents FROM sale_orders WHERE id = ?', orderId), 10_001)
  assert.equal(await scalar('SELECT verified_at FROM cash_entries WHERE sale_order_id = ?', orderId), null)
  const pendingConfirm = await confirm(a, orderId, 'b05-rounding-confirm-pending')
  assert.equal(pendingConfirm.status, 400, JSON.stringify(pendingConfirm.body))
  assert.match(pendingConfirm.body.error.message, /定金/)

  const under = await pay(a, orderId, 1_500, 'b05-rounding-under')
  assert.equal(under.status, 200, JSON.stringify(under.body))
  const underConfirm = await confirm(a, orderId, 'b05-rounding-confirm-under')
  assert.equal(underConfirm.status, 400, JSON.stringify(underConfirm.body))
  assert.match(underConfirm.body.error.message, /定金/)

  const lastCent = await pay(a, orderId, 1, 'b05-rounding-last-cent')
  assert.equal(lastCent.status, 200, JSON.stringify(lastCent.body))
  const confirmed = await confirm(a, orderId, 'b05-rounding-confirm')
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
  assert.equal(confirmed.body.data.effects.requiredDepositCents, 1_501)
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId), 'reserved')
})

test('放行证据：两个订单抢最后一件实物 —— 只一单预留成功，失败单的收款仍留账', async () => {
  const product = await seedProduct(db, { entityId: 'b05-race', name: '争抢品', trackingMode: 'quantity' })
  const itemId = await seedStockItem({ id: 'si-b05-race', productId: product.hardwareId, assetCode: 'AC-RACE-1' })

  // 两份报价都在实物可取时发出并转单（B03 的预检此时都能过）
  const first = await createIssuedQuote(a, { requestId: 'b05-race-a', lines: [usedLine(itemId, 100_000)] })
  const second = await createIssuedQuote(a, { requestId: 'b05-race-b', lines: [usedLine(itemId, 100_000)] })
  const orderA = (await convert(a, first.quoteId, first.revision, { requestId: 'b05-race-a-conv' })).body.data.entityId
  const orderB = (await convert(a, second.quoteId, second.revision, { requestId: 'b05-race-b-conv' })).body.data.entityId

  // 两单都先收了定金 —— 钱都已经进账
  assert.equal((await pay(a, orderA, 15_000, 'b05-race-a-pay')).status, 200)
  assert.equal((await pay(a, orderB, 15_000, 'b05-race-b-pay')).status, 200)

  const winA = await confirm(a, orderA, 'b05-race-a-confirm')
  assert.equal(winA.status, 200, JSON.stringify(winA.body))

  const loseB = await confirm(a, orderB, 'b05-race-b-confirm')
  assert.equal(loseB.status, 409, JSON.stringify(loseB.body))
  assert.equal(loseB.body.error.code, 'STOCK_CONFLICT')

  // 一单成功一单失败
  assert.equal(await scalar('SELECT trade_state FROM sale_orders WHERE id = ?', orderA), 'confirmed')
  assert.equal(await scalar('SELECT trade_state FROM sale_orders WHERE id = ?', orderB), 'draft')
  assert.equal(await scalar('SELECT COUNT(*) FROM stock_reservations WHERE stock_item_id = ? AND status = ?', itemId, 'active'), 1)

  // 关键：失败那一单已经收过的钱必须还在账上（收款与预留是两次独立 batch）
  assert.equal(await scalar('SELECT cash_net_cents FROM sale_orders WHERE id = ?', orderB), 15_000)
  assert.equal(await scalar('SELECT COUNT(*) FROM cash_entries WHERE sale_order_id = ?', orderB), 1)
  assert.equal(await scalar('SELECT balance_cents FROM sale_orders WHERE id = ?', orderB), 85_000)
})

test('补分配（B05 allocate）：为缺口行指定实物后可再占用，不改变交易状态', async () => {
  const product = await seedProduct(db, { entityId: 'b05-alloc', name: '补分配品', trackingMode: 'item', requiresSn: 1 })
  const itemId = await seedStockItem({ id: 'si-b05-alloc', productId: product.hardwareId, assetCode: 'AC-ALLOC-1', condition: 'new' })
  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b05-alloc',
    lines: [newLine(product.entityId, 120_000)],
  })
  const converted = await convert(a, quoteId, revision, { requestId: 'b05-alloc-conv' })
  const orderId = converted.body.data.entityId
  await pay(a, orderId, 20_000, 'b05-alloc-pay')

  // 先确认成交：这一行的新品没指定实物，所以本次占用 0 件（记为缺口）
  const confirmed = await confirm(a, orderId, 'b05-alloc-confirm')
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
  assert.equal(confirmed.body.data.effects.reservedCount, 0)

  // 再补分配：指定具体实物
  const allocated = await json(await a.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/allocate`, {
    requestId: 'b05-alloc-allocate',
    allocationChoices: [{ position: 0, stockItemId: itemId }],
  }))
  assert.equal(allocated.status, 200, JSON.stringify(allocated.body))
  assert.equal(allocated.body.data.state, null)
  assert.equal(allocated.body.data.effects.reservedCount, 1)
  assert.equal(await scalar('SELECT trade_state FROM sale_orders WHERE id = ?', orderId), 'confirmed')
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId), 'reserved')
})

// ──────────── 数量件预留（硬边界③对「按数量卖的新品」也生效） ────────────

test('数量件：付定金后锁住库存（available → reserved），不再是「付了钱也锁不住」', async () => {
  const product = await seedProduct(db, { entityId: 'b05-qty', name: '内存条 16G', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 5, 'b05-qty-stock')

  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b05-qty',
    lines: [newLine(product.entityId, 30_000, 2)],
  })
  const converted = await convert(a, quoteId, revision, { requestId: 'b05-qty-conv' })
  const orderId = converted.body.data.entityId

  // 未付款：一件都不许锁（R07 对数量件同样有效）
  const denied = await confirm(a, orderId, 'b05-qty-nopay')
  assert.equal(denied.status, 400, JSON.stringify(denied.body))
  assert.equal((await readBalance(product.hardwareId)).reserved_qty, 0)

  assert.equal((await pay(a, orderId, 10_000, 'b05-qty-pay')).status, 200)
  const confirmed = await confirm(a, orderId, 'b05-qty-confirm')
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
  assert.equal(confirmed.body.data.effects.reservedQty, 2)
  assert.equal(confirmed.body.data.effects.reservedCount, 0, '数量件不是逐件实物，reservedCount 为 0')

  const balance = await readBalance(product.hardwareId)
  assert.equal(balance.available_qty, 3, '可用量 5 − 2')
  assert.equal(balance.reserved_qty, 2)
  // 占用记录带数量桶引用（契约 Reservation.quantityBucketRef「数量件占用时必填」）
  assert.equal(
    await scalar(
      `SELECT qty FROM stock_reservations WHERE order_ref = ? AND status = 'active' AND quantity_bucket_ref = 'store'`,
      orderId,
    ),
    2,
  )
  assert.equal(
    await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE source = 'reservation' AND product_id = ? AND stock_item_id IS NULL`, product.hardwareId),
    1,
  )
})

test('数量件：库存不够时只锁能锁的，差额留在缺口里，不等于整单失败', async () => {
  const product = await seedProduct(db, { entityId: 'b05-qty-short', name: '硬盘 1T', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 1, 'b05-qty-short-stock')

  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b05-qty-short',
    lines: [newLine(product.entityId, 40_000, 3)],
  })
  const orderId = (await convert(a, quoteId, revision, { requestId: 'b05-qty-short-conv' })).body.data.entityId
  await pay(a, orderId, 30_000, 'b05-qty-short-pay')

  const confirmed = await confirm(a, orderId, 'b05-qty-short-confirm')
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
  assert.equal(confirmed.body.data.effects.reservedQty, 1, '库里只有 1 件，先锁 1 件')

  const detail = await json(await a.get(`/api/v2/sales/orders/${encodeURIComponent(orderId)}`))
  assert.equal(detail.body.data.shortage.length, 1)
  assert.equal(detail.body.data.shortage[0].qty, 3)
  assert.equal(detail.body.data.shortage[0].reservedQty, 1, '已锁 1 件')
  assert.equal(detail.body.data.shortage[0].shortageQty, 2, '差 2 件才是真缺口 —— 采购别买多')
})

test('数量件：确认成交后再走补分配，不会把已经锁住的数量又锁一遍', async () => {
  const product = await seedProduct(db, { entityId: 'b05-qty-again', name: '机箱风扇', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 4, 'b05-qty-again-stock')

  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b05-qty-again',
    lines: [newLine(product.entityId, 5_000, 2)],
  })
  const orderId = (await convert(a, quoteId, revision, { requestId: 'b05-qty-again-conv' })).body.data.entityId
  await pay(a, orderId, 5_000, 'b05-qty-again-pay')

  assert.equal((await confirm(a, orderId, 'b05-qty-again-confirm')).body.data.effects.reservedQty, 2)

  // 再点一次「确认成交」：状态已经不是草稿，明确拒绝 —— 而不是静默重复占用
  const denied = await confirm(a, orderId, 'b05-qty-again-confirm2')
  assert.equal(denied.status, 400, JSON.stringify(denied.body))
  assert.match(denied.body.error.message, /草稿/)

  // 补分配走的是同一段 plan，会重新算一遍数量件候选 —— 已经锁住的 2 件必须扣掉
  const allocated = await json(
    await a.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/allocate`, { requestId: 'b05-qty-again-alloc' }),
  )
  assert.equal(allocated.status, 200, JSON.stringify(allocated.body))
  assert.equal(allocated.body.data.effects.reservedQty, 0, '已经锁住 2 件，补分配不该再锁一遍')

  const balance = await readBalance(product.hardwareId)
  assert.equal(balance.available_qty, 2)
  assert.equal(balance.reserved_qty, 2)
})

test('放行证据：两单抢同一批数量件 —— 各锁各的，谁也不失败（同型号可替换）', async () => {
  const product = await seedProduct(db, { entityId: 'b05-qty-race', name: '抢手内存', trackingMode: 'quantity' })
  await seedQuantityStock(product.hardwareId, 3, 'b05-qty-race-stock')

  const first = await createIssuedQuote(a, { requestId: 'b05-qty-race-a', lines: [newLine(product.entityId, 30_000, 2)] })
  const second = await createIssuedQuote(a, { requestId: 'b05-qty-race-b', lines: [newLine(product.entityId, 30_000, 2)] })
  const orderA = (await convert(a, first.quoteId, first.revision, { requestId: 'b05-qty-race-a-conv' })).body.data.entityId
  const convB = await convert(a, second.quoteId, second.revision, { requestId: 'b05-qty-race-b-conv' })
  assert.equal(convB.status, 200, JSON.stringify(convB.body))
  const orderB = convB.body.data.entityId
  // 两个 requestId 只差尾部一个字母：订单号必须仍然不同。
  // （旧实现只取 requestId 去掉符号后的前 8 个字符，这里必然撞号，撞的是 UNIQUE (store_id, order_no)）
  assert.notEqual(
    await scalar('SELECT order_no FROM sale_orders WHERE id = ?', orderA),
    await scalar('SELECT order_no FROM sale_orders WHERE id = ?', orderB),
    '订单号不能靠 requestId 的前 8 位派生',
  )
  await pay(a, orderA, 10_000, 'b05-qty-race-a-pay')
  await pay(a, orderB, 10_000, 'b05-qty-race-b-pay')

  const winA = await confirm(a, orderA, 'b05-qty-race-a-confirm')
  assert.equal(winA.status, 200, JSON.stringify(winA.body))
  assert.equal(winA.body.data.effects.reservedQty, 2)

  const winB = await confirm(a, orderB, 'b05-qty-race-b-confirm')
  assert.equal(winB.status, 200, JSON.stringify(winB.body))
  assert.equal(winB.body.data.effects.reservedQty, 1, '只剩 1 件，锁 1 件，另一件进缺口')

  const balance = await readBalance(product.hardwareId)
  assert.equal(balance.available_qty, 0, '3 件全被锁走，一件不剩')
  assert.equal(balance.reserved_qty, 3)
  assert.equal(await scalar('SELECT trade_state FROM sale_orders WHERE id = ?', orderA), 'confirmed')
  assert.equal(
    await scalar('SELECT trade_state FROM sale_orders WHERE id = ?', orderB),
    'confirmed',
    'B 单不该因为抢不到而失败 —— 数量件同型号可替换，抢不到就是缺货，不是冲突',
  )
})

test('回归：公共前缀的顺序 requestId 不会撞订单号（旧实现只取前 8 个字符，这里必撞）', async () => {
  const product = await seedProduct(db, { entityId: 'b03-orderno', name: '订单号品', trackingMode: 'quantity' })
  const quotA = await createIssuedQuote(a, {
    requestId: 'req-20260921-001',
    lines: [newLine(product.entityId, 10_000)],
  })
  const quotB = await createIssuedQuote(a, {
    requestId: 'req-20260921-002',
    lines: [newLine(product.entityId, 10_000)],
  })

  const convertedA = await convert(a, quotA.quoteId, quotA.revision, { requestId: 'conv-20260921-001' })
  const convertedB = await convert(a, quotB.quoteId, quotB.revision, { requestId: 'conv-20260921-002' })
  assert.equal(convertedA.status, 200, JSON.stringify(convertedA.body))
  assert.equal(convertedB.status, 200, JSON.stringify(convertedB.body))

  const noA = await scalar('SELECT order_no FROM sale_orders WHERE id = ?', convertedA.body.data.entityId)
  const noB = await scalar('SELECT order_no FROM sale_orders WHERE id = ?', convertedB.body.data.entityId)
  assert.notEqual(noA, noB, '去掉横线后前 8 位相同的两个 requestId 必须得到不同订单号')
  assert.match(noA, /^SO-\d{8}-[0-9A-F]{8}$/, '订单号格式：SO-日期-8 位十六进制')
})

test('已取消的销售单不能占用库存；跨店访问一律 404', async () => {
  const product = await seedProduct(db, { entityId: 'b05-cancel', name: '取消品', trackingMode: 'quantity' })
  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'b05-cancel',
    lines: [newLine(product.entityId, 70_000)],
  })
  const converted = await convert(a, quoteId, revision, { requestId: 'b05-cancel-conv' })
  const orderId = converted.body.data.entityId
  await pay(a, orderId, 70_000, 'b05-cancel-pay')
  await db.prepare(`UPDATE sale_orders SET trade_state = 'cancelled' WHERE id = ?`).bind(orderId).run()

  const denied = await confirm(a, orderId, 'b05-cancel-confirm')
  assert.equal(denied.status, 400)
  assert.match(denied.body.error.message, /取消|关闭/)

  const crossStore = await json(await b.get(`/api/v2/sales/orders/${encodeURIComponent(orderId)}`))
  assert.equal(crossStore.status, 404)
  assert.equal(crossStore.body.error.code, 'ENTITY_NOT_FOUND')
})

// ─────────────────────────── 列表读模型 ───────────────────────────

test('R04：列表返回待收金额与缺口数，可按交易状态筛选', async () => {
  const list = await json(await a.get('/api/v2/sales/orders?limit=200'))
  assert.equal(list.status, 200, JSON.stringify(list.body))
  assert.ok(list.body.data.orders.length > 0)
  assert.ok(list.body.data.totals.all >= list.body.data.orders.length - 200)
  assert.equal(typeof list.body.data.totals.receivableCents, 'number')
  assert.equal(list.body.data.settings.depositPercent > 0, true)

  const drafts = await json(await a.get('/api/v2/sales/orders?tradeState=draft&limit=200'))
  assert.equal(drafts.status, 200)
  assert.ok(drafts.body.data.orders.every((row) => row.tradeState === 'draft'))

  const bad = await json(await a.get('/api/v2/sales/orders?tradeState=nope'))
  assert.equal(bad.status, 400)
})
