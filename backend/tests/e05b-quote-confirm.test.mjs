/**
 * E05b · B42「记录顾客确认」的 HTTP 接线（/api/v2/sales/quotes/:id/confirm）。
 *
 * 契约依据（2026-09-19 契约修订）：enums.json QuoteStatus 新增 confirmed（issued → confirmed，
 * 动作 B42）；objects.json QuoteVersion 新增 confirmedAt / confirmedSource；actions.json B42。
 *
 * 覆盖五层：
 *   1. 入口层：路由、鉴权、权限（sales/quote-edit 与旧码 quote/edit）；
 *   2. 状态层：只有已发出且未过期的版本能确认；草稿/已确认/过期都有人话文案；
 *   3. 数据层：confirmed_at / confirmed_source 成对落库（0012 的 CHECK）；确认后本版本
 *      不可被原地改写，save 出新版本且 confirmed 版本原样保留；
 *   4. 事务层：同 requestId 复用、改载荷冲突、版本冲突、跨店 404；
 *   5. 边界层：确认全程不写库存（R12：确认 ≠ 付款、确认不锁库存）。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER_A = { email: 'c-owner-a@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: '确认门店甲' }
const OWNER_B = { email: 'c-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: '确认门店乙' }

let env
let db
let a
let b
/** 无任何权限的店员（门店甲） */
let clerk
/** 只有旧码 quote/edit 的店员（门店甲）—— 确认动作应可用 */
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

const line = (overrides = {}) => ({
  source: 'new',
  nameSnapshot: '测试配件',
  specSnapshot: '',
  qty: 1,
  unitPriceCents: 100_000,
  ...overrides,
})

/** 建草稿 → 发出，返回 { quoteId, headerVersion }。 */
async function createIssued(client, { requestId, validUntil = null, unitPriceCents = 100_000 } = {}) {
  const create = await json(await client.post('/api/v2/sales/quotes', {
    requestId: `${requestId}-c`, title: `确认测试 ${requestId}`, lines: [line({ unitPriceCents })],
  }))
  assert.equal(create.status, 200, JSON.stringify(create.body))
  const quoteId = create.body.data.entityId
  const issue = await json(await client.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/issue`, {
    requestId: `${requestId}-i`, expectedVersion: create.body.data.entityVersion, validUntil,
  }))
  assert.equal(issue.status, 200, JSON.stringify(issue.body))
  return { quoteId, headerVersion: issue.body.data.entityVersion, revision: issue.body.data.effects.revision }
}

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER_A)
  await seedOwner(db, OWNER_B)
  a = createClient(env.call, await login(env.call, OWNER_A))
  b = createClient(env.call, await login(env.call, OWNER_B))
  clerk = createClient(env.call, await login(env.call, await seedClerk({ userId: 10, email: 'c-noperm@local.test' })))
  legacyClerk = createClient(env.call, await login(env.call, await seedClerk({ userId: 11, email: 'c-legacy@local.test', permissions: ['quote/edit'] })))
})

after(async () => {
  await env?.dispose()
})

// ─────────────────────────── 入口与鉴权 ───────────────────────────

test('未登录确认 → 401；无权限店员 → 403（契约信封）', async () => {
  const anonymous = await env.call('/api/v2/sales/quotes/q-x/confirm', { method: 'POST', body: JSON.stringify({ requestId: 'r-anon', source: 'offline' }) })
  assert.equal(anonymous.status, 401)

  const denied = await json(await clerk.post('/api/v2/sales/quotes/q-x/confirm', { requestId: 'r-noperm', source: 'offline' }))
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED')
})

test('确认来源缺省或非法 → 400', async () => {
  const { quoteId } = await createIssued(a, { requestId: 'r-src' })
  const missing = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, { requestId: 'r-src-missing' }))
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'VALIDATION_ERROR')

  const bogus = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, { requestId: 'r-src-bogus', source: 'phone' }))
  assert.equal(bogus.status, 400)
})

// ─────────────────────────── 状态层 ───────────────────────────

test('确认成功：issued → confirmed，确认时间与来源成对落库，报价头版本 +1', async () => {
  const { quoteId } = await createIssued(a, { requestId: 'r-ok-1' })
  const before = await db.prepare('SELECT version FROM quote_headers WHERE id = ?').bind(quoteId).first()

  const confirm = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, {
    requestId: 'r-ok-1-confirm', source: 'miniprogram',
  }))
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body))
  assert.equal(confirm.body.data.state, 'confirmed')
  assert.equal(confirm.body.data.entityVersion, before.version + 1)

  const version = await db.prepare('SELECT * FROM quote_versions WHERE quote_id = ?').bind(quoteId).first()
  assert.equal(version.status, 'confirmed')
  assert.ok(version.confirmed_at, 'confirmed_at 必须落库')
  assert.equal(version.confirmed_source, 'miniprogram')
  // 0012 的 CHECK：确认字段只允许成对出现
  assert.ok(version.issued_at, '确认过的版本必须有发出时间')

  // 详情带出确认信息；列表 totals 计入 confirmed
  const detail = await json(await a.get(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}`))
  assert.equal(detail.status, 200)
  assert.equal(detail.body.data.version.status, 'confirmed')
  assert.equal(detail.body.data.version.confirmedSource, 'miniprogram')
  assert.ok(detail.body.data.version.confirmedAt)
  const list = await json(await a.get('/api/v2/sales/quotes'))
  assert.equal(list.body.data.totals.confirmed, 1)
})

