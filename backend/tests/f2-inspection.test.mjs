/**
 * F2 · 隔离件判定 B19 的 HTTP 接线（POST /api/v2/inventory/items/:id/inspection）。
 *
 * 契约依据：
 *   actions.json  B19（权限 inventory/inspection，inputs result/findings/evidence/disposition，
 *                     errors INSPECTION_REQUIRED / OWNERSHIP_INVALID / VERSION_CONFLICT）
 *   enums.json    InspectionResult（pass/fail）
 *                 inventoryBucketRules.transitions（quarantine→available、quarantine→retired）
 *   objects.json  StockItem（inspectionRef / version）、AuditEvent（检查事实落地）
 *
 * 覆盖：
 *   1. 入口层：鉴权、权限（新码 inventory/inspection 与旧码 library/edit 等价）、405；
 *   2. 放行：quarantine → available，写 inspection_release 流水，余额守恒（不新增在库总量）；
 *   3. 报废：quarantine → retired，可卖库存分毫不动（不重新进入可卖库存）；
 *   4. 证据门槛：放行必须带服务端已实测的有效附件，缺证据 / 假证据一律拒绝；
 *   5. 重复判定：同一实物不能判两次（状态闸门）；
 *   6. 跨店 404、版本冲突 409、幂等重放、处置值非法 400、来源无关（采购待检 / 回收拆件）。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'
import { seedProduct } from './lib/inventory.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER_A = { email: 'f2-owner-a@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: '待检门店甲' }
const OWNER_B = { email: 'f2-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: '待检门店乙' }

let env
let db
let a
let b
/** 无任何权限的店员（门店甲） */
let clerk
/** 只有旧码 library/view + library/edit 的店员（门店甲） */
let legacyClerk
/** 只有 inventory/item-view 的店员（门店甲） */
let viewOnlyClerk

const json = async (response) => ({ status: response.status, body: await response.json() })

const scalar = async (sql, ...params) => {
  const row = await db.prepare(sql).bind(...params).first()
  return row ? Object.values(row)[0] : null
}

const readBalance = (productId, storeId = 1) =>
  db
    .prepare(
      `SELECT available_qty, reserved_qty, quarantine_qty FROM stock_balances
       WHERE store_id = ? AND product_id = ? AND location_id = 'store'`,
    )
    .bind(storeId, productId)
    .first()

