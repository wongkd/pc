/**
 * B16 · 盘点录入与差异批准 HTTP 接线
 *   POST /api/v2/inventory/counts              权限 inventory/count（旧 library/edit 等价）
 *   POST /api/v2/inventory/counts/:id/approve  权限 inventory/count-approve（owner_only 老板专属）
 *
 * 契约依据：
 *   actions.json  B16（inputs 范围与截止序号 / 实盘 / 批准差异理由；
 *                     effects InventoryMovement / StockBalance / AuditEvent；
 *                     errors VERSION_CONFLICT / PERMISSION_DENIED / VALIDATION_ERROR）
 *   enums.json    InventoryMovementSource（count_adjustment 已在 16 值内）
 *   02 §5         保存实盘结果不直接改库存
 *   03 §7         并发以截止时点 / 事件序号对齐
 *
 * 覆盖：
 *   1. 入口层：鉴权、两个路径各自的权限（录入认旧码 library/edit；批准不认旧码）、405；
 *   2. 录入：锁存账面、建草稿，**库存分毫不动**（这是本卡最重要的一条）；
 *   3. 批准：盘盈 / 盘亏 / 零差异三态，写 count_adjustment 流水，余额被调整到实盘值；
 *   4. 账面已变：批准前余额被别的动作改过 → 409 VERSION_CONFLICT 要求重盘，不硬调；
 *   5. 重复批准 / 跨店 / 版本冲突 / 幂等重放；
 *   6. 入参校验与审计留痕。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'
import { seedProduct } from './lib/inventory.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER_A = { email: 'b16-owner-a@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: '盘点门店甲' }
const OWNER_B = { email: 'b16-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: '盘点门店乙' }

let env
let db
/** 门店甲老板 */
let a
/** 门店乙老板（跨店用例） */
let b
/** 无任何权限的店员（门店甲） */
let clerk
/** 只有旧码 library/view + library/edit 的店员（门店甲） */
let legacyClerk
/** 只有新码 inventory/count 的店员 —— 能录入，不能批准 */
let countOnlyClerk
/** 只有新码 inventory/count-approve 的店员 —— 能批准，不能录入 */
let approveOnlyClerk

const json = async (response) => ({ status: response.status, body: await response.json() })

const scalar = async (sql, ...params) => {
  const row = await db.prepare(sql).bind(...params).first()
  return row ? Object.values(row)[0] : null
}

const readAvailable = (productId, storeId = 1) =>
  scalar(
    `SELECT COALESCE((SELECT available_qty FROM stock_balances
                      WHERE store_id = ? AND product_id = ? AND location_id = 'store'), 0)`,
    storeId,
    productId,
  )

/** 播一个店员，并按需要授予权限码（生产 permissions 表无种子迁移，这里显式建行）。 */
async function seedClerk({ userId, email, storeId = 1, permissions = [], owner = 1 }) {
  await db.prepare(`INSERT INTO users (id, email, password_hash, status) VALUES (?, ?, ?, 'active')`)
    .bind(userId, email, await legacyPasswordHash(PASSWORD)).run()
  const member = await db.prepare(`INSERT INTO store_members (store_id, user_id, status, is_owner, created_by, updated_by)
    VALUES (?, ?, 'active', 0, ?, ?)`).bind(storeId, userId, owner, owner).run()
  if (permissions.length) {
    const role = await db.prepare('INSERT INTO roles (store_id, code, name) VALUES (?, ?, ?)')
      .bind(storeId, `role-b16-${userId}`, `角色 ${userId}`).run()
    for (const code of permissions) {
      await db.prepare('INSERT OR IGNORE INTO permissions (code, name) VALUES (?, ?)').bind(code, code).run()
      const permission = await db.prepare('SELECT id FROM permissions WHERE code = ?').bind(code).first()
      await db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)')
        .bind(role.meta.last_row_id, permission.id).run()
    }
    await db.prepare('INSERT INTO member_roles (member_id, role_id) VALUES (?, ?)')
      .bind(member.meta.last_row_id, role.meta.last_row_id).run()
  }
  return { email, password: PASSWORD }
}

