/**
 * AS02 · 0027 迁移与数量件批次（stock_batches）。
 *
 * 卡面通过标准：迁移能被完整重放；数量件收货自动建批并落备注；批次不替代余额、
 * 不产生逐件实物；幂等与数据库唯一键双兜底；员工侧能按批次号与备注查到。
 * 首版边界：批次只记入库数量，余量归属未实现，故表内不得出现「剩余量」列。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createInventoryEnv, ctx, resetInventory, rows, scalar, seedProduct, STORE, ACTOR } from './lib/inventory.mjs'

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

async function reset() {
  await resetInventory(db)
  await db.prepare('DELETE FROM stock_batches').run()
}

async function columns(table) {
  return (await rows(db, `PRAGMA table_info(${table})`)).map((row) => row.name)
}

async function insertBatch(overrides = {}) {
  const row = {
    id: overrides.id ?? 'manual-batch-1',
    store_id: STORE,
    product_id: overrides.product_id,
    batch_code: overrides.batch_code ?? 'BT-0001-20260924-MANUAL0001',
    source_ref: overrides.source_ref ?? 'manual-source',
    source_line_ref: overrides.source_line_ref ?? 'manual-source-line',
    received_qty: overrides.received_qty ?? 1,
    occurred_at: '2026-09-24T02:00:00.000Z',
    remark: overrides.remark ?? '',
    actor_user_id: ACTOR,
  }
  return db
    .prepare(
      `INSERT INTO stock_batches
         (id, store_id, product_id, batch_code, source_ref, source_line_ref, received_qty, occurred_at, remark, actor_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.store_id,
      row.product_id,
      row.batch_code,
      row.source_ref,
      row.source_line_ref,
      row.received_qty,
      row.occurred_at,
      row.remark,
      row.actor_user_id,
    )
    .run()
}

test('0027 结构：批次表与两个备注列都在，且没有批次余量列', async () => {
  const batchCols = await columns('stock_batches')
  for (const col of [
    'id',
    'store_id',
    'product_id',
    'batch_code',
    'source_ref',
    'source_line_ref',
    'received_qty',
    'occurred_at',
    'remark',
    'actor_user_id',
  ]) {
    assert.ok(batchCols.includes(col), `stock_batches 缺列 ${col}`)
  }
  assert.ok(!batchCols.some((col) => col.includes('remain')), '首版不做批次余量，表里不该有剩余量列')

  assert.ok((await columns('stock_items')).includes('remark'), 'stock_items.remark 未建')
  assert.ok(
    (await columns('customer_device_custody')).includes('manufacturer_sn'),
    'customer_device_custody.manufacturer_sn 未建',
  )
})

test('数量件期初：自动生成 BT 批次号，数量与备注落库', async () => {
  await reset()
  await seedProduct(db, { entityId: 'prod-batch-1', name: 'SATA 数据线' })

  const result = await opening('req-batch-1', {
    approvedCountRef: '实盘单 BATCH-1',
    costBasis: { kind: 'known' },
    lines: [{ productRef: 'prod-batch-1', qty: 12, unitCostCents: 300, remark: ' 蓝色包装 ' }],
  })
  assert.equal(result.ok, true, JSON.stringify(result))

  const batches = await rows(
    db,
    'SELECT batch_code, received_qty, remark, source_ref, source_line_ref FROM stock_batches',
  )
  assert.equal(batches.length, 1)
  assert.match(batches[0].batch_code, /^BT-0001-\d{8}-[0-9A-F]{10}$/, `批次号异常：${batches[0].batch_code}`)
  assert.equal(batches[0].received_qty, 12)
  assert.equal(batches[0].remark, '蓝色包装', '备注去空白后落库')
  assert.ok(batches[0].source_ref, '批次必须能指回期初单')
  assert.ok(batches[0].source_line_ref, '批次必须能指回收货行')

  assert.equal(await scalar(db, 'SELECT available_qty FROM stock_balances'), 12, '批次不替代余额')
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM stock_items'), 0, '数量件不产生逐件实物')
})

test('逐件期初不建批次：批次只服务数量件', async () => {
  await reset()
  await seedProduct(db, { entityId: 'prod-batch-item', name: '二手整机', trackingMode: 'item', requiresSn: 1 })

  const result = await opening('req-batch-item', {
    approvedCountRef: '实盘单 BATCH-ITEM',
    costBasis: { kind: 'known' },
    lines: [{ productRef: 'prod-batch-item', qty: 1, condition: 'used', assetCode: 'U-301', unitCostCents: 50000 }],
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM stock_batches'), 0)
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM stock_items'), 1)
})

test('同 requestId 重放：批次不重复建，数量不翻倍', async () => {
  await reset()
  await seedProduct(db, { entityId: 'prod-batch-idem', name: '螺丝包' })
  const input = {
    approvedCountRef: '实盘单 BATCH-IDEM',
    costBasis: { kind: 'known' },
    lines: [{ productRef: 'prod-batch-idem', qty: 7, unitCostCents: 100 }],
  }

  const first = await opening('req-batch-idem', input)
  const second = await opening('req-batch-idem', input)

  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(second.reused, true)
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM stock_batches'), 1)
  assert.equal(await scalar(db, 'SELECT available_qty FROM stock_balances'), 7, '不得累加成 14')
})

test('同一收货行重复建批：数据库唯一键直接拒绝', async () => {
  await reset()
  const product = await seedProduct(db, { entityId: 'prod-batch-uniq', name: '扎带' })

  await insertBatch({ product_id: product.hardwareId })
  let rejected = false
  try {
    await insertBatch({ id: 'manual-batch-2', product_id: product.hardwareId, batch_code: 'BT-0001-20260924-OTHER0002' })
  } catch {
    rejected = true
  }
  assert.equal(rejected, true, '同一 source_line_ref 必须建不了第二批')
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM stock_batches'), 1)
})

test('零数量批次：CHECK 拒绝，不允许用空行表达取消', async () => {
  await reset()
  const product = await seedProduct(db, { entityId: 'prod-batch-zero', name: '硅脂' })

  let rejected = false
  try {
    await insertBatch({ id: 'manual-batch-zero', product_id: product.hardwareId, received_qty: 0 })
  } catch {
    rejected = true
  }
  assert.equal(rejected, true)
  assert.equal(await scalar(db, 'SELECT COUNT(*) FROM stock_batches'), 0)
})

test('员工库存查询：能按批次号与备注查到批次', async () => {
  await reset()
  await seedProduct(db, { entityId: 'prod-batch-q', name: '机箱风扇' })

  const result = await opening('req-batch-q', {
    approvedCountRef: '实盘单 BATCH-Q',
    costBasis: { kind: 'known' },
    lines: [{ productRef: 'prod-batch-q', qty: 4, unitCostCents: 1500, remark: '三楼货架第二格' }],
  })
  assert.equal(result.ok, true, JSON.stringify(result))

  const batchCode = await scalar(db, 'SELECT batch_code FROM stock_batches')
  const byCode = await env.inventory.queryInventory(db, STORE, { q: batchCode }, { includeCost: true })
  assert.equal(byCode.batches.length, 1, '按批次号必须命中')
  assert.equal(byCode.batches[0].batchCode, batchCode)
  assert.equal(byCode.batches[0].receivedQty, 4)
  assert.equal(byCode.batches[0].productName, '机箱风扇')
  assert.equal(byCode.batches[0].remark, '三楼货架第二格')

  const byRemark = await env.inventory.queryInventory(db, STORE, { q: '三楼货架' }, { includeCost: true })
  assert.equal(byRemark.batches.length, 1, '按备注必须命中')

  const empty = await env.inventory.queryInventory(db, STORE, { q: '不存在的批次' }, { includeCost: true })
  assert.equal(empty.batches.length, 0)
})
