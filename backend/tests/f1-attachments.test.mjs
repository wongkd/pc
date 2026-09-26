/**
 * F1 · 附件基础（B35）的 HTTP 接线（/api/v2/attachments*）。
 *
 * 契约依据：
 *   actions.json B35（POST /attachments/upload-intents、PUT /attachments/upload-intents/:id/blob、
 *                    POST /attachments/upload-intents/:id/complete，权限 attachment/upload）
 *   objects.json Attachment（ownerEntityRef / purpose / objectKey / contentType / byteSize / sha256 /
 *                            uploadState / visibility）
 *   enums.json   AttachmentPurpose / AttachmentUploadState / AttachmentVisibility
 *
 * 覆盖：
 *   1. 鉴权：无权限店员 403；旧码 library/edit 可上传（legacySource 兼容）；
 *   2. 签发意图：成功返回凭证与保留期，同 requestId 重放复用同一附件（不重复建行）；
 *   3. 签发校验：非法 purpose / 非法 mime / 超限大小 / 归属对象不存在 / 归属对象跨店 → 400；
 *   4. 写入字节：服务端实算 sha256 与真实 mime，声明与实际不符即拒绝并置 failed；
 *   5. 完整性：sha256 与签发声明不符 → 400；请求头 Content-Type 不符 → 400；
 *   6. 凭证：缺少或错误的上传凭证 → 403；
 *   7. 完成确认：uploaded → attached；未上传字节直接完成 → 400；
 *   8. 重复完成保护：同 requestId 幂等复用；不同 requestId 同归属幂等返回；改挂别处 → 409；
 *   9. 已 attached 后再写字节 → 409（内容不可覆盖）；
 *  10. 跨店隔离：别店用户读写本店附件 → 404；
 *  11. 孤立上传：超过保留期未关联的行在下次签发时被回收为 orphaned，对象一并删除；
 *  12. 存储标注：无 R2 绑定时返回 storageKind=memory / storagePersistent=false（测试替身，
 *      不是生产存储）；customerShareable 恒为 false（顾客端对外依赖备案域名，尚未就绪）。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'
import { seedProduct } from './lib/inventory.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER = { email: 'f1-owner@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: '装机门店' }
const OWNER_B = { email: 'f1-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: '别家门店' }

const ITEM_A = 'f1-item-a'
const ITEM_B = 'f1-item-b'

let env
let db
let a
let b
let clerk
let legacyClerk

const json = async (response) => ({ status: response.status, body: await response.json() })
const reqId = (tag) => `f1-${tag}-${randomUUID()}`
const sha256 = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex')

/** 造一段「文件头是 PNG」的字节。本系统只按魔数判类型，不做图片解码。 */
function pngBytes(payload = 48) {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const bytes = new Uint8Array(head.length + payload)
  bytes.set(head, 0)
  for (let i = head.length; i < bytes.length; i++) bytes[i] = (i * 7) % 251
  return bytes
}

/** 造一段「文件头是 JPEG」的字节，用于「声明 PNG 实际是 JPEG」的比对用例。 */
function jpegBytes(payload = 32) {
  const head = [0xff, 0xd8, 0xff, 0xe0]
  const bytes = new Uint8Array(head.length + payload)
  bytes.set(head, 0)
  for (let i = head.length; i < bytes.length; i++) bytes[i] = (i * 11) % 241
  return bytes
}

async function seedClerk({ userId, email, permissions = [] }) {
  await db
    .prepare(`INSERT INTO users (id, email, password_hash, status) VALUES (?, ?, ?, 'active')`)
    .bind(userId, email, await legacyPasswordHash(PASSWORD))
    .run()
  const member = await db
    .prepare(
      `INSERT INTO store_members (store_id, user_id, status, is_owner, created_by, updated_by)
       VALUES (1, ?, 'active', 0, 1, 1)`,
    )
    .bind(userId)
    .run()
  const memberId = member.meta.last_row_id
  if (permissions.length) {
    const role = await db
      .prepare('INSERT INTO roles (store_id, code, name) VALUES (1, ?, ?)')
      .bind(`role-${userId}`, `角色 ${userId}`)
      .run()
    for (const code of permissions) {
      await db.prepare('INSERT OR IGNORE INTO permissions (code, name) VALUES (?, ?)').bind(code, code).run()
      const permission = await db.prepare('SELECT id FROM permissions WHERE code = ?').bind(code).first()
      await db
        .prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)')
        .bind(role.meta.last_row_id, permission.id)
        .run()
    }
    await db.prepare('INSERT INTO member_roles (member_id, role_id) VALUES (?, ?)').bind(memberId, role.meta.last_row_id).run()
  }
  return { email, password: PASSWORD, memberId }
}

