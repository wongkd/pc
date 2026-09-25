/**
 * E11 · 回收拆件收尾：回收单闭环的 HTTP 接线（/api/v2/recovery/orders* + /api/v2/finance/payments）。
 *
 * 契约依据：
 *   actions.json B26（POST /recovery/orders，recovery/edit）—— 回收登记（客户暂存，不进自有库存）
 *                B27（POST /recovery/orders/:id/inspect、/offer，recovery/edit）—— 验机与估价
 *                B28（POST /recovery/orders/:id/acquire，recovery/acquire）—— 取得所有权（老板专属）
 *                B29（POST /recovery/orders/:id/return，recovery/edit）—— 归还客户
 *                B44（POST /recovery/orders/:id/teardown，recovery/edit）—— 拆件入库
 *                B33（POST /finance/payments，finance/payment）—— 登记对外付款
 *   readActions R10（GET /recovery/orders、/recovery/orders/:id，recovery/view）
 *   objects.json Recovery / RecoveryTeardown
 *   enums.json  RecoveryState / InventoryMovementSource（recovery_acquisition、conversion、scrap）
 *   migrations/0020_recovery.sql 三张表
 *
 * 覆盖：
 *   1. 鉴权：无 recovery 权限店员 403；旧码 quote/edit + quote/view 可登记/验机/估价/归还/拆件；
 *      B28 取得所有权与 B33 付款是老板专属，旧码店员 403；
 *   2. B26→B27(inspect)→B27(offer)→B28 闭环：逐件成本之和必须等于最终价，收购后实物进
 *      store/quarantine、成本落到 acquisition_cost_cents、流水 source='recovery_acquisition'；
 *   3. B28 守卫：不在 offered 状态不能收购；逐件成本之和与最终价不符 400；商品不存在 404；
 *   4. B33 回收付款：付部分后 payable 递减、cash_entries direction='out'；超付 BALANCE_EXCEEDED；
 *      付清后 payable=0；采购付款由 F3 独立回归覆盖；
 *   5. B44 拆件：守恒（产出 + 损耗 = 源成本）不满足 400；满足时源件 retired、产出件 quarantine、
 *      损耗走 scrap 流水、订单转 disassembled；
 *   6. B29 归还：offered 可归还；acquired 之后不得归还（所有权已转移）；
 *   7. 幂等：同 requestId 重复登记复用原单，不产生第二张；
 *   8. 跨店 404；R10 列表按 state 过滤、详情带 items 的 stockItemId 与 acquiredCostCents。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'
import { seedProduct } from './lib/inventory.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER = { email: 'e11-owner@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: '装机门店' }
const OWNER_B = { email: 'e11-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: '别家门店' }

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

async function seedAttachment({ id, ownerId, ownerType = 'recovery_order', state = 'attached', storeId = 1 }) {
  const complete = state === 'attached'
  await db.prepare(`INSERT INTO attachments
    (id, store_id, upload_state, purpose, visibility, object_key, declared_mime, declared_byte_size,
     content_type, byte_size, sha256, owner_entity_type, owner_entity_id, upload_token_hash,
     expires_at, request_id, created_by)
    VALUES (?, ?, ?, 'recovery_evidence', 'internal', ?, 'image/png', 12, ?, ?, ?, ?, ?, ?,
      '2099-01-01T00:00:00.000Z', ?, ?)`)
    .bind(
      id, storeId, state, `attachments/${id}`,
      complete ? 'image/png' : null, complete ? 12 : null, complete ? 'b'.repeat(64) : null,
      ownerType, ownerId, `token-hash-${id}`, `request-${id}`, storeId,
    ).run()
}

// ─────────────────────────── 请求助手 ───────────────────────────

const register = async (client, requestId, body) =>
  json(await client.post('/api/v2/recovery/orders', { requestId, ...body }))

const inspect = async (client, orderId, requestId, body = {}) =>
  json(await client.post(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}/inspect`, { requestId, ...body }))

const offer = async (client, orderId, requestId, body) =>
  json(await client.post(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}/offer`, { requestId, ...body }))

const acquire = async (client, orderId, requestId, body) =>
  json(await client.post(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}/acquire`, { requestId, ...body }))

const returnToSeller = async (client, orderId, requestId, reason) =>
  json(await client.post(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}/return`, { requestId, reason }))

const teardown = async (client, orderId, requestId, body) =>
  json(await client.post(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}/teardown`, { requestId, ...body }))

const pay = async (client, requestId, body) =>
  json(await client.post('/api/v2/finance/payments', { requestId, ...body }))

const listOrders = async (client, query = '') =>
  json(await client.get(`/api/v2/recovery/orders${query}`))

const orderDetail = async (client, orderId) =>
  json(await client.get(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}`))

const orderState = (orderId) => scalar('SELECT state FROM recovery_orders WHERE id = ?', orderId)

/** 走到 offered：登记一件旧机 → 验机 → 估价。返回 { orderId, itemId }。 */
async function toOffered(tag, { estimateCents = 80_000, sellerName = '陈师傅' } = {}) {
  const created = await register(a, `${tag}-reg`, {
    sellerName,
    sellerPhone: '13800001111',
    items: [{ description: '联想 ThinkPad T14 整机', condition: 'used', snRaw: `SN-${tag}` }],
    initialEstimateCents: estimateCents,
    note: `${tag} 到店回收`,
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const orderId = created.body.data.entityId

  const inspected = await inspect(a, orderId, `${tag}-inspect`, { note: '外壳磨损，功能正常' })
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body))
  assert.equal(inspected.body.data.state, 'inspecting')

  const detail = await orderDetail(a, orderId)
  const itemId = detail.body.data.items[0].id
  const offered = await offer(a, orderId, `${tag}-offer`, {
    itemPrices: [{ recoveryItemId: itemId, estimatedCents: estimateCents }],
    note: '报最终价',
  })
  assert.equal(offered.status, 200, JSON.stringify(offered.body))
  assert.equal(await orderState(orderId), 'offered')
  return { orderId, itemId }
}

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER)
  await seedOwner(db, OWNER_B)
  a = createClient(env.call, await login(env.call, OWNER))
  b = createClient(env.call, await login(env.call, OWNER_B))
  clerk = createClient(env.call, await login(env.call, await seedClerk({ userId: 20, email: 'e11-noperm@local.test' })))
  legacyClerk = createClient(env.call, await login(env.call, await seedClerk({
    userId: 21,
    email: 'e11-legacy@local.test',
    permissions: ['quote/edit', 'quote/view'],
  })))

  await seedProduct(db, { entityId: 'p-used-host', name: '二手整机（回收）', trackingMode: 'item' })
  await seedProduct(db, { entityId: 'p-ram', name: '拆机内存条', trackingMode: 'item' })
  await seedProduct(db, { entityId: 'p-ssd', name: '拆机固态硬盘', trackingMode: 'item' })
})

