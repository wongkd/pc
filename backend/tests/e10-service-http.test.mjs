/**
 * E10 · 售后维修与收款闭环的 HTTP 接线（/api/v2/service/orders*）。
 *
 * 契约依据：
 *   actions.json B20（POST /service/orders，service/edit）—— 接修登记
 *                B21（POST /service/orders/:id/diagnosis + /proposal，service/edit）—— 诊断与方案
 *                B22（POST /service/orders/:id/confirm-proposal，service/edit）—— 方案确认
 *                B23（POST /service/orders/:id/replace，service/edit）—— 换件领用自有备件
 *                B24（POST /service/orders/:id/dispatch + /receive-external，service/edit）—— 外送/返回
 *                B25（POST /service/orders/:id/retest + /return，service/edit）—— 复测/归还
 *                B41（POST /service/orders/:id/payments，service/charge）—— 售后收款
 *   readActions R09（GET /service/orders、/service/orders/:id，service/view）
 *   objects.json ServiceOrder / CustomerDevice / DeviceConfiguration / DeviceChange
 *   enums.json  ServiceState / ConfirmationMethod / WarrantyDecision / LocationKind
 *
 * 覆盖：
 *   1. 鉴权：无 service 权限店员 403；旧码 quote/edit（→service/edit、service/charge）+ quote/view 可接修、可收款；
 *   2. B20→B21→B22→B23→B41→B25 完整闭环：换件扣自有备件（available→sold，service_part_consumption），
 *      收款归零、复测通过、归还后 custody 转 customer；
 *   3. 幂等：同 requestId 重复接修复用原工单；
 *   4. B25 归还闸门：费用未结清不能复测通过（BALANCE_EXCEEDED），结清后才归还；
 *   5. B41：方案未确认不能收款；超收 422；结清后再收 422；
 *   6. B23：领用不在可用库存的备件 → STOCK_CONFLICT；
 *   7. B24：外送（custody→external）与返回（custody→store）；
 *   8. B22 拒绝维修：accepted=false → ready_return、余额 0，可直接归还；
 *   9. 跨店 404；
 *  10. R12 账本：维修待收并入 receivable（serviceCount / serviceTotalCents）。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'
import { seedProduct } from './lib/inventory.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER = { email: 'e10-owner@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: '装机门店' }
const OWNER_B = { email: 'e10-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: '别家门店' }

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

async function seedAttachment({ id, ownerId, ownerType = 'service_order', state = 'attached', storeId = 1 }) {
  const complete = state === 'attached'
  await db.prepare(`INSERT INTO attachments
    (id, store_id, upload_state, purpose, visibility, object_key, declared_mime, declared_byte_size,
     content_type, byte_size, sha256, owner_entity_type, owner_entity_id, upload_token_hash,
     expires_at, request_id, created_by)
    VALUES (?, ?, ?, 'service_intake', 'internal', ?, 'image/png', 12, ?, ?, ?, ?, ?, ?,
      '2099-01-01T00:00:00.000Z', ?, ?)`)
    .bind(
      id, storeId, state, `attachments/${id}`,
      complete ? 'image/png' : null, complete ? 12 : null, complete ? 'a'.repeat(64) : null,
      ownerType, ownerId, `token-hash-${id}`, `request-${id}`, storeId,
    ).run()
}

/** 播一个 item 级商品 + 一件 available 的自有备件，供 B23 换件领用。 */
async function seedStockItem({ id, productId, assetCode }) {
  await db.prepare(
    `INSERT INTO stock_items
       (id, store_id, product_id, asset_code, condition, ownership, availability, location,
        sn_raw, sn_normalized, acquisition_cost_cents, cost_known, version)
     VALUES (?, 1, ?, ?, 'new', 'store', 'available', 'store', ?, ?, 50000, 1, 1)`,
  ).bind(id, productId, assetCode, `SN-${assetCode}`, `SN-${assetCode}`).run()
  await db.prepare(
    `INSERT INTO inventory_movements
       (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
        source, occurred_at, actor_user_id, request_id)
     VALUES (?, 1, ?, ?, 1, NULL, 'available', 50000, 'opening_balance', ?, 1, ?)`,
  ).bind(`${id}::seed`, productId, id, new Date().toISOString(), `${id}::seed-req`).run()
  return id
}

