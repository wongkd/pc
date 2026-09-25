/**
 * E05 · 报价单的 HTTP 接线（/api/v2/sales/quotes*）。
 *
 * 走真实 Worker 入口 + 真实 D1，覆盖五层：
 *   1. 入口层：路由正则、鉴权、权限、405/404；
 *   2. 权限层：新权限码 `sales/quote-*`、契约声明的旧码映射（quote/view → sales/quote-view），
 *      以及 D-C 裁定后客户接口改用 `sales/order-*` 同时保留旧码兼容；
 *   3. 数据层：草稿反复保存不涨版本、发出后不可覆盖、客户外键同店约束（0011）；
 *   4. 事务层：同 requestId 复用、改载荷冲突、版本冲突、跨店 404 且不落库；
 *   5. 边界层：报价全程不动库存；响应里没有成本字段；金额一律整数分。
 *
 * 本卡的领域逻辑在 domains/quote.ts 里，这里只测「接口接得对不对、约束拦不拦得住」。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER_A = { email: 'q-owner-a@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: '报价门店甲' }
const OWNER_B = { email: 'q-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: '报价门店乙' }

let env
let db
let a
let b
/** 无任何权限的店员（门店甲） */
let clerk
/** 只有旧码 quote/view 的店员（门店甲）—— 报价与客户都应可用 */
let legacyClerk
/** 只有契约新码 sales/quote-view 的店员（门店甲） */
let quoteViewClerk
/** 只有契约新码 sales/order-view 的店员（门店甲） */
let customerViewClerk

const json = async (response) => ({ status: response.status, body: await response.json() })

/**
 * 播一个店员并授予权限码。
 * 生产 permissions 表没有种子迁移（legacy-mapping Q04），所以这里显式建权限行，不依赖既有数据。
 */
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

async function seedCustomer({ storeId = 1, name = '客户甲', phone = '' } = {}) {
  const result = await db
    .prepare(`INSERT INTO customers (store_id, name, phone, created_by, updated_by) VALUES (?, ?, ?, 1, 1)`)
    .bind(storeId, name, phone)
    .run()
  return result.meta.last_row_id
}

/** 播一件可用的二手实物（自有、在店、可用、成本未知）。 */
async function seedStockItem({ storeId = 1, entityId = 'stock-prod-1', itemId = 'si-1' } = {}) {
  await db
    .prepare(
      `INSERT INTO hardware
         (user_id, store_id, category, name, entity_id, tracking_mode, requires_sn, is_serialized, status, item_type, version)
       VALUES (1, ?, '测试分类', ?, ?, 'item', 1, 1, 'active', 'product', 1)`,
    )
    .bind(storeId, entityId, entityId)
    .run()
  const productId = (await db.prepare('SELECT id FROM hardware WHERE store_id = ? AND entity_id = ?').bind(storeId, entityId).first()).id
  await db
    .prepare(
      `INSERT INTO stock_items
         (id, store_id, product_id, asset_code, condition, ownership, availability, location, cost_known, created_by)
       VALUES (?, ?, ?, ?, 'used', 'store', 'available', 'store', 0, 1)`,
    )
    .bind(itemId, storeId, productId, `AC-${itemId}`)
    .run()
  return itemId
}

const scalar = async (sql, ...params) => {
  const row = await db.prepare(sql).bind(...params).first()
  return row ? Object.values(row)[0] : null
}

/** 建一份草稿并返回 id。 */
async function createDraft(client, body, requestId) {
  const response = await client.post('/api/v2/sales/quotes', { requestId, ...body })
  const payload = await response.json()
  if (!response.ok) throw new Error(`建草稿失败（${response.status}）：${JSON.stringify(payload)}`)
  return payload.data.entityId
}

const line = (overrides = {}) => ({
  source: 'new',
  nameSnapshot: '测试配件',
  specSnapshot: '',
  qty: 1,
  unitPriceCents: 100_000,
  ...overrides,
})

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER_A)
  await seedOwner(db, OWNER_B)
  a = createClient(env.call, await login(env.call, OWNER_A))
  b = createClient(env.call, await login(env.call, OWNER_B))
  clerk = createClient(env.call, await login(env.call, await seedClerk({ userId: 10, email: 'q-noperm@local.test' })))
  legacyClerk = createClient(env.call, await login(env.call, await seedClerk({ userId: 11, email: 'q-legacy@local.test', permissions: ['quote/view'] })))
  quoteViewClerk = createClient(env.call, await login(env.call, await seedClerk({ userId: 12, email: 'q-view@local.test', permissions: ['sales/quote-view'] })))
  customerViewClerk = createClient(env.call, await login(env.call, await seedClerk({ userId: 13, email: 'q-cust@local.test', permissions: ['sales/order-view'] })))
})

