/**
 * 一次性工具：把 contracts/v1/actions.json 里指向 backend/src/index.ts 的绝对行号
 * 整体平移 +2（R02 在入口顶部新增 2 行：1 行注释 + 1 行 import）。
 *
 * 为什么必须平移：validate-contracts.mjs 的 legacyPermissionMap 证据与 specBasis
 * 用的是**绝对行号**，入口加行会让全部证据错位，而校验器会失败（不会静默）。
 *
 * 用法：node docs/verification/2026-09-22-R02-workbench/shift-index-lines.mjs [--check]
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const TARGET = 'contracts/v1/actions.json'
const SHIFT = 2
const check = process.argv.includes('--check')

const raw = readFileSync(TARGET, 'utf8')

// 形态 1：evidence 数组与 wildcardNote 里的 "backend/src/index.ts:NNN"
const patternInline = /backend\/src\/index\.ts:(\d+)/g
// 形态 2：specBasis 的 { "file": "backend/src/index.ts", "line": NNN, ... }
const patternSpecBasis = /("file":\s*"backend\/src\/index\.ts",\s*"line":\s*)(\d+)/g

const inlineHits = [...raw.matchAll(patternInline)].length
const specHits = [...raw.matchAll(patternSpecBasis)].length

if (check) {
  console.log(`inline=${inlineHits} specBasis=${specHits}（--check 不改文件）`)
  process.exit(0)
}

if (inlineHits + specHits === 0) {
  console.log('没有找到需要平移的行号；请确认是否已经平移过。')
  process.exit(0)
}

copyFileSync(TARGET, `${TARGET}.bak-r02`)

const shifted = raw
  .replace(patternInline, (_m, n) => `backend/src/index.ts:${Number(n) + SHIFT}`)
  .replace(patternSpecBasis, (_m, prefix, n) => `${prefix}${Number(n) + SHIFT}`)

writeFileSync(TARGET, shifted, 'utf8')
console.log(`已平移 ${inlineHits + specHits} 处（inline=${inlineHits}, specBasis=${specHits}），步长 +${SHIFT}`)
console.log(`原文件备份为 ${TARGET}.bak-r02`)
