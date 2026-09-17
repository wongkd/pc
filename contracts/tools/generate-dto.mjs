#!/usr/bin/env node
/**
 * 跨端 DTO 生成器（T01c）
 *
 * 用途：从 contracts/v1 单向生成端内枚举与类型，供网页与原生小程序消费同一版本。
 * 运行：node contracts/tools/generate-dto.mjs          写入 contracts/generated/
 *       node contracts/tools/generate-dto.mjs --check  只比对，不写入；有差异则退出码 1
 *
 * 只做静态文本生成，不连接数据库、不部署、不读取生产数据。
 * 生成物禁止手工编辑；改了契约源文件必须重新生成本目录。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const contractsDir = resolve(here, '..')
const v1Dir = join(contractsDir, 'v1')
const outputDir = join(contractsDir, 'generated')
const repoRoot = resolve(contractsDir, '..')

export const GENERATOR_ID = 'contracts/tools/generate-dto.mjs'
export const GENERATOR_VERSION = '1'
export const GENERATE_COMMAND = 'node contracts/tools/generate-dto.mjs'
export const HEADER = '// AUTO-GENERATED FROM contracts/v1 — DO NOT EDIT'

const SOURCE_FILES = [
  'conventions.json',
  'enums.json',
  'objects.json',
  'errors.json',
  'money-rules.json',
  'actions.json'
]

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function readSource(file) {
  const path = join(v1Dir, file)
  const raw = readFileSync(path, 'utf8')
  return { file, path, raw, hash: sha256(raw), doc: JSON.parse(raw) }
}

function pascal(name) {
  return name
}

function constKey(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/** objects.json 的 type → TypeScript 类型 */
function tsTypeOf(field, enumNames) {
  const base = (() => {
    switch (field.type) {
      case 'id': return 'ContractId'
      case 'string': return 'string'
      case 'int': return 'number'
      case 'cents': return 'Cents'
      case 'bool': return 'boolean'
      case 'timestamp': return 'Instant'
      case 'date': return 'CalendarDate'
      case 'json': return 'JsonValue'
      case 'object': return 'JsonObject'
      case 'array': return 'JsonValue[]'
      case 'enum': {
        if (!enumNames.includes(field.enumRef)) {
          throw new Error(`枚举引用不存在：${field.enumRef}`)
        }
        return field.enumRef
      }
      default:
        throw new Error(`未知字段类型：${field.type}`)
    }
  })()
  return field.nullable ? `${base} | null` : base
}

function fieldComment(field) {
  const bits = []
  if (field.type === 'cents') bits.push('单位：分')
  if (field.desc) bits.push(field.desc)
  return bits.length ? ` // ${bits.join('；')}` : ''
}