after(async () => {
  await env?.dispose()
})

// ─────────────────────────── 入口与鉴权 ───────────────────────────

test('未登录访问报价列表 → 401，返回的不是契约信封', async () => {
  const response = await env.call('/api/v2/sales/quotes')
  assert.equal(response.status, 401)
})

test('没有任何权限的店员：读列表与建草稿都 403（契约信封）', async () => {
  const list = await json(await clerk.get('/api/v2/sales/quotes'))
  assert.equal(list.status, 403)
  assert.equal(list.body.error.code, 'PERMISSION_DENIED')

  const create = await json(await clerk.post('/api/v2/sales/quotes', { requestId: 'r-noperm', title: 'x' }))
  assert.equal(create.status, 403)
  assert.equal(create.body.error.code, 'PERMISSION_DENIED')
})

test('不存在的接口路径 → 404（本模块返回 null，交由入口兜底）', async () => {
  const response = await a.get('/api/v2/sales/quotes-x')
  assert.equal(response.status, 404)
})

test('方法不支持 → 405', async () => {
  const response = await a.del('/api/v2/sales/quotes')
  assert.equal(response.status, 405)
})

// ─────────────────────────── B01 建草稿 ───────────────────────────

test('建草稿：落 quote_headers + revision 1（draft），金额由服务端重算', async () => {
  const id = await createDraft(a, {
    title: '装机方案 A',
    lines: [line({ unitPriceCents: 259_900, qty: 2 }), line({ source: 'service', nameSnapshot: '装机服务费', unitPriceCents: 20_000 })],
    discountCents: 9_900,
  }, 'r-create-1')

  const header = await db.prepare('SELECT * FROM quote_headers WHERE id = ?').bind(id).first()
  assert.equal(header.title, '装机方案 A')
  assert.equal(header.current_revision, 0)
  assert.equal(header.version, 1)

  const version = await db.prepare('SELECT * FROM quote_versions WHERE quote_id = ?').bind(id).first()
  assert.equal(version.revision, 1)
  assert.equal(version.status, 'draft')
  assert.equal(version.issued_at, null)
  assert.equal(version.subtotal_cents, 259_900 * 2 + 20_000)
  assert.equal(version.total_cents, version.subtotal_cents - 9_900)

  // 行小计由服务端算，不相信客户端
  const lines = await db.prepare('SELECT * FROM quote_lines WHERE quote_id = ? ORDER BY position').bind(id).all()
  assert.equal(lines.results.length, 2)
  assert.equal(lines.results[0].line_total_cents, 519_800)
  assert.equal(lines.results[0].position, 0)
})

test('D05/D06：报价不能改15%预付款或在条款里藏自动配送费', async () => {
  const deposit = await json(await a.post('/api/v2/sales/quotes', {
    requestId: 'r-deposit-rule', title: '错误预付款比例', terms: { depositPercent: 20 }, lines: [line()],
  }))
  assert.equal(deposit.status, 400, JSON.stringify(deposit.body))
  assert.match(deposit.body.error.message, /固定为 15%/)

  const delivery = await json(await a.post('/api/v2/sales/quotes', {
    requestId: 'r-delivery-fee-rule', title: '隐藏配送费',
    terms: { delivery: { mode: 'delivery', feeCents: 3000 } }, lines: [line()],
  }))
  assert.equal(delivery.status, 400, JSON.stringify(delivery.body))
  assert.match(delivery.body.error.message, /服务行.*自动配送计费暂未开放/)

  const extension = await json(await a.post('/api/v2/sales/quotes', {
    requestId: 'r-extension-warranty-rule', title: '延保另收费',
    lines: [{ source: 'service', nameSnapshot: '二手整机延保 3 个月', qty: 1, unitPriceCents: 9900 }],
  }))
  assert.equal(extension.status, 400, JSON.stringify(extension.body))
  assert.match(extension.body.error.message, /延保选购、收费和订单履约暂未开放/)
  assert.equal(await scalar('SELECT COUNT(*) FROM quote_headers WHERE id IN (?, ?, ?)', 'r-deposit-rule::quote', 'r-delivery-fee-rule::quote', 'r-extension-warranty-rule::quote'), 0)
})

test('建草稿带客户：客户必须存在且属本店，否则 404 且不落库', async () => {
  const response = await json(await a.post('/api/v2/sales/quotes', { requestId: 'r-bad-customer', title: '带客户', customerId: 999_999 }))
  assert.equal(response.status, 404)
  assert.equal(response.body.error.code, 'ENTITY_NOT_FOUND')
  assert.equal(await scalar('SELECT COUNT(*) FROM quote_headers WHERE id = ?', 'r-bad-customer::quote'), 0)
})

