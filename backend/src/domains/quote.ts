/**
 * 报价单领域（E05 报价闭环）。
 *
 * ── 契约依据 ──
 *   actions.json   B01 POST /sales/quotes（建草稿，sales/quote-edit）
 *                  B02 POST /sales/quotes/:id/save 与 /issue（sales/quote-edit）
 *                  R05 GET  /sales/quotes 与 /sales/quotes/:id（sales/quote-view）
 *   objects.json   Quote（customerId / title / currentRevision）
 *                  QuoteVersion（revision / status / validUntil / lines / discountCents /
 *                                termsSnapshot / issuedAt）
 *                  SaleLine（source / nameSnapshot / qty / unitPriceCents /
 *                            warrantySnapshot / customerDeviceRef）
 *   enums.json     QuoteStatus = draft | issued | confirmed | converted | expired | closed
 *                  LineSource  = new | used | customer | service
 *   money-rules    金额只有整数分；服务端重算为准，不采信客户端送来的小计
 *   0009_quote_core.sql + 0012_quote_confirmed.sql  四张表与全部硬约束（本模块只写数据，不重复实现约束）
 *
 * ── 本模块刻意不做的事 ──
 *   · 不动库存：报价阶段不预留、不扣减、不触发采购（R12）。全程没有一句写
 *     stock_reservations / inventory_movements 的语句。
 *   · 不签发分享凭证的校验逻辑：凭证在这里被建立（只存摘要），校验属顾客端那一刀（Q-09）。
 *   · 不实现报价转销售单（B03 convert）：属收款/订单卡，不混进报价卡。
 *
 * ── E05b 契约修订（2026-09-19）──
 *   QuoteStatus 新增 confirmed（issued → confirmed，动作 B42「记录顾客确认」）：
 *   确认 ≠ 付款、确认不锁库存（R12）——本模块的确认动作同样不写任何库存语句；
 *   确认后本版本不可再改：save 只替换 draft 版本，confirmed 版本无法被原地改写，
 *   要改必须出新版本重新发出并重新确认（R10）。
 */

import {
  assertRowVersionStatement,
  bumpVersionStatement,
  guardStatement,
  hashPayload,
  queryOperation,
  runIdempotent,
  type OperationContext,
  type OperationPlan,
  type OperationsDb,
  type RunResult,
} from './operations'
import {
  containsExtensionWarrantyCommitment,
  EXTENSION_WARRANTY_DEFERRED_MESSAGE,
  isExtensionWarrantyLine,
  WARRANTY_POLICY_LINES,
} from './warranty'

// ═══════════════════════════════ 常量 ═══════════════════════════════

export const QUOTE_LINE_SOURCES = ['new', 'used', 'customer', 'service'] as const
export type QuoteLineSource = (typeof QUOTE_LINE_SOURCES)[number]

export type QuoteStatusValue = 'draft' | 'issued' | 'confirmed' | 'converted' | 'expired' | 'closed'

export type StockItemAvailability = 'available' | 'reserved' | 'unavailable' | 'missing'

/**
 * 门店报价参数。
 *
 * U2（到期前提醒提前量）与 U3（续期给多久）一直是「待定」，所以这两个数只写在这里：
 * 要改就改这一处，不散落在 SQL、界面文案和测试里。每次发出（issue）都会把当时生效的
 * 这组值写进 `quote_versions.terms_snapshot`，于是历史版本仍能说清当时按哪套规则办的。
 */
export interface QuoteSettings {
  /** 报价有效期（小时）。业务规则 R2：24 小时。 */
  validityHours: number
  /** 到期前多少小时算「即将到期」。U2 暂按 2 小时。 */
  reminderLeadHours: number
  /** 付定金后的库存锁定时限（天）。U1 暂按 7 天，本卡不锁库存，只作为条款快照。 */
  reservationDays: number
  /** 预付款比例（百分数）。R1/D06：15%；不得据此自动判定不退。 */
  depositPercent: number
}

export const QUOTE_SETTINGS: QuoteSettings = {
  validityHours: 24,
  reminderLeadHours: 2,
  reservationDays: 7,
  depositPercent: 15,
}

/** D07行级快照默认：新件1年、二手件1个日历月；客供硬件单独表述本店90天安装工艺责任。 */
const DEFAULT_WARRANTY: Record<QuoteLineSource, { months: number; note: string }> = {
  new: { months: 12, note: '全新整机 / 本店售出配件：1 年' },
  used: { months: 1, note: '本店二手配件：1 个月' },
  customer: { months: 0, note: '客供配件硬件本身不属于本店售出商品；本店提供90天安装工艺保修，依法应承担的责任不受影响' },
  service: { months: 0, note: '服务费' },
}

const MAX_LINES = 200
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200

// ═══════════════════════════════ 入参类型 ═══════════════════════════════

export interface QuoteLineInput {
  source: QuoteLineSource
  /** 报价单是给人看的：名称与规格是快照，商品改名不改历史报价。 */
  nameSnapshot: string
  specSnapshot?: string | null
  qty: number
  unitPriceCents: number
  /** 商品引用（hardware.entity_id）。报价阶段允许为空 —— 临时行在成交前才必须映射。 */
  productRef?: string | null
  /** 二手件必须指定具体实物（QuoteVersion.rules）。它是引用，不是占用。 */
  stockItemId?: string | null
  /** 客供件的来源设备（customer_devices.id 的字符串形式）。 */
  customerDeviceRef?: string | null
  warrantySnapshot?: Record<string, unknown> | null
}

/**
 * 条款快照。
 *
 * 契约 QuoteVersion.termsSnapshot 是 `object`，因此这里的内容只要不破坏金额计算就允许。
 * 定金比例与顾客预算**没有独立列**（0009 设计要点 3）：契约里没有这两个字段，
 * 用实现给契约加字段属禁止项。
 */
export interface QuoteTermsInput {
  /** 顾客心理预算（分）。R03：不是付款动作，不进任何金额计算。 */
  budgetCents?: number | null
  /** 定金比例（百分数）。缺省用门店参数。 */
  depositPercent?: number | null
  /** 送货方式与阶梯。档位未定（Q-03）时只记方式，不编造运费。 */
  delivery?: {
    mode: 'self_pickup' | 'delivery'
    distanceKm?: number | null
    feeCents?: number | null
    note?: string | null
  } | null
  /** 整单质保条款补充；逐行质保另在 lines[].warrantySnapshot。 */
  warranty?: Record<string, unknown> | null
  note?: string | null
}

export interface QuoteDraftInput {
  customerId?: number | null
  title: string
  lines?: QuoteLineInput[]
  terms?: QuoteTermsInput | null
  discountCents?: number | null
  /** 改版原因（R10）。只在改版时有值。 */
  changeReason?: string | null
  /** 反馈来源 miniprogram / wechat / offline（R10）。 */
  feedbackSource?: string | null
}

export interface QuoteIssueInput {
  /** 期望的报价头版本（乐观锁）。 */
  expectedVersion?: number | null
  /** 指定有效期；缺省 = 现在 + 门店参数的有效期小时数。 */
  validUntil?: string | null
}