/** 播一件自有在库实物，作为附件的归属对象（B19 将来也要往实物上挂检测证据）。 */
async function seedStockItem({ id, entityId, storeId }) {
  const targetDb = db
  const product = await seedProduct(targetDb, { entityId, trackingMode: 'item', requiresSn: 1 })
  await targetDb
    .prepare(
      `INSERT INTO stock_items
         (id, store_id, product_id, asset_code, condition, ownership, availability, location, cost_known, created_by)
       VALUES (?, ?, ?, ?, 'new', 'store', 'available', 'store', 0, 1)`,
    )
    .bind(id, storeId, product.hardwareId, `AC-${id}`)
    .run()
}

/** 走完整链路：签发 → 写字节 → 完成确认。返回 name / 响应。 */
async function uploadAndAttach(client, { ownerEntityType = 'stock_item', ownerEntityId = ITEM_A, purpose = 'service_intake', bytes = pngBytes(), tag = 'ok' } = {}) {
  const intentRes = await client.post('/api/v2/attachments/upload-intents', {
    requestId: reqId(`${tag}-intent`),
    ownerEntityType,
    ownerEntityId,
    purpose,
    mime: 'image/png',
    byteSize: bytes.byteLength,
    sha256: sha256(bytes),
  })
  const intent = await json(intentRes)
  assert.equal(intent.status, 200, JSON.stringify(intent.body))
  const { entityId, uploadToken } = intent.body.data

  const putRes = await client.putRaw(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/blob`, bytes, {
    'X-Upload-Token': uploadToken,
    'Content-Type': 'image/png',
  })
  const put = await json(putRes)

  const completeRequestId = reqId(`${tag}-complete`)
  const completeRes = await client.post(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/complete`, {
    requestId: completeRequestId,
  })
  const complete = await json(completeRes)
  return { entityId, uploadToken, intent: intent.body, completeRequestId, put, complete }
}

before(async () => {
  env = await createWorkerEnv({ migrations: true })
  db = env.db
  await seedOwner(db, OWNER)
  await seedOwner(db, OWNER_B)
  await seedStockItem({ id: ITEM_A, entityId: 'F1-PRODUCT-A', storeId: 1 })
  await seedStockItem({ id: ITEM_B, entityId: 'F1-PRODUCT-B', storeId: 2 })

  const token = await login(env.call, OWNER)
  const tokenB = await login(env.call, OWNER_B)
  a = createClient(env.call, token)
  b = createClient(env.call, tokenB)
  // createClient 只发 JSON；二进制 PUT 需要原始字节体，这里补一个助手。
  // 注意仍要带会话头：契约给 PUT 通道同样标了 attachment/upload 权限，缺 Authorization 会被 401 挡掉。
  for (const [client, bearer] of [[a, token], [b, tokenB]]) {
    client.putRaw = (path, bytes, headers = {}) =>
      env.call(path, { method: 'PUT', headers: { ...headers, Authorization: `Bearer ${bearer}` }, body: bytes })
  }

  clerk = createClient(env.call, await login(env.call, await seedClerk({ userId: 11, email: 'f1-clerk@local.test' })))
  legacyClerk = createClient(
    env.call,
    await login(env.call, await seedClerk({ userId: 12, email: 'f1-legacy@local.test', permissions: ['library/edit'] })),
  )
})

after(async () => {
  await env.dispose()
})

// ────────────────────────────── 鉴权 ──────────────────────────────

