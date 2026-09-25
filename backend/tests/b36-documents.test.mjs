import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { applySqlFile } from './lib/env.mjs'
import { backendRoot, createWorkerEnv, seedOwner, login, createClient } from './lib/worker.mjs'

let env, db, client
const json = async (response) => ({ status: response.status, body: await response.json() })
before(async () => {
  env = await createWorkerEnv(); db = env.db
  const owner = await seedOwner(db); client = createClient(env.call, await login(env.call, owner))
  await db.prepare(`INSERT INTO quote_headers (id, store_id, customer_id, title, current_revision, created_by, updated_by) VALUES ('doc-q1', 1, NULL, '客户配置单', 1, 1, 1)`).run()
  await db.prepare(`INSERT INTO quote_versions (quote_id, revision, store_id, status, issued_at, subtotal_cents, total_cents, created_by) VALUES ('doc-q1', 1, 1, 'issued', datetime('now'), 880000, 880000, 1)`).run()
  await db.prepare('UPDATE quote_versions SET terms_snapshot = ? WHERE quote_id = ? AND revision = ?')
    .bind(JSON.stringify({ warrantyPolicyLines: ['顾客可见的条款快照：基础保修按本单注明期限；延保暂未开放选购和收费。'] }), 'doc-q1', 1).run()
  await db.prepare(`INSERT INTO quote_lines (id, quote_id, revision, store_id, position, source, name_snapshot, spec_snapshot, qty, unit_price_cents, line_total_cents, warranty_snapshot) VALUES ('doc-line-1', 'doc-q1', 1, 1, 0, 'new', 'RTX 5070', '内部成本 123 元；供应商 A；SN: secret-sn', 1, 880000, 880000, '{"months":12,"note":"本店保修","internalMemo":"内部成本 123 元"}')`).run()
})
after(async () => env?.dispose())

test('B36 客户 HTML 单据是服务端白名单快照，不泄露成本供应商 SN，且不自动外发', async () => {
  const result = await json(await client.post('/api/v2/documents', { requestId: 'b36-html-1', entityRef: 'quote:doc-q1', snapshotVersion: 1, audience: 'customer', format: 'html' }))
  assert.equal(result.status, 200)
  const raw = JSON.stringify(result.body)
  assert.equal(raw.includes('内部成本'), false); assert.equal(raw.includes('供应商 A'), false); assert.equal(raw.includes('secret-sn'), false)
  assert.equal(raw.includes('internalMemo'), false)
  assert.equal(raw.includes('objectKey'), false)
  assert.equal(result.body.data.effects.delivery, 'none')
  assert.match(result.body.data.attachmentId, /^doc-[a-f0-9]{32}$/)
  assert.equal(result.body.data.downloadPath, `/api/v2/documents/${result.body.data.attachmentId}`)
  const operation = await db.prepare(`SELECT action, status FROM operations WHERE store_id=1 AND request_id='b36-html-1'`).first()
  assert.deepEqual(operation, { action: 'B36', status: 'succeeded' })
  const attachment = await db.prepare(`SELECT purpose, upload_state, owner_entity_type, owner_entity_id, version, content_type FROM attachments WHERE store_id=1 AND id=?`).bind(result.body.data.attachmentId).first()
  assert.deepEqual(attachment, { purpose: 'document_export', upload_state: 'attached', owner_entity_type: 'quote', owner_entity_id: 'doc-q1', version: 1, content_type: 'text/html; charset=utf-8' })
  const downloaded = await client.get(result.body.data.downloadPath)
  assert.equal(downloaded.status, 200)
  assert.equal(downloaded.headers.get('content-disposition')?.includes('attachment;'), true)
  const file = await downloaded.text()
  assert.equal(file.includes('RTX 5070'), true)
  assert.equal(file.includes('顾客可见的条款快照'), true, '单据只读取该报价版本自身的保修条款快照')
  assert.equal(file.includes('延保暂未开放选购和收费'), true)
  assert.equal(file.includes('内部成本'), false); assert.equal(file.includes('供应商 A'), false); assert.equal(file.includes('secret-sn'), false)
  assert.equal(file.includes('internalMemo'), false)
  assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff')
})