/** B42 确认来源（契约 actions.json B42 inputs；R10 的三渠道口径）。 */
export const QUOTE_CONFIRM_SOURCES = ['miniprogram', 'wechat', 'offline'] as const
export type QuoteConfirmSource = (typeof QUOTE_CONFIRM_SOURCES)[number]

export interface QuoteConfirmInput {
  /** 期望的报价头版本（乐观锁）。 */
  expectedVersion?: number | null
  /** 确认来源：小程序 / 微信 / 线下面谈。 */
  source: QuoteConfirmSource
  /** 备注（可选，例如「电话里口头确认」）。 */
  note?: string | null
}

// ═══════════════════════════════ 校验与计算 ═══════════════════════════════

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/** 行小计。单价 × 数量，整数分。0009 的 CHECK 与触发器会再验一次，这里只是服务端重算。 */
export function computeSubtotalCents(lines: readonly QuoteLineInput[]): number {
  return lines.reduce((sum, line) => sum + line.unitPriceCents * line.qty, 0)
}

/**
 * 提交前校验。给的是能照做的中文说明；真正的断言仍在 SQL 里（0009 的约束 + 守卫）。
 * requireLines 为真时用于 issue：契约 B02 要求「issue 额外要求完整配置行与条款」。
 */
export function validateQuoteDraft(input: QuoteDraftInput, options: { requireLines: boolean }): string | null {
  const title = (input.title ?? '').trim()
  if (!title) return '报价单标题不能为空'

  const requestedDepositPercent = input.terms?.depositPercent
  if (requestedDepositPercent !== undefined && requestedDepositPercent !== null && requestedDepositPercent !== QUOTE_SETTINGS.depositPercent) {
    return '首发预付款比例固定为 15%，不能通过报价条款改低或改高'
  }
  const deliveryFeeCents = input.terms?.delivery?.feeCents
  if (deliveryFeeCents !== undefined && deliveryFeeCents !== null && deliveryFeeCents > 0) {
    return '配送费必须作为单独的收费服务行计入应付；自动配送计费暂未开放'
  }
  if (containsExtensionWarrantyCommitment(input.terms?.warranty)) return EXTENSION_WARRANTY_DEFERRED_MESSAGE

  if (input.customerId !== undefined && input.customerId !== null) {
    if (!Number.isInteger(input.customerId) || input.customerId < 1) return '客户 ID 无效'
  }

  const lines = input.lines ?? []
  if (options.requireLines && lines.length === 0) return '发出前至少要有一行配置'
  if (lines.length > MAX_LINES) return `报价行最多 ${MAX_LINES} 行`

  for (const [index, line] of lines.entries()) {
    const at = `第 ${index + 1} 行`
    if (!(QUOTE_LINE_SOURCES as readonly string[]).includes(line.source)) {
      return `${at}：来源只能是新品 / 二手 / 客供 / 服务`
    }
    if (typeof line.nameSnapshot !== 'string' || !line.nameSnapshot.trim()) return `${at}：名称不能为空`
    if (isExtensionWarrantyLine(line.nameSnapshot) || isExtensionWarrantyLine(line.specSnapshot)) {
      return `${at}：${EXTENSION_WARRANTY_DEFERRED_MESSAGE}`
    }
    if (containsExtensionWarrantyCommitment(line.warrantySnapshot)) return `${at}：${EXTENSION_WARRANTY_DEFERRED_MESSAGE}`
    if (!isPositiveInt(line.qty)) return `${at}：数量必须是正整数`
    if (!isNonNegativeInt(line.unitPriceCents)) return `${at}：单价必须是非负整数分`

    if (line.source === 'used') {
      if (!line.stockItemId) return `${at}：二手件必须指定具体实物（哪一台）`
      if (line.qty !== 1) return `${at}：逐件跟踪的来源数量只能是 1`
    } else if (line.stockItemId) {
      return `${at}：只有二手件才能指定具体实物`
    }

    if (line.source === 'customer') {
      if (!line.customerDeviceRef) return `${at}：客供件必须指出来源设备`
      if (line.unitPriceCents !== 0) return `${at}：客供件本身不带价，装机服务费请另列一行`
      if (line.qty !== 1) return `${at}：客供件数量只能是 1`
    } else if (line.customerDeviceRef) {
      return `${at}：只有客供件才能引用顾客设备`
    }
  }

  const discount = input.discountCents ?? 0
  if (!isNonNegativeInt(discount)) return '优惠金额必须是非负整数分'
  const subtotal = computeSubtotalCents(lines)
  if (discount > subtotal) return '优惠金额不能超过小计'

  return null
}

