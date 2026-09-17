/**
 * T05a · 结构与约束：0007 建的对象、客户财产边界、未知成本、重复 SN、逐件占用、数量守恒。
 *
 * 跑在真实 workerd + 真实 D1 上（miniflare），被测代码经 esbuild 打包后直接调用。
 * 跑法：npm --prefix backend test
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createInventoryEnv, resetInventory, rows, scalar, seedProduct, STORE } from './lib/inventory.mjs'

let env
let db

before(async () => {
  env = await createInventoryEnv()
  db = env.db
})

after(async () => {
  await env?.dispose()
})

/** 统一捕获 SQL 失败的助手：接受 SQL 字符串（可带参数）。返回错误消息，成功返回 null。 */
async function attempt(sql, ...params) {
  try {
    await db.prepare(sql).bind(...params).run()
    return null
  } catch (error) {
    return String(error?.message ?? error)
  }
}

const insertItem = (overrides) => {
  const base = {
    id: 'si-x',
    asset_code: 'A-x',
    condition: 'new',
    ownership: 'store',
    availability: 'available',
    location: 'store',
    sn_raw: null,
    sn_normalized: null,
    cost_known: 1,
    acquisition_cost_cents: 100,
  }
  const v = { ...base, ...overrides }
  return attempt(
    `INSERT INTO stock_items
       (id, store_id, product_id, asset_code, condition, sn_raw, sn_normalized,
        ownership, availability, location, acquisition_cost_cents, cost_known)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    v.id,
    STORE,
    v.product_id,
    v.asset_code,
    v.condition,
    v.sn_raw,
    v.sn_normalized,
    v.ownership,
    v.availability,
    v.location,
    v.acquisition_cost_cents,
    v.cost_known,
  )
}

test('迁移与结构：0007 的表、索引与触发器都已建立', async () => {
  assert.ok(env.migrations.length >= 8, `迁移文件数应 >= 8，实际 ${env.migrations.length}`)
  const names = await rows(
    db,
    `SELECT name FROM sqlite_master WHERE name IN
       ('stock_items','stock_balances','inventory_movements','stock_reservations',
        'inventory_openings','inventory_opening_lines','inventory_movements_apply_balance',
        'uq_stock_items_store_owned_sn','uq_stock_reservations_active_item','uq_hardware_store_sku')
     ORDER BY name`,
  )
  assert.deepEqual(
    names.map((r) => r.name),
    [
      'inventory_movements',
      'inventory_movements_apply_balance',
      'inventory_opening_lines',
      'inventory_openings',
      'stock_balances',
      'stock_items',
      'stock_reservations',
      'uq_hardware_store_sku',
      'uq_stock_items_store_owned_sn',
      'uq_stock_reservations_active_item',
    ],
  )
})

test('Product 属性就地扩展在 hardware 上，新行有默认值', async () => {
  await resetInventory(db)
  const info = await rows(db, 'PRAGMA table_info(hardware)')
  const names = info.map((c) => c.name)
  for (const column of ['tracking_mode', 'requires_sn', 'specs', 'version', 'entity_id']) {
    assert.ok(names.includes(column), `hardware 缺少新列 ${column}`)
  }
  await db
    .prepare(
      `INSERT INTO hardware (user_id, store_id, category, name, entity_id)
       VALUES (1, ?, '测试', '默认值商品', 'prod-defaults')`,
    )
    .bind(STORE)
    .run()
  const row = await rows(
    db,
    `SELECT tracking_mode, requires_sn, version FROM hardware WHERE entity_id = 'prod-defaults'`,
  )
  assert.deepEqual(row[0], { tracking_mode: 'quantity', requires_sn: 0, version: 1 })
})

test('客户端边界：非店有实物不得进入可卖 / 已订 / 待处理（R03）', async () => {
  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-edge' })
  const product = await scalar(db, 'SELECT id FROM hardware WHERE entity_id = ?', 'prod-edge')

  const customerSellable = await attempt(
    `INSERT INTO stock_items
       (id, store_id, product_id, asset_code, condition, ownership, availability, location)
     VALUES ('si-c1', ?, ?, 'A-c1', 'used', 'customer', 'available', 'customer')`,
    STORE,
    product,
  )
  assert.match(String(customerSellable), /CHECK constraint failed/)

  const storeCustody = await attempt(
    `INSERT INTO stock_items
       (id, store_id, product_id, asset_code, condition, ownership, availability, location)
     VALUES ('si-c2', ?, ?, 'A-c2', 'used', 'store', 'customer_custody', 'customer')`,
    STORE,
    product,
  )
  assert.match(String(storeCustody), /CHECK constraint failed/)

  const custody = await attempt(
    `INSERT INTO stock_items
       (id, store_id, product_id, asset_code, condition, ownership, availability, location)
     VALUES ('si-c3', ?, ?, 'A-c3', 'used', 'customer', 'customer_custody', 'customer')`,
    STORE,
    product,
  )
  assert.equal(custody, null, '客户所有 + 客户保管必须被接受')
})

test('未知成本保持 NULL，不得写成 0（R01）', async () => {
  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-cost' })
  const product = await scalar(db, 'SELECT id FROM hardware WHERE entity_id = ?', 'prod-cost')

  const zeroCost = await attempt(
    `INSERT INTO stock_items
       (id, store_id, product_id, asset_code, condition, ownership, availability, location, cost_known, acquisition_cost_cents)
     VALUES ('si-k1', ?, ?, 'A-k1', 'used', 'store', 'available', 'store', 0, 0)`,
    STORE,
    product,
  )
  assert.match(String(zeroCost), /CHECK constraint failed/, '未知成本写成 0 必须被拒绝')

  const missingCost = await attempt(
    `INSERT INTO stock_items
       (id, store_id, product_id, asset_code, condition, ownership, availability, location, cost_known)
     VALUES ('si-k2', ?, ?, 'A-k2', 'used', 'store', 'available', 'store', 0)`,
    STORE,
    product,
  )
  assert.equal(missingCost, null)

  const knownWithoutAmount = await attempt(
    `INSERT INTO stock_items
       (id, store_id, product_id, asset_code, condition, ownership, availability, location, cost_known)
     VALUES ('si-k3', ?, ?, 'A-k3', 'used', 'store', 'available', 'store', 1)`,
    STORE,
    product,
  )
  assert.match(String(knownWithoutAmount), /CHECK constraint failed/, '声明成本已知就必须有金额')
})

test('重复 SN：店有重复被拒，客户件同 SN 可并存（不自动合并所有权）', async () => {
  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-sn', trackingMode: 'item', requiresSn: 1 })
  const product = await scalar(db, 'SELECT id FROM hardware WHERE entity_id = ?', 'prod-sn')

  assert.equal(
    await insertItem({ id: 'si-s1', product_id: product, asset_code: 'A-s1', sn_raw: 'SN-Abc-9', sn_normalized: 'SN-ABC-9' }),
    null,
  )
  const dup = await insertItem(
    { id: 'si-s2', product_id: product, asset_code: 'A-s2', sn_raw: 'SN-ABC-9', sn_normalized: 'SN-ABC-9' },
  )
  assert.match(String(dup), /UNIQUE constraint failed/)

  const customerSameSn = await insertItem({
    id: 'si-s3',
    product_id: product,
    asset_code: 'A-s3',
    ownership: 'customer',
    availability: 'customer_custody',
    location: 'customer',
    sn_raw: 'SN-Abc-9',
    sn_normalized: 'SN-ABC-9',
    cost_known: 0,
    acquisition_cost_cents: null,
  })
  assert.equal(customerSameSn, null, '别人的设备可以与店里同 SN 并存')
})

test('余额只由流水改变：三桶互斥、非负、在途与客户保管不落地', async () => {
  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-bal' })
  const product = await scalar(db, 'SELECT id FROM hardware WHERE entity_id = ?', 'prod-bal')

  const movement = (id, qty, to, from, source) =>
    attempt(
      `INSERT INTO inventory_movements (id, store_id, product_id, qty, from_bucket, to_bucket, source, occurred_at, actor_user_id, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-18T00:00:00Z', 1, ?)`,
      id,
      STORE,
      product,
      qty,
      from,
      to,
      source,
      `req-${id}`,
    )

  assert.equal(await movement('mv-a', 5, 'available', null, 'opening_balance'), null)
  assert.equal(await movement('mv-b', 2, 'reserved', 'available', 'reservation'), null, '桶间转移必须被接受')

  let balance = await rows(db, 'SELECT available_qty, reserved_qty, quarantine_qty FROM stock_balances WHERE product_id = ?', product)
  assert.deepEqual(balance[0], { available_qty: 3, reserved_qty: 2, quarantine_qty: 0 })

  const overdraw = await movement('mv-c', 10, null, 'reserved', 'delivery')
  assert.match(String(overdraw), /CHECK constraint failed/, '扣成负数必须整批失败')

  balance = await rows(db, 'SELECT available_qty, reserved_qty, quarantine_qty FROM stock_balances WHERE product_id = ?', product)
  assert.deepEqual(balance[0], { available_qty: 3, reserved_qty: 2, quarantine_qty: 0 }, '失败不得留下部分扣减')

  assert.equal(await movement('mv-d', 9, 'in_transit', null, 'purchase_receipt'), null)
  assert.equal(await movement('mv-e', 4, 'customer_custody', null, 'return_receipt'), null)
  balance = await rows(db, 'SELECT available_qty, reserved_qty, quarantine_qty FROM stock_balances WHERE product_id = ?', product)
  assert.deepEqual(
    balance[0],
    { available_qty: 3, reserved_qty: 2, quarantine_qty: 0 },
    '在途与客户保管不得进入在库三桶',
  )

  const zero = await movement('mv-f', 0, 'available', null, 'opening_balance')
  assert.match(String(zero), /CHECK constraint failed/, 'qty = 0 是无意义流水')

  const sameBucket = await movement('mv-g', 1, 'available', 'available', 'count_adjustment')
  assert.match(String(sameBucket), /CHECK constraint failed/, 'from 与 to 不得相同')
})