test('无 attachment/upload 权限的店员不能签发上传意图（403）', async () => {
  const res = await clerk.post('/api/v2/attachments/upload-intents', {
    requestId: reqId('deny'),
    ownerEntityType: 'stock_item',
    ownerEntityId: ITEM_A,
    purpose: 'service_intake',
    mime: 'image/png',
    byteSize: 64,
  })
  const { status, body } = await json(res)
  assert.equal(status, 403)
  assert.equal(body.error.code, 'PERMISSION_DENIED')
})

test('旧码 library/edit 仍可上传（legacySource 兼容，不把店员权限收紧到不可用）', async () => {
  const res = await legacyClerk.post('/api/v2/attachments/upload-intents', {
    requestId: reqId('legacy'),
    ownerEntityType: 'stock_item',
    ownerEntityId: ITEM_A,
    purpose: 'recovery_evidence',
    mime: 'image/png',
    byteSize: 64,
  })
  const { status, body } = await json(res)
  assert.equal(status, 200, JSON.stringify(body))
})

// ────────────────────────────── 签发上传意图 ──────────────────────────────

test('签发上传意图：返回一次性凭证、保留期与存储标注', async () => {
  const bytes = pngBytes()
  const res = await a.post('/api/v2/attachments/upload-intents', {
    requestId: reqId('intent-ok'),
    ownerEntityType: 'stock_item',
    ownerEntityId: ITEM_A,
    purpose: 'service_intake',
    mime: 'image/png',
    byteSize: bytes.byteLength,
    sha256: sha256(bytes),
  })
  const { status, body } = await json(res)
  assert.equal(status, 200, JSON.stringify(body))
  assert.ok(body.data.entityId)
  assert.ok(body.data.uploadToken)
  assert.ok(body.data.expiresAt)
  assert.equal(body.data.state, 'pending')
  // 存储标注必须如实透出：无 R2 绑定时是内存替身，不是生产存储。
  assert.equal(body.data.storageKind, 'memory')
  assert.equal(body.data.storagePersistent, false)
  // 顾客端对外读取依赖备案域名，当前未就绪 —— 不假装可用。
  assert.equal(body.data.customerShareable, false)

  const row = await db
    .prepare('SELECT upload_state, upload_token_hash, object_key FROM attachments WHERE store_id = 1 AND id = ?')
    .bind(body.data.entityId)
    .first()
  assert.equal(row.upload_state, 'pending')
  // 凭证只存摘要，不存明文。
  assert.notEqual(row.upload_token_hash, body.data.uploadToken)
  assert.equal(row.upload_token_hash, sha256(new TextEncoder().encode(body.data.uploadToken)))
  assert.ok(row.object_key.startsWith('attachments/store-1/'))
})

test('同 requestId 重放签发：复用同一附件，不重复建行', async () => {
  const bytes = pngBytes()
  const requestId = reqId('replay')
  const payload = {
    requestId,
    ownerEntityType: 'stock_item',
    ownerEntityId: ITEM_A,
    purpose: 'service_intake',
    mime: 'image/png',
    byteSize: bytes.byteLength,
  }
  const first = await json(await a.post('/api/v2/attachments/upload-intents', payload))
  const second = await json(await a.post('/api/v2/attachments/upload-intents', payload))
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(second.body.data.entityId, first.body.data.entityId)
  assert.equal(second.body.data.reused, true)

  const count = await db
    .prepare('SELECT COUNT(*) AS n FROM attachments WHERE store_id = 1 AND request_id = ?')
    .bind(requestId)
    .first()
  assert.equal(count.n, 1)
})