function buildEnums(enumsDoc) {
  const lines = []
  lines.push(HEADER)
  lines.push(`// 生成命令：${GENERATE_COMMAND}`)
  lines.push('// 来源：contracts/v1/enums.json；取值唯一来源，两端不得各自新增。')
  lines.push('')
  lines.push('export type ContractId = string')
  lines.push('export type Cents = number')
  lines.push('export type Instant = string')
  lines.push('export type CalendarDate = string')
  lines.push('export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject')
  lines.push('export interface JsonObject { [key: string]: JsonValue }')
  lines.push('')

  const enumNames = Object.keys(enumsDoc.enums)
  for (const name of enumNames) {
    const def = enumsDoc.enums[name]
    lines.push(`/** ${def.desc ?? name} */`)
    lines.push(`export const ${name} = {`)
    for (const v of def.values) {
      lines.push(`  ${constKey(v)}: ${JSON.stringify(v)},`)
    }
    lines.push('} as const')
    lines.push(`export type ${name} = (typeof ${name})[keyof typeof ${name}]`)
    lines.push(`export const ${name}Values: readonly ${name}[] = Object.values(${name})`)
    lines.push('')
  }

  lines.push('// ── 状态机（取值与转换均由契约冻结；守卫文案仅供展示，程序分支依据 from/to/action）──')
  lines.push('export interface StateTransition {')
  lines.push('  from: string')
  lines.push('  to: string')
  lines.push('  action: string | null')
  lines.push('  guard: string')
  lines.push('}')
  lines.push('export const STATE_MACHINES: Record<string, { initial: string; transitions: StateTransition[] }> = {')
  for (const [name, machine] of Object.entries(enumsDoc.stateMachines)) {
    lines.push(`  ${JSON.stringify(name)}: {`)
    lines.push(`    initial: ${JSON.stringify(machine.initial)},`)
    lines.push('    transitions: [')
    for (const t of machine.transitions) {
      lines.push(`      { from: ${JSON.stringify(t.from)}, to: ${JSON.stringify(t.to)}, action: ${t.action === null ? 'null' : JSON.stringify(t.action)}, guard: ${JSON.stringify(t.guard)} },`)
    }
    lines.push('    ]')
    lines.push('  },')
  }
  lines.push('}')
  lines.push('')
  lines.push('// ── 库存桶规则（自有在库 = available + reserved + quarantine）──')
  lines.push(`export const OWN_ON_HAND_BUCKETS: readonly StockBucket[] = ${JSON.stringify(enumsDoc.inventoryBucketRules.ownOnHand)}`)
  lines.push(`export const EXCLUDED_BUCKETS: readonly StockBucket[] = ${JSON.stringify(enumsDoc.inventoryBucketRules.excluded)}`)
  lines.push('')
  lines.push('// ── 待补枚举（尚未定义取值，实现对应任务前必须先补契约）──')
  lines.push(`export const PENDING_ENUM_NAMES: readonly string[] = ${JSON.stringify(enumsDoc.pendingEnums.map((p) => p.name))}`)
  lines.push('')
  return lines.join('\n')
}

function buildObjects(objectsDoc, enumsDoc) {
  const enumNames = Object.keys(enumsDoc.enums)
  const baseImports = ['ContractId', 'Cents', 'Instant', 'CalendarDate', 'JsonValue', 'JsonObject']

  const body = []
  body.push('// 持久对象默认另含 CommonFields；正式事件类对象另含 EventFields 的相关子集。')
  body.push('// 生成器不自动合并这两组字段，避免把读模型也套上持久字段；是否需要由各端按使用场景显式组合。')
  body.push('export interface CommonFields {')
  for (const [k, v] of Object.entries(objectsDoc.commonFields)) {
    body.push(`  ${k}: ${tsTypeOf(v, enumNames)}${fieldComment(v)}`)
  }
  body.push('}')
  body.push('')
  body.push('export interface EventFields {')
  for (const [k, v] of Object.entries(objectsDoc.eventFields)) {
    body.push(`  ${k}: ${tsTypeOf(v, enumNames)}${fieldComment(v)}`)
  }
  body.push('}')
  body.push('')

  for (const [objName, obj] of Object.entries(objectsDoc.objects)) {
    body.push(`/** ${obj.desc} */`)
    body.push(`export interface ${pascal(objName)} {`)
    for (const [fieldName, field] of Object.entries(obj.fields)) {
      body.push(`  ${fieldName}: ${tsTypeOf(field, enumNames)}${fieldComment(field)}`)
    }
    body.push('}')
    body.push('')
  }

  // 只导入正文真正引用到的类型。
  // 原因：端内 tsconfig 开了 noUnusedLocals，全量导入会让生成物在网页端直接编译失败
  // （T02a 实测 6 处 TS6196）。导入集合由正文推导，不需要人工维护。
  const text = body.join('\n')
  const used = [...baseImports, ...enumNames].filter((name) =>
    new RegExp(`\\b${name}\\b`).test(text),
  )

  const lines = []
  lines.push(HEADER)
  lines.push(`// 生成命令：${GENERATE_COMMAND}`)
  lines.push('// 来源：contracts/v1/objects.json；字段与 nullable 以契约为准。')
  lines.push('import type {')
  lines.push(`  ${used.join(', ')},`)
  lines.push("} from './enums'")
  lines.push('')
  return lines.concat(body).join('\n')
}