// ─────────────────────────── 请求助手 ───────────────────────────

const intake = async (client, requestId, body) =>
  json(await client.post('/api/v2/service/orders', { requestId, ...body }))

const diagnose = async (client, orderId, requestId, body) =>
  json(await client.post(`/api/v2/service/orders/${encodeURIComponent(orderId)}/diagnosis`, { requestId, ...body }))

const propose = async (client, orderId, requestId, body) =>
  json(await client.post(`/api/v2/service/orders/${encodeURIComponent(orderId)}/proposal`, { requestId, ...body }))

const confirm = async (client, orderId, requestId, body) =>
  json(await client.post(`/api/v2/service/orders/${encodeURIComponent(orderId)}/confirm-proposal`, { requestId, ...body }))

const replace = async (client, orderId, requestId, body) =>
  json(await client.post(`/api/v2/service/orders/${encodeURIComponent(orderId)}/replace`, { requestId, ...body }))

const dispatch = async (client, orderId, requestId, body) =>
  json(await client.post(`/api/v2/service/orders/${encodeURIComponent(orderId)}/dispatch`, { requestId, ...body }))

const receiveExternal = async (client, orderId, requestId, body) =>
  json(await client.post(`/api/v2/service/orders/${encodeURIComponent(orderId)}/receive-external`, { requestId, ...body }))

const retest = async (client, orderId, requestId, body) =>
  json(await client.post(`/api/v2/service/orders/${encodeURIComponent(orderId)}/retest`, { requestId, ...body }))

const returnDevice = async (client, orderId, requestId, body) =>
  json(await client.post(`/api/v2/service/orders/${encodeURIComponent(orderId)}/return`, { requestId, ...body }))

const pay = async (client, orderId, requestId, body) =>
  json(await client.post(`/api/v2/service/orders/${encodeURIComponent(orderId)}/payments`, { requestId, ...body }))

const listOrders = async (client, query = '') =>
  json(await client.get(`/api/v2/service/orders${query}`))

const orderDetail = async (client, orderId) =>
  json(await client.get(`/api/v2/service/orders/${encodeURIComponent(orderId)}`))

const orderState = (orderId) => scalar('SELECT state FROM service_orders WHERE id = ?', orderId)

/** 把一张工单走到「方案已确认、进入维修」，返回 orderId。 */
async function intakeToRepairing(tag) {
  const created = await intake(a, `${tag}-intake`, {
    customerName: '陈先生', deviceCode: `DEV-${tag}`, symptom: '开机蓝屏',
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const orderId = created.body.data.entityId
  await diagnose(a, orderId, `${tag}-diag`, { diagnosisNote: '内存条接触不良' })
  await propose(a, orderId, `${tag}-proposal`, {
    items: [{ name: '更换内存条', qty: 1, unitPriceCents: 30_000, chargeType: 'charge' }],
    chargeCents: 30_000,
    warrantyDecision: 'out_of_warranty',
  })
  const confirmed = await confirm(a, orderId, `${tag}-confirm`, {
    proposalVersion: 1, confirmationMethod: 'phone', confirmedAt: '2026-09-21T10:00:00Z', accepted: true,
  })
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
  return orderId
}

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER)
  await seedOwner(db, OWNER_B)
  a = createClient(env.call, await login(env.call, OWNER))
  b = createClient(env.call, await login(env.call, OWNER_B))
  clerk = createClient(env.call, await login(env.call, await seedClerk({ userId: 20, email: 'e10-noperm@local.test' })))
  legacyClerk = createClient(env.call, await login(env.call, await seedClerk({
    userId: 21,
    email: 'e10-legacy@local.test',
    permissions: ['quote/edit', 'quote/view'],
  })))
})

after(async () => {
  await env?.dispose()
})

