/**
 * T05a · 查询口径：GET /inventory、GET /inventory/items/:id。
 *
 * 关注点（卡面「最容易做错的三件事」之二、之三）：
 *   · 可卖 / 已订 / 待处理三类分别可查、分别对账，从任何角度看总和一致；
 *   · 同型号的不同实物必须能分别定位，不被型号汇总吞掉；
 *   · 客户保管另列，不进自有库存汇总。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createInventoryEnv, ctx, resetInventory, seedProduct, scalar, STORE } from './lib/inventory.mjs'

let env
let db

before(async () => {
  env = await createInventoryEnv()
  db = env.db
})

after(async () => {
  await env?.dispose()
})

/** 播一条余额变化（直接写流水，让触发器维护余额）。 */
async function move(productId, id, qty, toBucket, fromBucket = null) {
  await db
    .prepare(
      `INSERT INTO inventory_movements (id, store_id, product_id, qty, from_bucket, to_bucket, source, occurred_at, actor_user_id, request_id)
       VALUES (?, ?, ?, ?, ?, ?, 'count_adjustment', '2026-09-18T00:00:00Z', 1, ?)`,
    )
    .bind(id, STORE, productId, qty, fromBucket, toBucket, `req-${id}`)
    .run()
}

test('型号汇总：三桶分别可查，自有在库合计等于三者之和', async () => {
  await resetInventory(db)
  const { hardwareId } = await seedProduct(db, { entityId: 'prod-sum', name: '汇总机型' })

  await move(hardwareId, 'mv-sum-1', 10, 'available')
  await move(hardwareId, 'mv-sum-2', 3, 'reserved', 'available')
  await move(hardwareId, 'mv-sum-3', 2, 'quarantine')

  const listed = await env.inventory.queryInventory(db, STORE, {}, { includeCost: true })
  const row = listed.items.find((item) => item.id === 'prod-sum')
  assert.ok(row, '汇总里必须有该型号')
  assert.equal(row.availableQty, 7)
  assert.equal(row.reservedQty, 3)
  assert.equal(row.quarantineQty, 2)
  assert.equal(row.ownOnHandQty, 12, '自有在库 = 可卖 + 已订 + 待处理')

  assert.equal(listed.totals.availableQty, 7)
  assert.equal(listed.totals.reservedQty, 3)
  assert.equal(listed.totals.quarantineQty, 2)
  assert.equal(listed.totals.ownOnHandQty, 12, '总额必须与逐行相加一致')
  assert.equal(listed.totals.inTransitQty, 0, '在途不进入在库口径')

  // 与逐行相加对照：换一个角度算，总数必须还是同一个
  const sumFromRows = listed.items.reduce((acc, item) => acc + item.ownOnHandQty, 0)
  assert.equal(sumFromRows, listed.totals.ownOnHandQty)
})

test('在途与客户保管都不算在库', async () => {
  await resetInventory(db)
  const { hardwareId } = await seedProduct(db, { entityId: 'prod-buckets', name: '边界机型' })

  await move(hardwareId, 'mv-b1', 4, 'available')
  await move(hardwareId, 'mv-b2', 6, 'in_transit')
  await move(hardwareId, 'mv-b3', 5, 'customer_custody')

  const listed = await env.inventory.queryInventory(db, STORE, {}, { includeCost: false })
  const row = listed.items.find((item) => item.id === 'prod-buckets')
  assert.equal(row.availableQty, 4)
  assert.equal(row.ownOnHandQty, 4, '在途 6 件与客户保管 5 件都不得计入在库')
  assert.equal(listed.totals.ownOnHandQty, 4)
})

