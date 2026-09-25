/**
 * R02 · 工作台读模型的 HTTP 接线（GET /api/v2/workbench）。
 *
 * 契约依据：
 *   actions.json     R02（无权限门槛；03 §8 权限表首行「待办」老板与店员均可）
 *   objects.json     TaskReadModel（16 字段 + 5 条排序与去重规则）
 *   enums.json       TaskCategory（delivery / stock_shortage / service / recovery / collection）
 *   fixtures.json    datasets.V1（响应形状与 expected 口径的首次冻结）
 *   conventions.json reading.noHiddenSecurity、pagination.snapshot（一次快照、分页不改汇总口径）
 *
 * 覆盖：
 *   1. 入口层：匿名 401、方法 405、非法筛选值 400、契约信封；
 *   2. 空门店不编数字（无待办就是 0，不是假数据）；
 *   3. 缺货单 → stock_shortage（卡点优先，不同时作为可交付重复出现）；
 *   4. 实物单确认成交 → delivery（B06，还没开始备料）；
 *   5. draft 单不进待办；
 *   6. metrics 与 tasks 出自同一次快照，receivable 只算 countsTowardReceivable；
 *   7. 工单 → service、回收单 → recovery；回收未确认收购不计应收；
 *   8. 跨店隔离：别家店的单不出现在本店工作台；
 *   9. 筛选（category / q / limit）与排序（逾期优先）；
 *  10. 响应里没有成本、供应商、毛利字段（服务端过滤，不是前端隐藏）。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'
import { seedProduct } from './lib/inventory.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER_A = { email: 'r02-owner-a@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: '工作台甲店' }
const OWNER_B = { email: 'r02-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: '工作台乙店' }

let env
let db
let a
let b
/** 无任何权限的店员（门店甲）：R02 无门槛，他照样该拿到工作台 */
let clerk

const json = async (response) => ({ status: response.status, body: await response.json() })

const scalar = async (sql, ...params) => {
  const row = await db.prepare(sql).bind(...params).first()
  return row ? Object.values(row)[0] : null
}