/** 已发布报价需通过当前首发金额条款，旧版本不原地改写并要求重发后重新确认。 */
export function validateCheckoutTermsSnapshot(termsSnapshot: string | null): string | null {
  let terms: Record<string, unknown>
  try {
    const parsed = JSON.parse(termsSnapshot ?? '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '报价条款快照无效，请核对后重新出具报价'
    terms = parsed as Record<string, unknown>
  } catch {
    return '报价条款快照无效，请核对后重新出具报价'
  }

  const percent = terms.depositPercent
  if (percent !== undefined && percent !== null && percent !== QUOTE_SETTINGS.depositPercent) {
    return '该报价版本的预付款比例不符合首发固定 15% 规则；请新建版本、重新发出并由顾客确认'
  }
  const delivery = terms.delivery
  if (delivery && typeof delivery === 'object' && !Array.isArray(delivery)) {
    const fee = (delivery as Record<string, unknown>).feeCents
    if (typeof fee === 'number' && fee > 0) {
      return '该报价版本把配送费放在未计入应付的条款字段；请将费用列为服务行、新建版本并重新确认'
    }
  }
  return null
}

// ═══════════════════════════════ 语句拼装 ═══════════════════════════════

function warrantyFor(line: QuoteLineInput): string {
  if (line.warrantySnapshot && typeof line.warrantySnapshot === 'object') {
    return JSON.stringify({ ...DEFAULT_WARRANTY[line.source], ...line.warrantySnapshot })
  }
  return JSON.stringify(DEFAULT_WARRANTY[line.source])
}

function insertVersionStatement(
  db: OperationsDb,
  ctx: OperationContext,
  version: {
    quoteId: string
    revision: number
    discountCents: number
    termsSnapshot: string
    subtotalCents: number
  },
): D1PreparedStatement {
  // 草稿版本不带 issued_at / valid_until（0009 的 CHECK 要求两者自洽）。
  // 有效期在 issue 那一刻才由门店参数决定。
  return db
    .prepare(
      `INSERT INTO quote_versions
         (quote_id, revision, store_id, status, valid_until, discount_cents, terms_snapshot,
          issued_at, subtotal_cents, total_cents, issued_request_id, created_by)
       VALUES (?, ?, ?, 'draft', NULL, ?, ?, NULL, ?, ?, NULL, ?)`,
    )
    .bind(
      version.quoteId,
      version.revision,
      ctx.storeId,
      version.discountCents,
      version.termsSnapshot,
      version.subtotalCents,
      version.subtotalCents - version.discountCents,
      ctx.actorUserId,
    )
}

function insertLineStatement(
  db: OperationsDb,
  ctx: OperationContext,
  quoteId: string,
  revision: number,
  position: number,
  line: QuoteLineInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO quote_lines
         (id, quote_id, revision, store_id, position, source, name_snapshot, spec_snapshot,
          qty, unit_price_cents, line_total_cents, product_ref, stock_item_id, customer_device_ref,
          warranty_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `${ctx.requestId}::line-${position}`,
      quoteId,
      revision,
      ctx.storeId,
      position,
      line.source,
      line.nameSnapshot.trim(),
      (line.specSnapshot ?? '').trim(),
      line.qty,
      line.unitPriceCents,
      line.unitPriceCents * line.qty,
      // 商品引用（hardware.entity_id）。E05 只收不落是缺口，0015 补列后这里必须写真值：
      // 成交（B03）要按它把报价行映射到商品。空串一律按空值处理，不存 ''。
      line.productRef?.trim() || null,
      line.stockItemId ?? null,
      line.customerDeviceRef ?? null,
      warrantyFor(line),
    )
}

/** 条款快照：门店参数打底，再用调用方给的值覆盖，最后附上改版溯源信息。 */
function buildTermsSnapshot(input: QuoteDraftInput): string {
  const terms = input.terms ?? {}
  const snapshot: Record<string, unknown> = {
    depositPercent: QUOTE_SETTINGS.depositPercent,
    depositRefundable: false,
    reservationDays: QUOTE_SETTINGS.reservationDays,
    validityHours: QUOTE_SETTINGS.validityHours,
    reminderLeadHours: QUOTE_SETTINGS.reminderLeadHours,
    warrantyPolicyLines: [...WARRANTY_POLICY_LINES],
  }
  // 预算：顾客心理预算，不是付款动作，不进金额计算（R03）。
  if (terms.budgetCents !== undefined && terms.budgetCents !== null) snapshot.budgetCents = terms.budgetCents
  if (terms.delivery) {
    snapshot.delivery = {
      mode: terms.delivery.mode,
      distanceKm: terms.delivery.distanceKm ?? null,
      note: terms.delivery.note ?? null,
    }
  }
  if (terms.warranty) snapshot.warranty = terms.warranty
  if (terms.note) snapshot.note = terms.note
  if (input.changeReason) snapshot.changeReason = input.changeReason
  if (input.feedbackSource) snapshot.feedbackSource = input.feedbackSource
  return JSON.stringify(snapshot)
}

function insertShareStatement(
  db: OperationsDb,
  ctx: OperationContext,
  quoteId: string,
  revision: number,
  tokenHash: string,
  expiresAt: string,
): D1PreparedStatement {
  // 只存摘要。明文 token 只在一次响应里出现（0009 设计要点 5）。
  return db
    .prepare(
      `INSERT INTO quote_shares
         (id, store_id, quote_id, revision, token_hash, status, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(`${ctx.requestId}::share`, ctx.storeId, quoteId, revision, tokenHash, expiresAt, ctx.actorUserId)
}

// ═══════════════════════════════ B01 创建报价草稿 ═══════════════════════════════

export function planCreateQuote(db: OperationsDb, ctx: OperationContext, input: QuoteDraftInput): OperationPlan {
  // 实体 ID 由服务端先生成：幂等记录与业务语句在同一批次里，取不到自增主键（T04）。
  const quoteId = `${ctx.requestId}::quote`
  const lines = input.lines ?? []
  const subtotal = computeSubtotalCents(lines)
  const discount = input.discountCents ?? 0
  const statements: D1PreparedStatement[] = []

  if (input.customerId !== undefined && input.customerId !== null) {
    statements.push(
      guardStatement(
        db,
        'ENTITY_NOT_FOUND',
        `NOT EXISTS (SELECT 1 FROM customers WHERE store_id = ? AND id = ? AND status = 'active')`,
        ctx.storeId,
        input.customerId,
      ),
    )
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO quote_headers
           (id, store_id, customer_id, title, current_revision, version, created_by, updated_by)
         VALUES (?, ?, ?, ?, 0, 1, ?, ?)`,
      )
      .bind(quoteId, ctx.storeId, input.customerId ?? null, input.title.trim(), ctx.actorUserId, ctx.actorUserId),
    // 主键撞车就整批回滚，不留半截草稿
    guardStatement(
      db,
      'VALIDATION_ERROR',
      'NOT EXISTS (SELECT 1 FROM quote_headers WHERE store_id = ? AND id = ?)',
      ctx.storeId,
      quoteId,
    ),
    insertVersionStatement(db, ctx, {
      quoteId,
      revision: 1,
      discountCents: discount,
      termsSnapshot: buildTermsSnapshot(input),
      subtotalCents: subtotal,
    }),
  )

  for (const [index, line] of lines.entries()) {
    statements.push(insertLineStatement(db, ctx, quoteId, 1, index, line))
  }

  statements.push(bumpVersionStatement(db, ctx, 'Quote', quoteId, 1))

  return {
    statements,
    outcome: {
      entityType: 'Quote',
      entityId: quoteId,
      version: 1,
      summary: `新建报价草稿「${input.title.trim()}」`,
      effects: { revision: 1, lineCount: lines.length, subtotalCents: subtotal, totalCents: subtotal - discount },
    },
    constraintCodes: { 'customers.store_id, customers.id': 'ENTITY_NOT_FOUND' },
  }
}

/** B01 入口。 */
export async function createQuote(
  db: OperationsDb,
  ctx: OperationContext,
  input: QuoteDraftInput,
): Promise<RunResult> {
  const invalid = validateQuoteDraft(input, { requireLines: false })
  if (invalid) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: invalid, retryable: false, httpStatus: 400 }
  }
  const resolved: OperationContext = { ...ctx, payloadHash: await hashPayload(input) }
  return runIdempotent(db, resolved, (context) => planCreateQuote(db, context, input))
}

// ═══════════════════════════════ 读取辅助（plan 必须是同步的，故预读在这里） ═══════════════════════════════

interface QuoteHeaderRow {
  id: string
  customer_id: number | null
  title: string
  current_revision: number
  version: number
}

async function readHeader(db: OperationsDb, storeId: number, quoteId: string): Promise<QuoteHeaderRow | null> {
  const row = await db
    .prepare(
      `SELECT id, customer_id, title, current_revision, version
       FROM quote_headers WHERE store_id = ? AND id = ?`,
    )
    .bind(storeId, quoteId)
    .first<QuoteHeaderRow>()
  return row ?? null
}

/**
 * 决定这次 save 该写哪个 revision。
 *
 * 规则：**草稿反复保存不涨版本号**（契约 B02 的自环转换说的是「issued 状态再次 save 形成新版本」）。
 *   · 已有 draft 版本 → 原地替换它的内容（仍旧是那个 revision）
 *   · 没有 draft（首次保存，或上一版已发出） → revision = 现有最大版本 + 1
 *
 * 并发下由主键 (quote_id, revision) 兜底：两个请求同时判定出同一个 revision，
 * 只有一个能插入成功，另一个整批回滚 —— 不会出现「两份内容都以为自己写进了 v2」。
 */
