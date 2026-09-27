import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const contract = JSON.parse(readFileSync(resolve(root, 'contracts/v2/catalog.json'), 'utf8'))
const text = '// 自动生成：node contracts/tools/generate-catalog-contract.mjs；禁止手改。\n' +
  `export const CATALOG_VERSION = ${JSON.stringify(contract.contractVersion)} as const\n` +
  `export const CATALOG_IMAGE_PRESETS = ${JSON.stringify(contract.imagePresets, null, 2)} as const\n` +
  Object.entries(contract.types).map(([name, fields]) => `export interface ${name} {\n${Object.entries(fields).map(([key, type]) => `  ${key}: ${type}`).join('\n')}\n}\n`).join('')
for (const target of ['contracts/generated-v2/catalog.ts', 'backend/src/contracts/v2/generated/catalog.ts', 'frontend/src/contracts/v2/generated/catalog.ts', 'miniprogram/contracts/v2/generated/catalog.ts']) {
  const path = resolve(root, target)
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== text) throw new Error(`商城契约漂移：${target}`)
  } else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
}
console.log('商城契约与三端类型一致')