test('同型号的不同实物分别定位；客户保管件另列一行', async () => {
  await resetInventory(db)
  const { hardwareId } = await seedProduct(db, { entityId: 'prod-items', name: '逐件机型', trackingMode: 'item', requiresSn: 1 })

  // 建实物必须同时写流水 —— 余额只由流水维护，这是写入纪律（见验证文档「与其他卡的口径」）。
  const insert = async (id, code, ownership, availability, location, sn, hardwareIdForMovement) => {
    await db
      .prepare(
        `INSERT INTO stock_items (id, store_id, product_id, asset_code, condition, sn_raw, sn_normalized,
           ownership, availability, location, cost_known, acquisition_cost_cents)
         VALUES (?, ?, ?, ?, 'used', ?, ?, ?, ?, ?, 1, 5000)`,
      )
      .bind(id, STORE, hardwareIdForMovement, code, sn, sn ? sn.toUpperCase() : null, ownership, availability, location)
      .run()
    await db
      .prepare(
        `INSERT INTO inventory_movements (id, store_id, product_id, stock_item_id, qty, to_bucket, source, occurred_at, actor_user_id, request_id)
         VALUES (?, ?, ?, ?, 1, ?, 'opening_balance', '2026-09-18T00:00:00Z', 1, ?)`,
      )
      .bind(`mv-${id}`, STORE, hardwareIdForMovement, id, availability, `req-${id}`)
      .run()
  }

  await insert('si-u1', 'U-001', 'store', 'available', 'store', 'sn-001', hardwareId)
  await insert('si-u2', 'U-002', 'store', 'reserved', 'store', 'sn-002', hardwareId)
  await insert('si-cust', 'C-001', 'customer', 'customer_custody', 'customer', 'sn-003', hardwareId)

  const listed = await env.inventory.queryInventory(db, STORE, {}, { includeCost: false })

  const codes = listed.lotItems.map((item) => item.assetCode).sort()
  assert.deepEqual(codes, ['C-001', 'U-001', 'U-002'], '三件实物必须各自一行，不被型号汇总吞掉')

  const u1 = listed.lotItems.find((item) => item.assetCode === 'U-001')
  const u2 = listed.lotItems.find((item) => item.assetCode === 'U-002')
  assert.equal(u1.availability, 'available')
  assert.equal(u2.availability, 'reserved')
  assert.equal(u1.snNormalized, 'SN-001')
  assert.notEqual(u1.id, u2.id, '同型号不同实物必须是不同的实体')

  const summary = listed.items.find((item) => item.id === 'prod-items')
  assert.equal(summary.storeItemCount, 2, '型号汇总里的逐件数只数店有件')
  assert.equal(summary.customerCustodyCount, 1, '客户保管件单独计一列')
  assert.equal(listed.totals.customerCustodyCount, 1)
  assert.equal(listed.totals.ownOnHandQty, 2, '客户保管不进自有库存')
})

test('查询筛选：condition 与 availability 生效', async () => {
  await resetInventory(db)
  const { hardwareId } = await seedProduct(db, { entityId: 'prod-filter', trackingMode: 'item', requiresSn: 1 })

  const insert = (id, code, condition, availability) =>
    db
      .prepare(
        `INSERT INTO stock_items (id, store_id, product_id, asset_code, condition, ownership, availability, location, cost_known, acquisition_cost_cents)
         VALUES (?, ?, ?, ?, ?, 'store', ?, 'store', 1, 100)`,
      )
      .bind(id, STORE, hardwareId, code, condition, availability)
      .run()

  await insert('si-n1', 'N-001', 'new', 'available')
  await insert('si-n2', 'N-002', 'new', 'quarantine')
  await insert('si-u1', 'U-001', 'used', 'available')

  const used = await env.inventory.queryInventory(db, STORE, { condition: 'used' }, { includeCost: false })
  assert.deepEqual(used.lotItems.map((item) => item.assetCode), ['U-001'])

  const quarantine = await env.inventory.queryInventory(db, STORE, { availability: 'quarantine' }, { includeCost: false })
  assert.deepEqual(quarantine.lotItems.map((item) => item.assetCode), ['N-002'])

  const search = await env.inventory.queryInventory(db, STORE, { q: 'filter' }, { includeCost: false })
  assert.deepEqual(search.items.map((item) => item.id), ['prod-filter'])
})

test('成本字段按权限返回：无权时字段根本不出现，不是置空', async () => {
  await resetInventory(db)
  const { hardwareId } = await seedProduct(db, { entityId: 'prod-cost', name: '成本机型' })
  await move(hardwareId, 'mv-cost-1', 2, 'available')

  const withoutCost = await env.inventory.queryInventory(db, STORE, {}, { includeCost: false })
  const row = withoutCost.items.find((item) => item.id === 'prod-cost')
  assert.equal('totalCostCents' in row, false, '无权时不得出现成本字段')
  assert.equal('costKnown' in row, false)

  const lotWithout = withoutCost.lotItems[0]
  if (lotWithout) {
    assert.equal('acquisitionCostCents' in lotWithout, false)
  }

  const withCost = await env.inventory.queryInventory(db, STORE, {}, { includeCost: true })
  const rowWithCost = withCost.items.find((item) => item.id === 'prod-cost')
  assert.equal('totalCostCents' in rowWithCost, true)
  assert.equal('costKnown' in rowWithCost, true)
})

test('列表分页：cursor 不改变汇总口径', async () => {
  await resetInventory(db)
  for (const name of ['A 机型', 'B 机型', 'C 机型']) {
    await seedProduct(db, { entityId: `prod-${name[0]}`, name })
  }

  const first = await env.inventory.queryInventory(db, STORE, { limit: 2 }, { includeCost: false })
  assert.equal(first.items.length, 2)
  assert.equal(first.hasMore, true)
  assert.ok(first.nextCursor)

  const second = await env.inventory.queryInventory(db, STORE, { limit: 2, cursor: first.nextCursor }, { includeCost: false })
  assert.equal(second.items.length, 1)
  assert.equal(second.hasMore, false)
  assert.equal(second.nextCursor, null)

  const ids = [...first.items, ...second.items].map((item) => item.id)
  assert.deepEqual(ids, ['prod-A', 'prod-B', 'prod-C'], '两页合起来不重不漏')
})