test('签发校验：用途 / 类型 / 大小 / 归属对象逐项拒绝', async () => {
  const base = {
    ownerEntityType: 'stock_item',
    ownerEntityId: ITEM_A,
    purpose: 'service_intake',
    mime: 'image/png',
    byteSize: 64,
  }

  const badPurpose = await json(await a.post('/api/v2/attachments/upload-intents', { ...base, requestId: reqId('bad-purpose'), purpose: 'wallpaper' }))
  assert.equal(badPurpose.status, 400)

  const badMime = await json(await a.post('/api/v2/attachments/upload-intents', { ...base, requestId: reqId('bad-mime'), mime: 'application/zip' }))
  assert.equal(badMime.status, 400)

  const tooBig = await json(await a.post('/api/v2/attachments/upload-intents', { ...base, requestId: reqId('too-big'), byteSize: 21 * 1024 * 1024 }))
  assert.equal(tooBig.status, 400)

  const noOwner = await json(await a.post('/api/v2/attachments/upload-intents', { ...base, requestId: reqId('no-owner'), ownerEntityId: 'not-exists' }))
  assert.equal(noOwner.status, 400)
  assert.match(noOwner.body.error.message, /归属/)

  // 归属对象存在但属于别家门店：同样拒绝（不能只检查父单存在）。
  const crossStore = await json(await a.post('/api/v2/attachments/upload-intents', { ...base, requestId: reqId('cross-store'), ownerEntityId: ITEM_B }))
  assert.equal(crossStore.status, 400)

  const badType = await json(await a.post('/api/v2/attachments/upload-intents', { ...base, requestId: reqId('bad-type'), ownerEntityType: 'customer' }))
  assert.equal(badType.status, 400)
})

// ────────────────────────────── 写入字节 ──────────────────────────────

test('写入字节：服务端实算 sha256 与真实类型，成功后状态为 uploaded', async () => {
  const bytes = pngBytes()
  const intent = await json(
    await a.post('/api/v2/attachments/upload-intents', {
      requestId: reqId('put-ok-intent'),
      ownerEntityType: 'stock_item',
      ownerEntityId: ITEM_A,
      purpose: 'service_intake',
      mime: 'image/png',
      byteSize: bytes.byteLength,
      sha256: sha256(bytes),
    }),
  )
  assert.equal(intent.status, 200)
  const { entityId, uploadToken } = intent.body.data

  const put = await json(
    await a.putRaw(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/blob`, bytes, {
      'X-Upload-Token': uploadToken,
      'Content-Type': 'image/png',
    }),
  )
  assert.equal(put.status, 200, JSON.stringify(put.body))
  assert.equal(put.body.data.state, 'uploaded')
  assert.equal(put.body.data.byteSize, bytes.byteLength)
  assert.equal(put.body.data.sha256, sha256(bytes))

  const row = await db.prepare('SELECT upload_state, sha256, byte_size, content_type FROM attachments WHERE id = ?').bind(entityId).first()
  assert.equal(row.upload_state, 'uploaded')
  assert.equal(row.sha256, sha256(bytes))
  assert.equal(row.content_type, 'image/png')
})

test('写入字节：sha256 与签发声明不符 → 400 且置 failed', async () => {
  const bytes = pngBytes()
  const intent = await json(
    await a.post('/api/v2/attachments/upload-intents', {
      requestId: reqId('hash-intent'),
      ownerEntityType: 'stock_item',
      ownerEntityId: ITEM_A,
      purpose: 'service_intake',
      mime: 'image/png',
      byteSize: bytes.byteLength,
      sha256: sha256(pngBytes(99)),
    }),
  )
  const { entityId, uploadToken } = intent.body.data
  const put = await json(
    await a.putRaw(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/blob`, bytes, {
      'X-Upload-Token': uploadToken,
      'Content-Type': 'image/png',
    }),
  )
  assert.equal(put.status, 400)
  assert.match(put.body.error.message, /完整性/)

  const row = await db.prepare('SELECT upload_state, failure_reason FROM attachments WHERE id = ?').bind(entityId).first()
  assert.equal(row.upload_state, 'failed')
  assert.ok(row.failure_reason)
})