async function seedClerk({ userId, email, storeId = 1, permissions = [] }) {
  await db.prepare(`INSERT INTO users (id, email, password_hash, status) VALUES (?, ?, ?, 'active')`)
    .bind(userId, email, await legacyPasswordHash(PASSWORD)).run()
  const member = await db.prepare(`INSERT INTO store_members (store_id, user_id, status, is_owner, created_by, updated_by)
    VALUES (?, ?, 'active', 0, ?, ?)`).bind(storeId, userId, userId, userId).run()
  const memberId = member.meta.last_row_id
  if (permissions.length) {
    const role = await db.prepare('INSERT INTO roles (store_id, code, name) VALUES (?, ?, ?)')
      .bind(storeId, `role-r02-${userId}`, `角色 ${userId}`).run()
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

/** 播一件门店甲的可用实物（必须带入库流水，否则余额与实物脱节）。 */
async function seedStockItem({ id, productId, assetCode }) {
  await db.prepare(
    `INSERT INTO stock_items
       (id, store_id, product_id, asset_code, condition, ownership, availability, location,
        acquisition_cost_cents, cost_known, version)
     VALUES (?, 1, ?, ?, 'used', 'store', 'available', 'store', 50000, 1, 1)`,
  ).bind(id, productId, assetCode).run()
  await db.prepare(
    `INSERT INTO inventory_movements
       (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
        source, occurred_at, actor_user_id, request_id)
     VALUES (?, 1, ?, ?, 1, NULL, 'available', 50000, 'opening_balance', ?, 1, ?)`,
  ).bind(`${id}::seed`, productId, id, new Date().toISOString(), `${id}::seed-req`).run()
  return id
}

const newLine = (productRef, unitPriceCents, qty = 1) => ({
  source: 'new', nameSnapshot: '新品 CPU', specSnapshot: '', qty, unitPriceCents, productRef,
})
const usedLine = (stockItemId, unitPriceCents) => ({
  source: 'used', nameSnapshot: '二手显卡', specSnapshot: '拆机件', qty: 1, unitPriceCents, stockItemId,
})

async function createIssuedQuote(client, { requestId, lines, discountCents = 0 }) {
  const create = await json(await client.post('/api/v2/sales/quotes', {
    requestId: `${requestId}-c`, title: `工作台 ${requestId}`, lines, discountCents,
  }))
  assert.equal(create.status, 200, JSON.stringify(create.body))
  const quoteId = create.body.data.entityId
  const issue = await json(await client.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/issue`, {
    requestId: `${requestId}-i`, expectedVersion: create.body.data.entityVersion,
  }))
  assert.equal(issue.status, 200, JSON.stringify(issue.body))
  return { quoteId, revision: issue.body.data.effects.revision }
}

const convert = async (client, quoteId, quoteVersion, requestId) =>
  json(await client.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/convert`, { requestId, quoteVersion }))

const pay = async (client, orderId, amountCents, requestId) =>
  json(await client.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/payments`, {
    requestId, amountCents, method: 'wechat', verificationState: 'verified',
  }))

const confirm = async (client, orderId, requestId) =>
  json(await client.post(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/confirm`, { requestId }))

const intake = async (client, requestId, body) =>
  json(await client.post('/api/v2/service/orders', { requestId, ...body }))

const register = async (client, requestId, body) =>
  json(await client.post('/api/v2/recovery/orders', { requestId, ...body }))

const workbench = async (client, query = '') =>
  json(await client.get(`/api/v2/workbench${query}`))

/** 走完「报价 → 转单 → 付清 → 确认成交」，返回销售单的 id 与单号。 */
async function toConfirmedOrder(client, tag, { lines }) {
  const { quoteId, revision } = await createIssuedQuote(client, { requestId: tag, lines })
  const converted = await convert(client, quoteId, revision, `${tag}-conv`)
  assert.equal(converted.status, 200, JSON.stringify(converted.body))
  const orderId = converted.body.data.entityId
  const total = await scalar('SELECT total_cents FROM sale_orders WHERE id = ?', orderId)
  const paid = await pay(client, orderId, total, `${tag}-pay`)
  assert.equal(paid.status, 200, JSON.stringify(paid.body))
  const done = await confirm(client, orderId, `${tag}-confirm`)
  assert.equal(done.status, 200, JSON.stringify(done.body))
  const orderNo = await scalar('SELECT order_no FROM sale_orders WHERE id = ?', orderId)
  return { orderId, orderNo, totalCents: total }
}

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER_A)
  await seedOwner(db, OWNER_B)
  a = createClient(env.call, await login(env.call, OWNER_A))
  b = createClient(env.call, await login(env.call, OWNER_B))
  clerk = createClient(env.call, await login(env.call, await seedClerk({ userId: 30, email: 'r02-noperm@local.test' })))
})

after(async () => {
  await env?.dispose()
})

// ─────────────────────────── 入口与信封 ───────────────────────────

test('R02：匿名 401；无权限店员照样能读工作台（03 §8 首行：待办是基础能力）', async () => {
  const anonymous = await env.call('/api/v2/workbench', { method: 'GET' })
  assert.equal(anonymous.status, 401)

  const asClerk = await workbench(clerk)
  assert.equal(asClerk.status, 200, JSON.stringify(asClerk.body))
  assert.ok(Array.isArray(asClerk.body.data.tasks))
  assert.equal(asClerk.body.meta.contractVersion, 'v1')
})

test('R02：非法筛选值拒绝而不是静默忽略；非 GET 405', async () => {
  const badCategory = await workbench(a, '?category=not-a-category')
  assert.equal(badCategory.status, 400)
  assert.equal(badCategory.body.error.code, 'VALIDATION_ERROR')

  const badScope = await workbench(a, '?scope=everything')
  assert.equal(badScope.status, 400)

  const badLimit = await workbench(a, '?limit=abc')
  assert.equal(badLimit.status, 400)

  const zeroLimit = await workbench(a, '?limit=0')
  assert.equal(zeroLimit.status, 400)

  const post = await json(await a.post('/api/v2/workbench', { requestId: 'x' }))
  assert.equal(post.status, 405)
})

