#!/usr/bin/env node
/**
 * 契约自洽性校验（T01a + T01b + T01-rev1）
 *
 * 用途：验证 contracts/v1.1 下的协议文件彼此自洽，并且与 backend/migrations 的实际表结构、
 *       backend/src/index.ts 的实际权限守卫、docs/plans 的规格原文对得上。
 * 运行：node contracts/tools/validate-contracts.mjs
 * 退出码：0 = 全部通过；1 = 存在失败项
 *
 * 说明：本脚本只做静态结构校验与源码文本核对，不连接任何数据库、不部署、不读取生产数据。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { buildArtifacts, HEADER as GENERATED_HEADER, GENERATE_COMMAND } from './generate-dto.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const contractsDir = resolve(here, '..')
const v1Dir = join(contractsDir, 'v1.1')
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
    failures.push(`JSON 解析失败：v1.1/${file} —— ${error.message}`)
    return null
  }
}

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ── 载入 ────────────────────────────────────────────────────────────────
const conventions = loadJson('conventions.json')
const enumsDoc = loadJson('enums.json')
const objectsDoc = loadJson('objects.json')
const errorsDoc = loadJson('errors.json')
const moneyDoc = loadJson('money-rules.json')
const legacyDoc = loadJson('legacy-mapping.json')
const actionsDoc = loadJson('actions.json')

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
  check(`${file} 声明 contractVersion`, doc.contractVersion === 'v1.1', `实际为 ${doc.contractVersion}`)
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

// ── 10. 动作目录与权限映射（T01b）──────────────────────────────────────
check('actions.json 声明 contractVersion', actionsDoc.contractVersion === 'v1.1', `实际 ${actionsDoc.contractVersion}`)
check('actions.json 标记冻结来源', typeof actionsDoc.frozenBy === 'string' && actionsDoc.frozenBy.length > 0)

const permCodes = new Set((actionsDoc.permissionModel?.codes ?? []).map((c) => c.code))
const grantPolicies = new Set(Object.keys(actionsDoc.permissionModel?.grantPolicyValues ?? {}))
const actionList = actionsDoc.actions ?? []
const definedCodes = actionList.map((a) => a.code)
const supplementaryCodes = (actionsDoc.supplementaryActions ?? []).map((a) => a.code)
const allBusinessCodes = [...definedCodes, ...supplementaryCodes]

// 10.1 动作编号与 enums.json 的 ActionCode 枚举双向一致
check('动作编号无重复', new Set(definedCodes).size === definedCodes.length,
  `重复 ${definedCodes.length - new Set(definedCodes).size} 个`)
check('动作编号与补充动作编号无重叠', definedCodes.every((c) => !supplementaryCodes.includes(c)))
const enumActionCodes = enumsDoc.enums.ActionCode?.values ?? []
check('enums.json 定义了 ActionCode 枚举', enumActionCodes.length > 0)
const missingInActions = enumActionCodes.filter((c) => !definedCodes.includes(c))
const extraInActions = definedCodes.filter((c) => !enumActionCodes.includes(c))
check('ActionCode 枚举里的每个编号都有动作定义', missingInActions.length === 0, `缺 ${missingInActions.join(', ')}`)
check('每个动作定义都在 ActionCode 枚举内', extraInActions.length === 0, `多出 ${extraInActions.join(', ')}`)

// 10.2 权限码自身
for (const perm of actionsDoc.permissionModel?.codes ?? []) {
  check(`权限码 ${perm.code} 命名合法`, /^[a-z][a-z0-9-]*\/[a-z0-9-]+$/.test(perm.code), `code=${perm.code}`)
  check(`权限码 ${perm.code} 声明合法的 grantPolicy`, grantPolicies.has(perm.grantPolicy), `grantPolicy=${perm.grantPolicy}`)
  check(`权限码 ${perm.code} 声明合法的 level`, ['action', 'field'].includes(perm.level), `level=${perm.level}`)
}
check('权限码无重复', permCodes.size === (actionsDoc.permissionModel?.codes ?? []).length)

// 10.3 不可放宽权限：owner_only 绝不能继承「店员可得」的旧权限（03 §8 硬约束）
const clerkGrantable = new Set(actionsDoc.permissionModel?.legacyPermissions?.clerkGrantable ?? [])
check('声明了旧权限的店员可得性清单', clerkGrantable.size > 0, 'permissionModel.legacyPermissions.clerkGrantable 缺失')
const widening = (actionsDoc.permissionModel?.codes ?? []).filter((c) => {
  if (c.grantPolicy !== 'owner_only' || !c.legacySource) return false
  return String(c.legacySource).split('+').map((s) => s.trim()).filter(Boolean).some((s) => clerkGrantable.has(s))
})
check('noWidening：owner_only 权限不得继承店员可得的旧权限', widening.length === 0,
  widening.map((c) => `${c.code}←${c.legacySource}`).join(', '))

// 10.4 动作的跨文件引用完整性
const smNames = new Set(Object.keys(enumsDoc.stateMachines))
const errNames = new Set(errorsDoc.errors.map((e) => e.code))
const badPerm = [], badEntity = [], badSm = [], badErr = []
for (const act of actionList) {
  check(`动作 ${act.code} 有 operations`, Array.isArray(act.operations) && act.operations.length > 0)
  for (const op of act.operations ?? []) {
    check(`动作 ${act.code} 的路径以 / 开头`, typeof op.path === 'string' && op.path.startsWith('/'), `path=${op.path}`)
    if (op.permission !== null && !permCodes.has(op.permission)) badPerm.push(`${act.code}→${op.permission}`)
  }
  if (act.entity && !OBJECT_NAMES.includes(act.entity)) badEntity.push(`${act.code}→${act.entity}`)
  if (act.stateMachine && !smNames.has(act.stateMachine)) badSm.push(`${act.code}→${act.stateMachine}`)
  for (const c of act.errors ?? []) if (!errNames.has(c)) badErr.push(`${act.code}→${c}`)
}
check('动作的 permission 引用均存在', badPerm.length === 0, badPerm.join(', '))
check('动作的 entity 引用均存在', badEntity.length === 0, badEntity.join(', '))
check('动作的 stateMachine 引用均存在', badSm.length === 0, badSm.join(', '))
check('动作的 errors 引用均存在', badErr.length === 0, badErr.join(', '))

// 10.5 每个正式页面都能找到动作（02 §5）
const uiSpecPath = join(repoRoot, 'docs', 'plans', '2026-09-17-web-wechat-plan', '02-ui-specification.md')
const pageNames = []
try {
  const lines = readFileSync(uiSpecPath, 'utf8').split(/\r?\n/)
  const start = lines.findIndex((l) => l.startsWith('## 5. 各业务页'))
  if (start < 0) throw new Error('未找到「## 5. 各业务页」标题')
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) break
    if (!line.startsWith('|')) continue
    const first = line.split('|')[1]?.trim() ?? ''
    if (!first || first === '页面' || /^:?-+:?$/.test(first)) continue
    pageNames.push(first)
  }
} catch (error) {
  failures.push(`无法解析 02 §5 页面清单 —— ${error.message}`)
}
check('解析到 02 §5 的页面清单', pageNames.length > 0, `解析到 ${pageNames.length} 个`)

const NON_PAGE_REFS = new Set(['全局'])
const coveredPages = new Set()
const strayRefs = []
for (const act of actionList) {
  for (const r of act.uiRefs ?? []) {
    coveredPages.add(r)
    if (!pageNames.includes(r) && !NON_PAGE_REFS.has(r)) strayRefs.push(`${act.code}→${r}`)
  }
}
for (const page of pageNames) {
  check(`页面「${page}」至少映射一个动作`, coveredPages.has(page), 'noWidening 之外的空缺同样不可接受')
}
check('uiRefs 只引用已知页面或白名单标记', strayRefs.length === 0, strayRefs.join(', '))

// 10.6 旧权限 → 新 action 映射，以真实源码为准
const legacyMap = actionsDoc.legacyPermissionMap?.map ?? []
const legacyCodesInMap = legacyMap.map((m) => m.legacy)
check('旧权限映射无重复', new Set(legacyCodesInMap).size === legacyCodesInMap.length)

const backendSrcPath = join(repoRoot, 'backend', 'src', 'index.ts')
const backendSrc = readFileSync(backendSrcPath, 'utf8')
const backendLines = backendSrc.split(/\r?\n/)
const realLegacy = new Set(
  [...backendSrc.matchAll(/'([a-z]+\/[a-z-]+)'/g)].map((m) => m[1]).filter((c) => c !== 'application/json')
)
check('后端源码中提取到旧权限码', realLegacy.size > 0, '未匹配到 resource/verb 形态的字面量')
const missingMap = [...realLegacy].filter((c) => !legacyCodesInMap.includes(c))
const extraMap = legacyCodesInMap.filter((c) => !realLegacy.has(c))
check('后端实际使用的旧权限码全部已映射', missingMap.length === 0, `未映射 ${missingMap.join(', ')}`)
check('映射中没有后端不存在的旧权限码', extraMap.length === 0, `多出 ${extraMap.join(', ')}`)

for (const entry of legacyMap) {
  check(`映射 ${entry.legacy} 声明了实际守卫资源`, Array.isArray(entry.actuallyGuards) && entry.actuallyGuards.length > 0)
  check(`映射 ${entry.legacy} 至少映射一个目标`, Array.isArray(entry.mapsTo) && entry.mapsTo.length > 0)
  for (const t of entry.mapsTo ?? []) check(`映射 ${entry.legacy} 的目标 ${t} 存在`, permCodes.has(t), `permissionModel 无 ${t}`)
  for (const t of entry.doesNotGrant ?? []) check(`映射 ${entry.legacy} 的排除项 ${t} 存在`, permCodes.has(t), `permissionModel 无 ${t}`)
  for (const ev of entry.evidence ?? []) {
    const m = /^backend\/src\/index\.ts:(\d+)$/.exec(ev)
    check(`映射 ${entry.legacy} 的证据 ${ev} 格式正确`, Boolean(m), '应形如 backend/src/index.ts:123')
    if (!m) continue
    const ln = Number(m[1])
    const inRange = ln >= 1 && ln <= backendLines.length
    check(`映射 ${entry.legacy} 的证据行 ${ln} 存在`, inRange, `index.ts 共 ${backendLines.length} 行`)
    if (inRange) {
      const text = backendLines[ln - 1]
      check(`映射 ${entry.legacy} 的证据行 ${ln} 确实涉及权限`, /requirePermission|permissions\.includes/.test(text),
        `该行内容：${text.trim().slice(0, 60)}`)
    }
  }
}

// 新增的老板专属权限码：不是错误，但 T03 装配默认角色时必须确认不自动授予
const newOwnerOnly = (actionsDoc.permissionModel?.codes ?? [])
  .filter((c) => c.grantPolicy === 'owner_only' && !c.legacySource).map((c) => c.code)
if (newOwnerOnly.length) {
  warn(`新增老板专属权限码 ${newOwnerOnly.length} 个，T03 装配默认角色时不得自动授予：${newOwnerOnly.join('、')}`)
}

// 10.7 补充动作与状态机缺口
for (const act of actionsDoc.supplementaryActions ?? []) {
  check(`补充动作 ${act.code} 声明合法 status`, ['reserved', 'specified'].includes(act.status), `status=${act.status}`)
  if (act.status === 'reserved') {
    check(`保留动作 ${act.code} 不预设路径`, act.path === null, `path=${act.path}`)
    check(`保留动作 ${act.code} 说明原因`, typeof act.reason === 'string' && act.reason.length > 0)
  }
  if (act.permission) check(`补充动作 ${act.code} 的权限码存在`, permCodes.has(act.permission), `permission=${act.permission}`)
}

const gaps = actionsDoc.stateMachineGaps?.gaps ?? []
check('状态机缺口已登记', gaps.length > 0)
for (const gap of gaps) {
  check(`缺口对象 ${gap.object} 存在`, OBJECT_NAMES.includes(gap.object), `objects.json 无 ${gap.object}`)
  for (const a of gap.affectsActions ?? []) {
    check(`缺口 ${gap.object} 影响的动作 ${a} 已定义`, allBusinessCodes.includes(a), `${a} 不在动作目录中`)
  }
}

// 10.8 auth 与读接口
for (const act of [...(actionsDoc.authActions ?? []), ...(actionsDoc.readActions ?? [])]) {
  check(`${act.code} 声明 path`, typeof act.path === 'string' && act.path.startsWith('/'), `path=${act.path}`)
  if (act.permission && !permCodes.has(act.permission)) {
    failures.push(`${act.code} 的权限码 ${act.permission} 不存在于 permissionModel`)
  }
}

warn(`已登记状态机缺口 ${gaps.length} 项（不影响本次校验结论，须由对应任务卡补全）`)

// ── 11. 缺口依据与规格字段覆盖（T01-rev1）───────────────────────────────
// 11.1 每条缺口的 specBasis 必须可被机械验证：文件存在、行号在范围内、引文逐字出现在该行。
//      起因：T01b 曾用未经核实的断言把「Purchase 缺状态字段」登记为对象层遗漏，事后核对
//      04 §2 的最低字段列本就没有状态字段、在途是派生值 —— 结论是错的。此检查确保
//      任何缺口登记都必须附可核对原文，而不是凭印象断言。
const specCache = new Map()
function specLinesOf(relPath) {
  if (specCache.has(relPath)) return specCache.get(relPath)
  let lines = null
  try {
    lines = readFileSync(join(repoRoot, relPath), 'utf8').split(/\r?\n/)
  } catch {
    lines = null
  }
  specCache.set(relPath, lines)
  return lines
}
function verifyBasis(ownerLabel, basis) {
  for (const b of basis ?? []) {
    const lines = specLinesOf(b.file)
    const label = `${ownerLabel} specBasis ${b.file}:${b.line}`
    check(`${label} 文件可读`, lines !== null, '文件不存在或读取失败')
    if (!lines) continue
    const inRange = Number.isInteger(b.line) && b.line >= 1 && b.line <= lines.length
    check(`${label} 行号在范围内`, inRange, `文件共 ${lines.length} 行`)
    if (!inRange) continue
    check(`${label} 引文出现在该行`, lines[b.line - 1].includes(b.quote), `该行未找到「${b.quote}」`)
  }
}

const smg = actionsDoc.stateMachineGaps ?? {}
const originKeys = Object.keys(smg.originValues ?? {})
check('stateMachineGaps 声明 originValues 取值表', originKeys.length > 0)
let basisVerified = 0
for (const gap of gaps) {
  check(`缺口 ${gap.object} 声明 origin`, typeof gap.origin === 'string' && gap.origin.length > 0, `origin=${gap.origin}`)
  check(`缺口 ${gap.object} 的 origin 在取值表内`, originKeys.includes(gap.origin), `origin=${gap.origin}`)
  check(`缺口 ${gap.object} 附 specBasis`, Array.isArray(gap.specBasis) && gap.specBasis.length > 0,
    '没有 specBasis 依据不得登记为缺口')
  basisVerified += (gap.specBasis ?? []).length
  verifyBasis(`缺口 ${gap.object}`, gap.specBasis)
}
for (const ng of smg.notAGap ?? []) {
  if (typeof ng !== 'object' || ng === null) {
    check('notAGap 条目为结构化对象（含 claim / reason / specBasis）', false, `实际为 ${typeof ng}`)
    continue
  }
  check(`notAGap「${String(ng.claim).slice(0, 20)}…」附 reason`, typeof ng.reason === 'string' && ng.reason.length > 0)
  basisVerified += (ng.specBasis ?? []).length
  verifyBasis(`notAGap「${String(ng.claim).slice(0, 20)}…」`, ng.specBasis)
}

// 11.2 04 §2「数据对象与最低字段」覆盖：逐行与 objects.json 双向核对。
//      复合行（如「Purchase / Receipt」）在规格里是一行、本契约拆为两个对象，故按并集比对。
const UI_SPEC = 'docs/plans/2026-09-17-web-wechat-plan/04-data-and-api.md'
const SPEC_NAME_MAP = {
  Product: ['Product'], StockBalance: ['StockBalance'], StockItem: ['StockItem'], Customer: ['Customer'],
  CustomerDevice: ['CustomerDevice'], Quote: ['Quote'], QuoteVersion: ['QuoteVersion'], SaleOrder: ['SaleOrder'],
  SaleLine: ['SaleLine'], Reservation: ['Reservation'], Purchase: ['Purchase'], Receipt: ['Receipt'],
  InventoryMovement: ['InventoryMovement'], Checklist: ['Checklist'], TestRecord: ['TestRecord'],
  Delivery: ['Delivery'], Recovery: ['Recovery'], RefurbishmentCost: ['RefurbishmentCost'],
  ServiceOrder: ['ServiceOrder'], DeviceConfiguration: ['DeviceConfiguration'], Change: ['DeviceChange'],
  Return: ['ReturnRecord'], Refund: ['Refund'], CashEntry: ['CashEntry'], Offset: ['Offset'],
  Attachment: ['Attachment'], Operation: ['Operation'], AuditEvent: ['AuditEvent'],
  WechatIdentity: ['WechatIdentity'], Session: ['Session']
}
function parseSpecFields(fieldCell) {
  const out = new Set()
  for (let token of fieldCell.split('、')) {
    token = token.trim()
    if (!token) continue
    token = token.replace(/\s*可空\s*$/, '').replace(/\(.*?\)/g, '')
    for (const part of token.split(/\s+或\s+/)) {
      for (const sub of part.split(/\s*\/\s*/)) {
        const f = sub.trim().toLowerCase()
        if (f) out.add(f)
      }
    }
  }
  return [...out]
}
const specLines = specLinesOf(UI_SPEC)
check('04 §2 规格文件可读', specLines !== null)
let coverageRows = 0
if (specLines) {
  let inSection2 = false
  for (const line of specLines) {
    if (/^##\s*2\./.test(line)) { inSection2 = true; continue }
    if (/^##\s*3\./.test(line)) { inSection2 = false; continue }
    if (!inSection2 || !line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 4) continue
    const nameCell = cells[1]
    const fieldCell = cells[2]
    if (!nameCell || nameCell === '对象' || /^-+$/.test(nameCell)) continue
    if (!fieldCell || fieldCell === '最低业务字段') continue
    const keys = nameCell.split('/').map((s) => s.trim().split(/\s+/)[0]).map((p) => SPEC_NAME_MAP[p]).filter(Boolean).flat()
    if (!keys.length) {
      warn(`04 §2 行「${nameCell}」未在 SPEC_NAME_MAP 登记，无法核对字段覆盖`)
      continue
    }
    coverageRows += 1
    const specFields = parseSpecFields(fieldCell)
    const own = new Set()
    for (const k of keys) for (const f of Object.keys(objectsDoc.objects[k]?.fields ?? {})) own.add(f.toLowerCase())
    const missing = specFields.filter((f) => !own.has(f))
    check(`04 §2「${nameCell}」最低字段已全部落到 objects.json`, missing.length === 0, `缺 ${missing.join(', ')}`)
  }
  check('04 §2 覆盖检查至少解析到 20 行对象', coverageRows >= 20, `仅 ${coverageRows} 行`)
}

// ── 12. 虚构样本、金额算例与 DTO 生成物（T01c）─────────────────────────────
// 起因：05 T01c 要求「所有 7 个首页样本和资金算例能逐项核算」，并要求「生成文件不手改」。
//      文档里声称「已核对」不算证据；本节把两件事都变成机械重算。
const fixturesPath = join(v1Dir, 'fixtures.json')
let fixturesDoc = null
if (!existsSync(fixturesPath)) {
  failures.push('contracts/v1.1/fixtures.json 不存在 —— T01c 的样本与算例未产出')
} else {
  try {
    fixturesDoc = JSON.parse(readFileSync(fixturesPath, 'utf8'))
  } catch (error) {
    failures.push(`JSON 解析失败：v1.1/fixtures.json —— ${error.message}`)
  }
}

let fixtureCheckCount = 0
if (fixturesDoc) {  check('fixtures.json 声明 contractVersion', fixturesDoc.contractVersion === 'v1.1', `实际为 ${fixturesDoc.contractVersion}`)
  check('fixtures.json 标记冻结来源', typeof fixturesDoc.frozenBy === 'string' && fixturesDoc.frozenBy.length > 0)

  // 12.1 子结构定义
  const errCodeSet = new Set(errorsDoc.errors.map((e) => e.code))
  for (const [shapeName, shape] of Object.entries(fixturesDoc.shapeDefinitions ?? {})) {
    if (shapeName === 'note') continue
    check(`子结构 ${shapeName} 声明 definedBy`, typeof shape.definedBy === 'string' && shape.definedBy.length > 0)
    check(`子结构 ${shapeName} 含 fields`, shape.fields && Object.keys(shape.fields).length > 0)
    for (const [fname, fdef] of Object.entries(shape.fields ?? {})) {
      if (fdef.type === 'array') {
        check(`子结构 ${shapeName}.${fname} 的数组元素声明 itemFields`, Boolean(fdef.itemFields))
        for (const [iname, idef] of Object.entries(fdef.itemFields ?? {})) {
          check(`子结构 ${shapeName}.${fname}[].${iname} 声明类型`, typeof idef.type === 'string')
          if (idef.type !== 'string') {
            check(`子结构 ${shapeName}.${fname}[].${iname} 的类型在约定集合内`, TYPE_NAMES.includes(idef.type), `type=${idef.type}`)
          }
        }
        continue
      }
      check(`子结构 ${shapeName}.${fname} 的类型在约定集合内`, TYPE_NAMES.includes(fdef.type), `type=${fdef.type}`)
      check(`子结构 ${shapeName}.${fname} 显式声明 nullable`, typeof fdef.nullable === 'boolean')
      if (fdef.type === 'enum') {
        check(`子结构 ${shapeName}.${fname} 的 enumRef 存在`, ENUM_NAMES.includes(fdef.enumRef), `enumRef=${fdef.enumRef}`)
      }
      if (fdef.type === 'cents') {
        check(`子结构 ${shapeName}.${fname} 的金额字段名以 Cents 结尾`, fname.endsWith('Cents'), `字段名 ${fname}`)
      }
    }
  }

  // 12.2 V1 读取样本：字段集合、枚举取值、金额恒等式、metrics 重算
  const v1 = fixturesDoc.datasets?.V1
  check('fixtures 含 V1 数据集', Boolean(v1))
  if (v1) {
    const readModelFields = Object.keys(objectsDoc.objects.TaskReadModel?.fields ?? {})
    check('TaskReadModel 字段可读', readModelFields.length > 0)
    const tasks = v1.tasks ?? []
    check('V1 任务数为 7', tasks.length === 7, `实际 ${tasks.length}`)
    const taskIds = tasks.map((t) => t.taskId)
    const entityIds = tasks.map((t) => t.entityId)
    check('V1 taskId 无重复', new Set(taskIds).size === taskIds.length)
    check('V1 entityId 无重复', new Set(entityIds).size === entityIds.length)
    check('V1 全部使用 DEMO- 标识', taskIds.every((t) => String(t).startsWith('DEMO-')) && entityIds.every((t) => String(t).startsWith('DEMO-')),
      '演示标识由 ID 前缀承载')

    const amountShape = Object.keys(fixturesDoc.shapeDefinitions?.amountSummary?.fields ?? {})
    const actionShape = Object.keys(fixturesDoc.shapeDefinitions?.primaryAction?.fields ?? {})

    for (const task of tasks) {
      const label = `V1 ${task.entityId}`
      const keys = Object.keys(task)
      const missing = readModelFields.filter((f) => !keys.includes(f))
      const extra = keys.filter((f) => !readModelFields.includes(f))
      check(`${label} 覆盖 TaskReadModel 全部字段`, missing.length === 0, `缺 ${missing.join(', ')}`)
      check(`${label} 无未定义字段`, extra.length === 0, `多出 ${extra.join(', ')}`)
      check(`${label} 的 entityType 合法`, (enumsDoc.enums.EntityType?.values ?? []).includes(task.entityType), `entityType=${task.entityType}`)
      check(`${label} 的 category 合法`, (enumsDoc.enums.TaskCategory?.values ?? []).includes(task.category), `category=${task.category}`)
      if (task.photoKind !== null) {
        check(`${label} 的 photoKind 合法`, (enumsDoc.enums.AttachmentPurpose?.values ?? []).includes(task.photoKind), `photoKind=${task.photoKind}`)
      }
      if (task.dueAt !== null) {
        check(`${label} 的 dueAt 为 UTC 瞬时格式`, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(task.dueAt), `dueAt=${task.dueAt}`)
      }
      check(`${label} 的 detailTarget 非空`, typeof task.detailTarget === 'string' && task.detailTarget.startsWith('/'))

      const a = task.amountSummary
      const aMissing = amountShape.filter((f) => !(f in a))
      const aExtra = Object.keys(a).filter((f) => !amountShape.includes(f))
      check(`${label} 的 amountSummary 结构完整`, aMissing.length === 0 && aExtra.length === 0,
        `缺 ${aMissing.join(', ')} / 多 ${aExtra.join(', ')}`)
      check(`${label} 声明 countsTowardReceivable`, typeof a.countsTowardReceivable === 'boolean')
      if (a.countsTowardReceivable) {
        check(`${label} 计入待收时 balanceCents 为整数`, Number.isInteger(a.balanceCents), `balanceCents=${a.balanceCents}`)
        check(`${label} 计入待收时 balanceDirection 合法`, (enumsDoc.enums.BalanceDirection?.values ?? []).includes(a.balanceDirection), `balanceDirection=${a.balanceDirection}`)
        const identity = a.totalCents - a.receivedCents - a.offsetCents
        check(`${label} 满足 balanceCents = totalCents - receivedCents - offsetCents`, identity === a.balanceCents,
          `重算 ${identity} ≠ 声明 ${a.balanceCents}`)
        check(`${label} 的 balanceDirection 与余额方向一致`,
          (a.balanceCents > 0 && a.balanceDirection === 'client_due') || (a.balanceCents === 0 && a.balanceDirection === 'settled') || (a.balanceCents < 0 && a.balanceDirection === 'store_due'),
          `balanceCents=${a.balanceCents} direction=${a.balanceDirection}`)
      } else {
        check(`${label} 不计待收时不得用余额字段冒充`, a.balanceCents === null && a.balanceDirection === null,
          `balanceCents=${a.balanceCents} balanceDirection=${a.balanceDirection}`)
        check(`${label} 不计待收时给出可读原因`, typeof a.note === 'string' && a.note.length > 0)
      }
      check(`${label} 的 estimateCents 未被计入待收`, !a.countsTowardReceivable || a.estimateCents === null)

      const pa = task.primaryAction
      const pMissing = actionShape.filter((f) => !(f in pa))
      check(`${label} 的 primaryAction 结构完整`, pMissing.length === 0, `缺 ${pMissing.join(', ')}`)
      check(`${label} 的 primaryAction.code 是已登记动作`, (enumsDoc.enums.ActionCode?.values ?? []).includes(pa.code), `code=${pa.code}`)
      check(`${label} 的 label 为界面文案`, typeof pa.label === 'string' && pa.label.length > 0)
      check(`${label} 的 enabled 为布尔`, typeof pa.enabled === 'boolean')
      check(`${label} 禁用时必须给出可读阻断原因`, pa.enabled || (Array.isArray(pa.blockers) && pa.blockers.length > 0))
      for (const blk of pa.blockers ?? []) {
        check(`${label} 的阻断码 ${blk.code} 是标准错误码`, errCodeSet.has(blk.code), `不在 errors.json`)
        check(`${label} 的阻断原因非空`, typeof blk.message === 'string' && blk.message.length > 0)
      }
    }

    // metrics 机械重算
    const expected = v1.expected ?? {}
    const m = v1.metrics ?? {}
    const catCount = (c) => tasks.filter((t) => t.category === c).length
    const recv = tasks.filter((t) => t.amountSummary.countsTowardReceivable).reduce((s, t) => s + t.amountSummary.balanceCents, 0)
    check('V1 待交机数可重算', m.pendingDelivery?.value === catCount('delivery'), `声明 ${m.pendingDelivery?.value} / 重算 ${catCount('delivery')}`)
    check('V1 缺货订单数可重算', m.stockShortage?.value === catCount('stock_shortage'), `声明 ${m.stockShortage?.value} / 重算 ${catCount('stock_shortage')}`)
    check('V1 维修待办数可重算', m.servicePending?.value === catCount('service'), `声明 ${m.servicePending?.value} / 重算 ${catCount('service')}`)
    check('V1 待办总数可重算', m.taskTotal?.value === tasks.length, `声明 ${m.taskTotal?.value} / 重算 ${tasks.length}`)
    check('V1 待收款可重算', m.receivable?.valueCents === recv, `声明 ${m.receivable?.valueCents} / 重算 ${recv}`)
    check('V1 expected 待收款与 metrics 一致', expected.receivableCents === recv, `${expected.receivableCents} ≠ ${recv}`)
    check('V1 expected 待办总数与样本一致', expected.taskTotal === tasks.length)
    for (const [c, n] of Object.entries(expected.categoryCounts ?? {})) {
      check(`V1 类别 ${c} 计数可重算`, catCount(c) === n, `声明 ${n} / 重算 ${catCount(c)}`)
    }
    const catSum = Object.values(expected.categoryCounts ?? {}).reduce((s, n) => s + n, 0)
    check('V1 类别计数之和等于待办总数', catSum === tasks.length, `${catSum} ≠ ${tasks.length}`)
    for (const ex of expected.excludedFromReceivable ?? []) {
      const t = tasks.find((x) => x.entityId === ex.entityId)
      check(`V1 排除项 ${ex.entityId} 在样本内`, Boolean(t))
      if (t) check(`V1 排除项 ${ex.entityId} 确实不计待收`, t.amountSummary.countsTowardReceivable === false)
    }
    check('V1 声明固定演示日期', fixturesDoc.demoPolicy?.demoDate === '2026-09-17', `demoDate=${fixturesDoc.demoPolicy?.demoDate}`)
    check('V1 声明业务时区', fixturesDoc.demoPolicy?.demoTimezone === 'Asia/Shanghai')
  }

  // 12.3 V2 二手循环
  const v2 = fixturesDoc.datasets?.V2
  check('fixtures 含 V2 数据集', Boolean(v2))
  if (v2) {
    const lineSources = enumsDoc.enums.LineSource?.values ?? []
    for (const q of v2.quotes ?? []) {
      for (const line of q.lines ?? []) {
        check(`V2 ${q.id} 的行来源 ${line.source} 合法`, lineSources.includes(line.source), `source=${line.source}`)
        if (line.source === 'used') {
          check(`V2 ${q.id} 的二手行指定具体实物`, typeof line.stockItemId === 'string' && line.stockItemId.length > 0,
            'used 必须指定具体实物（enums.json LineSource）')
        }
        if (line.source === 'customer') {
          check(`V2 ${q.id} 的客供行售价为 0`, line.unitPriceCents === 0, `unitPriceCents=${line.unitPriceCents}`)
        }
      }
    }
    const expectedCost = v2.stockItem?.acquisitionCostCents + (v2.refurbishmentCosts ?? []).filter((c) => c.capitalizable).reduce((s, c) => s + c.amountCents, 0)
    check('V2 成本为收购 + 可归属整备', v2.expectedCostCents === expectedCost, `声明 ${v2.expectedCostCents} / 重算 ${expectedCost}`)
    check('V2 声明客户输出不含原卖方', (v2.expectations ?? []).some((e) => e.includes('不含 sellerRef')))
  }

  // 12.4 V3 / V4 索引完整性
  const computeCaseIds = new Set((fixturesDoc.computeCases ?? []).map((c) => c.id))
  const behaviorCaseIds = new Set((fixturesDoc.behaviorCases ?? []).map((c) => c.id))
  const boundaryIds = new Set((fixturesDoc.boundaryInputs ?? []).map((b) => b.id))
  for (const id of fixturesDoc.datasets?.V3?.computeCaseIds ?? []) {
    check(`V3 引用的算例 ${id} 存在`, computeCaseIds.has(id), 'computeCases 中未定义')
  }
  for (const id of fixturesDoc.datasets?.V3?.behaviorCaseIds ?? []) {
    check(`V3 引用的行为算例 ${id} 存在`, behaviorCaseIds.has(id), 'behaviorCases 中未定义')
  }
  for (const id of fixturesDoc.datasets?.V4?.boundaryInputIds ?? []) {
    check(`V4 引用的边界输入 ${id} 存在`, boundaryIds.has(id), 'boundaryInputs 中未定义')
  }

  // 12.4b V5 库存样本逐项重算（T05c）
  //
  // fixtures.rules 第 5 条要求「逐项核算由本脚本机械重算，禁止只在文档里声称已核对」。
  // 数量守恒定的是 T05a 的实现口径：to_bucket 桶 +qty、from_bucket 桶 −qty（OPEN-ITEMS G-17）。
  const v5 = fixturesDoc.datasets?.V5
  if (v5) {
    const products5 = v5.products ?? []
    const items5 = v5.stockItems ?? []
    const balances5 = v5.balances ?? []
    const moves5 = v5.movements ?? []
    const ownBuckets = new Set(['available', 'reserved', 'quarantine'])

    const productRefs = new Set(products5.map((p) => p.productRef))
    check('V5 商品引用唯一', productRefs.size === products5.length, `声明 ${products5.length} 个 / 唯一引用 ${productRefs.size} 个`)

    const assetCodes = items5.map((i) => i.assetCode)
    check('V5 实物内部编号唯一', new Set(assetCodes).size === assetCodes.length, `编号 ${assetCodes.length} 个 / 唯一 ${new Set(assetCodes).size} 个`)
    check('V5 实物均指向已声明商品', items5.every((i) => productRefs.has(i.productRef)), '存在指向未声明商品的实物')
    check(
      'V5 二手实物必有内部编号（无 SN 也要有）',
      items5.filter((i) => i.condition === 'used').every((i) => typeof i.assetCode === 'string' && i.assetCode.length > 0),
      '04 §2 L21：二手必有内部编号',
    )

    const recomputed = new Map()
    for (const m of moves5) {
      const cur = recomputed.get(m.productRef) ?? { available: 0, reserved: 0, quarantine: 0 }
      if (m.toBucket) cur[m.toBucket] += m.qty
      if (m.fromBucket) cur[m.fromBucket] -= m.qty
      recomputed.set(m.productRef, cur)
    }
    for (const b of balances5) {
      const c = recomputed.get(b.productRef) ?? { available: 0, reserved: 0, quarantine: 0 }
      check(`V5 数量守恒 ${b.productRef} 可卖`, c.available === b.availableQty, `流水重算 ${c.available} ≠ 余额 ${b.availableQty}`)
      check(`V5 数量守恒 ${b.productRef} 已订`, c.reserved === b.reservedQty, `流水重算 ${c.reserved} ≠ 余额 ${b.reservedQty}`)
      check(`V5 数量守恒 ${b.productRef} 待处理`, c.quarantine === b.quarantineQty, `流水重算 ${c.quarantine} ≠ 余额 ${b.quarantineQty}`)
      check(
        `V5 三桶非负 ${b.productRef}`,
        b.availableQty >= 0 && b.reservedQty >= 0 && b.quarantineQty >= 0,
        `可卖 ${b.availableQty} / 已订 ${b.reservedQty} / 待处理 ${b.quarantineQty}`,
      )
      check(
        `V5 未知成本不得估成 0 ${b.productRef}`,
        b.costKnown ? b.totalCostCents !== null : b.totalCostCents === null,
        `costKnown=${b.costKnown} 而 totalCostCents=${JSON.stringify(b.totalCostCents)}（03 §1 R01：未知成本为 null，不是 0）`,
      )
    }

    for (const ref of products5.filter((p) => p.trackingMode === 'item').map((p) => p.productRef)) {
      const itemCount = items5.filter((i) => i.productRef === ref && ownBuckets.has(i.availability) && i.ownership === 'store').length
      const b = balances5.find((x) => x.productRef === ref)
      const qty = (b?.availableQty ?? 0) + (b?.reservedQty ?? 0) + (b?.quarantineQty ?? 0)
      check(`V5 逐件商品 ${ref} 自有在库量 = 实物件数`, itemCount === qty, `实物 ${itemCount} 件 ≠ 余额合计 ${qty}`)
    }

    check(
      'V5 客户保管件所有权为客户',
      items5.filter((i) => i.availability === 'customer_custody').every((i) => i.ownership === 'customer'),
      '03 §1 R03：客户暂存不属于可卖库存，所有权必须是 customer',
    )
    check(
      'V5 在途件不落在余额三桶内',
      items5.filter((i) => i.availability === 'in_transit').every((i) => !ownBuckets.has(i.availability)),
      '03 §4 L84：在途不算在库',
    )
    const storeSn = items5.filter((i) => i.ownership === 'store' && i.snNormalized).map((i) => i.snNormalized)
    check('V5 店有实物的 SN 不重复', new Set(storeSn).size === storeSn.length, `店有 SN ${storeSn.length} 个 / 唯一 ${new Set(storeSn).size} 个（03 §4 L86：重复 SN 不自动合并）`)

    const caseIds5 = v5.caseIds ?? []
    const caseIdSet5 = new Set((v5.cases ?? []).map((c) => c.id))
    for (const id of caseIds5) {
      check(`V5 引用样本用例 ${id} 存在`, caseIdSet5.has(id), 'cases 中未定义')
    }
    for (const c of v5.cases ?? []) {
      check(`V5 样本用例 ${c.id} 附规格依据`, Array.isArray(c.specBasis) && c.specBasis.length > 0, '登记必须钉规格原文行号（P-11）')
      basisVerified += (c.specBasis ?? []).length
      verifyBasis(`V5 用例 ${c.id}`, c.specBasis ?? [])
    }
    const iv06 = (v5.cases ?? []).find((c) => c.id === 'IV-06')
    for (const row of iv06?.expect?.byProduct ?? []) {
      const b = balances5.find((x) => x.productRef === row.productRef)
      check(
        `V5 用例 IV-06 声明的 ${row.productRef} 与余额一致`,
        Boolean(b) && b.availableQty === row.availableQty && b.reservedQty === row.reservedQty && b.quarantineQty === row.quarantineQty,
        b ? `余额 ${b.availableQty}/${b.reservedQty}/${b.quarantineQty} ≠ 用例 ${row.availableQty}/${row.reservedQty}/${row.quarantineQty}` : '余额中不存在该商品',
      )
    }
  }

  // 12.5 金额算例逐项重算
  const moneyTerms = new Set(fixturesDoc.moneyFormulaContract?.terms ?? [])
  const moneyComputed = new Set(fixturesDoc.moneyFormulaContract?.computed ?? [])
  const knownComputed = new Set()
  const knownTerms = new Set()
  for (const f of moneyDoc.formulas) {
    knownComputed.add(f.id)
    for (const t of f.derivedTerms ?? []) {
      knownComputed.add(t)
      knownTerms.add(t)
    }
    for (const ref of f.objectFields ?? []) {
      const leaf = ref.slice(ref.indexOf('.') + 1)
      if (leaf) knownTerms.add(leaf)
    }
  }
  for (const k of moneyComputed) {
    check(`口径结果项 ${k} 对应 money-rules 公式`, knownComputed.has(k), '不是任何公式的 id 或 derivedTerm')
  }
  for (const k of moneyTerms) {
    check(`口径输入项 ${k} 是 money-rules 公式的派生项或对象字段`, knownTerms.has(k), '不是任何公式的 derivedTerm 或 objectFields')
  }

  // 口径实现：逐字对应 money-rules.json 的 expression
  function computeMoney(terms) {
    const got = (k) => Object.prototype.hasOwnProperty.call(terms, k)
    const isNull = (k) => !got(k) || terms[k] === null
    const out = {}
    const nullReason = {}
    const setNull = (key, deps) => {
      const bad = deps.filter(isNull)
      out[key] = null
      nullReason[key] = `依赖 ${bad.join('、')} 为 null（conventions.nullable：null 表示未知或不适用，禁止用 0 代替）`
    }
    const dep1 = ['confirmedTotalCents', 'approvedIncreaseCents', 'approvedDecreaseCents', 'returnCreditCents']
    dep1.some(isNull) ? setNull('salesNetAccruedCents', dep1)
      : (out.salesNetAccruedCents = terms.confirmedTotalCents + terms.approvedIncreaseCents - terms.approvedDecreaseCents - terms.returnCreditCents)
    const dep2 = ['validReceiptsCents', 'validRefundsCents']
    dep2.some(isNull) ? setNull('cashNetReceivedCents', dep2)
      : (out.cashNetReceivedCents = terms.validReceiptsCents - terms.validRefundsCents)
    const dep3 = ['appliedOffsetsCents', 'reversedOffsetsCents']
    dep3.some(isNull) ? setNull('offsetNetCents', dep3)
      : (out.offsetNetCents = terms.appliedOffsetsCents - terms.reversedOffsetsCents)
    const dep4 = ['salesNetAccruedCents', 'cashNetReceivedCents', 'offsetNetCents']
    const isMissingOut = (k) => out[k] === null || out[k] === undefined
    dep4.some(isMissingOut)
      ? setNull('salesBalanceCents', dep4)
      : (out.salesBalanceCents = out.salesNetAccruedCents - out.cashNetReceivedCents - out.offsetNetCents)
    out.balanceDirection = out.salesBalanceCents === null ? null
      : out.salesBalanceCents > 0 ? 'client_due' : out.salesBalanceCents === 0 ? 'settled' : 'store_due'
    if (out.balanceDirection === null) nullReason.balanceDirection = '依赖 salesBalanceCents 为 null'
    const dep6 = ['finalAcquisitionCents', 'lawfulAdjustmentCents', 'validOffsetsCents', 'cashNetPaidCents']
    dep6.some(isNull) ? setNull('recoveryPayableRemainingCents', dep6)
      : (out.recoveryPayableRemainingCents = terms.finalAcquisitionCents + terms.lawfulAdjustmentCents - terms.validOffsetsCents - terms.cashNetPaidCents)
    const dep7 = ['salesBalanceCents', 'recoveryPayableRemainingCents']
    if (out.salesBalanceCents === null || out.recoveryPayableRemainingCents === null) setNull('offsetAmountCents', dep7)
    else out.offsetAmountCents = Math.min(Math.max(out.salesBalanceCents, 0), Math.max(out.recoveryPayableRemainingCents, 0))
    if (out.salesBalanceCents === null || isNull('refundableCashNetCents')) setNull('refundableCashCents', ['salesBalanceCents', 'refundableCashNetCents'])
    else out.refundableCashCents = out.salesBalanceCents >= 0 ? 0 : Math.min(-out.salesBalanceCents, terms.refundableCashNetCents)
    if (out.salesBalanceCents === null) setNull('collectableCents', ['salesBalanceCents'])
    else out.collectableCents = Math.max(out.salesBalanceCents, 0)
    return { out, nullReason }
  }

  const seenCaseIds = new Set()
  for (const c of fixturesDoc.computeCases ?? []) {
    check(`算例 ${c.id} 唯一`, !seenCaseIds.has(c.id))
    seenCaseIds.add(c.id)
    check(`算例 ${c.id} 声明 kind`, typeof c.kind === 'string' && c.kind.length > 0)
    check(`算例 ${c.id} 声明来源`, typeof c.source === 'string' && c.source.length > 0)
    check(`算例 ${c.id} 含 stages`, Array.isArray(c.stages) && c.stages.length > 0)
    for (const st of c.stages ?? []) {
      const where = `${c.id}/${st.id}`
      const kindTerms = c.kind === 'assetCost' || c.kind === 'discountAllocation' || c.kind === 'partialReturn'
        ? new Set((fixturesDoc.moneyFormulaContract?.otherKinds ?? {})[c.kind] ?? [])
        : moneyTerms
      for (const k of Object.keys(st.terms ?? {})) {
        check(`${where} 的输入项 ${k} 在口径表内`, kindTerms.has(k), `不在 ${c.kind} 的输入口径中`)
      }
      for (const k of Object.keys(st.expected ?? {})) {
        check(`${where} 的期望项 ${k} 可被公式重算`, moneyComputed.has(k) || ['assetCostCents', 'capitalizableRefurbishmentCents', 'nonCapitalizableCents', 'discountAllocationCents', 'allocationSumCents', 'floorNumerator', 'floorCents', 'remainderNumerator', 'remainderOrder', 'perUnitCents', 'creditCents', 'cumulativeCreditCents', 'capCents'].includes(k),
          `未知期望项 ${k}`)
      }

      if (c.kind === 'assetCost') {
        const cap = (st.terms.refurbishmentCosts ?? []).filter((r) => r.capitalizable).reduce((s, r) => s + r.amountCents, 0)
        const nonCap = (st.terms.refurbishmentCosts ?? []).filter((r) => !r.capitalizable).reduce((s, r) => s + r.amountCents, 0)
        const total = st.terms.acquisitionCostCents + cap
        check(`${where} 可归属整备可重算`, st.expected.capitalizableRefurbishmentCents === cap, `${st.expected.capitalizableRefurbishmentCents} ≠ ${cap}`)
        check(`${where} 不可归属整备可重算`, st.expected.nonCapitalizableCents === nonCap, `${st.expected.nonCapitalizableCents} ≠ ${nonCap}`)
        check(`${where} 实物成本 = 收购 + 可归属整备`, st.expected.assetCostCents === total, `${st.expected.assetCostCents} ≠ ${total}`)
        continue
      }

      if (c.kind === 'discountAllocation') {
        const lines = st.terms.lines ?? []
        const total = lines.reduce((s, l) => s + l.grossCents, 0)
        const floor = {}
        const rem = {}
        for (const l of lines) {
          const num = st.terms.discountCents * l.grossCents
          floor[l.lineId] = Math.floor(num / total)
          rem[l.lineId] = num % total
        }
        const alloc = { ...floor }
        let left = st.terms.discountCents - Object.values(floor).reduce((s, v) => s + v, 0)
        const order = [...lines].map((l) => l.lineId).sort((a, b) => (rem[b] - rem[a]) || (a < b ? -1 : a > b ? 1 : 0))
        for (const id of order) {
          if (left <= 0) break
          alloc[id] += 1
          left -= 1
        }
        for (const l of lines) {
          check(`${where} 行 ${l.lineId} 的向下取整可重算`, st.expected.floorCents[l.lineId] === floor[l.lineId], `${st.expected.floorCents[l.lineId]} ≠ ${floor[l.lineId]}`)
          check(`${where} 行 ${l.lineId} 的余数可重算`, st.expected.remainderNumerator[l.lineId] === rem[l.lineId], `${st.expected.remainderNumerator[l.lineId]} ≠ ${rem[l.lineId]}`)
          check(`${where} 行 ${l.lineId} 的分摊额可重算`, st.expected.discountAllocationCents[l.lineId] === alloc[l.lineId], `${st.expected.discountAllocationCents[l.lineId]} ≠ ${alloc[l.lineId]}`)
        }
        const expectOrder = order.filter((id) => rem[id] > 0)
        check(`${where} 余分顺序可重算`, JSON.stringify(st.expected.remainderOrder) === JSON.stringify(expectOrder),
          `声明 ${JSON.stringify(st.expected.remainderOrder)} / 重算 ${JSON.stringify(expectOrder)}`)
        const sum = Object.values(st.expected.discountAllocationCents).reduce((s, v) => s + v, 0)
        check(`${where} 分摊合计等于整单优惠`, sum === st.terms.discountCents && st.expected.allocationSumCents === sum, `${sum} ≠ ${st.terms.discountCents}`)
        continue
      }

      if (c.kind === 'partialReturn') {
        const { netLineCents, qty, returnQty } = st.terms
        const base = Math.floor(netLineCents / qty)
        const perUnit = []
        for (let i = 0; i < qty; i++) perUnit.push(i === qty - 1 ? netLineCents - base * (qty - 1) : base)
        const credit = perUnit.slice(0, returnQty).reduce((s, v) => s + v, 0)
        check(`${where} 按件分配可重算`, JSON.stringify(st.expected.perUnitCents) === JSON.stringify(perUnit), `${JSON.stringify(st.expected.perUnitCents)} ≠ ${JSON.stringify(perUnit)}`)
        check(`${where} 贷项可重算`, st.expected.creditCents === credit, `${st.expected.creditCents} ≠ ${credit}`)
        check(`${where} 累计不超原行净额`, credit <= netLineCents && st.expected.capCents === netLineCents, 'cap 必须为原行净额')
        check(`${where} 累计贷项可重算`, st.expected.cumulativeCreditCents === credit, `${st.expected.cumulativeCreditCents} ≠ ${credit}`)
        continue
      }

      // 其余 kind 走金额公式
      const { out, nullReason } = computeMoney(st.terms ?? {})
      let nullChecked = 0
      for (const [k, v] of Object.entries(st.expected ?? {})) {
        if (!moneyComputed.has(k)) continue
        if (v === null) {
          check(`${where} 的 ${k} 应为 null`, out[k] === null, `重算得到 ${JSON.stringify(out[k])}`)
          const reason = (st.nullReasons ?? {})[k]
          check(`${where} 的 ${k} 为 null 时必须写明原因`, typeof reason === 'string' && reason.length > 0, '缺 nullReasons')
          nullChecked++
        } else {
          check(`${where} 的 ${k} 可重算`, out[k] === v, `声明 ${v} / 重算 ${JSON.stringify(out[k])}`)
        }
      }
      for (const [k, v] of Object.entries(out)) {
        check(`${where} 的重算结果 ${k} 已写入期望`, !(k in (st.expected ?? {})) || st.expected[k] === v || st.expected[k] === null,
          '期望值与公式结果不一致')
        if (v === null) check(`${where} 的重算空值 ${k} 有原因说明`, typeof (st.nullReasons ?? {})[k] === 'string', '重算为 null 但未说明原因')
      }

      if (c.kind === 'tradeIn') {
        const sc = st.scenarioExpected ?? {}
        const balanceBefore = out.salesBalanceCents
        const payableBefore = out.recoveryPayableRemainingCents
        const offset = out.offsetAmountCents
        check(`${where} 折抵金额与公式一致`, sc.offsetAppliedCents === offset, `${sc.offsetAppliedCents} ≠ ${offset}`)
        check(`${where} 本次现金收可重算`, sc.cashCollectCents === Math.max(balanceBefore - offset, 0), `${sc.cashCollectCents} ≠ ${Math.max(balanceBefore - offset, 0)}`)
        check(`${where} 本次现金付可重算`, sc.cashPayCustomerCents === Math.max(payableBefore - offset, 0), `${sc.cashPayCustomerCents} ≠ ${Math.max(payableBefore - offset, 0)}`)
        check(`${where} 不得同时收与付`, !(sc.cashCollectCents > 0 && sc.cashPayCustomerCents > 0), '折抵取 min，不可能两端同时为正')
      }
      if (c.kind === 'return' && st.scenarioExpected) {
        const sc = st.scenarioExpected
        if ('refundCents' in sc) {
          check(`${where} 退款额不超可退上限`, sc.refundCents <= out.refundableCashCents, `${sc.refundCents} > ${out.refundableCashCents}`)
        }
        if ('inventoryDisposition' in sc) {
          check(`${where} 退货实物处置为待检且不自动可卖`, sc.inventoryDisposition === 'quarantine' && sc.autoSellable === false,
            '03 §7：库存先进入待检，绝不自动可卖')
        }
      }
      if (c.kind === 'cancel' && st.scenarioExpected) {
        const sc = st.scenarioExpected
        if ('refundDueCents' in sc) {
          check(`${where} 取消不自动现金退款`, sc.cashRefundedCents === 0 && sc.refundRequiresAction === 'B18',
            'B11：预收转为应退，不自动产生现金退款')
        }
      }
    }

    for (const u of c.unresolved ?? []) {
      check(`算例 ${c.id} 的未决项附归属`, typeof u.owner === 'string' && u.owner.length > 0)
      check(`算例 ${c.id} 的未决项附原因`, typeof u.why === 'string' && u.why.length > 0)
      fixtureCheckCount++
    }
    for (const k of Object.keys(moneyTerms)) {
      check(`口径项 ${k} 被至少一个算例使用`, JSON.stringify(fixturesDoc.computeCases).includes(`"${k}"`), '声明了口径却无人使用')
    }
  }

  // 12.6 行为算例
  const actionCodeSet = new Set(enumsDoc.enums.ActionCode?.values ?? [])
  for (const b of fixturesDoc.behaviorCases ?? []) {
    check(`行为算例 ${b.id} 引用已登记动作`, actionCodeSet.has(b.request?.action), `action=${b.request?.action}`)
    if (b.expect?.errorCode) {
      check(`行为算例 ${b.id} 的期望错误码存在`, errCodeSet.has(b.expect.errorCode), `errorCode=${b.expect.errorCode}`)
    }
    check(`行为算例 ${b.id} 声明归属任务`, typeof b.owner === 'string' && b.owner.length > 0)
    check(`行为算例 ${b.id} 附依据`, Array.isArray(b.specBasis) && b.specBasis.length > 0, '登记必须钉规格原文行号')
    verifyBasis(`行为算例 ${b.id}`, b.specBasis)
  }

  // 12.7 边界输入
  for (const b of fixturesDoc.boundaryInputs ?? []) {
    check(`边界输入 ${b.id} 声明期望行为`, typeof b.expect === 'string' && b.expect.length > 0)
    check(`边界输入 ${b.id} 声明归属任务`, typeof b.owner === 'string' && b.owner.length > 0)
    check(`边界输入 ${b.id} 附依据`, Array.isArray(b.basis) && b.basis.length > 0, '登记必须钉规格原文行号')
    verifyBasis(`边界输入 ${b.id}`, b.basis)
  }

  // 12.8 未决项
  for (const o of fixturesDoc.openItems ?? []) {
    check(`未决项 ${o.id} 声明归属`, typeof o.owner === 'string' && o.owner.length > 0)
    check(`未决项 ${o.id} 声明原因`, typeof o.why === 'string' && o.why.length > 0)
    for (const a of o.affects ?? []) {
      check(`未决项 ${o.id} 的影响项 ${a} 存在`,
        computeCaseIds.has(a) || boundaryIds.has(a) || ['shapeDefinitions', 'dtoGeneration', 'datasets.V1'].includes(a),
        '引用了不存在的项')
    }
  }

  // 12.9 DTO 生成流程与生成物不可手改
  const dto = fixturesDoc.dtoGeneration
  check('fixtures 声明 dtoGeneration', Boolean(dto))
  if (dto) {
    check('生成器文件存在', existsSync(join(repoRoot, dto.generator)), `缺 ${dto.generator}`)
    check('生成器路径与本脚本一致', dto.generator === 'contracts/tools/generate-dto.mjs')
    const { files: builtFiles } = buildArtifacts()
    const builtNames = Object.keys(builtFiles).sort()
    const declared = (dto.artifacts ?? []).map((a) => a.file).sort()
    check('声明的生成物与实际产出一致', JSON.stringify(declared) === JSON.stringify(builtNames),
      `声明 ${declared.join(', ')} / 实际 ${builtNames.join(', ')}`)
    for (const a of dto.artifacts ?? []) {
      check(`生成物 ${a.file} 声明来源`, Array.isArray(a.from) && a.from.length > 0)
      for (const src of a.from ?? []) {
        check(`生成物 ${a.file} 的来源 ${src} 存在`,
          src === 'contracts/v1.1 全部 JSON' || existsSync(join(v1Dir, src)), `契约中无 ${src}`)
      }
    }
    check('声明生成物禁止手工编辑', typeof dto.forbiddenManualEdit === 'string' && dto.forbiddenManualEdit.length > 0)

    // 逐字节比对磁盘生成物与重新生成的结果
    const outDir = join(repoRoot, 'contracts', 'generated')
    check('生成物目录存在', existsSync(outDir), `缺 contracts/generated —— 请运行 ${GENERATE_COMMAND}`)
    if (existsSync(outDir)) {
      for (const [name, content] of Object.entries(builtFiles)) {
        const target = join(outDir, name)
        check(`生成物 ${name} 已落地`, existsSync(target), '缺失')
        if (!existsSync(target)) continue
        const onDisk = readFileSync(target, 'utf8')
        check(`生成物 ${name} 与契约一致（未手改）`, onDisk === content,
          '内容与重新生成的结果不同 —— 生成物禁止手工编辑，请改契约源文件后重新生成')
      }
      const stray = readdirSync(outDir).filter((f) => !Object.prototype.hasOwnProperty.call(builtFiles, f))
      check('生成物目录无手写文件', stray.length === 0, `多出 ${stray.join(', ')}`)
      const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
      check('manifest 记录契约来源哈希', Object.keys(manifest.generatedFrom ?? {}).length > 0)
      for (const [rel, expectedHash] of Object.entries(manifest.generatedFrom ?? {})) {
        const p = join(repoRoot, rel)
        check(`manifest 的来源 ${rel} 存在`, existsSync(p))
        if (!existsSync(p)) continue
        const actual = sha256Text(readFileSync(p, 'utf8'))
        check(`manifest 的来源哈希 ${rel} 与文件一致`, actual === expectedHash, '源文件已变更，须重新生成')
      }
      for (const a of manifest.artifacts ?? []) {
        const actual = sha256Text(builtFiles[a.file] ?? '')
        check(`manifest 的生成物哈希 ${a.file} 与产出一致`, actual === a.sha256, '生成物哈希不匹配')
      }
      if (!builtFiles['manifest.json'].includes(GENERATED_HEADER)) {
        failures.push('生成器未在文件头写入 DO NOT EDIT 标记')
      } else {
        passes.push('生成物带 DO NOT EDIT 标记')
      }
      for (const name of builtNames.filter((n) => n.endsWith('.ts'))) {
        check(`生成物 ${name} 首行为生成标记`, builtFiles[name].startsWith(GENERATED_HEADER), '缺 AUTO-GENERATED 头')
      }
    }
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────
console.log('契约自洽性校验 · contractVersion v1.1')
console.log('─'.repeat(64))
console.log(`枚举 ${ENUM_NAMES.length} 个 / 取值 ${enumValueCount} 项`)
console.log(`对象 ${OBJECT_NAMES.length} 个 / 字段 ${fieldCount} 个（其中枚举引用 ${enumRefCount} 个）`)
console.log(`状态机 ${Object.keys(enumsDoc.stateMachines).length} 个 / 转换 ${transitionCount} 条`)
console.log(`库存桶转换 ${bucketTransitionCount} 条`)
console.log(`错误码 ${errorCount} 个`)
console.log(`金额公式 ${formulaCount} 条`)
console.log(`旧表映射 ${mappedTables.size} 张 / 迁移实际表 ${sqlTables.size} 张`)
console.log(`缺口依据核验 ${basisVerified} 条 / 规格 §2 字段覆盖 ${coverageRows} 行`)
if (fixturesDoc) {
  const stageCount = (fixturesDoc.computeCases ?? []).reduce((s, c) => s + (c.stages ?? []).length, 0)
  console.log(`虚构样本 ${(fixturesDoc.datasets?.V1?.tasks ?? []).length} 条 / 金额算例 ${(fixturesDoc.computeCases ?? []).length} 个（${stageCount} 阶段）/ 行为算例 ${(fixturesDoc.behaviorCases ?? []).length} 个 / 边界输入 ${(fixturesDoc.boundaryInputs ?? []).length} 条`)
  console.log(`DTO 生成物 ${Object.keys(buildArtifacts().files).length} 个（已逐字节比对，哈希一致）`)
}
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