test('数量守恒：余额可以按流水逐笔重算，结果一致', async () => {
  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-recon' })
  const product = await scalar(db, 'SELECT id FROM hardware WHERE entity_id = ?', 'prod-recon')

  const statements = [
    [10, 'available', null],
    [4, 'quarantine', null],
    [3, 'reserved', 'available'],
    [1, null, 'quarantine'],
  ]
  for (const [index, [qty, to, from]] of statements.entries()) {
    await db
      .prepare(
        `INSERT INTO inventory_movements (id, store_id, product_id, qty, from_bucket, to_bucket, source, occurred_at, actor_user_id, request_id)
         VALUES (?, ?, ?, ?, ?, ?, 'count_adjustment', '2026-09-18T00:00:00Z', 1, ?)`,
      )
      .bind(`mv-r-${index}`, STORE, product, qty, from, to, `req-r-${index}`)
      .run()
  }

  const result = await env.inventory.reconcileProductBalance(db, STORE, product)
  assert.equal(result.consistent, true, JSON.stringify(result))
  assert.deepEqual(result.stored, { available: 7, reserved: 3, quarantine: 3 })
  assert.deepEqual(result.ledger, result.stored, '按流水重算必须与余额一致')
})

test('逐件占用：同一实物同时只能有一条有效占用（部分唯一索引）', async () => {
  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-rsv', trackingMode: 'item', requiresSn: 1 })
  const product = await scalar(db, 'SELECT id FROM hardware WHERE entity_id = ?', 'prod-rsv')
  await insertItem({ id: 'si-r1', product_id: product, asset_code: 'A-r1' })

  const reserve = (id, status) =>
    attempt(
      `INSERT INTO stock_reservations (id, store_id, stock_item_id, order_ref, line_ref, status, request_id)
       VALUES (?, ?, 'si-r1', 'ord-1', 'line-1', ?, ?)`,
      id,
      STORE,
      status,
      `req-${id}`,
    )

  assert.equal(await reserve('rsv-1', 'active'), null)
  const second = await reserve('rsv-2', 'active')
  assert.match(String(second), /UNIQUE constraint failed/, '同一实物的第二条有效占用必须被拒绝')

  assert.equal(await reserve('rsv-3', 'released'), null, '已释放的历史占用要保留')

  // 释放掉 rsv-1 之后，同一实物才可以被再次占用 —— 历史行仍然留着。
  await db.prepare(`UPDATE stock_reservations SET status = 'released', closed_at = datetime('now') WHERE id = 'rsv-1'`).run()
  assert.equal(await reserve('rsv-4', 'active'), null, '前一条释放后可以再次占用同一实物')

  const badQty = await attempt(
    `INSERT INTO stock_reservations (id, store_id, stock_item_id, order_ref, line_ref, qty, status, request_id)
     VALUES ('rsv-5', ?, 'si-r1', 'ord-1', 'line-1', 3, 'released', 'req-rsv-5')`,
    STORE,
  )
  assert.match(String(badQty), /CHECK constraint failed/, '逐件实物的占用数量恒为 1')
})