test('实物详情：来源、有效占用、流水都能查到', async () => {
  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-detail', name: '详情机型', trackingMode: 'item', requiresSn: 1 })

  const opened = await env.inventory.createOpening(db, ctx('req-detail-open', 'B13'), {
    approvedCountRef: '实盘单 D-1',
    costBasis: { kind: 'known' },
    lines: [{ productRef: 'prod-detail', qty: 1, condition: 'used', assetCode: 'U-500', snRaw: 'sn-500', unitCostCents: 66000 }],
  })
  assert.equal(opened.ok, true, JSON.stringify(opened))

  const itemId = (opened.outcome.effects.itemIds)[0]
  await db
    .prepare(
      `INSERT INTO stock_reservations (id, store_id, stock_item_id, order_ref, line_ref, status, request_id)
       VALUES ('rsv-detail', ?, ?, 'ord-900', 'line-900', 'active', 'req-rsv-detail')`,
    )
    .bind(STORE, itemId)
    .run()

  const detail = await env.inventory.queryStockItem(db, STORE, itemId, { includeCost: true })
  assert.ok(detail)
  assert.equal(detail.product.id, 'prod-detail')
  assert.equal(detail.item.assetCode, 'U-500')
  assert.equal(detail.item.ownership, 'store')
  assert.equal(detail.item.acquisitionCostCents, 66000)
  assert.equal(detail.item.costKnown, true)
  assert.equal(detail.item.activeReservationRef, 'rsv-detail')

  assert.ok(detail.activeReservation, '有效占用必须能查到')
  assert.equal(detail.activeReservation.orderRef, 'ord-900')
  assert.equal(detail.activeReservation.status, 'active')

  assert.ok(detail.acquisition, '取得来源必须能查到')
  assert.equal(detail.acquisition.kind, 'opening')
  assert.equal(detail.acquisition.approvedCountRef, '实盘单 D-1')

  assert.equal(detail.movements.length, 1)
  assert.equal(detail.item.availability, 'quarantine')
  assert.equal(detail.movements[0].toBucket, 'quarantine')
  assert.equal(detail.movements[0].source, 'opening_balance')

  // 无权时实物详情也不得带成本
  const withoutCost = await env.inventory.queryStockItem(db, STORE, itemId, { includeCost: false })
  assert.equal('acquisitionCostCents' in withoutCost.item, false)
  assert.equal('costKnown' in withoutCost.item, false)
})

test('查不到的实物：如实返回 null，不抛错', async () => {
  await resetInventory(db)
  assert.equal(await env.inventory.queryStockItem(db, STORE, 'si-not-exist', { includeCost: true }), null)
})

test('对账：脱离流水的实物能被发现（有实无账）', async () => {
  await resetInventory(db)
  const { hardwareId } = await seedProduct(db, { entityId: 'prod-orphan', trackingMode: 'item', requiresSn: 1 })

  const orphan = (id, code) =>
    db
      .prepare(
        `INSERT INTO stock_items (id, store_id, product_id, asset_code, condition, ownership, availability, location, cost_known, acquisition_cost_cents)
         VALUES (?, ?, ?, ?, 'used', 'store', 'available', 'store', 1, 100)`,
      )
      .bind(id, STORE, hardwareId, code)
      .run()

  // 正常路径产出的实物：实物与流水成对
  await orphan('si-ok', 'A-OK')
  await db
    .prepare(
      `INSERT INTO inventory_movements (id, store_id, product_id, stock_item_id, qty, to_bucket, source, occurred_at, actor_user_id, request_id)
       VALUES ('mv-ok', ?, ?, 'si-ok', 1, 'available', 'opening_balance', '2026-09-18T00:00:00Z', 1, 'req-ok')`,
    )
    .bind(STORE, hardwareId)
    .run()

  // 只建了实物、没写流水 —— 它游离在余额之外
  await orphan('si-orphan', 'A-ORPHAN')

  const found = await env.inventory.findStockItemsWithoutMovements(db, STORE)
  assert.deepEqual(found.map((item) => item.assetCode), ['A-ORPHAN'])

  // 同一时刻余额里只有那件有账的
  const balance = await scalar(db, 'SELECT available_qty FROM stock_balances WHERE product_id = ?', hardwareId)
  assert.equal(balance, 1)
})