test('写入字节：声明 PNG 实际是 JPEG（改扩展名无效）→ 400', async () => {
  const real = jpegBytes()
  const intent = await json(
    await a.post('/api/v2/attachments/upload-intents', {
      requestId: reqId('sniff-intent'),
      ownerEntityType: 'stock_item',
      ownerEntityId: ITEM_A,
      purpose: 'service_intake',
      mime: 'image/png',
      byteSize: real.byteLength,
      sha256: sha256(real),
    }),
  )
  const { entityId, uploadToken } = intent.body.data
  const put = await json(
    await a.putRaw(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/blob`, real, {
      'X-Upload-Token': uploadToken,
      'Content-Type': 'image/png',
    }),
  )
  assert.equal(put.status, 400)
  assert.match(put.body.error.message, /实际类型/)
})

test('写入字节：非白名单内容（纯文本）→ 400', async () => {
  const bytes = new TextEncoder().encode('这不是图片，只是普通文本内容。')
  const intent = await json(
    await a.post('/api/v2/attachments/upload-intents', {
      requestId: reqId('text-intent'),
      ownerEntityType: 'stock_item',
      ownerEntityId: ITEM_A,
      purpose: 'service_intake',
      mime: 'image/png',
      byteSize: bytes.byteLength,
    }),
  )
  const { entityId, uploadToken } = intent.body.data
  const put = await json(
    await a.putRaw(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/blob`, bytes, {
      'X-Upload-Token': uploadToken,
      'Content-Type': 'image/png',
    }),
  )
  assert.equal(put.status, 400)
  assert.match(put.body.error.message, /文件头|允许的类型/)
})

test('写入字节：实际大小与声明不符 → 400', async () => {
  const bytes = pngBytes()
  const intent = await json(
    await a.post('/api/v2/attachments/upload-intents', {
      requestId: reqId('size-intent'),
      ownerEntityType: 'stock_item',
      ownerEntityId: ITEM_A,
      purpose: 'service_intake',
      mime: 'image/png',
      byteSize: bytes.byteLength + 10,
    }),
  )
  const { entityId, uploadToken } = intent.body.data
  const put = await json(
    await a.putRaw(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/blob`, bytes, {
      'X-Upload-Token': uploadToken,
      'Content-Type': 'image/png',
    }),
  )
  assert.equal(put.status, 400)
  assert.match(put.body.error.message, /大小/)
})

test('写入字节：请求头 Content-Type 与内容不符 → 400', async () => {
  const bytes = pngBytes()
  const intent = await json(
    await a.post('/api/v2/attachments/upload-intents', {
      requestId: reqId('header-intent'),
      ownerEntityType: 'stock_item',
      ownerEntityId: ITEM_A,
      purpose: 'service_intake',
      mime: 'image/png',
      byteSize: bytes.byteLength,
    }),
  )
  const { entityId, uploadToken } = intent.body.data
  const put = await json(
    await a.putRaw(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/blob`, bytes, {
      'X-Upload-Token': uploadToken,
      'Content-Type': 'image/jpeg',
    }),
  )
  assert.equal(put.status, 400)
  assert.match(put.body.error.message, /Content-Type/)
})

test('写入字节：缺少或错误的上传凭证 → 403', async () => {
  const bytes = pngBytes()
  const intent = await json(
    await a.post('/api/v2/attachments/upload-intents', {
      requestId: reqId('token-intent'),
      ownerEntityType: 'stock_item',
      ownerEntityId: ITEM_A,
      purpose: 'service_intake',
      mime: 'image/png',
      byteSize: bytes.byteLength,
    }),
  )
  const { entityId } = intent.body.data

  const missing = await json(
    await a.putRaw(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/blob`, bytes, {
      'Content-Type': 'image/png',
    }),
  )
  assert.equal(missing.status, 403)

  const wrong = await json(
    await a.putRaw(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/blob`, bytes, {
      'X-Upload-Token': 'not-the-real-token',
      'Content-Type': 'image/png',
    }),
  )
  assert.equal(wrong.status, 403)
})