// ─────────────────────────── 鉴权 ───────────────────────────

test('鉴权：无 service 权限店员 403；旧码 quote/edit + quote/view 可接修、可收款', async () => {
  const deniedList = await listOrders(clerk)
  assert.equal(deniedList.status, 403)
  assert.equal(deniedList.body.error.code, 'PERMISSION_DENIED')

  const deniedIntake = await intake(clerk, 'e10-auth-deny', {
    customerName: '散客', deviceCode: 'DEV-X', symptom: '开不了机',
  })
  assert.equal(deniedIntake.status, 403)

  // 旧码 quote/view 等价 service/view：能读列表。
  const list = await listOrders(legacyClerk)
  assert.equal(list.status, 200, JSON.stringify(list.body))

  // 旧码 quote/edit 等价 service/edit：能接修。
  const created = await intake(legacyClerk, 'e10-auth-legacy', {
    customerName: '李小姐', deviceCode: 'DEV-L', symptom: '风扇异响',
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))

  // 旧码 quote/edit 等价 service/charge：方案确认后能收款（走到收款需先完成前置）。
  const orderId = created.body.data.entityId
  await diagnose(legacyClerk, orderId, 'e10-auth-legacy-diag', { diagnosisNote: '清灰' })
  await propose(legacyClerk, orderId, 'e10-auth-legacy-proposal', {
    items: [{ name: '清灰', qty: 1, unitPriceCents: 5_000, chargeType: 'charge' }],
    chargeCents: 5_000,
    warrantyDecision: 'out_of_warranty',
  })
  await confirm(legacyClerk, orderId, 'e10-auth-legacy-confirm', {
    proposalVersion: 1, confirmationMethod: 'wechat', confirmedAt: '2026-09-21T10:00:00Z', accepted: true,
  })
  const paid = await pay(legacyClerk, orderId, 'e10-auth-legacy-pay', {
    amountCents: 5_000, method: 'cash', occurredAt: '2026-09-21T10:30:00Z',
  })
  assert.equal(paid.status, 200, JSON.stringify(paid.body))
})

// ─────────────────────────── 完整闭环 ───────────────────────────

