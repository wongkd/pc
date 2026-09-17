/**
 * T04 本地 D1 测试环境。
 *
 * 用 miniflare 起真实 workerd + 真实 D1 binding（不是模拟对象），
 * 在隔离的内存库里按序应用 backend/migrations/*.sql，再叠加测试专用表。
 *
 * 被测代码通过 esbuild 打包后直接调用（见 lib/build.mjs）——
 * miniflare 的 scriptPath 不编译 TS，所以不走 Worker 路由那条路。
 *
 * 边界：
 *   · 只跑本地，不连远程、不 deploy、不碰生产 D1。
 *   · 每个测试文件独立起一个环境（内存库），互不干扰。
 */

import { Miniflare, Log, LogLevel } from 'miniflare'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitSql } from './sql.mjs'
import { bundleModule } from './build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const backendRoot = resolve(here, '..', '..')
const migrationsDir = join(backendRoot, 'migrations')
const demoSchemaPath = join(backendRoot, 'tests', 'harness', 'demo-schema.sql')

/** 逐条提交 SQL，失败时指出是哪一条。 */
export async function applySqlSource(db, source, label) {
  const statements = splitSql(source)
  for (const statement of statements) {
    try {
      await db.prepare(statement).run()
    } catch (error) {
      const preview = statement.replace(/\s+/g, ' ').slice(0, 110)
      throw new Error(`[${label}] 执行失败：${preview}...\n原因：${error?.message ?? error}`)
    }
  }
  return statements.length
}

export async function applySqlFile(db, path, label = path) {
  return applySqlSource(db, readFileSync(path, 'utf8'), label)
}

/** 按文件名顺序应用 migrations 目录下的全部迁移，返回每个文件执行的语句数。 */
export async function applyMigrations(db) {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  const applied = []
  for (const file of files) {
    const count = await applySqlFile(db, join(migrationsDir, file), file)
    applied.push({ file, statements: count })
  }
  return applied
}

/** 供外键引用的最小种子数据：一家店 + 一个操作人。 */
export async function seedStore(db, { storeId = 1, userId = 1 } = {}) {
  await db
    .prepare(`INSERT INTO users (id, email, password_hash, status) VALUES (?, ?, ?, 'active')`)
    .bind(userId, `t04-user-${userId}@example.test`, 'seed:seed')
    .run()
  await db
    .prepare(`INSERT INTO stores (id, name, status) VALUES (?, ?, 'active')`)
    .bind(storeId, `T04 测试店 ${storeId}`)
    .run()
  return { storeId, userId }
}

/**
 * 起一个隔离环境。
 * @param {{ demo?: boolean }} options demo=true 时额外建测试专用表并打包演示动作
 */
export async function createTestEnv({ demo = true } = {}) {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response("ok") } }',
    compatibilityDate: '2025-06-01',
    d1Databases: { DB: `t04-${Math.random().toString(36).slice(2, 8)}` },
    log: new Log(LogLevel.ERROR),
  })

  const db = await miniflare.getD1Database('DB')
  const migrations = await applyMigrations(db)
  let demoModule = null
  if (demo) {
    await applySqlFile(db, demoSchemaPath, 'demo-schema.sql')
    demoModule = await bundleModule('tests/harness/demo-action.ts', 'demo-action')
  }

  return {
    miniflare,
    db,
    migrations,
    demo: demoModule,
    async dispose() {
      await miniflare.dispose()
    },
  }
}