test('跨店隔离：别店用户读写本店附件一律 404', async () => {
  const bytes = pngBytes()
  const intent = await json(
    await a.post('/api/v2/attachments/upload-intents', {
      requestId: reqId('isolation-intent'),
      ownerEntityType: 'stock_item',
      ownerEntityId: ITEM_A,
      purpose: 'service_intake',
      mime: 'image/png',
      byteSize: bytes.byteLength,
    }),
  )
  const { entityId, uploadToken } = intent.body.data

  const putOther = await json(
    await b.putRaw(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/blob`, bytes, {
      'X-Upload-Token': uploadToken,
      'Content-Type': 'image/png',
    }),
  )
  assert.equal(putOther.status, 404)

  const completeOther = await json(
    await b.post(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/complete`, { requestId: reqId('iso-complete') }),
  )
  assert.equal(completeOther.status, 404)
})

// ────────────────────────────── 完成确认 ──────────────────────────────

test('完成确认：uploaded → attached，并记录归属', async () => {
  const result = await uploadAndAttach(a, { tag: 'attach-ok' })
  assert.equal(result.put.status, 200, JSON.stringify(result.put.body))
  assert.equal(result.complete.status, 200, JSON.stringify(result.complete.body))
  assert.equal(result.complete.body.data.state, 'attached')

  const row = await db
    .prepare('SELECT upload_state, owner_entity_type, owner_entity_id, version FROM attachments WHERE id = ?')
    .bind(result.entityId)
    .first()
  assert.equal(row.upload_state, 'attached')
  assert.equal(row.owner_entity_type, 'stock_item')
  assert.equal(row.owner_entity_id, ITEM_A)
  assert.equal(row.version, 3) // pending → uploaded → attached
})

test('完成确认：尚未写入字节（pending）直接完成 → 400', async () => {
  const intent = await json(
    await a.post('/api/v2/attachments/upload-intents', {
      requestId: reqId('pending-intent'),
      ownerEntityType: 'stock_item',
      ownerEntityId: ITEM_A,
      purpose: 'service_intake',
      mime: 'image/png',
      byteSize: 128,
    }),
  )
  const { entityId } = intent.body.data
  const complete = await json(
    await a.post(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/complete`, { requestId: reqId('pending-complete') }),
  )
  assert.equal(complete.status, 400)
  assert.match(complete.body.error.message, /尚未写入/)
})

test('重复完成保护：同 requestId 幂等复用；同归属的不同 requestId 也按幂等返回', async () => {
  const result = await uploadAndAttach(a, { tag: 'dup' })
  assert.equal(result.complete.status, 200)

  // 同 requestId 再发一次：走 operations 幂等记录，reused=true。
  const sameRequestId = await json(
    await a.post(`/api/v2/attachments/upload-intents/${encodeURIComponent(result.entityId)}/complete`, {
      requestId: result.completeRequestId,
    }),
  )
  assert.equal(sameRequestId.status, 200)
  assert.equal(sameRequestId.body.data.reused, true)

  // 换一个 requestId、但归属一致：按当前状态幂等返回，不报错也不重复写。
  const otherRequestId = await json(
    await a.post(`/api/v2/attachments/upload-intents/${encodeURIComponent(result.entityId)}/complete`, {
      requestId: reqId('dup-complete-2'),
    }),
  )
  assert.equal(otherRequestId.status, 200)
  assert.equal(otherRequestId.body.data.reused, true)
  assert.equal(otherRequestId.body.data.effects.ownerEntityId, ITEM_A)

  const row = await db.prepare('SELECT upload_state, version FROM attachments WHERE id = ?').bind(result.entityId).first()
  assert.equal(row.upload_state, 'attached')
  assert.equal(row.version, 3)
})

test('重复完成保护：已关联后试图改挂到别的业务对象 → 409', async () => {
  const result = await uploadAndAttach(a, { tag: 'remap' })
  assert.equal(result.complete.status, 200)

  const remap = await json(
    await a.post(`/api/v2/attachments/upload-intents/${encodeURIComponent(result.entityId)}/complete`, {
      requestId: reqId('remap-2'),
      ownerEntityType: 'stock_item',
      ownerEntityId: ITEM_B,
    }),
  )
  assert.equal(remap.status, 409)
  assert.equal(remap.body.error.code, 'VERSION_CONFLICT')
})

test('已 attached 后不能再覆盖内容（PUT 字节 → 409）', async () => {
  const bytes = pngBytes()
  const result = await uploadAndAttach(a, { tag: 'frozen-content' })
  assert.equal(result.complete.status, 200)

  const again = await json(
    await a.putRaw(`/api/v2/attachments/upload-intents/${encodeURIComponent(result.entityId)}/blob`, bytes, {
      'X-Upload-Token': result.uploadToken,
      'Content-Type': 'image/png',
    }),
  )
  assert.equal(again.status, 409)
})

// ────────────────────────────── 孤立上传回收 ──────────────────────────────

test('孤立上传：超过保留期未关联的行在下次签发时被回收为 orphaned', async () => {
  const bytes = pngBytes()
  const intent = await json(
    await a.post('/api/v2/attachments/upload-intents', {
      requestId: reqId('orphan-intent'),
      ownerEntityType: 'stock_item',
      ownerEntityId: ITEM_A,
      purpose: 'service_intake',
      mime: 'image/png',
      byteSize: bytes.byteLength,
      sha256: sha256(bytes),
    }),
  )
  const { entityId, uploadToken } = intent.body.data
  const put = await json(
    await a.putRaw(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/blob`, bytes, {
      'X-Upload-Token': uploadToken,
      'Content-Type': 'image/png',
    }),
  )
  assert.equal(put.status, 200)

  // 把保留期推到过去，模拟「传完字节却一直没关联」。
  await db
    .prepare(`UPDATE attachments SET expires_at = datetime('now', '-1 hour') WHERE store_id = 1 AND id = ?`)
    .bind(entityId)
    .run()

  // 下一次签发会顺带扫描回收（惰性清理，不依赖定时任务）。
  const next = await json(
    await a.post('/api/v2/attachments/upload-intents', {
      requestId: reqId('orphan-next'),
      ownerEntityType: 'stock_item',
      ownerEntityId: ITEM_A,
      purpose: 'service_intake',
      mime: 'image/png',
      byteSize: 64,
    }),
  )
  assert.equal(next.status, 200)

  const row = await db.prepare('SELECT upload_state, failure_reason FROM attachments WHERE id = ?').bind(entityId).first()
  assert.equal(row.upload_state, 'orphaned')
  assert.ok(row.failure_reason)

  // 已关联的行不受保留期影响：回收只动 pending / uploaded。
  const attached = await db
    .prepare(`SELECT COUNT(*) AS n FROM attachments WHERE store_id = 1 AND upload_state = 'attached'`)
    .first()
  assert.ok(attached.n >= 1)
})