test('B20→B21→B22→B23→B41→B25：换件扣备件、收款归零、归还转 custody', async () => {
  const product = await seedProduct(db, { entityId: 'e10-loop-part', name: '内存条', trackingMode: 'item' })
  const itemId = await seedStockItem({ id: 'si-e10-loop', productId: product.hardwareId, assetCode: 'AC-E10-LOOP' })

  const created = await intake(a, 'e10-loop-intake', {
    customerName: '陈先生', deviceCode: 'DEV-LOOP', symptom: '开机蓝屏',
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const orderId = created.body.data.entityId
  const deviceId = created.body.data.effects.deviceId
  assert.ok(orderId, '接修返回工单 id')
  assert.ok(deviceId, '接修返回设备 id')
  assert.equal(await orderState(orderId), 'received')
  // 客户财产不进自有库存
  assert.equal(await scalar('SELECT custody_location FROM customer_device_custody WHERE id = ?', deviceId), 'store')

  const diag = await diagnose(a, orderId, 'e10-loop-diag', { diagnosisNote: '内存条接触不良' })
  assert.equal(diag.status, 200, JSON.stringify(diag.body))
  assert.equal(await orderState(orderId), 'diagnosing')

  const prop = await propose(a, orderId, 'e10-loop-proposal', {
    items: [{ name: '更换内存条', qty: 1, unitPriceCents: 30_000, chargeType: 'charge' }],
    chargeCents: 30_000,
    warrantyDecision: 'out_of_warranty',
  })
  assert.equal(prop.status, 200, JSON.stringify(prop.body))
  assert.equal(await orderState(orderId), 'awaiting_approval')
  assert.equal(await scalar('SELECT proposal_version FROM service_orders WHERE id = ?', orderId), 1)

  const confirmed = await confirm(a, orderId, 'e10-loop-confirm', {
    proposalVersion: 1, confirmationMethod: 'phone', confirmedAt: '2026-09-21T10:00:00Z', accepted: true,
  })
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
  assert.equal(await orderState(orderId), 'repairing')
  assert.equal(await scalar('SELECT confirmed_charge_cents FROM service_orders WHERE id = ?', orderId), 30_000)
  assert.equal(await scalar('SELECT balance_cents FROM service_orders WHERE id = ?', orderId), 30_000)

  // 换件：领用自有备件 available → sold
  const replaced = await replace(a, orderId, 'e10-loop-replace', {
    approvedProposalVersion: 1,
    components: [
      { oldComponentRef: '旧内存条', oldItemDisposition: 'quarantine', newStockItem: itemId, qty: 1, chargeType: 'charge' },
    ],
  })
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body))
  assert.equal(await orderState(orderId), 'retesting')
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId), 'sold')
  assert.equal(
    await scalar(`SELECT from_bucket FROM inventory_movements WHERE stock_item_id = ? AND source = 'service_part_consumption'`, itemId),
    'available',
  )
  assert.equal(
    await scalar(`SELECT to_bucket FROM inventory_movements WHERE stock_item_id = ? AND source = 'service_part_consumption'`, itemId),
    'sold',
  )
  // 换件事件 + 配置版本落库
  assert.equal(await scalar('SELECT COUNT(*) FROM device_changes WHERE service_order_id = ?', orderId), 1)
  assert.equal(await scalar('SELECT COUNT(*) FROM device_configurations WHERE device_id = ?', deviceId), 1)

  // 收款前不能复测通过（归还闸门）
  const earlyRetest = await retest(a, orderId, 'e10-loop-retest-early', { passed: true })
  assert.equal(earlyRetest.status, 409)
  assert.equal(earlyRetest.body.error.code, 'BALANCE_EXCEEDED')

  // 收款归零
  const paid = await pay(a, orderId, 'e10-loop-pay', {
    amountCents: 30_000, method: 'wechat', occurredAt: '2026-09-21T11:00:00Z', remark: '维修费结清',
  })
  assert.equal(paid.status, 200, JSON.stringify(paid.body))
  assert.equal(paid.body.data.effects.balanceCents, 0)
  assert.equal(await scalar('SELECT cash_net_cents FROM service_orders WHERE id = ?', orderId), 30_000)
  assert.equal(await scalar('SELECT balance_cents FROM service_orders WHERE id = ?', orderId), 0)
  assert.equal(
    await scalar(`SELECT amount_cents FROM cash_entries WHERE purpose = 'service_order' AND allocation_id = ?`, orderId),
    30_000,
  )

  // 复测通过 → 待归还
  const retested = await retest(a, orderId, 'e10-loop-retest', { passed: true })
  assert.equal(retested.status, 200, JSON.stringify(retested.body))
  assert.equal(await orderState(orderId), 'ready_return')

  // 归还 → returned，custody 转 customer
  const returned = await returnDevice(a, orderId, 'e10-loop-return', { returnedTo: '陈先生本人' })
  assert.equal(returned.status, 200, JSON.stringify(returned.body))
  assert.equal(await orderState(orderId), 'returned')
  assert.equal(await scalar('SELECT custody_location FROM customer_device_custody WHERE id = ?', deviceId), 'customer')
})

// ─────────────────────────── 幂等 ───────────────────────────

test('幂等：同 requestId 重复接修复用原工单，不新建设备', async () => {
  const first = await intake(a, 'e10-idem', { customerName: '王先生', deviceCode: 'DEV-IDEM', symptom: '花屏' })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const orderId = first.body.data.entityId

  const again = await intake(a, 'e10-idem', { customerName: '王先生', deviceCode: 'DEV-IDEM', symptom: '花屏' })
  assert.equal(again.status, 200)
  assert.equal(again.body.data.entityId, orderId, '复用同一个工单 id')

  assert.equal(await scalar('SELECT COUNT(*) FROM service_orders WHERE id = ?', orderId), 1)
  const deviceId = 'e10-idem::device'
  assert.equal(await scalar('SELECT COUNT(*) FROM customer_device_custody WHERE id = ?', deviceId), 1)
  assert.equal(await scalar('SELECT manufacturer_sn FROM customer_device_custody WHERE id = ?', deviceId), 'DEV-IDEM')
})