test('R02：category=all 与不传等价（前端「全部」按钮不该 400）', async () => {
  const all = await workbench(a, '?category=all')
  assert.equal(all.status, 200, JSON.stringify(all.body))
  assert.equal(all.body.data.filters.category, null)
})

test('R02：空门店不编数字 —— 没有待办就是 0 与空数组', async () => {
  // 乙店此时一件单据都没有
  const empty = await workbench(b)
  assert.equal(empty.status, 200, JSON.stringify(empty.body))
  const { tasks, metrics } = empty.body.data
  assert.equal(tasks.length, 0)
  assert.equal(metrics.taskTotal.value, 0)
  assert.equal(metrics.pendingDelivery.value, 0)
  assert.equal(metrics.stockShortage.value, 0)
  assert.equal(metrics.servicePending.value, 0)
  assert.equal(metrics.receivable.valueCents, 0)
})

// ─────────────────────────── 销售单两类 ───────────────────────────

test('R02：缺货单归「缺货」并给 B15；卡点优先，不同时作为待交付重复出现', async () => {
  const product = await seedProduct(db, { entityId: 'r02-short-cpu', name: '工作台新品A', trackingMode: 'quantity' })
  // 数量件、店里没有可用量 ⇒ 确认成交后进缺口
  const { orderNo } = await toConfirmedOrder(a, 'r02-short', { lines: [newLine(product.entityId, 300_000)] })

  const snapshot = await workbench(a, '?category=stock_shortage')
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body))
  const task = snapshot.body.data.tasks.find((item) => item.entityId === orderNo)
  assert.ok(task, `缺货单 ${orderNo} 应出现在缺货待办里`)
  assert.equal(task.category, 'stock_shortage')
  assert.equal(task.entityType, 'sale_order')
  assert.equal(task.primaryAction.code, 'B15')
  assert.ok(task.amountSummary, '销售单必须有金额摘要')

  // 同一张单不能同时以 delivery 身份再出现一次
  const delivery = await workbench(a, '?category=delivery')
  assert.equal(delivery.body.data.tasks.some((item) => item.entityId === orderNo), false)
})

test('R02：实物单确认成交后归「待交机」，阶段没到就给 B06 而不是 B10', async () => {
  const product = await seedProduct(db, { entityId: 'r02-stock-gpu', name: '工作台实物B', trackingMode: 'item' })
  const itemId = await seedStockItem({ id: 'r02-si-gpu', productId: product.hardwareId, assetCode: 'R02-AC-1' })
  const { orderId, orderNo } = await toConfirmedOrder(a, 'r02-deliver', { lines: [usedLine(itemId, 500_000)] })

  // B05 只锁货，履约阶段仍是 waiting_stock（备料与装机是 B06）
  assert.equal(await scalar('SELECT fulfillment_state FROM sale_orders WHERE id = ?', orderId), 'waiting_stock')

  const snapshot = await workbench(a, '?category=delivery')
  const task = snapshot.body.data.tasks.find((item) => item.entityId === orderNo)
  assert.ok(task, `已成交实物单 ${orderNo} 应出现在待交机里`)
  assert.equal(task.category, 'delivery')
  assert.equal(task.primaryAction.code, 'B06', '还没开始备料，主动作必须是 B06，不能给一个点了必然 400 的 B10')
  assert.equal(task.primaryAction.enabled, true)
  assert.equal(task.primaryAction.blockers.length, 0)
})