/** 播一个指定门店的商品（lib 的 seedProduct 固定 store 1，跨店用例要自己播）。 */
async function seedProductAt(storeId, entityId, name) {
  await db
    .prepare(
      `INSERT INTO hardware
         (user_id, store_id, category, name, entity_id, sku, tracking_mode, requires_sn,
          is_serialized, status, default_price_cents, item_type, version)
       VALUES (1, ?, '测试分类', ?, ?, NULL, 'quantity', 0, 0, 'active', 0, 'product', 1)`,
    )
    .bind(storeId, name ?? entityId, entityId)
    .run()
  return scalar('SELECT id FROM hardware WHERE store_id = ? AND entity_id = ?', storeId, entityId)
}

/**
 * 建立可卖库存。必须走流水让 0007 的余额触发器维护 stock_balances ——
 * 直接 UPDATE 余额会绕开「余额只有一个写入者」的结构保证。
 */
async function seedAvailableStock({ productId, qty, storeId = 1, tag }) {
  const id = `seed-mv-${tag}`
  await db
    .prepare(
      `INSERT INTO inventory_movements
         (id, store_id, product_id, qty, to_bucket, source, occurred_at, actor_user_id, request_id)
       VALUES (?, ?, ?, ?, 'available', 'opening_balance', ?, 1, ?)`,
    )
    .bind(id, storeId, productId, qty, new Date().toISOString(), `${id}::req`).run()
  return id
}

const countsPath = () => '/api/v2/inventory/counts'
const approvePath = (countId) => `/api/v2/inventory/counts/${encodeURIComponent(countId)}/approve`

// 各用例独立商品，互不干扰
let productP1
let productP2
let productP3
let productB

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER_A)
  await seedOwner(db, OWNER_B)
  await seedClerk({ userId: 3, email: 'b16-clerk-none@local.test' })
  await seedClerk({ userId: 4, email: 'b16-clerk-legacy@local.test', permissions: ['library/view', 'library/edit'] })
  await seedClerk({ userId: 5, email: 'b16-clerk-count@local.test', permissions: ['inventory/count'] })
  await seedClerk({ userId: 6, email: 'b16-clerk-approve@local.test', permissions: ['inventory/count-approve'] })

  a = createClient(env.call, await login(env.call, OWNER_A))
  b = createClient(env.call, await login(env.call, OWNER_B))
  clerk = createClient(env.call, await login(env.call, { email: 'b16-clerk-none@local.test', password: PASSWORD }))
  legacyClerk = createClient(env.call, await login(env.call, { email: 'b16-clerk-legacy@local.test', password: PASSWORD }))
  countOnlyClerk = createClient(env.call, await login(env.call, { email: 'b16-clerk-count@local.test', password: PASSWORD }))
  approveOnlyClerk = createClient(env.call, await login(env.call, { email: 'b16-clerk-approve@local.test', password: PASSWORD }))

  productP1 = (await seedProduct(db, { entityId: 'b16-p1', name: 'B16 商品一', trackingMode: 'quantity' })).hardwareId
  productP2 = (await seedProduct(db, { entityId: 'b16-p2', name: 'B16 商品二', trackingMode: 'quantity' })).hardwareId
  productP3 = (await seedProduct(db, { entityId: 'b16-p3', name: 'B16 商品三', trackingMode: 'quantity' })).hardwareId
  productB = await seedProductAt(2, 'b16-p-b', '乙店商品')
})

after(async () => {
  await env?.dispose()
})

// ────────────────────────────── 鉴权与权限 ──────────────────────────────

test('未登录访问盘点接口被挡在鉴权之外（401）', async () => {
  const response = await env.call(countsPath(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'b16-unauth', lines: [] }),
  })
  assert.equal(response.status, 401)
})

