/**
 * /api/v2 库存与商品路由（E04b）。
 *
 * 为什么单独成文件：`src/index.ts` 里旧 `/api` 的路由与业务混在一起（T-08），
 * 而本卡新增的是一整条新链路（契约路径、契约信封、幂等写入），塞进旧入口只会让它更难拆。
 * 入口只保留「分发一行」，其余都在这里。
 *
 * ⚠️ 本文件里的新权限码**不能**写进 `src/index.ts`：
 * `validate-contracts.mjs` 第 10.6 节会把 index.ts 里所有 `'xx/yy'` 字面量当成旧权限码，
 * 要求它们全部出现在 legacyPermissionMap 里。新码走本文件，旧校验不受影响。
 *
 * 承接 v1 库存动作；D10 正式期初和库存成本读字段由 contracts/v2/inventory-opening.json 增量定义。
 *   · R06  GET  /inventory                 权限 inventory/view        —— 型号汇总与逐件实物
 *   · R07  GET  /inventory/items/:id       权限 inventory/item-view   —— 实物详情、占用、来源、流水
 *   · B12  POST /inventory/products        权限 inventory/product-edit
 *   · B13  POST /inventory/openings        权限 inventory/opening（老板专属，旧 library/edit 不授予）
 *   · B19  POST /inventory/items/:id/inspection 权限 inventory/inspection（隔离件出 quarantine）
 *   · B16  POST /inventory/counts               权限 inventory/count（录入盘点，保存实盘不改库存）
 *   · B16  POST /inventory/counts/:id/approve   权限 inventory/count-approve（批准差异，老板专属）
 *   · R14  GET  /operations/:requestId     权限 null                  —— 「结果未知」后的第一步
 *
 * 成本字段：不查、不返回，而不是查出来再抹掉（04 §2 globalRules：「内部成本…不靠前端隐藏」）。
 * 因此无成本权限时响应里**没有** totalCostCents / acquisitionCostCents / costKnown 这几个键。
 */

import {
  INSPECTION_RELEASE_BUCKETS,
  INVENTORY_PERMISSIONS,
  STOCK_BUCKETS,
  approveCount,
  createCount,
  createOpening,
  inspectStockItem,
  makeItemAvailable,
  OPENING_COST_BASES,
  openOpeningWindow,
  recordRefurbishment,
  queryInventory,
  queryOpeningWindow,
  queryStockItem,
  writeProduct,
  type CountApproveInput,
  type CountInput,
  type CountLineInput,
  type InspectionReleaseBucket,
  type InspectionInput,
  type InspectionResult,
  type OpeningInput,
  type OpeningCostBasis,
  type OpeningLineInput,
  type ProductWriteInput,
  type MakeItemAvailableInput,
  type RefurbishmentInput,
  type StockBucket,
  type StockCondition,
} from '../domains/inventory'
import { findErrorDefinition } from '../generated/error-codes'
import { appendReadableDiagnostic, queryOperation } from '../domains/operations'

/** 只声明本模块用到的绑定，避免与入口的 Env 定义互相耦合。 */
export interface InventoryRouteEnv {
  DB: D1Database
  /** B13：preview 保留旧格式隔离试录；formal 启用 D10 正式窗口与四类成本。默认关闭。 */
  INVENTORY_OPENING_MODE?: string
}

/** 与入口的 AuthContext 结构一致；本模块只读，不重新判定会话。 */
export interface InventoryRouteContext {
  userId: number
  storeId: number
  permissions: string[]
}

const CONTRACT_VERSION = 'v2'
const PREFIX = '/api/v2'

const ITEM_PATH = /^\/api\/v2\/inventory\/items\/(.+)$/
// B19 待检件判定。必须比 ITEM_PATH 先匹配：ITEM_PATH 的 (.+) 会贪婪吞掉结尾的 `/inspection`，
// 若不先判断，`/inventory/items/x/inspection` 会被当成实物 id「x/inspection」走 GET 详情。
const INSPECTION_PATH = /^\/api\/v2\/inventory\/items\/(.+)\/inspection$/
const REFURBISHMENT_PATH = /^\/api\/v2\/inventory\/items\/([^/]+)\/refurbishments$/
const MAKE_AVAILABLE_PATH = /^\/api\/v2\/inventory\/items\/([^/]+)\/make-available$/
// B16 盘点：批准路径比录入路径更具体，先判断。两者都在 /inventory 前缀下，
// 与 /inventory/items/* 无交集（counts 不是 items），但保持「具体路径优先」的一致写法。
const COUNT_APPROVE_PATH = /^\/api\/v2\/inventory\/counts\/([^/]+)\/approve$/
const COUNTS_PATH = '/api/v2/inventory/counts'
const OPERATION_PATH = /^\/api\/v2\/operations\/([^/]+)$/

// ────────────────────────────── 契约信封 ──────────────────────────────

function meta(requestId: string | null) {
  return { requestId, serverTime: new Date().toISOString(), contractVersion: CONTRACT_VERSION }
}