test('R02：确认成交后到交付阶段的单，主动作是 B10，尾款未清时带可读卡点', async () => {
  const product = await seedProduct(db, { entityId: 'r02-ready-cpu', name: '工作台实物C', trackingMode: 'item' })
  const itemId = await seedStockItem({ id: 'r02-si-cpu', productId: product.hardwareId, assetCode: 'R02-AC-2' })
  // 只付定金并确认成交，然后直接把履约阶段推到 ready_delivery（备料与检测是 E08 的流程）
  const { quoteId, revision } = await createIssuedQuote(a, { requestId: 'r02-ready', lines: [usedLine(itemId, 400_000)] })
  const converted = await convert(a, quoteId, revision, 'r02-ready-conv')
  const orderId = converted.body.data.entityId
  await pay(a, orderId, 60_000, 'r02-ready-pay')
  const done = await confirm(a, orderId, 'r02-ready-confirm')
  assert.equal(done.status, 200, JSON.stringify(done.body))
  await db.prepare(`UPDATE sale_orders SET fulfillment_state = 'ready_delivery' WHERE id = ?`).bind(orderId).run()
  const orderNo = await scalar('SELECT order_no FROM sale_orders WHERE id = ?', orderId)

  const snapshot = await workbench(a, '?category=delivery')
  const task = snapshot.body.data.tasks.find((item) => item.entityId === orderNo)
  assert.ok(task)
  assert.equal(task.primaryAction.code, 'B10')
  assert.equal(task.primaryAction.enabled, false, '尾款没结清不能放行交付')
  // 卡点顺序照后端 deliverSaleOrder 的闸门顺序：装机检测 → SN → 尾款。
  // 这张单没做检测单、实物也还没绑 SN，前两条都会出现 —— 断言「顺序」而不是写死集合，
  // 免得把夹具的 SN 配置细节耦合进断言。
  const codes = task.primaryAction.blockers.map((item) => item.code)
  assert.equal(codes[0], 'CHECKLIST_INCOMPLETE', '检测闸门排在最前')
  assert.ok(codes.includes('VALIDATION_ERROR'), '尾款未结清必须出现在卡点里')
  assert.ok(
    codes.indexOf('VALIDATION_ERROR') > codes.indexOf('CHECKLIST_INCOMPLETE'),
    '闸门顺序：检测在前、尾款在后',
  )
  const balanceBlocker = task.primaryAction.blockers.find((item) => item.code === 'VALIDATION_ERROR')
  assert.match(balanceBlocker.message, /尾款/)
  assert.ok(task.blockerSummary, '有卡点时必须给出可读摘要')
})

test('R02：草稿单不进工作台（不是待办，是没做完的开单动作）', async () => {
  const product = await seedProduct(db, { entityId: 'r02-draft', name: '工作台草稿品', trackingMode: 'quantity' })
  const { quoteId, revision } = await createIssuedQuote(a, {
    requestId: 'r02-draft', lines: [newLine(product.entityId, 100_000)],
  })
  const converted = await convert(a, quoteId, revision, 'r02-draft-conv')
  assert.equal(converted.status, 200, JSON.stringify(converted.body))
  const orderNo = await scalar('SELECT order_no FROM sale_orders WHERE id = ?', converted.body.data.entityId)

  const snapshot = await workbench(a)
  assert.equal(snapshot.body.data.tasks.some((item) => item.entityId === orderNo), false)
})

// ─────────────────────────── 工单与回收单 ───────────────────────────