test('三种确认来源都接受（R10 口径）', async () => {
  for (const [index, source] of ['wechat', 'offline', 'miniprogram'].entries()) {
    const { quoteId } = await createIssued(a, { requestId: `r-src-ok-${index}` })
    const confirm = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, {
      requestId: `r-src-ok-${index}-confirm`, source,
    }))
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body))
    assert.equal(await scalar('SELECT confirmed_source FROM quote_versions WHERE quote_id = ?', quoteId), source)
  }
})

test('草稿不能确认：没发出过的报价没有「顾客确认」可记', async () => {
  const create = await json(await a.post('/api/v2/sales/quotes', { requestId: 'r-draft-c', title: '纯草稿', lines: [line()] }))
  const quoteId = create.body.data.entityId
  const confirm = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, { requestId: 'r-draft-confirm', source: 'offline' }))
  assert.equal(confirm.status, 400)
  assert.equal(confirm.body.error.code, 'VALIDATION_ERROR')
  assert.equal(await scalar('SELECT status FROM quote_versions WHERE quote_id = ?', quoteId), 'draft')
})

test('已确认的版本不能重复确认（不同 requestId 也不行）', async () => {
  const { quoteId } = await createIssued(a, { requestId: 'r-twice' })
  const first = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, { requestId: 'r-twice-a', source: 'wechat' }))
  assert.equal(first.status, 200)
  const second = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, { requestId: 'r-twice-b', source: 'wechat' }))
  assert.equal(second.status, 400)
  assert.equal(second.body.error.code, 'VALIDATION_ERROR')
  // 版本号没有被第二次确认再推高
  assert.equal(await scalar('SELECT status FROM quote_versions WHERE quote_id = ?', quoteId), 'confirmed')
})

test('已过期的版本不能确认：先续期（重新发出）再确认', async () => {
  const past = new Date(Date.now() - 3_600_000).toISOString()
  const { quoteId } = await createIssued(a, { requestId: 'r-expired', validUntil: past })
  const confirm = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, { requestId: 'r-expired-confirm', source: 'offline' }))
  assert.equal(confirm.status, 400)
  assert.equal(confirm.body.error.code, 'VALIDATION_ERROR')
  assert.equal(await scalar('SELECT status FROM quote_versions WHERE quote_id = ?', quoteId), 'issued')
})

// ─────────────────────────── 事务层 ───────────────────────────

test('同 requestId 同载荷：复用原结果，不重复推进版本', async () => {
  const { quoteId } = await createIssued(a, { requestId: 'r-idem-c' })
  const before = await scalar('SELECT version FROM quote_headers WHERE id = ?', quoteId)
  const first = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, { requestId: 'r-idem-c-confirm', source: 'offline' }))
  const second = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, { requestId: 'r-idem-c-confirm', source: 'offline' }))
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(second.body.data.entityId, first.body.data.entityId)
  assert.equal(second.body.data.entityVersion, first.body.data.entityVersion)
  assert.equal(await scalar('SELECT version FROM quote_headers WHERE id = ?', quoteId), before + 1)
})

test('同 requestId 改载荷（换来源）→ 409 IDEMPOTENCY_MISMATCH', async () => {
  const { quoteId } = await createIssued(a, { requestId: 'r-mismatch-c' })
  const first = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, { requestId: 'r-mismatch-confirm', source: 'offline' }))
  assert.equal(first.status, 200)
  // 同一 requestId 再来一次但换了来源：载荷不同，必须拦下而不是复用成功结果
  await db.prepare(`UPDATE quote_versions SET status = 'issued', confirmed_at = NULL, confirmed_source = NULL
                    WHERE quote_id = ?`).bind(quoteId).run()
  const conflict = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, { requestId: 'r-mismatch-confirm', source: 'wechat' }))
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_MISMATCH')
})