test('跨店客户不能挂到本店报价上（0011 的同店外键 + 写前守卫）', async () => {
  const customerB = await seedCustomer({ storeId: 2, name: '乙店客户' })
  const response = await json(await a.post('/api/v2/sales/quotes', { requestId: 'r-cross-customer', title: '跨店', customerId: customerB }))
  assert.equal(response.status, 404)
  assert.equal(await scalar('SELECT COUNT(*) FROM quote_headers WHERE id = ?', 'r-cross-customer::quote'), 0)
})

test('建草稿带客户成功：customer_id 落库，详情里能读到客户名', async () => {
  const customerId = await seedCustomer({ storeId: 1, name: '张三', phone: '13800000001' })
  const id = await createDraft(a, { title: '给张三的配置', customerId, lines: [line()] }, 'r-with-customer')
  const detail = await json(await a.get(`/api/v2/sales/quotes/${encodeURIComponent(id)}`))
  assert.equal(detail.status, 200)
  assert.equal(detail.body.data.quote.customerId, customerId)
  assert.equal(detail.body.data.customer.name, '张三')
})

test('缺 requestId → 400；与 Idempotency-Key 头不一致 → 400', async () => {
  const missing = await json(await a.post('/api/v2/sales/quotes', { title: '没有 requestId' }))
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'VALIDATION_ERROR')

  const mismatch = await env.call('/api/v2/sales/quotes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await login(env.call, OWNER_A)}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'header-x' },
    body: JSON.stringify({ requestId: 'body-y', title: '不一致' }),
  })
  assert.equal(mismatch.status, 400)
})

// ─────────────────────────── 幂等 ───────────────────────────

test('同 requestId 同载荷：复用原结果，不重复建单', async () => {
  const body = { title: '幂等草稿', lines: [line()] }
  const first = await json(await a.post('/api/v2/sales/quotes', { requestId: 'r-idem-1', ...body }))
  const second = await json(await a.post('/api/v2/sales/quotes', { requestId: 'r-idem-1', ...body }))
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(second.body.data.entityId, first.body.data.entityId)
  assert.equal(await scalar('SELECT COUNT(*) FROM quote_headers WHERE id = ?', 'r-idem-1::quote'), 1)
})

test('同 requestId 改载荷 → 409 IDEMPOTENCY_MISMATCH', async () => {
  await a.post('/api/v2/sales/quotes', { requestId: 'r-idem-2', title: '原始', lines: [line()] })
  const conflict = await json(await a.post('/api/v2/sales/quotes', { requestId: 'r-idem-2', title: '改了标题', lines: [line()] }))
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_MISMATCH')
})

// ─────────────────────────── B02 保存 ───────────────────────────

test('草稿反复保存不涨版本号：仍然只有 revision 1', async () => {
  const id = await createDraft(a, { title: '反复保存', lines: [line()] }, 'r-save-1')

  const first = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/save`, {
    requestId: 'r-save-1-a', expectedVersion: 1, title: '反复保存（改）', lines: [line({ unitPriceCents: 111_100 })],
  }))
  assert.equal(first.status, 200)
  assert.equal(first.body.data.effects.revision, 1)
  assert.equal(first.body.data.entityVersion, 2)

  const second = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/save`, {
    requestId: 'r-save-1-b', expectedVersion: 2, title: '反复保存（再改）', lines: [line({ unitPriceCents: 222_200 })],
  }))
  assert.equal(second.status, 200)
  assert.equal(second.body.data.effects.revision, 1)

  assert.equal(await scalar('SELECT COUNT(*) FROM quote_versions WHERE quote_id = ?', id), 1)
  assert.equal(await scalar('SELECT COUNT(*) FROM quote_lines WHERE quote_id = ? AND revision = 1', id), 1)
  assert.equal(await scalar('SELECT unit_price_cents FROM quote_lines WHERE quote_id = ? AND revision = 1', id), 222_200)
})

test('保存时 expectedVersion 落后 → 409 VERSION_CONFLICT，且草稿内容不变', async () => {
  const id = await createDraft(a, { title: '版本冲突', lines: [line()] }, 'r-save-2')
  await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/save`, {
    requestId: 'r-save-2-a', expectedVersion: 1, title: '第一次改', lines: [line({ unitPriceCents: 333_300 })],
  })

  const stale = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/save`, {
    requestId: 'r-save-2-b', expectedVersion: 1, title: '拿旧版本改', lines: [line({ unitPriceCents: 444_400 })],
  }))
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT')
  assert.equal(await scalar('SELECT unit_price_cents FROM quote_lines WHERE quote_id = ? AND revision = 1', id), 333_300)
})