test('没有任何权限的店员：录入被拒（403）', async () => {
  const { status, body } = await json(await clerk.post(countsPath(), {
    requestId: 'b16-deny-none',
    lines: [{ productRef: 'b16-p1', countedQty: 1 }],
  }))
  assert.equal(status, 403)
  assert.equal(body.error.code, 'PERMISSION_DENIED')
})

test('契约声明旧码 library/edit 映射到 inventory/count：旧码店员可录入', async () => {
  await seedAvailableStock({ productId: productP1, qty: 10, tag: 'legacy-base' })
  const { status, body } = await json(await legacyClerk.post(countsPath(), {
    requestId: 'b16-legacy-count',
    scope: { note: '旧码店员盘点' },
    lines: [{ productRef: 'b16-p1', countedQty: 10 }],
  }))
  assert.equal(status, 200, JSON.stringify(body))
  assert.equal(body.data.entityVersion, 1)
})

test('只有 inventory/count 的店员：能录入（200）', async () => {
  const { status } = await json(await countOnlyClerk.post(countsPath(), {
    requestId: 'b16-count-only',
    lines: [{ productRef: 'b16-p1', countedQty: 10 }],
  }))
  assert.equal(status, 200)
})

test('⚠️ 只有 inventory/count 的店员**不能批准**（403）：批准是另一个权限码', async () => {
  const countId = await scalar(`SELECT id FROM inventory_counts WHERE request_id = 'b16-count-only'`)
  const { status, body } = await json(await countOnlyClerk.post(approvePath(countId), {
    requestId: 'b16-count-only-approve',
    reason: '越权批准',
  }))
  assert.equal(status, 403)
  assert.equal(body.error.code, 'PERMISSION_DENIED')
  assert.equal(await scalar('SELECT status FROM inventory_counts WHERE id = ?', countId), 'draft')
})

test('⚠️ 旧码 library/edit **不能批准**：inventory/count-approve 是 owner_only（403）', async () => {
  const countId = await scalar(`SELECT id FROM inventory_counts WHERE request_id = 'b16-legacy-count'`)
  const { status, body } = await json(await legacyClerk.post(approvePath(countId), {
    requestId: 'b16-legacy-approve',
    reason: '旧宽权限想批准',
  }))
  assert.equal(status, 403)
  assert.equal(body.error.code, 'PERMISSION_DENIED')
  // 没有任何差异流水产生
  assert.equal(await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE source = 'count_adjustment'`), 0)
})

test('只有 inventory/count-approve 的店员：能批准，但不能录入（403）', async () => {
  const denied = await json(await approveOnlyClerk.post(countsPath(), {
    requestId: 'b16-approve-only-count',
    lines: [{ productRef: 'b16-p1', countedQty: 10 }],
  }))
  assert.equal(denied.status, 403)

  const countId = await scalar(`SELECT id FROM inventory_counts WHERE request_id = 'b16-count-only'`)
  const approved = await json(await approveOnlyClerk.post(approvePath(countId), {
    requestId: 'b16-approve-only-approve',
    reason: '实盘与账面一致，批准',
  }))
  assert.equal(approved.status, 200, JSON.stringify(approved.body))
  assert.equal(approved.body.data.entityVersion, 2)
})

test('GET 打两个盘点路径都报 405（只有 POST）', async () => {
  const listGet = await json(await a.get(countsPath()))
  assert.equal(listGet.status, 405)
  const approveGet = await json(await a.get(approvePath('whatever')))
  assert.equal(approveGet.status, 405)
})

// ────────────────────────────── 录入：不改库存 ──────────────────────────────

test('⚠️ 录入保存实盘**不改动库存**，只建草稿并锁存账面', async () => {
  await seedAvailableStock({ productId: productP2, qty: 7, tag: 'record-base' })
  const before = await readAvailable(productP2)
  assert.equal(before, 7)

  const { status, body } = await json(await a.post(countsPath(), {
    requestId: 'b16-record-1',
    scope: { asOf: '2026-09-22T01:00:00.000Z', note: '全店盘点' },
    note: '月末',
    lines: [{ productRef: 'b16-p2', countedQty: 10, note: '货架第三层，复核后盘盈三件' }],
  }))
  assert.equal(status, 200, JSON.stringify(body))
  assert.equal(body.data.entityId, 'b16-record-1::count')
  assert.equal(body.data.effects.stockTouched, false)

  // 库存分毫未动 —— 这是 B16 最重要的一条约束（02 §5）
  assert.equal(await readAvailable(productP2), 7)
  assert.equal(await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE product_id = ? AND source = 'count_adjustment'`, productP2), 0)

  // 草稿与锁存账面
  const count = await db.prepare(`SELECT status, as_of, scope_note, approved_reason FROM inventory_counts WHERE id = ?`)
    .bind('b16-record-1::count').first()
  assert.equal(count.status, 'draft')
  assert.equal(count.as_of, '2026-09-22T01:00:00.000Z')
  assert.equal(count.scope_note, '全店盘点')
  assert.equal(count.approved_reason, null)

  const line = await db.prepare(`SELECT book_qty, counted_qty, adjustment_movement_id FROM inventory_count_lines WHERE count_id = ?`)
    .bind('b16-record-1::count').first()
  assert.equal(line.book_qty, 7)
  assert.equal(line.counted_qty, 10)
  assert.equal(line.adjustment_movement_id, null)

  // 审计：实盘事实留痕，且明确标注未动库存
  const audit = await db.prepare(`SELECT actor_user_id, details FROM audit_logs WHERE action = 'inventory_count_record' AND entity_id = ?`)
    .bind('b16-record-1::count').first()
  assert.ok(audit, '应有 inventory_count_record 审计行')
  assert.equal(JSON.parse(audit.details).stockTouched, false)
  assert.ok(audit.actor_user_id > 0)
})

