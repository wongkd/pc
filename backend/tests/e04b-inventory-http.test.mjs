/**
 * E04b · 库存与商品的 HTTP 接线（/api/v2/inventory/*）。
 *
 * 走真实 Worker 入口 + 真实 D1，覆盖四层：
 *   1. 入口层：路由正则、鉴权、权限、405/404；
 *   2. 权限层：新权限码本身、契约声明的旧码映射（library/view → inventory/view 等）、
 *      以及 noWidening —— 旧 library/edit **不得**换来期初录入能力；
 *   3. 口径层：无成本权限时响应里根本没有成本键（不是置空）；未知成本是 null 不是 0；
 *   4. 事务层：同 requestId 复用、改载荷冲突、版本冲突、跨店 404 且不落库。
 *
 * 本卡的领域逻辑已在 t05a-* 里测过，这里只测「接口接得对不对」。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER_A = { email: 'inv-owner-a@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: '库存门店甲' }
const OWNER_B = { email: 'inv-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: '库存门店乙' }

let env
let db
let a
let b
/** 无任何权限的店员（门店甲） */
let clerk
/** 只有旧码 library/view + library/edit 的店员（门店甲） */
let legacyClerk
/** 只有 inventory/view 的店员（门店甲） */
let viewOnlyClerk
/** inventory/view + inventory/cost-view 的店员（门店甲） */
let costClerk

async function json(response) {
  return { status: response.status, body: await response.json() }
}

/**
 * 播一个店员，并按需要授予权限码。
 * 权限表在生产无种子迁移（legacy-mapping Q04），所以这里显式建权限行，不依赖任何既有数据。
 */
async function seedClerk({ userId, email, storeId = 1, permissions = [], owner = 1 }) {
  await db.prepare(`INSERT INTO users (id, email, password_hash, status) VALUES (?, ?, ?, 'active')`)
    .bind(userId, email, await legacyPasswordHash(PASSWORD)).run()
  const member = await db.prepare(`INSERT INTO store_members (store_id, user_id, status, is_owner, created_by, updated_by)
    VALUES (?, ?, 'active', 0, ?, ?)`).bind(storeId, userId, owner, owner).run()
  const memberId = member.meta.last_row_id
  if (!permissions.length) return { email, password: PASSWORD, memberId }
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
  return { email, password: PASSWORD, memberId }
}

/** 建一个商品并返回 { entityId, version }。走真实接口，不用测试专用后门。 */
async function createProduct(client, body, requestId) {
  const response = await client.post('/api/v2/inventory/products', { ...body, requestId })
  const text = await response.text()
  assert.equal(response.status, 200, `建档失败（${response.status}）：${text}`)
  const payload = JSON.parse(text)
  return { entityId: payload.data.entityId, version: payload.data.entityVersion }
}

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER_A)
  await seedOwner(db, OWNER_B)
  await seedClerk({ userId: 3, email: 'inv-clerk-none@local.test' })
  await seedClerk({ userId: 4, email: 'inv-clerk-legacy@local.test', permissions: ['library/view', 'library/edit'] })
  await seedClerk({ userId: 5, email: 'inv-clerk-view@local.test', permissions: ['inventory/view'] })
  await seedClerk({ userId: 6, email: 'inv-clerk-cost@local.test', permissions: ['inventory/view', 'inventory/cost-view'] })

  a = createClient(env.call, await login(env.call, OWNER_A))
  b = createClient(env.call, await login(env.call, OWNER_B))
  clerk = createClient(env.call, await login(env.call, { email: 'inv-clerk-none@local.test', password: PASSWORD }))
  legacyClerk = createClient(env.call, await login(env.call, { email: 'inv-clerk-legacy@local.test', password: PASSWORD }))
  viewOnlyClerk = createClient(env.call, await login(env.call, { email: 'inv-clerk-view@local.test', password: PASSWORD }))
  costClerk = createClient(env.call, await login(env.call, { email: 'inv-clerk-cost@local.test', password: PASSWORD }))

  // 门店甲先有一个计数商品（走接口建），后面读、期初、跨店都以它为中心。
  await createProduct(a, { name: '演示显卡 RTX-E04B', sku: 'GPU-E04B', category: '显卡', brand: '影驰', trackingMode: 'quantity', requiresSn: false, defaultSalePriceCents: 259900 }, 'req-inv-setup-1')
})

after(async () => {
  await env?.dispose()
})

