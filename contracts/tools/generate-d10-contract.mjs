#!/usr/bin/env node
/** Generate the D10 v2 inventory-opening contract and sync both TypeScript clients. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const sourcePath = join(root, 'contracts/v2/inventory-opening.json')
const outputs = [
  'contracts/generated-v2/inventory-opening.ts',
  'backend/src/generated/inventory-opening-v2.ts',
  'frontend/src/contracts/v2/generated/inventory-opening.ts',
].map((path) => join(root, path))
const checkOnly = process.argv.includes('--check')

const doc = JSON.parse(readFileSync(sourcePath, 'utf8'))
if (doc.contractVersion !== 'v2' || doc.inherits !== 'v1.1') throw new Error('D10 扩展必须为继承 v1.1 的 v2 契约')
const expectedBases = ['known_actual', 'assessed_estimate', 'unknown', 'zero_cost']
const costBases = doc.types.find((type) => type.name === 'OpeningCostBasis')?.values
if (JSON.stringify(costBases) !== JSON.stringify(expectedBases)) throw new Error('D10 四类成本必须逐项保持已冻结顺序与名称')
if (doc.openingWindow?.activation?.durationDays?.min !== 1 || doc.openingWindow?.activation?.durationDays?.max !== 7
  || doc.openingWindow?.reopen !== false || doc.openingWindow?.previewStartsWindow !== false
  || !doc.openingWindow?.closeRules?.includes('first_business_movement') || !doc.openingWindow?.closeRules?.includes('deadline')) {
  throw new Error('D10 窗口规则必须是 1 至 7 天、首笔正式库存流水或截止关闭、不可重开，且预览不启动')
}
const lineInterface = doc.interfaces.find((iface) => iface.name === 'FormalOpeningLineInput')
if (!lineInterface?.fields.some((field) => field.name === 'approvedCountLineRef' && !field.optional)
  || !lineInterface?.fields.some((field) => field.name === 'costBasis' && !field.optional)) {
  throw new Error('正式 D10 每行必须包含盘点行引用与成本类型')
}
const id = (value) => /^[A-Za-z_$][\w$]*$/.test(value)
const typeExpr = (value) => /^[A-Za-z0-9_$'|<>,.[\] ?]+$/.test(value)
const chunks = ['// AUTO-GENERATED FROM contracts/v2/inventory-opening.json — DO NOT EDIT', '']

for (const type of doc.types) {
  if (!id(type.name) || !id(type.constant) || !Array.isArray(type.values) || !type.values.every((v) => typeof v === 'string')) {
    throw new Error(`无效的 v2 字符串联合：${type.name}`)
  }
  chunks.push(`export const ${type.constant} = ${JSON.stringify(type.values)} as const`)
  chunks.push(`export type ${type.name} = (typeof ${type.constant})[number]`, '')
}

for (const iface of doc.interfaces) {
  if (!id(iface.name) || !Array.isArray(iface.fields)) throw new Error(`无效的 v2 接口：${iface.name}`)
  chunks.push(`export interface ${iface.name} {`)
  for (const field of iface.fields) {
    if (!id(field.name) || !typeExpr(field.type)) throw new Error(`无效字段：${iface.name}.${field.name}`)
    chunks.push(`  ${field.name}${field.optional ? '?' : ''}: ${field.type}`)
  }
  chunks.push('}', '')
}

const artifact = `${chunks.join('\n').trimEnd()}\n`
const failures = []
for (const path of outputs) {
  if (checkOnly) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== artifact) failures.push(path.slice(root.length + 1))
  } else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, artifact, 'utf8')
  }
}

if (failures.length) {
  console.error(`D10 v2 生成物与唯一来源不一致：\n${failures.map((path) => `- ${path}`).join('\n')}\n运行 node contracts/tools/generate-d10-contract.mjs`)
  process.exit(1)
}
console.log(checkOnly ? '✓ D10 v2 契约生成物与网页端、后端副本一致' : '✓ 已生成 D10 v2 契约及两端副本')