test('账面为 0 的商品也能盘（book_qty 记 0，不是「查不到就跳过」）', async () => {
  const { status } = await json(await a.post(countsPath(), {
    requestId: 'b16-record-zero',
    lines: [{ productRef: 'b16-p3', countedQty: 2 }],
  }))
  assert.equal(status, 200)
  assert.equal(
    await scalar(`SELECT book_qty FROM inventory_count_lines WHERE count_id = 'b16-record-zero::count'`),
    0,
  )
})

// ────────────────────────────── 批准：生成差异调整 ──────────────────────────────

test('批准盘盈（账面 7 → 实盘 10）：写 count_adjustment 入库流水，余额调整为 10', async () => {
  const { status, body } = await json(await a.post(approvePath('b16-record-1::count'), {
    requestId: 'b16-approve-gain-p2',
    reason: '重新清点货架，复核确认盘盈三件',
  }))
  assert.equal(status, 200, JSON.stringify(body))
  assert.equal(body.data.entityVersion, 2)

  const adjustment = await db
    .prepare(`SELECT qty, from_bucket, to_bucket, source FROM inventory_movements WHERE product_id = ? AND source = 'count_adjustment'`)
    .bind(productP2).first()
  assert.deepEqual(
    { qty: adjustment.qty, from: adjustment.from_bucket, to: adjustment.to_bucket, source: adjustment.source },
    { qty: 3, from: null, to: 'available', source: 'count_adjustment' },
  )

  // 恒等式：批准后余额 == 实盘数量
  assert.equal(await readAvailable(productP2), 10)
  assert.equal(await scalar(`SELECT status FROM inventory_counts WHERE id = 'b16-record-1::count'`), 'approved')
  assert.equal(
    await scalar(`SELECT adjustment_movement_id FROM inventory_count_lines WHERE count_id = 'b16-record-1::count'`),
    'b16-approve-gain-p2::count-adjustment::0',
  )

  // 审计：批准理由与逐行调整明细
  const audit = await db.prepare(`SELECT details FROM audit_logs WHERE action = 'inventory_count_approve' AND entity_id = ?`)
    .bind('b16-record-1::count').first()
  const details = JSON.parse(audit.details)
  assert.equal(details.reason, '重新清点货架，复核确认盘盈三件')
  assert.deepEqual(
    { book: details.adjustments[0].bookQty, counted: details.adjustments[0].countedQty, diff: details.adjustments[0].diffQty },
    { book: 7, counted: 10, diff: 3 },
  )
})