// ────────────────────────────── 鉴权与权限 ──────────────────────────────

test('未登录访问库存接口被挡在鉴权之外', async () => {
  assert.equal((await json(await env.call('/api/v2/inventory'))).status, 401)
  assert.equal((await json(await env.call('/api/v2/inventory/products', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '越权', trackingMode: 'quantity', requiresSn: false, requestId: 'x' }),
  }))).status, 401)
})

test('没有任何权限的店员：三个入口全部 403', async () => {
  assert.equal((await json(await clerk.get('/api/v2/inventory'))).status, 403)
  assert.equal((await json(await clerk.post('/api/v2/inventory/products', {
    name: '越权商品', trackingMode: 'quantity', requiresSn: false, requestId: 'req-deny-1',
  }))).status, 403)
  assert.equal((await json(await clerk.post('/api/v2/inventory/openings', {
    approvedCountRef: '越权期初', lines: [], requestId: 'req-deny-2',
  }))).status, 403)
})

test('403 是契约信封：code 为 PERMISSION_DENIED，客户端按 code 分支', async () => {
  const { body } = await json(await clerk.get('/api/v2/inventory'))
  assert.equal(body.error.code, 'PERMISSION_DENIED')
  assert.equal(body.error.retryable, false)
  assert.equal(body.meta.contractVersion, 'v2')
})

test('契约里 library/view 映射到库存读权限，旧码店员读得到', async () => {
  const { status, body } = await json(await legacyClerk.get('/api/v2/inventory'))
  assert.equal(status, 200, JSON.stringify(body))
  assert.ok(Array.isArray(body.data.items) && body.data.items.length >= 1)
})

test('noWidening：旧 library/edit 换不到期初录入（老板专属）', async () => {
  assert.equal((await json(await legacyClerk.get('/api/v2/inventory'))).status, 200)
  const opening = await json(await legacyClerk.post('/api/v2/inventory/openings', {
    approvedCountRef: '旧码越权期初', lines: [], requestId: 'req-nowiden-1',
  }))
  assert.equal(opening.status, 403, JSON.stringify(opening.body))
})

test('只有 inventory/view 的店员写不了商品', async () => {
  assert.equal((await json(await viewOnlyClerk.get('/api/v2/inventory'))).status, 200)
  assert.equal((await json(await viewOnlyClerk.post('/api/v2/inventory/products', {
    name: '只读越权', trackingMode: 'quantity', requiresSn: false, requestId: 'req-readonly-1',
  }))).status, 403)
})

// ────────────────────────────── 成本字段 ──────────────────────────────

test('无成本权限时响应里没有成本键，而不是置空为 0', async () => {
  const withoutCost = (await json(await legacyClerk.get('/api/v2/inventory'))).body.data
  assert.equal('totalCostCents' in withoutCost.items[0], false, '无权时不得出现 totalCostCents')
  assert.equal('costKnown' in withoutCost.items[0], false)

  const withCost = (await json(await costClerk.get('/api/v2/inventory'))).body.data
  assert.equal('totalCostCents' in withCost.items[0], true)
  assert.equal('costKnown' in withCost.items[0], true)
})

test('未知成本返回 null + costKnown=false，不写成 0', async () => {
  const { entityId } = await createProduct(a, { name: '演示主板 B760-E04B', sku: 'MB-E04B', category: '主板', trackingMode: 'quantity', requiresSn: false }, 'req-inv-setup-2')
  const opening = await json(await a.post('/api/v2/inventory/openings', {
    approvedCountRef: '实盘 2026-09-19 主板',
    costBasis: { kind: 'unknown', note: '早批进货单已丢' },
    lines: [{ productRef: entityId, qty: 2 }],
    requestId: 'req-inv-opening-unknown',
  }))
  assert.equal(opening.status, 200, JSON.stringify(opening.body))

  const rows = (await json(await a.get('/api/v2/inventory?q=MB-E04B'))).body.data.items
  assert.equal(rows.length, 1)
  assert.equal(rows[0].availableQty, 2)
  assert.equal(rows[0].totalCostCents, null, '未知成本必须是 null')
  assert.equal(rows[0].costKnown, false, 'costKnown=false 时前端显示「成本未知」')
})

// ────────────────────────────── 读模型口径 ──────────────────────────────