test('保存缺 expectedVersion → 400', async () => {
  const id = await createDraft(a, { title: '缺版本号', lines: [line()] }, 'r-save-3')
  const response = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/save`, {
    requestId: 'r-save-3-a', title: '没带版本', lines: [line()],
  }))
  assert.equal(response.status, 400)
})

// ─────────────────────────── B02 发出 ───────────────────────────

test('发出报价：draft → issued，有效期 24 小时，current_revision 前进', async () => {
  const id = await createDraft(a, { title: '发出的单', lines: [line({ unitPriceCents: 500_000 })] }, 'r-issue-1')
  const before = Date.now()
  const result = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/issue`, { requestId: 'r-issue-1-a', expectedVersion: 1 }))
  assert.equal(result.status, 200)
  assert.equal(result.body.data.state, 'issued')

  const version = await db.prepare('SELECT * FROM quote_versions WHERE quote_id = ? AND revision = 1').bind(id).first()
  assert.equal(version.status, 'issued')
  assert.ok(version.issued_at)
  const hours = (new Date(version.valid_until).getTime() - before) / 3_600_000
  assert.ok(hours > 23.9 && hours < 24.1, `有效期应约 24 小时，实际 ${hours}`)

  const header = await db.prepare('SELECT * FROM quote_headers WHERE id = ?').bind(id).first()
  assert.equal(header.current_revision, 1)
  assert.equal(header.version, 2)
})

test('发出时签发分享凭证：只存摘要，明文不在库里', async () => {
  const id = await createDraft(a, { title: '带凭证的单', lines: [line()] }, 'r-issue-2')
  const result = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/issue`, { requestId: 'r-issue-2-a', expectedVersion: 1 }))

  const token = result.body.data.shareToken
  assert.equal(typeof token, 'string')
  assert.ok(token.length >= 32, '明文 token 应足够长')

  const share = await db.prepare('SELECT * FROM quote_shares WHERE quote_id = ?').bind(id).first()
  assert.equal(share.revision, 1)
  assert.equal(share.status, 'active')
  assert.notEqual(share.token_hash, token)
  assert.equal(await scalar('SELECT COUNT(*) FROM quote_shares WHERE quote_id = ? AND token_hash = ?', id, token), 0)

  // 幂等重放不给第二次明文
  const replay = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/issue`, { requestId: 'r-issue-2-a', expectedVersion: 1 }))
  assert.equal(replay.status, 200)
  assert.equal(replay.body.data.shareToken, undefined)
})

test('没有草稿版本时不能再发出 → 400（已发出的版本不会被覆盖）', async () => {
  const id = await createDraft(a, { title: '重复发出', lines: [line()] }, 'r-issue-3')
  await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/issue`, { requestId: 'r-issue-3-a', expectedVersion: 1 })
  const again = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/issue`, { requestId: 'r-issue-3-b', expectedVersion: 2 }))
  assert.equal(again.status, 400)
  assert.equal(again.body.error.code, 'VALIDATION_ERROR')
})

test('空报价不能发出（契约 B02：issue 要求完整配置行）', async () => {
  const id = await createDraft(a, { title: '空草稿', lines: [] }, 'r-issue-4')
  const response = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/issue`, { requestId: 'r-issue-4-a', expectedVersion: 1 }))
  assert.equal(response.status, 400)
})

test('发出后改价：生成新版本，旧版本金额原样保留', async () => {
  const id = await createDraft(a, { title: '改价', lines: [line({ unitPriceCents: 100_000 })] }, 'r-revise-1')
  await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/issue`, { requestId: 'r-revise-1-a', expectedVersion: 1 })

  // 以已发出版本为底稿保存 → revision 2（草稿）
  const saved = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/save`, {
    requestId: 'r-revise-1-b', expectedVersion: 2, title: '改价', lines: [line({ unitPriceCents: 90_000 })], changeReason: '顾客要降价', feedbackSource: 'wechat',
  }))
  assert.equal(saved.status, 200)
  assert.equal(saved.body.data.effects.revision, 2)

  const v1 = await db.prepare('SELECT * FROM quote_versions WHERE quote_id = ? AND revision = 1').bind(id).first()
  assert.equal(v1.status, 'issued')
  assert.equal(v1.total_cents, 100_000)
  assert.equal(await scalar('SELECT line_total_cents FROM quote_lines WHERE quote_id = ? AND revision = 1', id), 100_000)

  const v2 = await db.prepare('SELECT * FROM quote_versions WHERE quote_id = ? AND revision = 2').bind(id).first()
  assert.equal(v2.status, 'draft')
  assert.equal(v2.total_cents, 90_000)
  assert.equal(JSON.parse(v2.terms_snapshot).changeReason, '顾客要降价')
  assert.equal(JSON.parse(v2.terms_snapshot).feedbackSource, 'wechat')

  // 发出新版本后 current_revision 指到 2，旧版本仍在账上
  await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/issue`, { requestId: 'r-revise-1-c', expectedVersion: 3 })
  assert.equal(await scalar('SELECT current_revision FROM quote_headers WHERE id = ?', id), 2)
  assert.equal(await scalar('SELECT COUNT(*) FROM quote_versions WHERE quote_id = ?', id), 2)
})