function buildActions(actionsDoc, enumsDoc) {
  const lines = []
  lines.push(HEADER)
  lines.push(`// 生成命令：${GENERATE_COMMAND}`)
  lines.push('// 来源：contracts/v1/actions.json；动作码、路径、权限码的唯一来源。')
  lines.push("import type { ActionCode } from './enums'")
  lines.push('')
  lines.push('export interface ActionOperation {')
  lines.push('  method: string')
  lines.push('  path: string')
  lines.push('  permission: string | null')
  lines.push('}')
  lines.push('')

  lines.push('// ── 动作 → 路径 / 权限（完整请求路径 = /api/v2 + path）──')
  lines.push('export const ACTION_OPERATIONS: Record<ActionCode, readonly ActionOperation[]> = {')
  for (const act of actionsDoc.actions) {
    const ops = act.operations.map((op) => `{ method: ${JSON.stringify(op.method)}, path: ${JSON.stringify(op.path)}, permission: ${op.permission === null ? 'null' : JSON.stringify(op.permission)} }`)
    lines.push(`  ${JSON.stringify(act.code)}: [${ops.join(', ')}],`)
  }
  lines.push('}')
  lines.push('')
  lines.push('export const ACTION_NAMES: Record<ActionCode, string> = {')
  for (const act of actionsDoc.actions) lines.push(`  ${JSON.stringify(act.code)}: ${JSON.stringify(act.name)},`)
  lines.push('}')
  lines.push('')

  const uiRefs = {}
  for (const act of actionsDoc.actions) {
    for (const r of act.uiRefs ?? []) {
      if (!uiRefs[r]) uiRefs[r] = []
      uiRefs[r].push(act.code)
    }
  }
  lines.push('// ── 页面 → 该页可发起的动作（02 §5；每页至少一个，由契约校验脚本强制）──')
  lines.push('export const PAGE_ACTIONS: Record<string, readonly ActionCode[]> = {')
  for (const page of Object.keys(uiRefs).sort()) {
    lines.push(`  ${JSON.stringify(page)}: ${JSON.stringify(uiRefs[page])},`)
  }
  lines.push('}')
  lines.push('')

  lines.push('// ── 权限码──')
  lines.push('export type PermissionCode =')
  for (const perm of actionsDoc.permissionModel.codes) lines.push(`  | ${JSON.stringify(perm.code)}`)
  lines.push('')
  lines.push('export interface PermissionDefinition {')
  lines.push('  code: PermissionCode')
  lines.push('  domain: string')
  lines.push('  level: "action" | "field"')
  lines.push('  desc: string')
  lines.push('  grantPolicy: "default" | "explicit" | "owner_only"')
  lines.push('  legacySource: string | null')
  lines.push('}')
  lines.push('export const PERMISSIONS: readonly PermissionDefinition[] = [')
  for (const perm of actionsDoc.permissionModel.codes) {
    lines.push(`  { code: ${JSON.stringify(perm.code)}, domain: ${JSON.stringify(perm.domain)}, level: ${JSON.stringify(perm.level)}, desc: ${JSON.stringify(perm.desc)}, grantPolicy: ${JSON.stringify(perm.grantPolicy)}, legacySource: ${perm.legacySource === null ? 'null' : JSON.stringify(perm.legacySource)} },`)
  }
  lines.push(']')
  lines.push('')
  lines.push('// 字段级权限不守卫动作，只决定响应是否返回受限字段；不得当按钮权限使用。')
  lines.push('export const FIELD_LEVEL_PERMISSIONS: readonly PermissionCode[] = [')
  lines.push(`  ${actionsDoc.permissionModel.codes.filter((c) => c.level === 'field').map((c) => JSON.stringify(c.code)).join(', ')}`)
  lines.push(']')
  lines.push('')
  lines.push('// ── 补充动作（reserved 的不得由两端自行取名；specified 的路径已冻结）──')
  lines.push('export interface SupplementaryAction {')
  lines.push('  code: string')
  lines.push('  name: string')
  lines.push('  status: "reserved" | "specified"')
  lines.push('  path: string | null')
  lines.push('  permission: string | null')
  lines.push('  owner: string | null')
  lines.push('}')
  lines.push('export const SUPPLEMENTARY_ACTIONS: readonly SupplementaryAction[] = [')
  for (const act of actionsDoc.supplementaryActions) {
    lines.push(`  { code: ${JSON.stringify(act.code)}, name: ${JSON.stringify(act.name)}, status: ${JSON.stringify(act.status)}, path: ${act.path === null ? 'null' : JSON.stringify(act.path)}, permission: ${act.permission === null || act.permission === undefined ? 'null' : JSON.stringify(act.permission)}, owner: ${act.owner === null || act.owner === undefined ? 'null' : JSON.stringify(act.owner)} },`)
  }
  lines.push(']')
  lines.push('')
  lines.push('// ── 动作编号全集（含补充动作）──')
  lines.push(`export const ALL_ACTION_CODES: readonly string[] = ${JSON.stringify([
    ...actionsDoc.actions.map((a) => a.code),
    ...actionsDoc.supplementaryActions.map((a) => a.code)
  ])}`)
  lines.push('')
  return lines.join('\n')
}

