/** U01 · Cross-model, per-item inventory read, full-result facets and scope isolation. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER_A = { email: 'u01-owner-a@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: 'U01 门店甲' }
const OWNER_B = { email: 'u01-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: 'U01 门店乙' }

let env
let db
let ownerA
let ownerB
let clerk
let costClerk
let deniedClerk

async function json(response) {
  return { status: response.status, body: await response.json() }
}

async function seedClerk({ userId, email, permissions }) {
  await db.prepare(`INSERT INTO users (id, email, password_hash, status) VALUES (?, ?, ?, 'active')`)
    .bind(userId, email, await legacyPasswordHash(PASSWORD)).run()
  const member = await db.prepare(`INSERT INTO store_members (store_id, user_id, status, is_owner, created_by, updated_by)
    VALUES (1, ?, 'active', 0, 1, 1)`).bind(userId).run()
  const role = await db.prepare('INSERT INTO roles (store_id, code, name) VALUES (1, ?, ?)')
    .bind(`u01-role-${userId}`, `U01 角色 ${userId}`).run()
  for (const code of permissions) {
    await db.prepare('INSERT OR IGNORE INTO permissions (code, name) VALUES (?, ?)').bind(code, code).run()
    const permission = await db.prepare('SELECT id FROM permissions WHERE code = ?').bind(code).first()
    await db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)')
      .bind(role.meta.last_row_id, permission.id).run()
  }
  await db.prepare('INSERT INTO member_roles (member_id, role_id) VALUES (?, ?)')
    .bind(member.meta.last_row_id, role.meta.last_row_id).run()
}

async function seedProduct({ storeId = 1, userId = storeId, entityId, name, category, trackingMode, sku = null }) {
  await db.prepare(`INSERT INTO hardware
    (user_id, store_id, category, name, entity_id, sku, tracking_mode, requires_sn,
     is_serialized, status, default_price_cents, item_type, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 'product', 1)`)
    .bind(userId, storeId, category, name, entityId, sku, trackingMode,
      trackingMode === 'item' ? 1 : 0, trackingMode === 'item' ? 1 : 0).run()
  return db.prepare('SELECT id FROM hardware WHERE store_id = ? AND entity_id = ?')
    .bind(storeId, entityId).first().then((row) => row.id)
}

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER_A)
  await seedOwner(db, OWNER_B)
  await seedClerk({ userId: 5, email: 'u01-denied-clerk@local.test', permissions: [] })
  await seedClerk({ userId: 3, email: 'u01-clerk@local.test', permissions: ['inventory/view'] })
  await seedClerk({ userId: 4, email: 'u01-cost-clerk@local.test', permissions: ['inventory/view', 'inventory/cost-view'] })

  ownerA = createClient(env.call, await login(env.call, OWNER_A))
  ownerB = createClient(env.call, await login(env.call, OWNER_B))
  deniedClerk = createClient(env.call, await login(env.call, { email: 'u01-denied-clerk@local.test', password: PASSWORD }))
  clerk = createClient(env.call, await login(env.call, { email: 'u01-clerk@local.test', password: PASSWORD }))
  costClerk = createClient(env.call, await login(env.call, { email: 'u01-cost-clerk@local.test', password: PASSWORD }))

  const statements = []
  for (let index = 0; index < 105; index += 1) {
    const suffix = String(index).padStart(3, '0')
    statements.push(db.prepare(`INSERT INTO hardware
      (user_id, store_id, category, name, entity_id, sku, tracking_mode, requires_sn,
       is_serialized, status, default_price_cents, item_type, version)
      VALUES (1, 1, 'CPU', ?, ?, ?, 'item', 1, 1, 'active', 0, 'product', 1)`)
      .bind(`CPU-${suffix}`, `u01-cpu-${suffix}`, `SKU-${suffix}`))
  }
  await db.batch(statements)
  await db.prepare(`UPDATE hardware SET specs = ? WHERE store_id = 1 AND entity_id = 'u01-cpu-104'`)
    .bind('{"memory":"32GB"}').run()
  const productRows = await db.prepare(`SELECT id, entity_id FROM hardware WHERE store_id = 1 AND entity_id LIKE 'u01-cpu-%'`).all()
  const productByRef = new Map((productRows.results ?? []).map((row) => [row.entity_id, row.id]))
  const itemStatements = []
  for (let index = 0; index < 105; index += 1) {
    const suffix = String(index).padStart(3, '0')
    const id = `u01-item-${suffix}`
    const itemCode = `U01-${suffix}`
    const availability = ['available', 'reserved', 'quarantine'][index % 3]
    const condition = index % 2 === 0 ? 'used' : 'new'
    const sn = index === 104 ? 'SN-TARGET-104' : null
    itemStatements.push(db.prepare(`INSERT INTO stock_items
      (id, store_id, product_id, asset_code, condition, sn_raw, sn_normalized, remark, ownership,
       availability, location, acquisition_cost_cents, cost_known, cost_basis)
      VALUES (?, 1, ?, ?, ?, ?, ?, '', 'store', ?, 'store', 1000, 1, 'known_actual')`)
      .bind(id, productByRef.get(`u01-cpu-${suffix}`), itemCode, condition, sn,
        sn?.replace(/\s+/g, '').toUpperCase() ?? null, availability))
  }
  await db.batch(itemStatements)

  const diskId = await seedProduct({ entityId: 'u01-disk-qty', name: 'Disk-Alpha', category: '硬盘', trackingMode: 'quantity' })
  await db.prepare(`INSERT INTO inventory_movements
    (id, store_id, product_id, qty, to_bucket, source, occurred_at, actor_user_id, request_id)
    VALUES ('u01-mv-disk-a', 1, ?, 4, 'available', 'count_adjustment', '2026-09-27T00:00:00Z', 1, 'u01-req-disk-a')`)
    .bind(diskId).run()
  await db.prepare(`INSERT INTO inventory_movements
    (id, store_id, product_id, qty, to_bucket, source, occurred_at, actor_user_id, request_id)
    VALUES ('u01-mv-disk-q', 1, ?, 1, 'quarantine', 'count_adjustment', '2026-09-27T00:01:00Z', 1, 'u01-req-disk-q')`)
    .bind(diskId).run()
  const secondDiskId = await seedProduct({ entityId: 'u01-disk-qty-2', name: 'Disk-Beta', category: '硬盘', trackingMode: 'quantity' })
  await db.prepare(`INSERT INTO inventory_movements
    (id, store_id, product_id, qty, to_bucket, source, occurred_at, actor_user_id, request_id)
    VALUES ('u01-mv-disk-b', 1, ?, 2, 'available', 'count_adjustment', '2026-09-27T00:02:00Z', 1, 'u01-req-disk-b')`)
    .bind(secondDiskId).run()
})

after(async () => {
  await env?.dispose()
})

test('U01：类别、逐件分页与全量统计使用同一筛选范围，不按当前页截断', async () => {
  const first = await json(await ownerA.get('/api/v2/inventory/stock-items?category=CPU&limit=2'))
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.data.items.length, 2)
  assert.equal(first.body.data.items[0].assetCode, 'U01-000')
  assert.equal(first.body.data.hasMore, true)
  assert.ok(first.body.data.nextCursor)

  const data = first.body.data
  assert.deepEqual(data.filters, {
    q: '', category: 'CPU', condition: null, availability: null, inspectionStatus: null, limit: 2, cursor: null, quantityCursor: null,
  })
  assert.equal(data.totals.ownOnHandQty, 105, '总数来自全部匹配实物，不是当前 2 行')
  assert.equal(data.totals.itemCount, 105)
  assert.equal(data.totals.quantityTrackedQty, 0)
  assert.deepEqual(data.availabilityCounts.map((row) => [row.availability, row.qty]), [
    ['available', 35], ['reserved', 35], ['quarantine', 35],
  ])
  const cpuFacet = data.categoryCounts.find((row) => row.category === 'CPU')
  const diskFacet = data.categoryCounts.find((row) => row.category === '硬盘')
  assert.equal(cpuFacet.metrics.ownOnHandQty, 105)
  assert.equal(diskFacet.metrics.ownOnHandQty, 7)
  assert.equal(diskFacet.metrics.quantityTrackedQty, 7, '数量库存只计余额，不伪造逐件行')
  assert.equal(diskFacet.metrics.itemCount, 0)

  const second = await json(await ownerA.get(`/api/v2/inventory/stock-items?category=CPU&limit=2&cursor=${encodeURIComponent(data.nextCursor)}`))
  assert.equal(second.status, 200, JSON.stringify(second.body))
  assert.deepEqual(second.body.data.items.map((row) => row.assetCode), ['U01-002', 'U01-003'])
  assert.equal(second.body.data.totals.ownOnHandQty, 105, '分页只改变当前行，不改变统计')

  const quantityFirst = await json(await ownerA.get('/api/v2/inventory/stock-items?category=硬盘&limit=1'))
  assert.equal(quantityFirst.status, 200, JSON.stringify(quantityFirst.body))
  assert.deepEqual(quantityFirst.body.data.items, [], '数量库存不伪造成逐件实物')
  assert.equal(quantityFirst.body.data.quantityProducts.length, 1)
  assert.equal(quantityFirst.body.data.quantityProducts[0].name, 'Disk-Alpha')
  assert.equal(quantityFirst.body.data.quantityProducts[0].ownOnHandQty, 5)
  assert.equal(quantityFirst.body.data.quantityHasMore, true)
  const quantitySecond = await json(await ownerA.get(`/api/v2/inventory/stock-items?category=硬盘&limit=1&quantityCursor=${encodeURIComponent(quantityFirst.body.data.quantityNextCursor)}`))
  assert.equal(quantitySecond.status, 200, JSON.stringify(quantitySecond.body))
  assert.equal(quantitySecond.body.data.quantityProducts[0].name, 'Disk-Beta')
  assert.equal(quantitySecond.body.data.quantityProducts[0].ownOnHandQty, 2)
  assert.equal(quantitySecond.body.data.totals.ownOnHandQty, 7, '数量型号分页不截断筛选统计')
  const quantityQuarantine = await json(await ownerA.get('/api/v2/inventory/stock-items?category=硬盘&availability=quarantine'))
  assert.equal(quantityQuarantine.status, 200, JSON.stringify(quantityQuarantine.body))
  assert.equal(quantityQuarantine.body.data.quantityProducts.length, 1)
  assert.equal(quantityQuarantine.body.data.quantityProducts[0].quarantineQty, 1)
  assert.equal(quantityQuarantine.body.data.totals.ownOnHandQty, 1)
  assert.equal(quantityQuarantine.body.data.availabilityCounts.find((row) => row.availability === 'quarantine').qty, 1)
  const staleQuantityCursor = await json(await ownerA.get(`/api/v2/inventory/stock-items?category=CPU&quantityCursor=${encodeURIComponent(quantityFirst.body.data.quantityNextCursor)}`))
  assert.equal(staleQuantityCursor.status, 400, '数量型号游标同样绑定当前筛选')
  const crossStoreCursor = await json(await ownerB.get(`/api/v2/inventory/stock-items?cursor=${encodeURIComponent(data.nextCursor)}`))
  assert.equal(crossStoreCursor.status, 400, '逐件游标绑定当前登录门店')

  const statusFiltered = await json(await ownerA.get('/api/v2/inventory/stock-items?category=CPU&availability=available&limit=1'))
  assert.equal(statusFiltered.status, 200, JSON.stringify(statusFiltered.body))
  assert.equal(statusFiltered.body.data.items.length, 1)
  assert.equal(statusFiltered.body.data.totals.ownOnHandQty, 35)
  assert.equal(statusFiltered.body.data.totals.availableQty, 35)
  assert.equal(statusFiltered.body.data.categoryCounts.find((row) => row.category === 'CPU').metrics.ownOnHandQty, 35,
    '分类 facet 保留已选库存桶筛选')
  assert.equal(statusFiltered.body.data.categoryCounts.find((row) => row.category === '硬盘').metrics.ownOnHandQty, 6,
    '分类 facet 忽略已选类别，但应用库存桶筛选')
  assert.deepEqual(statusFiltered.body.data.availabilityCounts.map((row) => row.qty), [35, 35, 35],
    '状态统计忽略当前状态筛选，但保留类别与搜索范围，便于完整选择')
})

test('U01：跨越 100 个型号按型号、内部编号或 SN 找到目标实物；游标不跨筛选复用', async () => {
  const targetByModel = await json(await ownerA.get('/api/v2/inventory/stock-items?q=CPU-104'))
  assert.equal(targetByModel.status, 200)
  assert.deepEqual(targetByModel.body.data.items.map((row) => row.assetCode), ['U01-104'])
  const targetByAssetCode = await json(await ownerA.get('/api/v2/inventory/stock-items?q=U01-104'))
  assert.deepEqual(targetByAssetCode.body.data.items.map((row) => row.assetCode), ['U01-104'])
  const targetBySpec = await json(await ownerA.get('/api/v2/inventory/stock-items?q=32GB'))
  assert.deepEqual(targetBySpec.body.data.items.map((row) => row.assetCode), ['U01-104'])
  const targetBySn = await json(await ownerA.get('/api/v2/inventory/stock-items?q=SN-TARGET-104'))
  assert.deepEqual(targetBySn.body.data.items.map((row) => row.assetCode), ['U01-104'])

  const first = await json(await ownerA.get('/api/v2/inventory/stock-items?limit=100'))
  assert.equal(first.body.data.items.length, 100)
  assert.equal(first.body.data.hasMore, true)
  const second = await json(await ownerA.get(`/api/v2/inventory/stock-items?limit=100&cursor=${encodeURIComponent(first.body.data.nextCursor)}`))
  assert.equal(second.status, 200)
  assert.equal(second.body.data.items.length, 5)
  assert.equal(second.body.data.items[4].assetCode, 'U01-104')
  assert.equal(first.body.data.totals.ownOnHandQty, 112)
  assert.equal(second.body.data.totals.ownOnHandQty, 112)

  const mismatched = await json(await ownerA.get(`/api/v2/inventory/stock-items?category=硬盘&limit=100&cursor=${encodeURIComponent(first.body.data.nextCursor)}`))
  assert.equal(mismatched.status, 400)
  assert.match(mismatched.body.error.message, /筛选不匹配/)
})

test('U01：数量与逐件库存不混算；condition 只筛有成色事实的实物', async () => {
  const used = await json(await ownerA.get('/api/v2/inventory/stock-items?condition=used'))
  assert.equal(used.status, 200, JSON.stringify(used.body))
  assert.equal(used.body.data.totals.itemCount, 53)
  assert.equal(used.body.data.totals.quantityTrackedQty, 0, '数量库存没有 condition 字段，不得推造新品 / 二手')
  assert.equal(used.body.data.items.every((row) => row.condition === 'used'), true)
  assert.equal(used.body.data.items.every((row) => ['unrecorded', 'pending', 'passed', 'failed'].includes(row.inspectionStatus)), true,
    '逐件实物返回独立检测状态；数量库存不推断检测结论')
  assert.equal('inspectionRef' in used.body.data.items[0], false)
  assert.deepEqual(used.body.data.availabilityCounts.map((row) => row.qty), [18, 17, 18])
})

test('U01：权限、门店隔离和成本字段范围保持不变', async () => {
  const denied = await json(await env.call('/api/v2/inventory/stock-items'))
  assert.equal(denied.status, 401)

  const noGrant = await json(await deniedClerk.get('/api/v2/inventory/stock-items'))
  assert.equal(noGrant.status, 403)

  const withoutView = await json(await ownerB.get('/api/v2/inventory/stock-items?category=CPU'))
  assert.equal(withoutView.status, 200)
  assert.deepEqual(withoutView.body.data.items, [])
  assert.equal(withoutView.body.data.totals.ownOnHandQty, 0)

  const visible = await json(await clerk.get('/api/v2/inventory/stock-items?limit=1'))
  assert.equal(visible.status, 200)
  assert.equal('acquisitionCostCents' in visible.body.data.items[0], false)
  assert.equal('costKnown' in visible.body.data.items[0], false)
  assert.equal('totalCostCents' in visible.body.data.quantityProducts[0], false)

  const withCost = await json(await costClerk.get('/api/v2/inventory/stock-items?limit=1'))
  assert.equal(withCost.status, 200)
  assert.equal(withCost.body.data.items[0].acquisitionCostCents, 1000)
  assert.equal(withCost.body.data.items[0].costKnown, true)
  assert.equal('totalCostCents' in withCost.body.data.quantityProducts[0], true)
})

test('U01：并发筛选各自使用自己的结果与全量统计', async () => {
  const [cpu, disk, exact] = await Promise.all([
    ownerA.get('/api/v2/inventory/stock-items?category=CPU'),
    ownerA.get('/api/v2/inventory/stock-items?category=硬盘'),
    ownerA.get('/api/v2/inventory/stock-items?q=CPU-104'),
  ].map((response) => response.then(json)))

  assert.equal(cpu.status, 200)
  assert.equal(cpu.body.data.totals.ownOnHandQty, 105)
  assert.ok(cpu.body.data.items.every((row) => row.category === 'CPU'))
  assert.equal(disk.status, 200)
  assert.equal(disk.body.data.totals.ownOnHandQty, 7)
  assert.equal(disk.body.data.totals.quantityTrackedQty, 7)
  assert.deepEqual(disk.body.data.items, [], '数量商品没有被伪造成单件行')
  assert.equal(exact.status, 200)
  assert.deepEqual(exact.body.data.items.map((row) => row.assetCode), ['U01-104'])
})

test('U01：非法状态与游标格式明确拒绝', async () => {
  assert.equal((await json(await ownerA.get('/api/v2/inventory/stock-items?availability=sold'))).status, 400)
  assert.equal((await json(await ownerA.get('/api/v2/inventory/stock-items?limit=0'))).status, 400)
  assert.equal((await json(await ownerA.get('/api/v2/inventory/stock-items?cursor=bad'))).status, 400)
  assert.equal((await json(await ownerA.get('/api/v2/inventory/stock-items?quantityCursor=bad'))).status, 400)
})
