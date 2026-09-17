#!/usr/bin/env node
/**
 * 从 contracts/v1/errors.json 生成后端错误码常量。
 *
 * 为什么需要：契约是两端唯一协议来源；后端若手写一份错误码副本，
 * 早晚与契约漂移。这里做单向生成，生成物禁止手改（首行 DO NOT EDIT）。
 *
 * 用法：
 *   node scripts/sync-error-codes.mjs           # 写入
 *   node scripts/sync-error-codes.mjs --check   # 只校验，不写入；漂移则退出码 1
 *
 * 工作目录无关：路径基于本文件位置推导。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const backendRoot = resolve(here, '..')
const repoRoot = resolve(backendRoot, '..')
const source = join(repoRoot, 'contracts', 'v1', 'errors.json')
const target = join(backendRoot, 'src', 'generated', 'error-codes.ts')

const checkOnly = process.argv.includes('--check')

if (!existsSync(source)) {
  console.error(`✗ 找不到契约错误码文件：${source}`)
  process.exit(1)
}

const document = JSON.parse(readFileSync(source, 'utf8'))
const raw = document.errors
if (!Array.isArray(raw) || raw.length === 0) {
  console.error('✗ contracts/v1/errors.json 的 errors 不是非空数组，拒绝生成')
  process.exit(1)
}
const contractVersion = document.contractVersion ?? 'unknown'
const frozenBy = document.frozenBy ?? 'unknown'

const required = ['httpStatus', 'code', 'meaning', 'retryable']
for (const [i, item] of raw.entries()) {
  for (const key of required) {
    if (!(key in item)) {
      console.error(`✗ errors.json 第 ${i} 项缺少字段 ${key}`)
      process.exit(1)
    }
  }
}

const codes = raw.map((e) => e.code)
if (new Set(codes).size !== codes.length) {
  console.error('✗ errors.json 存在重复的错误码')
  process.exit(1)
}

const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

const literal = raw
  .map(
    (e) =>
      `  { httpStatus: ${e.httpStatus}, code: ${quote(e.code)}, ` +
      `retryable: ${e.retryable ? 'true' : 'false'}, meaning: ${quote(e.meaning)} },`,
  )
  .join('\n')

const union = raw.map((e) => `  | ${quote(e.code)}`).join('\n')

const output = `// DO NOT EDIT — 本文件由 backend/scripts/sync-error-codes.mjs 生成。
// 来源：contracts/v1/errors.json（${contractVersion}，${frozenBy} 冻结，${raw.length} 个错误码）。
// 重新生成：node backend/scripts/sync-error-codes.mjs
// 校验漂移：node backend/scripts/sync-error-codes.mjs --check
//
// 结果未知时的处置见契约 unknownResultProcedure：保存 requestId 与载荷摘要，
// 再以操作结果查询接口确认，不把「网络超时」当作失败。

export type ErrorCode =
${union}

export interface ErrorDefinition {
  httpStatus: number
  code: ErrorCode
  retryable: boolean
  meaning: string
}

export const ERROR_DEFINITIONS: readonly ErrorDefinition[] = [
${literal}
]

const byCode = new Map<string, ErrorDefinition>()
for (const definition of ERROR_DEFINITIONS) {
  byCode.set(definition.code, definition)
}

/** 按错误码取定义；未知码返回 undefined，调用方必须自行兜底。 */
export function findErrorDefinition(code: string): ErrorDefinition | undefined {
  return byCode.get(code)
}

/** 判断任意字符串是否为契约内已登记的错误码。 */
export function isErrorCode(value: string): value is ErrorCode {
  return byCode.has(value)
}
`

mkdirSync(dirname(target), { recursive: true })

if (checkOnly) {
  if (!existsSync(target)) {
    console.error(`✗ 生成物不存在：${target}`)
    process.exit(1)
  }
  const current = readFileSync(target, 'utf8')
  if (current !== output) {
    console.error('✗ 后端错误码生成物与契约不一致（已漂移）')
    console.error('  运行 node backend/scripts/sync-error-codes.mjs 重新生成')
    process.exit(1)
  }
  console.log(`✓ 后端错误码生成物与契约一致（${raw.length} 个错误码）`)
  process.exit(0)
}

writeFileSync(target, output, 'utf8')
console.log(`✓ 已生成 ${target}（${raw.length} 个错误码）`)