// ─────────────────────────── 校验与红线 ───────────────────────────

test('客供件不允许带价，且必须指出来源设备', async () => {
  const priced = await json(await a.post('/api/v2/sales/quotes', {
    requestId: 'r-rule-customer-1', title: '客供带价', lines: [line({ source: 'customer', unitPriceCents: 1, customerDeviceRef: '1' })],
  }))
  assert.equal(priced.status, 400)

  const noDevice = await json(await a.post('/api/v2/sales/quotes', {
    requestId: 'r-rule-customer-2', title: '客供无设备', lines: [line({ source: 'customer', unitPriceCents: 0 })],
  }))
  assert.equal(noDevice.status, 400)
})

test('二手件必须指定具体实物，且数量只能是 1', async () => {
  const noItem = await json(await a.post('/api/v2/sales/quotes', {
    requestId: 'r-rule-used-1', title: '二手无实物', lines: [line({ source: 'used' })],
  }))
  assert.equal(noItem.status, 400)

  const twoItems = await json(await a.post('/api/v2/sales/quotes', {
    requestId: 'r-rule-used-2', title: '二手两件', lines: [line({ source: 'used', stockItemId: 'si-x', qty: 2 })],
  }))
  assert.equal(twoItems.status, 400)
})

test('优惠不能超过小计（0009 的 CHECK 拦得住，服务端先给可读说明）', async () => {
  const response = await json(await a.post('/api/v2/sales/quotes', {
    requestId: 'r-rule-discount', title: '优惠超标', lines: [line({ unitPriceCents: 1_000 })], discountCents: 2_000,
  }))
  assert.equal(response.status, 400)
})

test('报价响应里没有成本、供应商、SN 字段', async () => {
  const id = await createDraft(a, { title: '脱敏检查', lines: [line()] }, 'r-redact-1')
  const list = await a.get('/api/v2/sales/quotes')
  const detail = await a.get(`/api/v2/sales/quotes/${encodeURIComponent(id)}`)
  const text = `${await list.text()}${await detail.text()}`.toLowerCase()
  for (const forbidden of ['cost', 'supplier', 'vendor', 'sn_raw', 'snraw', 'margin', 'profit']) {
    assert.ok(!text.includes(forbidden), `报价响应里不应出现 ${forbidden}`)
  }
})

test('报价全程不动库存：建单、保存、发出之后预留表仍为空', async () => {
  const itemId = await seedStockItem({ entityId: 'stock-prod-quote', itemId: 'si-quote-1' })
  const id = await createDraft(a, {
    title: '二手装机', lines: [line({ source: 'used', stockItemId: itemId, unitPriceCents: 300_000 })],
  }, 'r-no-reserve-1')

  const before = await scalar('SELECT COUNT(*) FROM stock_reservations')
  await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/save`, {
    requestId: 'r-no-reserve-1-a', expectedVersion: 1, title: '二手装机',
    lines: [line({ source: 'used', stockItemId: itemId, unitPriceCents: 310_000 })],
  })
  await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/issue`, { requestId: 'r-no-reserve-1-b', expectedVersion: 2 })

  assert.equal(await scalar('SELECT COUNT(*) FROM stock_reservations'), before)
  assert.equal(await scalar('SELECT COUNT(*) FROM inventory_movements'), 0)
  // 实物本身也没被改状态
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId), 'available')
})

// ─────────────────────────── R05 读取 ───────────────────────────