/** 播一个店员，并按需要授予权限码（生产 permissions 表无种子迁移，这里显式建行）。 */
async function seedClerk({ userId, email, storeId = 1, permissions = [], owner = 1 }) {
  await db.prepare(`INSERT INTO users (id, email, password_hash, status) VALUES (?, ?, ?, 'active')`)
    .bind(userId, email, await legacyPasswordHash(PASSWORD)).run()
  const member = await db.prepare(`INSERT INTO store_members (store_id, user_id, status, is_owner, created_by, updated_by)
    VALUES (?, ?, 'active', 0, ?, ?)`).bind(storeId, userId, owner, owner).run()
  const memberId = member.meta.last_row_id
  if (permissions.length) {
    const role = await db.prepare('INSERT INTO roles (store_id, code, name) VALUES (?, ?, ?)')
      .bind(storeId, `role-f2-${userId}`, `角色 ${userId}`).run()
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

/** 播一个指定门店的商品（lib 的 seedProduct 固定 store 1，跨店用例要自己播）。 */
async function seedProductAt(storeId, entityId, { trackingMode = 'item', name } = {}) {
  await db
    .prepare(
      `INSERT INTO hardware
         (user_id, store_id, category, name, entity_id, sku, tracking_mode, requires_sn,
          is_serialized, status, default_price_cents, item_type, version)
       VALUES (1, ?, '测试分类', ?, ?, NULL, ?, ?, ?, 'active', 0, 'product', 1)`,
    )
    .bind(storeId, name ?? entityId, entityId, trackingMode, trackingMode === 'item' ? 1 : 0, trackingMode === 'item' ? 1 : 0)
    .run()
  return scalar('SELECT id FROM hardware WHERE store_id = ? AND entity_id = ?', storeId, entityId)
}

/**
 * 播一件**在 quarantine** 的店有实物。必须走库存流水让 0007 触发器维护余额。
 * `source` 只为贴近不同来源（采购待检 / 回收拆件 / 退货），B19 本身不看来源 —— 这正是要验证的。
 */
async function seedQuarantineItem({ id, storeId = 1, productId, assetCode, source = 'purchase_receipt', fromBucket = 'in_transit' }) {
  const normalized = `SN-${assetCode}`
  await db.prepare(
    `INSERT INTO stock_items
       (id, store_id, product_id, asset_code, condition, ownership, availability, location,
        sn_raw, sn_normalized, acquisition_cost_cents, cost_known, version)
     VALUES (?, ?, ?, ?, 'used', 'store', 'quarantine', 'store', ?, ?, 50000, 1, 1)`,
  ).bind(id, storeId, productId, assetCode, normalized, normalized).run()
  await db.prepare(
    `INSERT INTO inventory_movements
       (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
        source, occurred_at, actor_user_id, request_id)
     VALUES (?, ?, ?, ?, 1, ?, 'quarantine', 50000, ?, ?, 1, ?)`,
  ).bind(`${id}::seed`, storeId, productId, id, fromBucket, source, new Date().toISOString(), `${id}::seed-req`).run()
  return id
}

/**
 * 播一条附件。uploadState='attached' 时按 0022 的 CHECK 必须齐备 sha256/byte_size/content_type，
 * 且必须带 owner（business 只能关联上传完成的文件）。这就是 B19 认的「服务端已实测」证据。
 */
async function seedAttachment({ id, storeId = 1, uploadState = 'attached', ownerType = 'stock_item', ownerId }) {
  const measured = uploadState === 'uploaded' || uploadState === 'attached'
  const ownerOk = uploadState === 'pending' || uploadState === 'uploaded' || uploadState === 'attached'
  await db.prepare(
    `INSERT INTO attachments
       (id, store_id, upload_state, purpose, visibility, object_key, declared_mime, declared_byte_size,
        content_type, byte_size, sha256, owner_entity_type, owner_entity_id,
        upload_token_hash, expires_at, created_by, request_id)
     VALUES (?, ?, ?, 'recovery_evidence', 'internal', ?, 'image/png', 1024, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).bind(
    id,
    storeId,
    uploadState,
    `attachments/store-${storeId}/${id}.png`,
    measured ? 'image/png' : null,
    measured ? 1024 : null,
    measured ? 'a'.repeat(64) : null,
    ownerOk ? ownerType : null,
    ownerOk ? ownerId : null,
    `hash-${id}`,
    new Date(Date.now() + 3_600_000).toISOString(),
    `${id}::req`,
  ).run()
  return id
}

function inspectionPath(itemId) {
  return `/api/v2/inventory/items/${encodeURIComponent(itemId)}/inspection`
}

let productA
let productB

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER_A)
  await seedOwner(db, OWNER_B)
  await seedClerk({ userId: 3, email: 'f2-clerk-none@local.test' })
  await seedClerk({ userId: 4, email: 'f2-clerk-legacy@local.test', permissions: ['library/view', 'library/edit'] })
  await seedClerk({ userId: 5, email: 'f2-clerk-view@local.test', permissions: ['inventory/item-view'] })

  a = createClient(env.call, await login(env.call, OWNER_A))
  b = createClient(env.call, await login(env.call, OWNER_B))
  clerk = createClient(env.call, await login(env.call, { email: 'f2-clerk-none@local.test', password: PASSWORD }))
  legacyClerk = createClient(env.call, await login(env.call, { email: 'f2-clerk-legacy@local.test', password: PASSWORD }))
  viewOnlyClerk = createClient(env.call, await login(env.call, { email: 'f2-clerk-view@local.test', password: PASSWORD }))

  const created = await seedProduct(db, { entityId: 'f2-laptop', name: 'F2 待检笔记本', trackingMode: 'item' })
  productA = created.hardwareId
  productB = await seedProductAt(2, 'f2-laptop-b', { name: '乙店待检笔记本' })
})

after(async () => {
  await env?.dispose()
})

// ────────────────────────────── 鉴权与权限 ──────────────────────────────

test('未登录访问判定接口被挡在鉴权之外（401）', async () => {
  const response = await env.call(inspectionPath('whatever'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: 'pass', findings: 'x', disposition: 'retired', expectedVersion: 1, requestId: 'f2-unauth' }),
  })
  assert.equal(response.status, 401)
})

test('没有任何权限的店员：判定被拒（403）', async () => {
  const { status, body } = await json(await clerk.post(inspectionPath('whatever'), {
    result: 'pass', findings: '越权', disposition: 'retired', expectedVersion: 1, requestId: 'f2-deny-none',
  }))
  assert.equal(status, 403)
  assert.equal(body.error.code, 'PERMISSION_DENIED')
})

test('只有读权限（inventory/item-view）不能判定（403）', async () => {
  const { status } = await json(await viewOnlyClerk.post(inspectionPath('whatever'), {
    result: 'pass', findings: '只有读权', disposition: 'retired', expectedVersion: 1, requestId: 'f2-deny-view',
  }))
  assert.equal(status, 403)
})

test('契约声明旧码 library/edit 映射到 inventory/inspection，旧码店员可判定', async () => {
  const itemId = await seedQuarantineItem({ id: 'si-f2-legacy', productId: productA, assetCode: 'AC-F2-LEGACY' })
  const { status, body } = await json(await legacyClerk.post(inspectionPath(itemId), {
    result: 'fail', findings: '旧码店员判定报废', disposition: 'retired', expectedVersion: 1, requestId: 'f2-legacy-ok',
  }))
  assert.equal(status, 200, JSON.stringify(body))
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId), 'retired')
})

test('GET 打判定接口报 405（只有 POST 是判定）', async () => {
  const { status } = await json(await a.get(inspectionPath('si-f2-legacy')))
  assert.equal(status, 405)
})

// ────────────────────────────── 放行（quarantine → available） ──────────────────────────────

test('放行：quarantine → available，写 inspection_release 流水，在库总量不变', async () => {
  const itemId = await seedQuarantineItem({ id: 'si-f2-pass', productId: productA, assetCode: 'AC-F2-PASS' })
  await seedAttachment({ id: 'att-f2-pass', ownerId: itemId })

  const beforeBalance = await readBalance(productA)
  assert.equal(beforeBalance.quarantine_qty, 1)
  assert.equal(beforeBalance.available_qty, 0)

  const { status, body } = await json(await a.post(inspectionPath(itemId), {
    result: 'pass',
    findings: '点亮正常，屏幕无坏点，键盘背光正常',
    evidence: ['att-f2-pass'],
    disposition: 'available',
    expectedVersion: 1,
    requestId: 'f2-pass-1',
  }))
  assert.equal(status, 200, JSON.stringify(body))
  assert.equal(body.data.effects.fromBucket, 'quarantine')
  assert.equal(body.data.effects.toBucket, 'available')
  assert.equal(body.data.entityVersion, 2)

  // 实物状态 + 检查引用回填
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId), 'available')
  const ref = await scalar('SELECT inspection_ref FROM stock_items WHERE id = ?', itemId)
  assert.equal(ref, 'f2-pass-1::inspection')

  // 流水：source=inspection_release，from quarantine → to available
  const movement = await db
    .prepare(`SELECT from_bucket, to_bucket, source, qty FROM inventory_movements WHERE stock_item_id = ? AND source = 'inspection_release'`)
    .bind(itemId)
    .first()
  assert.deepEqual(
    { from: movement.from_bucket, to: movement.to_bucket, source: movement.source, qty: movement.qty },
    { from: 'quarantine', to: 'available', source: 'inspection_release', qty: 1 },
  )

  // 余额守恒：待处理 -1、可卖 +1，自有在库总量不变
  const afterBalance = await readBalance(productA)
  assert.equal(afterBalance.available_qty, 1)
  assert.equal(afterBalance.quarantine_qty, 0)
  const onHandBefore = beforeBalance.available_qty + beforeBalance.reserved_qty + beforeBalance.quarantine_qty
  const onHandAfter = afterBalance.available_qty + afterBalance.reserved_qty + afterBalance.quarantine_qty
  assert.equal(onHandAfter, onHandBefore)
})

test('检查事实写入审计：findings / evidence / result / 操作人可追溯', async () => {
  const audit = await db
    .prepare(`SELECT actor_user_id, entity_type, entity_id, details FROM audit_logs WHERE action = 'stock_inspection' AND entity_id = 'si-f2-pass'`)
    .first()
  assert.ok(audit, '应有 stock_inspection 审计行')
  const details = JSON.parse(audit.details)
  assert.equal(details.result, 'pass')
  assert.equal(details.disposition, 'available')
  assert.deepEqual(details.evidence, ['att-f2-pass'])
  assert.match(details.findings, /点亮正常/)
  assert.ok(audit.actor_user_id > 0)
})

// ────────────────────────────── 报废（quarantine → retired） ──────────────────────────────

test('报废：quarantine → retired，可卖库存分毫不动（不重新进入可卖库存）', async () => {
  const itemId = await seedQuarantineItem({ id: 'si-f2-scrap', productId: productA, assetCode: 'AC-F2-SCRAP' })
  const beforeBalance = await readBalance(productA)

  const { status, body } = await json(await a.post(inspectionPath(itemId), {
    result: 'fail',
    findings: '主板进水腐蚀，无维修价值',
    disposition: 'retired',
    expectedVersion: 1,
    requestId: 'f2-scrap-1',
  }))
  assert.equal(status, 200, JSON.stringify(body))
  assert.equal(body.data.effects.toBucket, 'retired')

  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId), 'retired')
  assert.equal(
    await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE stock_item_id = ? AND source = 'inspection_release' AND to_bucket = 'retired'`, itemId),
    1,
  )

  const afterBalance = await readBalance(productA)
  // 关键：报废不增加可卖库存，待处理减少
  assert.equal(afterBalance.available_qty, beforeBalance.available_qty)
  assert.equal(afterBalance.quarantine_qty, beforeBalance.quarantine_qty - 1)
})