test('并发完成同一附件只关联一次；冲突方复用原 requestId 可确认已完成', async () => {
  const bytes = pngBytes()
  const intent = await json(await a.post('/api/v2/attachments/upload-intents', {
    requestId: reqId('race-complete-intent'),
    ownerEntityType: 'stock_item', ownerEntityId: ITEM_A, purpose: 'recovery_evidence',
    mime: 'image/png', byteSize: bytes.byteLength, sha256: sha256(bytes),
  }))
  assert.equal(intent.status, 200, JSON.stringify(intent.body))
  const { entityId, uploadToken } = intent.body.data
  const put = await json(await a.putRaw(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/blob`, bytes, {
    'X-Upload-Token': uploadToken, 'Content-Type': 'image/png',
  }))
  assert.equal(put.status, 200, JSON.stringify(put.body))

  const complete = (requestId) => a.post(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/complete`, {
    requestId, ownerEntityType: 'stock_item', ownerEntityId: ITEM_A,
  }).then(json)
  const requestIds = ['f1-race-complete-a', 'f1-race-complete-b']
  const raced = await Promise.all(requestIds.map(complete))
  assert.ok(raced.every((result) => result.status === 200 || (result.status === 409 && result.body.error.code === 'VERSION_CONFLICT')))
  assert.ok(raced.some((result) => result.status === 200))

  const row = await db.prepare('SELECT upload_state, owner_entity_id, version FROM attachments WHERE store_id = 1 AND id = ?').bind(entityId).first()
  assert.equal(row.upload_state, 'attached')
  assert.equal(row.owner_entity_id, ITEM_A)
  assert.equal(row.version, 3, '签发、写字节、完成各推进一次')
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE store_id = 1 AND id = ? AND upload_state = \'attached\'').bind(entityId).first().then((value) => value.n), 1)

  const loserIndex = raced.findIndex((result) => result.status === 409)
  if (loserIndex >= 0) {
    const retry = await complete(requestIds[loserIndex])
    assert.equal(retry.status, 200, JSON.stringify(retry.body))
    assert.equal(retry.body.data.entityId, entityId)
  }
})