test('型号汇总带分类、品牌、管理方式与默认售价', async () => {
  const rows = (await json(await a.get('/api/v2/inventory?q=GPU-E04B'))).body.data.items
  assert.equal(rows.length, 1)
  assert.equal(rows[0].category, '显卡')
  assert.equal(rows[0].brand, '影驰', '品牌来自 product_brands 关联，不是自由文本猜测')
  assert.equal(rows[0].trackingMode, 'quantity')
  assert.equal(rows[0].requiresSn, false)
  assert.equal(rows[0].defaultSalePriceCents, 259900)
  assert.equal(rows[0].version, 1, '界面要拿它当 expectedVersion，不能靠猜')
})

test('q 与 productRef 都能收窄结果', async () => {
  const byQuery = (await json(await a.get('/api/v2/inventory?q=演示'))).body.data
  assert.ok(byQuery.items.length >= 2)
  const byRef = (await json(await a.get('/api/v2/inventory?productRef=no-such-ref'))).body.data
  assert.equal(byRef.items.length, 0)
})

test('非法筛选参数被拒，不静默忽略', async () => {
  assert.equal((await json(await a.get('/api/v2/inventory?condition=refurbished'))).status, 400)
  assert.equal((await json(await a.get('/api/v2/inventory?availability=lost'))).status, 400)
  assert.equal((await json(await a.get('/api/v2/inventory?limit=abc'))).status, 400)
})

test('仓库操作日志对库存可见成员开放，并按门店隔离且不返回成本', async () => {
  const visible = await json(await viewOnlyClerk.get('/api/v2/inventory/activity'))
  assert.equal(visible.status, 200)
  assert.ok(visible.body.data.items.length > 0)
  assert.ok(visible.body.data.items.some((item) => item.action === 'B12' && item.kind === 'operation'))
  assert.ok(visible.body.data.items.every((item) => !('costCents' in item) && !('unitCostCents' in item)))

  const denied = await json(await clerk.get('/api/v2/inventory/activity'))
  assert.equal(denied.status, 403)

  const otherStore = await json(await b.get('/api/v2/inventory/activity'))
  assert.equal(otherStore.status, 200)
  assert.deepEqual(otherStore.body.data.items, [])
})

test('实物详情按 ID 可查；跨店与不存在一律 404 且不泄露', async () => {
  const item = await json(await a.post('/api/v2/inventory/openings', {
    approvedCountRef: '实盘 2026-09-19 逐件',
    costBasis: { kind: 'known' },
    lines: [{ productRef: (await json(await a.get('/api/v2/inventory?q=GPU-E04B'))).body.data.items[0].id, qty: 1, condition: 'used', assetCode: 'E04B-U-001', snRaw: 'SN E04B 001', unitCostCents: 120000 }],
    requestId: 'req-inv-opening-item',
  }))
  assert.equal(item.status, 400, '数量件不得带内部编号，这一条由领域的守卫拦下')

  // 建一个逐件商品再入期初
  const { entityId } = await createProduct(a, { name: '演示二手显卡 3080', sku: 'GPU-USED-3080', category: '显卡', brand: '影驰', trackingMode: 'item', requiresSn: true }, 'req-inv-setup-3')
  const perItem = await json(await a.post('/api/v2/inventory/openings', {
    approvedCountRef: '实盘 2026-09-19 二手卡',
    costBasis: { kind: 'known' },
    lines: [{ productRef: entityId, qty: 1, condition: 'used', assetCode: 'E04B-U-001', snRaw: 'SN E04B 001', unitCostCents: 120000 }],
    requestId: 'req-inv-opening-item-2',
  }))
  assert.equal(perItem.status, 200, JSON.stringify(perItem.body))

  const detail = await json(await a.get('/api/v2/inventory?productRef=' + encodeURIComponent(entityId)))
  const stockItemId = detail.body.data.lotItems[0].id
  const one = await json(await a.get(`/api/v2/inventory/items/${encodeURIComponent(stockItemId)}`))
  assert.equal(one.status, 200, JSON.stringify(one.body))
  assert.equal(one.body.data.item.assetCode, 'E04B-U-001')
  assert.equal(one.body.data.item.condition, 'used')

  const cross = await json(await b.get(`/api/v2/inventory/items/${encodeURIComponent(stockItemId)}`))
  assert.equal(cross.status, 404, '别家门店的实物必须 404')
  assert.equal(cross.body.error.code, 'ENTITY_NOT_FOUND')
  assert.equal((await json(await a.get('/api/v2/inventory/items/not-a-real-id'))).status, 404)
})