// ────────────────────────────── 证据门槛 ──────────────────────────────

test('放行但没有任何附件 → 422 INSPECTION_REQUIRED（不能没有证据强行通过）', async () => {
  const itemId = await seedQuarantineItem({ id: 'si-f2-noev', productId: productA, assetCode: 'AC-F2-NOEV' })
  const { status, body } = await json(await a.post(inspectionPath(itemId), {
    result: 'pass',
    findings: '看起来没问题',
    evidence: [],
    disposition: 'available',
    expectedVersion: 1,
    requestId: 'f2-noev-1',
  }))
  assert.equal(status, 422)
  assert.equal(body.error.code, 'INSPECTION_REQUIRED')
  // 没有通过 → 实物仍待在待检，未落账
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId), 'quarantine')
  assert.equal(await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE stock_item_id = ?`, itemId), 1)
})

test('证据附件不存在 / 未完成上传 / 不属于本件 → 一律拒绝', async () => {
  const itemId = await seedQuarantineItem({ id: 'si-f2-badev', productId: productA, assetCode: 'AC-F2-BADEV' })
  const otherItemId = await seedQuarantineItem({ id: 'si-f2-badev-other', productId: productA, assetCode: 'AC-F2-BADEV-OTHER' })
  await seedAttachment({ id: 'att-f2-badev-foreign', ownerId: otherItemId })

  const cases = [
    { evidence: ['att-f2-does-not-exist'], why: '附件不存在' },
    { evidence: ['att-f2-badev-foreign'], why: '附件挂在别的实物上' },
  ]
  for (const [index, probe] of cases.entries()) {
    const { status, body } = await json(await a.post(inspectionPath(itemId), {
      result: 'pass',
      findings: `假证据：${probe.why}`,
      evidence: probe.evidence,
      disposition: 'available',
      expectedVersion: 1,
      requestId: `f2-badev-${index}`,
    }))
    assert.equal(status, 422, `${probe.why} 应被拒`)
    assert.equal(body.error.code, 'INSPECTION_REQUIRED')
  }
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId), 'quarantine')

  // 未完成上传（pending）的附件同样不作数
  await seedAttachment({ id: 'att-f2-pending', ownerId: itemId, uploadState: 'pending' })
  const pending = await json(await a.post(inspectionPath(itemId), {
    result: 'pass',
    findings: '引用了还在上传中的附件',
    evidence: ['att-f2-pending'],
    disposition: 'available',
    expectedVersion: 1,
    requestId: 'f2-badev-pending',
  }))
  assert.equal(pending.status, 422)
  assert.equal(pending.body.error.code, 'INSPECTION_REQUIRED')

  // 别店附件也不认（同 id 跨店）
  await seedAttachment({ id: 'att-f2-otherstore', storeId: 2, ownerId: otherItemId })
  const crossStoreEvidence = await json(await a.post(inspectionPath(itemId), {
    result: 'pass',
    findings: '引用了别店的附件',
    evidence: ['att-f2-otherstore'],
    disposition: 'available',
    expectedVersion: 1,
    requestId: 'f2-badev-otherstore',
  }))
  assert.equal(crossStoreEvidence.status, 422)
})

test('报废不强制附件，但一旦引用假证据同样被拒', async () => {
  const itemId = await seedQuarantineItem({ id: 'si-f2-scrap-badev', productId: productA, assetCode: 'AC-F2-SCRAP-BADEV' })
  const bad = await json(await a.post(inspectionPath(itemId), {
    result: 'fail',
    findings: '进水报废，附了一张不存在的图',
    evidence: ['att-f2-nope'],
    disposition: 'retired',
    expectedVersion: 1,
    requestId: 'f2-scrap-badev',
  }))
  assert.equal(bad.status, 422)
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId), 'quarantine')
})

// ────────────────────────────── 重复判定 / 跨店 / 版本 / 幂等 ──────────────────────────────

test('同一实物不能重复判定：已放行的件再判 → 422', async () => {
  const repeated = await json(await a.post(inspectionPath('si-f2-pass'), {
    result: 'pass',
    findings: '想再判一次',
    disposition: 'available',
    expectedVersion: 2,
    requestId: 'f2-repeat-1',
  }))
  assert.equal(repeated.status, 422)
  assert.equal(repeated.body.error.code, 'INSPECTION_REQUIRED')
  // 状态与流水都没被第二次请求改动
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', 'si-f2-pass'), 'available')
  assert.equal(await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE stock_item_id = 'si-f2-pass' AND source = 'inspection_release'`), 1)
})

