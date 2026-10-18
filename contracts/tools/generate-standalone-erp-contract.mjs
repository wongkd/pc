import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = 'contracts/v2/standalone-erp.json'
const doc = JSON.parse(readFileSync(resolve(root, source), 'utf8'))
if (doc.inherits !== 'v1.2' || doc.contractVersion !== 'v2-standalone-erp-1') throw new Error('独立ERP增量版本不匹配')
const lines = [`// AUTO-GENERATED FROM ${source} — DO NOT EDIT`, '']
for (const item of doc.interfaces) {
  if (!/^[A-Z]\w+$/.test(item.name)) throw new Error('接口名无效')
  lines.push(`export interface ${item.name} {`)
  for (const [name, type] of Object.entries(item.fields)) {
    if (!/^\w+$/.test(name) || !/^(string|number|boolean)(\[\])?$/.test(type)) throw new Error('字段类型无效')
    lines.push(`  ${name}: ${type}`)
  }
  lines.push('}', '')
}
const output = lines.join('\n')
for (const file of ['contracts/generated-v2/standalone-erp.ts', 'backend/src/generated/standalone-erp-v2.ts', 'frontend/src/contracts/v2/generated/standalone-erp.ts', 'miniprogram/contracts/generated/standalone-erp.ts']) {
  const path = resolve(root, file)
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== output) throw new Error(`生成物漂移：${file}`)
  } else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, output) }
}
console.log('独立ERP增量契约与四处生成物一致')