async function resolveSaveRevision(db: OperationsDb, storeId: number, quoteId: string): Promise<{ revision: number; draft: boolean }> {
  const draft = await db
    .prepare(
      `SELECT revision FROM quote_versions
       WHERE store_id = ? AND quote_id = ? AND status = 'draft'
       ORDER BY revision DESC LIMIT 1`,
    )
    .bind(storeId, quoteId)
    .first<{ revision: number }>()
  if (draft) return { revision: draft.revision, draft: true }

  const maxRow = await db
    .prepare(`SELECT COALESCE(MAX(revision), 0) AS maxRevision FROM quote_versions WHERE store_id = ? AND quote_id = ?`)
    .bind(storeId, quoteId)
    .first<{ maxRevision: number }>()
  return { revision: (maxRow?.maxRevision ?? 0) + 1, draft: false }
}

// ═══════════════════════════════ B02 保存报价版本 ═══════════════════════════════

export function planSaveQuote(
  db: OperationsDb,
  ctx: OperationContext,
  quoteId: string,
  revision: number,
  expectedVersion: number,
  input: QuoteDraftInput,
): OperationPlan {
  const lines = input.lines ?? []
  const subtotal = computeSubtotalCents(lines)
  const discount = input.discountCents ?? 0
  const nextVersion = expectedVersion + 1
  const statements: D1PreparedStatement[] = []

  statements.push(
    guardStatement(
      db,
      'ENTITY_NOT_FOUND',
      'NOT EXISTS (SELECT 1 FROM quote_headers WHERE store_id = ? AND id = ?)',
      ctx.storeId,
      quoteId,
    ),
    guardStatement(
      db,
      'VERSION_CONFLICT',
      'NOT EXISTS (SELECT 1 FROM quote_headers WHERE store_id = ? AND id = ? AND version = ?)',
      ctx.storeId,
      quoteId,
      expectedVersion,
    ),
  )

  if (input.customerId !== undefined && input.customerId !== null) {
    statements.push(
      guardStatement(
        db,
        'ENTITY_NOT_FOUND',
        `NOT EXISTS (SELECT 1 FROM customers WHERE store_id = ? AND id = ? AND status = 'active')`,
        ctx.storeId,
        input.customerId,
      ),
    )
  }

  // 替换该 revision 的内容：删版本行即可，quote_lines 由 ON DELETE CASCADE 跟着删。
  // 只删 draft —— 已发出的版本永远不动，这是 0009「发出后不可覆盖」的落点。
  statements.push(
    db
      .prepare(`DELETE FROM quote_versions WHERE store_id = ? AND quote_id = ? AND revision = ? AND status = 'draft'`)
      .bind(ctx.storeId, quoteId, revision),
    insertVersionStatement(db, ctx, {
      quoteId,
      revision,
      discountCents: discount,
      termsSnapshot: buildTermsSnapshot(input),
      subtotalCents: subtotal,
    }),
  )

  for (const [index, line] of lines.entries()) {
    statements.push(insertLineStatement(db, ctx, quoteId, revision, index, line))
  }

  statements.push(
    db
      .prepare(
        `UPDATE quote_headers SET customer_id = ?, title = ?, version = ?, updated_by = ?, updated_at = datetime('now')
         WHERE store_id = ? AND id = ? AND version = ?`,
      )
      .bind(
        input.customerId ?? null,
        input.title.trim(),
        nextVersion,
        ctx.actorUserId,
        ctx.storeId,
        quoteId,
        expectedVersion,
      ),
    // 条件更新影响 0 行不报错（T04 的核心教训）→ 用一条守卫把它变成硬错误。
    assertRowVersionStatement(db, 'VERSION_CONFLICT', 'quote_headers', 'id', quoteId, nextVersion),
    bumpVersionStatement(db, ctx, 'Quote', quoteId, nextVersion),
  )

  return {
    statements,
    outcome: {
      entityType: 'Quote',
      entityId: quoteId,
      version: nextVersion,
      summary: `保存报价第 ${revision} 版`,
      effects: { revision, lineCount: lines.length, subtotalCents: subtotal, totalCents: subtotal - discount },
    },
    constraintCodes: { 'customers.store_id, customers.id': 'ENTITY_NOT_FOUND', 'quote_versions.quote_id, quote_versions.revision': 'VERSION_CONFLICT' },
  }
}

/** B02 save 入口。 */
export async function saveQuote(
  db: OperationsDb,
  ctx: OperationContext,
  quoteId: string,
  input: QuoteDraftInput,
  expectedVersion: number,
): Promise<RunResult> {
  const invalid = validateQuoteDraft(input, { requireLines: false })
  if (invalid) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: invalid, retryable: false, httpStatus: 400 }
  }
  if (!isPositiveInt(expectedVersion)) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: '保存必须带 expectedVersion（当前报价头版本）',
      retryable: false,
      httpStatus: 400,
    }
  }

  const header = await readHeader(db, ctx.storeId, quoteId)
  if (!header) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '报价单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  const { revision } = await resolveSaveRevision(db, ctx.storeId, quoteId)

  const resolved: OperationContext = { ...ctx, payloadHash: await hashPayload({ quoteId, revision, expectedVersion, input }) }
  return runIdempotent(db, resolved, (context) => planSaveQuote(db, context, quoteId, revision, expectedVersion, input))
}

// ═══════════════════════════════ B02 发出报价 ═══════════════════════════════

interface DraftVersionRow {
  revision: number
  subtotal_cents: number
  discount_cents: number
  terms_snapshot: string
  line_count: number
}