test('B36 同一报价版本复用可追溯附件，跨门店下载返回 404', async () => {
  const first = await json(await client.post('/api/v2/documents', { requestId: 'b36-html-repeat-1', entityRef: 'quote:doc-q1', snapshotVersion: 1, audience: 'customer', format: 'html' }))
  const second = await json(await client.post('/api/v2/documents', { requestId: 'b36-html-repeat-2', entityRef: 'quote:doc-q1', snapshotVersion: 1, audience: 'customer', format: 'html' }))
  assert.equal(first.body.data.attachmentId, second.body.data.attachmentId)
  const internal = await json(await client.post('/api/v2/documents', { requestId: 'b36-html-internal-1', entityRef: 'quote:doc-q1', snapshotVersion: 1, audience: 'internal', format: 'html' }))
  assert.equal(first.body.data.attachmentId, internal.body.data.attachmentId)
  const count = await db.prepare(`SELECT count(*) AS n FROM attachments WHERE store_id=1 AND purpose='document_export'`).first()
  assert.equal(count.n, 1)
  const otherOwner = await seedOwner(db, { email: 'other@local.test', storeId: 2, userId: 2 })
  const otherClient = createClient(env.call, await login(env.call, otherOwner))
  assert.equal((await otherClient.get(first.body.data.downloadPath)).status, 404)
})

test('B36 pdf/image 尚未接入时明确失败，不伪造文件', async () => {
  for (const format of ['pdf', 'image']) {
    const requestId = `b36-${format}-1`
    const result = await json(await client.post('/api/v2/documents', { requestId, entityRef: 'quote:doc-q1', snapshotVersion: 1, audience: 'customer', format }))
    assert.equal(result.status, 400); assert.equal(result.body.error.code, 'VALIDATION_ERROR')
    const operation = await db.prepare(`SELECT count(*) AS n FROM operations WHERE store_id=1 AND request_id=?`).bind(requestId).first()
    assert.equal(operation.n, 0)
  }
})

test('0028 升级保留既有附件行与状态', async () => {
  const upgradeEnv = await createWorkerEnv({ migrations: false })
  try {
    const migrationDir = join(backendRoot, 'migrations')
    const priorMigrations = readdirSync(migrationDir).filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) < 28).sort()
    for (const name of priorMigrations) await applySqlFile(upgradeEnv.db, join(migrationDir, name), name)
    const owner = await seedOwner(upgradeEnv.db)
    await upgradeEnv.db.prepare(`INSERT INTO attachments
      (id, store_id, upload_state, purpose, visibility, object_key, declared_mime, declared_byte_size,
       upload_token_hash, expires_at, request_id, created_by)
      VALUES ('legacy-attachment', ?, 'pending', 'service_intake', 'internal', 'attachments/store-1/legacy.jpg',
       'image/jpeg', 4, 'token-hash', '2099-01-01T00:00:00Z', 'legacy-request', ?)`)
      .bind(owner.storeId, owner.userId).run()
    await applySqlFile(upgradeEnv.db, join(migrationDir, '0028_document_export_attachments.sql'), '0028_document_export_attachments.sql')
    const row = await upgradeEnv.db.prepare(`SELECT id, purpose, upload_state, object_key, request_id FROM attachments WHERE id='legacy-attachment'`).first()
    assert.deepEqual(row, { id: 'legacy-attachment', purpose: 'service_intake', upload_state: 'pending', object_key: 'attachments/store-1/legacy.jpg', request_id: 'legacy-request' })
    const allowed = await upgradeEnv.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='attachments'`).first()
    assert.match(allowed.sql, /document_export/)
  } finally { await upgradeEnv.dispose() }
})