// ─────────────────────────── 归还闸门（未结清） ───────────────────────────

test('B25 归还闸门：费用未结清不能复测通过，结清后才归还', async () => {
  const orderId = await intakeToRepairing('e10-gate')
  // 不换件直接复测会因状态不对被拒（repairing 不能复测）
  const wrongState = await retest(a, orderId, 'e10-gate-retest-bad', { passed: true })
  assert.equal(wrongState.status, 400)

  // 走到 retesting（换件，但不收款），复测通过被闸门拦下
  const product = await seedProduct(db, { entityId: 'e10-gate-part', name: '风扇', trackingMode: 'item' })
  const itemId = await seedStockItem({ id: 'si-e10-gate', productId: product.hardwareId, assetCode: 'AC-E10-GATE' })
  const replaced = await replace(a, orderId, 'e10-gate-replace', {
    approvedProposalVersion: 1,
    components: [{ oldComponentRef: '旧风扇', oldItemDisposition: 'scrapped', newStockItem: itemId, qty: 1, chargeType: 'charge' }],
  })
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body))
  assert.equal(await orderState(orderId), 'retesting')

  const blocked = await retest(a, orderId, 'e10-gate-retest', { passed: true })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.error.code, 'BALANCE_EXCEEDED')
  assert.match(blocked.body.error.message, /还没结清|结清/)

  // 结清后复测通过 → 归还成功
  await pay(a, orderId, 'e10-gate-pay', { amountCents: 30_000, method: 'cash', occurredAt: '2026-09-21T11:00:00Z' })
  const retested = await retest(a, orderId, 'e10-gate-retest-2', { passed: true })
  assert.equal(retested.status, 200, JSON.stringify(retested.body))
  const returned = await returnDevice(a, orderId, 'e10-gate-return', { returnedTo: '本人' })
  assert.equal(returned.status, 200, JSON.stringify(returned.body))
})

// ─────────────────────────── 收款边界 ───────────────────────────

test('B41：方案未确认不能收款；超收 422；结清后再收 422', async () => {
  const created = await intake(a, 'e10-pay-edge', { customerName: '赵先生', deviceCode: 'DEV-PAY', symptom: '卡顿' })
  const orderId = created.body.data.entityId

  // 方案未确认（confirmed_charge_cents 为 NULL）不能收款
  const premature = await pay(a, orderId, 'e10-pay-edge-early', {
    amountCents: 1_000, method: 'cash', occurredAt: '2026-09-21T09:00:00Z',
  })
  assert.equal(premature.status, 400)
  assert.match(premature.body.error.message, /方案还没确认|没有应收/)

  await diagnose(a, orderId, 'e10-pay-edge-diag', { diagnosisNote: '重装系统' })
  await propose(a, orderId, 'e10-pay-edge-proposal', {
    items: [{ name: '重装系统', qty: 1, unitPriceCents: 10_000, chargeType: 'charge' }],
    chargeCents: 10_000,
    warrantyDecision: 'out_of_warranty',
  })
  await confirm(a, orderId, 'e10-pay-edge-confirm', {
    proposalVersion: 1, confirmationMethod: 'phone', confirmedAt: '2026-09-21T10:00:00Z', accepted: true,
  })

  // 超收：可收上限 10000，收 10001 → 422
  const over = await pay(a, orderId, 'e10-pay-edge-over', {
    amountCents: 10_001, method: 'cash', occurredAt: '2026-09-21T10:10:00Z',
  })
  assert.equal(over.status, 422)
  assert.equal(over.body.error.code, 'BALANCE_EXCEEDED')

  // 结清
  const paid = await pay(a, orderId, 'e10-pay-edge-pay', {
    amountCents: 10_000, method: 'cash', occurredAt: '2026-09-21T10:20:00Z',
  })
  assert.equal(paid.status, 200, JSON.stringify(paid.body))
  assert.equal(await scalar('SELECT balance_cents FROM service_orders WHERE id = ?', orderId), 0)

  // 结清后再收 → 可收上限 max(0,0)=0，1 > 0 → 422
  const over2 = await pay(a, orderId, 'e10-pay-edge-over2', {
    amountCents: 1, method: 'cash', occurredAt: '2026-09-21T10:30:00Z',
  })
  assert.equal(over2.status, 422)
  assert.equal(over2.body.error.code, 'BALANCE_EXCEEDED')
})