test('expectedVersion 落后 → 409 VERSION_CONFLICT', async () => {
  const { quoteId } = await createIssued(a, { requestId: 'r-stale-c' })
  const stale = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, { requestId: 'r-stale-confirm', expectedVersion: 1, source: 'offline' }))
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT')
  assert.equal(await scalar('SELECT status FROM quote_versions WHERE quote_id = ?', quoteId), 'issued')
})

test('跨店确认 → 404，且对方版本状态不变', async () => {
  const { quoteId } = await createIssued(a, { requestId: 'r-cross-c' })
  const cross = await json(await b.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, { requestId: 'r-cross-confirm', source: 'offline' }))
  assert.equal(cross.status, 404)
  assert.equal(cross.body.error.code, 'ENTITY_NOT_FOUND')
  assert.equal(await scalar('SELECT status FROM quote_versions WHERE quote_id = ?', quoteId), 'issued')
})

// ─────────────────────────── 确认后不能改 ───────────────────────────

test('确认后保存：出新草稿版本（revision 2），confirmed 版本原样保留、金额不变', async () => {
  const before = (await json(await a.get('/api/v2/sales/quotes'))).body.data.totals
  const { quoteId } = await createIssued(a, { requestId: 'r-lock-c', unitPriceCents: 123_400 })
  const confirmed = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, { requestId: 'r-lock-confirm', source: 'miniprogram' }))
  assert.equal(confirmed.status, 200)
  const headerVersion = confirmed.body.data.entityVersion

  const save = await json(await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/save`, {
    requestId: 'r-lock-save', expectedVersion: headerVersion, title: '确认后工作版本读模型 r-lock-c', lines: [line({ unitPriceCents: 199_900 })],
  }))
  assert.equal(save.status, 200, JSON.stringify(save.body))
  assert.equal(save.body.data.effects.revision, 2)

  // 第 1 版仍是 confirmed，金额原样；第 2 版是新草稿
  const v1 = await db.prepare('SELECT * FROM quote_versions WHERE quote_id = ? AND revision = 1').bind(quoteId).first()
  assert.equal(v1.status, 'confirmed')
  assert.equal(v1.subtotal_cents, 123_400)
  assert.equal(v1.confirmed_source, 'miniprogram')
  const v2 = await db.prepare('SELECT status FROM quote_versions WHERE quote_id = ? AND revision = 2').bind(quoteId).first()
  assert.equal(v2.status, 'draft')

  const list = await json(await a.get(`/api/v2/sales/quotes?q=${encodeURIComponent('确认后工作版本读模型 r-lock-c')}`))
  assert.equal(list.status, 200)
  assert.equal(list.body.data.quotes.length, 1)
  const row = list.body.data.quotes[0]
  assert.equal(row.status, 'draft')
  assert.equal(row.currentRevision, 1)
  assert.equal(row.workRevision, 2)
  assert.equal(row.publishedRevision, 1)
  assert.equal(row.publishedStatus, 'confirmed')
  assert.equal(row.publishedTotalCents, 123_400)
  assert.equal(row.totalCents, 199_900)
  assert.equal(row.lineCount, 1)
  assert.equal(row.shared, true)
  assert.equal(list.body.data.totals.confirmed, before.confirmed + 1)
  assert.equal(list.body.data.totals.issuedAmountCents, before.issuedAmountCents)
})

test('确认动作全程不写库存（R12：确认 ≠ 付款、确认不锁库存）', async () => {
  const before = await db.prepare('SELECT COUNT(*) AS n FROM stock_reservations').first()
  const { quoteId } = await createIssued(a, { requestId: 'r-nostock-c' })
  await a.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, { requestId: 'r-nostock-confirm', source: 'offline' })
  const after = await db.prepare('SELECT COUNT(*) AS n FROM stock_reservations').first()
  assert.equal(after.n, before.n)
})

// ─────────────────────────── 旧码兼容 ───────────────────────────

test('只有旧码 quote/edit 的店员可以记录确认（LEGACY_EQUIVALENT）', async () => {
  const { quoteId } = await createIssued(a, { requestId: 'r-legacy-c' })
  const confirm = await json(await legacyClerk.post(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, { requestId: 'r-legacy-confirm', source: 'wechat' }))
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body))
  assert.equal(confirm.body.data.state, 'confirmed')
})