test('跨店：别店的实物判定返回 404，且不落任何账', async () => {
  const foreign = await seedQuarantineItem({ id: 'si-f2-cross-b', storeId: 2, productId: productB, assetCode: 'AC-F2-CROSS-B' })
  const { status, body } = await json(await a.post(inspectionPath(foreign), {
    result: 'pass',
    findings: '越店判定',
    disposition: 'available',
    expectedVersion: 1,
    requestId: 'f2-cross-store',
  }))
  assert.equal(status, 404)
  assert.equal(body.error.code, 'ENTITY_NOT_FOUND')
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', foreign), 'quarantine')
  assert.equal(await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE stock_item_id = ? AND request_id = ?`, foreign, 'f2-cross-store'), 0)
})

test('版本冲突：expectedVersion 与实物当前版本不符 → 409', async () => {
  const itemId = await seedQuarantineItem({ id: 'si-f2-version', productId: productA, assetCode: 'AC-F2-VERSION' })
  await seedAttachment({ id: 'att-f2-version', ownerId: itemId })
  const { status, body } = await json(await a.post(inspectionPath(itemId), {
    result: 'pass',
    findings: '拿了过期的版本',
    evidence: ['att-f2-version'],
    disposition: 'available',
    expectedVersion: 7,
    requestId: 'f2-version-1',
  }))
  assert.equal(status, 409)
  assert.equal(body.error.code, 'VERSION_CONFLICT')
  assert.equal(body.error.currentVersion, 1)
  assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', itemId), 'quarantine')
})

test('幂等：同 requestId 重放返回原结果，不重复落账', async () => {
  const itemId = await seedQuarantineItem({ id: 'si-f2-idem', productId: productA, assetCode: 'AC-F2-IDEM' })
  await seedAttachment({ id: 'att-f2-idem', ownerId: itemId })
  const payload = {
    result: 'pass',
    findings: '幂等放行',
    evidence: ['att-f2-idem'],
    disposition: 'available',
    expectedVersion: 1,
    requestId: 'f2-idem-1',
  }
  const first = await json(await a.post(inspectionPath(itemId), payload))
  const second = await json(await a.post(inspectionPath(itemId), payload))
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(second.status, 200, JSON.stringify(second.body))
  assert.equal(second.body.data.entityVersion, first.body.data.entityVersion)
  // 只落一条流水，version 只推进一次
  assert.equal(await scalar(`SELECT COUNT(*) FROM inventory_movements WHERE stock_item_id = ? AND source = 'inspection_release'`, itemId), 1)
  assert.equal(await scalar('SELECT version FROM stock_items WHERE id = ?', itemId), 2)
})

// ────────────────────────────── 入参校验 ──────────────────────────────

test('disposition 只能是 available / retired（其余值 400）', async () => {
  const itemId = await seedQuarantineItem({ id: 'si-f2-baddisp', productId: productA, assetCode: 'AC-F2-BADDISP' })
  for (const disposition of ['sold', 'quarantine', 'reserved', 'in_transit']) {
    const { status, body } = await json(await a.post(inspectionPath(itemId), {
      result: 'pass', findings: '非法处置', disposition, expectedVersion: 1, requestId: `f2-baddisp-${disposition}`,
    }))
    assert.equal(status, 400, `${disposition} 应被拒`)
    assert.equal(body.error.code, 'VALIDATION_ERROR')
  }
})

test('findings 为空 / result 非法 → 400', async () => {
  const itemId = await seedQuarantineItem({ id: 'si-f2-badinput', productId: productA, assetCode: 'AC-F2-BADINPUT' })
  const emptyFindings = await json(await a.post(inspectionPath(itemId), {
    result: 'pass', findings: '   ', disposition: 'retired', expectedVersion: 1, requestId: 'f2-badinput-1',
  }))
  assert.equal(emptyFindings.status, 400)
  const badResult = await json(await a.post(inspectionPath(itemId), {
    result: 'maybe', findings: '结论不合法', disposition: 'retired', expectedVersion: 1, requestId: 'f2-badinput-2',
  }))
  assert.equal(badResult.status, 400)
})

// ────────────────────────────── 来源无关 ──────────────────────────────

test('判定不看来源：回收拆件 / 采购待检 / 退货待处理的隔离件都能放行', async () => {
  const sources = [
    { id: 'si-f2-src-recovery', assetCode: 'AC-F2-SRC-REC', source: 'conversion', fromBucket: null, attachment: 'att-f2-src-recovery' },
    { id: 'si-f2-src-purchase', assetCode: 'AC-F2-SRC-PUR', source: 'purchase_receipt', fromBucket: 'in_transit', attachment: 'att-f2-src-purchase' },
    { id: 'si-f2-src-return', assetCode: 'AC-F2-SRC-RET', source: 'return_receipt', fromBucket: null, attachment: 'att-f2-src-return' },
  ]
  for (const entry of sources) {
    await seedQuarantineItem({ id: entry.id, productId: productA, assetCode: entry.assetCode, source: entry.source, fromBucket: entry.fromBucket })
    await seedAttachment({ id: entry.attachment, ownerId: entry.id })
    const { status, body } = await json(await a.post(inspectionPath(entry.id), {
      result: 'pass',
      findings: `${entry.source} 来源的隔离件验机通过`,
      evidence: [entry.attachment],
      disposition: 'available',
      expectedVersion: 1,
      requestId: `f2-src-${entry.source}`,
    }))
    assert.equal(status, 200, `${entry.source} 应能放行：${JSON.stringify(body)}`)
    assert.equal(await scalar('SELECT availability FROM stock_items WHERE id = ?', entry.id), 'available')
  }
})