test('B39 暂缓：盘点结果减少账面库存时，B16 批准拒绝且不写调整流水', async () => {
  const created = await json(await a.post(countsPath(), {
    requestId: 'b16-loss-count',
    lines: [{ productRef: 'b16-p2', countedQty: 9 }],
  }))
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const before = await readAvailable(productP2)
  const approved = await json(await a.post(approvePath(created.body.data.entityId), {
    requestId: 'b16-loss-approve',
    reason: '复核实盘数量',
  }))
  assert.equal(approved.status, 400, JSON.stringify(approved.body))
  assert.match(approved.body.error.message, /B39.*B16/)
  assert.equal(await readAvailable(productP2), before)
  assert.equal(await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE request_id = 'b16-loss-approve'`), 0)
})

test('批准盘盈（账面 0 → 实盘 2）：余额增加，方向是入 available', async () => {
  const { status } = await json(await a.post(approvePath('b16-record-zero::count'), {
    requestId: 'b16-approve-gain',
    reason: '实盘多出 2 件，确认为漏记入库',
  }))
  assert.equal(status, 200)
  assert.equal(await readAvailable(productP3), 2)
  const adjustment = await db
    .prepare(`SELECT qty, from_bucket, to_bucket FROM inventory_movements WHERE product_id = ? AND source = 'count_adjustment'`)
    .bind(productP3).first()
  assert.deepEqual(
    { qty: adjustment.qty, from: adjustment.from_bucket, to: adjustment.to_bucket },
    { qty: 2, from: null, to: 'available' },
  )
})

test('零差异：不写任何流水，但不影响批准本身', async () => {
  // 前一条盘点批准后 productP2 余额 = 10。
  assert.equal(await readAvailable(productP2), 10)
  const created = await json(await a.post(countsPath(), {
    requestId: 'b16-record-zero-diff',
    lines: [{ productRef: 'b16-p2', countedQty: 10 }],
  }))
  assert.equal(created.status, 200)

  const beforeCount = await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE product_id = ? AND source = 'count_adjustment'`, productP2)
  const approved = await json(await a.post(approvePath('b16-record-zero-diff::count'), {
    requestId: 'b16-approve-zero-diff',
    reason: '账面与实盘一致',
  }))
  assert.equal(approved.status, 200, JSON.stringify(approved.body))
  assert.equal(await readAvailable(productP2), 10)
  assert.equal(
    await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE product_id = ? AND source = 'count_adjustment'`, productP2),
    beforeCount,
  )
  assert.equal(
    await scalar(`SELECT adjustment_movement_id FROM inventory_count_lines WHERE count_id = 'b16-record-zero-diff::count'`),
    null,
  )
})

// ────────────────────────────── 账面已变 / 重复批准 / 跨店 / 版本 / 幂等 ──────────────────────────────

test('⚠️ 批准时账面已被别的动作改过 → 409 VERSION_CONFLICT（要求重盘，不硬调）', async () => {
  await seedAvailableStock({ productId: productP3, qty: 5, tag: 'stale-base' })
  const countedQty = (await readAvailable(productP3)) + 2
  await json(await a.post(countsPath(), {
    requestId: 'b16-stale-count',
    lines: [{ productRef: 'b16-p3', countedQty }],
  }))
  const staleLine = await db.prepare(`SELECT book_qty, counted_qty FROM inventory_count_lines WHERE count_id = 'b16-stale-count::count'`).first()
  assert.ok(staleLine.counted_qty >= staleLine.book_qty, JSON.stringify(staleLine))
  // 录入之后，截止点以外的正常出入库把余额改了
  await seedAvailableStock({ productId: productP3, qty: 1, tag: 'stale-after' })
  const currentQty = await readAvailable(productP3)

  const { status, body } = await json(await a.post(approvePath('b16-stale-count::count'), {
    requestId: 'b16-stale-approve',
    reason: '拿旧账面硬调',
  }))
  assert.equal(status, 409, JSON.stringify(body))
  assert.equal(body.error.code, 'VERSION_CONFLICT')

  // 关键：没有生成任何调整流水，也仍是草稿
  assert.equal(await scalar(`SELECT status FROM inventory_counts WHERE id = 'b16-stale-count::count'`), 'draft')
  assert.equal(
    await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE request_id = 'b16-stale-approve'`),
    0,
  )
  assert.equal(await readAvailable(productP3), currentQty)
})