test('列表：草稿与已发出分列，过期与即将到期能标出来', async () => {
  const draftId = await createDraft(a, { title: '列表草稿', lines: [line()] }, 'r-list-1')

  const soon = await createDraft(a, { title: '快要过期', lines: [line()] }, 'r-list-2')
  const soonDeadline = new Date(Date.now() + 30 * 60_000).toISOString()
  await a.post(`/api/v2/sales/quotes/${encodeURIComponent(soon)}/issue`, { requestId: 'r-list-2-a', expectedVersion: 1, validUntil: soonDeadline })

  const gone = await createDraft(a, { title: '已经过期', lines: [line()] }, 'r-list-3')
  await a.post(`/api/v2/sales/quotes/${encodeURIComponent(gone)}/issue`, { requestId: 'r-list-3-a', expectedVersion: 1, validUntil: '2020-01-01T00:00:00.000Z' })

  const list = await json(await a.get('/api/v2/sales/quotes'))
  assert.equal(list.status, 200)
  const byId = new Map(list.body.data.quotes.map((row) => [row.id, row]))
  assert.equal(byId.get(draftId).status, 'draft')
  assert.equal(byId.get(soon).status, 'issued')
  assert.equal(byId.get(soon).expiringSoon, true)
  assert.equal(byId.get(gone).status, 'expired')
  assert.equal(byId.get(gone).expired, true)
  assert.ok(list.body.data.settings.validityHours === 24, '门店参数随列表返回，界面据此解释有效期')

  const expiredOnly = await json(await a.get('/api/v2/sales/quotes?status=expired'))
  assert.ok(expiredOnly.body.data.quotes.every((row) => row.status === 'expired'))
})

test('R05 列表按工作版本显示摘要，已发出指针与统计保持独立', async () => {
  const before = (await json(await a.get('/api/v2/sales/quotes'))).body.data.totals
  const prefix = 'R05工作版本口径'

  const draftId = await createDraft(a, {
    title: `${prefix}-纯草稿`,
    lines: [line({ nameSnapshot: 'CPU', qty: 2, unitPriceCents: 32_000 }), line({ nameSnapshot: '内存', unitPriceCents: 15_999 })],
    discountCents: 2_000,
  }, 'r-work-draft')

  const issuedId = await createDraft(a, { title: `${prefix}-已发出`, lines: [line({ unitPriceCents: 100_000 })] }, 'r-work-issued')
  await a.post(`/api/v2/sales/quotes/${encodeURIComponent(issuedId)}/issue`, { requestId: 'r-work-issued-i', expectedVersion: 1 })

  const revisedId = await createDraft(a, { title: `${prefix}-已发出另存草稿`, lines: [line({ unitPriceCents: 123_400 })] }, 'r-work-revised')
  await a.post(`/api/v2/sales/quotes/${encodeURIComponent(revisedId)}/issue`, { requestId: 'r-work-revised-i', expectedVersion: 1 })
  await a.post(`/api/v2/sales/quotes/${encodeURIComponent(revisedId)}/save`, {
    requestId: 'r-work-revised-s', expectedVersion: 2, title: `${prefix}-已发出另存草稿`,
    lines: [line({ nameSnapshot: '新CPU', unitPriceCents: 150_000 }), line({ nameSnapshot: '新内存', unitPriceCents: 69_900 })],
    discountCents: 20_000,
  })

  const noWorkVersionId = await createDraft(a, { title: `${prefix}-无工作版本`, lines: [line()] }, 'r-work-missing-draft')
  await db.prepare('DELETE FROM quote_versions WHERE quote_id = ?').bind(noWorkVersionId).run()

  const brokenPointerId = await createDraft(a, { title: `${prefix}-指针无版本`, lines: [line()] }, 'r-work-missing-issued')
  await a.post(`/api/v2/sales/quotes/${encodeURIComponent(brokenPointerId)}/issue`, { requestId: 'r-work-missing-issued-i', expectedVersion: 1 })
  await db.prepare('DELETE FROM quote_versions WHERE quote_id = ?').bind(brokenPointerId).run()

  const list = await json(await a.get(`/api/v2/sales/quotes?q=${encodeURIComponent(prefix)}`))
  assert.equal(list.status, 200)
  const byId = new Map(list.body.data.quotes.map((row) => [row.id, row]))

  const pureDraft = byId.get(draftId)
  assert.equal(pureDraft.status, 'draft')
  assert.equal(pureDraft.currentRevision, 0)
  assert.equal(pureDraft.workRevision, 1)
  assert.equal(pureDraft.publishedRevision, null)
  assert.equal(pureDraft.lineCount, 2)
  assert.equal(pureDraft.subtotalCents, 79_999)
  assert.equal(pureDraft.discountCents, 2_000)
  assert.equal(pureDraft.totalCents, 77_999)
  const pureDetail = (await json(await a.get(`/api/v2/sales/quotes/${encodeURIComponent(draftId)}`))).body.data
  assert.equal(pureDraft.workRevision, pureDetail.version.revision)
  assert.equal(pureDraft.status, pureDetail.version.status)
  assert.equal(pureDraft.lineCount, pureDetail.lines.length)
  assert.equal(pureDraft.totalCents, pureDetail.version.totalCents)

  const issuedOnly = byId.get(issuedId)
  assert.equal(issuedOnly.status, 'issued')
  assert.equal(issuedOnly.workRevision, 1)
  assert.equal(issuedOnly.publishedRevision, 1)
  assert.equal(issuedOnly.totalCents, 100_000)
  assert.equal(issuedOnly.shared, true)

  const revised = byId.get(revisedId)
  assert.equal(revised.status, 'draft')
  assert.equal(revised.currentRevision, 1)
  assert.equal(revised.workRevision, 2)
  assert.equal(revised.publishedRevision, 1)
  assert.equal(revised.publishedStatus, 'issued')
  assert.equal(revised.publishedTotalCents, 123_400)
  assert.equal(revised.shared, true)
  assert.equal(revised.lineCount, 2)
  assert.equal(revised.totalCents, 199_900)
  const revisedDetail = (await json(await a.get(`/api/v2/sales/quotes/${encodeURIComponent(revisedId)}`))).body.data
  assert.equal(revised.workRevision, revisedDetail.version.revision)
  assert.equal(revised.status, revisedDetail.version.status)
  assert.equal(revised.lineCount, revisedDetail.lines.length)
  assert.equal(revised.totalCents, revisedDetail.version.totalCents)

  for (const missingId of [noWorkVersionId, brokenPointerId]) {
    const missing = byId.get(missingId)
    assert.equal(missing.status, 'missing')
    assert.equal(missing.workRevision, null)
    assert.equal(missing.publishedRevision, null)
    assert.equal(missing.lineCount, null)
    assert.equal(missing.subtotalCents, null)
    assert.equal(missing.discountCents, null)
    assert.equal(missing.totalCents, null)
  }

  const totals = list.body.data.totals
  assert.equal(totals.all, before.all + 5)
  assert.equal(totals.draft, before.draft + 2)
  assert.equal(totals.issued, before.issued + 2)
  assert.equal(totals.confirmed, before.confirmed)
  assert.equal(totals.issuedAmountCents, before.issuedAmountCents + 223_400)

  const drafts = await json(await a.get(`/api/v2/sales/quotes?status=draft&q=${encodeURIComponent(prefix)}`))
  assert.deepEqual(new Set(drafts.body.data.quotes.map((row) => row.id)), new Set([draftId, revisedId]))
  assert.equal(drafts.body.data.totals.all, totals.all, '搜索和状态筛选不缩小汇总范围')
  const issued = await json(await a.get(`/api/v2/sales/quotes?status=issued&q=${encodeURIComponent(prefix)}`))
  assert.deepEqual(issued.body.data.quotes.map((row) => row.id), [issuedId])
  assert.equal(issued.body.data.totals.issuedAmountCents, totals.issuedAmountCents)
})

