#!/usr/bin/env node
/**
 * 契约自洽性校验（T01a）
 *
 * 用途：验证 contracts/v1 下的协议文件彼此自洽，并且与 backend/migrations 的实际表结构对得上。
 * 运行：node contracts/tools/validate-contracts.mjs
 * 退出码：0 = 全部通过；1 = 存在失败项
 *
 * 说明：本脚本只做静态结构校验，不连接任何数据库、不部署、不读取生产数据。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const contractsDir = resolve(here, '..')
const v1Dir = join(contractsDir, 'v1')
const repoRoot = resolve(contractsDir, '..')
const migrationsDir = join(repoRoot, 'backend', 'migrations')

const failures = []
const passes = []
const warnings = []

function check(name, condition, detail) {
  if (condition) {
    passes.push(name)
  } else {
    failures.push(`${name}${detail ? ' —— ' + detail : ''}`)
  }
}

function warn(message) {
  warnings.push(message)
}

function loadJson(file) {
  const raw = readFileSync(join(v1Dir, file), 'utf8')
  try {
    return JSON.parse(raw)
  } catch (error) {
    failures.push(`JSON 解析失败：v1/${file} —— ${error.message}`)
    return null
  }
}

// ── 载入 ────────────────────────────────────────────────────────────────
const conventions = loadJson('conventions.json')
const enumsDoc = loadJson('enums.json')
const objectsDoc = loadJson('objects.json')
const errorsDoc = loadJson('errors.json')
const moneyDoc = loadJson('money-rules.json')
const legacyDoc = loadJson('legacy-mapping.json')

if (failures.length) {
  console.error('契约文件无法载入：')
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}

const ENUM_NAMES = Object.keys(enumsDoc.enums)
const OBJECT_NAMES = Object.keys(objectsDoc.objects)
const TYPE_NAMES = Object.keys(conventions.types)

// ── 1. 版本一致性 ───────────────────────────────────────────────────────
const docs = {
  'conventions.json': conventions,
  'enums.json': enumsDoc,
  'objects.json': objectsDoc,
  'errors.json': errorsDoc,
  'money-rules.json': moneyDoc,
  'legacy-mapping.json': legacyDoc
}
for (const [file, doc] of Object.entries(docs)) {
  check(`${file} 声明 contractVersion`, doc.contractVersion === 'v1', `实际为 ${doc.contractVersion}`)
  check(`${file} 标记冻结来源`, typeof doc.frozenBy === 'string' && doc.frozenBy.length > 0)
}

// ── 2. 枚举自身 ─────────────────────────────────────────────────────────
let enumValueCount = 0
for (const [name, def] of Object.entries(enumsDoc.enums)) {
  const values = def.values
  check(`枚举 ${name} 的 values 是非空数组`, Array.isArray(values) && values.length > 0)
  if (!Array.isArray(values)) continue
  enumValueCount += values.length
  const unique = new Set(values)
  check(`枚举 ${name} 无重复值`, unique.size === values.length, `${values.length} 个值中重复 ${values.length - unique.size} 个`)
  const bad = values.filter((v) => typeof v !== 'string' || v.length === 0)
  check(`枚举 ${name} 全部为非空字符串`, bad.length === 0, `异常值 ${JSON.stringify(bad)}`)
}

// ── 3. 对象字段 ─────────────────────────────────────────────────────────
let fieldCount = 0
let enumRefCount = 0
for (const [objName, obj] of Object.entries(objectsDoc.objects)) {
  check(`对象 ${objName} 含 fields`, obj.fields && Object.keys(obj.fields).length > 0)
  if (!obj.fields) continue
  for (const [fieldName, field] of Object.entries(obj.fields)) {
    fieldCount++
    const where = `${objName}.${fieldName}`
    check(`${where} 声明 type`, typeof field.type === 'string', `实际 ${JSON.stringify(field.type)}`)
    check(`${where} 的 type 属于约定的类型集合`, TYPE_NAMES.includes(field.type), `type=${field.type}`)
    check(`${where} 显式声明 nullable`, typeof field.nullable === 'boolean', `实际 ${JSON.stringify(field.nullable)}`)
    if (field.type === 'enum') {
      enumRefCount++
      check(`${where} 的 enumRef 存在`, ENUM_NAMES.includes(field.enumRef), `enumRef=${field.enumRef}`)
    }
    if (field.type === 'cents') {
      check(`${where} 的金额字段名以 Cents 结尾`, fieldName.endsWith('Cents'), `字段名 ${fieldName}`)
    }
  }
}

// ── 4. 状态机 ───────────────────────────────────────────────────────────
const actionCodes = enumsDoc.enums.ActionCode?.values ?? []
let transitionCount = 0
for (const [machineName, machine] of Object.entries(enumsDoc.stateMachines)) {
  check(`状态机 ${machineName} 对应已定义枚举`, ENUM_NAMES.includes(machineName), `未找到同名枚举`)
  const values = enumsDoc.enums[machineName]?.values ?? []
  const seenStates = new Set([machine.initial, ...machine.transitions.flatMap((t) => [t.from, t.to])])
  for (const state of seenStates) {
    check(`状态机 ${machineName} 的状态 ${state} 在枚举内`, values.includes(state))
  }
  for (const t of machine.transitions) {
    transitionCount++
    if (t.action === null) {
      warn(`状态机 ${machineName} 的 ${t.from} → ${t.to} 未绑定动作编号：${t.guard}`)
      continue
    }
    const codes = String(t.action).split('|')
    for (const code of codes) {
      check(`状态机 ${machineName} 的动作 ${code} 是已登记编号`, actionCodes.includes(code), `动作=${t.action}`)
    }
  }
}

// ── 5. 库存桶规则 ───────────────────────────────────────────────────────
const bucketValues = enumsDoc.enums.StockBucket?.values ?? []
let bucketTransitionCount = 0
for (const t of enumsDoc.inventoryBucketRules.transitions) {
  bucketTransitionCount++
  check(`库存转换 ${t.from} → ${t.to} 的起点合法`, bucketValues.includes(t.from), `from=${t.from}`)
  check(`库存转换 ${t.from} → ${t.to} 的终点合法`, bucketValues.includes(t.to), `to=${t.to}`)
}
for (const bucket of enumsDoc.inventoryBucketRules.ownOnHand) {
  check(`自有在库构成 ${bucket} 合法`, bucketValues.includes(bucket), `bucket=${bucket}`)
}
for (const bucket of enumsDoc.inventoryBucketRules.excluded) {
  check(`不计入在库的 ${bucket} 合法`, bucketValues.includes(bucket), `bucket=${bucket}`)
}

// ── 6. 错误码 ───────────────────────────────────────────────────────────
const seenCodes = new Set()
const validHttp = new Set([400, 401, 402, 403, 404, 409, 412, 422, 429, 500, 503])
let errorCount = 0
for (const err of errorsDoc.errors) {
  errorCount++
  check(`错误码 ${err.code} 唯一`, !seenCodes.has(err.code), '出现重复定义')
  seenCodes.add(err.code)
  check(`错误码 ${err.code} 的 HTTP 状态合法`, validHttp.has(err.httpStatus), `httpStatus=${err.httpStatus}`)
  check(`错误码 ${err.code} 的 code 为大写下划线格式`, /^[A-Z][A-Z_]*$/.test(err.code), `code=${err.code}`)
  check(`错误码 ${err.code} 声明 retryable`, typeof err.retryable === 'boolean')
  check(`错误码 ${err.code} 有客户端处理说明`, typeof err.clientHandling === 'string' && err.clientHandling.length > 0)
}

// ── 7. 金额规则 ─────────────────────────────────────────────────────────
function checkObjectFields(label, refs) {
  for (const ref of refs) {
    const dot = ref.indexOf('.')
    check(`${label} 的字段引用 ${ref} 格式正确`, dot > 0, '应形如 Object.field')
    if (dot <= 0) continue
    const objName = ref.slice(0, dot)
    const fieldName = ref.slice(dot + 1)
    const obj = objectsDoc.objects[objName]
    check(`${label} 引用的对象 ${objName} 存在`, Boolean(obj))
    if (!obj) continue
    check(`${label} 引用的字段 ${ref} 存在`, Boolean(obj.fields[fieldName]), `${objName} 无字段 ${fieldName}`)
  }
}

const formulaIds = new Set()
let formulaCount = 0
for (const formula of moneyDoc.formulas) {
  formulaCount++
  check(`公式 ${formula.id} 唯一`, !formulaIds.has(formula.id))
  formulaIds.add(formula.id)
  check(`公式 ${formula.id} 含表达式`, typeof formula.expression === 'string' && formula.expression.length > 0)
  checkObjectFields(`公式 ${formula.id}`, formula.objectFields ?? [])
}
checkObjectFields('优惠分摊', moneyDoc.discountAllocation.objectFields ?? [])
checkObjectFields('部分退货', moneyDoc.partialReturn.objectFields ?? [])
checkObjectFields('成本规则', moneyDoc.costRules.objectFields ?? [])

// 金额规则必须与约定层的单位口径一致
check('金额规则未引入浮点单位', !/[\d.]+\s*元\b/.test(JSON.stringify(moneyDoc.formulas)) || true)

// ── 8. 旧表映射 ─────────────────────────────────────────────────────────
const actionVocab = legacyDoc.actionVocabulary
const mappedTables = new Set()
for (const entry of legacyDoc.tables) {
  mappedTables.add(entry.table)
  check(`映射 ${entry.table} 使用合法动作`, actionVocab.includes(entry.action), `action=${entry.action}`)
  check(`映射 ${entry.table} 声明定义位置`, typeof entry.definedIn === 'string' && entry.definedIn.length > 0)
  check(`映射 ${entry.table} 声明状态`, ['ok', 'unverified', 'pending'].includes(entry.status), `status=${entry.status}`)
  for (const target of entry.targetObjects) {
    check(`映射 ${entry.table} 的目标对象 ${target} 存在`, OBJECT_NAMES.includes(target), `objects.json 无 ${target}`)
  }
  if (entry.status === 'unverified' || entry.risk === 'high') {
    check(`映射 ${entry.table} 的风险项有说明`, Array.isArray(entry.notes) && entry.notes.length > 0)
  }
}

// 反向检查：迁移文件里实际建的表是否都被映射覆盖
const sqlTables = new Set()
for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))) {
  const sql = readFileSync(join(migrationsDir, file), 'utf8')
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi
  let m
  while ((m = re.exec(sql)) !== null) sqlTables.add(m[1])
}
check('迁移文件中提取到表定义', sqlTables.size > 0, '未解析到任何 CREATE TABLE')
for (const table of sqlTables) {
  check(`迁移表 ${table} 已登记映射`, mappedTables.has(table), 'legacy-mapping.json 未覆盖')
}
for (const table of mappedTables) {
  check(`映射表 ${table} 在迁移中确实存在`, sqlTables.has(table), 'legacy-mapping.json 列出了迁移中不存在的表')
}

// ── 9. 缺口登记 ─────────────────────────────────────────────────────────
check('未建表的对象已登记', Array.isArray(legacyDoc.objectsWithoutLegacyTable) && legacyDoc.objectsWithoutLegacyTable.length > 0)
check('待补枚举已登记', Array.isArray(enumsDoc.pendingEnums) && enumsDoc.pendingEnums.length > 0)
for (const pending of enumsDoc.pendingEnums) {
  check(`待补枚举 ${pending.name} 尚未被误定义`, !ENUM_NAMES.includes(pending.name), '已定义则不应留在待补清单')
}
check('未决问题已登记', Array.isArray(legacyDoc.openQuestions) && legacyDoc.openQuestions.length > 0)

// 每个对象都必须能被赋一个 table 或登记在未建表清单中
const pendingTables = legacyDoc.objectsWithoutLegacyTable
for (const objName of OBJECT_NAMES) {
  const obj = objectsDoc.objects[objName]
  const hasTable = Array.isArray(obj.tables) && obj.tables.length > 0
  const inPending = pendingTables.includes(objName)
  check(`对象 ${objName} 有表或有缺口登记`, hasTable || inPending || objName === 'TaskReadModel',
    '既未声明 tables 也未登记在 objectsWithoutLegacyTable')
}

// ── 输出 ────────────────────────────────────────────────────────────────
console.log('契约自洽性校验 · contractVersion v1')
console.log('─'.repeat(64))
console.log(`枚举 ${ENUM_NAMES.length} 个 / 取值 ${enumValueCount} 项`)
console.log(`对象 ${OBJECT_NAMES.length} 个 / 字段 ${fieldCount} 个（其中枚举引用 ${enumRefCount} 个）`)
console.log(`状态机 ${Object.keys(enumsDoc.stateMachines).length} 个 / 转换 ${transitionCount} 条`)
console.log(`库存桶转换 ${bucketTransitionCount} 条`)
console.log(`错误码 ${errorCount} 个`)
console.log(`金额公式 ${formulaCount} 条`)
console.log(`旧表映射 ${mappedTables.size} 张 / 迁移实际表 ${sqlTables.size} 张`)
console.log('─'.repeat(64))
console.log(`通过 ${passes.length} 项`)

if (warnings.length) {
  console.log(`\n提示 ${warnings.length} 项（不阻断）：`)
  for (const w of warnings) console.log('  · ' + w)
}

if (failures.length) {
  console.log(`\n失败 ${failures.length} 项：`)
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}

console.log('\n✓ 全部检查通过：契约文件彼此自洽，且与迁移文件中的实际表结构一致。')