test('别家门店的型号读不到，跨店写入也不会落到本店', async () => {
  const theirRows = (await json(await b.get('/api/v2/inventory?q=GPU-E04B'))).body.data
  assert.equal(theirRows.items.length, 0, '店乙不该看到店甲的型号')
  const crossOpening = await json(await b.post('/api/v2/inventory/openings', {
    approvedCountRef: '跨店期初',
    lines: [{ productRef: (await json(await a.get('/api/v2/inventory?q=GPU-E04B'))).body.data.items[0].id, qty: 1 }],
    requestId: 'req-inv-cross-1',
  }))
  assert.equal(crossOpening.status, 404, '猜到别家的型号 ID 也只能是 404')
  const stillZero = await db.prepare(`SELECT COUNT(*) AS n FROM inventory_movements WHERE store_id = 2`).first()
  assert.equal(stillZero.n, 0, '跨店请求不得在店乙留下任何流水')
})

// ────────────────────────────── 商品建档的写入约定 ──────────────────────────────

test('建档返回 operationId 与实体版本，并把分类品牌链接进商品主数据', async () => {
  const response = await a.post('/api/v2/inventory/products', {
    name: '演示内存 DDR5-E04B', sku: 'RAM-E04B', category: '内存', brand: '金百达',
    trackingMode: 'quantity', requiresSn: false, defaultSalePriceCents: 39900, requestId: 'req-inv-write-1',
  })
  const payload = await json(response)
  assert.equal(payload.status, 200, JSON.stringify(payload.body))
  assert.equal(payload.body.data.operationId, 'req-inv-write-1')
  assert.equal(payload.body.data.entityVersion, 1)

  const row = await db.prepare(`SELECT h.category, h.default_price_cents, h.tracking_mode, h.requires_sn,
      pc.name AS category_name, pb.name AS brand_name
    FROM hardware h
    LEFT JOIN product_categories pc ON pc.id = h.category_id
    LEFT JOIN product_brands pb ON pb.id = h.brand_id
    WHERE h.store_id = 1 AND h.entity_id = ?`).bind(payload.body.data.entityId).first()
  assert.equal(row.category, '内存')
  assert.equal(row.category_name, '内存', 'B12 建档必须同时链接 product_categories，否则旧商品页显示「未分类」')
  assert.equal(row.brand_name, '金百达', '品牌同样要链接 product_brands')
  assert.equal(row.default_price_cents, 39900)
})

test('缺 requestId、或幂等头与 body 不一致时拒绝', async () => {
  const noId = await json(await a.post('/api/v2/inventory/products', { name: '无 ID', trackingMode: 'quantity', requiresSn: false }))
  assert.equal(noId.status, 400)
  assert.equal(noId.body.error.code, 'VALIDATION_ERROR')

  const mismatch = await json(await env.call('/api/v2/inventory/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await login(env.call, OWNER_A)}`, 'Idempotency-Key': 'req-header-x' },
    body: JSON.stringify({ name: '头不一致', trackingMode: 'quantity', requiresSn: false, requestId: 'req-body-y' }),
  }))
  assert.equal(mismatch.status, 400, JSON.stringify(mismatch.body))
})

test('同 requestId 同载荷复用结果，不改载荷换 ID 会撞 IDEMPOTENCY_MISMATCH', async () => {
  const body = { name: '演示电源 650W-E04B', sku: 'PSU-E04B', category: '电源', trackingMode: 'quantity', requiresSn: false, requestId: 'req-inv-idem-1' }
  const first = await json(await a.post('/api/v2/inventory/products', body))
  const second = await json(await a.post('/api/v2/inventory/products', body))
  assert.equal(first.status, 200)
  assert.equal(second.status, 200, '同 ID 同载荷必须复用，不能报错')
  assert.equal(second.body.data.entityId, first.body.data.entityId)

  const rows = await db.prepare(`SELECT COUNT(*) AS n FROM hardware WHERE store_id = 1 AND sku = 'PSU-E04B'`).first()
  assert.equal(rows.n, 1, '复用不得重复建档')

  const changed = await json(await a.post('/api/v2/inventory/products', { ...body, name: '同名不同载荷' }))
  assert.equal(changed.status, 409, JSON.stringify(changed.body))
  assert.equal(changed.body.error.code, 'IDEMPOTENCY_MISMATCH')
})

