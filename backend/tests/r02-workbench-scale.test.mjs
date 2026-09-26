/**
 * R02 · 工作台在「每类在办超过 200 条」时的统计口径（P03）。
 *
 * 为什么单独一个文件：r02-workbench.test.mjs 用的是几件单据的小夹具，
 * 照不出「每类 LIMIT 200」这条读取上限对统计的影响。本卡用合成的大数据集回答两个问题：
 *
 *   1. metrics 必须是**全集**在办事项的统计 —— 不能跟着明细读取的上限一起被截断
 *      （conventions.pagination.snapshot：「分页不得改变汇总口径」；workbench.ts 自己的注释
 *      也写着 metrics 基于未筛选的完整在办集合）；
 *   2. 筛选与 limit 仍然不得改变统计，明细列表仍然受 limit 约束。
 *
 * 正确性判据是**独立预期**：逐单循环 + 另一种 SQL 写法（LEFT JOIN + GROUP BY）重新算一遍缺件，
 * 再按状态集合分类。旧实现不是基准 —— 实测过它会把 255 条在办销售单统计成 133 条。
 *
 * 只跑本机内存 D1（miniflare + 真实迁移），不连远端、不写生产。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createTestEnv, seedStore } from './lib/env.mjs'
import { bundleModule } from './lib/build.mjs'

const STORE = 1
const EMPTY_STORE = 2
const ACTOR = 1

/** 与 workbench.ts 判定表一致的在办状态集合（不是抄 SQL：状态集合本身就是业务口径）。 */
const SERVICE_OPEN_STATES = [
  'received', 'diagnosing', 'awaiting_approval', 'repairing', 'outsourced', 'retesting', 'ready_return',
]
const RECOVERY_OPEN_STATES = [
  'received_for_inspection', 'inspecting', 'offered', 'acquired', 'disassembled', 'refurbishing', 'return_pending',
]

let env
let db
let workbench

// ─────────────────────────────── 数据集 ───────────────────────────────

const NOW = new Date('2026-09-26T07:00:00Z')
const STAMP_BASE = Date.UTC(2026, 8, 26, 6, 0, 0)
/** 建单时间每单差 1 小时且互不相同：时间戳撞车会让「按 created_at 取前 200」的窗口不可复现。 */
const stamp = (seq) => new Date(STAMP_BASE - seq * 3600 * 1000).toISOString()

const SERVICE_STATES = [
  'received', 'diagnosing', 'awaiting_approval', 'repairing', 'outsourced',
  'retesting', 'ready_return', 'returned', 'closed',
]
const RECOVERY_STATES = [
  'draft', 'received_for_inspection', 'inspecting', 'offered', 'acquired',
  'disassembled', 'refurbishing', 'ready_for_sale', 'return_pending', 'returned',
]

/** 分批提交：几千条单条往返会把建库拖到分钟级。取出待提交区必须同步完成，否则会重复提交。 */
function batcher(db, chunk = 200) {
  let pending = []
  let chain = Promise.resolve()
  return {
    add(statement) {
      pending.push(statement)
      if (pending.length < chunk) return undefined
      const batch = pending
      pending = []
      chain = chain.then(() => db.batch(batch))
      return chain
    },
    async flush() {
      if (pending.length > 0) {
        const batch = pending
        pending = []
        chain = chain.then(() => db.batch(batch))
      }
      return chain
    },
  }
}

/**
 * 造一家店的合成数据：含终态（delivered / returned / ready_for_sale）、草稿、缺件、维修、回收。
 * 数量刻意让销售、工单、回收三类在办都超过 200 条。
 */