test('同一盘点单不能二次批准（不同 requestId）→ 409，且不重复调整', async () => {
  const before = await readAvailable(productP2)
  const { status, body } = await json(await a.post(approvePath('b16-record-1::count'), {
    requestId: 'b16-double-approve',
    reason: '再批一次',
  }))
  assert.equal(status, 409)
  assert.equal(body.error.code, 'VERSION_CONFLICT')
  assert.equal(await readAvailable(productP2), before)
})

test('跨店：别店的盘点单批准返回 404，且不落任何账', async () => {
  const { status, body } = await json(await b.post(approvePath('b16-record-1::count'), {
    requestId: 'b16-cross-store',
    reason: '越店批准',
  }))
  assert.equal(status, 404)
  assert.equal(body.error.code, 'ENTITY_NOT_FOUND')
  assert.equal(await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE request_id = 'b16-cross-store'`), 0)
})

test('跨店：录入他店商品返回 404', async () => {
  const { status, body } = await json(await a.post(countsPath(), {
    requestId: 'b16-cross-record',
    lines: [{ productRef: 'b16-p-b', countedQty: 1 }],
  }))
  assert.equal(status, 404)
  assert.equal(body.error.code, 'ENTITY_NOT_FOUND')
})

test('版本冲突：expectedVersion 与盘点单当前版本不符 → 409', async () => {
  await json(await a.post(countsPath(), {
    requestId: 'b16-version-count',
    lines: [{ productRef: 'b16-p1', countedQty: 10 }],
  }))
  const { status, body } = await json(await a.post(approvePath('b16-version-count::count'), {
    requestId: 'b16-version-approve',
    reason: '拿了过期的版本',
    expectedVersion: 9,
  }))
  assert.equal(status, 409)
  assert.equal(body.error.code, 'VERSION_CONFLICT')
  assert.equal(await scalar(`SELECT status FROM inventory_counts WHERE id = 'b16-version-count::count'`), 'draft')
})

test('幂等：同一 requestId 重放返回原结果，不重复调整', async () => {
  await seedAvailableStock({ productId: productP1, qty: 20, tag: 'idem-base' })
  const initialQty = await readAvailable(productP1)
  const countedQty = initialQty + 1
  const payload = {
    requestId: 'b16-idem-count',
    scope: { note: '幂等盘点' },
    lines: [{ productRef: 'b16-p1', countedQty }],
  }
  const first = await json(await a.post(countsPath(), payload))
  const second = await json(await a.post(countsPath(), payload))
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(second.status, 200, JSON.stringify(second.body))
  assert.equal(second.body.data.entityId, first.body.data.entityId)
  // 只建一张盘点单、只锁一行
  assert.equal(await scalar(`SELECT COUNT(*) FROM inventory_counts WHERE request_id = 'b16-idem-count'`), 1)
  const idemLine = await db.prepare(`SELECT book_qty, counted_qty FROM inventory_count_lines WHERE count_id = 'b16-idem-count::count'`).first()
  assert.ok(idemLine.counted_qty >= idemLine.book_qty, JSON.stringify(idemLine))

  // 批准同样幂等 —— 必须复用同一个 requestId 字符串（否则等于没验幂等）
  const approvePayload = { requestId: 'b16-idem-approve', reason: '幂等批准' }
  const approve1 = await json(await a.post(approvePath('b16-idem-count::count'), approvePayload))
  const approve2 = await json(await a.post(approvePath('b16-idem-count::count'), approvePayload))
  assert.equal(approve1.status, 200, JSON.stringify(approve1.body))
  assert.equal(approve2.status, 200, JSON.stringify(approve2.body))
  assert.equal(approve2.body.data.entityVersion, approve1.body.data.entityVersion)
  assert.equal(
    await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE request_id = 'b16-idem-approve' AND source = 'count_adjustment'`),
    1,
  )
  assert.equal(await readAvailable(productP1), countedQty)
  assert.equal(await scalar(`SELECT version FROM inventory_counts WHERE id = 'b16-idem-count::count'`), 2)
})