async function readDraftVersion(db: OperationsDb, storeId: number, quoteId: string): Promise<DraftVersionRow | null> {
  const row = await db
    .prepare(
      `SELECT v.revision, v.subtotal_cents, v.discount_cents, v.terms_snapshot,
              (SELECT COUNT(*) FROM quote_lines ql WHERE ql.quote_id = v.quote_id AND ql.revision = v.revision) AS line_count
       FROM quote_versions v
       WHERE v.store_id = ? AND v.quote_id = ? AND v.status = 'draft'
       ORDER BY v.revision DESC LIMIT 1`,
    )
    .bind(storeId, quoteId)
    .first<DraftVersionRow>()
  return row ?? null
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function planIssueQuote(
  db: OperationsDb,
  ctx: OperationContext,
  quoteId: string,
  revision: number,
  expectedVersion: number,
  issuedAt: string,
  validUntil: string,
  tokenHash: string,
  shareExpiresAt: string,
): OperationPlan {
  const nextVersion = expectedVersion + 1

  const statements: D1PreparedStatement[] = [
    guardStatement(
      db,
      'ENTITY_NOT_FOUND',
      'NOT EXISTS (SELECT 1 FROM quote_headers WHERE store_id = ? AND id = ?)',
      ctx.storeId,
      quoteId,
    ),
    guardStatement(
      db,
      'VERSION_CONFLICT',
      'NOT EXISTS (SELECT 1 FROM quote_headers WHERE store_id = ? AND id = ? AND version = ?)',
      ctx.storeId,
      quoteId,
      expectedVersion,
    ),
    // 只允许 draft → issued。已发出的版本不可能被再发一次。
    db
      .prepare(
        `UPDATE quote_versions
         SET status = 'issued', issued_at = ?, valid_until = ?, issued_request_id = ?
         WHERE store_id = ? AND quote_id = ? AND revision = ? AND status = 'draft'`,
      )
      .bind(issuedAt, validUntil, ctx.requestId, ctx.storeId, quoteId, revision),
    // 条件更新影响 0 行不报错 → 守卫确认状态真的变了。
    guardStatement(
      db,
      'VALIDATION_ERROR',
      `NOT EXISTS (SELECT 1 FROM quote_versions
                   WHERE store_id = ? AND quote_id = ? AND revision = ? AND status = 'issued')`,
      ctx.storeId,
      quoteId,
      revision,
    ),
    // 同一版本同时只允许一个有效凭证（部分唯一索引 uq_quote_shares_active_version）。
    // 重新签发时先把旧的撤下来，并留下「谁撤的、什么时候撤的」。
    db
      .prepare(
        `UPDATE quote_shares SET status = 'revoked', revoked_at = ?, revoked_by = ?
         WHERE store_id = ? AND quote_id = ? AND revision = ? AND status = 'active'`,
      )
      .bind(issuedAt, ctx.actorUserId, ctx.storeId, quoteId, revision),
    insertShareStatement(db, ctx, quoteId, revision, tokenHash, shareExpiresAt),
    db
      .prepare(
        `UPDATE quote_headers SET current_revision = ?, version = ?, updated_by = ?, updated_at = datetime('now')
         WHERE store_id = ? AND id = ? AND version = ?`,
      )
      .bind(revision, nextVersion, ctx.actorUserId, ctx.storeId, quoteId, expectedVersion),
    assertRowVersionStatement(db, 'VERSION_CONFLICT', 'quote_headers', 'id', quoteId, nextVersion),
    bumpVersionStatement(db, ctx, 'Quote', quoteId, nextVersion),
  ]

  return {
    statements,
    outcome: {
      entityType: 'Quote',
      entityId: quoteId,
      version: nextVersion,
      summary: `发出报价第 ${revision} 版`,
      // ⚠️ 分享凭证明文**不进** effects：effects 会随幂等记录一起落库，
      // 明文落库就等于「库被读走时链接也被读走」（0009 设计要点 5）。
      effects: { revision, validUntil, shareId: `${ctx.requestId}::share` },
    },
    constraintCodes: { 'quote_shares.quote_id, quote_shares.revision': 'VALIDATION_ERROR' },
  }
}

/** issue 的结果：明文 token 只在**本次**签发时出现，命中幂等记录时不再返回。 */
export interface IssueResult extends RunResult {
  shareToken?: string
}

/** B02 issue 入口。 */
export async function issueQuote(
  db: OperationsDb,
  ctx: OperationContext,
  quoteId: string,
  input: QuoteIssueInput,
): Promise<IssueResult> {
  // 重放保护必须放在业务预读**之前**：第一次发出成功后草稿就变成了 issued 版本，
  // 此时客户端超时重发同一 requestId，会先撞上「没有待发出的草稿」——
  // 不先查幂等记录的话，重试会拿到 400 而不是当初的成功结果（实测就是这个症状）。
  const issueAction = 'B02'
  const issuePayloadHash = await hashPayload({ quoteId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action: issueAction, payloadHash: issuePayloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const header = await readHeader(db, ctx.storeId, quoteId)
  if (!header) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '报价单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  const draft = await readDraftVersion(db, ctx.storeId, quoteId)
  if (!draft) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: '这份报价当前没有待发出的草稿版本。已发出的版本不会被覆盖 —— 要改请先保存出新版本',
      retryable: false,
      httpStatus: 400,
    }
  }
  if (draft.line_count === 0) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '发出前至少要有一行配置', retryable: false, httpStatus: 400 }
  }

  const expectedVersion = input.expectedVersion ?? header.version
  if (!isPositiveInt(expectedVersion)) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: 'expectedVersion 必须是正整数', retryable: false, httpStatus: 400 }
  }

  const issuedAt = new Date().toISOString()
  const validUntil = input.validUntil ?? new Date(Date.now() + QUOTE_SETTINGS.validityHours * 3600_000).toISOString()
  if (Number.isNaN(new Date(validUntil).getTime())) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '有效期不是合法时间', retryable: false, httpStatus: 400 }
  }

  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  // 链接失效时间与价格有效期是两件事：版本过期是「价格不作数」，凭证失效是「链接打不开」。
  // 本轮让凭证与版本同寿命，顾客端那一刀可以再放宽。
  const shareExpiresAt = validUntil

  const resolved: OperationContext = { ...ctx, action: issueAction, payloadHash: issuePayloadHash }
  const result = await runIdempotent(db, resolved, (context) =>
    planIssueQuote(db, context, quoteId, draft.revision, expectedVersion, issuedAt, validUntil, tokenHash, shareExpiresAt),
  )
  // 命中幂等记录时不返回明文：那一次响应已经给过了。
  return result.ok && !result.reused ? { ...result, shareToken: token } : result
}

// ═══════════════════════════════ B42 记录顾客确认 ═══════════════════════════════

/**
 * B42 的 plan。
 *
 * 状态转换只有一条路：issued → confirmed（enums.json QuoteStatus）。实现上与 issue 同一手法
 * ——条件 UPDATE 只命中 status='issued' 的行，再用守卫确认状态真的变了：
 * D1 条件 UPDATE 影响 0 行不报错（T04 的核心教训），没有守卫就会静默半截账。
 *
 * 过期闸也做成结构化的：valid_until 早于当前时刻的版本不允许被确认（先续期再确认）。
 * 金额全用整数分、时间全用同一格式的 ISO 串，字符串比较即时间比较。
 *
 * 本动作不写任何库存 / 资金表：确认 ≠ 付款、确认不锁库存（R12）。
 */
export function planConfirmQuote(
  db: OperationsDb,
  ctx: OperationContext,
  quoteId: string,
  revision: number,
  expectedVersion: number,
  confirmedAt: string,
  source: QuoteConfirmSource,
): OperationPlan {
  const nextVersion = expectedVersion + 1

  const statements: D1PreparedStatement[] = [
    guardStatement(
      db,
      'ENTITY_NOT_FOUND',
      'NOT EXISTS (SELECT 1 FROM quote_headers WHERE store_id = ? AND id = ?)',
      ctx.storeId,
      quoteId,
    ),
    guardStatement(
      db,
      'VERSION_CONFLICT',
      'NOT EXISTS (SELECT 1 FROM quote_headers WHERE store_id = ? AND id = ? AND version = ?)',
      ctx.storeId,
      quoteId,
      expectedVersion,
    ),
    // 过期闸：超过 valid_until 的版本不能被确认，必须先续期（重新发出）。
    // guardStatement 的条件为真即中止（T04 断言守卫），所以这里断言「存在已过期的版本」就失败。
    guardStatement(
      db,
      'VALIDATION_ERROR',
      `EXISTS (SELECT 1 FROM quote_versions
               WHERE store_id = ? AND quote_id = ? AND revision = ?
                 AND valid_until IS NOT NULL AND valid_until < ?)`,
      ctx.storeId,
      quoteId,
      revision,
      confirmedAt,
    ),
    // 只允许 issued → confirmed。draft / confirmed / converted / closed 都不会被命中。
    db
      .prepare(
        `UPDATE quote_versions
         SET status = 'confirmed', confirmed_at = ?, confirmed_source = ?
         WHERE store_id = ? AND quote_id = ? AND revision = ? AND status = 'issued'`,
      )
      .bind(confirmedAt, source, ctx.storeId, quoteId, revision),
    // 条件更新影响 0 行不报错 → 守卫确认状态真的变了。
    guardStatement(
      db,
      'VALIDATION_ERROR',
      `NOT EXISTS (SELECT 1 FROM quote_versions
                   WHERE store_id = ? AND quote_id = ? AND revision = ? AND status = 'confirmed')`,
      ctx.storeId,
      quoteId,
      revision,
    ),
    db
      .prepare(
        `UPDATE quote_headers SET version = ?, updated_by = ?, updated_at = datetime('now')
         WHERE store_id = ? AND id = ? AND version = ?`,
      )
      .bind(nextVersion, ctx.actorUserId, ctx.storeId, quoteId, expectedVersion),
    assertRowVersionStatement(db, 'VERSION_CONFLICT', 'quote_headers', 'id', quoteId, nextVersion),
    bumpVersionStatement(db, ctx, 'Quote', quoteId, nextVersion),
  ]

  return {
    statements,
    outcome: {
      entityType: 'Quote',
      entityId: quoteId,
      version: nextVersion,
      summary: `记录顾客确认（第 ${revision} 版，来源：${source === 'miniprogram' ? '小程序' : source === 'wechat' ? '微信' : '线下面谈'}）`,
      effects: { revision, confirmedAt, source },
    },
    constraintCodes: {
      'quote_versions.quote_id, quote_versions.revision': 'VALIDATION_ERROR',
    },
  }
}

