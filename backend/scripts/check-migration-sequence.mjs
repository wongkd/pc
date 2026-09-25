#!/usr/bin/env node
/**
 * 迁移编号守卫 —— 保证 backend/migrations 能被安全地「按文件名排序」执行。
 *
 * 为什么需要：
 *   `backend/tests/lib/env.mjs` 的 `applyMigrations()` 读取整个目录后按**文件名排序**
 *   逐个执行 —— 也就是「版本顺序 = 字符串顺序」。因此下面三种写法都会让迁移链
 *   在**不报错**的情况下跑错：
 *     · 没补零    → `22_x.sql` 会排到 `0001_x.sql` 之前（地基没打就上屋顶）
 *     · 编号重复  → 两段语义互相遮蔽，翻日志也看不出
 *     · 编号缺号  → 执行顺序出现空洞，回滚和排查时说不清「跳过了什么」
 *   这类错误是静默的，排查成本极高，所以在写下来之前就拦住。
 *
 * 用法：
 *   node backend/scripts/check-migration-sequence.mjs
 *   退出码 0 = 合规；1 = 存在问题。
 *
 * 只读：不写文件、不连数据库、不改任何状态。工作目录无关。
 */

import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const backendRoot = resolve(here, '..')
const migrationsDir = join(backendRoot, 'migrations')

/** 只认 `NNNN_小写描述.sql`；描述段可含下划线与数字。 */
const FILE_PATTERN = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/

const pad = (n) => String(n).padStart(4, '0')

let files
try {
  files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()
} catch (error) {
  console.error(`✗ 读不到迁移目录：${migrationsDir}\n  ${error?.message ?? error}`)
  process.exit(1)
}

if (files.length === 0) {
  console.error(`✗ 迁移目录里没有任何 .sql 文件：${migrationsDir}`)
  process.exit(1)
}

const failures = []
const seen = new Map()

for (const name of files) {
  const matched = FILE_PATTERN.exec(name)
  if (!matched) {
    failures.push(
      `命名不合规：${name}\n      要求「4 位编号 + 下划线 + 小写描述.sql」，例如 0022_tradein.sql`,
    )
    continue
  }
  const number = matched[1]
  if (seen.has(number)) {
    failures.push(`编号重复：${number} 同时出现在 ${seen.get(number)} 与 ${name}`)
  } else {
    seen.set(number, name)
  }
}

// 连续性：本项目基线是 0000_baseline.sql，故起点固定为 0000。
if (seen.size > 0) {
  const max = Math.max(...[...seen.keys()].map(Number))
  const missing = []
  for (let i = 0; i <= max; i += 1) {
    if (!seen.has(pad(i))) missing.push(pad(i))
  }
  if (missing.length) {
    failures.push(`编号不连续，缺：${missing.join(', ')}（已到 ${pad(max)}）`)
  }
}

if (failures.length) {
  console.error('✗ 迁移编号存在问题：')
  for (const line of failures) console.error(`  · ${line}`)
  console.error('\n  编号顺序就是执行顺序，写错不会报错、只会静默跑错。请先修正再继续。')
  process.exit(1)
}

const max = Math.max(...[...seen.keys()].map(Number))
console.log(`✓ 迁移编号合规：${files.length} 个文件，0000–${pad(max)} 连续、无缺号、无重号`)
console.log(`  下一个迁移编号必须是：${pad(max + 1)}`)
console.log(`  （顺序靠文件名排序；编号只追加不改写，补零是功能要求不是风格）`)