test('R02：接修工单进「维修待办」，刚接修给 B21', async () => {
  const created = await intake(a, 'r02-service', {
    customerName: '陈先生', deviceCode: 'DEV-R02', symptom: '开机蓝屏',
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const orderNo = await scalar(
    'SELECT order_no FROM service_orders WHERE id = ?', created.body.data.entityId,
  )

  const snapshot = await workbench(a, '?category=service')
  const task = snapshot.body.data.tasks.find((item) => item.entityId === orderNo)
  assert.ok(task, `工单 ${orderNo} 应出现在维修待办里`)
  assert.equal(task.category, 'service')
  assert.equal(task.entityType, 'service_order')
  assert.equal(task.primaryAction.code, 'B21')
  assert.match(task.title, /^维修 · /)
  assert.equal(task.amountSummary.countsTowardReceivable, false, '还没出方案不能计确定应收')
  assert.match(task.amountSummary.note ?? '', /未确认/)
})

test('R02：回收单进「回收待办」；未确认收购不计应收', async () => {
  const created = await register(a, 'r02-recovery', {
    sellerName: '陈师傅',
    sellerPhone: '13800001111',
    items: [{ description: '联想 ThinkPad T14 整机', condition: 'used', snRaw: 'SN-R02-1' }],
    initialEstimateCents: 150_000,
    note: '到店回收',
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const orderNo = await scalar('SELECT order_no FROM recovery_orders WHERE id = ?', created.body.data.entityId)

  const snapshot = await workbench(a, '?category=recovery')
  const task = snapshot.body.data.tasks.find((item) => item.entityId === orderNo)
  assert.ok(task, `回收单 ${orderNo} 应出现在回收待办里`)
  assert.equal(task.category, 'recovery')
  assert.equal(task.entityType, 'recovery_order')
  assert.equal(task.primaryAction.code, 'B27')
  assert.equal(task.amountSummary.countsTowardReceivable, false)
  assert.equal(task.amountSummary.estimateCents, 150_000, '未确认的初估只能进 estimateCents')
  assert.equal(task.amountSummary.balanceCents, null, '不得用初估冒充确定应收')
})

// ─────────────────────────── 口径：同快照、汇总、隔离 ───────────────────────────

test('R02：metrics 与 tasks 出自同一次快照，receivable 只算 countsTowardReceivable', async () => {
  const snapshot = await workbench(a)
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body))
  const { tasks, metrics, generatedAt, filters } = snapshot.body.data

  assert.equal(filters.scope, 'open')
  assert.equal(filters.q, null)
  assert.equal(filters.category, null)
  assert.ok(!Number.isNaN(Date.parse(generatedAt)), 'generatedAt 必须是可解析的时间戳')

  const countOf = (category) => tasks.filter((task) => task.category === category).length
  assert.equal(metrics.taskTotal.value, tasks.length)
  assert.equal(metrics.pendingDelivery.value, countOf('delivery'))
  assert.equal(metrics.stockShortage.value, countOf('stock_shortage'))
  assert.equal(metrics.servicePending.value, countOf('service'))
  assert.equal(metrics.taskTotal.filterTarget, '/dashboard?scope=open')

  // 应收 = countsTowardReceivable=true 的 balanceCents 之和（V1.expected.receivableFormula）
  const expected = tasks.reduce((sum, task) => {
    if (!task.amountSummary?.countsTowardReceivable) return sum
    return sum + Math.max(task.amountSummary.balanceCents ?? 0, 0)
  }, 0)
  assert.equal(metrics.receivable.valueCents, expected)
  assert.ok(metrics.receivable.valueCents > 0, '甲店有未结清的成交单，应收应大于 0')
})

test('R02：汇总口径不随筛选变化（分页不得改变汇总口径）', async () => {
  const full = await workbench(a)
  const filtered = await workbench(a, '?category=service&limit=1')
  assert.equal(filtered.body.data.tasks.length, 1)
  assert.deepEqual(filtered.body.data.metrics, full.body.data.metrics, '筛选与 limit 不得改变统计口径')
})

test('R02：跨店隔离 —— 乙店看不到甲店任何待办', async () => {
  const other = await workbench(b)
  assert.equal(other.status, 200, JSON.stringify(other.body))
  const aTasks = (await workbench(a)).body.data.tasks
  const bIds = new Set(other.body.data.tasks.map((task) => task.taskId))
  for (const task of aTasks) {
    assert.equal(bIds.has(task.taskId), false, `乙店不该看到甲店的 ${task.taskId}`)
  }
})

test('R02：q 只搜单号 / 客户 / 设备，命不中就是空', async () => {
  const all = await workbench(a)
  const target = all.body.data.tasks[0]
  assert.ok(target, '甲店应至少有一条待办')

  const hit = await workbench(a, `?q=${encodeURIComponent(target.entityId)}`)
  assert.equal(hit.body.data.tasks.length, 1)
  assert.equal(hit.body.data.tasks[0].taskId, target.taskId)

  const miss = await workbench(a, '?q=绝不存在的关键词zzz')
  assert.equal(miss.body.data.tasks.length, 0)
  // 命不中时统计口径不变，界面才能区分「没有待办」与「筛掉了」
  assert.deepEqual(miss.body.data.metrics, all.body.data.metrics)
})

test('R02：排序 —— 逾期在最前，无交期排在已知交期之后', async () => {
  const overdue = await scalar(
    `SELECT id FROM sale_orders WHERE store_id = 1 AND trade_state = 'confirmed' ORDER BY created_at ASC LIMIT 1`,
  )
  const yesterday = new Date(Date.now() - 26 * 3600 * 1000).toISOString()
  await db.prepare('UPDATE sale_orders SET due_at = ? WHERE id = ?').bind(yesterday, overdue).run()

  const snapshot = await workbench(a)
  const first = snapshot.body.data.tasks[0]
  assert.equal(first.entityId, await scalar('SELECT order_no FROM sale_orders WHERE id = ?', overdue))
  assert.equal(first.deadlineText, '已逾期')

  const last = snapshot.body.data.tasks[snapshot.body.data.tasks.length - 1]
  assert.equal(last.dueAt, null, '没有交期的事项排在最后，文案是「未约定」')
  assert.equal(last.deadlineText, null)
})

// ─────────────────────────── 服务端过滤 ───────────────────────────

test('R02：响应里没有成本 / 供应商 / 毛利 —— 服务端就没取这些字段', async () => {
  const snapshot = await workbench(a)
  const raw = JSON.stringify(snapshot.body)
  for (const forbidden of ['cost', 'Cost', 'supplier', 'Supplier', 'margin', 'Margin', '供应商', '毛利']) {
    assert.equal(raw.includes(forbidden), false, `响应里不得出现 ${forbidden}`)
  }
})

test('R02：真实 HTTP 待办响应不包含演示图片 URL 或静态图库地址', async () => {
  const snapshot = await workbench(a)
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body))
  assert.ok(snapshot.body.data.tasks.length > 0, '用真实读模型产生的待办检查图片字段')
  for (const task of snapshot.body.data.tasks) {
    const photoUrl = task.photoUrl ?? ''
    const isDemoImage = photoUrl.startsWith('demo://')
      || /(?:^|\/)assets\/workbench\/(?:gpu|laptop|monitor|tower)\.jpg(?:[?#]|$)/i.test(photoUrl)
    assert.equal(
      isDemoImage,
      false,
      `${task.taskId} 不得把演示图片地址或静态图库资源作为附件返回`,
    )
  }
})

test('R02：任务形状与契约 TaskReadModel 一致（16 个字段一个不少）', async () => {
  const snapshot = await workbench(a)
  const task = snapshot.body.data.tasks[0]
  const expected = [
    'taskId', 'entityType', 'entityId', 'entityVersion', 'category', 'title',
    'customerDisplay', 'deviceSummary', 'photoKind', 'photoUrl', 'dueAt', 'deadlineText',
    'blockerSummary', 'amountSummary', 'primaryAction', 'detailTarget',
  ]
  for (const field of expected) {
    assert.ok(field in task, `缺字段 ${field}`)
  }
  assert.equal(Object.keys(task).length, expected.length, '不得多出契约外的字段')
  // objects.json TaskReadModel.rules 第 1 条：主键为 entityType + entityId
  assert.equal(task.taskId, `${task.entityType}:${task.entityId}`)

  // primaryAction 的 blocker 码必须是 errors.json 里的码
  const known = new Set([
    'VALIDATION_ERROR', 'AUTH_REQUIRED', 'SESSION_REVOKED', 'PERMISSION_DENIED', 'ENTITY_NOT_FOUND',
    'VERSION_CONFLICT', 'STOCK_CONFLICT', 'PURCHASE_PAYMENT_CONFLICT', 'IDEMPOTENCY_MISMATCH',
    'CHECKLIST_INCOMPLETE', 'SERIAL_MISMATCH', 'BALANCE_EXCEEDED', 'PURCHASE_CANCEL_EXCEEDED',
    'OFFSET_EXCEEDED', 'OWNERSHIP_INVALID', 'INSPECTION_REQUIRED', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE',
  ])
  for (const item of snapshot.body.data.tasks) {
    for (const blocker of item.primaryAction.blockers) {
      assert.ok(known.has(blocker.code), `blocker.code ${blocker.code} 不在 errors.json 里`)
    }
    if (!item.primaryAction.enabled) {
      assert.ok(item.primaryAction.blockers.length > 0, '禁用的主动作必须给出至少一条可读原因')
    }
  }
})