/** B42 入口。重放保护放在业务预读之前（与 issue 同一教训：先查幂等，再谈业务）。 */
export async function confirmQuote(
  db: OperationsDb,
  ctx: OperationContext,
  quoteId: string,
  input: QuoteConfirmInput,
): Promise<RunResult> {
  if (!(QUOTE_CONFIRM_SOURCES as readonly string[]).includes(input.source)) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: '确认来源只能是 miniprogram / wechat / offline',
      retryable: false,
      httpStatus: 400,
    }
  }

  const confirmAction = 'B42'
  const confirmPayloadHash = await hashPayload({ quoteId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, {
    action: confirmAction,
    payloadHash: confirmPayloadHash,
  })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const header = await readHeader(db, ctx.storeId, quoteId)
  if (!header) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '报价单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  if (header.current_revision <= 0) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: '这份报价还没有发出过任何版本，请先发出再记录顾客确认',
      retryable: false,
      httpStatus: 400,
    }
  }

  const current = await db
    .prepare(
      `SELECT status, valid_until AS validUntil, terms_snapshot AS termsSnapshot FROM quote_versions
       WHERE store_id = ? AND quote_id = ? AND revision = ?`,
    )
    .bind(ctx.storeId, quoteId, header.current_revision)
    .first<{ status: string; validUntil: string | null; termsSnapshot: string | null }>()
  if (!current) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: '当前版本的记录缺失，请先核对这份报价的数据',
      retryable: false,
      httpStatus: 400,
    }
  }
  const termsProblem = validateCheckoutTermsSnapshot(current.termsSnapshot)
  if (termsProblem) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: termsProblem, retryable: false, httpStatus: 400 }
  }
  if (current.status === 'draft') {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: '当前版本还是草稿，请先发出再记录顾客确认',
      retryable: false,
      httpStatus: 400,
    }
  }
  if (current.status === 'confirmed') {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: '这份报价已经记录过顾客确认了',
      retryable: false,
      httpStatus: 400,
    }
  }
  if (current.status !== 'issued') {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: `当前版本状态是 ${current.status}，只有已发出的版本能记录顾客确认`,
      retryable: false,
      httpStatus: 400,
    }
  }
  if (current.validUntil && new Date(current.validUntil).getTime() <= Date.now()) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: '报价已过期，请先续期（重新发出）再记录顾客确认',
      retryable: false,
      httpStatus: 400,
    }
  }

  const expectedVersion = input.expectedVersion ?? header.version
  if (!isPositiveInt(expectedVersion)) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: 'expectedVersion 必须是正整数', retryable: false, httpStatus: 400 }
  }

  const confirmedAt = new Date().toISOString()
  const resolved: OperationContext = { ...ctx, action: confirmAction, payloadHash: confirmPayloadHash }
  return runIdempotent(db, resolved, (context) =>
    planConfirmQuote(db, context, quoteId, header.current_revision, expectedVersion, confirmedAt, input.source),
  )
}

// ═══════════════════════════════ R05 读模型 ═══════════════════════════════

export interface QuoteListRow {
  id: string
  title: string
  customerId: number | null
  customerName: string | null
  /** 数据表中的已发出版本指针；纯草稿为 0。列表展示使用 workRevision。 */
  currentRevision: number
  /** 当前工作版本：有草稿时取草稿，否则取 currentRevision 指向的已发出版本。 */
  workRevision: number | null
  /** currentRevision 指向的版本摘要，用于保留已发出/已确认口径。 */
  publishedRevision: number | null
  publishedStatus: QuoteStatusValue | 'expired' | null
  publishedTotalCents: number | null
  version: number
  status: QuoteStatusValue | 'missing'
  validUntil: string | null
  issuedAt: string | null
  subtotalCents: number | null
  discountCents: number | null
  totalCents: number | null
  lineCount: number | null
  shared: boolean
  expired: boolean
  expiringSoon: boolean
  createdAt: string
  updatedAt: string
}

export interface QuoteListResult {
  quotes: QuoteListRow[]
  totals: { all: number; draft: number; issued: number; confirmed: number; expired: number; issuedAmountCents: number }
  settings: QuoteSettings
}

export interface QuoteListFilter {
  /** 展示态筛选：draft / issued / expired。expired 是算出来的，不在库里。 */
  status?: string | null
  q?: string | null
  limit?: number | null
}

/** 逾期是「超过 validUntil」的自动判定（enums.json QuoteStatus 里该转换的 action 为 null）。 */
function statusView(status: string, validUntil: string | null): { status: QuoteStatusValue; expired: boolean; expiringSoon: boolean } {
  const value = status as QuoteStatusValue
  if (value !== 'issued' || !validUntil) return { status: value, expired: false, expiringSoon: false }
  const deadline = new Date(validUntil).getTime()
  if (Number.isNaN(deadline)) return { status: value, expired: false, expiringSoon: false }
  const remaining = deadline - Date.now()
  return {
    status: remaining <= 0 ? 'expired' : value,
    expired: remaining <= 0,
    expiringSoon: remaining > 0 && remaining <= QUOTE_SETTINGS.reminderLeadHours * 3600_000,
  }
}