// ─────────────────────────── 换件备件边界 ───────────────────────────

test('B23：领用不在可用库存的备件 → STOCK_CONFLICT', async () => {
  const orderId = await intakeToRepairing('e10-stock')
  const replaced = await replace(a, orderId, 'e10-stock-replace', {
    approvedProposalVersion: 1,
    components: [{ oldComponentRef: '旧主板', oldItemDisposition: 'scrapped', newStockItem: 'si-不存在', qty: 1, chargeType: 'charge' }],
  })
  assert.equal(replaced.status, 409)
  assert.equal(replaced.body.error.code, 'STOCK_CONFLICT')
  // 没换成功，工单还停在 repairing
  assert.equal(await orderState(orderId), 'repairing')
})

// ─────────────────────────── 外送链路 ───────────────────────────

test('B24：外送 custody→external，返回 custody→store', async () => {
  const created = await intake(a, 'e10-dispatch', { customerName: '孙先生', deviceCode: 'DEV-DISPATCH', symptom: '进水' })
  const orderId = created.body.data.entityId
  const deviceId = created.body.data.effects.deviceId

  await diagnose(a, orderId, 'e10-dispatch-diag', { diagnosisNote: '主板腐蚀' })
  // 诊断中（尚未出方案）不能外送
  const earlyDispatch = await dispatch(a, orderId, 'e10-dispatch-early', { receiver: '返厂' })
  assert.equal(earlyDispatch.status, 400)

  await propose(a, orderId, 'e10-dispatch-proposal', {
    items: [{ name: '送修主板', qty: 1, unitPriceCents: 20_000, chargeType: 'charge' }],
    chargeCents: 20_000,
    warrantyDecision: 'undetermined',
  })
  // 外送：awaiting_approval 即可外送，无需先确认收费
  const dispatched = await dispatch(a, orderId, 'e10-dispatch-go', { receiver: '厂家售后中心' })
  assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body))
  assert.equal(await orderState(orderId), 'outsourced')
  assert.equal(await scalar('SELECT custody_location FROM customer_device_custody WHERE id = ?', deviceId), 'external')

  // 返回
  const received = await receiveExternal(a, orderId, 'e10-dispatch-recv', { note: '主板已修好' })
  assert.equal(received.status, 200, JSON.stringify(received.body))
  assert.equal(await orderState(orderId), 'retesting')
  assert.equal(await scalar('SELECT custody_location FROM customer_device_custody WHERE id = ?', deviceId), 'store')
})

// ─────────────────────────── 拒绝维修 ───────────────────────────

test('B22 拒绝维修：accepted=false → ready_return、余额 0，可直接归还', async () => {
  const created = await intake(a, 'e10-reject', { customerName: '周先生', deviceCode: 'DEV-REJECT', symptom: '老机器' })
  const orderId = created.body.data.entityId
  await diagnose(a, orderId, 'e10-reject-diag', { diagnosisNote: '主板坏，换新不划算' })
  await propose(a, orderId, 'e10-reject-proposal', {
    items: [{ name: '换主板', qty: 1, unitPriceCents: 80_000, chargeType: 'charge' }],
    chargeCents: 80_000,
    warrantyDecision: 'out_of_warranty',
  })
  const rejected = await confirm(a, orderId, 'e10-reject-confirm', {
    proposalVersion: 1, confirmationMethod: 'phone', confirmedAt: '2026-09-21T10:00:00Z', accepted: false,
  })
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body))
  assert.equal(await orderState(orderId), 'ready_return')
  assert.equal(await scalar('SELECT confirmed_charge_cents FROM service_orders WHERE id = ?', orderId), 0)
  assert.equal(await scalar('SELECT balance_cents FROM service_orders WHERE id = ?', orderId), 0)

  const returned = await returnDevice(a, orderId, 'e10-reject-return', { returnedTo: '本人' })
  assert.equal(returned.status, 200, JSON.stringify(returned.body))
  assert.equal(await orderState(orderId), 'returned')
})