after(async () => {
  await env?.dispose()
})

// ─────────────────────────── 鉴权 ───────────────────────────

test('鉴权：无权限店员 403；旧码可登记与验机，但收购与付款必须老板', async () => {
  const deniedList = await listOrders(clerk)
  assert.equal(deniedList.status, 403)
  assert.equal(deniedList.body.error.code, 'PERMISSION_DENIED')

  const deniedRegister = await register(clerk, 'e11-auth-deny', {
    sellerName: '散客', items: [{ description: '旧主机' }],
  })
  assert.equal(deniedRegister.status, 403)

  // 旧码 quote/view → recovery/view：能读列表。
  const list = await listOrders(legacyClerk)
  assert.equal(list.status, 200, JSON.stringify(list.body))

  // 旧码 quote/edit → recovery/edit：能登记与验机。
  const created = await register(legacyClerk, 'e11-auth-legacy', {
    sellerName: '李小姐', items: [{ description: '旧笔记本', condition: 'used' }],
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const orderId = created.body.data.entityId
  const inspected = await inspect(legacyClerk, orderId, 'e11-auth-legacy-inspect', {})
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body))

  // recovery/acquire 是 owner_only：旧码店员不能取得所有权。
  const deniedAcquire = await acquire(legacyClerk, orderId, 'e11-auth-legacy-acquire', {
    finalAcquisitionCents: 10_000,
    lines: [{ recoveryItemId: 'dummy', productRef: 'p-used-host', costCents: 10_000 }],
  })
  assert.equal(deniedAcquire.status, 403)
  assert.equal(deniedAcquire.body.error.code, 'PERMISSION_DENIED')

  // finance/payment 是 owner_only：旧码店员不能付款。
  const deniedPay = await pay(legacyClerk, 'e11-auth-legacy-pay', {
    sourceDocument: `recovery:${orderId}`, amountCents: 1_000, method: 'cash',
  })
  assert.equal(deniedPay.status, 403)
})