export async function queryQuotes(db: OperationsDb, storeId: number, filter: QuoteListFilter = {}): Promise<QuoteListResult> {
  const limitRaw = filter.limit ?? DEFAULT_LIST_LIMIT
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Number(limitRaw) : DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT)

  const rows = await db
    .prepare(
      `SELECT h.id, h.title, h.customer_id AS customerId, c.name AS customerName,
              h.current_revision AS currentRevision, h.version, h.created_at AS createdAt, h.updated_at AS updatedAt,
              CASE WHEN w.revision IS NULL THEN 'missing' ELSE w.status END AS status,
              w.revision AS workRevision, w.valid_until AS validUntil, w.issued_at AS issuedAt,
              w.subtotal_cents AS subtotalCents, w.discount_cents AS discountCents, w.total_cents AS totalCents,
              CASE WHEN w.revision IS NULL THEN NULL
                   ELSE (SELECT COUNT(*) FROM quote_lines ql WHERE ql.quote_id = h.id AND ql.revision = w.revision)
              END AS lineCount,
              p.revision AS publishedRevision, p.status AS publishedStatus, p.valid_until AS publishedValidUntil,
              p.total_cents AS publishedTotalCents,
              EXISTS (SELECT 1 FROM quote_shares s
                      WHERE s.quote_id = h.id AND s.revision = p.revision AND s.status = 'active') AS shared
       FROM quote_headers h
       LEFT JOIN customers c ON c.store_id = h.store_id AND c.id = h.customer_id
       LEFT JOIN quote_versions p ON p.store_id = h.store_id AND p.quote_id = h.id
                                 AND p.revision = h.current_revision AND h.current_revision > 0
       LEFT JOIN quote_versions d ON d.store_id = h.store_id AND d.quote_id = h.id AND d.status = 'draft'
                                 AND d.revision = (SELECT MAX(draft.revision) FROM quote_versions draft
                                                   WHERE draft.store_id = h.store_id AND draft.quote_id = h.id
                                                     AND draft.status = 'draft')
       LEFT JOIN quote_versions w ON w.store_id = h.store_id AND w.quote_id = h.id
                                 AND w.revision = CASE WHEN d.revision IS NOT NULL THEN d.revision ELSE p.revision END
       WHERE h.store_id = ?
       ORDER BY h.updated_at DESC, h.id DESC`,
    )
    .bind(storeId)
    .all<Record<string, unknown>>()

  const all: QuoteListRow[] = (rows.results ?? []).map((row) => {
    const view = row.workRevision === null || row.workRevision === undefined
      ? { status: 'missing' as const, expired: false, expiringSoon: false }
      : statusView(String(row.status), (row.validUntil as string | null) ?? null)
    return {
      id: String(row.id),
      title: String(row.title ?? ''),
      customerId: (row.customerId as number | null) ?? null,
      customerName: (row.customerName as string | null) ?? null,
      currentRevision: Number(row.currentRevision ?? 0),
      workRevision: row.workRevision === null || row.workRevision === undefined ? null : Number(row.workRevision),
      publishedRevision: row.publishedRevision === null || row.publishedRevision === undefined ? null : Number(row.publishedRevision),
      publishedStatus: row.publishedRevision === null || row.publishedRevision === undefined
        ? null
        : statusView(String(row.publishedStatus), (row.publishedValidUntil as string | null) ?? null).status,
      publishedTotalCents: row.publishedTotalCents === null || row.publishedTotalCents === undefined
        ? null
        : Number(row.publishedTotalCents),
      version: Number(row.version ?? 1),
      status: view.status,
      validUntil: (row.validUntil as string | null) ?? null,
      issuedAt: (row.issuedAt as string | null) ?? null,
      subtotalCents: row.subtotalCents === null || row.subtotalCents === undefined ? null : Number(row.subtotalCents),
      discountCents: row.discountCents === null || row.discountCents === undefined ? null : Number(row.discountCents),
      totalCents: row.totalCents === null || row.totalCents === undefined ? null : Number(row.totalCents),
      lineCount: row.lineCount === null || row.lineCount === undefined ? null : Number(row.lineCount),
      shared: Number(row.shared ?? 0) === 1,
      expired: view.expired,
      expiringSoon: view.expiringSoon,
      createdAt: String(row.createdAt ?? ''),
      updatedAt: String(row.updatedAt ?? ''),
    }
  })

  const totals = {
    all: all.length,
    // 草稿数按工作版本；已发出/确认/过期数按 currentRevision 指向的已发出版本。
    // 因而一张「已发出版 + 新草稿」的报价会同时计入工作草稿和其已发出生命周期状态。
    draft: all.filter((row) => row.status === 'draft').length,
    issued: all.filter((row) => row.publishedStatus === 'issued').length,
    confirmed: all.filter((row) => row.publishedStatus === 'confirmed').length,
    expired: all.filter((row) => row.publishedStatus === 'expired').length,
    // 在谈金额严格取已发出指针版本；有新草稿时仍不把草稿金额算进已发出金额。
    issuedAmountCents: all
      .filter((row) => row.publishedStatus === 'issued')
      .reduce((sum, row) => sum + (row.publishedTotalCents ?? 0), 0),
  }

  const q = (filter.q ?? '').trim().toLowerCase()
  let visible = all
  if (filter.status) {
    visible = visible.filter((row) => row.status === filter.status)
  }
  if (q) {
    visible = visible.filter(
      (row) => row.title.toLowerCase().includes(q) || (row.customerName ?? '').toLowerCase().includes(q),
    )
  }

  return { quotes: visible.slice(0, limit), totals, settings: QUOTE_SETTINGS }
}

export interface QuoteDetailLine {
  id: string
  position: number
  source: QuoteLineSource
  nameSnapshot: string
  specSnapshot: string
  qty: number
  unitPriceCents: number
  lineTotalCents: number
  /** 商品引用（hardware.entity_id）。报价阶段允许为空（临时行）；成交前 new / used 行必须有。 */
  productRef: string | null
  stockItemId: string | null
  customerDeviceRef: string | null
  warrantySnapshot: Record<string, unknown>
  /** 只有 used 行有值：这件实物现在还能不能拿出来（契约 Quote.rules「已失效的引用显示需替换」）。 */
  stockItemAvailability: StockItemAvailability | null
}

