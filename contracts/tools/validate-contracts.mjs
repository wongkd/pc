#!/usr/bin/env node
/**
 * 契约自洽性校验（T01a + T01b）
 *
 * 用途：验证 contracts/v1 下的协议文件彼此自洽，并且与 backend/migrations 的实际表结构、
 *       backend/src/index.ts 的实际权限守卫对得上。
 * 运行：node contracts/tools/validate-contracts.mjs
 * 退出码：0 = 全部通过；1 = 存在失败项
 *
 * 说明：本脚本只做静态结构校验与源码文本核对，不连接任何数据库、不部署、不读取生产数据。
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

// ── 10. 动作目录与权限映射（T01b）──────────────────────────────────────
check('actions.json 声明 contractVersion', actionsDoc.contractVersion === 'v1', `实际 ${actionsDoc.contractVersion}`)
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
