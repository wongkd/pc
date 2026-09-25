/**
 * T05a · B13 录入期初库存（POST /inventory/openings）。
 * 权限码 inventory/opening（老板专属）由请求层装配，本层不鉴权（T03）。
 *
 * 卡面通过标准：可卖 / 已订 / 待处理 / 在途不会混算；不从历史 SN 表数量直接推断期初库存。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createInventoryEnv, ctx, resetInventory, rows, scalar, seedProduct, STORE } from './lib/inventory.mjs'

let env
let db
let opening

before(async () => {
  env = await createInventoryEnv()
  db = env.db
  opening = (requestId, input) => env.inventory.createOpening(db, ctx(requestId, 'B13'), input)
})

after(async () => {
  await env?.dispose()
})

test('数量件期初：流水、余额、成本与审计一起成立', async () => {
  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-q', name: '期初数量件' })

  const result = await opening('req-open-1', {
    approvedCountRef: '实盘单 2026-09-18-A',
    costBasis: { kind: 'known', note: '按采购单核对' },
    note: '开店首次建账',
    lines: [{ productRef: 'prod-q', qty: 5, unitCostCents: 1000 }],
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.outcome.entityType, 'StockItem')

  const balances = await rows(
    db,
    `SELECT available_qty, reserved_qty, quarantine_qty, total_cost_cents, cost_known
     FROM stock_balances WHERE store_id = ? AND location_id = 'store'`,
    STORE,
  )
  assert.deepEqual(balances[0], {
    available_qty: 5,
    reserved_qty: 0,
    quarantine_qty: 0,
    total_cost_cents: 5000,
    cost_known: 1,
  })

  assert.equal(await scalar(db, "SELECT COUNT(*) FROM inventory_movements WHERE source = 'opening_balance'"), 1)
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM inventory_openings'), 1)
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM inventory_opening_lines'), 1)
  assert.equal(
    await scalar(db, 'SELECT approved_count_ref FROM inventory_openings'),
    '实盘单 2026-09-18-A',
    '人工确认凭据必须落库',
  )
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM stock_items'), 0, '数量件不产生逐件实物')
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM operations'), 1)
})

test('逐件期初：每件实物独立成行并带内部编号', async () => {
  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-used', name: '二手显卡', trackingMode: 'item', requiresSn: 1 })

  const result = await opening('req-open-2', {
    approvedCountRef: '实盘单 2026-09-18-B',
    costBasis: { kind: 'known' },
    lines: [
      { productRef: 'prod-used', qty: 1, condition: 'used', assetCode: 'U-017', snRaw: 'sn-abc-17', unitCostCents: 88000 },
      { productRef: 'prod-used', qty: 1, condition: 'used', assetCode: 'U-018', unitCostCents: 90000 },
    ],
  })

  assert.equal(result.ok, true, JSON.stringify(result))

  const items = await rows(
    db,
    `SELECT asset_code, condition, sn_raw, sn_normalized, ownership, availability, acquisition_cost_cents, cost_known
     FROM stock_items ORDER BY asset_code`,
  )
  assert.deepEqual(items, [
    {
      asset_code: 'U-017',
      condition: 'used',
      sn_raw: 'sn-abc-17',
      sn_normalized: 'SN-ABC-17',
      ownership: 'store',
      availability: 'available',
      acquisition_cost_cents: 88000,
      cost_known: 1,
    },
    {
      asset_code: 'U-018',
      condition: 'used',
      sn_raw: null,
      sn_normalized: null,
      ownership: 'store',
      availability: 'available',
      acquisition_cost_cents: 90000,
      cost_known: 1,
    },
  ])
  assert.equal(
    await scalar(db, 'SELECT available_qty FROM stock_balances'),
    2,
    '逐件实物的数量也要进余额，两件必须分别定位而不是被汇总吞掉',
  )
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'), 2, '每件实物各有一条流水')
})

test('未知成本保持 NULL，不估成 0（R01）', async () => {
  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-unk', name: '成本未知机型' })

  const result = await opening('req-open-unk', {
    approvedCountRef: '实盘单 2026-09-18-C',
    costBasis: { kind: 'unknown', note: '旧库存无采购单据' },
    lines: [
      { productRef: 'prod-unk', qty: 3 },
      { productRef: 'prod-unk', qty: 1, unitCostCents: 2500 },
    ],
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  const balance = await rows(
    db,
    'SELECT available_qty, total_cost_cents, cost_known FROM stock_balances WHERE product_id = (SELECT id FROM hardware WHERE entity_id = ?)',
    'prod-unk',
  )
  assert.equal(balance[0].available_qty, 4)
  assert.equal(balance[0].total_cost_cents, null, '存在未知成本时总额必须是 NULL 而不是已填部分的和')
  assert.equal(balance[0].cost_known, 0)

  const lines = await rows(db, 'SELECT unit_cost_cents, cost_known FROM inventory_opening_lines ORDER BY id')
  assert.deepEqual(lines, [
    { unit_cost_cents: null, cost_known: 0 },
    { unit_cost_cents: 2500, cost_known: 1 },
  ])
})

test('缺人工确认凭据：拒绝，且不留任何账', async () => {
  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-no-ref' })

  const result = await opening('req-open-no-ref', {
    approvedCountRef: '   ',
    lines: [{ productRef: 'prod-no-ref', qty: 1, unitCostCents: 100 }],
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'VALIDATION_ERROR')
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM inventory_openings'), 0)
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'), 0)
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM operations'), 0)
})

test('商品不存在或不属于本店：ENTITY_NOT_FOUND', async () => {
  await resetInventory(db)
  const result = await opening('req-open-404', {
    approvedCountRef: '实盘单 X',
    lines: [{ productRef: 'prod-ghost', qty: 1, unitCostCents: 100 }],
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ENTITY_NOT_FOUND')
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM operations'), 0)
})

test('逐件商品的期初行数量恒为 1；不填编号由服务端自动分配', async () => {
  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-item-rules', trackingMode: 'item', requiresSn: 1 })

  // 内部编号由服务端自动生成（AS02 用户确认规则），不是手填项；没给编号也必须能建账。
  const auto = await opening('req-open-autocode', {
    approvedCountRef: '实盘单 D',
    costBasis: { kind: 'known' },
    lines: [{ productRef: 'prod-item-rules', qty: 1, condition: 'used', unitCostCents: 100 }],
  })
  assert.equal(auto.ok, true, JSON.stringify(auto))
  const generated = await rows(db, 'SELECT asset_code FROM stock_items')
  assert.equal(generated.length, 1)
  assert.match(generated[0].asset_code, /^IT-0001-\d{8}-[0-9A-F]{10}$/, `内部编号应由服务端生成：${generated[0].asset_code}`)

  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-item-rules', trackingMode: 'item', requiresSn: 1 })

  const badQty = await opening('req-open-badqty', {
    approvedCountRef: '实盘单 D',
    costBasis: { kind: 'known' },
    lines: [{ productRef: 'prod-item-rules', qty: 2, condition: 'used', assetCode: 'U-100', unitCostCents: 100 }],
  })
  assert.equal(badQty.ok, false)
  assert.equal(badQty.code, 'VALIDATION_ERROR')
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM stock_items'), 0)
})

test('数量件行不得带内部编号（事实必须与商品属性一致）', async () => {
  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-qty-rules' })

  const result = await opening('req-open-qtycode', {
    approvedCountRef: '实盘单 E',
    costBasis: { kind: 'known' },
    lines: [{ productRef: 'prod-qty-rules', qty: 1, assetCode: 'A-1', unitCostCents: 100 }],
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'VALIDATION_ERROR')
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'), 0)
})

test('期初不是日常入库捷径：已有在库的商品不得再走期初', async () => {
  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-repeat' })

  const first = await opening('req-open-first', {
    approvedCountRef: '实盘单 F',
    costBasis: { kind: 'known' },
    lines: [{ productRef: 'prod-repeat', qty: 2, unitCostCents: 100 }],
  })
  assert.equal(first.ok, true, JSON.stringify(first))

  const second = await opening('req-open-second', {
    approvedCountRef: '实盘单 F-2',
    costBasis: { kind: 'known' },
    lines: [{ productRef: 'prod-repeat', qty: 3, unitCostCents: 100 }],
  })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'VALIDATION_ERROR')
  assert.equal(await scalar(db, 'SELECT available_qty FROM stock_balances'), 2, '已有在库不得被第二次期初覆盖')
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM inventory_openings'), 1)
})

test('成本口径声明与实际不一致：拒绝', async () => {
  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-basis' })

  // 声明「成本已知」却有一行给不出金额 —— 声明与事实矛盾，必须拦。
  const declaredKnown = await opening('req-open-basis-2', {
    approvedCountRef: '实盘单 G',
    costBasis: { kind: 'known' },
    lines: [{ productRef: 'prod-basis', qty: 1 }],
  })
  assert.equal(declaredKnown.ok, false)
  assert.equal(declaredKnown.code, 'VALIDATION_ERROR')

  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'), 0)
})

test('同 requestId 复用：不重复建账', async () => {
  await resetInventory(db)
  await seedProduct(db, { entityId: 'prod-idem' })
  const input = {
    approvedCountRef: '实盘单 H',
    costBasis: { kind: 'known' },
    lines: [{ productRef: 'prod-idem', qty: 4, unitCostCents: 500 }],
  }

  const first = await opening('req-open-idem', input)
  const second = await opening('req-open-idem', input)

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.reused, true)
  assert.equal(await scalar(db, 'SELECT available_qty FROM stock_balances'), 4, '不得累加成 8')
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'), 1)
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM inventory_openings'), 1)
})

test('不从历史 SN 表推断期初：旧表有行，库存仍为 0', async () => {
  await resetInventory(db)
  const product = await seedProduct(db, { entityId: 'prod-legacy', trackingMode: 'item', requiresSn: 1 })

  // 旧台账里躺着 4 件「在库」的 SN —— 它们不是期初，只是历史记录。
  for (let i = 1; i <= 4; i += 1) {
    await db
      .prepare(
        `INSERT INTO serial_numbers (store_id, sn_code, product_id, status, purchase_cost_cents)
         VALUES (?, ?, ?, 'in_stock', 0)`,
      )
      .bind(STORE, `LEGACY-SN-${i}`, product.hardwareId)
      .run()
  }
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM serial_numbers'), 4)

  const inventoryList = await env.inventory.queryInventory(db, STORE, {}, { includeCost: true })
  assert.equal(inventoryList.totals.ownOnHandQty, 0, '未经人工实盘的旧 SN 不得变成库存')
  assert.equal(inventoryList.totals.availableQty, 0)
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM stock_items'), 0)
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'), 0)

  // 走一次真正的期初，才会出现库存 —— 且数量只等于实盘确认的数。
  const confirmed = await opening('req-open-legacy', {
    approvedCountRef: '实盘单 2026-09-18-I（人工点数 2 件）',
    costBasis: { kind: 'known' },
    lines: [
      { productRef: 'prod-legacy', qty: 1, condition: 'used', assetCode: 'U-201', unitCostCents: 30000 },
      { productRef: 'prod-legacy', qty: 1, condition: 'used', assetCode: 'U-202', unitCostCents: 30000 },
    ],
  })
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
  assert.equal(await scalar(db, 'SELECT available_qty FROM stock_balances'), 2, '库存等于实盘确认的 2 件，不是旧表的 4 件')
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM serial_numbers'), 4, '旧表原样保留，不被改写')
})