export interface QuoteDetail {
  quote: {
    id: string
    title: string
    customerId: number | null
    customerName: string | null
    currentRevision: number
    version: number
    createdAt: string
    updatedAt: string
  }
  customer: { id: number; name: string; phone: string } | null
  version: {
    revision: number
    status: QuoteStatusValue
    validUntil: string | null
    issuedAt: string | null
    discountCents: number
    subtotalCents: number
    totalCents: number
    termsSnapshot: Record<string, unknown>
  }
  lines: QuoteDetailLine[]
  /** 版本历史。已发出的版本永远留在这里，改价不会把它抹掉。 */
  revisions: {
    revision: number
    status: QuoteStatusValue
    issuedAt: string | null
    validUntil: string | null
    totalCents: number
    lineCount: number
  }[]
  hasDraft: boolean
  share: { active: boolean; expiresAt: string | null; createdAt: string | null; revision: number } | null
  expired: boolean
  expiringSoon: boolean
  settings: QuoteSettings
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * 读一份报价单。revision 为空时读「当前版本」（currentRevision）；为 0 表示只有草稿头、还没有版本。
 *
 * 刻意不返回：成本、供应商、SN、内部备注。它们根本不在本查询的列表里 ——
 * 不是查出来再删掉（04 §2 globalRules：内部成本不靠前端隐藏）。
 */
export async function queryQuoteDetail(
  db: OperationsDb,
  storeId: number,
  quoteId: string,
  revision?: number | null,
): Promise<QuoteDetail | null> {
  const header = await db
    .prepare(
      `SELECT h.id, h.title, h.customer_id AS customerId, h.current_revision AS currentRevision, h.version,
              h.created_at AS createdAt, h.updated_at AS updatedAt,
              c.name AS customerName, c.phone AS customerPhone
       FROM quote_headers h
       LEFT JOIN customers c ON c.store_id = h.store_id AND c.id = h.customer_id
       WHERE h.store_id = ? AND h.id = ?`,
    )
    .bind(storeId, quoteId)
    .first<Record<string, unknown>>()
  if (!header) return null

  const currentRevision = Number(header.currentRevision ?? 0)

  const revisionRows = await db
    .prepare(
      `SELECT v.revision, v.status, v.issued_at AS issuedAt, v.valid_until AS validUntil,
              v.confirmed_at AS confirmedAt, v.confirmed_source AS confirmedSource,
              v.subtotal_cents AS subtotalCents, v.discount_cents AS discountCents,
              v.total_cents AS totalCents, v.terms_snapshot AS termsSnapshot,
              (SELECT COUNT(*) FROM quote_lines ql WHERE ql.quote_id = v.quote_id AND ql.revision = v.revision) AS lineCount
       FROM quote_versions v
       WHERE v.store_id = ? AND v.quote_id = ?
       ORDER BY v.revision DESC`,
    )
    .bind(storeId, quoteId)
    .all<Record<string, unknown>>()

  const revisions = (revisionRows.results ?? []).map((row) => ({
    revision: Number(row.revision),
    status: String(row.status) as QuoteStatusValue,
    issuedAt: (row.issuedAt as string | null) ?? null,
    validUntil: (row.validUntil as string | null) ?? null,
    confirmedAt: (row.confirmedAt as string | null) ?? null,
    confirmedSource: (row.confirmedSource as string | null) ?? null,
    totalCents: Number(row.totalCents ?? 0),
    lineCount: Number(row.lineCount ?? 0),
  }))

  // 默认读「当前工作版本」：有草稿读草稿（编辑中的单子），没有草稿读已发出的最新版。
  // 直接用 currentRevision 会漏掉 current_revision = 0 的纯草稿 —— 那种单子的详情页一行都看不到。
  const draftRow = revisions.find((row) => row.status === 'draft')
  const targetRevision = revision ?? (draftRow ? draftRow.revision : currentRevision)

  const target = (revisionRows.results ?? []).find((row) => Number(row.revision) === targetRevision) ?? null

  let lines: QuoteDetailLine[] = []
  if (target) {
    const lineRows = await db
      .prepare(
        `SELECT id, position, source, name_snapshot AS nameSnapshot, spec_snapshot AS specSnapshot,
                qty, unit_price_cents AS unitPriceCents, line_total_cents AS lineTotalCents,
                product_ref AS productRef, stock_item_id AS stockItemId,
                customer_device_ref AS customerDeviceRef,
                warranty_snapshot AS warrantySnapshot
         FROM quote_lines
         WHERE store_id = ? AND quote_id = ? AND revision = ?
         ORDER BY position ASC`,
      )
      .bind(storeId, quoteId, targetRevision)
      .all<Record<string, unknown>>()

    // 二手件的可用性单独查一次：报价行是「引用」不是「占用」，
    // 但界面上必须能看出「这台的引用已经失效了」。
    const itemIds = (lineRows.results ?? [])
      .map((row) => (row.stockItemId as string | null) ?? null)
      .filter((id): id is string => Boolean(id))
    const availability = new Map<string, StockItemAvailability>()
    if (itemIds.length) {
      const placeholders = itemIds.map(() => '?').join(', ')
      const itemRows = await db
        .prepare(`SELECT id, availability FROM stock_items WHERE store_id = ? AND id IN (${placeholders})`)
        .bind(storeId, ...itemIds)
        .all<{ id: string; availability: string }>()
      for (const row of itemRows.results ?? []) {
        availability.set(row.id, row.availability === 'available' ? 'available' : row.availability === 'reserved' ? 'reserved' : 'unavailable')
      }
    }

    lines = (lineRows.results ?? []).map((row) => {
      const stockItemId = (row.stockItemId as string | null) ?? null
      return {
        id: String(row.id),
        position: Number(row.position ?? 0),
        source: String(row.source) as QuoteLineSource,
        nameSnapshot: String(row.nameSnapshot ?? ''),
        specSnapshot: String(row.specSnapshot ?? ''),
        qty: Number(row.qty ?? 0),
        unitPriceCents: Number(row.unitPriceCents ?? 0),
        lineTotalCents: Number(row.lineTotalCents ?? 0),
        productRef: (row.productRef as string | null) ?? null,
        stockItemId,
        customerDeviceRef: (row.customerDeviceRef as string | null) ?? null,
        warrantySnapshot: parseJsonObject(row.warrantySnapshot),
        stockItemAvailability: stockItemId ? availability.get(stockItemId) ?? 'missing' : null,
      }
    })
  }

  const shareRow = await db
    .prepare(
      `SELECT revision, status, expires_at AS expiresAt, created_at AS createdAt
       FROM quote_shares WHERE store_id = ? AND quote_id = ? AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(storeId, quoteId)
    .first<Record<string, unknown>>()

  const targetStatus = target ? String(target.status) : 'draft'
  const targetValidUntil = target ? ((target.validUntil as string | null) ?? null) : null
  const view = statusView(targetStatus, targetValidUntil)

  return {
    quote: {
      id: String(header.id),
      title: String(header.title ?? ''),
      customerId: (header.customerId as number | null) ?? null,
      customerName: (header.customerName as string | null) ?? null,
      currentRevision,
      version: Number(header.version ?? 1),
      createdAt: String(header.createdAt ?? ''),
      updatedAt: String(header.updatedAt ?? ''),
    },
    customer:
      header.customerId === null || header.customerId === undefined
        ? null
        : {
            id: Number(header.customerId),
            name: String(header.customerName ?? ''),
            phone: String(header.customerPhone ?? ''),
          },
    version: {
      revision: targetRevision,
      status: view.status,
      validUntil: targetValidUntil,
      issuedAt: target ? ((target.issuedAt as string | null) ?? null) : null,
      confirmedAt: target ? ((target.confirmedAt as string | null) ?? null) : null,
      confirmedSource: target ? ((target.confirmedSource as string | null) ?? null) : null,
      discountCents: target ? Number(target.discountCents ?? 0) : 0,
      subtotalCents: target ? Number(target.subtotalCents ?? 0) : 0,
      totalCents: target ? Number(target.totalCents ?? 0) : 0,
      termsSnapshot: target ? parseJsonObject(target.termsSnapshot) : {},
    },
    lines,
    revisions,
    hasDraft: revisions.some((row) => row.status === 'draft'),
    share: shareRow
      ? {
          active: true,
          expiresAt: (shareRow.expiresAt as string | null) ?? null,
          createdAt: (shareRow.createdAt as string | null) ?? null,
          revision: Number(shareRow.revision ?? 0),
        }
      : null,
    expired: view.expired,
    expiringSoon: view.expiringSoon,
    settings: QUOTE_SETTINGS,
  }
}