test('正式模式未绑定 R2 时拒绝创建附件，不返回内存存储成功', async () => {
  const guarded = await createWorkerEnv({ bindings: { REQUIRE_PERSISTENT_STORAGE: 'true' } })
  try {
    const owner = await seedOwner(guarded.db)
    const guardedProduct = await seedProduct(guarded.db, { entityId: 'f1-no-r2-product', trackingMode: 'item', requiresSn: 1 })
    await guarded.db.prepare(`INSERT INTO stock_items
      (id, store_id, product_id, asset_code, condition, ownership, availability, location, cost_known, created_by)
      VALUES (?, ?, ?, ?, 'new', 'store', 'available', 'store', 0, 1)`)
      .bind('f1-no-r2-item-id', owner.storeId, guardedProduct.hardwareId, 'AC-f1-no-r2').run()
    const client = createClient(guarded.call, await login(guarded.call, owner))
    const result = await json(await client.post('/api/v2/attachments/upload-intents', {
      requestId: reqId('no-r2'), ownerEntityType: 'stock_item', ownerEntityId: 'f1-no-r2-item-id',
      purpose: 'service_intake', mime: 'image/png', byteSize: pngBytes().byteLength,
    }))
    assert.equal(result.status, 503)
    assert.equal(result.body.error.code, 'SERVICE_UNAVAILABLE')
    const rows = await guarded.db.prepare(`SELECT COUNT(*) AS n FROM attachments WHERE store_id=?`).bind(owner.storeId).first()
    assert.equal(rows.n, 0)
  } finally { await guarded.dispose() }
})

test('R2 绑定启用时签发响应明确标记持久存储', async () => {
  const first = await createWorkerEnv({ bindings: { REQUIRE_PERSISTENT_STORAGE: 'true' }, withR2: true })
  const second = await createWorkerEnv({ bindings: { REQUIRE_PERSISTENT_STORAGE: 'true' }, withR2: true })
  try {
    const owner = await seedOwner(first.db)
    const crossProduct = await seedProduct(first.db, { entityId: 'f1-cross-product', trackingMode: 'item', requiresSn: 1 })
    await first.db.prepare(`INSERT INTO stock_items
      (id, store_id, product_id, asset_code, condition, ownership, availability, location, cost_known, created_by)
      VALUES (?, ?, ?, ?, 'new', 'store', 'available', 'store', 0, 1)`)
      .bind('f1-cross-item-id', owner.storeId, crossProduct.hardwareId, 'AC-f1-cross').run()
    const firstClient = createClient(first.call, await login(first.call, owner))
    const bytes = pngBytes()
    const intent = await json(await firstClient.post('/api/v2/attachments/upload-intents', {
      requestId: reqId('cross-intent'), ownerEntityType: 'stock_item', ownerEntityId: 'f1-cross-item-id',
      purpose: 'service_intake', mime: 'image/png', byteSize: bytes.byteLength, sha256: sha256(bytes),
    }))
    assert.equal(intent.status, 200, JSON.stringify(intent.body))
    assert.equal(intent.body.data.storageKind, 'r2')
    assert.equal(intent.body.data.storagePersistent, true)
    // 迁移集合是按目录全量重放的：这个数字与 backend/migrations/*.sql 的数量一起走，
    // 每次追加迁移都要一起改 —— 它拦的是「迁移被无意漏掉 / 被删」，不是为了让人少改一行。
    assert.equal(second.migrations.length, 32)
  } finally {
    await Promise.all([first.dispose(), second.dispose()])
  }
})
