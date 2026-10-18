import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const digest = (source) => createHash('sha256').update(source).digest('hex')
const schema = (db) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_pcq_%' ORDER BY type,name").all()
const schemaText = (db) => JSON.stringify(schema(db).map((row) => ({ ...row, sql: row.sql?.replace(/\s+/g, ' ').trim() })))

/** 每个迁移与记录在同一个 IMMEDIATE 事务提交；旧无记录库只能显式校验基线后接管。 */
export function migrateHost(database, directory, { baseline, through } = {}) {
  const db = database.db
  const files = readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()
  if (!files.length) throw new Error('迁移目录为空')
  if (through && !files.includes(through)) throw new Error('指定迁移不存在')
  const selected = through ? files.slice(0, files.indexOf(through) + 1) : files
  const sources = new Map(files.map((file) => [file, readFileSync(join(directory, file), 'utf8')]))
  const recorded = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_pcq_migrations'").get()
  if (!recorded && schema(db).length) {
    if (!baseline || !files.includes(baseline)) throw new Error('已有库没有迁移记录；先备份并运行 migrate-host --baseline <最后已应用文件>')
    const reference = new DatabaseSync(':memory:')
    try {
      for (const file of files.slice(0, files.indexOf(baseline) + 1)) reference.exec(sources.get(file))
      if (schemaText(reference) !== schemaText(db)) throw new Error('旧库结构与指定迁移基线不符；拒绝接管')
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('旧库外键不完整；拒绝接管')
    } finally { reference.close() }
  } else if (baseline) throw new Error('基线参数仅允许接管无迁移记录的已有库')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('CREATE TABLE IF NOT EXISTS _pcq_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, baseline INTEGER NOT NULL DEFAULT 0)')
    if (baseline) {
      const insert = db.prepare('INSERT INTO _pcq_migrations(name,sha256,baseline) VALUES(?,?,1)')
      for (const file of files.slice(0, files.indexOf(baseline) + 1)) insert.run(file, digest(sources.get(file)))
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  const rows = db.prepare('SELECT name, sha256 FROM _pcq_migrations ORDER BY name').all()
  for (const [index, row] of rows.entries()) {
    if (files[index] !== row.name || digest(sources.get(row.name) ?? '') !== row.sha256) throw new Error(`迁移历史不匹配：${row.name}，拒绝启动`)
  }
  if (rows.length > selected.length) throw new Error('数据库版本高于目标代码；禁止自动降级')
  const applied = []
  for (const file of selected.slice(rows.length)) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('PRAGMA defer_foreign_keys = ON')
      db.exec(sources.get(file))
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('迁移后外键校验失败')
      db.prepare('INSERT INTO _pcq_migrations(name,sha256) VALUES(?,?)').run(file, digest(sources.get(file)))
      db.exec('COMMIT')
      applied.push(file)
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`迁移 ${file} 失败（本文件已回滚）：${error.message}`)
    }
  }
  return { applied, total: selected.length, latest: selected.at(-1) }
}