// ─────────────────────────── B26 → B27 → B28 闭环 ───────────────────────────

test('B26 登记：客户暂存不进自有库存，单号与明细落库', async () => {
  const created = await register(a, 'e11-b26', {
    sellerName: '吴女士',
    items: [
      { description: '旧台式整机', condition: 'used', snRaw: 'SN-B26-A', estimatedCents: 30_000 },
      { description: '旧显示器', condition: 'used' },
    ],
    initialEstimateCents: 40_000,
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const orderId = created.body.data.entityId
  assert.equal(created.body.data.state, 'received_for_inspection')
  assert.match(created.body.data.summary, /回收登记 2 件/)

  assert.equal(await orderState(orderId), 'received_for_inspection')
  const detail = await orderDetail(a, orderId)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.data.items.length, 2)
  assert.equal(detail.body.data.items[0].estimatedCents, 30_000)
  assert.equal(detail.body.data.items[0].stockItemId, null)

  // 暂存阶段没有产生任何自有实物。
  const owned = await scalar('SELECT COUNT(*) FROM stock_items WHERE store_id = 1 AND ownership = ?', 'store')
  assert.equal(owned, 0)

  // 缺字段即拒绝。
  const noItems = await register(a, 'e11-b26-empty', { sellerName: '散客', items: [] })
  assert.equal(noItems.status, 400)
  assert.equal(noItems.body.error.code, 'VALIDATION_ERROR')
})

test('B27 验机与估价：版本递增，逐件价落到明细', async () => {
  const { orderId, itemId } = await toOffered('e11-b27', { estimateCents: 90_000 })

  const detail = await orderDetail(a, orderId)
  assert.equal(detail.body.data.state, 'offered')
  assert.equal(detail.body.data.offerVersion, 1)
  assert.equal(detail.body.data.initialEstimateCents, 90_000)
  assert.equal(detail.body.data.items[0].estimatedCents, 90_000)

  // 报价发出后不能再改价：契约 RecoveryState 没有 offered → inspecting 的回头路
  // （enums.json transitions：offered 只能走 B28 acquired 或 B29 return_pending）。
  // 客户还价场景目前只能走 B29 归还后重开一单，已登记为 OPEN-ITEMS G-27 待栋哥拍板。
  const again = await offer(a, orderId, 'e11-b27-offer2', {
    itemPrices: [{ recoveryItemId: itemId, estimatedCents: 100_000 }],
  })
  assert.equal(again.status, 400)
  assert.equal(again.body.error.code, 'VALIDATION_ERROR')
  const after = await orderDetail(a, orderId)
  assert.equal(after.body.data.offerVersion, 1)
  assert.equal(after.body.data.initialEstimateCents, 90_000)
})

test('B28 取得所有权：逐件成本之和必须等于最终价，收购后实物进待检', async () => {
  const { orderId, itemId } = await toOffered('e11-b28', { estimateCents: 80_000 })

  // 逐件成本与最终价不符 → 400。
  const mismatch = await acquire(a, orderId, 'e11-b28-mismatch', {
    finalAcquisitionCents: 80_000,
    lines: [{ recoveryItemId: itemId, productRef: 'p-used-host', assetCode: 'AST-B28-A', costCents: 70_000 }],
  })
  assert.equal(mismatch.status, 400)
  assert.equal(mismatch.body.error.code, 'VALIDATION_ERROR')
  assert.match(mismatch.body.error.message, /逐件成本之和/)

  // 商品不存在 → 404。
  const noProduct = await acquire(a, orderId, 'e11-b28-noproduct', {
    finalAcquisitionCents: 80_000,
    lines: [{ recoveryItemId: itemId, productRef: 'p-not-exist', costCents: 80_000 }],
  })
  assert.equal(noProduct.status, 404)

  const acquired = await acquire(a, orderId, 'e11-b28-ok', {
    finalAcquisitionCents: 80_000,
    lines: [{ recoveryItemId: itemId, productRef: 'p-used-host', assetCode: 'AST-B28-A', snRaw: 'SN-B28-A', costCents: 80_000 }],
    evidenceRef: '照片+身份证复印件',
  })
  assert.equal(acquired.status, 200, JSON.stringify(acquired.body))
  assert.equal(await orderState(orderId), 'acquired')

  const detail = await orderDetail(a, orderId)
  assert.equal(detail.body.data.finalAcquisitionCents, 80_000)
  assert.equal(detail.body.data.payableCents, 80_000)
  assert.equal(detail.body.data.paidCents, 0)
  const stockItemId = detail.body.data.items[0].stockItemId
  assert.ok(stockItemId)
  assert.equal(detail.body.data.items[0].acquiredCostCents, 80_000)

  // 实物归门店、待检（不自动可卖），成本落到取得成本。
  const item = await db.prepare(
    `SELECT ownership, availability, acquisition_cost_cents, cost_known, acquisition_ref
     FROM stock_items WHERE store_id = 1 AND id = ?`,
  ).bind(stockItemId).first()
  assert.equal(item.ownership, 'store')
  assert.equal(item.availability, 'quarantine')
  assert.equal(item.acquisition_cost_cents, 80_000)
  assert.equal(item.cost_known, 1)
  assert.equal(item.acquisition_ref, orderId)

  const movement = await db.prepare(
    `SELECT source, to_bucket, cost_cents FROM inventory_movements WHERE store_id = 1 AND stock_item_id = ?`,
  ).bind(stockItemId).first()
  assert.equal(movement.source, 'recovery_acquisition')
  assert.equal(movement.to_bucket, 'quarantine')
  assert.equal(movement.cost_cents, 80_000)
})

test('B28 守卫：不在 offered 状态不能取得所有权', async () => {
  const created = await register(a, 'e11-b28-guard-reg', {
    sellerName: '守卫测试', items: [{ description: '旧主机', condition: 'used' }],
  })
  const orderId = created.body.data.entityId
  const detail = await orderDetail(a, orderId)
  const itemId = detail.body.data.items[0].id

  // 还在 received_for_inspection（未估价）→ 拒绝。
  const tooEarly = await acquire(a, orderId, 'e11-b28-guard-early', {
    finalAcquisitionCents: 10_000,
    lines: [{ recoveryItemId: itemId, productRef: 'p-used-host', costCents: 10_000 }],
  })
  assert.equal(tooEarly.status, 400)
  assert.equal(tooEarly.body.error.code, 'VALIDATION_ERROR')
})

// ─────────────────────────── B33 付款 ───────────────────────────

test('B33 回收付款：应付递减、超付拒绝、付清归零', async () => {
  const { orderId, itemId } = await toOffered('e11-b33', { estimateCents: 60_000 })
  const acquired = await acquire(a, orderId, 'e11-b33-acquire', {
    finalAcquisitionCents: 60_000,
    lines: [{ recoveryItemId: itemId, productRef: 'p-used-host', assetCode: 'AST-B33-A', costCents: 60_000 }],
  })
  assert.equal(acquired.status, 200, JSON.stringify(acquired.body))

  // 超付 → BALANCE_EXCEEDED。
  const over = await pay(a, 'e11-b33-over', {
    sourceDocument: `recovery:${orderId}`, amountCents: 60_001, method: 'cash',
  })
  assert.equal(over.body.error.code, 'BALANCE_EXCEEDED', JSON.stringify(over.body))

  // 付一部分。
  const part = await pay(a, 'e11-b33-part', {
    sourceDocument: `recovery:${orderId}`, amountCents: 20_000, method: 'wechat', remark: '先付定金',
  })
  assert.equal(part.status, 200, JSON.stringify(part.body))
  const afterPart = await orderDetail(a, orderId)
  assert.equal(afterPart.body.data.paidCents, 20_000)
  assert.equal(afterPart.body.data.payableCents, 40_000)

  // 付清。
  const rest = await pay(a, 'e11-b33-rest', {
    sourceDocument: { kind: 'recovery', id: orderId }, amountCents: 40_000, method: 'cash',
  })
  assert.equal(rest.status, 200, JSON.stringify(rest.body))
  const done = await orderDetail(a, orderId)
  assert.equal(done.body.data.paidCents, 60_000)
  assert.equal(done.body.data.payableCents, 0)

  // 已付清再付 → 超付。
  const again = await pay(a, 'e11-b33-again', {
    sourceDocument: `recovery:${orderId}`, amountCents: 1, method: 'cash',
  })
  assert.equal(again.body.error.code, 'BALANCE_EXCEEDED')

  // 资金流水方向必须是 out，且挂在回收单上。
  const entries = await db.prepare(
    `SELECT direction, amount_cents, method, purpose, allocation_type, allocation_id
     FROM cash_entries WHERE store_id = 1 AND allocation_id = ? ORDER BY amount_cents`,
  ).bind(orderId).all()
  assert.equal(entries.results.length, 2)
  for (const entry of entries.results) {
    assert.equal(entry.direction, 'out')
    assert.equal(entry.purpose, 'recovery')
    assert.equal(entry.allocation_type, 'recovery')
  }
  assert.equal(entries.results[0].amount_cents, 20_000)
  assert.equal(entries.results[0].method, 'wechat')
  assert.equal(entries.results[1].amount_cents, 40_000)
})

test('B33 幂等：同 requestId 重复付款不重复记账', async () => {
  const { orderId, itemId } = await toOffered('e11-b33-idem', { estimateCents: 50_000 })
  await acquire(a, orderId, 'e11-b33-idem-acquire', {
    finalAcquisitionCents: 50_000,
    lines: [{ recoveryItemId: itemId, productRef: 'p-used-host', assetCode: 'AST-IDEM-A', costCents: 50_000 }],
  })

  const first = await pay(a, 'e11-b33-idem-pay', {
    sourceDocument: `recovery:${orderId}`, amountCents: 10_000, method: 'cash',
  })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const second = await pay(a, 'e11-b33-idem-pay', {
    sourceDocument: `recovery:${orderId}`, amountCents: 10_000, method: 'cash',
  })
  assert.equal(second.status, 200, JSON.stringify(second.body))
  assert.equal(second.body.data.operationId, 'e11-b33-idem-pay')

  const paid = await scalar('SELECT paid_cents FROM recovery_orders WHERE id = ?', orderId)
  assert.equal(paid, 10_000)
  const count = await scalar('SELECT COUNT(*) FROM cash_entries WHERE store_id = 1 AND allocation_id = ?', orderId)
  assert.equal(count, 1)
})

// ─────────────────────────── B44 拆件 ───────────────────────────

test('B44 拆件：守恒校验、源件退役、产出件进待检、损耗单列报废', async () => {
  const { orderId, itemId } = await toOffered('e11-b44', { estimateCents: 120_000 })
  await acquire(a, orderId, 'e11-b44-acquire', {
    finalAcquisitionCents: 120_000,
    lines: [{ recoveryItemId: itemId, productRef: 'p-used-host', assetCode: 'AST-B44-HOST', costCents: 120_000 }],
  })
  const detail = await orderDetail(a, orderId)
  const sourceId = detail.body.data.items[0].stockItemId

  // 守恒不成立（产出 70_000 + 损耗 0 ≠ 120_000）→ 400。
  const broken = await teardown(a, orderId, 'e11-b44-broken', {
    sourceStockItemId: sourceId,
    outputs: [{ productRef: 'p-ram', assetCode: 'AST-B44-RAM', costCents: 70_000 }],
  })
  assert.equal(broken.status, 400)
  assert.equal(broken.body.error.code, 'VALIDATION_ERROR')
  assert.match(broken.body.error.message, /不等于源整机成本/)

  // 守恒成立：内存 40_000 + 固态 50_000 + 损耗 30_000 = 120_000。
  const done = await teardown(a, orderId, 'e11-b44-ok', {
    sourceStockItemId: sourceId,
    outputs: [
      { productRef: 'p-ram', assetCode: 'AST-B44-RAM', snRaw: 'SN-B44-RAM', costCents: 40_000 },
      { productRef: 'p-ssd', assetCode: 'AST-B44-SSD', costCents: 50_000 },
    ],
    scrapLines: [{ description: '主板腐蚀报废', costCents: 30_000 }],
    occurredAt: '2026-09-22T02:00:00Z',
  })
  assert.equal(done.status, 200, JSON.stringify(done.body))
  assert.equal(await orderState(orderId), 'disassembled')

  // 源件退役。
  const source = await db.prepare('SELECT availability FROM stock_items WHERE store_id = 1 AND id = ?').bind(sourceId).first()
  assert.equal(source.availability, 'retired')

  // 产出件：两件、待检、成本分别是 40_000 / 50_000，来源 conversion。
  const outputs = await db.prepare(
    `SELECT si.id, si.asset_code, si.availability, si.acquisition_cost_cents, m.source
     FROM stock_items si
     JOIN inventory_movements m ON m.stock_item_id = si.id AND m.source = 'conversion'
     WHERE si.store_id = 1 AND si.acquisition_ref = ? AND si.id != ?
     ORDER BY si.asset_code`,
  ).bind(orderId, sourceId).all()
  assert.equal(outputs.results.length, 2)
  assert.equal(outputs.results[0].asset_code, 'AST-B44-RAM')
  assert.equal(outputs.results[0].availability, 'quarantine')
  assert.equal(outputs.results[0].acquisition_cost_cents, 40_000)
  assert.equal(outputs.results[1].acquisition_cost_cents, 50_000)

  // 损耗：单列报废流水，不建实物。
  const scrap = await db.prepare(
    `SELECT cost_cents, source, stock_item_id FROM inventory_movements
     WHERE store_id = 1 AND request_id = 'e11-b44-ok' AND source = 'scrap'`,
  ).all()
  assert.equal(scrap.results.length, 1)
  assert.equal(scrap.results[0].cost_cents, 30_000)
  assert.equal(scrap.results[0].stock_item_id, sourceId)

  // 拆件记录落库且守恒。
  const record = await db.prepare(
    `SELECT source_cost_cents, output_cost_cents, scrap_cost_cents FROM recovery_teardowns
     WHERE store_id = 1 AND recovery_order_id = ?`,
  ).bind(orderId).first()
  assert.equal(record.source_cost_cents, 120_000)
  assert.equal(record.output_cost_cents, 90_000)
  assert.equal(record.scrap_cost_cents, 30_000)
})

test('B44 守卫：本单未取得所有权时不能拆件', async () => {
  // 先造一件真正属于门店的待检实物（另一张已收购的单）。
  const owned = await toOffered('e11-b44-guard-own', { estimateCents: 60_000 })
  await acquire(a, owned.orderId, 'e11-b44-guard-own-acq', {
    finalAcquisitionCents: 60_000,
    lines: [{ recoveryItemId: owned.itemId, productRef: 'p-used-host', assetCode: 'AST-GUARD-OWN', costCents: 60_000 }],
  })
  const ownedDetail = await orderDetail(a, owned.orderId)
  const sourceId = ownedDetail.body.data.items[0].stockItemId

  // 另一张只登记、还没收购的单，拿这件实物去拆 → 守卫拒绝（本单未到 acquired）。
  const created = await register(a, 'e11-b44-guard-reg', {
    sellerName: '暂存测试', items: [{ description: '旧主机', condition: 'used' }],
  })
  const orderId = created.body.data.entityId
  const denied = await teardown(a, orderId, 'e11-b44-guard-deny', {
    sourceStockItemId: sourceId,
    outputs: [{ productRef: 'p-ram', assetCode: 'AST-GUARD-OUT', costCents: 60_000 }],
  })
  assert.equal(denied.status, 400)
  assert.equal(denied.body.error.code, 'VALIDATION_ERROR')
})

// ─────────────────────────── B29 归还 ───────────────────────────

test('B29 归还：估价后可选不卖，所有权已转移后不得归还', async () => {
  const first = await toOffered('e11-b29', { estimateCents: 30_000 })
  const returned = await returnToSeller(a, first.orderId, 'e11-b29-return', '客户嫌价低，不卖了')
  assert.equal(returned.status, 200, JSON.stringify(returned.body))
  assert.equal(await orderState(first.orderId), 'returned')

  // 归还后不能再估价（状态机已终止）。
  const lateOffer = await offer(a, first.orderId, 'e11-b29-late', { estimatedCents: 30_000 })
  assert.equal(lateOffer.status, 400)

  // 已收购（所有权归门店）不能归还。
  const second = await toOffered('e11-b29b', { estimateCents: 40_000 })
  await acquire(a, second.orderId, 'e11-b29b-acquire', {
    finalAcquisitionCents: 40_000,
    lines: [{ recoveryItemId: second.itemId, productRef: 'p-used-host', assetCode: 'AST-B29B', costCents: 40_000 }],
  })
  const denied = await returnToSeller(a, second.orderId, 'e11-b29b-return', '客户反悔')
  assert.equal(denied.status, 400)
  assert.equal(denied.body.error.code, 'VALIDATION_ERROR')

  // 原因不能为空。
  const third = await toOffered('e11-b29c', { estimateCents: 20_000 })
  const noReason = await returnToSeller(a, third.orderId, 'e11-b29c-blank', '   ')
  assert.equal(noReason.status, 400)
  assert.equal(noReason.body.error.code, 'VALIDATION_ERROR')
})

// ─────────────────────────── 幂等 / 跨店 / R10 ───────────────────────────

test('幂等与跨店：同 requestId 复用；别家门店 404', async () => {
  const created = await register(a, 'e11-idem', {
    sellerName: '幂等客户', items: [{ description: '旧机', condition: 'used' }],
  })
  assert.equal(created.status, 200)
  const orderId = created.body.data.entityId

  const again = await register(a, 'e11-idem', {
    sellerName: '幂等客户', items: [{ description: '旧机', condition: 'used' }],
  })
  assert.equal(again.status, 200)
  assert.equal(again.body.data.entityId, orderId)

  const total = await scalar("SELECT COUNT(*) FROM recovery_orders WHERE store_id = 1 AND request_id = 'e11-idem'")
  assert.equal(total, 1)

  const crossDetail = await orderDetail(b, orderId)
  assert.equal(crossDetail.status, 404)
  const crossAction = await inspect(b, orderId, 'e11-cross', {})
  assert.equal(crossAction.status, 404)
})

test('R10 读：列表按状态过滤，详情带明细', async () => {
  await toOffered('e11-r10-a', { estimateCents: 10_000 })
  await toOffered('e11-r10-b', { estimateCents: 20_000 })

  const all = await listOrders(a, '?limit=100')
  assert.equal(all.status, 200, JSON.stringify(all.body))
  assert.ok(all.body.data.orders.length >= 2)

  const offered = await listOrders(a, '?state=offered&limit=100')
  assert.equal(offered.status, 200)
  assert.ok(offered.body.data.orders.length >= 1)
  for (const order of offered.body.data.orders) {
    assert.equal(order.state, 'offered')
    assert.equal(typeof order.payableCents, 'number')
    assert.ok(order.seller.name)
  }

  const bad = await listOrders(a, '?limit=abc')
  assert.equal(bad.status, 400)

  const first = offered.body.data.orders[0]
  await seedAttachment({ id: 'e11-r10-attached', ownerId: first.id })
  await seedAttachment({ id: 'e11-r10-pending', ownerId: first.id, state: 'pending' })
  await seedAttachment({ id: 'e11-r10-other-order', ownerId: 'another-recovery-order' })
  await seedAttachment({ id: 'e11-r10-other-store', ownerId: first.id, storeId: 2 })
  const detail = await orderDetail(a, first.id)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.data.id, first.id)
  assert.ok(Array.isArray(detail.body.data.items))
  assert.equal(detail.body.data.items[0].description.length > 0, true)
  assert.deepEqual(detail.body.data.attachments.map((item) => item.id), ['e11-r10-attached'])
  assert.equal(detail.body.data.attachments[0].uploadState, 'attached')
  assert.equal(detail.body.data.attachments[0].contentType, 'image/png')
  assert.equal('objectKey' in detail.body.data.attachments[0], false)
})