test('改商品必须带 expectedVersion；B40 暂缓且通用编辑不能改售价', async () => {
  const { entityId } = await createProduct(a, { name: '演示机箱 E04B', sku: 'CASE-E04B', category: '机箱', trackingMode: 'quantity', requiresSn: false }, 'req-inv-edit-0')

  const missing = await json(await a.post('/api/v2/inventory/products', {
    productRef: entityId, name: '演示机箱 E04B 改', trackingMode: 'quantity', requiresSn: false, requestId: 'req-inv-edit-1',
  }))
  assert.equal(missing.status, 400, '不带 expectedVersion 的修改必须拒绝')

  const priceEdit = await json(await a.post('/api/v2/inventory/products', {
    productRef: entityId, expectedVersion: 1, name: '演示机箱 E04B 改', category: '机箱',
    trackingMode: 'quantity', requiresSn: false, defaultSalePriceCents: 19900, requestId: 'req-inv-edit-2',
  }))
  assert.equal(priceEdit.status, 400, JSON.stringify(priceEdit.body))
  assert.match(priceEdit.body.error.message, /B40|售价/)

  const updated = await json(await a.post('/api/v2/inventory/products', {
    productRef: entityId, expectedVersion: 1, name: '演示机箱 E04B 改', category: '机箱',
    trackingMode: 'quantity', requiresSn: false, requestId: 'req-inv-edit-2b',
  }))
  assert.equal(updated.status, 200, JSON.stringify(updated.body))
  assert.equal(updated.body.data.entityVersion, 2)
  const price = await db.prepare('SELECT default_price_cents FROM hardware WHERE store_id = 1 AND entity_id = ?').bind(entityId).first()
  assert.equal(price.default_price_cents, 0, '普通商品资料编辑保留售价')

  const stale = await json(await a.post('/api/v2/inventory/products', {
    productRef: entityId, expectedVersion: 1, name: '演示机箱 E04B 再改', category: '机箱',
    trackingMode: 'quantity', requiresSn: false, requestId: 'req-inv-edit-3',
  }))
  assert.equal(stale.status, 409, JSON.stringify(stale.body))
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT')
})

test('SKU 同店唯一，撞车给出可照做的提示', async () => {
  const duplicate = await json(await a.post('/api/v2/inventory/products', {
    name: '重复 SKU 商品', sku: 'GPU-E04B', category: '显卡', trackingMode: 'quantity', requiresSn: false, requestId: 'req-inv-dupesku-1',
  }))
  assert.equal(duplicate.status, 400, JSON.stringify(duplicate.body))
  assert.equal(duplicate.body.error.code, 'VALIDATION_ERROR')
  // 守卫只带错误码回来，契约兜底文案是「字段无效，或金额不是整数分」——
  // 拦下这条的其实是 SKU 唯一约束，字段本身没有任何问题，所以路由层要补人话。
  assert.match(duplicate.body.error.message, /SKU/)
  assert.match(duplicate.body.error.message, /具体原因.*本店 SKU 已存在/, '响应还必须保留数据库真因')
})

test('领域层已经说清楚的消息不被通用提示顶掉', async () => {
  const { entityId } = await createProduct(a, { name: '演示线材 E04B', sku: 'CABLE-E04B', category: '线材', trackingMode: 'quantity', requiresSn: false }, 'req-inv-msg-0')
  const missingVersion = await json(await a.post('/api/v2/inventory/products', {
    productRef: entityId, name: '演示线材 E04B 改', trackingMode: 'quantity', requiresSn: false, requestId: 'req-inv-msg-1',
  }))
  assert.equal(missingVersion.status, 400)
  assert.match(missingVersion.body.error.message, /expectedVersion/, '这句比通用提示更有用，不能被替换掉')
})

// ────────────────────────────── 期初库存 ──────────────────────────────

test('期初：数量件按数量入库，成本按整数分累计', async () => {
  const { entityId } = await createProduct(a, { name: '演示固态 1TB-E04B', sku: 'SSD-E04B', category: '硬盘', trackingMode: 'quantity', requiresSn: false }, 'req-inv-open-setup')
  const response = await json(await a.post('/api/v2/inventory/openings', {
    approvedCountRef: '实盘 2026-09-19 固态盘',
    costBasis: { kind: 'known', note: '按最后一批进货单' },
    note: '开业前盘点',
    lines: [{ productRef: entityId, qty: 3, unitCostCents: 26000 }],
    requestId: 'req-inv-opening-qty-1',
  }))
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(response.body.data.entityVersion, 1)

  const rows = (await json(await a.get('/api/v2/inventory?q=SSD-E04B'))).body.data.items
  assert.equal(rows[0].availableQty, 3)
  assert.equal(rows[0].totalCostCents, 78000, '3 × 260.00 元 = 780.00 元')
  assert.equal(rows[0].costKnown, true)
  assert.equal(rows[0].ownOnHandQty, 3)
})