// ────────────────────────────── 入参校验 ──────────────────────────────

test('录入校验：空 lines / 负数量 / 缺 productRef / 同一商品重复 → 400', async () => {
  const cases = [
    { lines: [], why: 'lines 为空' },
    { lines: [{ productRef: 'b16-p1', countedQty: -1 }], why: '实盘为负' },
    { lines: [{ countedQty: 1 }], why: '缺 productRef' },
    { lines: [{ productRef: 'b16-p1', countedQty: 1 }, { productRef: 'b16-p1', countedQty: 2 }], why: '同一商品两行' },
    { lines: [{ productRef: 'b16-p1', countedQty: 1.5 }], why: '实盘不是整数' },
  ]
  for (const [index, probe] of cases.entries()) {
    const { status, body } = await json(await a.post(countsPath(), { requestId: `b16-badinput-${index}`, lines: probe.lines }))
    assert.equal(status, 400, `${probe.why} 应被拒：${JSON.stringify(body)}`)
    assert.equal(body.error.code, 'VALIDATION_ERROR')
  }
})

test('录入：缺少 requestId → 400', async () => {
  const { status, body } = await json(await a.post(countsPath(), { lines: [{ productRef: 'b16-p1', countedQty: 1 }] }))
  assert.equal(status, 400)
  assert.equal(body.error.code, 'VALIDATION_ERROR')
})

test('批准校验：理由为空 → 400', async () => {
  const { status, body } = await json(await a.post(approvePath('b16-version-count::count'), {
    requestId: 'b16-badreason',
    reason: '   ',
  }))
  assert.equal(status, 400)
  assert.equal(body.error.code, 'VALIDATION_ERROR')
})

test('批准：盘点单不存在 → 404', async () => {
  const { status, body } = await json(await a.post(approvePath('no-such-count'), {
    requestId: 'b16-missing-count',
    reason: '随便',
  }))
  assert.equal(status, 404)
  assert.equal(body.error.code, 'ENTITY_NOT_FOUND')
})

test('B16 并发批准同一盘点单只写一组差异流水', async () => {
  const product = await seedProduct(db, { entityId: 'b16-approve-race', name: 'B16 并发批准件', trackingMode: 'quantity' })
  await seedAvailableStock({ productId: product.hardwareId, qty: 5, tag: 'approve-race' })
  const saved = await json(await a.post(countsPath(), {
    requestId: 'b16-approve-race-count',
    lines: [{ productRef: product.entityId, countedQty: 6 }],
  }))
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const countId = saved.body.data.entityId
  const raceLine = await db.prepare(`SELECT book_qty, counted_qty FROM inventory_count_lines WHERE count_id = ?`).bind(countId).first()
  assert.ok(raceLine.counted_qty >= raceLine.book_qty, JSON.stringify(raceLine))

  const [left, right] = await Promise.all([
    a.post(approvePath(countId), { requestId: 'b16-approve-race-left', reason: '并发批准 A', expectedVersion: 1 }).then(json),
    a.post(approvePath(countId), { requestId: 'b16-approve-race-right', reason: '并发批准 B', expectedVersion: 1 }).then(json),
  ])
  const results = [left, right]
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409])
  assert.equal(results.find((result) => result.status === 409).body.error.code, 'VERSION_CONFLICT')
  assert.equal(await readAvailable(product.hardwareId), 6)
  assert.equal(await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE product_id = ? AND source = 'count_adjustment'`, product.hardwareId), 1)
})