function ok(data: unknown, requestId: string | null = null, status = 200): Response {
  return new Response(JSON.stringify({ data, meta: meta(requestId) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * 错误响应。`message` 是给人看的说明，程序分支一律看 `code`（errors.json rules 1）。
 */
function fail(
  code: string,
  message: string,
  status: number,
  options: { requestId?: string | null; currentVersion?: number; fieldErrors?: Record<string, string> } = {},
): Response {
  const error: Record<string, unknown> = { code, message, retryable: isRetryable(code) }
  if (options.fieldErrors) error.fieldErrors = options.fieldErrors
  if (options.currentVersion !== undefined) error.currentVersion = options.currentVersion
  return new Response(JSON.stringify({ error, meta: meta(options.requestId ?? null) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function isRetryable(code: string): boolean {
  return code === 'AUTH_REQUIRED' || code === 'SESSION_REVOKED' || code === 'RATE_LIMITED' || code === 'SERVICE_UNAVAILABLE'
}

// ────────────────────────────── 权限 ──────────────────────────────

/**
 * 新权限码 ← 契约声明的旧权限码（actions.json legacyPermissionMap 的 mapsTo / doesNotGrant）。
 *
 * 为什么要认旧码：门店现有角色行里存的是旧码（`library/view`、`library/edit`、`cost/view`），
 * 契约把它们的映射写死在 legacyPermissionMap 里。若本层只认新码，所有店员都会被判成无权限，
 * 而事实上契约已经声明这三个旧码涵盖这些读/写动作。
 *
 * 为什么 `inventory/opening` 不在表里：它是 owner_only，legacySource 为 null，
 * 且 `library/edit` 的 doesNotGrant 明确列出它（03 §8「期初属老板专属」）。
 * 把旧宽权限自动升级成期初录入 = 把老板能力下放给店员，属契约违规。
 */
const LEGACY_EQUIVALENT: Record<string, readonly string[]> = {
  [INVENTORY_PERMISSIONS.view]: ['library/view'],
  [INVENTORY_PERMISSIONS.itemView]: ['library/view'],
  [INVENTORY_PERMISSIONS.productView]: ['library/view'],
  [INVENTORY_PERMISSIONS.productEdit]: ['library/edit'],
  [INVENTORY_PERMISSIONS.inspection]: ['library/edit'],
  [INVENTORY_PERMISSIONS.refurbish]: ['library/edit'],
  // B16 盘点录入：契约 legacySource=library/edit（grantPolicy=default）。
  // ⚠️ 批准（inventory/count-approve）**刻意不在本表**：它 legacySource=null、grantPolicy=owner_only，
  // 把旧宽权限自动升级成批准权 = 让店员能改库存账，属契约违规（noWideningGuard）。这条表只认新码。
  [INVENTORY_PERMISSIONS.count]: ['library/edit'],
  [INVENTORY_PERMISSIONS.costView]: ['cost/view'],
} as const

function grants(context: InventoryRouteContext, code: string): boolean {
  if (context.permissions.includes('*') || context.permissions.includes(code)) return true
  return (LEGACY_EQUIVALENT[code] ?? []).some((legacy) => context.permissions.includes(legacy))
}

/** 成本可见性单独判定：它不守卫动作，只决定响应里是否有这些字段（permissionModel.levels）。 */
function canViewCost(context: InventoryRouteContext): boolean {
  return grants(context, INVENTORY_PERMISSIONS.costView)
}

// ────────────────────────────── 入参解析 ──────────────────────────────

/**
 * requestId：body 与 Idempotency-Key 头两处都有时必须一致（conventions.write.idempotencyHeader）。
 * 缺失即拒绝 —— 没有 requestId 就没有幂等，写动作不可能「恰好一次」。
 */
function requireRequestId(body: Record<string, unknown>, req: Request): string | null {
  const fromBody = typeof body.requestId === 'string' ? body.requestId.trim() : ''
  const headerValue = req.headers.get('Idempotency-Key')
  const fromHeader = headerValue ? headerValue.trim() : ''
  if (fromBody && fromHeader && fromBody !== fromHeader) return null
  return fromBody || fromHeader || null
}

function asText(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function asInt(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value
}

function parseProductInput(body: Record<string, unknown>): { input: ProductWriteInput | null; problem: string | null } {
  const name = asText(body.name)
  if (!name) return { input: null, problem: '商品名称不能为空' }
  const trackingMode = body.trackingMode === 'item' ? 'item' : body.trackingMode === 'quantity' ? 'quantity' : null
  if (!trackingMode) return { input: null, problem: 'trackingMode 只能是 item 或 quantity' }
  if (typeof body.requiresSn !== 'boolean') return { input: null, problem: 'requiresSn 必须是布尔值' }

  const status = body.status === undefined || body.status === null ? undefined : body.status
  if (status !== undefined && status !== 'active' && status !== 'disabled') {
    return { input: null, problem: 'status 只能是 active 或 disabled' }
  }
  const priceRaw = body.defaultSalePriceCents
  let defaultSalePriceCents: number | null = null
  if (priceRaw !== undefined && priceRaw !== null) {
    if (typeof priceRaw !== 'number' || !Number.isInteger(priceRaw) || priceRaw < 0) {
      return { input: null, problem: '默认售价必须是非负整数分' }
    }
    defaultSalePriceCents = priceRaw
  }
  const expectedVersionRaw = body.expectedVersion
  let expectedVersion: number | null = null
  if (expectedVersionRaw !== undefined && expectedVersionRaw !== null) {
    if (typeof expectedVersionRaw !== 'number' || !Number.isInteger(expectedVersionRaw) || expectedVersionRaw < 1) {
      return { input: null, problem: 'expectedVersion 必须是正整数' }
    }
    expectedVersion = expectedVersionRaw
  }

  return {
    input: {
      productRef: asText(body.productRef),
      expectedVersion,
      sku: asText(body.sku),
      name,
      category: asText(body.category),
      brand: asText(body.brand),
      specs: asText(body.specs),
      defaultSalePriceCents,
      trackingMode,
      requiresSn: body.requiresSn,
      status: status as ProductWriteInput['status'],
    },
    problem: null,
  }
}

function parseOpeningInput(body: Record<string, unknown>): { input: OpeningInput | null; problem: string | null } {
  const approvedCountRef = asText(body.approvedCountRef)
  if (!approvedCountRef) return { input: null, problem: '期初必须填写人工实盘凭据（approvedCountRef）' }
  if (!Array.isArray(body.lines) || body.lines.length === 0) return { input: null, problem: '期初至少需要一行' }

  const basisRaw = body.costBasis as Record<string, unknown> | undefined | null
  let costBasis: OpeningInput['costBasis'] = null
  if (basisRaw !== undefined && basisRaw !== null) {
    const kind = basisRaw.kind
    if (kind !== 'known' && kind !== 'unknown') return { input: null, problem: 'costBasis.kind 只能是 known 或 unknown' }
    costBasis = { kind, note: asText(basisRaw.note) }
  }

  const lines: OpeningLineInput[] = []
  for (const [index, raw] of (body.lines as unknown[]).entries()) {
    const at = `第 ${index + 1} 行`
    if (!raw || typeof raw !== 'object') return { input: null, problem: `${at}：行数据无效` }
    const line = raw as Record<string, unknown>
    const productRef = asText(line.productRef)
    if (!productRef) return { input: null, problem: `${at}：缺少 productRef` }
    const qty = asInt(line.qty)
    if (qty === null || qty < 1) return { input: null, problem: `${at}：数量必须是正整数` }
    const condition = line.condition === undefined || line.condition === null ? undefined : line.condition
    if (condition !== undefined && condition !== 'new' && condition !== 'used') {
      return { input: null, problem: `${at}：成色只能是 new 或 used` }
    }
    // 未知成本必须是「没给金额」；给 0 是「这件是零成本」，两者不能混（03 §1 R01）。
    let unitCostCents: number | null | undefined = undefined
    if (line.unitCostCents !== undefined && line.unitCostCents !== null) {
      if (typeof line.unitCostCents !== 'number' || !Number.isInteger(line.unitCostCents) || line.unitCostCents < 0) {
        return { input: null, problem: `${at}：单件成本必须是非负整数分` }
      }
      unitCostCents = line.unitCostCents
    } else {
      unitCostCents = null
    }
    lines.push({
      productRef,
      qty,
      condition: condition as StockCondition | undefined,
      assetCode: asText(line.assetCode) ?? undefined,
      snRaw: asText(line.snRaw) ?? undefined,
      remark: asText(line.remark),
      unitCostCents,
    })
  }

  return {
    input: {
      approvedCountRef,
      costBasis,
      note: asText(body.note),
      occurredAt: asText(body.occurredAt),
      lines,
    },
    problem: null,
  }
}

/** D10 正式录入：成本口径逐行声明，不能继承旧版“已知 / 未知”整单标签。 */
function parseFormalOpeningInput(body: Record<string, unknown>): { input: OpeningInput | null; problem: string | null } {
  const approvedCountRef = asText(body.approvedCountRef)
  if (!approvedCountRef) return { input: null, problem: '期初必须填写人工实盘凭据（approvedCountRef）' }
  if (!Array.isArray(body.lines) || body.lines.length === 0) return { input: null, problem: '期初至少需要一行' }

  const lines: OpeningLineInput[] = []
  for (const [index, raw] of (body.lines as unknown[]).entries()) {
    const at = `第 ${index + 1} 行`
    if (!raw || typeof raw !== 'object') return { input: null, problem: `${at}：行数据无效` }
    const line = raw as Record<string, unknown>
    const productRef = asText(line.productRef)
    if (!productRef) return { input: null, problem: `${at}：缺少 productRef` }
    const qty = asInt(line.qty)
    if (qty === null || qty < 1) return { input: null, problem: `${at}：数量必须是正整数` }
    const condition = line.condition === undefined || line.condition === null ? undefined : line.condition
    if (condition !== undefined && condition !== 'new' && condition !== 'used') {
      return { input: null, problem: `${at}：成色只能是 new 或 used` }
    }
    if (typeof line.costBasis !== 'string' || !(OPENING_COST_BASES as readonly string[]).includes(line.costBasis)) {
      return { input: null, problem: `${at}：必须明确选择实际成本、估值、未知或真实零成本` }
    }
    const approvedCountLineRef = asText(line.approvedCountLineRef)
    if (!approvedCountLineRef || approvedCountLineRef.length > 120) {
      return { input: null, problem: `${at}：必须填写盘点明细行引用（最多 120 个字符）` }
    }
    let unitCostCents: number | null = null
    if (line.unitCostCents !== undefined && line.unitCostCents !== null) {
      if (typeof line.unitCostCents !== 'number' || !Number.isSafeInteger(line.unitCostCents) || line.unitCostCents < 0) {
        return { input: null, problem: `${at}：单件成本必须为非负整数分` }
      }
      unitCostCents = line.unitCostCents
    }
    lines.push({
      approvedCountLineRef,
      productRef,
      qty,
      condition: condition as StockCondition | undefined,
      assetCode: asText(line.assetCode) ?? undefined,
      snRaw: asText(line.snRaw) ?? undefined,
      remark: asText(line.remark),
      unitCostCents,
      costBasis: line.costBasis as OpeningCostBasis,
      costEvidenceRef: asText(line.costEvidenceRef),
      costAssessedAt: asText(line.costAssessedAt),
    })
  }
  return {
    input: {
      approvedCountRef,
      note: asText(body.note),
      occurredAt: asText(body.occurredAt),
      lines,
    },
    problem: null,
  }
}

/** B19 入参。disposition 只认 available / retired；evidence 缺省视为空数组。 */
function parseInspectionInput(body: Record<string, unknown>): { input: InspectionInput | null; problem: string | null } {
  const result = body.result
  if (result !== 'pass' && result !== 'fail') return { input: null, problem: 'result 只能是 pass 或 fail' }

  const findings = asText(body.findings)
  if (!findings) return { input: null, problem: 'findings 不能为空：判定必须留下可追溯的检测发现' }

  const disposition = body.disposition
  if (!(INSPECTION_RELEASE_BUCKETS as readonly string[]).includes(disposition as string)) {
    return { input: null, problem: `disposition 只能是 ${INSPECTION_RELEASE_BUCKETS.join(' 或 ')}：待检件只能放回可卖或报废离店` }
  }

  const expectedVersion = asInt(body.expectedVersion)
  if (expectedVersion === null || expectedVersion < 1) {
    return { input: null, problem: 'expectedVersion 必须是正整数（判定必须基于一个明确的实物版本）' }
  }

  const evidence: string[] = []
  const rawEvidence = body.evidence
  if (rawEvidence !== undefined && rawEvidence !== null) {
    if (!Array.isArray(rawEvidence)) return { input: null, problem: 'evidence 必须是附件 id 数组' }
    for (const entry of rawEvidence) {
      const text = asText(entry)
      if (!text) return { input: null, problem: 'evidence 里的每一项都必须是非空附件 id' }
      evidence.push(text)
    }
  }

  return {
    input: {
      result: result as InspectionResult,
      findings,
      evidence,
      disposition: disposition as InspectionReleaseBucket,
      expectedVersion,
      occurredAt: asText(body.occurredAt),
    },
    problem: null,
  }
}

  function parseRefurbishmentInput(body: Record<string, unknown>): { input: RefurbishmentInput | null; problem: string | null } {
    const category = asText(body.category)
    const amountCents = asInt(body.amountCents)
    if (!category) return { input: null, problem: 'category 不能为空' }
    if (amountCents === null || amountCents <= 0) return { input: null, problem: 'amountCents 必须是正整数分' }
    if (typeof body.capitalizable !== 'boolean') return { input: null, problem: 'capitalizable 必须是布尔值' }
    if (body.paymentEntryRef != null && typeof body.paymentEntryRef !== 'string') return { input: null, problem: 'paymentEntryRef 必须是文本编号' }
    if (body.evidenceRef != null && typeof body.evidenceRef !== 'string') return { input: null, problem: 'evidenceRef 必须是文本编号' }
    return { input: { category, amountCents, capitalizable: body.capitalizable, paymentEntryRef: asText(body.paymentEntryRef), evidenceRef: asText(body.evidenceRef), occurredAt: asText(body.occurredAt) }, problem: null }
  }

function parseMakeAvailableInput(body: Record<string, unknown>): { input: MakeItemAvailableInput | null; problem: string | null } {
  const conditionGrade = body.conditionGrade
  const salePriceCents = asInt(body.salePriceCents)
  const disclosureNote = asText(body.disclosureNote)
  const warrantyTerm = body.warrantyTerm
  const expectedVersion = asInt(body.expectedVersion)
  if (!['brand_new', 'like_new', 'excellent', 'good', 'fair'].includes(conditionGrade as string)) return { input: null, problem: 'conditionGrade 取值无效' }
  if (salePriceCents === null || salePriceCents <= 0) return { input: null, problem: 'salePriceCents 必须是正整数分' }
  if (!disclosureNote) return { input: null, problem: 'disclosureNote 不能为空' }
  if (typeof body.dataDisposed !== 'boolean') return { input: null, problem: 'dataDisposed 必须是布尔值' }
  if (!['3', '6', '12', '24'].includes(warrantyTerm as string)) return { input: null, problem: 'warrantyTerm 只能是 3、6、12 或 24' }
  if (expectedVersion === null || expectedVersion < 1) return { input: null, problem: 'expectedVersion 必须是正整数' }
  return { input: { conditionGrade: conditionGrade as MakeItemAvailableInput['conditionGrade'], salePriceCents, disclosureNote, dataDisposed: body.dataDisposed, warrantyTerm: warrantyTerm as MakeItemAvailableInput['warrantyTerm'], expectedVersion }, problem: null }
}

// ────────────────────────────── 写结果 → 响应 ──────────────────────────────

/**
 * 给校验类失败补一句人能用的说明。
 *
 * 为什么要补：契约的 `VALIDATION_ERROR.meaning` 是「字段无效，或金额不是整数分」，
 * 而写动作的断言守卫（T04「约束即断言」）只把**错误码**带出异常，不带细节。
 * 于是「这件商品已经有库存事实了，不能再走期初」这种最需要说清楚的情况，
 * 用户看到的却是「字段无效」—— 字段明明没填错。E04b 浏览器验收就撞到了这一条。
 *
 * 只改展示文案，不改 code：程序分支仍只看 code（errors.json rules 1）。
 * 文案写成「可能是…」，因为服务端确实分辨不出守卫里是哪一条先命中。
 *
 * ⚠️ 只在**领域层没给出更具体文案**时才替换（拿生成物的 meaning 比对，不是自己写一份兜底字串）：
 * 像「第 1 行：整单声明成本已知，却缺少 unitCostCents」「修改商品必须带 expectedVersion」
 * 这类已经说得清楚的，原样保留。
 */
const GENERIC_VALIDATION_MEANING = findErrorDefinition('VALIDATION_ERROR')?.meaning ?? '字段无效，或金额不是整数分'

function guidanceFor(code: string, message: string, action: 'product' | 'opening' | 'opening-window'): string | null {
  if (code !== 'VALIDATION_ERROR') return null
  if (message !== GENERIC_VALIDATION_MEANING) return null
  if (action === 'opening') {
    return '期初没有通过校验。最常见的两种：该型号已经有库存事实（期初只能建一次，补货走采购、差异走盘点）；'
      + '或者数量、内部编号、成本与商品属性不一致（逐件型号必须一行一件，内部编号由系统生成；按数量型号不要填逐件编号）。'
  }
  if (action === 'opening-window') return '正式期初窗口必须在本店第一笔正式库存经营流水前开启，且每店只能开启一次。'
  return '商品没有通过校验。最常见的两种：SKU 在本店已经存在；或者该商品已经产生过库存事实，'
    + '此时不允许再改「逐件管理 / 需要 SN」（改了会让既有实物与属性自相矛盾）。'
}

interface WriteSuccess {
  ok: true
  requestId: string
  outcome: unknown
}

interface WriteFailure {
  ok: false
  code: string
  message: string
  httpStatus: number
  requestId: string
  currentVersion?: number
  diagnostic?: string
}

/** 幂等执行器的 RunResult 与期初的预校验失败共用同一形态：都有 ok / code / httpStatus / message。 */
function writeResponse(result: WriteSuccess | WriteFailure, context: 'product' | 'opening' | 'opening-window'): Response {
  if (result.ok) {
    const outcome = result.outcome as { entityType?: string; entityId?: string; version?: number; summary?: string; effects?: Record<string, unknown> }
    return ok(
      {
        operationId: result.requestId,
        entityId: outcome.entityId ?? null,
        entityVersion: outcome.version ?? null,
        state: null,
        effects: outcome.effects ?? {},
        summary: outcome.summary ?? '',
      },
      result.requestId,
    )
  }
  const message = appendReadableDiagnostic(guidanceFor(result.code, result.message, context) ?? result.message, result.diagnostic)
  return fail(result.code, message, result.httpStatus, { requestId: result.requestId, currentVersion: result.currentVersion })
}

// ────────────────────────────── 路由 ──────────────────────────────

function requireGrant(context: InventoryRouteContext, code: string): Response | null {
  return grants(context, code) ? null : fail('PERMISSION_DENIED', '无该动作权限', 403)
}

async function handleInventoryRead(req: Request, env: InventoryRouteEnv, context: InventoryRouteContext): Promise<Response> {
  const denied = requireGrant(context, INVENTORY_PERMISSIONS.view)
  if (denied) return denied

  const url = new URL(req.url)
  const condition = url.searchParams.get('condition')
  if (condition && condition !== 'new' && condition !== 'used') {
    return fail('VALIDATION_ERROR', 'condition 只能是 new 或 used', 400)
  }
  const availability = url.searchParams.get('availability')
  if (availability && !(STOCK_BUCKETS as readonly string[]).includes(availability)) {
    return fail('VALIDATION_ERROR', 'availability 不是合法的库存状态', 400)
  }
  const limitRaw = url.searchParams.get('limit')
  let limit: number | null = null
  if (limitRaw !== null && limitRaw !== '') {
    if (!/^\d+$/.test(limitRaw)) return fail('VALIDATION_ERROR', 'limit 必须是正整数', 400)
    limit = Number(limitRaw)
  }

  const result = await queryInventory(
    env.DB,
    context.storeId,
    {
      q: url.searchParams.get('q'),
      productRef: url.searchParams.get('productRef'),
      condition: (condition as StockCondition | null) ?? null,
      availability: (availability as StockBucket | null) ?? null,
      limit,
      cursor: url.searchParams.get('cursor'),
    },
    { includeCost: canViewCost(context) },
  )
  const openingMode = env.INVENTORY_OPENING_MODE === 'preview'
    ? 'preview'
    : env.INVENTORY_OPENING_MODE === 'formal'
      ? 'formal'
      : 'disabled'
  const openingWindow = await queryOpeningWindow(env.DB, context.storeId, openingMode)

  return ok(
    {
      items: result.items,
      lotItems: result.lotItems,
      batches: result.batches,
      totals: result.totals,
      filters: result.filters,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      openingWindow,
    },
    null,
  )
}

async function handleStockItemRead(req: Request, env: InventoryRouteEnv, context: InventoryRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, INVENTORY_PERMISSIONS.itemView)
  if (denied) return denied

  let stockItemId = rawId
  try {
    stockItemId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '实物编号无法解析', 400)
  }

  const detail = await queryStockItem(env.DB, context.storeId, stockItemId, { includeCost: canViewCost(context) })
  // 跨店或不存在一律 404：不泄露别家门店有没有这件实物（03 §1）。
  if (!detail) return fail('ENTITY_NOT_FOUND', '实物不存在或不属于当前门店', 404)
  return ok(detail, null)
}

async function handleProductWrite(req: Request, env: InventoryRouteEnv, context: InventoryRouteContext): Promise<Response> {
  const denied = requireGrant(context, INVENTORY_PERMISSIONS.productEdit)
  if (denied) return denied

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return fail('VALIDATION_ERROR', '请求体不是合法 JSON', 400)
  }

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parseProductInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '商品数据无效', 400, { requestId })

  const result = await writeProduct(env.DB, { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B12', payloadHash: '' }, input)
  return writeResponse(result, 'product')
}

async function handleOpeningWrite(req: Request, env: InventoryRouteEnv, context: InventoryRouteContext): Promise<Response> {
  // 期初是老板专属：这里只认新码，旧 library/edit 不得自动获得（contracts noWideningGuard）。
  const denied = requireGrant(context, INVENTORY_PERMISSIONS.opening)
  if (denied) return denied
  const mode = env.INVENTORY_OPENING_MODE
  if (mode !== 'preview' && mode !== 'formal') {
    return fail('VALIDATION_ERROR', '期初入口未在当前环境启用。', 409)
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return fail('VALIDATION_ERROR', '请求体不是合法 JSON', 400)
  }

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  if (mode === 'formal' && body.command !== undefined) {
    if (body.command !== 'open_window') return fail('VALIDATION_ERROR', '正式期初命令无效', 400, { requestId })
    const durationDays = asInt(body.durationDays)
    if (durationDays === null || durationDays < 1 || durationDays > 7) {
      return fail('VALIDATION_ERROR', '正式期初窗口期限必须为 1 至 7 天', 400, { requestId })
    }
    const result = await openOpeningWindow(env.DB, {
      storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B13', payloadHash: '',
    }, durationDays)
    return writeResponse(result, 'opening-window')
  }

  if (mode === 'preview') {
    if (body.command !== undefined) return fail('VALIDATION_ERROR', '隔离预览只支持旧格式试录，不能开启正式期初窗口', 409, { requestId })
    if (Array.isArray(body.lines) && body.lines.some((raw) => raw && typeof raw === 'object' && (
      'approvedCountLineRef' in (raw as Record<string, unknown>)
      || 'costBasis' in (raw as Record<string, unknown>)
      || 'costEvidenceRef' in (raw as Record<string, unknown>)
      || 'costAssessedAt' in (raw as Record<string, unknown>)
    ))) {
      return fail('VALIDATION_ERROR', '隔离预览只接受旧格式；四类成本仅在正式期初流程使用', 409, { requestId })
    }
  }

  const { input, problem } = mode === 'formal' ? parseFormalOpeningInput(body) : parseOpeningInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '期初数据无效', 400, { requestId })

  const result = await createOpening(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B13', payloadHash: '' },
    input,
    { requireOpenWindow: mode === 'formal', requireFormalMetadata: mode === 'formal' },
  )
  return writeResponse(result, 'opening')
}

/**
 * B19 待检件判定（隔离件出 quarantine）。
 *
 * 权限用新码 inventory/inspection；契约 legacyPermissionMap 声明它由旧码 library/edit 映射而来，
 * 所以门店现有存旧码的角色也能用（LEGACY_EQUIVALENT 里登记）。
 */
async function handleInspectionWrite(
  req: Request,
  env: InventoryRouteEnv,
  context: InventoryRouteContext,
  rawId: string,
): Promise<Response> {
  const denied = requireGrant(context, INVENTORY_PERMISSIONS.inspection)
  if (denied) return denied

  let stockItemId = rawId
  try {
    stockItemId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '实物编号无法解析', 400)
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return fail('VALIDATION_ERROR', '请求体不是合法 JSON', 400)
  }

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parseInspectionInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '判定数据无效', 400, { requestId })

  const result = await inspectStockItem(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B19', payloadHash: '' },
    stockItemId,
    input,
  )

  if (result.ok) {
    const outcome = result.outcome
    return ok(
      {
        operationId: result.requestId,
        entityId: outcome.entityId ?? null,
        entityVersion: outcome.version ?? null,
        state: null,
        effects: outcome.effects ?? {},
        summary: outcome.summary ?? '',
      },
      result.requestId,
    )
  }
  // RunFailed 带脱敏诊断、InspectionRequestFailure 不带，统一取一下再翻译成可读线索。
  const diagnostic = 'diagnostic' in result ? result.diagnostic : undefined
  const message = appendReadableDiagnostic(result.message, diagnostic)
  return fail(result.code, message, result.httpStatus, { requestId: result.requestId, currentVersion: result.currentVersion })
}

function b30WriteResponse(result: WriteSuccess | WriteFailure): Response {
  if (result.ok) {
    const outcome = result.outcome as { entityId?: string; version?: number; summary?: string; effects?: Record<string, unknown> }
    return ok({ operationId: result.requestId, entityId: outcome.entityId ?? null, entityVersion: outcome.version ?? null, state: null, effects: outcome.effects ?? {}, summary: outcome.summary ?? '' }, result.requestId)
  }
  return fail(result.code, appendReadableDiagnostic(result.message, result.diagnostic), result.httpStatus, { requestId: result.requestId, currentVersion: result.currentVersion })
}

async function handleRefurbishmentWrite(req: Request, env: InventoryRouteEnv, context: InventoryRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, INVENTORY_PERMISSIONS.refurbish)
  if (denied) return denied
  let stockItemId: string
  try { stockItemId = decodeURIComponent(rawId) } catch { return fail('VALIDATION_ERROR', '实物编号无法解析', 400) }
  let body: Record<string, unknown>
  try { body = (await req.json()) as Record<string, unknown> } catch { return fail('VALIDATION_ERROR', '请求体不是合法 JSON', 400) }
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)
  const { input, problem } = parseRefurbishmentInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '整备数据无效', 400, { requestId })
  return b30WriteResponse(await recordRefurbishment(env.DB, { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B30', payloadHash: '' }, stockItemId, input))
}

async function handleMakeAvailableWrite(req: Request, env: InventoryRouteEnv, context: InventoryRouteContext, rawId: string): Promise<Response> {
  const denied = requireGrant(context, INVENTORY_PERMISSIONS.refurbish)
  if (denied) return denied
  let stockItemId: string
  try { stockItemId = decodeURIComponent(rawId) } catch { return fail('VALIDATION_ERROR', '实物编号无法解析', 400) }
  let body: Record<string, unknown>
  try { body = (await req.json()) as Record<string, unknown> } catch { return fail('VALIDATION_ERROR', '请求体不是合法 JSON', 400) }
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)
  const { input, problem } = parseMakeAvailableInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '上架数据无效', 400, { requestId })
  return b30WriteResponse(await makeItemAvailable(env.DB, { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B30', payloadHash: '' }, stockItemId, input))
}

// ────────────────────────────── B16 盘点 ──────────────────────────────

/** B16 入参（录入）。scope 可缺省；lines 至少一行，逐行 countedQty 必须是非负整数。 */
function parseCountInput(body: Record<string, unknown>): { input: CountInput | null; problem: string | null } {
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return { input: null, problem: '盘点至少需要一行实盘结果' }
  }

  const scopeRaw = body.scope as Record<string, unknown> | undefined | null
  let scope: CountInput['scope'] = null
  if (scopeRaw !== undefined && scopeRaw !== null) {
    if (typeof scopeRaw !== 'object') return { input: null, problem: 'scope 必须是对象' }
    const rawAsOf = scopeRaw.asOf
    const asOf = rawAsOf === undefined || rawAsOf === null ? null : asText(rawAsOf)
    if (rawAsOf !== undefined && rawAsOf !== null && !asOf) {
      return { input: null, problem: 'scope.asOf 必须是非空字符串' }
    }
    scope = { asOf, note: asText(scopeRaw.note) }
  }

  const lines: CountLineInput[] = []
  for (const [index, raw] of (body.lines as unknown[]).entries()) {
    const at = `第 ${index + 1} 行`
    if (!raw || typeof raw !== 'object') return { input: null, problem: `${at}：行数据无效` }
    const line = raw as Record<string, unknown>
    const productRef = asText(line.productRef)
    if (!productRef) return { input: null, problem: `${at}：缺少 productRef` }
    const countedQty = asInt(line.countedQty)
    if (countedQty === null || countedQty < 0) return { input: null, problem: `${at}：实盘数量必须是非负整数` }
    lines.push({ productRef, countedQty, note: asText(line.note) })
  }

  return { input: { scope, note: asText(body.note), lines }, problem: null }
}

/** B16 入参（批准）。理由必填 —— 契约把「批准差异理由」列为输入。 */
function parseCountApproveInput(body: Record<string, unknown>): { input: CountApproveInput | null; problem: string | null } {
  const reason = asText(body.reason)
  if (!reason) return { input: null, problem: '批准差异必须填写理由' }
  const rawVersion = body.expectedVersion
  let expectedVersion: number | null = null
  if (rawVersion !== undefined && rawVersion !== null) {
    expectedVersion = asInt(rawVersion)
    if (expectedVersion === null || expectedVersion < 1) return { input: null, problem: 'expectedVersion 必须是正整数' }
  }
  return { input: { reason, expectedVersion }, problem: null }
}

/**
 * 盘点写动作的响应装配。
 *
 * 为什么不复用 writeResponse：那个函数的文案兜底是按 product / opening 两个域写的
 * （见 guidanceFor），而盘点的校验失败原因由领域层逐条给出，不需要通用话术。
 */
function countWriteResponse(result: WriteSuccess | WriteFailure): Response {
  if (result.ok) {
    const outcome = result.outcome as { entityId?: string; version?: number; summary?: string; effects?: Record<string, unknown> }
    return ok(
      {
        operationId: result.requestId,
        entityId: outcome.entityId ?? null,
        entityVersion: outcome.version ?? null,
        state: null,
        effects: outcome.effects ?? {},
        summary: outcome.summary ?? '',
      },
      result.requestId,
    )
  }
  const message = appendReadableDiagnostic(result.message, result.diagnostic)
  return fail(result.code, message, result.httpStatus, { requestId: result.requestId, currentVersion: result.currentVersion })
}

/**
 * B16 盘点录入（POST /inventory/counts）。
 *
 * 权限用新码 inventory/count（契约 legacySource=library/edit，旧码店员可用）。
 * ⚠️ 本动作**不写任何 inventory_movements**：保存实盘只把事实记下来，
 * 库存差异要等老板走第二个路径批准才生成（02 §5「差异保存不自动改变库存」）。
 */
async function handleCountWrite(req: Request, env: InventoryRouteEnv, context: InventoryRouteContext): Promise<Response> {
  const denied = requireGrant(context, INVENTORY_PERMISSIONS.count)
  if (denied) return denied

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return fail('VALIDATION_ERROR', '请求体不是合法 JSON', 400)
  }

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parseCountInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '盘点数据无效', 400, { requestId })

  const result = await createCount(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B16', payloadHash: '' },
    input,
  )
  return countWriteResponse(result)
}

/**
 * B16 批准盘点差异（POST /inventory/counts/:id/approve），老板专属。
 *
 * ⚠️ 只认新码 inventory/count-approve：契约 legacySource=null、grantPolicy=owner_only，
 * 旧 library/edit 不得自动获得批准权（noWideningGuard）。
 * 这是 B16 唯一改库存的地方 —— 逐行写 source='count_adjustment' 的流水，由 0007 触发器结算余额。
 */
async function handleCountApproveWrite(
  req: Request,
  env: InventoryRouteEnv,
  context: InventoryRouteContext,
  rawId: string,
): Promise<Response> {
  const denied = requireGrant(context, INVENTORY_PERMISSIONS.countApprove)
  if (denied) return denied

  let countId = rawId
  try {
    countId = decodeURIComponent(rawId)
  } catch {
    return fail('VALIDATION_ERROR', '盘点单编号无法解析', 400)
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return fail('VALIDATION_ERROR', '请求体不是合法 JSON', 400)
  }

  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const { input, problem } = parseCountApproveInput(body)
  if (!input) return fail('VALIDATION_ERROR', problem ?? '批准数据无效', 400, { requestId })

  const result = await approveCount(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B16', payloadHash: '' },
    countId,
    input,
  )
  return countWriteResponse(result)
}

async function handleOperationRead(env: InventoryRouteEnv, context: InventoryRouteContext, requestId: string): Promise<Response> {
  const result = await queryOperation(env.DB, context.storeId, requestId)
  if (!result.found) {
    return ok({ status: 'unknown', resultRef: null, entityId: null, entityVersion: null, summary: null }, requestId)
  }
  return ok(
    {
      status: result.status === 'succeeded' ? 'succeeded' : 'pending',
      resultRef: result.outcome?.entityId ?? null,
      entityId: result.outcome?.entityId ?? null,
      entityVersion: result.outcome?.version ?? null,
      summary: result.outcome?.summary ?? null,
      mismatch: result.mismatch === true,
    },
    requestId,
  )
}

/**
 * 分发入口。返回 null 表示「不是本模块的路径」，由调用方继续走原来的 404。
 *
 * 只匹配 `/api/v2/...`；旧 `/api/...` 一律不接管，避免两条链路互相争抢同一个 URL。
 */
export async function routeInventoryV2(req: Request, env: InventoryRouteEnv, context: InventoryRouteContext): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname
  if (!path.startsWith(`${PREFIX}/`)) return null

  if (path === `${PREFIX}/inventory`) {
    if (req.method !== 'GET') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleInventoryRead(req, env, context)
  }

  // B30/B19 子路径必须排在实物详情之前：ITEM_PATH 的 (.+) 会贪婪吞掉子路径。
  const refurbishmentMatch = REFURBISHMENT_PATH.exec(path)
  if (refurbishmentMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleRefurbishmentWrite(req, env, context, refurbishmentMatch[1])
  }
  const makeAvailableMatch = MAKE_AVAILABLE_PATH.exec(path)
  if (makeAvailableMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleMakeAvailableWrite(req, env, context, makeAvailableMatch[1])
  }
  const inspectionMatch = INSPECTION_PATH.exec(path)
  if (inspectionMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleInspectionWrite(req, env, context, inspectionMatch[1])
  }

  const itemMatch = ITEM_PATH.exec(path)
  if (itemMatch) {
    if (req.method !== 'GET') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleStockItemRead(req, env, context, itemMatch[1])
  }

  if (path === `${PREFIX}/inventory/products`) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleProductWrite(req, env, context)
  }

  if (path === `${PREFIX}/inventory/openings`) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleOpeningWrite(req, env, context)
  }

  // B16 批准路径先判断（比录入路径更具体）。批准与录入是两个独立动作，
  // 权限也不同（count-approve 老板专属 / count 店员可用），所以是两条独立路径、两次独立鉴权。
  const countApproveMatch = COUNT_APPROVE_PATH.exec(path)
  if (countApproveMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleCountApproveWrite(req, env, context, countApproveMatch[1])
  }

  if (path === COUNTS_PATH) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleCountWrite(req, env, context)
  }

  const operationMatch = OPERATION_PATH.exec(path)
  if (operationMatch) {
    if (req.method !== 'GET') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleOperationRead(env, context, decodeURIComponent(operationMatch[1]))
  }

  // 只对本模块负责的路径报 404；其余 /api/v2 路径返回 null，交给后面的模块。
  // E05 起 /api/v2 下并存第二条链路（报价单），两个模块靠「谁认领」分工 ——
  // 如果这里继续对所有 /api/v2 路径兜底 404，报价链路永远不会被调用（实测就是这个症状）。
  if (path.startsWith(`${PREFIX}/inventory`)) {
    return fail('ENTITY_NOT_FOUND', '接口不存在', 404)
  }
  return null
}