async function seedLargeStore(storeId, { saleTotal, serviceTotal, recoveryTotal }) {
  const batch = batcher(db)

  const productIds = []
  for (let k = 0; k < 10; k += 1) {
    const id = storeId * 1000 + k
    productIds.push(id)
    batch.add(db.prepare(
      `INSERT INTO hardware (id, user_id, store_id, category, name, tracking_mode, is_serialized)
       VALUES (?, ?, ?, 'cpu', ?, ?, ?)`,
    ).bind(id, ACTOR, storeId, `P03 商品 ${storeId}-${k}`, k % 2 === 0 ? 'item' : 'quantity', k % 2 === 0 ? 1 : 0))
  }
  await batch.flush()

  for (let i = 0; i < saleTotal; i += 1) {
    const orderId = `p03-sale-${storeId}-${i}`
    const isDraft = i % 17 === 16
    const isDelivered = !isDraft && i % 11 === 10
    const isShortage = !isDraft && !isDelivered && i % 3 === 0
    const tradeState = isDraft ? 'draft' : 'confirmed'
    const fulfillment = isDelivered ? 'delivered' : ['waiting_stock', 'preparing', 'testing', 'ready_delivery'][i % 4]
    const createdAt = stamp(i)

    const usedItemId = i % 2 === 0 ? `p03-si-${storeId}-${i}` : null
    if (usedItemId) {
      batch.add(db.prepare(
        `INSERT INTO stock_items
           (id, store_id, product_id, asset_code, condition, ownership, availability, location,
            acquisition_cost_cents, cost_known, version)
         VALUES (?, ?, ?, ?, 'used', 'store', 'reserved', 'store', 50000, 1, 1)`,
      ).bind(usedItemId, storeId, productIds[i % 10], `P03-SN-${storeId}-${i}`))
    }

    const lines = []
    if (usedItemId) {
      lines.push({ source: 'used', qty: 1, unit: 100000 + i, stockItemId: usedItemId, newIndex: null })
    }
    lines.push({ source: 'new', qty: 1 + (i % 2), unit: 200000 + i, stockItemId: null, newIndex: 0 })

    const subtotal = lines.reduce((sum, line) => sum + line.unit * line.qty, 0)
    const cashNet = [0, Math.floor(subtotal * 0.3), subtotal][i % 3]
    const balance = subtotal - cashNet

    batch.add(db.prepare(
      `INSERT INTO sale_orders
         (id, store_id, order_no, customer_snapshot, kind, trade_state, fulfillment_state, due_at,
          configuration_version, subtotal_cents, discount_cents, adjustment_cents, total_cents,
          cash_net_cents, offset_net_cents, return_credit_cents, balance_cents, balance_direction,
          version, request_id, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, ?, ?, 0, 0, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      orderId, storeId, `SO-${storeId}-${String(i).padStart(4, '0')}`,
      JSON.stringify({ name: `客户 ${i}` }), i % 2 === 0 ? 'assembly' : 'retail',
      tradeState, fulfillment,
      i % 7 === 0 ? new Date(Date.UTC(2026, 8, 20, 3)).toISOString() : null,
      subtotal, subtotal, cashNet, balance, balance > 0 ? 'client_due' : 'settled',
      `${orderId}::req`, ACTOR, ACTOR, createdAt, createdAt,
    ))

    for (let position = 0; position < lines.length; position += 1) {
      const line = lines[position]
      const lineId = `${orderId}::L${position}`
      batch.add(db.prepare(
        `INSERT INTO sale_lines
           (id, store_id, sale_order_id, position, product_id, source, name_snapshot, spec_snapshot,
            qty, unit_price_cents, discount_allocation_cents, net_line_cents, stock_item_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, 0, ?, ?)`,
      ).bind(
        lineId, storeId, orderId, position, productIds[(i + position) % 10], line.source,
        `P03 行 ${position}`, line.qty, line.unit, line.unit * line.qty, line.stockItemId,
      ))

      if (line.source !== 'new' || isDraft || isDelivered) continue
      // 缺件单：新品行一条不占 ⇒ 缺 1 行
      const covered = isShortage ? 0 : line.qty
      for (let r = 0; r < covered; r += 1) {
        batch.add(db.prepare(
          `INSERT INTO stock_reservations
             (id, store_id, stock_item_id, quantity_bucket_ref, order_ref, line_ref, qty,
              status, version, request_id, created_at)
           VALUES (?, ?, NULL, 'store', ?, ?, 1, 'active', 1, ?, ?)`,
        ).bind(`${lineId}::R${r}`, storeId, orderId, lineId, `${lineId}::R${r}::req`, createdAt))
      }
    }
  }
  await batch.flush()

  for (let i = 0; i < serviceTotal; i += 1) {
    const orderId = `p03-svc-${storeId}-${i}`
    const deviceId = `p03-dev-${storeId}-${i}`
    const chargeConfirmed = i % 2 === 0
    const charge = chargeConfirmed ? 20000 + i : null
    const cashNet = chargeConfirmed ? (i % 4 === 0 ? 0 : Math.floor(charge * 0.5)) : 0
    const balance = (charge ?? 0) - cashNet
    const createdAt = stamp(i)
    batch.add(db.prepare(
      `INSERT INTO customer_device_custody
         (id, store_id, device_code, custody_location, version, request_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'store', 1, ?, ?, ?, ?)`,
    ).bind(deviceId, storeId, `P03-DEV-${storeId}-${i}`, `${deviceId}::req`, ACTOR, createdAt, createdAt))
    batch.add(db.prepare(
      `INSERT INTO service_orders
         (id, store_id, order_no, device_id, symptom, intake_snapshot, state, proposal_version,
          confirmed_charge_cents, due_at, cash_net_cents, balance_cents, balance_direction,
          version, request_id, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      orderId, storeId, `WO-${storeId}-${String(i).padStart(4, '0')}`, deviceId,
      `故障 ${i}`, JSON.stringify({ customerName: `机主 ${i}` }),
      SERVICE_STATES[i % SERVICE_STATES.length], chargeConfirmed ? 1 : null, charge,
      cashNet, balance, balance > 0 ? 'client_due' : 'settled',
      `${orderId}::req`, ACTOR, ACTOR, createdAt, createdAt,
    ))
  }
  await batch.flush()

  for (let i = 0; i < recoveryTotal; i += 1) {
    const orderId = `p03-rec-${storeId}-${i}`
    const state = RECOVERY_STATES[i % RECOVERY_STATES.length]
    const acquired = ['acquired', 'disassembled', 'refurbishing', 'return_pending', 'ready_for_sale'].includes(state)
    const final = acquired ? 50000 + i : null
    const paid = acquired && i % 2 === 0 ? 20000 : 0
    const createdAt = stamp(i)
    batch.add(db.prepare(
      `INSERT INTO recovery_orders
         (id, store_id, order_no, seller_snapshot, state, initial_estimate_cents,
          final_acquisition_cents, payable_cents, paid_cents, version, request_id,
          created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      orderId, storeId, `TR-${storeId}-${String(i).padStart(4, '0')}`,
      JSON.stringify({ name: `卖家 ${i}` }), state, 150000 + i, final,
      final === null ? 0 : final - paid, paid, `${orderId}::req`, ACTOR, ACTOR, createdAt, createdAt,
    ))
    batch.add(db.prepare(
      `INSERT INTO recovery_items
         (id, store_id, recovery_order_id, description, condition, sn_raw, estimated_cents, request_id, created_at)
       VALUES (?, ?, ?, ?, 'used', ?, ?, ?, ?)`,
    ).bind(`${orderId}::I0`, storeId, orderId, `旧机 ${i}`, `P03-SN-${storeId}-${i}`, 150000 + i, `${orderId}::I0::req`, createdAt))
  }
  await batch.flush()
}

// ─────────────────────────────── 独立预期 ───────────────────────────────

/**
 * 逐单重算：缺件用 LEFT JOIN + GROUP BY（与实现里的 correlated SUM 不是同一写法），
 * 分类按状态集合判定。返回的每一个数都必须能单独讲清来源。
 */
async function expectedTotals(storeId) {
  const all = async (sql, ...params) => (await db.prepare(sql).bind(...params).all()).results ?? []

  const saleRows = await all(
    `SELECT o.id, o.order_no, o.balance_cents, o.created_at, o.due_at
       FROM sale_orders o
      WHERE o.store_id = ? AND o.trade_state = 'confirmed' AND o.fulfillment_state <> 'delivered'`,
    storeId,
  )
  let delivery = 0
  let shortage = 0
  let saleReceivable = 0
  const saleTasks = []
  for (const row of saleRows) {
    const gap = await db.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT l.id, l.qty, COALESCE(SUM(r.qty), 0) AS covered
           FROM sale_lines l
           LEFT JOIN stock_reservations r
             ON r.line_ref = l.id AND r.status = 'active' AND r.quantity_bucket_ref IS NOT NULL
          WHERE l.sale_order_id = ? AND l.source = 'new' AND l.stock_item_id IS NULL
          GROUP BY l.id, l.qty
       ) WHERE qty > covered`,
    ).bind(row.id).first()
    const isShortage = (gap?.n ?? 0) > 0
    if (isShortage) shortage += 1
    else delivery += 1
    saleReceivable += Math.max(row.balance_cents, 0)
    saleTasks.push({
      entityId: row.order_no,
      category: isShortage ? 'stock_shortage' : 'delivery',
      createdAt: row.created_at,
      dueAt: row.due_at,
    })
  }

  const serviceRows = await all(
    `SELECT order_no, state, confirmed_charge_cents, balance_cents FROM service_orders WHERE store_id = ?`,
    storeId,
  )
  const serviceTasks = serviceRows.filter((row) => SERVICE_OPEN_STATES.includes(row.state))
  const serviceReceivable = serviceTasks.reduce(
    (sum, row) => sum + (row.confirmed_charge_cents !== null ? Math.max(row.balance_cents, 0) : 0),
    0,
  )

  const recoveryRows = await all(
    `SELECT order_no, state FROM recovery_orders WHERE store_id = ?`,
    storeId,
  )
  const recoveryTasks = recoveryRows.filter((row) => RECOVERY_OPEN_STATES.includes(row.state))

  return {
    delivery,
    shortage,
    service: serviceTasks.length,
    recovery: recoveryTasks.length,
    taskTotal: delivery + shortage + serviceTasks.length + recoveryTasks.length,
    receivableCents: saleReceivable + serviceReceivable,
    saleReceivableCents: saleReceivable,
    serviceReceivableCents: serviceReceivable,
    tasks: [
      ...saleTasks,
      ...serviceTasks.map((row) => ({ entityId: row.order_no, category: 'service', createdAt: null, dueAt: null })),
      ...recoveryTasks.map((row) => ({ entityId: row.order_no, category: 'recovery', createdAt: null, dueAt: null })),
    ],
  }
}

// ─────────────────────────────── 环境 ───────────────────────────────

before(async () => {
  env = await createTestEnv({ demo: false })
  db = env.db
  await seedStore(db, { storeId: STORE, userId: ACTOR })
  await seedStore(db, { storeId: EMPTY_STORE, userId: 2 })
  workbench = await bundleModule('src/domains/workbench.ts', 'p03-workbench-scale')
  await seedLargeStore(STORE, { saleTotal: 320, serviceTotal: 270, recoveryTotal: 300 })
})

after(async () => {
  await env?.dispose()
})

const read = (storeId = STORE, query = {}) => workbench.queryWorkbench(db, storeId, query, NOW)

// ─────────────────────────────── 断言 ───────────────────────────────

test('P03：每类在办都超过 200 条时，metrics 是全集统计而不是被截断的前 200', async () => {
  const expected = await expectedTotals(STORE)
  const snapshot = await read()

  // 前提先立住：确实超过了每类 200 的上限，否则这条用例照不出问题
  assert.ok(expected.delivery + expected.shortage > 200, `销售在办 ${expected.delivery + expected.shortage} 条应超过 200`)
  assert.ok(expected.service > 200, `工单在办 ${expected.service} 条应超过 200`)
  assert.ok(expected.recovery > 200, `回收在办 ${expected.recovery} 条应超过 200`)

  assert.equal(snapshot.metrics.pendingDelivery.value, expected.delivery)
  assert.equal(snapshot.metrics.stockShortage.value, expected.shortage)
  assert.equal(snapshot.metrics.servicePending.value, expected.service)
  assert.equal(snapshot.metrics.taskTotal.value, expected.taskTotal)
  assert.equal(snapshot.metrics.receivable.valueCents, expected.receivableCents)
  assert.equal(
    snapshot.metrics.receivable.valueCents,
    expected.saleReceivableCents + expected.serviceReceivableCents,
    '应收只累加 countsTowardReceivable 的余额（未确认收购的回收单不计）',
  )
})

test('P03：明细列表仍受 limit 约束，且统计不小于列表长度', async () => {
  const expected = await expectedTotals(STORE)
  const snapshot = await read()

  assert.equal(snapshot.tasks.length, 20, '契约默认 limit = 20')
  assert.ok(snapshot.metrics.taskTotal.value > snapshot.tasks.length, '统计是全集，列表是一次分页')
  assert.ok(snapshot.metrics.taskTotal.value <= expected.taskTotal)

  const capped = await read(STORE, { limit: 999 })
  assert.equal(capped.tasks.length, 100, '契约 maxLimit = 100')
  assert.deepEqual(capped.metrics, snapshot.metrics)

  const limited = await read(STORE, { limit: 5 })
  assert.equal(limited.tasks.length, 5)
  assert.deepEqual(limited.metrics, snapshot.metrics, 'limit 不得改变统计')
})

test('P03：筛选不得改变统计（界面要能区分「没有待办」与「筛掉了」）', async () => {
  const full = await read()
  const filtered = await read(STORE, { category: 'service', limit: 3 })
  assert.equal(filtered.tasks.length, 3)
  assert.ok(filtered.tasks.every((task) => task.category === 'service'))
  assert.deepEqual(filtered.metrics, full.metrics)

  const miss = await read(STORE, { q: '绝不存在的关键词-zzz' })
  assert.equal(miss.tasks.length, 0)
  assert.deepEqual(miss.metrics, full.metrics)
})

test('P03：返回的每一条待办都能在全集里对上，不凭空造单', async () => {
  const expected = await expectedTotals(STORE)
  const known = new Set(expected.tasks.map((task) => task.entityId))
  const snapshot = await read()

  assert.ok(snapshot.tasks.length > 0)
  for (const task of snapshot.tasks) {
    assert.ok(known.has(task.entityId), `${task.entityId} 不在全集里`)
  }
  assert.equal(new Set(snapshot.tasks.map((task) => task.taskId)).size, snapshot.tasks.length, '同一单据不得重复出现')
})

test('P03：空门店仍是 0 与空数组（统计口径变了不代表可以编数字）', async () => {
  const snapshot = await read(EMPTY_STORE)
  assert.equal(snapshot.tasks.length, 0)
  assert.equal(snapshot.metrics.taskTotal.value, 0)
  assert.equal(snapshot.metrics.pendingDelivery.value, 0)
  assert.equal(snapshot.metrics.stockShortage.value, 0)
  assert.equal(snapshot.metrics.servicePending.value, 0)
  assert.equal(snapshot.metrics.receivable.valueCents, 0)
})

// ═══════════════════════ P06：窗口装谁 · 一次批处理 ═══════════════════════

/**
 * 上面那组用例回答「统计口径对不对」；这一组回答另外两个问题：
 *
 *   1. **明细的 200 条窗口里装的是谁**。按 `created_at ASC` 取前 200 条，装的是「最旧的 200 条」，
 *      一条刚建、但已经逾期的事项会被更早建的非逾期事项挤出窗口，界面上看不到也搜不到。
 *      改成按契约 ordering 排序后，窗口里装的是「最紧急的 200 条」。
 *   2. **回收 draft 白占名额**：它在应用层才被丢掉（没有下一步动作），却先占掉一个窗口位置。
 *
 * 判据不依赖具体实现：用「统计说有 N 条，那列表里就必须找得到」以及「逾期事项必须在窗口内」来断言。
 * 修复前的实现两条都会失败（窗口外的事项直接消失）。
 */

const WINDOW_STORE = 3
const MUTATE_STORE = 4
/** 上海时间 2026-09-20 11:00 —— 相对 NOW(09-26) 已逾期。 */
const OVERDUE_DUE_AT = '2026-09-20T03:00:00.000Z'
/** 合成商品的 id 基址，保证跨店不撞。 */
const productIdFor = (storeId) => storeId * 100_000

let windowSeeded = false

/** 一条「数量件新品单 + 足额占用」⇒ 不缺货，只会派生出一条待交机。 */
function queueOpenOrder(batch, { storeId, seq, productId, createdAt, dueAt }) {
  const orderId = `p06-sale-${storeId}-${seq}`
  const lineId = `${orderId}::L0`
  batch.add(db.prepare(
    `INSERT INTO sale_orders
       (id, store_id, order_no, customer_snapshot, kind, trade_state, fulfillment_state, due_at,
        configuration_version, subtotal_cents, discount_cents, adjustment_cents, total_cents,
        cash_net_cents, offset_net_cents, return_credit_cents, balance_cents, balance_direction,
        version, request_id, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'assembly', 'confirmed', 'waiting_stock', ?, 0, ?, 0, 0, ?, ?, 0, 0, ?, 'client_due', 1, ?, ?, ?, ?, ?)`,
  ).bind(
    orderId, storeId, `SO-${storeId}-${String(seq).padStart(4, '0')}`,
    JSON.stringify({ name: `P06 客户 ${seq}` }), dueAt,
    200_000, 200_000, 0, 200_000,
    `${orderId}::req`, ACTOR, ACTOR, createdAt, createdAt,
  ))
  batch.add(db.prepare(
    `INSERT INTO sale_lines
       (id, store_id, sale_order_id, position, product_id, source, name_snapshot, spec_snapshot,
        qty, unit_price_cents, discount_allocation_cents, net_line_cents, stock_item_id)
     VALUES (?, ?, ?, 0, ?, 'new', ?, '', 1, ?, 0, ?, NULL)`,
  ).bind(lineId, storeId, orderId, productId, `P06 商品 ${seq}`, 200_000, 200_000))
  // 占用覆盖掉整行数量 ⇒ 不算缺货（缺货单在这里是噪声，本组只关心交期排序）
  batch.add(db.prepare(
    `INSERT INTO stock_reservations
       (id, store_id, stock_item_id, quantity_bucket_ref, order_ref, line_ref, qty,
        status, version, request_id, created_at)
     VALUES (?, ?, NULL, 'store', ?, ?, 1, 'active', 1, ?, ?)`,
  ).bind(`${lineId}::R0`, storeId, orderId, lineId, `${lineId}::R0::req`, createdAt))
}

function queueRecoveryOrder(batch, { storeId, seq, state, createdAt }) {
  const orderId = `p06-rec-${storeId}-${seq}`
  batch.add(db.prepare(
    `INSERT INTO recovery_orders
       (id, store_id, order_no, seller_snapshot, state, initial_estimate_cents,
        final_acquisition_cents, payable_cents, paid_cents, version, request_id,
        created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 0, 1, ?, ?, ?, ?, ?)`,
  ).bind(
    orderId, storeId, `TR-${storeId}-${String(seq).padStart(4, '0')}`,
    JSON.stringify({ name: `P06 卖家 ${seq}` }), state, 150_000 + seq,
    `${orderId}::req`, ACTOR, ACTOR, createdAt, createdAt,
  ))
}

/**
 * 专供本组用例的店：
 *   · 240 条「建单更早、没有交期」+ 8 条「建单最新、已逾期」的在办销售单
 *     ⇒ 按 created_at 取前 200 条时，8 条逾期单一条都进不来；
 *   · 200 条 draft + 6 条真正待处理的回收单（建单最新）
 *     ⇒ 按 created_at 取前 200 条时，窗口被 draft 占满，6 条一条都进不来。
 */
async function seedWindowStore() {
  if (windowSeeded) return
  windowSeeded = true

  await seedStore(db, { storeId: WINDOW_STORE, userId: 3 })
  await seedStore(db, { storeId: MUTATE_STORE, userId: 4 })

  const batch = batcher(db)
  for (const storeId of [WINDOW_STORE, MUTATE_STORE]) {
    batch.add(db.prepare(
      `INSERT INTO hardware (id, user_id, store_id, category, name, tracking_mode, is_serialized)
       VALUES (?, ?, ?, 'cpu', 'P06 合成商品', 'quantity', 0)`,
    ).bind(productIdFor(storeId), ACTOR, storeId))
  }

  // 建单更早、无交期：这批会占满「按 created_at 取前 200」的窗口
  for (let i = 0; i < 240; i += 1) {
    queueOpenOrder(batch, {
      storeId: WINDOW_STORE,
      seq: i,
      productId: productIdFor(WINDOW_STORE),
      createdAt: new Date(Date.UTC(2026, 7, 1) + i * 60_000).toISOString(),
      dueAt: null,
    })
  }
  // 建单最新、已逾期：真正该被先看到的 8 条
  for (let i = 0; i < 8; i += 1) {
    queueOpenOrder(batch, {
      storeId: WINDOW_STORE,
      seq: 1000 + i,
      productId: productIdFor(WINDOW_STORE),
      createdAt: new Date(Date.UTC(2026, 8, 25) + i * 60_000).toISOString(),
      dueAt: OVERDUE_DUE_AT,
    })
  }
  // 200 条 draft 回收单：应用层会丢掉它们，但在 SQL 里它们照样占窗口
  for (let i = 0; i < 200; i += 1) {
    queueRecoveryOrder(batch, {
      storeId: WINDOW_STORE,
      seq: i,
      state: 'draft',
      createdAt: new Date(Date.UTC(2026, 7, 1) + i * 60_000).toISOString(),
    })
  }
  // 6 条真正待处理的回收单：建单最新
  for (let i = 0; i < 6; i += 1) {
    queueRecoveryOrder(batch, {
      storeId: WINDOW_STORE,
      seq: 1000 + i,
      state: 'received_for_inspection',
      createdAt: new Date(Date.UTC(2026, 8, 25, 1) + i * 60_000).toISOString(),
    })
  }
  await batch.flush()
}

test('P06：逾期单不会被「更早建的非逾期单」挤出 200 条窗口', async () => {
  await seedWindowStore()

  const snapshot = await read(WINDOW_STORE, { category: 'delivery', limit: 200 })
  // 前提立住：销售在办 248 条，确实超过窗口
  assert.equal(snapshot.tasks.length, 100, 'SQL 候选窗口 200 条，API 按契约最多返回 100 条')

  const overdueIds = Array.from({ length: 8 }, (_, i) => `SO-${WINDOW_STORE}-${String(1000 + i).padStart(4, '0')}`)

  // 前提断言：这条用例之所以有意义，是因为「按建单时间取前 200 条」确实装不下逾期单。
  // 把前提显式写出来 —— 它一旦不成立，这里会自己报错，而不是让用例悄悄退化成空跑。
  const legacyWindow = await db.prepare(
    `SELECT order_no FROM sale_orders
      WHERE store_id = ? AND trade_state = 'confirmed' AND fulfillment_state <> 'delivered'
      ORDER BY created_at ASC LIMIT 200`,
  ).bind(WINDOW_STORE).all()
  const legacyVisible = new Set((legacyWindow.results ?? []).map((row) => row.order_no))
  for (const orderNo of overdueIds) {
    assert.ok(!legacyVisible.has(orderNo), `前提不成立：按建单时间取的窗口已经装下了 ${orderNo}`)
  }

  const visible = new Set(snapshot.tasks.map((task) => task.entityId))
  for (const orderNo of overdueIds) {
    assert.ok(visible.has(orderNo), `${orderNo} 已逾期，却不在明细窗口里 —— 界面上看不到也搜不到`)
  }

  // 契约 ordering 第一档是「逾期」，这 8 条必须排在最前
  assert.deepEqual(
    snapshot.tasks.slice(0, 8).map((task) => task.entityId).sort(),
    [...overdueIds].sort(),
    '逾期事项必须排在明细最前面',
  )
})

test('P06：回收 draft 不再白占窗口名额 —— 统计说有 6 条，列表里就得找得到这 6 条', async () => {
  await seedWindowStore()

  const snapshot = await read(WINDOW_STORE, { category: 'recovery', limit: 200 })

  // 前提断言：按建单时间取的前 200 条回收单全是 draft —— 这正是修复前窗口被占满、明细为空的机制。
  const legacyRecovery = await db.prepare(
    `SELECT state FROM recovery_orders
      WHERE store_id = ? AND state NOT IN ('returned', 'ready_for_sale')
      ORDER BY created_at ASC LIMIT 200`,
  ).bind(WINDOW_STORE).all()
  assert.equal(legacyRecovery.results.length, 200, '前提不成立：窗口没被占满')
  assert.ok(
    (legacyRecovery.results ?? []).every((row) => row.state === 'draft'),
    '前提不成立：按建单时间取的窗口里混进了非 draft 单',
  )

  // 统计是全店全集：248 条在办销售单 + 6 条待处理回收单（draft 从来不算在办）
  assert.equal(snapshot.metrics.taskTotal.value, 254)

  // 统计说这 6 条在办，明细里就必须找得到这 6 条。
  // 修复前窗口被 200 条 draft 占满、draft 又到应用层才被丢掉，这里会是 0 条 —— 统计与列表互相矛盾。
  const expected = Array.from(
    { length: 6 },
    (_, i) => `TR-${WINDOW_STORE}-${String(1000 + i).padStart(4, '0')}`,
  ).sort()
  assert.deepEqual(snapshot.tasks.map((task) => task.entityId).sort(), expected)
  assert.ok(snapshot.tasks.every((task) => task.category === 'recovery'))
})

test('P06：四段读走一次批处理 —— 这是「同一读取快照」的机制证据', async () => {
  await seedWindowStore()

  const prepared = []
  const batchSizes = []
  const spy = {
    prepare(sql) {
      prepared.push(sql)
      return db.prepare(sql)
    },
    batch(statements) {
      batchSizes.push(statements.length)
      return db.batch(statements)
    },
  }

  const viaSpy = await workbench.queryWorkbench(spy, STORE, {}, NOW)
  // 四次独立往返不构成快照：中间任何一次写入都会让 metrics 与 tasks 各描述一份数据。
  assert.equal(batchSizes.length, 1, '四段读必须一次批处理发出')
  assert.deepEqual(batchSizes, [4], '三类明细各一条 + 一次全店统计')
  assert.equal(prepared.length, 4)

  // 批处理的结果顺序必须与语句顺序一致，否则会张冠李戴
  const direct = await read()
  assert.deepEqual(viaSpy.metrics, direct.metrics)
  assert.deepEqual(viaSpy.tasks, direct.tasks)
})

test('P06：读不缓存陈旧快照 —— 写入后紧接着的工作台读取必须看到新单', async () => {
  await seedWindowStore()
  assert.equal((await read(MUTATE_STORE)).metrics.taskTotal.value, 0, '这家店起初没有在办事项')

  const batch = batcher(db)
  queueOpenOrder(batch, {
    storeId: MUTATE_STORE,
    seq: 0,
    productId: productIdFor(MUTATE_STORE),
    createdAt: new Date(Date.UTC(2026, 8, 26, 5)).toISOString(),
    dueAt: null,
  })
  await batch.flush()

  const after = await read(MUTATE_STORE)
  assert.equal(after.metrics.taskTotal.value, 1, '写入后的第一次读取就该看到它')
  assert.equal(after.tasks.length, 1)
  assert.equal(after.tasks[0].entityId, `SO-${MUTATE_STORE}-0000`)
})


test('发布：内部编号约束拒绝空值，删除重复 SN 闸门不削弱编号保障', async () => {
  for (const assetCode of [null, '', '   ']) {
    await assert.rejects(
      db.prepare('UPDATE stock_items SET asset_code = ? WHERE id = ?')
        .bind(assetCode, 'p03-si-1-0').run(),
      /NOT NULL|CHECK constraint/i,
    )
  }
  const row = await db.prepare('SELECT asset_code FROM stock_items WHERE id = ?').bind('p03-si-1-0').first()
  assert.equal(row.asset_code, 'P03-SN-1-0')
})