function buildErrors(errorsDoc) {
  const lines = []
  lines.push(HEADER)
  lines.push(`// 生成命令：${GENERATE_COMMAND}`)
  lines.push('// 来源：contracts/v1/errors.json；程序分支只能依据 code，不得匹配 message 文本。')
  lines.push('')
  lines.push('export const ERROR_CODES = {')
  for (const e of errorsDoc.errors) lines.push(`  ${constKey(e.code)}: ${JSON.stringify(e.code)},`)
  lines.push('} as const')
  lines.push('export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]')
  lines.push('')
  lines.push('export interface ErrorDefinition {')
  lines.push('  code: ErrorCode')
  lines.push('  httpStatus: number')
  lines.push('  meaning: string')
  lines.push('  clientHandling: string')
  lines.push('  retryable: boolean')
  lines.push('}')
  lines.push('export const ERRORS: readonly ErrorDefinition[] = [')
  for (const e of errorsDoc.errors) {
    lines.push(`  { code: ${JSON.stringify(e.code)}, httpStatus: ${e.httpStatus}, meaning: ${JSON.stringify(e.meaning)}, clientHandling: ${JSON.stringify(e.clientHandling)}, retryable: ${e.retryable} },`)
  }
  lines.push(']')
  lines.push('')
  lines.push('// 结果未知的处理流程：以原 requestId 查询 /operations/:requestId，不按失败直接重发新 ID。')
  lines.push(`export const UNKNOWN_RESULT_PROCEDURE: readonly string[] = ${JSON.stringify(errorsDoc.unknownResultProcedure)}`)
  lines.push('')
  return lines.join('\n')
}

function buildMoney(moneyDoc, conventions) {
  const lines = []
  lines.push(HEADER)
  lines.push(`// 生成命令：${GENERATE_COMMAND}`)
  lines.push('// 来源：contracts/v1/money-rules.json、conventions.json；只导出公式编号与单位口径，不生成计算实现。')
  lines.push("import type { Cents } from './enums'")
  lines.push('')
  lines.push('// 金额一律整数分，禁止浮点；界面按元显示，运算与传输只用分。')
  lines.push(`export type Money = Cents`)
  lines.push(`export const CURRENCY = ${JSON.stringify(conventions.money.currency)} as const`)
  lines.push(`export const CURRENCY_SYMBOL = ${JSON.stringify(conventions.money.symbol)} as const`)
  lines.push(`export const MONEY_UNIT = ${JSON.stringify(conventions.money.unit)} as const`)
  lines.push('')
  lines.push('export const MONEY_FORMULA_IDS = {')
  for (const f of moneyDoc.formulas) lines.push(`  ${constKey(f.id)}: ${JSON.stringify(f.id)},`)
  lines.push('} as const')
  lines.push('export type MoneyFormulaId = (typeof MONEY_FORMULA_IDS)[keyof typeof MONEY_FORMULA_IDS]')
  lines.push('')
  lines.push('export interface MoneyFormula {')
  lines.push('  id: MoneyFormulaId')
  lines.push('  definition: string')
  lines.push('  expression: string')
  lines.push('  objectFields: readonly string[]')
  lines.push('  derivedTerms: readonly string[]')
  lines.push('  note: string')
  lines.push('}')
  lines.push('export const MONEY_FORMULAS: readonly MoneyFormula[] = [')
  for (const f of moneyDoc.formulas) {
    lines.push(`  { id: ${JSON.stringify(f.id)}, definition: ${JSON.stringify(f.definition)}, expression: ${JSON.stringify(f.expression)}, objectFields: ${JSON.stringify(f.objectFields)}, derivedTerms: ${JSON.stringify(f.derivedTerms)}, note: ${JSON.stringify(f.note)} },`)
  }
  lines.push(']')
  lines.push('')
  lines.push('// 计算结果以服务端重算为准；客户端算出的值只作展示，不作为权威值。')
  lines.push('export const MONEY_SERVER_AUTHORITY = true as const')
  lines.push('')
  return lines.join('\n')
}