test('详情：行序稳定、版本历史完整、二手件可用性能读出来', async () => {
  const itemId = await seedStockItem({ entityId: 'stock-prod-detail', itemId: 'si-detail-1' })
  const id = await createDraft(a, {
    title: '详情检查',
    lines: [
      line({ position: undefined, unitPriceCents: 100_000 }),
      line({ source: 'used', stockItemId: itemId, nameSnapshot: '二手显卡', unitPriceCents: 200_000, warrantySnapshot: { remark: '成色九成新' } }),
      line({ source: 'service', nameSnapshot: '装机服务', unitPriceCents: 30_000 }),
    ],
  }, 'r-detail-1')
  await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/issue`, { requestId: 'r-detail-1-a', expectedVersion: 1 })

  const detail = await json(await a.get(`/api/v2/sales/quotes/${encodeURIComponent(id)}`))
  assert.equal(detail.status, 200)
  const data = detail.body.data
  assert.equal(data.quote.currentRevision, 1)
  assert.deepEqual(data.lines.map((row) => row.position), [0, 1, 2])
  assert.equal(data.lines[1].source, 'used')
  assert.equal(data.lines[1].stockItemAvailability, 'available')
  assert.equal(data.revisions.length, 1)
  assert.equal(data.revisions[0].status, 'issued')
  assert.equal(data.revisions[0].lineCount, 3)
  assert.equal(data.share.active, true)
  // 逐行质保快照：二手 1 个月
  assert.equal(data.lines[1].warrantySnapshot.months, 1)
  assert.equal(data.lines[1].warrantySnapshot.remark, '成色九成新')
  assert.equal(data.lines[2].warrantySnapshot.months, 0)
})

test('二手件被占用后详情标出「不能直接拿」', async () => {
  const itemId = await seedStockItem({ entityId: 'stock-prod-taken', itemId: 'si-taken-1' })
  const id = await createDraft(a, {
    title: '占用检查', lines: [line({ source: 'used', stockItemId: itemId, unitPriceCents: 100_000 })],
  }, 'r-detail-2')
  await db.prepare(`UPDATE stock_items SET availability = 'reserved' WHERE id = ?`).bind(itemId).run()

  const detail = await json(await a.get(`/api/v2/sales/quotes/${encodeURIComponent(id)}`))
  assert.equal(detail.body.data.lines[0].stockItemAvailability, 'reserved')

  await db.prepare(`UPDATE stock_items SET availability = 'available' WHERE id = ?`).bind(itemId).run()
})

test('读指定历史版本：revision 参数能取回旧版本的行', async () => {
  const id = await createDraft(a, { title: '版本回看', lines: [line({ unitPriceCents: 100_000 })] }, 'r-detail-3')
  await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/issue`, { requestId: 'r-detail-3-a', expectedVersion: 1 })
  await a.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/save`, {
    requestId: 'r-detail-3-b', expectedVersion: 2, title: '版本回看', lines: [line({ unitPriceCents: 88_000 })],
  })

  const old = await json(await a.get(`/api/v2/sales/quotes/${encodeURIComponent(id)}?revision=1`))
  assert.equal(old.body.data.version.revision, 1)
  assert.equal(old.body.data.version.totalCents, 100_000)

  const draftView = await json(await a.get(`/api/v2/sales/quotes/${encodeURIComponent(id)}?revision=2`))
  assert.equal(draftView.body.data.version.status, 'draft')
  assert.equal(draftView.body.data.hasDraft, true)
})

test('跨店：别家门店读不到本店报价 → 404', async () => {
  const id = await createDraft(a, { title: '甲店的单', lines: [line()] }, 'r-cross-1')
  const response = await json(await b.get(`/api/v2/sales/quotes/${encodeURIComponent(id)}`))
  assert.equal(response.status, 404)
  assert.equal(response.body.error.code, 'ENTITY_NOT_FOUND')

  const save = await json(await b.post(`/api/v2/sales/quotes/${encodeURIComponent(id)}/save`, {
    requestId: 'r-cross-1-b', expectedVersion: 1, title: '乙店来改', lines: [line()],
  }))
  assert.equal(save.status, 404)
  assert.equal(await scalar('SELECT title FROM quote_headers WHERE id = ?', id), '甲店的单')
})

// ─────────────────────────── 权限映射（E05 D-C 裁定） ───────────────────────────

test('报价读权限：旧码 quote/view 与新码 sales/quote-view 都能读', async () => {
  await createDraft(a, { title: '权限检查', lines: [line()] }, 'r-perm-1')
  const legacy = await json(await legacyClerk.get('/api/v2/sales/quotes'))
  assert.equal(legacy.status, 200)
  const modern = await json(await quoteViewClerk.get('/api/v2/sales/quotes'))
  assert.equal(modern.status, 200)
})

test('只有读权限的店员不能建草稿 → 403', async () => {
  const response = await json(await quoteViewClerk.post('/api/v2/sales/quotes', { requestId: 'r-perm-2', title: '无权建单', lines: [line()] }))
  assert.equal(response.status, 403)
  assert.equal(await scalar('SELECT COUNT(*) FROM quote_headers WHERE id = ?', 'r-perm-2::quote'), 0)
})

test('客户接口改用契约正牌码：sales/order-view 能读，旧码 quote/view 仍兼容', async () => {
  const modern = await json(await customerViewClerk.get('/api/customers'))
  assert.equal(modern.status, 200, '只有 sales/order-view 的店员应能读客户')

  const legacy = await json(await legacyClerk.get('/api/customers'))
  assert.equal(legacy.status, 200, '门店角色行里存的是旧码 quote/view，必须继续能读')

  const none = await json(await clerk.get('/api/customers'))
  assert.equal(none.status, 403, '两者都没有的店员不能读客户')
})

test('客户接口写权限：sales/order-edit 能写；只有读码的店员不能写', async () => {
  const denied = await json(await customerViewClerk.post('/api/customers', { name: '只读店员试图建档' }))
  assert.equal(denied.status, 403, '只有读权限的店员不能建档')
  const deniedLegacy = await json(await legacyClerk.post('/api/customers', { name: '旧读码店员试图建档' }))
  assert.equal(deniedLegacy.status, 403, '旧码 quote/view 是读码，换不来写权限')

  const editClerk = createClient(env.call, await login(env.call, await seedClerk({ userId: 14, email: 'q-cust-edit@local.test', permissions: ['sales/order-edit'] })))
  const allowed = await json(await editClerk.post('/api/customers', { name: '正牌写码店员建档' }))
  assert.equal(allowed.status, 201)
})