test('D10：显式关闭期初入口时拒绝写入且不创建操作记录', async () => {
  const closedEnv = await createWorkerEnv({ bindings: { INVENTORY_OPENING_MODE: 'disabled' } })
  try {
    await seedOwner(closedEnv.db, OWNER_A)
    const owner = createClient(closedEnv.call, await login(closedEnv.call, OWNER_A))
    const result = await json(await owner.post('/api/v2/inventory/openings', {
      requestId: 'req-opening-formal-blocked', approvedCountRef: '首发正式期初', lines: [],
    }))
    assert.equal(result.status, 409, JSON.stringify(result.body))
    assert.match(result.body.error.message, /期初入口未在当前环境启用/)
    const operations = await closedEnv.db.prepare('SELECT COUNT(*) AS n FROM operations WHERE request_id = ?')
      .bind('req-opening-formal-blocked').first()
    assert.equal(operations.n, 0)
  } finally {
    await closedEnv.dispose()
  }
})

test('期初：逐件商品一行一件，内部编号由服务端自动生成', async () => {
  const { entityId } = await createProduct(a, { name: '演示二手本 X1-E04B', sku: 'NB-USED-E04B', category: '笔记本', trackingMode: 'item', requiresSn: true }, 'req-inv-open-setup-2')

  const twoInOne = await json(await a.post('/api/v2/inventory/openings', {
    approvedCountRef: '实盘 逐件两件', lines: [{ productRef: entityId, qty: 2, assetCode: 'E04B-NB-001' }], requestId: 'req-inv-open-item-1',
  }))
  assert.equal(twoInOne.status, 400, '逐件商品一行只能一件')

  const noCode = await json(await a.post('/api/v2/inventory/openings', {
    approvedCountRef: '实盘 逐件自动编号', costBasis: { kind: 'known' },
    lines: [{ productRef: entityId, qty: 1, condition: 'used', unitCostCents: 285000 }], requestId: 'req-inv-open-item-2',
  }))
  assert.equal(noCode.status, 200, JSON.stringify(noCode.body))

  const detail = (await json(await a.get(`/api/v2/inventory?productRef=${encodeURIComponent(entityId)}`))).body.data
  assert.equal(detail.lotItems.length, 1)
  assert.match(detail.lotItems[0].assetCode, /^IT-0001-\d{8}-[0-9A-F]{10}$/)
  assert.equal(detail.lotItems[0].acquisitionCostCents, 285000)
})

test('期初声明成本已知却漏填金额会被拒；声明未知但个别行有金额可以', async () => {
  const { entityId } = await createProduct(a, { name: '演示风扇 E04B', sku: 'FAN-E04B', category: '风扇', trackingMode: 'quantity', requiresSn: false }, 'req-inv-open-setup-3')
  const contradiction = await json(await a.post('/api/v2/inventory/openings', {
    approvedCountRef: '实盘 风扇', costBasis: { kind: 'known' }, lines: [{ productRef: entityId, qty: 2 }], requestId: 'req-inv-open-basis-1',
  }))
  assert.equal(contradiction.status, 400)
  assert.match(contradiction.body.error.message, /成本/)

  const mixed = await json(await a.post('/api/v2/inventory/openings', {
    approvedCountRef: '实盘 风扇 混口径',
    costBasis: { kind: 'unknown', note: '大部分说不清' },
    lines: [{ productRef: entityId, qty: 2, unitCostCents: 3500 }],
    requestId: 'req-inv-open-basis-2',
  }))
  assert.equal(mixed.status, 200, JSON.stringify(mixed.body))
})