export function buildArtifacts() {
  const sources = {}
  for (const file of SOURCE_FILES) sources[file] = readSource(file)

  const conventions = sources['conventions.json'].doc
  const enumsDoc = sources['enums.json'].doc
  const objectsDoc = sources['objects.json'].doc
  const errorsDoc = sources['errors.json'].doc
  const moneyDoc = sources['money-rules.json'].doc
  const actionsDoc = sources['actions.json'].doc

  const files = {
    'enums.ts': buildEnums(enumsDoc),
    'objects.ts': buildObjects(objectsDoc, enumsDoc),
    'actions.ts': buildActions(actionsDoc, enumsDoc),
    'errors.ts': buildErrors(errorsDoc),
    'money.ts': buildMoney(moneyDoc, conventions)
  }

  const generatedFrom = {}
  for (const file of SOURCE_FILES) generatedFrom[`contracts/v1/${file}`] = sources[file].hash

  const artifactHashes = {}
  for (const [name, content] of Object.entries(files)) artifactHashes[name] = sha256(content)

  const manifest = {
    generator: GENERATOR_ID,
    generatorVersion: GENERATOR_VERSION,
    command: GENERATE_COMMAND,
    checkCommand: `${GENERATE_COMMAND} --check`,
    neutralOutputDir: 'contracts/generated',
    contractVersion: conventions.contractVersion,
    contractsFrozenBy: [conventions.frozenBy, actionsDoc.frozenBy, 'T01c'],
    headerRule: HEADER,
    editPolicy: '生成物禁止手工编辑；改契约源文件后重新生成。validate-contracts.mjs 第 12 节重算本清单的哈希。',
    targets: [
      { id: 'web', rootPath: 'frontend/src/contracts/generated', owner: 'T02a', status: 'pending' },
      { id: 'miniprogram', rootPath: 'miniprogram/contracts/generated', owner: 'T02b', status: 'pending' }
    ],
    generatedFrom,
    artifacts: Object.keys(files).sort().map((name) => ({ file: name, sha256: artifactHashes[name] })),
    selfHashNote: 'manifest.json 与 artifacts 的 sha256 均指文件正文（不含 manifest 自身哈希）。'
  }
  files['manifest.json'] = JSON.stringify(manifest, null, 2) + '\n'

  return { files, manifest }
}

function checkOnly() {
  const { files } = buildArtifacts()
  const diffs = []
  for (const [name, content] of Object.entries(files)) {
    const path = join(outputDir, name)
    if (!existsSync(path)) {
      diffs.push(`缺失：${name}`)
      continue
    }
    const onDisk = readFileSync(path, 'utf8')
    if (onDisk !== content) diffs.push(`内容不一致：${name}`)
  }
  if (existsSync(outputDir)) {
    for (const name of readdirSync(outputDir)) {
      if (!Object.prototype.hasOwnProperty.call(files, name)) diffs.push(`多余文件：${name}`)
    }
  }
  if (diffs.length) {
    console.error('生成物与契约不一致：')
    for (const d of diffs) console.error('  ✗ ' + d)
    console.error(`\n请运行：${GENERATE_COMMAND}`)
    process.exit(1)
  }
  console.log(`✓ 生成物与 contracts/v1 一致（${Object.keys(files).length} 个文件）`)
}

function write() {
  const { files } = buildArtifacts()
  mkdirSync(outputDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(outputDir, name), content, 'utf8')
    console.log(`  写入 contracts/generated/${name}`)
  }
  console.log(`\n✓ 已从 contracts/v1 生成 ${Object.keys(files).length} 个文件。生成物禁止手工编辑。`)
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  if (process.argv.includes('--check')) checkOnly()
  else write()
}
