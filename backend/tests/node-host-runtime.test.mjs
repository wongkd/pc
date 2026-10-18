import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createLocalD1 } from '../scripts/lib/d1-sqlite.mjs'
import { hostConfig } from '../scripts/lib/host-config.mjs'
import { migrateHost } from '../scripts/lib/host-migrations.mjs'
import { bootstrapOwner } from '../scripts/lib/host-bootstrap.mjs'

const args = { port: 8790, db: ':memory:', dataDir: 'attachments' }
test('正式宿主拒绝缺配置、演示种子、内存库；使用受控绑定', () => {
  assert.throws(() => hostConfig(args, { PCQ_MODE: 'production' }), /JWT_SECRET/)
  const env = { PCQ_MODE: 'production', JWT_SECRET: 's'.repeat(48), PCQ_DB: 'test.sqlite', PCQ_ATTACHMENTS: 'files', PCQ_WORKER_ENTRY: 'worker.mjs' }
  assert.throws(() => hostConfig({ ...args, seed: true }, env), /禁止/)
  assert.throws(() => hostConfig(args, { ...env, PCQ_DB: ':memory:' }), /PCQ_DB/)
  const config = hostConfig(args, env)
  assert.equal(config.bindings.INVENTORY_OPENING_MODE, 'closed')
  assert.equal(config.bindings.JWT_SECRET, env.JWT_SECRET)
  assert.equal(config.bindings.REQUIRE_PERSISTENT_STORAGE, 'true')
})

test('增量迁移保留数据、失败整文件回滚、篡改与代码降级拒绝', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pcq-migrations-'))
  const db = createLocalD1(':memory:')
  try {
    writeFileSync(join(directory, '0000_base.sql'), 'CREATE TABLE records(id INTEGER PRIMARY KEY, note TEXT);')
    assert.equal(migrateHost(db, directory).total, 1)
    db.db.prepare('INSERT INTO records VALUES(1,?)').run('保留历史')
    writeFileSync(join(directory, '0001_upgrade.sql'), 'ALTER TABLE records ADD COLUMN version INTEGER DEFAULT 1;')
    assert.equal(migrateHost(db, directory).applied.length, 1)
    assert.equal(db.db.prepare('SELECT note FROM records').get().note, '保留历史')
    assert.equal(migrateHost(db, directory).applied.length, 0)
    assert.throws(() => migrateHost(db, directory, { through: '0000_base.sql' }), /禁止自动降级/)
    writeFileSync(join(directory, '0002_failure.sql'), 'CREATE TABLE temporary_row(id INTEGER); INSERT INTO missing_table VALUES(1);')
    assert.throws(() => migrateHost(db, directory), /已回滚/)
    assert.equal(db.db.prepare("SELECT name FROM sqlite_master WHERE name='temporary_row'").get(), undefined)
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM _pcq_migrations').get().n, 2)
    writeFileSync(join(directory, '0000_base.sql'), 'CREATE TABLE modified(id INTEGER);')
    assert.throws(() => migrateHost(db, directory), /历史不匹配/)
  } finally { db.close(); rmSync(directory, { recursive: true }) }
})

test('旧无记录库拒绝猜测基线，显式基线校验后保留账号与业务升级', async () => {
  const db = createLocalD1(':memory:')
  const dir = resolve('migrations')
  try {
    // 模拟旧宿主应用现有全部迁移但没有记录。
    const { readFileSync, readdirSync } = await import('node:fs')
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    for (const file of files) db.db.exec(readFileSync(join(dir, file), 'utf8'))
    await bootstrapOwner(db, { email: 'synthetic@example.test', password: 'synthetic-password-18', storeName: '合成门店' })
    assert.throws(() => migrateHost(db, dir), /没有迁移记录/)
    assert.throws(() => migrateHost(db, dir, { baseline: files.at(-2) }), /结构.*不符/)
    migrateHost(db, dir, { baseline: files.at(-1) })
    assert.equal(db.db.prepare('SELECT email FROM users').get().email, 'synthetic@example.test')
    await assert.rejects(bootstrapOwner(db, { email: 'second@example.test', password: 'synthetic-password-18', storeName: '拒绝重播' }), /已有账号/)
    assert.equal(db.db.prepare('PRAGMA foreign_key_check').all().length, 0)
  } finally { db.close() }
})

test('本地batch并发不会嵌套事务；失败不会污染另一个batch', async () => {
  const db = createLocalD1(':memory:')
  try {
    db.db.exec('CREATE TABLE counter(id INTEGER PRIMARY KEY, n INTEGER NOT NULL CHECK(n>=0)); INSERT INTO counter VALUES(1,0)')
    const outcomes = await Promise.allSettled([
      db.batch([db.prepare('UPDATE counter SET n=n+1'), db.prepare('UPDATE counter SET n=-1')]),
      db.batch([db.prepare('UPDATE counter SET n=n+3')]),
    ])
    assert.equal(outcomes[0].status, 'rejected')
    assert.equal(outcomes[1].status, 'fulfilled')
    assert.equal(db.db.prepare('SELECT n FROM counter').get().n, 3)
  } finally { db.close() }
})