test('期初是受控动作：同 requestId 复用，且已有库存事实的商品不能再走期初', async () => {
  const body = {
    approvedCountRef: '实盘 复用期初', lines: [{ productRef: (await json(await a.get('/api/v2/inventory?q=FAN-E04B'))).body.data.items[0].id, qty: 1, unitCostCents: 3500 }],
    requestId: 'req-inv-open-once',
  }
  const first = await json(await a.post('/api/v2/inventory/openings', body))
  assert.equal(first.status, 400, '该型号已有库存事实，重复期初必须被拒')
  // 断言打在「用户能看懂」上：契约的 VALIDATION_ERROR 兜底文案是「字段无效」，
  // 而这里字段没有任何问题 —— 浏览器验收就是被这句误导过一次。
  assert.match(first.body.error.message, /已经有库存事实|期初只能建一次/)
  assert.equal(first.body.error.code, 'VALIDATION_ERROR')

  const { entityId } = await createProduct(a, { name: '演示键鼠 E04B', sku: 'KB-E04B', category: '外设', trackingMode: 'quantity', requiresSn: false }, 'req-inv-open-setup-4')
  const once = { approvedCountRef: '实盘 键鼠', lines: [{ productRef: entityId, qty: 2, unitCostCents: 8000 }], requestId: 'req-inv-open-idem' }
  const created = await json(await a.post('/api/v2/inventory/openings', once))
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const replay = await json(await a.post('/api/v2/inventory/openings', once))
  assert.equal(replay.status, 200, '同 ID 同载荷必须复用')
  assert.equal(replay.body.data.entityId, created.body.data.entityId)

  const movements = await db.prepare(`SELECT COUNT(*) AS n FROM inventory_movements WHERE store_id = 1 AND request_id = 'req-inv-open-idem'`).first()
  assert.equal(movements.n, 1, '复用不得重复记流水')

  const second = await json(await a.post('/api/v2/inventory/openings', {
    approvedCountRef: '实盘 键鼠 第二次', lines: [{ productRef: entityId, qty: 1 }], requestId: 'req-inv-open-idem-2',
  }))
  assert.equal(second.status, 400, '期初不是日常入库的捷径')
})

// ────────────────────────────── 结果未知后的查询 ──────────────────────────────

test('operations 查询：已完成的写动作查得到，未知 ID 返回 unknown', async () => {
  const found = await json(await a.get('/api/v2/operations/req-inv-write-1'))
  assert.equal(found.status, 200)
  assert.equal(found.body.data.status, 'succeeded')
  assert.ok(found.body.data.entityId)

  const missing = await json(await a.get('/api/v2/operations/req-never-happened'))
  assert.equal(missing.status, 200)
  assert.equal(missing.body.data.status, 'unknown')

  // 别家门店查不到本店的 requestId
  const cross = await json(await b.get('/api/v2/operations/req-inv-write-1'))
  assert.equal(cross.body.data.status, 'unknown')
})

// ────────────────────────────── 其它 ──────────────────────────────

test('不支持的方法与不存在的 v2 路径都返回契约错误，不静默 200', async () => {
  const wrongMethod = await json(await a.post('/api/v2/inventory', { requestId: 'x' }))
  assert.equal(wrongMethod.status, 405)
  const unknownPath = await json(await a.get('/api/v2/inventory/unknown-thing'))
  assert.equal(unknownPath.status, 404)
  assert.equal(unknownPath.body.error.code, 'ENTITY_NOT_FOUND')
})

test('旧商品兼容路由仍保留，通用改价受限，library 路由已退役', async () => {
  const legacy = await json(await a.get('/api/products?page=1&pageSize=1'))
  assert.equal(legacy.status, 200, '旧商品接口必须照旧可用')
  assert.ok('items' in legacy.body)
  const product = legacy.body.items[0]
  const originalPrice = await db.prepare('SELECT default_price_cents FROM hardware WHERE id = ?').bind(product.id).first()
  const v1Edit = await json(await a.put(`/api/products/${product.id}`, { defaultPriceCents: 1 }))
  assert.equal(v1Edit.status, 409, JSON.stringify(v1Edit.body))
  assert.match(v1Edit.body.error, /B40.*通用编辑/)

  const library = await json(await a.get('/api/library'))
  assert.equal(library.status, 410)
  assert.equal(library.body.error, '此旧版接口已下线')
  const legacyEdit = await json(await a.put(`/api/library/${product.id}`, { price: 0.01 }))
  assert.equal(legacyEdit.status, 410)
  assert.equal(legacyEdit.body.error, '此旧版接口已下线')
  const storedPrice = await db.prepare('SELECT default_price_cents FROM hardware WHERE id = ?').bind(product.id).first()
  assert.equal(storedPrice.default_price_cents, originalPrice.default_price_cents)
})
