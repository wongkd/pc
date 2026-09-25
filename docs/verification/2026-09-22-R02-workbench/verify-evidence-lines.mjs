/**
 * R02 收尾核实工具：检查 contracts/v1/actions.json 里所有指向 backend/src/index.ts
 * 的**绝对行号**证据，其落点是否真的落在权限守卫行上。
 *
 * 为什么需要它：`shift-index-lines.mjs` 按固定步长整体平移行号，但「平移」本身不保证
 * 落点正确 —— 若插入行数数错、或脚本被重复执行，校验器可能仍然通过而证据已悄悄指错。
 * 本脚本把每一处引用的**实际行内容**打出来，供人工逐条比对。
 *
 * 用法：node docs/verification/2026-09-22-R02-workbench/verify-evidence-lines.mjs
 */
import { readFileSync } from 'node:fs'

const ACTIONS = 'contracts/v1/actions.json'
const ENTRY = 'backend/src/index.ts'

const raw = readFileSync(ACTIONS, 'utf8')
const entryLines = readFileSync(ENTRY, 'utf8').split(/\r?\n/)

/** 收集所有引用：{ line, kind, context } */
const refs = []

// 形态 1：内联字符串 "backend/src/index.ts:NNN"（evidence 数组、wildcardNote 等）
for (const m of raw.matchAll(/backend\/src\/index\.ts:(\d+)/g)) {
  refs.push({ line: Number(m[1]), kind: 'inline', at: m.index })
}

// 形态 2：specBasis 的 { "file": "backend/src/index.ts", "line": NNN }
for (const m of raw.matchAll(/"file":\s*"backend\/src\/index\.ts",\s*"line":\s*(\d+)/g)) {
  refs.push({ line: Number(m[1]), kind: 'specBasis', at: m.index })
}

refs.sort((a, b) => a.line - b.line)

/** 权限守卫的形态：requirePermission(...) / grants(...) / grantsAny(...) */
const GUARD = /requirePermission|grantsAny|grants\(/

let guardHits = 0
let missHits = 0
const misses = []

console.log(`entry=${ENTRY} 总行数=${entryLines.length}`)
console.log(`发现 ${refs.length} 处绝对行号引用\n`)

for (const r of refs) {
  const text = (entryLines[r.line - 1] ?? '').trim()
  const isGuard = GUARD.test(text)
  if (isGuard) guardHits++
  else {
    missHits++
    misses.push({ ...r, text })
  }
  const flag = isGuard ? 'OK  ' : 'MISS'
  console.log(`${flag} L${String(r.line).padStart(5)} [${r.kind.padEnd(9)}] ${text.slice(0, 110)}`)
}

console.log(`\n落在权限守卫行上：${guardHits} 处`)
console.log(`未落在守卫行上：${missHits} 处`)

if (missHits > 0) {
  console.log('\n⚠️ 以下引用需要人工判断（可能是分发点、Env 声明或注释，属正常）：')
  for (const m of misses) console.log(`  L${m.line} [${m.kind}] ${m.text.slice(0, 130)}`)
}