// ─────────────────────────── 跨店与读模型 ───────────────────────────

test('跨店 404：别家门店读不到、也动不了这张工单', async () => {
  const created = await intake(a, 'e10-cross', { customerName: '吴先生', deviceCode: 'DEV-CROSS', symptom: '异响' })
  const orderId = created.body.data.entityId

  const detail = await orderDetail(b, orderId)
  assert.equal(detail.status, 404)

  const diag = await diagnose(b, orderId, 'e10-cross-diag', { diagnosisNote: 'x' })
  assert.equal(diag.status, 404)
})

test('R09：工单列表与详情（含状态过滤与 allowedActions）', async () => {
  const created = await intake(a, 'e10-r09', { customerName: '郑先生', deviceCode: 'DEV-R09', symptom: '黑屏' })
  const orderId = created.body.data.entityId
  await seedAttachment({ id: 'e10-r09-attached', ownerId: orderId })
  await seedAttachment({ id: 'e10-r09-pending', ownerId: orderId, state: 'pending' })
  await seedAttachment({ id: 'e10-r09-other-order', ownerId: 'another-service-order' })
  await seedAttachment({ id: 'e10-r09-other-store', ownerId: orderId, storeId: 2 })

  const list = await listOrders(a)
  assert.equal(list.status, 200, JSON.stringify(list.body))
  assert.ok(Array.isArray(list.body.data.orders))
  assert.ok(list.body.data.orders.some((o) => o.id === orderId), '列表含刚接修的工单')

  const filtered = await listOrders(a, '?state=received')
  assert.equal(filtered.status, 200)
  for (const o of filtered.body.data.orders) {
    assert.equal(o.state, 'received')
  }

  const detail = await orderDetail(a, orderId)
  assert.equal(detail.status, 200, JSON.stringify(detail.body))
  assert.equal(detail.body.data.order.state, 'received')
  assert.deepEqual(detail.body.data.order.allowedActions, ['diagnosis'])
  assert.deepEqual(detail.body.data.order.attachments.map((item) => item.id), ['e10-r09-attached'])
  assert.equal(detail.body.data.order.attachments[0].uploadState, 'attached')
  assert.equal(detail.body.data.order.attachments[0].contentType, 'image/png')
  assert.equal('objectKey' in detail.body.data.order.attachments[0], false)
})

// ─────────────────────────── 账本并入维修待收 ───────────────────────────

test('R12：维修待收并入账本 receivable（serviceCount / serviceTotalCents）', async () => {
  const orderId = await intakeToRepairing('e10-ledger')

  const overview = await json(await a.get('/api/v2/finance/overview'))
  assert.equal(overview.status, 200, JSON.stringify(overview.body))
  assert.ok(overview.body.data.receivable.serviceCount >= 1, '维修待收至少 1 张')
  assert.ok(overview.body.data.receivable.serviceTotalCents >= 30_000, '维修待收至少含这张单的 30000')

  // 结清后维修待收减回
  await pay(a, orderId, 'e10-ledger-pay', { amountCents: 30_000, method: 'cash', occurredAt: '2026-09-21T11:00:00Z' })
  const after = await json(await a.get('/api/v2/finance/overview'))
  assert.equal(after.status, 200)
  const remaining = await scalar(
    'SELECT COUNT(*) FROM service_orders WHERE store_id = 1 AND confirmed_charge_cents IS NOT NULL AND balance_cents > 0',
  )
  assert.equal(after.body.data.receivable.serviceCount, remaining, '结清后维修待收与库内一致')
})
