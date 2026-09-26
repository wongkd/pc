#!/usr/bin/env node
/**
 * T02a · 把 contracts/v1.1 的生成物落到网页端内目录，并防止三处漂移。
 *
 *   node frontend/scripts/sync-contracts.mjs          写入端内目录（幂等）
 *   node frontend/scripts/sync-contracts.mjs --check  只比对，不写入；有差异退出码 1
 *
 * 三方一致性：contracts/v1.1（唯一来源） → contracts/generated（中立生成物，T01c）
 *          → frontend/src/contracts/generated（端内消费副本，T02a）
 *
 * 端内副本不是第二份契约，只是同一份编译产物。任何一方被手工修改都会被本脚本检出。
 * 目标路径由 contracts/v1.1/fixtures.json 的 dtoGeneration.targets[id=web] 冻结。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { buildArtifacts, GENERATE_COMMAND } from '../../contracts/tools/generate-dto.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const frontendRoot = resolve(here, '..')
const repoRoot = resolve(here, '../..')

const targetDir = join(frontendRoot, 'src', 'contracts', 'generated')
const neutralDir = join(repoRoot, 'contracts', 'generated')
/** 冻结来源，改路径须先改契约（fixtures.json dtoGeneration.targets）。 */
const FROZEN_TARGET = 'frontend/src/contracts/generated'
const CHECK_CMD = 'node frontend/scripts/sync-contracts.mjs --check'

const checkOnly = process.argv.includes('--check')

function readDirIfExists(dir) {
  if (!existsSync(dir)) return null
  const out = new Map()
  for (const name of readdirSync(dir)) out.set(name, readFileSync(join(dir, name), 'utf8'))
  return out
}

function die(lines) {
  console.error(lines[0])
  for (const l of lines.slice(1)) console.error('  ✗ ' + l)
  console.error(`\n修复：运行 ${GENERATE_COMMAND} 后重新运行 node frontend/scripts/sync-contracts.mjs`)
  process.exit(1)
}

// ── 1. 冻结路径自检 ─────────────────────────────────────────────────────
const { files } = buildArtifacts()
const fixtures = JSON.parse(readFileSync(join(repoRoot, 'contracts', 'v1.1', 'fixtures.json'), 'utf8'))
const webTarget = (fixtures.dtoGeneration?.targets ?? []).find((t) => t.id === 'web')
if (!webTarget) die(['契约 dtoGeneration.targets 中找不到 id=web 的目标'])
if (webTarget.rootPath !== FROZEN_TARGET) {
  die([`契约声明的 web 目标路径为 ${webTarget.rootPath}，本脚本写的是 ${FROZEN_TARGET}；改路径必须先改契约`])
}

const names = Object.keys(files).sort()

// ── 2. 写入模式：落地后自检 ─────────────────────────────────────────────
if (!checkOnly) {
  mkdirSync(targetDir, { recursive: true })
  for (const name of names) {
    writeFileSync(join(targetDir, name), files[name], 'utf8')
    console.log(`  写入 ${FROZEN_TARGET}/${name}`)
  }
  const written = readDirIfExists(targetDir)
  const bad = names.filter((n) => written.get(n) !== files[n])
  if (bad.length) die(['写入后回读不一致（磁盘异常）', ...bad])
  console.log(`\n✓ 已落地 ${names.length} 个生成物到 ${FROZEN_TARGET}。禁止手工编辑，改契约后重新运行本脚本。`)
  console.log(`  防漂移复验：${CHECK_CMD}`)
  process.exit(0)
}

// ── 3. 检查模式：端内 vs 契约 ───────────────────────────────────────────
const failures = []
const onDisk = readDirIfExists(targetDir)
if (!onDisk) die([`端内目录不存在：${FROZEN_TARGET}`])

for (const name of names) {
  if (!onDisk.has(name)) failures.push(`端内缺失：${name}`)
  else if (onDisk.get(name) !== files[name]) failures.push(`端内内容与契约不一致：${name}（可能被手工修改）`)
}
for (const name of onDisk.keys()) {
  if (!names.includes(name)) failures.push(`端内多余文件：${name}`)
}

// ── 4. 中立生成物交叉比对（存在才比） ───────────────────────────────────
const neutral = readDirIfExists(neutralDir)
if (neutral) {
  for (const name of names) {
    if (neutral.has(name) && onDisk.has(name) && neutral.get(name) !== onDisk.get(name)) {
      failures.push(`端内与 contracts/generated 不一致：${name}`)
    }
  }
}

if (failures.length) die(['端内生成物与契约不一致：', ...failures])
console.log(`✓ 端内生成物与 contracts/v1.1 一致（${names.length} 个文件，目标 ${FROZEN_TARGET}）`)
