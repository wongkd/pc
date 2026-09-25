/**
 * 库存领域（T05a）：商品主数据、逐件实物、数量余额、库存流水、客户财产边界、
 * 受控期初记录与库存查询。
 *
 * 规格依据：
 *   · docs/plans/2026-09-17-web-wechat-plan/03-domain-rules.md §1 L13（R03 门店所有与客户所有）
 *   · 同文件 §4 L84（自有在库 = 可卖 + 已订 + 待处理；在途不算在库；客户保管另列）
 *   · 同文件 §4 L86（逐件是商品属性；二手一律逐件；无厂商 SN 也有内部编号；重复 SN 进人工核对）
 *   · 同文件 §4 L88-L98（事件 → 数量变化对照表）
 *   · docs/plans/2026-09-17-web-wechat-plan/04-data-and-api.md §2 L19-L21（三个对象的最低字段）
 *   · 同文件 §3 L57-L58（GET /inventory、GET /inventory/items/:id）
 *   · 同文件 §5 L98-L99（B12 /inventory/products、B13 /inventory/openings）
 *
 * 一致性与幂等遵守 T04 的约定（docs/verification/2026-09-17-T04/README.md §3）：
 *   · 全部写动作走 runIdempotent，不自己拼裸批次；
 *   · 断言一律写成 SQL 约束或 assertion_guards 守卫，不用「条件 UPDATE + 查影响行数」；
 *   · 版本推进用 bumpVersionStatement 往版本日志插行；
 *   · 实体 ID 在拼 SQL 之前生成（batch 内取不到自增主键）。
 *
 * 本模块不做鉴权：storeId / actorUserId 由调用方从会话派生（T03）。权限码见函数注释，
 * 由请求层装配，本层不采信客户端传来的角色名。
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
import { generateInternalCode, normalizeManufacturerSn } from './serial-codes'
import { listAttachedForOwner, type AttachmentView } from './attachment'
import { OPENING_COST_BASES, type FormalOpeningLineInput, type OpeningCostBasis, type OpeningWindowStatus } from '../generated/inventory-opening-v2'
export { OPENING_COST_BASES } from '../generated/inventory-opening-v2'
export type { OpeningCostBasis, OpeningWindowStatus } from '../generated/inventory-opening-v2'

// ─────────────────────────────────────────────────────────────────────────────
// 枚举常量：取值必须与 contracts/v1/enums.json 逐字一致，不得在本文件新增取值。
// ─────────────────────────────────────────────────────────────────────────────

export const STOCK_BUCKETS = [
  'available',
  'reserved',
  'quarantine',
  'in_transit',
  'customer_custody',
  'sold',
  'retired',
] as const
export type StockBucket = (typeof STOCK_BUCKETS)[number]

/** 自有在库 = 这三个桶，互斥；在途与客户保管不在其中（03 §4 L84 / enums inventoryBucketRules）。 */
export const OWN_ON_HAND_BUCKETS = ['available', 'reserved', 'quarantine'] as const
export type OwnOnHandBucket = (typeof OWN_ON_HAND_BUCKETS)[number]

export const MOVEMENT_SOURCES = [
  'purchase_receipt',
  'quick_purchase',
  'opening_balance',
  'recovery_acquisition',
  'reservation',
  'unreservation',
  'assembly_pick',
  'delivery',
  'return_receipt',
  'service_part_consumption',
  'scrap',
  'supplier_return',
  'count_adjustment',
  'conversion',
  'inspection_quarantine',
  'inspection_release',
] as const
export type MovementSource = (typeof MOVEMENT_SOURCES)[number]

export type TrackingMode = 'quantity' | 'item'
export type StockCondition = 'new' | 'used'
export type ProductStatus = 'active' | 'disabled'

/**
 * 权限码（contracts/v1/actions.json 的 R06 / R07 / B12 / B13），由请求层装配。
 * 取值必须与 permissionModel.codes 逐字一致；本模块只用它做「请求层该用哪个码」的唯一出处，
 * 不在本层做鉴权（见文件头）。
 */
export const INVENTORY_PERMISSIONS = {
  view: 'inventory/view',
  itemView: 'inventory/item-view',
  productEdit: 'inventory/product-edit',
  productView: 'inventory/product-view',
  costView: 'inventory/cost-view',
  opening: 'inventory/opening',
  inspection: 'inventory/inspection',
  /** B16 录入盘点实盘（契约 legacySource = library/edit，grantPolicy=default）。 */
  count: 'inventory/count',
  /**
   * B16 批准盘点差异（契约 legacySource=null、grantPolicy=owner_only）。
   * ⚠️ 老板专属：请求层只能认新码，旧 library/edit 不得自动获得（noWideningGuard）。
   */
  countApprove: 'inventory/count-approve',
  /** B30 整备记录与上架（旧 library/edit 的映射）。 */
  refurbish: 'inventory/refurbish',
} as const

/**
 * SN 规范化口径：去掉全部空白并转大写，保留连字符等符号。
 * 不删除符号，是为了不让 'AB-12' 与 'AB12' 被误合并成同一件实物 —— 重复 SN 必须由人工核对，
 * 不能由规范化规则悄悄替你决定（03 §4 L86）。
 */
export function normalizeSn(raw: string): string {
  return raw.trim().replace(/\s+/g, '').toUpperCase()
}

function nowIso(): string {
  return new Date().toISOString()
}

function isValidCents(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

// ─────────────────────────────────────────────────────────────────────────────
// B12 · 建立与修改商品主数据（POST /inventory/products）
// 权限：inventory/product-edit（旧 library/edit 的映射，actions.json legacyPermissionMap）
//
// 就地在 hardware 上扩展，不新建 products 表：objects.json L36 声明 Product 复用 hardware，
// legacy-mapping L45 声明 action=extend。这样旧报价系统立刻看得到新商品，不产生第二套主数据。
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductWriteInput {
  /** 有值表示修改既有商品（hardware.entity_id，对客户端是不透明字符串）。 */
  productRef?: string | null
  /** 修改时必填；新建时忽略。 */
  expectedVersion?: number | null
  sku?: string | null
  name: string
  /** 分类名（objects.json Product.category）。落 hardware.category 并链接 product_categories。 */
  category?: string | null
  /** 品牌名（objects.json Product.brand）。落 product_brands 并链接 hardware.brand_id。 */
  brand?: string | null
  /** contracts 的 actions.json L305 写 specs:Spec[]，objects.json L43 写 string —— 见验证文档的冲突登记。 */
  specs?: string | null
  defaultSalePriceCents?: number | null
  trackingMode: TrackingMode
  requiresSn: boolean
  status?: ProductStatus
}

export interface ProductWriteResolution {
  entityId: string
  created: boolean
  nextVersion: number
}

/** 供调用方在提交前给出友好提示；真正的断言在 planProductWrite 生成的 SQL 里。 */
export function validateProductInput(input: ProductWriteInput): string | null {
  if (!input.name || !input.name.trim()) return '商品名称不能为空'
  if (input.trackingMode !== 'quantity' && input.trackingMode !== 'item') return 'trackingMode 取值无效'
  if (input.productRef && input.defaultSalePriceCents !== undefined && input.defaultSalePriceCents !== null) {
    return 'B40 挂牌价调整首发暂缓；通用商品编辑不能改价'
  }
  if (input.productRef && (input.expectedVersion === undefined || input.expectedVersion === null)) {
    return '修改商品必须带 expectedVersion'
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) return 'expectedVersion 必须为正整数'
  }
  if (input.defaultSalePriceCents !== undefined && input.defaultSalePriceCents !== null) {
    if (!isValidCents(input.defaultSalePriceCents)) return 'defaultSalePriceCents 必须为非负整数分'
  }
  if (input.status && input.status !== 'active' && input.status !== 'disabled') return 'status 取值无效'
  return null
}

/**
 * 分类与品牌的落地语句（B12 的两条前置）。
 *
 * 为什么不是「只写 category / brand 两个自由文本列就算完事」：
 * `hardware.category_id` / `brand_id` 是 ERP 商品模型自己的外键（0002 迁移），
 * 旧「商品管理」页按它们显示分类与品牌。B12 建档若只写自由文本，新商品在旧页上就是
 * 「未分类 / 无品牌」——同一份主数据在两张页面上不一致，不是显示问题，是数据问题。
 *
 * 做法沿用旧写入路径已有的形态（`createLegacyCategoryStatement`）：`INSERT OR IGNORE`
 * 按门店＋名称去重，已存在就什么都不做，再由硬件表的子查询取回 id。
 * 随机 code 是为了满足 `UNIQUE(store_id, code)`：命中名称冲突时该行会被忽略，code 不落库。
 */
function productLinkStatements(
  db: OperationsDb,
  ctx: OperationContext,
  category: string,
  brand: string,
): D1PreparedStatement[] {
  const statements = [
    db
      .prepare(
        `INSERT OR IGNORE INTO product_categories (store_id, code, name, status, created_by, updated_by)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      )
      .bind(ctx.storeId, `LEGACY-${crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`, category, ctx.actorUserId, ctx.actorUserId),
  ]
  if (brand) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO product_brands (store_id, name, normalized_name, status, created_by, updated_by)
           VALUES (?, ?, ?, 'active', ?, ?)`,
        )
        .bind(ctx.storeId, brand, brand.toLowerCase(), ctx.actorUserId, ctx.actorUserId),
    )
  }
  return statements
}

/**
 * 拼 B12 的批次。
 *
 * 「关键属性已发生业务后修改需专门规则」（objects.json Product.rules）在本卡落地为一条硬规则：
 * 一旦该商品已经有实物或流水，就不再允许改 trackingMode / requiresSn，因为改完会让既有库存
 * 事实自相矛盾。规则写成 SQL，不靠 JS 预读判断。
 */
export function planProductWrite(
  db: OperationsDb,
  ctx: OperationContext,
  input: ProductWriteInput,
): OperationPlan {
  const mode = input.trackingMode
  const requiresSn = input.requiresSn ? 1 : 0
  const isSerialized = mode === 'item' ? 1 : 0
  const status = input.status ?? 'active'
  const category = (input.category ?? '').trim() || '未分类'
  const brand = (input.brand ?? '').trim()
  const statements: D1PreparedStatement[] = productLinkStatements(db, ctx, category, brand)

  if (input.sku) {
    statements.push(
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `EXISTS (SELECT 1 FROM hardware WHERE store_id = ? AND sku = ?
                   AND (? IS NULL OR entity_id <> ?))`,
        ctx.storeId,
        input.sku,
        input.productRef ?? null,
        input.productRef ?? null,
        { diagnostic: 'SKU_ALREADY_EXISTS' },
      ),
    )
  }

  if (!input.productRef) {
    const entityId = `${ctx.requestId}::product`
    statements.push(
      db
        .prepare(
          `INSERT INTO hardware
             (user_id, store_id, created_by, updated_by, category, category_id, name, entity_id, sku,
              tracking_mode, requires_sn, is_serialized, specs, status, default_price_cents,
              brand_id, item_type, version, updated_at)
           VALUES (?, ?, ?, ?, ?,
                   (SELECT id FROM product_categories WHERE store_id = ? AND name = ?),
                   ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   (SELECT id FROM product_brands WHERE store_id = ? AND name = ?),
                   'product', 1, datetime('now'))`,
        )
        .bind(
          ctx.actorUserId,
          ctx.storeId,
          ctx.actorUserId,
          ctx.actorUserId,
          category,
          ctx.storeId,
          category,
          input.name.trim(),
          entityId,
          input.sku ?? null,
          mode,
          requiresSn,
          isSerialized,
          input.specs ?? null,
          status,
          input.defaultSalePriceCents ?? 0,
          ctx.storeId,
          brand,
        ),
      // 断言插入确实生效：entity_id 是服务端生成的，撞车就整批回滚
      guardStatement(
        db,
        'VALIDATION_ERROR',
        'NOT EXISTS (SELECT 1 FROM hardware WHERE store_id = ? AND entity_id = ?)',
        ctx.storeId,
        entityId,
      ),
      bumpVersionStatement(db, ctx, 'Product', entityId, 1),
    )

    return {
      statements,
      outcome: {
        entityType: 'Product',
        entityId,
        version: 1,
        summary: `建立商品「${input.name.trim()}」`,
        effects: { sku: input.sku ?? null, trackingMode: mode, requiresSn: input.requiresSn },
      },
      constraintCodes: { 'hardware.store_id, hardware.sku': 'VALIDATION_ERROR' },
    }
  }

  const expectedVersion = input.expectedVersion as number
  const nextVersion = expectedVersion + 1
  const productRef = input.productRef

  statements.push(
    // 1. 商品必须存在且属本店
    guardStatement(
      db,
      'ENTITY_NOT_FOUND',
      'NOT EXISTS (SELECT 1 FROM hardware WHERE store_id = ? AND entity_id = ?)',
      ctx.storeId,
      productRef,
    ),
    // 2. 版本必须匹配
    guardStatement(
      db,
      'VERSION_CONFLICT',
      'NOT EXISTS (SELECT 1 FROM hardware WHERE store_id = ? AND entity_id = ? AND version = ?)',
      ctx.storeId,
      productRef,
      expectedVersion,
    ),
    // 即使绕过 writeProduct 校验直接组装 plan，B12 也不得成为 B40 的通用改价入口。
    guardStatement(
      db,
      'VALIDATION_ERROR',
      '? IS NOT NULL',
      input.defaultSalePriceCents ?? null,
      { diagnostic: 'LIST_PRICE_CHANGE_RESERVED' },
    ),
    // 3. 改了逐件/SN 属性，但该商品已经发生业务 —— 拒绝，不静默改写历史
    guardStatement(
      db,
      'VALIDATION_ERROR',
      `EXISTS (SELECT 1 FROM hardware h
               WHERE h.store_id = ? AND h.entity_id = ?
                 AND (h.tracking_mode <> ? OR h.requires_sn <> ?)
                 AND (EXISTS (SELECT 1 FROM stock_items si WHERE si.product_id = h.id)
                      OR EXISTS (SELECT 1 FROM inventory_movements im WHERE im.product_id = h.id)))`,
      ctx.storeId,
      productRef,
      mode,
      requiresSn,
    ),
    db
      .prepare(
        `UPDATE hardware SET
           name = ?, category = ?,
           category_id = (SELECT id FROM product_categories WHERE store_id = ? AND name = ?),
           brand_id = (SELECT id FROM product_brands WHERE store_id = ? AND name = ?),
           sku = ?, specs = ?, status = ?, default_price_cents = default_price_cents,
           tracking_mode = ?, requires_sn = ?, is_serialized = ?,
           version = ?, updated_by = ?, updated_at = datetime('now')
         WHERE store_id = ? AND entity_id = ? AND version = ?`,
      )
      .bind(
        input.name.trim(),
        category,
        ctx.storeId,
        category,
        ctx.storeId,
        brand,
        input.sku ?? null,
        input.specs ?? null,
        status,
        mode,
        requiresSn,
        isSerialized,
        nextVersion,
        ctx.actorUserId,
        ctx.storeId,
        productRef,
        expectedVersion,
      ),
    // 4. 断言条件更新确实生效 —— 影响 0 行时不留半截账
    assertRowVersionStatement(db, 'VERSION_CONFLICT', 'hardware', 'entity_id', productRef, nextVersion),
    bumpVersionStatement(db, ctx, 'Product', productRef, nextVersion),
  )

  return {
    statements,
    outcome: {
      entityType: 'Product',
      entityId: productRef,
      version: nextVersion,
      summary: `更新商品「${input.name.trim()}」`,
      effects: { trackingMode: mode, requiresSn: input.requiresSn, status },
    },
    constraintCodes: { 'hardware.store_id, hardware.sku': 'VALIDATION_ERROR' },
  }
}

/**
 * B12 入口。返回 RunResult，幂等语义由 runIdempotent 保证。
 */
export async function writeProduct(
  db: OperationsDb,
  ctx: OperationContext,
  input: ProductWriteInput,
): Promise<RunResult> {
  const invalid = validateProductInput(input)
  if (invalid) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: invalid,
      retryable: false,
      httpStatus: 400,
    }
  }
  const resolved: OperationContext = { ...ctx, payloadHash: await hashPayload(input) }
  return runIdempotent(db, resolved, (context) => planProductWrite(db, context, input))
}

// ─────────────────────────────────────────────────────────────────────────────
// B13 · 录入期初库存（POST /inventory/openings）
// 权限：inventory/opening（老板专属；旧 library/edit 的 doesNotGrant 明确不含它）
//
// 卡面通过标准：「不从历史 SN 表数量直接推断期初库存」。本实现从结构上做到这点 ——
// 期初只能由本动作写入，而本动作必须携带 approvedCountRef（人工实盘确认凭据），
// 且不存在任何从 serial_numbers 计数搬运的代码路径。
// ─────────────────────────────────────────────────────────────────────────────

export interface OpeningLineInput extends Omit<FormalOpeningLineInput, 'costBasis' | 'approvedCountLineRef'> {
  /** 正式 D10 必填，用于审计并拒绝重复导入同一盘点行。 */
  approvedCountLineRef?: string
  /** 省略或 null 表示成本未知；不得用 0 冒充已知的零成本（R01）。 */
  unitCostCents?: number | null
  /** 仅正式 D10 流程要求；旧格式预览不填，保留为待分类历史值。 */
  costBasis?: OpeningCostBasis | null
  /** 实际成本 / 真实零成本的单据或批准依据；估值行用作估值依据。 */
  costEvidenceRef?: string | null
  /** 估值日期，仅 assessed_estimate 要求，ISO 日期 YYYY-MM-DD。 */
  costAssessedAt?: string | null
}

export interface OpeningInput {
  /** 人工确认的实盘凭据。必填 —— 这是 B13 与「日常入库」的分界线。 */
  approvedCountRef: string
  costBasis?: { kind: 'known' | 'unknown'; note?: string | null } | null
  note?: string | null
  occurredAt?: string | null
  lines: OpeningLineInput[]
}

interface ResolvedProduct {
  hardwareId: number
  entityId: string
  name: string
  trackingMode: TrackingMode
  status: string
}

export interface OpeningRequestFailure {
  ok: false
  requestId: string
  code: 'VALIDATION_ERROR' | 'ENTITY_NOT_FOUND' | 'PERMISSION_DENIED'
  message: string
  retryable: false
  httpStatus: number
}

/** 供调用方在提交前校验；返回 null 表示通过。 */
export function validateOpeningInput(input: OpeningInput): string | null {
  if (!input.approvedCountRef || !input.approvedCountRef.trim()) {
    return '期初必须携带人工确认的实盘凭据（approvedCountRef）'
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) return '期初至少需要一行'
  const basis = input.costBasis?.kind
  if (basis && basis !== 'known' && basis !== 'unknown') return 'costBasis.kind 取值无效'
  for (const [index, line] of input.lines.entries()) {
    const at = `第 ${index + 1} 行`
    if (!line.productRef) return `${at}：缺少 productRef`
    if (!Number.isInteger(line.qty) || line.qty < 1) return `${at}：qty 必须为正整数`
    if (line.approvedCountLineRef !== undefined && (!line.approvedCountLineRef.trim() || line.approvedCountLineRef.trim().length > 120)) {
      return `${at}：盘点明细行引用必须为 1 至 120 个字符`
    }
    if (line.condition && line.condition !== 'new' && line.condition !== 'used') return `${at}：condition 取值无效`
    if (line.unitCostCents !== undefined && line.unitCostCents !== null) {
      if (!isValidCents(line.unitCostCents)) return `${at}：unitCostCents 必须为非负整数分`
    } else if (!line.costBasis && basis === 'known') {
      // 整单声明成本已知，却有一行给不出金额 —— 声明与事实矛盾。
      // 反过来（声明 unknown 但个别行有金额）是允许的：期初常有「大部分说不清、少数有单据」。
      return `${at}：整单声明成本已知，却缺少 unitCostCents`
    }

    if (line.costBasis == null) continue
    if (!(OPENING_COST_BASES as readonly string[]).includes(line.costBasis)) return `${at}：成本类型无效`
    const amount = line.unitCostCents
    const evidence = line.costEvidenceRef?.trim() ?? ''
    if (line.costBasis === 'unknown') {
      if (amount !== undefined && amount !== null) return `${at}：成本未知时金额必须留空，不能填 0`
      if (line.costAssessedAt) return `${at}：成本未知不能填写估值日期`
      continue
    }
    if (line.costBasis === 'zero_cost') {
      if (amount !== 0) return `${at}：真实零成本必须明确填 0 元`
      if (!evidence) return `${at}：真实零成本必须填写赠与、捐赠等依据`
      if (line.costAssessedAt) return `${at}：真实零成本不能填写估值日期`
      continue
    }
    if (!Number.isSafeInteger(amount) || (amount as number) <= 0) return `${at}：实际成本和估值都必须为正整数分，零成本请选真实零成本`
    if (!evidence) return `${at}：实际成本或估值必须填写凭据 / 估值依据`
    if (line.costBasis === 'assessed_estimate') {
      if (!isIsoDate(line.costAssessedAt)) return `${at}：估值必须填写有效的估值日期（YYYY-MM-DD）`
      if (line.costAssessedAt > nowIso().slice(0, 10)) return `${at}：估值日期不能晚于今天`
    } else if (line.costAssessedAt) {
      return `${at}：实际成本不能填写估值日期`
    }
  }
  return null
}

function isIsoDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

async function loadProducts(
  db: OperationsDb,
  storeId: number,
  refs: string[],
): Promise<Map<string, ResolvedProduct>> {
  const placeholders = refs.map(() => '?').join(', ')
  const result = await db
    .prepare(
      `SELECT id, entity_id, name, tracking_mode, COALESCE(status, 'active') AS status
       FROM hardware WHERE store_id = ? AND entity_id IN (${placeholders})`,
    )
    .bind(storeId, ...refs)
    .all<{ id: number; entity_id: string; name: string; tracking_mode: string; status: string }>()

  const map = new Map<string, ResolvedProduct>()
  for (const row of result.results ?? []) {
    map.set(row.entity_id, {
      hardwareId: row.id,
      entityId: row.entity_id,
      name: row.name,
      trackingMode: row.tracking_mode === 'item' ? 'item' : 'quantity',
      status: row.status,
    })
  }
  return map
}

export function planOpening(
  db: OperationsDb,
  ctx: OperationContext,
  input: OpeningInput,
  products: Map<string, ResolvedProduct>,
  requireOpenWindow = false,
): OperationPlan {
  const openingId = `${ctx.requestId}::opening`
  const occurredAt = input.occurredAt ?? nowIso()
  const statements: D1PreparedStatement[] = []

  if (requireOpenWindow) {
    statements.push(
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `NOT EXISTS (
           SELECT 1 FROM inventory_opening_windows
           WHERE store_id = ? AND closed_at IS NULL AND julianday(closes_at) > julianday('now')
         )`,
        ctx.storeId,
        { diagnostic: 'OPENING_WINDOW_NOT_ACTIVE' },
      ),
    )
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO inventory_openings
           (id, store_id, approved_count_ref, cost_basis_note, note, actor_user_id, request_id,
            window_opened_at, window_closes_at)
         VALUES (?, ?, ?, ?, ?, ?, ?,
           (SELECT opened_at FROM inventory_opening_windows WHERE store_id = ? AND closed_at IS NULL),
           (SELECT closes_at FROM inventory_opening_windows WHERE store_id = ? AND closed_at IS NULL))`,
      )
      .bind(
        openingId,
        ctx.storeId,
        input.approvedCountRef.trim(),
        input.costBasis?.note ?? null,
        input.note ?? null,
        ctx.actorUserId,
        ctx.requestId,
        requireOpenWindow ? ctx.storeId : null,
        requireOpenWindow ? ctx.storeId : null,
      ),
  )

  const costByProduct = new Map<number, { allKnown: boolean; cents: number }>()
  const effects: Record<string, unknown> = { openingId, itemIds: [], movementIds: [] }
  const itemIds = effects.itemIds as string[]
  const movementIds = effects.movementIds as string[]

  let openingQty = 0

  for (const [index, line] of input.lines.entries()) {
    const product = products.get(line.productRef) as ResolvedProduct
    const perItem = product.trackingMode === 'item'
    const isUsed = line.condition === 'used'
    const costBasis = line.costBasis ?? null
    // 估值金额留在明细且带 basis，但旧 cost_known 只代表实际/真实零成本，
    // 以免售后或交付流水把估值冒充实际成本计入成本报表。
    const amountPresent = line.unitCostCents !== undefined && line.unitCostCents !== null
    const costKnown = costBasis === 'assessed_estimate' || costBasis === 'unknown'
      ? false
      : amountPresent
    const unitCost = costBasis === 'assessed_estimate' || costBasis === 'unknown' || !amountPresent
      ? null
      : line.unitCostCents as number
    const estimatedUnitCost = costBasis === 'assessed_estimate' && amountPresent
      ? line.unitCostCents as number
      : null
    const stockItemId = perItem ? `${ctx.requestId}::item::${index}` : null
    // 用户原样填的编号（可能为空）。守卫必须用它判断「数量件不得带内部编号」：
    // 若拿下面加工后的 assetCode 去验，数量件恒为空串，这条守卫就被自动编号旁路掉了。
    const declaredAssetCode = (line.assetCode ?? '').trim()
    const assetCode = perItem ? declaredAssetCode || generateInternalCode('IT', ctx.storeId, occurredAt) : ''
    const snNormalized = normalizeManufacturerSn(line.snRaw)

    // 事实必须与商品属性一致：逐件商品一行一件，数量件不得带内部编号（03 §3 L50、§4 L86）。
    statements.push(
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `EXISTS (SELECT 1 FROM hardware h
                 WHERE h.store_id = ? AND h.entity_id = ?
                   AND ((h.tracking_mode = 'item' AND ? <> 1) OR (h.tracking_mode <> 'item' AND ? <> '')))`,
        ctx.storeId,
        line.productRef,
        line.qty,
        declaredAssetCode,
      ),
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `NOT EXISTS (SELECT 1 FROM hardware h
                     WHERE h.store_id = ? AND h.entity_id = ?
                       AND COALESCE(h.status, 'active') = 'active')`,
        ctx.storeId,
        line.productRef,
      ),
      // 「期初不是日常入库的捷径」（04 §5 L99）：此前已有库存事实的商品不能再走期初。
      // 两个守卫都必须排除「本次请求刚写入的行」——D1 的 batch 按顺序执行，同一批里
      // 第二条 line 会看得见第一条 line 的效果，不排除就会把本批自己的写入误判成已有库存。
      // 有过流水的商品要重建数量，应走盘点调整（count_adjustment），不是重新建期初。
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `EXISTS (SELECT 1 FROM stock_items si
                 WHERE si.store_id = ? AND si.product_id = ?
                   AND si.ownership = 'store' AND si.availability <> 'retired'
                   AND (si.acquisition_ref IS NULL OR si.acquisition_ref <> ?))`,
        ctx.storeId,
        product.hardwareId,
        openingId,
        { diagnostic: 'OPENING_ALREADY_EXISTS' },
      ),
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `EXISTS (SELECT 1 FROM inventory_movements im
                 WHERE im.store_id = ? AND im.product_id = ? AND im.request_id <> ?)`,
        ctx.storeId,
        product.hardwareId,
        ctx.requestId,
        { diagnostic: 'OPENING_ALREADY_EXISTS' },
      ),
    )

    if (requireOpenWindow && line.approvedCountLineRef) {
      statements.push(
        guardStatement(
          db,
          'VALIDATION_ERROR',
          `EXISTS (
             SELECT 1 FROM inventory_opening_lines
             WHERE store_id = ? AND approved_count_ref = ? AND approved_count_line_ref = ?
           )`,
          ctx.storeId,
          input.approvedCountRef.trim(),
          line.approvedCountLineRef.trim(),
          { diagnostic: 'OPENING_COUNT_LINE_ALREADY_IMPORTED' },
        ),
      )
    }

    const lineId = `${ctx.requestId}::opening-line::${index}`

    if (perItem) {
      statements.push(
        db
          .prepare(
            `INSERT INTO stock_items
               (id, store_id, product_id, asset_code, condition, sn_raw, sn_normalized, remark,
                ownership, availability, location, acquisition_ref,
                acquisition_cost_cents, cost_known, cost_basis, estimated_acquisition_cost_cents,
                cost_evidence_ref, cost_assessed_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'store', 'available', 'store', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            stockItemId,
            ctx.storeId,
            product.hardwareId,
            assetCode,
            isUsed ? 'used' : 'new',
            line.snRaw ?? null,
            snNormalized,
            line.remark?.trim() ?? '',
            openingId,
            unitCost,
            costKnown ? 1 : 0,
            costBasis,
            estimatedUnitCost,
            line.costEvidenceRef?.trim() || null,
            line.costAssessedAt ?? null,
            ctx.actorUserId,
          ),
      )
      itemIds.push(stockItemId)
    } else {
      const batchId = `${ctx.requestId}::batch::${index}`
      const batchCode = generateInternalCode('BT', ctx.storeId, occurredAt)
      statements.push(
        db.prepare(`INSERT INTO stock_batches
          (id, store_id, product_id, batch_code, source_ref, source_line_ref, received_qty, occurred_at, remark,
           cost_basis, unit_cost_cents, estimated_unit_cost_cents, cost_evidence_ref, cost_assessed_at, actor_user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(batchId, ctx.storeId, product.hardwareId, batchCode, openingId, lineId, line.qty, occurredAt,
            line.remark?.trim() ?? '', costBasis, unitCost, estimatedUnitCost, line.costEvidenceRef?.trim() || null,
            line.costAssessedAt ?? null, ctx.actorUserId),
      )
    }

    const movementId = `${ctx.requestId}::movement::${index}`
    statements.push(
      db
        .prepare(
          `INSERT INTO inventory_movements
             (id, store_id, product_id, stock_item_id, qty, to_bucket, cost_cents, cost_basis,
              estimated_unit_cost_cents,
              source, occurred_at, actor_user_id, request_id)
           VALUES (?, ?, ?, ?, ?, 'available', ?, ?, ?, 'opening_balance', ?, ?, ?)`,
        )
        .bind(
          movementId,
          ctx.storeId,
          product.hardwareId,
          stockItemId,
          line.qty,
          unitCost,
          costBasis,
          estimatedUnitCost,
          occurredAt,
          ctx.actorUserId,
          ctx.requestId,
        ),
    )
    movementIds.push(movementId)

    statements.push(
      db
        .prepare(
          `INSERT INTO inventory_opening_lines
             (id, opening_id, store_id, product_id, stock_item_id, qty, condition,
              asset_code, sn_raw, unit_cost_cents, cost_known, cost_basis, estimated_unit_cost_cents,
              approved_count_ref, approved_count_line_ref, cost_evidence_ref, cost_assessed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          lineId,
          openingId,
          ctx.storeId,
          product.hardwareId,
          stockItemId,
          line.qty,
          perItem ? (isUsed ? 'used' : 'new') : null,
          perItem ? assetCode : null,
          line.snRaw ?? null,
          unitCost,
          costKnown ? 1 : 0,
          costBasis,
          estimatedUnitCost,
          input.approvedCountRef.trim(),
          line.approvedCountLineRef?.trim() || null,
          line.costEvidenceRef?.trim() || null,
          line.costAssessedAt ?? null,
        ),
    )

    const entry = costByProduct.get(product.hardwareId) ?? { allKnown: true, cents: 0 }
    if (costBasis === 'assessed_estimate' || costBasis === 'unknown') entry.allKnown = false
    else if (costKnown) entry.cents += (unitCost as number) * line.qty
    else entry.allKnown = false
    costByProduct.set(product.hardwareId, entry)

    openingQty += line.qty
  }

  // 成本口径：任一未知成本行 → cost_known=0 且 total_cost_cents 为 NULL，不估成 0（R01、StockBalance.rules）。
  for (const [productId, entry] of costByProduct) {
    statements.push(
      db
        .prepare(
          `UPDATE stock_balances SET total_cost_cents = ?, cost_known = ?, updated_at = datetime('now')
           WHERE store_id = ? AND product_id = ? AND location_id = 'store'`,
        )
        .bind(entry.allKnown ? entry.cents : null, entry.allKnown ? 1 : 0, ctx.storeId, productId),
    )
  }

  return {
    statements,
    outcome: {
      entityType: 'StockItem',
      entityId: openingId,
      version: 1,
      summary: `期初建账 ${input.lines.length} 行 / ${openingQty} 件，实盘凭据：${input.approvedCountRef.trim()}`,
      effects,
    },
    constraintCodes: {
      'stock_items.store_id, stock_items.asset_code': 'VALIDATION_ERROR',
      'stock_items.store_id, stock_items.sn_normalized': 'SERIAL_MISMATCH',
      'inventory_openings.approved_count_ref': 'VALIDATION_ERROR',
    },
  }
}

/** B13 入口。 */
export async function createOpening(
  db: OperationsDb,
  ctx: OperationContext,
  input: OpeningInput,
  options: { requireOpenWindow?: boolean; requireFormalMetadata?: boolean } = {},
): Promise<RunResult | OpeningRequestFailure> {
  const formalRefs = Array.isArray(input.lines) ? input.lines.map((line) => line.approvedCountLineRef?.trim() ?? '') : []
  const duplicateFormalRef = options.requireFormalMetadata && new Set(formalRefs).size !== formalRefs.length
  const invalid = validateOpeningInput(input)
    ?? (options.requireFormalMetadata && input.lines.some((line) => !line.costBasis || !line.approvedCountLineRef?.trim())
      ? '正式期初每一行都必须填写盘点明细行引用并选择成本类型'
      : duplicateFormalRef
        ? '盘点明细行引用重复，不能重复导入同一行'
      : null)
  if (invalid) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: invalid,
      retryable: false,
      httpStatus: 400,
    }
  }

  const refs = [...new Set(input.lines.map((line) => line.productRef))]
  const products = await loadProducts(db, ctx.storeId, refs)
  for (const [index, line] of input.lines.entries()) {
    const product = products.get(line.productRef)
    if (!product) {
      return {
        ok: false,
        requestId: ctx.requestId,
        code: 'ENTITY_NOT_FOUND',
        message: `第 ${index + 1} 行的商品不存在或不属于本店`,
        retryable: false,
        httpStatus: 404,
      }
    }
  }

  const resolved: OperationContext = { ...ctx, payloadHash: await hashPayload(input) }
  return runIdempotent(db, resolved, (context) => planOpening(db, context, input, products, options.requireOpenWindow === true))
}

/** 正式窗口是一店一次；不存在的窗口与已用窗口区别返回，刷新页面后状态仍从数据库读取。 */
export async function queryOpeningWindow(
  db: OperationsDb,
  storeId: number,
  mode: OpeningWindowStatus['mode'],
): Promise<OpeningWindowStatus> {
  if (mode === 'preview') {
    return { mode, status: 'preview', openedAt: null, closesAt: null, closedAt: null, closeReason: null }
  }
  if (mode !== 'formal') {
    return { mode: 'disabled', status: 'disabled', openedAt: null, closesAt: null, closedAt: null, closeReason: null }
  }

  const row = await db.prepare(`
    SELECT opened_at, closes_at, closed_at, close_reason
    FROM inventory_opening_windows WHERE store_id = ?
  `).bind(storeId).first<{
    opened_at: string
    closes_at: string
    closed_at: string | null
    close_reason: 'first_business_movement' | null
  }>()
  if (!row) return { mode, status: 'not_started', openedAt: null, closesAt: null, closedAt: null, closeReason: null }
  const status = row.closed_at
    ? 'closed'
    : Date.parse(row.closes_at) <= Date.now()
      ? 'expired'
      : 'open'
  return {
    mode,
    status,
    openedAt: row.opened_at,
    closesAt: row.closes_at,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
  }
}

/** 老板开启一次期初窗口；服务端算 UTC 截止时间，最长七天且永不重开。 */
export async function openOpeningWindow(
  db: OperationsDb,
  ctx: OperationContext,
  durationDays: number,
): Promise<RunResult | OpeningRequestFailure> {
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 7) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: '正式期初窗口期限必须为 1 至 7 天',
      retryable: false,
      httpStatus: 400,
    }
  }
  const openedAt = nowIso()
  const closesAt = new Date(Date.parse(openedAt) + durationDays * 24 * 60 * 60 * 1000).toISOString()
  const resolved: OperationContext = { ...ctx, payloadHash: await hashPayload({ durationDays }) }
  return runIdempotent(db, resolved, () => ({
    statements: [
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `EXISTS (SELECT 1 FROM inventory_opening_windows WHERE store_id = ?)`,
        ctx.storeId,
        { diagnostic: 'OPENING_WINDOW_ALREADY_USED' },
      ),
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `EXISTS (
           SELECT 1 FROM inventory_movements
           WHERE store_id = ? AND source <> 'opening_balance'
         )`,
        ctx.storeId,
        { diagnostic: 'OPENING_WINDOW_AFTER_BUSINESS_MOVEMENT' },
      ),
      db.prepare(`
        INSERT INTO inventory_opening_windows
          (store_id, opened_at, closes_at, actor_user_id, request_id)
        VALUES (?, ?, ?, ?, ?)
      `).bind(ctx.storeId, openedAt, closesAt, ctx.actorUserId, ctx.requestId),
    ],
    outcome: {
      entityType: 'InventoryOpeningWindow',
      entityId: `opening-window:${ctx.storeId}`,
      version: 1,
      summary: `已开启正式期初窗口，截止 ${closesAt}（UTC）`,
      effects: { openedAt, closesAt, durationDays },
    },
    constraintCodes: { 'inventory_opening_windows.store_id': 'VALIDATION_ERROR' },
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// B19 · 待检件判定（POST /inventory/items/:id/inspection）
// 权限：inventory/inspection（旧 library/edit 的映射，actions.json legacyPermissionMap）
//
// 隔离件「出 quarantine」的唯一出口。契约（actions.json B19 + enums.json
// inventoryBucketRules.transitions）把合法去向钉死成两条：
//   quarantine -> available  验机通过放回可卖（明写「不再新增一次总库存」）
//   quarantine -> retired    拒收退供或报废离店
// 余额守恒不靠本模块自觉：from=quarantine / to=<disp> 的流水经 0007 的余额触发器结算，
// available 只在 to=available 时 +1；报废那一路只减 quarantine，可卖库存分毫不动。
//
// 记录落地（2026-09-22 栋哥裁定「复用 audit_logs」）：
//   契约 B19 的 effects 只有 StockItem / StockBalance，**没有 Inspection 实体**。
//   因此检查事实（结果 / 发现 / 证据 / 处置）写 audit_logs（契约 AuditEvent），
//   stock_items.inspection_ref 回填本次判定的逻辑 id（`<requestId>::inspection`）。
//   不新建业务表、不改契约 —— 与并行进行的 F1（附件基础）互不触碰单点区。
//
// 证据门槛（2026-09-22 栋哥裁定「放行必须带附件」）：
//   disposition=available 时，evidence 至少一条，且每条都必须是**服务端已实测**的有效附件：
//   存在 + 同店 + upload_state='attached' + owner 指向本实物（0022 的 CHECK 保证 attached 必有 owner）。
//   没有有效证据就想放行，报 INSPECTION_REQUIRED —— 不能强行通过。
// ─────────────────────────────────────────────────────────────────────────────

export const INSPECTION_RESULTS = ['pass', 'fail'] as const
export type InspectionResult = (typeof INSPECTION_RESULTS)[number]

/**
 * B19 允许的处置去向（落到哪个库存桶）。取自 enums.json inventoryBucketRules.transitions
 * 里 from=quarantine 的两条：待检通过放回可卖，或报废退供离店。
 *
 * ⚠️ 别与 purchase.ts 的 INSPECTION_DISPOSITIONS 混淆 —— 那个是契约枚举 InspectionDisposition
 *   （available / quarantine / return_to_supplier / return_to_customer / scrapped），
 *   说的是「这批到货怎么处置」；这里说的是「这件待检实物最终进哪个桶」。
 *   契约 B19 的 inputs 写的是 disposition:StockBucket，本常量就是它的合法子集。
 */
export const INSPECTION_RELEASE_BUCKETS = ['available', 'retired'] as const
export type InspectionReleaseBucket = (typeof INSPECTION_RELEASE_BUCKETS)[number]

export interface InspectionInput {
  result: InspectionResult
  /** 检测发现（人写的说明）。必填：没有发现就无法追溯为什么放行 / 报废。 */
  findings: string
  /** 证据附件 id（B35 / 0022 attachments 的行 id）。disposition=available 时至少一条。 */
  evidence: string[]
  disposition: InspectionReleaseBucket
  /** 乐观锁：与实物当前版本不符即拒绝，避免两个人对同一件各判一次。 */
  expectedVersion: number
  occurredAt?: string | null
}

export interface InspectionRequestFailure {
  ok: false
  requestId: string
  code:
    | 'VALIDATION_ERROR'
    | 'ENTITY_NOT_FOUND'
    | 'INSPECTION_REQUIRED'
    | 'OWNERSHIP_INVALID'
    | 'VERSION_CONFLICT'
    | 'IDEMPOTENCY_MISMATCH'
    | 'SERVICE_UNAVAILABLE'
  message: string
  retryable: boolean
  httpStatus: number
  currentVersion?: number
}

interface InspectableItem {
  id: string
  productId: number
  availability: string
  ownership: string
  version: number
}

/** 供调用方在提交前校验；返回 null 表示通过。硬断言仍在 plan 生成的 SQL 里。 */
export function validateInspectionInput(input: InspectionInput): string | null {
  if (!(INSPECTION_RESULTS as readonly string[]).includes(input.result)) return 'result 只能是 pass 或 fail'
  if (typeof input.findings !== 'string' || !input.findings.trim()) {
    return 'findings 不能为空：判定必须留下可追溯的检测发现'
  }
  if (!(INSPECTION_RELEASE_BUCKETS as readonly string[]).includes(input.disposition)) {
    return `disposition 只能是 ${INSPECTION_RELEASE_BUCKETS.join(' 或 ')}：待检件只能放回可卖或报废离店`
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    return 'expectedVersion 必须是正整数（判定必须基于一个明确的实物版本）'
  }
  if (!Array.isArray(input.evidence)) return 'evidence 必须是附件 id 数组'
  if (new Set(input.evidence).size !== input.evidence.length) return 'evidence 里有重复的附件引用'
  return null
}

export function planStockInspection(
  db: OperationsDb,
  ctx: OperationContext,
  input: InspectionInput,
  item: InspectableItem,
): OperationPlan {
  const occurredAt = input.occurredAt ?? nowIso()
  const inspectionId = `${ctx.requestId}::inspection`
  const movementId = `${ctx.requestId}::inspection-mv`
  const nextVersion = item.version + 1
  const toBucket = input.disposition
  const statements: D1PreparedStatement[] = []

  // 1. 期望版本硬断言：预读到落库之间可能被人改过，JS 的友好提示不算数。
  statements.push(
    guardStatement(
      db,
      'VERSION_CONFLICT',
      `NOT EXISTS (SELECT 1 FROM stock_items WHERE store_id = ? AND id = ? AND version = ?)`,
      ctx.storeId,
      item.id,
      input.expectedVersion,
      { diagnostic: `expected version ${input.expectedVersion}` },
    ),
  )

  // 2. 流水：只在实物**仍处于 quarantine** 时落账（条件式 SELECT）。
  //    已判定过的件（available / retired）命中 0 行 —— 不会重复扣减待处理桶，也不会重复加可卖库存。
  statements.push(
    db
      .prepare(
        `INSERT INTO inventory_movements
           (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
            source, occurred_at, actor_user_id, request_id)
         SELECT ?, si.store_id, si.product_id, si.id, 1, 'quarantine', ?, NULL,
                'inspection_release', ?, ?, ?
         FROM stock_items si
         WHERE si.store_id = ? AND si.id = ? AND si.availability = 'quarantine'`,
      )
      .bind(movementId, toBucket, occurredAt, ctx.actorUserId, ctx.requestId, ctx.storeId, item.id),
  )

  // 3. 实物状态与检查引用。条件同样带上 availability='quarantine'，
  //    使「流水落账」与「状态变更」两件事要么都发生、要么都不发生。
  statements.push(
    db
      .prepare(
        `UPDATE stock_items
           SET availability = ?, inspection_ref = ?, version = version + 1, updated_at = ?
         WHERE store_id = ? AND id = ? AND availability = 'quarantine'`,
      )
      .bind(toBucket, inspectionId, occurredAt, ctx.storeId, item.id),
  )

  // 4. 硬守卫：流水真的落了账。D1 的 batch 里「条件 UPDATE 影响 0 行」不是错误，
  //    不自己断言就会静默产生半截账（T04 的整个理由）。命中即说明实物不在待检，
  //    报 INSPECTION_REQUIRED 而不是让一次无效请求悄悄返回成功。
  statements.push(
    guardStatement(
      db,
      'INSPECTION_REQUIRED',
      `NOT EXISTS (SELECT 1 FROM inventory_movements WHERE store_id = ? AND id = ?)`,
      ctx.storeId,
      movementId,
      { diagnostic: 'ITEM_NOT_IN_QUARANTINE' },
    ),
  )

  // 5. 版本日志：乐观锁的真正实现（主键即断言，并发推进只有一个能成功）。
  statements.push(bumpVersionStatement(db, ctx, 'StockItem', item.id, nextVersion))

  // 6. 检查事实写审计（契约 AuditEvent / audit_logs）。脱敏：只写业务事实，不含 token / 大请求。
  statements.push(
    db
      .prepare(
        `INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details)
         VALUES (?, ?, 'stock_inspection', 'StockItem', ?, ?)`,
      )
      .bind(
        ctx.storeId,
        ctx.actorUserId,
        item.id,
        JSON.stringify({
          inspectionRef: inspectionId,
          result: input.result,
          findings: input.findings.trim(),
          evidence: input.evidence,
          disposition: toBucket,
          fromBucket: 'quarantine',
          toBucket,
          expectedVersion: input.expectedVersion,
          version: nextVersion,
        }),
      ),
  )

  const summary = toBucket === 'available'
    ? `待检件放行可卖（检测${input.result === 'pass' ? '通过' : '未通过'}），证据 ${input.evidence.length} 条`
    : `待检件报废离店（检测${input.result === 'pass' ? '通过' : '未通过'}），不计入可卖库存`

  return {
    statements,
    outcome: {
      entityType: 'StockItem',
      entityId: item.id,
      version: nextVersion,
      summary,
      effects: {
        inspectionRef: inspectionId,
        movementId,
        fromBucket: 'quarantine',
        toBucket,
        evidence: input.evidence,
      },
    },
    constraintCodes: {
      'inventory_movements.id': 'SERVICE_UNAVAILABLE',
      'audit_logs.id': 'SERVICE_UNAVAILABLE',
    },
  }
}

async function loadInspectableItem(
  db: OperationsDb,
  storeId: number,
  stockItemId: string,
): Promise<InspectableItem | null> {
  const row = await db
    .prepare(
      `SELECT id, product_id, availability, ownership, version
       FROM stock_items WHERE store_id = ? AND id = ?`,
    )
    .bind(storeId, stockItemId)
    .first<{ id: string; product_id: number; availability: string; ownership: string; version: number }>()
  if (!row) return null
  return {
    id: row.id,
    productId: row.product_id,
    availability: row.availability,
    ownership: row.ownership,
    version: row.version,
  }
}

/**
 * 校验证据附件是否真的可用。返回 null 表示全部合格，否则返回给用户看的原因。
 *
 * 为什么必须在服务端查表：客户端报上来的 id 只是一个字符串，不能当成「有证据」。
 * 只有 attachments 里存在且已 attached 的行才算服务端实测过的证据（0022 头注释第 2 条）。
 */
export async function verifyInspectionEvidence(
  db: OperationsDb,
  storeId: number,
  stockItemId: string,
  evidence: string[],
): Promise<string | null> {
  if (evidence.length === 0) return null
  const placeholders = evidence.map(() => '?').join(', ')
  const result = await db
    .prepare(
      `SELECT id, upload_state, owner_entity_type, owner_entity_id
       FROM attachments WHERE store_id = ? AND id IN (${placeholders})`,
    )
    .bind(storeId, ...evidence)
    .all<{ id: string; upload_state: string; owner_entity_type: string | null; owner_entity_id: string | null }>()
  const found = new Map((result.results ?? []).map((row) => [row.id, row]))
  for (const id of evidence) {
    const row = found.get(id)
    if (!row) return `证据附件 ${id} 不存在或不属于当前门店`
    if (row.upload_state !== 'attached') {
      return `证据附件 ${id} 尚未完成上传（当前 ${row.upload_state}），不能作为验机证据`
    }
    if (row.owner_entity_type !== 'stock_item' || row.owner_entity_id !== stockItemId) {
      return `证据附件 ${id} 未关联到本实物，不能作为本件的验机证据`
    }
  }
  return null
}

/** B19 入口。返回 RunResult，幂等语义由 runIdempotent 保证。 */
export async function inspectStockItem(
  db: OperationsDb,
  ctx: OperationContext,
  stockItemId: string,
  input: InspectionInput,
): Promise<RunResult | InspectionRequestFailure> {
  const invalid = validateInspectionInput(input)
  if (invalid) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: invalid, retryable: false, httpStatus: 400 }
  }

  const resolved: OperationContext = { ...ctx, payloadHash: await hashPayload(input) }

  // ── 幂等优先（顺序是功能要求，不是风格）──────────────────────────────────
  // 这一段必须排在所有状态检查之前。判定成功后实物已不在 quarantine，
  // 若先查状态，合法的「同 ID 重放」（网络超时后客户端重发）会被误判成
  // 「重复判定」而 422 —— 违反契约 objects.json Operation.rules
  // 「同 ID 同载荷返回原结果，成功凭据随单据保留」。
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, {
    action: ctx.action,
    payloadHash: resolved.payloadHash,
  })
  if (existing.found) {
    if (existing.mismatch) {
      return {
        ok: false,
        requestId: ctx.requestId,
        code: 'IDEMPOTENCY_MISMATCH',
        message: '同一 requestId 已用于不同的动作或不同的载荷，已中止；请勿更换 ID 重复提交',
        retryable: false,
        httpStatus: 409,
      }
    }
    if (existing.status !== 'succeeded') {
      return {
        ok: false,
        requestId: ctx.requestId,
        code: 'SERVICE_UNAVAILABLE',
        message: '该请求的处理结果尚未确认，请稍后查询',
        retryable: true,
        httpStatus: 503,
      }
    }
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const item = await loadInspectableItem(db, ctx.storeId, stockItemId)
  // 跨店与不存在一律 404：不泄露别家门店有没有这件实物（03 §1）。
  if (!item) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '实物不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }

  // 所有权：只有门店自有物可判定放行 / 报废。客户保管件不是我们的货（R03）。
  if (item.ownership !== 'store') {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'OWNERSHIP_INVALID',
      message: '该实物非门店所有，不能判定放行或报废；客户保管件须先走收购取得所有权',
      retryable: false,
      httpStatus: 422,
    }
  }

  // 待检门槛：只有 quarantine 桶的件可判定。这就是「同一实物不能重复判定」的闸门 ——
  // 判定成功后桶已变成 available / retired，再判直接拒绝。
  if (item.availability !== 'quarantine') {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'INSPECTION_REQUIRED',
      message: `该实物当前状态是 ${item.availability}，不在待检中；已判定过的件不能重复判定`,
      retryable: false,
      httpStatus: 422,
    }
  }

  // 版本冲突：友好提示（真正的硬断言在 plan 的守卫里）。
  if (item.version !== input.expectedVersion) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VERSION_CONFLICT',
      message: '实物已被其他人更新，请刷新后重试',
      retryable: false,
      httpStatus: 409,
      currentVersion: item.version,
    }
  }

  // 证据门槛（2026-09-22 栋哥裁定「放行必须带附件」）：
  //   · 放行可卖：evidence 至少一条 —— 没有证据就是验机门槛未达成，报 INSPECTION_REQUIRED，
  //     而不是字段格式错。它拦的是「没验机就想上架」，不是「填错了字段」。
  //   · 无论放行还是报废，一旦引用了 evidence，就逐条核实是服务端实测过的有效附件（不许拿假 id 充数）。
  if (input.disposition === 'available' && input.evidence.length === 0) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'INSPECTION_REQUIRED',
      message: '放行可卖必须先有验机证据：请先上传验机照片并完成上传，再判定为可卖',
      retryable: false,
      httpStatus: 422,
    }
  }
  if (input.evidence.length > 0) {
    const problem = await verifyInspectionEvidence(db, ctx.storeId, item.id, input.evidence)
    if (problem) {
      return { ok: false, requestId: ctx.requestId, code: 'INSPECTION_REQUIRED', message: problem, retryable: false, httpStatus: 422 }
    }
  }

  return runIdempotent(db, resolved, (context) => planStockInspection(db, context, input, item))
}

// ─────────────────────────────────────────────────────────────────────────────
// B30 · 回收件整备与上架
// ─────────────────────────────────────────────────────────────────────────────

export const CONDITION_GRADES = ['brand_new', 'like_new', 'excellent', 'good', 'fair'] as const
export type ConditionGrade = (typeof CONDITION_GRADES)[number]
export const WARRANTY_TERMS = ['3', '6', '12', '24'] as const
export type WarrantyTerm = (typeof WARRANTY_TERMS)[number]

export interface RefurbishmentInput {
  category: string
  amountCents: number
  capitalizable: boolean
  paymentEntryRef?: string | null
  evidenceRef?: string | null
  occurredAt?: string | null
}

export interface MakeItemAvailableInput {
  conditionGrade: ConditionGrade
  salePriceCents: number
  disclosureNote: string
  dataDisposed: boolean
  warrantyTerm: WarrantyTerm
  expectedVersion: number
}

type RefurbishmentFailure = InspectionRequestFailure

interface RefurbishableItem {
  id: string
  recoveryOrderId: string
  recoveryState: string
  availability: string
  ownership: string
  version: number
  acquisitionCostCents: number | null
  costKnown: number
  inspectionRef: string | null
}

function validateRefurbishmentInput(input: RefurbishmentInput): string | null {
  if (!input.category?.trim()) return '整备类别不能为空'
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) return '整备金额必须是正整数分'
  if (typeof input.capitalizable !== 'boolean') return 'capitalizable 必须是布尔值'
  if (input.paymentEntryRef != null && typeof input.paymentEntryRef !== 'string') return '付款流水引用必须是文本编号'
  if (input.evidenceRef != null && typeof input.evidenceRef !== 'string') return '凭据引用必须是文本编号'
  return null
}

function validateMakeAvailableInput(input: MakeItemAvailableInput): string | null {
  if (!(CONDITION_GRADES as readonly string[]).includes(input.conditionGrade)) return 'conditionGrade 取值无效'
  if (!Number.isInteger(input.salePriceCents) || input.salePriceCents <= 0) return 'salePriceCents 必须是正整数分'
  if (!input.disclosureNote?.trim()) return 'disclosureNote 不能为空'
  if (typeof input.dataDisposed !== 'boolean') return 'dataDisposed 必须是布尔值'
  if (!(WARRANTY_TERMS as readonly string[]).includes(input.warrantyTerm)) return 'warrantyTerm 只能是 3、6、12 或 24'
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) return 'expectedVersion 必须是正整数'
  return null
}

async function loadRefurbishableItem(db: OperationsDb, storeId: number, stockItemId: string): Promise<RefurbishableItem | null> {
  const row = await db.prepare(
    `SELECT si.id, si.availability, si.ownership, si.version, si.acquisition_cost_cents, si.cost_known, si.inspection_ref,
            ri.recovery_order_id, ro.state AS recovery_state
       FROM stock_items si
       JOIN recovery_items ri ON ri.stock_item_id = si.id AND ri.store_id = si.store_id
       JOIN recovery_orders ro ON ro.id = ri.recovery_order_id AND ro.store_id = si.store_id
      WHERE si.store_id = ? AND si.id = ?`,
  ).bind(storeId, stockItemId).first<{
    id: string; availability: string; ownership: string; version: number; acquisition_cost_cents: number | null; cost_known: number
    inspection_ref: string | null; recovery_order_id: string; recovery_state: string
  }>()
  if (!row) return null
  return { id: row.id, recoveryOrderId: row.recovery_order_id, recoveryState: row.recovery_state, availability: row.availability,
    ownership: row.ownership, version: row.version, acquisitionCostCents: row.acquisition_cost_cents, costKnown: row.cost_known, inspectionRef: row.inspection_ref }
}

function refurbishmentPlan(db: OperationsDb, ctx: OperationContext, item: RefurbishableItem, input: RefurbishmentInput): OperationPlan {
  const occurredAt = input.occurredAt ?? nowIso()
  const nextVersion = item.version + 1
  const costId = `${ctx.requestId}::refurbishment`
  const statements: D1PreparedStatement[] = [
    guardStatement(db, 'VERSION_CONFLICT',
      `NOT EXISTS (SELECT 1 FROM recovery_orders WHERE store_id=? AND id=? AND state IN ('acquired','refurbishing'))`,
      ctx.storeId, item.recoveryOrderId, { diagnostic: 'RECOVERY_NOT_REFURBISHABLE' }),
    db.prepare(`INSERT INTO refurbishment_costs
      (id, store_id, stock_item_id, category, amount_cents, capitalizable, payment_entry_ref, evidence_ref, occurred_at, request_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(costId, ctx.storeId, item.id, input.category.trim(), input.amountCents, input.capitalizable ? 1 : 0,
        input.paymentEntryRef?.trim() || null, input.evidenceRef?.trim() || null, occurredAt, ctx.requestId, ctx.actorUserId),
    db.prepare(`UPDATE stock_items SET refurbishment_cost_cents = COALESCE(refurbishment_cost_cents, 0) + ?,
      version = version + 1, updated_at = ? WHERE store_id = ? AND id = ?`)
      .bind(input.capitalizable ? input.amountCents : 0, occurredAt, ctx.storeId, item.id),
    db.prepare(`UPDATE recovery_orders SET state = 'refurbishing', version = version + 1, updated_by = ?, updated_at = ?
      WHERE store_id = ? AND id = ? AND state = 'acquired'`).bind(ctx.actorUserId, occurredAt, ctx.storeId, item.recoveryOrderId),
    bumpVersionStatement(db, ctx, 'StockItem', item.id, nextVersion),
    db.prepare(`INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details) VALUES (?, ?, 'refurbishment_record', 'StockItem', ?, ?)`)
      .bind(ctx.storeId, ctx.actorUserId, item.id, JSON.stringify({ costId, category: input.category.trim(), amountCents: input.amountCents, capitalizable: input.capitalizable,
        paymentEntryRef: input.paymentEntryRef?.trim() || null, evidenceRef: input.evidenceRef?.trim() || null })),
  ]
  return { statements, outcome: { entityType: 'StockItem', entityId: item.id, version: nextVersion,
    summary: `已记录整备${input.capitalizable ? '并计入件成本' : '费用（不计入件成本）'}：${input.category.trim()}`,
    effects: { refurbishmentCostId: costId, capitalizedCents: input.capitalizable ? input.amountCents : 0, cashEntryCreated: false } },
    constraintCodes: { 'refurbishment_costs.store_id, refurbishment_costs.request_id, refurbishment_costs.stock_item_id': 'SERVICE_UNAVAILABLE' } }
}

/** 记录整备成本；只允许回收取得但未拆件的门店自有实物。 */
export async function recordRefurbishment(db: OperationsDb, ctx: OperationContext, stockItemId: string, input: RefurbishmentInput): Promise<RunResult | RefurbishmentFailure> {
  const invalid = validateRefurbishmentInput(input)
  if (invalid) return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: invalid, retryable: false, httpStatus: 400 }
  const resolved = { ...ctx, payloadHash: await hashPayload(input) }
  const reused = await reuseExistingOperation(db, ctx, resolved.payloadHash)
  if (reused) return reused
  const item = await loadRefurbishableItem(db, ctx.storeId, stockItemId)
  if (!item) return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '回收实物不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  if (item.ownership !== 'store' || !['acquired', 'refurbishing'].includes(item.recoveryState)) {
    return { ok: false, requestId: ctx.requestId, code: 'OWNERSHIP_INVALID', message: '仅已取得所有权且未拆件的回收实物可以整备', retryable: false, httpStatus: 422 }
  }
  if (input.paymentEntryRef?.trim()) {
    const payment = await db.prepare(`SELECT id FROM cash_entries WHERE store_id = ? AND id = ? AND direction = 'out'`)
      .bind(ctx.storeId, input.paymentEntryRef.trim()).first<{ id: string }>()
    if (!payment) return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '付款流水引用必须指向本门店已登记的付款（支出）流水', retryable: false, httpStatus: 400 }
  }
  return runIdempotent(db, resolved, (operation) => refurbishmentPlan(db, operation, item, input))
}

function makeAvailablePlan(db: OperationsDb, ctx: OperationContext, item: RefurbishableItem, input: MakeItemAvailableInput): OperationPlan {
  const now = nowIso(); const nextVersion = item.version + 1
  const statements: D1PreparedStatement[] = [
    guardStatement(db, 'VERSION_CONFLICT', `NOT EXISTS (SELECT 1 FROM recovery_orders WHERE store_id=? AND id=? AND state IN ('acquired','refurbishing'))`, ctx.storeId, item.recoveryOrderId, { diagnostic: 'RECOVERY_NOT_REFURBISHABLE' }),
    guardStatement(db, 'INSPECTION_REQUIRED', `NOT EXISTS (SELECT 1 FROM stock_items WHERE store_id=? AND id=? AND inspection_ref IS NOT NULL AND acquisition_cost_cents IS NOT NULL AND cost_known=1)`, ctx.storeId, item.id, { diagnostic: 'LISTING_GATE_MISSING' }),
    guardStatement(db, 'VERSION_CONFLICT', `NOT EXISTS (SELECT 1 FROM stock_items WHERE store_id=? AND id=? AND version=?)`, ctx.storeId, item.id, input.expectedVersion, { diagnostic: 'EXPECTED_VERSION' }),
    db.prepare(`UPDATE stock_items SET condition_grade=?, sale_price_cents=?, disclosure_note=?, data_disposed=?, warranty_term=?, version=version+1, updated_at=? WHERE store_id=? AND id=?`)
      .bind(input.conditionGrade, input.salePriceCents, input.disclosureNote.trim(), input.dataDisposed ? 1 : 0, input.warrantyTerm, now, ctx.storeId, item.id),
    db.prepare(`UPDATE recovery_orders SET state='ready_for_sale', version=version+1, updated_by=?, updated_at=? WHERE store_id=? AND id=? AND state IN ('acquired','refurbishing')`)
      .bind(ctx.actorUserId, now, ctx.storeId, item.recoveryOrderId),
    bumpVersionStatement(db, ctx, 'StockItem', item.id, nextVersion),
    db.prepare(`INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details) VALUES (?, ?, 'refurbishment_list', 'StockItem', ?, ?)`)
      .bind(ctx.storeId, ctx.actorUserId, item.id, JSON.stringify({ conditionGrade: input.conditionGrade, salePriceCents: input.salePriceCents, warrantyTerm: input.warrantyTerm, dataDisposed: input.dataDisposed })),
  ]
  return { statements, outcome: { entityType: 'StockItem', entityId: item.id, version: nextVersion, summary: '回收实物已完成整备并上架', effects: { recoveryState: 'ready_for_sale', salePriceCents: input.salePriceCents } }, constraintCodes: {} }
}

/** B30 上架：写入逐件销售事实，且在事务中复核检测和已知成本门槛。 */
export async function makeItemAvailable(db: OperationsDb, ctx: OperationContext, stockItemId: string, input: MakeItemAvailableInput): Promise<RunResult | RefurbishmentFailure> {
  const invalid = validateMakeAvailableInput(input)
  if (invalid) return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: invalid, retryable: false, httpStatus: 400 }
  const resolved = { ...ctx, payloadHash: await hashPayload(input) }
  const reused = await reuseExistingOperation(db, ctx, resolved.payloadHash)
  if (reused) return reused
  const item = await loadRefurbishableItem(db, ctx.storeId, stockItemId)
  if (!item) return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '回收实物不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  if (item.ownership !== 'store' || !['acquired', 'refurbishing'].includes(item.recoveryState)) return { ok: false, requestId: ctx.requestId, code: 'OWNERSHIP_INVALID', message: '已拆件或未取得所有权的回收实物不能上架', retryable: false, httpStatus: 422 }
  if (!item.inspectionRef || item.acquisitionCostCents === null || item.costKnown !== 1) return { ok: false, requestId: ctx.requestId, code: 'INSPECTION_REQUIRED', message: '上架前必须完成检测并确认逐件可归属成本', retryable: false, httpStatus: 422 }
  if (item.version !== input.expectedVersion) return { ok: false, requestId: ctx.requestId, code: 'VERSION_CONFLICT', message: '实物已被更新，请刷新后重试', retryable: false, httpStatus: 409, currentVersion: item.version }
  return runIdempotent(db, resolved, (operation) => makeAvailablePlan(db, operation, item, input))
}

// ─────────────────────────────────────────────────────────────────────────────
// 查询 · GET /inventory、GET /inventory/items/:id（04 §3 L57-L58）
// 成本字段由 includeCost 决定是否出现在响应里 —— 不是在返回后再抹掉，而是根本不查
// （04 §2 globalRules：「内部成本…不靠前端隐藏」）。
// ─────────────────────────────────────────────────────────────────────────────

export interface InventoryQuery {
  q?: string | null
  /** 只看某一个型号（hardware.entity_id）。界面展开某行看逐件时用它，避免整店实物混在一页。 */
  productRef?: string | null
  condition?: StockCondition | null
  availability?: StockBucket | null
  limit?: number | null
  cursor?: string | null
}

export interface InventoryProductRow {
  id: string
  sku: string | null
  name: string
  category: string
  /** 品牌名。来自 product_brands 的关联，不是自由文本猜测（objects.json Product.brand）。 */
  brand: string | null
  /** 默认售价（objects.json Product.defaultSalePriceCents）。售价不是成本，不受成本权限控制。 */
  defaultSalePriceCents: number
  /** 当前版本。修改商品必须带 expectedVersion，界面拿不到版本就只能「读一次改一次」地盲写。 */
  version: number
  trackingMode: TrackingMode
  requiresSn: boolean
  status: ProductStatus
  /** 自有在库三桶，互斥；在途不在此，客户保管另列。 */
  availableQty: number
  reservedQty: number
  quarantineQty: number
  ownOnHandQty: number
  /** 门店所有的逐件实物数（不含客户保管）。 */
  storeItemCount: number
  /** 客户保管件数 —— 另列，绝不并入上面的在库数。 */
  customerCustodyCount: number
  totalCostCents?: number | null
  costKnown?: boolean
}

export interface InventoryItemRow {
  id: string
  version: number
  productId: string
  productName: string
  assetCode: string
  remark: string
  condition: StockCondition
  snRaw: string | null
  snNormalized: string | null
  ownership: 'store' | 'customer' | 'vendor'
  availability: StockBucket
  location: 'store' | 'customer' | 'external' | 'supplier'
  activeReservationRef: string | null
  acquisitionCostCents?: number | null
  assessedEstimateCents?: number | null
  costKnown?: boolean
  acquisitionCostBasis?: OpeningCostBasis | null
  costEvidenceRef?: string | null
  costAssessedAt?: string | null
}

export interface InventoryTotals {
  /** 自有在库合计 = available + reserved + quarantine。 */
  ownOnHandQty: number
  availableQty: number
  reservedQty: number
  quarantineQty: number
  /** 客户保管件数，单独一列。 */
  customerCustodyCount: number
  /** 在途不在余额表里，恒为 0；保留字段是为了让两端不必猜「为什么没有这个数」。 */
  inTransitQty: number
}

export interface InventoryListResult {
  items: InventoryProductRow[]
  /** 逐件实物明细：同型号的不同实物在这里各自一行，不会被型号汇总吞掉。 */
  lotItems: InventoryItemRow[]
  batches: StockBatchRow[]
  totals: InventoryTotals
  filters: InventoryQuery
  nextCursor: string | null
  hasMore: boolean
}

export interface StockBatchRow {
  id: string
  batchCode: string
  productId: string
  productName: string
  receivedQty: number
  occurredAt: string
  remark: string
  sourceRef: string
  unitCostCents?: number | null
  estimatedUnitCostCents?: number | null
  costBasis?: OpeningCostBasis | null
  costEvidenceRef?: string | null
  costAssessedAt?: string | null
}

interface ProductRowRaw {
  entity_id: string | null
  hardware_id: number
  sku: string | null
  name: string
  category: string
  brand_name: string | null
  default_price_cents: number
  version: number
  tracking_mode: string
  requires_sn: number
  status: string | null
  available_qty: number
  reserved_qty: number
  quarantine_qty: number
  total_cost_cents: number | null
  cost_known: number
  store_item_count: number
  customer_custody_count: number
}

export async function queryInventory(
  db: OperationsDb,
  storeId: number,
  query: InventoryQuery = {},
  options: { includeCost: boolean } = { includeCost: false },
): Promise<InventoryListResult> {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100)
  const filters = { ...query, limit }
  const conditions = [`h.store_id = ?`, `COALESCE(h.item_type, 'product') = 'product'`]
  const params: (string | number)[] = [storeId]

  if (query.q) {
    conditions.push(`(h.name LIKE ? OR COALESCE(h.sku, '') LIKE ?)`)
    params.push(`%${query.q}%`, `%${query.q}%`)
  }
  if (query.productRef) {
    conditions.push(`h.entity_id = ?`)
    params.push(query.productRef)
  }
  if (query.cursor) {
    const [lastName, lastId] = query.cursor.split('\u0001')
    conditions.push(`(h.name > ? OR (h.name = ? AND h.id > ?))`)
    params.push(lastName, lastName, Number(lastId))
  }

  const rows = await db
    .prepare(
      `SELECT h.id AS hardware_id, h.entity_id, h.sku, h.name, h.category,
              pb.name AS brand_name,
              COALESCE(h.default_price_cents, 0) AS default_price_cents,
              COALESCE(h.version, 1) AS version,
              COALESCE(h.tracking_mode, 'quantity') AS tracking_mode,
              COALESCE(h.requires_sn, 0) AS requires_sn,
              COALESCE(h.status, 'active') AS status,
              COALESCE(b.available_qty, 0) AS available_qty,
              COALESCE(b.reserved_qty, 0) AS reserved_qty,
              COALESCE(b.quarantine_qty, 0) AS quarantine_qty,
              b.total_cost_cents, COALESCE(b.cost_known, 0) AS cost_known,
              (SELECT COUNT(*) FROM stock_items si
                WHERE si.store_id = h.store_id AND si.product_id = h.id
                  AND si.ownership = 'store' AND si.availability <> 'retired') AS store_item_count,
              (SELECT COUNT(*) FROM stock_items si
                WHERE si.store_id = h.store_id AND si.product_id = h.id
                  AND si.ownership = 'customer') AS customer_custody_count
       FROM hardware h
       LEFT JOIN product_brands pb
         ON pb.id = h.brand_id AND pb.store_id = h.store_id
       LEFT JOIN stock_balances b
         ON b.store_id = h.store_id AND b.product_id = h.id AND b.location_id = 'store'
       WHERE ${conditions.join(' AND ')}
       ORDER BY h.name, h.id
       LIMIT ?`,
    )
    .bind(...params, limit + 1)
    .all<ProductRowRaw>()

  const all = rows.results ?? []
  const hasMore = all.length > limit
  const page = hasMore ? all.slice(0, limit) : all
  const last = page[page.length - 1]

  const items: InventoryProductRow[] = page.map((row) => {
    const own = row.available_qty + row.reserved_qty + row.quarantine_qty
    const item: InventoryProductRow = {
      id: row.entity_id ?? `hardware-${row.hardware_id}`,
      sku: row.sku,
      name: row.name,
      category: row.category,
      brand: row.brand_name,
      defaultSalePriceCents: row.default_price_cents,
      version: row.version,
      trackingMode: row.tracking_mode === 'item' ? 'item' : 'quantity',
      requiresSn: row.requires_sn === 1,
      status: row.status === 'disabled' ? 'disabled' : 'active',
      availableQty: row.available_qty,
      reservedQty: row.reserved_qty,
      quarantineQty: row.quarantine_qty,
      ownOnHandQty: own,
      storeItemCount: row.store_item_count,
      customerCustodyCount: row.customer_custody_count,
    }
    if (options.includeCost) {
      item.totalCostCents = row.total_cost_cents
      item.costKnown = row.cost_known === 1
    }
    return item
  })

  const itemConditions = [`si.store_id = ?`]
  const itemParams: (string | number)[] = [storeId]
  if (query.productRef) {
    itemConditions.push(`h.entity_id = ?`)
    itemParams.push(query.productRef)
  }
  if (query.q) {
    itemConditions.push(`(si.asset_code LIKE ? OR COALESCE(si.sn_normalized, '') LIKE ? OR si.remark LIKE ?)`)
    itemParams.push(`%${query.q}%`, `%${query.q.replace(/\s+/g, '').toUpperCase()}%`, `%${query.q}%`)
  }
  if (query.condition) {
    itemConditions.push(`si.condition = ?`)
    itemParams.push(query.condition)
  }
  if (query.availability) {
    itemConditions.push(`si.availability = ?`)
    itemParams.push(query.availability)
  }
  const itemRows = await db
    .prepare(
      `SELECT si.id, si.version, si.asset_code, si.condition, si.sn_raw, si.sn_normalized, si.remark,
              si.ownership, si.availability, si.location,
              si.acquisition_cost_cents, si.estimated_acquisition_cost_cents, si.cost_known, si.cost_basis, si.cost_evidence_ref, si.cost_assessed_at,
              h.entity_id AS product_entity_id, h.name AS product_name,
              (SELECT sr.id FROM stock_reservations sr
                WHERE sr.stock_item_id = si.id AND sr.status = 'active') AS active_reservation_ref
       FROM stock_items si
       JOIN hardware h ON h.id = si.product_id
       WHERE ${itemConditions.join(' AND ')}
       ORDER BY si.asset_code
       LIMIT ?`,
    )
    .bind(...itemParams, limit)
    .all<{
      id: string
      version: number
      asset_code: string
      condition: string
      sn_raw: string | null
      sn_normalized: string | null
      remark: string
      ownership: string
      availability: string
      location: string
      acquisition_cost_cents: number | null
      estimated_acquisition_cost_cents: number | null
      cost_known: number
      cost_basis: OpeningCostBasis | null
      cost_evidence_ref: string | null
      cost_assessed_at: string | null
      product_entity_id: string | null
      product_name: string
      active_reservation_ref: string | null
    }>()

  const lotItems: InventoryItemRow[] = (itemRows.results ?? []).map((row) => {
    const item: InventoryItemRow = {
      id: row.id,
      version: row.version,
      productId: row.product_entity_id ?? '',
      productName: row.product_name,
      assetCode: row.asset_code,
      remark: row.remark,
      condition: row.condition === 'used' ? 'used' : 'new',
      snRaw: row.sn_raw,
      snNormalized: row.sn_normalized,
      ownership: row.ownership as InventoryItemRow['ownership'],
      availability: row.availability as StockBucket,
      location: row.location as InventoryItemRow['location'],
      activeReservationRef: row.active_reservation_ref,
    }
    if (options.includeCost) {
      item.acquisitionCostCents = row.acquisition_cost_cents
      item.assessedEstimateCents = row.estimated_acquisition_cost_cents
      item.costKnown = row.cost_known === 1
      item.acquisitionCostBasis = row.cost_basis
      item.costEvidenceRef = row.cost_evidence_ref
      item.costAssessedAt = row.cost_assessed_at
    }
    return item
  })

  const batchResult = await db.prepare(`
    WITH batches AS (
      SELECT b.*, h.entity_id AS product_entity_id, h.name AS product_name
      FROM stock_batches b JOIN hardware h ON h.id=b.product_id AND h.store_id=b.store_id
      WHERE b.store_id=? ${query.productRef ? 'AND h.entity_id=?' : ''}
    )
    SELECT b.id, b.batch_code, b.product_entity_id, b.product_name, b.received_qty,
           b.occurred_at, b.remark, b.source_ref, b.cost_basis, b.unit_cost_cents, b.estimated_unit_cost_cents,
           b.cost_evidence_ref, b.cost_assessed_at
    FROM batches b
    WHERE (?='' OR b.batch_code LIKE ? OR b.remark LIKE ? OR b.product_name LIKE ?)
    ORDER BY b.occurred_at DESC, b.id DESC LIMIT ?
  `).bind(storeId, ...(query.productRef ? [query.productRef] : []),
    query.q ?? '', `%${query.q ?? ''}%`, `%${query.q ?? ''}%`, `%${query.q ?? ''}%`, limit)
    .all<{
      id: string; batch_code: string; product_entity_id: string | null; product_name: string; received_qty: number
      occurred_at: string; remark: string; source_ref: string; cost_basis: OpeningCostBasis | null
      unit_cost_cents: number | null; estimated_unit_cost_cents: number | null; cost_evidence_ref: string | null; cost_assessed_at: string | null
    }>()
  const batches: StockBatchRow[] = (batchResult.results ?? []).map((row) => {
    const batch: StockBatchRow = {
      id: row.id, batchCode: row.batch_code, productId: row.product_entity_id ?? '', productName: row.product_name,
      receivedQty: row.received_qty, occurredAt: row.occurred_at,
      remark: row.remark, sourceRef: row.source_ref,
    }
    if (options.includeCost) {
      batch.costBasis = row.cost_basis
      batch.unitCostCents = row.unit_cost_cents
      batch.estimatedUnitCostCents = row.estimated_unit_cost_cents
      batch.costEvidenceRef = row.cost_evidence_ref
      batch.costAssessedAt = row.cost_assessed_at
    }
    return batch
  })

  const balanceTotals = await db
    .prepare(
      `SELECT COALESCE(SUM(available_qty), 0) AS available_qty,
              COALESCE(SUM(reserved_qty), 0) AS reserved_qty,
              COALESCE(SUM(quarantine_qty), 0) AS quarantine_qty
       FROM stock_balances WHERE store_id = ?`,
    )
    .bind(storeId)
    .first<{ available_qty: number; reserved_qty: number; quarantine_qty: number }>()

  const custody = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM stock_items
       WHERE store_id = ? AND ownership = 'customer'`,
    )
    .bind(storeId)
    .first<{ n: number }>()

  const availableQty = balanceTotals?.available_qty ?? 0
  const reservedQty = balanceTotals?.reserved_qty ?? 0
  const quarantineQty = balanceTotals?.quarantine_qty ?? 0

  return {
    items,
    lotItems,
    batches,
    totals: {
      ownOnHandQty: availableQty + reservedQty + quarantineQty,
      availableQty,
      reservedQty,
      quarantineQty,
      customerCustodyCount: custody?.n ?? 0,
      inTransitQty: 0,
    },
    filters,
    nextCursor: hasMore && last ? `${last.name}\u0001${last.hardware_id}` : null,
    hasMore,
  }
}

export interface StockItemDetail {
  item: InventoryItemRow
  attachments: AttachmentView[]
  recoveryState: string | null
  /** 整备成本与凭据引用仅在有成本查看权限时返回。 */
  refurbishmentCosts?: {
    id: string
    category: string
    amountCents: number
    capitalizable: boolean
    paymentEntryRef: string | null
    evidenceRef: string | null
    occurredAt: string
  }[]
  product: {
    id: string
    sku: string | null
    name: string
    trackingMode: TrackingMode
  }
  /** 有效占用（最多一条，由部分唯一索引保证）。 */
  activeReservation: {
    id: string
    orderRef: string
    lineRef: string
    status: string
    createdAt: string
  } | null
  /** 取得来源：期初单头，或后续的采购 / 回收引用。 */
  acquisition: { kind: 'opening'; id: string; approvedCountRef: string; createdAt: string } | null
  movements: {
    id: string
    qty: number
    fromBucket: StockBucket | null
    toBucket: StockBucket | null
    source: MovementSource
    occurredAt: string
  }[]
}

export async function queryStockItem(
  db: OperationsDb,
  storeId: number,
  stockItemId: string,
  options: { includeCost: boolean } = { includeCost: false },
): Promise<StockItemDetail | null> {
  const row = await db
    .prepare(
      `SELECT si.id, si.version, si.asset_code, si.condition, si.sn_raw, si.sn_normalized, si.remark,
              si.ownership, si.availability, si.location, si.acquisition_ref,
              si.acquisition_cost_cents, si.estimated_acquisition_cost_cents, si.cost_known, si.cost_basis, si.cost_evidence_ref, si.cost_assessed_at,
              (SELECT ro.state FROM recovery_items ri JOIN recovery_orders ro ON ro.id = ri.recovery_order_id AND ro.store_id = ri.store_id WHERE ri.store_id = si.store_id AND ri.stock_item_id = si.id LIMIT 1) AS recovery_state,
              h.id AS hardware_id, h.entity_id, h.sku, h.name, COALESCE(h.tracking_mode,'quantity') AS tracking_mode
       FROM stock_items si
       JOIN hardware h ON h.id = si.product_id
       WHERE si.store_id = ? AND si.id = ?`,
    )
    .bind(storeId, stockItemId)
    .first<{
      id: string
      version: number
      asset_code: string
      condition: string
      sn_raw: string | null
      sn_normalized: string | null
      remark: string
      ownership: string
      availability: string
      location: string
      acquisition_ref: string | null
      acquisition_cost_cents: number | null
      estimated_acquisition_cost_cents: number | null
      cost_known: number
      cost_basis: OpeningCostBasis | null
      cost_evidence_ref: string | null
      cost_assessed_at: string | null
      recovery_state: string | null
      hardware_id: number
      entity_id: string | null
      sku: string | null
      name: string
      tracking_mode: string
    }>()

  if (!row) return null

  const attachments = await listAttachedForOwner(db, storeId, 'stock_item', stockItemId)

  const reservation = await db
    .prepare(
      `SELECT id, order_ref, line_ref, status, created_at
       FROM stock_reservations
       WHERE stock_item_id = ? AND status = 'active'`,
    )
    .bind(stockItemId)
    .first<{ id: string; order_ref: string; line_ref: string; status: string; created_at: string }>()

  const opening = row.acquisition_ref
    ? await db
        .prepare(
          `SELECT id, approved_count_ref, created_at FROM inventory_openings
           WHERE store_id = ? AND id = ?`,
        )
        .bind(storeId, row.acquisition_ref)
        .first<{ id: string; approved_count_ref: string; created_at: string }>()
    : null

  const movementRows = await db
    .prepare(
      `SELECT id, qty, from_bucket, to_bucket, source, occurred_at
       FROM inventory_movements WHERE stock_item_id = ?
       ORDER BY recorded_at DESC, id DESC LIMIT 50`,
    )
    .bind(stockItemId)
    .all<{
      id: string
      qty: number
      from_bucket: string | null
      to_bucket: string | null
      source: string
      occurred_at: string
    }>()

  const refurbishmentRows = options.includeCost
    ? await db.prepare(
        `SELECT id, category, amount_cents, capitalizable, payment_entry_ref, evidence_ref, occurred_at
         FROM refurbishment_costs
         WHERE store_id = ? AND stock_item_id = ?
         ORDER BY occurred_at DESC, created_at DESC, id DESC`,
      ).bind(storeId, stockItemId).all<{
        id: string
        category: string
        amount_cents: number
        capitalizable: number
        payment_entry_ref: string | null
        evidence_ref: string | null
        occurred_at: string
      }>()
    : null

  const item: InventoryItemRow = {
    id: row.id,
    version: row.version,
    productId: row.entity_id ?? `hardware-${row.hardware_id}`,
    productName: row.name,
    assetCode: row.asset_code,
    remark: row.remark,
    condition: row.condition === 'used' ? 'used' : 'new',
    snRaw: row.sn_raw,
    snNormalized: row.sn_normalized,
    ownership: row.ownership as InventoryItemRow['ownership'],
    availability: row.availability as StockBucket,
    location: row.location as InventoryItemRow['location'],
    activeReservationRef: reservation?.id ?? null,
  }
  if (options.includeCost) {
    item.acquisitionCostCents = row.acquisition_cost_cents
    item.assessedEstimateCents = row.estimated_acquisition_cost_cents
    item.costKnown = row.cost_known === 1
    item.acquisitionCostBasis = row.cost_basis
    item.costEvidenceRef = row.cost_evidence_ref
    item.costAssessedAt = row.cost_assessed_at
  }

  return {
    item,
    attachments,
    recoveryState: row.recovery_state,
    ...(refurbishmentRows ? {
      refurbishmentCosts: (refurbishmentRows.results ?? []).map((cost) => ({
        id: cost.id,
        category: cost.category,
        amountCents: cost.amount_cents,
        capitalizable: cost.capitalizable === 1,
        paymentEntryRef: cost.payment_entry_ref,
        evidenceRef: cost.evidence_ref,
        occurredAt: cost.occurred_at,
      })),
    } : {}),
    product: {
      id: row.entity_id ?? `hardware-${row.hardware_id}`,
      sku: row.sku,
      name: row.name,
      trackingMode: row.tracking_mode === 'item' ? 'item' : 'quantity',
    },
    activeReservation: reservation
      ? {
          id: reservation.id,
          orderRef: reservation.order_ref,
          lineRef: reservation.line_ref,
          status: reservation.status,
          createdAt: reservation.created_at,
        }
      : null,
    acquisition: opening
      ? { kind: 'opening', id: opening.id, approvedCountRef: opening.approved_count_ref, createdAt: opening.created_at }
      : null,
    movements: (movementRows.results ?? []).map((m) => ({
      id: m.id,
      qty: m.qty,
      fromBucket: m.from_bucket as StockBucket | null,
      toBucket: m.to_bucket as StockBucket | null,
      source: m.source as MovementSource,
      occurredAt: m.occurred_at,
    })),
  }
}

/**
 * 数量守恒校验：把某个型号的余额按流水重算一遍，与 stock_balances 当前值对比。
 *
 * 为什么需要它：余额由触发器维护，而「余额 = 流水净和」这个等式跨表跨行，SQL 的
 * CHECK 无法表达（CHECK 不能做聚合）。所以守恒不靠声明式约束，而靠两件事：
 *   1. 余额只有一个写入者（迁移 0007 的 inventory_movements_apply_balance 触发器），
 *      「一条流水必然改变一次余额」是结构保证；
 *   2. 本函数提供随时可重算的对账口径，任何一次偏离都能被发现。
 * 这是本卡在「不变量无法用现有约束表达」上如实留的口子，已登记在验证文档里。
 */
export async function reconcileProductBalance(
  db: OperationsDb,
  storeId: number,
  productId: number,
): Promise<{
  ledger: { available: number; reserved: number; quarantine: number }
  stored: { available: number; reserved: number; quarantine: number }
  consistent: boolean
}> {
  const ledgerRow = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN to_bucket = 'available'   THEN qty END), 0)
           - COALESCE(SUM(CASE WHEN from_bucket = 'available'   THEN qty END), 0) AS available,
         COALESCE(SUM(CASE WHEN to_bucket = 'reserved'    THEN qty END), 0)
           - COALESCE(SUM(CASE WHEN from_bucket = 'reserved'    THEN qty END), 0) AS reserved,
         COALESCE(SUM(CASE WHEN to_bucket = 'quarantine'  THEN qty END), 0)
           - COALESCE(SUM(CASE WHEN from_bucket = 'quarantine'  THEN qty END), 0) AS quarantine
       FROM inventory_movements WHERE store_id = ? AND product_id = ?`,
    )
    .bind(storeId, productId)
    .first<{ available: number; reserved: number; quarantine: number }>()

  const storedRow = await db
    .prepare(
      `SELECT available_qty, reserved_qty, quarantine_qty FROM stock_balances
       WHERE store_id = ? AND product_id = ? AND location_id = 'store'`,
    )
    .bind(storeId, productId)
    .first<{ available_qty: number; reserved_qty: number; quarantine_qty: number }>()

  const ledger = {
    available: ledgerRow?.available ?? 0,
    reserved: ledgerRow?.reserved ?? 0,
    quarantine: ledgerRow?.quarantine ?? 0,
  }
  const stored = {
    available: storedRow?.available_qty ?? 0,
    reserved: storedRow?.reserved_qty ?? 0,
    quarantine: storedRow?.quarantine_qty ?? 0,
  }
  return {
    ledger,
    stored,
    consistent:
      ledger.available === stored.available &&
      ledger.reserved === stored.reserved &&
      ledger.quarantine === stored.quarantine,
  }
}

/**
 * 对账：找出没有任何流水的逐件实物（「有实无账」）。
 *
 * 为什么需要它：余额只由流水维护，所以「改实物状态」与「写流水」必须成对出现 ——
 * 建实物不写流水，实物就游离在余额之外，两个视角会各说各话。这条纪律无法用数据库
 * 约束表达：CHECK 不能跨表，触发器也无从判断同一批次里是否还有一条对应的流水。
 * 与其假装它不存在，这里提供一个随时可跑的对账口径，让偏离能被发现。
 *
 * 后续卡（采购入库 T06、预留 T08、交付 T10）必须以同一纪律写库：
 * 任何改变 stock_items.availability 的动作，都要带上一条对应来源的 inventory_movements。
 */
export async function findStockItemsWithoutMovements(
  db: OperationsDb,
  storeId: number,
  limit = 50,
): Promise<{ id: string; assetCode: string; availability: StockBucket }[]> {
  const result = await db
    .prepare(
      `SELECT si.id, si.asset_code, si.availability
       FROM stock_items si
       WHERE si.store_id = ?
         AND NOT EXISTS (SELECT 1 FROM inventory_movements im WHERE im.stock_item_id = si.id)
       ORDER BY si.asset_code LIMIT ?`,
    )
    .bind(storeId, limit)
    .all<{ id: string; asset_code: string; availability: string }>()

  return (result.results ?? []).map((row) => ({
    id: row.id,
    assetCode: row.asset_code,
    availability: row.availability as StockBucket,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// B16 · 盘点录入与差异批准
//   POST /inventory/counts              权限 inventory/count（旧 library/edit 的映射，default）
//   POST /inventory/counts/:id/approve  权限 inventory/count-approve（owner_only 老板专属）
//
// 表与三条硬口径见 backend/migrations/0024_inventory_counts.sql 头注释。实现侧四个要点：
//   ① 录入与批准是**两个独立写动作**，各走 runIdempotent，两个 requestId 各自幂等；
//   ② 「保存实盘不直接改库存」不靠自觉：录入的 plan 里一条 inventory_movements 都不拼，
//      余额自然分毫不动 —— 这是可被测试证伪的结构事实，不是注释里的承诺；
//   ③ 批准前逐行核对「账面是否仍等于录入时锁存的值」，且刻意用**守卫**而不在 JS 层判断：
//      批准成功后 status 由 draft 变 approved，若在入口用 JS 判断状态，合法的「同 ID 重放」
//      会被误判成「重复批准」（B19 实测踩过一次，见其入口注释）。
//   ④ 差异用**锁存值**算（counted − book），不在批准时重算账面：重算会把截止点之后
//      发生的正常出入库一起吞进调整额，账面从此说不清。账面已变就报 VERSION_CONFLICT 重盘。
// ─────────────────────────────────────────────────────────────────────────────

export const COUNT_STATUSES = ['draft', 'approved'] as const
export type CountStatus = (typeof COUNT_STATUSES)[number]

export interface CountLineInput {
  /** 商品引用（hardware.entity_id）。 */
  productRef: string
  /** 实盘数量。允许为 0 —— 「一件都没盘到」是合法结论，也是盘亏最常见的形态。 */
  countedQty: number
  note?: string | null
}

export interface CountScopeInput {
  /** 截止时点（ISO）。缺省取录入时刻。账面快照的时间锚点，只用于溯源与展示。 */
  asOf?: string | null
  /** 盘点范围说明（人读），如「全店」「A 货架」。 */
  note?: string | null
}

export interface CountInput {
  scope?: CountScopeInput | null
  lines: CountLineInput[]
  note?: string | null
}

export interface CountApproveInput {
  /** 批准差异理由（契约 B16 必填输入）。 */
  reason: string
  expectedVersion?: number | null
}

export interface CountRequestFailure {
  ok: false
  requestId: string
  code:
    | 'VALIDATION_ERROR'
    | 'ENTITY_NOT_FOUND'
    | 'VERSION_CONFLICT'
    | 'IDEMPOTENCY_MISMATCH'
    | 'SERVICE_UNAVAILABLE'
  message: string
  retryable: boolean
  httpStatus: number
  currentVersion?: number
}

/** 供调用方在提交前校验；返回 null 表示通过。 */
export function validateCountInput(input: CountInput): string | null {
  if (!Array.isArray(input.lines) || input.lines.length === 0) return '盘点至少需要一行实盘结果'
  const seen = new Set<string>()
  for (const [index, line] of input.lines.entries()) {
    const at = `第 ${index + 1} 行`
    if (!line.productRef || !line.productRef.trim()) return `${at}：缺少 productRef`
    if (!Number.isInteger(line.countedQty) || line.countedQty < 0) return `${at}：countedQty 必须是非负整数`
    // 同一商品一次性只能有一个实盘结论：两行会让差异调整翻倍（表上也有 UNIQUE 兜底）。
    if (seen.has(line.productRef)) return `${at}：同一商品在一次盘点里只能出现一次`
    seen.add(line.productRef)
  }
  const asOf = input.scope?.asOf
  if (asOf !== undefined && asOf !== null && typeof asOf !== 'string') return 'scope.asOf 必须是 ISO 时间字符串'
  return null
}

/** 供调用方在提交前校验；返回 null 表示通过。 */
export function validateCountApproveInput(input: CountApproveInput): string | null {
  if (!input.reason || !input.reason.trim()) return '批准差异必须填写理由'
  const version = input.expectedVersion
  if (version !== undefined && version !== null) {
    if (!Number.isInteger(version) || version < 1) return 'expectedVersion 必须是正整数'
  }
  return null
}

/** 幂等前置：命中即原样复用，未命中返回 null 继续走业务分支（顺序同 B19，见其入口注释）。 */
async function reuseExistingOperation(
  db: OperationsDb,
  ctx: OperationContext,
  payloadHash: string,
): Promise<RunResult | CountRequestFailure | null> {
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action: ctx.action, payloadHash })
  if (!existing.found) return null
  if (existing.mismatch) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'IDEMPOTENCY_MISMATCH',
      message: '同一 requestId 已用于不同的动作或不同的载荷，已中止；请勿更换 ID 重复提交',
      retryable: false,
      httpStatus: 409,
    }
  }
  if (existing.status !== 'succeeded') {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'SERVICE_UNAVAILABLE',
      message: '该请求的处理结果尚未确认，请稍后查询',
      retryable: true,
      httpStatus: 503,
    }
  }
  return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
}

/** 读锁存账面：没有余额行 = 该商品还没有任何库存事实 = 账面 0（不是「查不到所以跳过」）。 */
async function loadAvailableBalances(
  db: OperationsDb,
  storeId: number,
  productIds: number[],
): Promise<Map<number, number>> {
  if (productIds.length === 0) return new Map()
  const placeholders = productIds.map(() => '?').join(', ')
  const result = await db
    .prepare(
      `SELECT product_id, available_qty FROM stock_balances
       WHERE store_id = ? AND location_id = 'store' AND product_id IN (${placeholders})`,
    )
    .bind(storeId, ...productIds)
    .all<{ product_id: number; available_qty: number }>()
  return new Map((result.results ?? []).map((row) => [row.product_id, row.available_qty]))
}

export function planCount(
  db: OperationsDb,
  ctx: OperationContext,
  input: CountInput,
  products: Map<string, ResolvedProduct>,
  balances: Map<number, number>,
): OperationPlan {
  const countId = `${ctx.requestId}::count`
  const asOf = (input.scope?.asOf ?? '').trim() || nowIso()
  const statements: D1PreparedStatement[] = []
  const lineEffects: { productRef: string; bookQty: number; countedQty: number; diffQty: number }[] = []

  statements.push(
    db
      .prepare(
        `INSERT INTO inventory_counts
           (id, store_id, status, as_of, scope_note, note, request_id, created_by)
         VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)`,
      )
      .bind(
        countId,
        ctx.storeId,
        asOf,
        (input.scope?.note ?? '').trim() || null,
        (input.note ?? '').trim() || null,
        ctx.requestId,
        ctx.actorUserId,
      ),
  )

  for (const [index, line] of input.lines.entries()) {
    const product = products.get(line.productRef) as ResolvedProduct
    const bookQty = balances.get(product.hardwareId) ?? 0
    statements.push(
      db
        .prepare(
          `INSERT INTO inventory_count_lines
             (id, count_id, store_id, product_id, book_qty, counted_qty, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `${ctx.requestId}::count-line::${index}`,
          countId,
          ctx.storeId,
          product.hardwareId,
          bookQty,
          line.countedQty,
          (line.note ?? '').trim() || null,
        ),
    )
    lineEffects.push({
      productRef: product.entityId,
      bookQty,
      countedQty: line.countedQty,
      diffQty: line.countedQty - bookQty,
    })
  }

  // 实盘事实写审计（契约 AuditEvent）。此处**没有**任何 inventory_movements / stock_balances 语句，
  // stockTouched:false 是审计里可核对的断言，不是自我描述。
  statements.push(
    db
      .prepare(
        `INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details)
         VALUES (?, ?, 'inventory_count_record', 'inventory_count', ?, ?)`,
      )
      .bind(
        ctx.storeId,
        ctx.actorUserId,
        countId,
        JSON.stringify({ countId, asOf, scopeNote: (input.scope?.note ?? '').trim() || null, lines: lineEffects, stockTouched: false }),
      ),
  )

  return {
    statements,
    outcome: {
      entityType: 'inventory_count',
      entityId: countId,
      version: 1,
      summary: `盘点草稿已保存 ${input.lines.length} 行（保存实盘不改动库存，待批准后生成差异调整）`,
      effects: { countId, asOf, lines: lineEffects, stockTouched: false },
    },
    constraintCodes: {
      'inventory_counts.id': 'SERVICE_UNAVAILABLE',
      'inventory_count_lines.count_id, inventory_count_lines.product_id': 'VALIDATION_ERROR',
    },
  }
}

/** B16 入口一：录入盘点。 */
export async function createCount(
  db: OperationsDb,
  ctx: OperationContext,
  input: CountInput,
): Promise<RunResult | CountRequestFailure> {
  const invalid = validateCountInput(input)
  if (invalid) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: invalid, retryable: false, httpStatus: 400 }
  }

  const resolved: OperationContext = { ...ctx, payloadHash: await hashPayload(input) }
  const reused = await reuseExistingOperation(db, ctx, resolved.payloadHash)
  if (reused) return reused

  const refs = [...new Set(input.lines.map((line) => line.productRef))]
  const products = await loadProducts(db, ctx.storeId, refs)
  for (const [index, line] of input.lines.entries()) {
    if (!products.has(line.productRef)) {
      return {
        ok: false,
        requestId: ctx.requestId,
        code: 'ENTITY_NOT_FOUND',
        message: `第 ${index + 1} 行的商品不存在或不属于本店`,
        retryable: false,
        httpStatus: 404,
      }
    }
  }

  const balances = await loadAvailableBalances(db, ctx.storeId, [...products.values()].map((p) => p.hardwareId))
  return runIdempotent(db, resolved, (context) => planCount(db, context, input, products, balances))
}

interface ExistingCount {
  id: string
  asOf: string
  status: CountStatus
  version: number
}

interface ExistingCountLine {
  id: string
  productId: number
  productRef: string
  bookQty: number
  countedQty: number
}

async function loadCount(db: OperationsDb, storeId: number, countId: string): Promise<ExistingCount | null> {
  const row = await db
    .prepare(`SELECT id, as_of, status, version FROM inventory_counts WHERE store_id = ? AND id = ?`)
    .bind(storeId, countId)
    .first<{ id: string; as_of: string; status: string; version: number }>()
  if (!row) return null
  return { id: row.id, asOf: row.as_of, status: row.status as CountStatus, version: row.version }
}

async function loadCountLines(db: OperationsDb, storeId: number, countId: string): Promise<ExistingCountLine[]> {
  const result = await db
    .prepare(
      `SELECT l.id, l.product_id, h.entity_id, l.book_qty, l.counted_qty
       FROM inventory_count_lines l
       JOIN hardware h ON h.id = l.product_id AND h.store_id = l.store_id
       WHERE l.store_id = ? AND l.count_id = ?
       ORDER BY l.rowid`,
    )
    .bind(storeId, countId)
    .all<{ id: string; product_id: number; entity_id: string; book_qty: number; counted_qty: number }>()
  return (result.results ?? []).map((row) => ({
    id: row.id,
    productId: row.product_id,
    productRef: row.entity_id,
    bookQty: row.book_qty,
    countedQty: row.counted_qty,
  }))
}

export function planCountApprove(
  db: OperationsDb,
  ctx: OperationContext,
  count: ExistingCount,
  lines: ExistingCountLine[],
  input: CountApproveInput,
): OperationPlan {
  const occurredAt = nowIso()
  const nextVersion = count.version + 1
  const statements: D1PreparedStatement[] = []
  const adjustments: {
    productRef: string
    bookQty: number
    countedQty: number
    diffQty: number
    movementId: string | null
  }[] = []

  // 1. 状态闸门：只有草稿可批准。已批准再批会把同一差异调整两遍，库存直接错账。
  statements.push(
    guardStatement(
      db,
      'VERSION_CONFLICT',
      `NOT EXISTS (SELECT 1 FROM inventory_counts WHERE store_id = ? AND id = ? AND status = 'draft')`,
      ctx.storeId,
      count.id,
      { diagnostic: 'COUNT_NOT_DRAFT' },
    ),
  )

  // 2. 期望版本硬断言（契约 B16 errors 列了 VERSION_CONFLICT）。
  if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
    statements.push(
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'inventory_counts', 'id', count.id, input.expectedVersion),
    )
  }

  for (const [index, line] of lines.entries()) {
    // 3. 账面未变守卫：批准时的账面必须**仍等于**录入时锁存的值。
    //    不等 ⇒ 截止点之后又有出入库 ⇒ 这次盘点的实盘结论已经过期，必须重盘。
    //    守卫排在该行的流水插入之前：同一商品一次盘点只有一行（UNIQUE），行与行之间互不干扰。
    statements.push(
      guardStatement(
        db,
        'VERSION_CONFLICT',
        `COALESCE((SELECT sb.available_qty FROM stock_balances sb
                   WHERE sb.store_id = ? AND sb.product_id = ? AND sb.location_id = 'store'), 0) <> ?`,
        ctx.storeId,
        line.productId,
        line.bookQty,
        { diagnostic: 'COUNT_BOOK_CHANGED' },
      ),
    )

    const diff = line.countedQty - line.bookQty
    if (diff === 0) {
      adjustments.push({ productRef: line.productRef, bookQty: line.bookQty, countedQty: line.countedQty, diffQty: 0, movementId: null })
      continue
    }

    // 差异流水：盘盈走「入 available」，盘亏走「出 available」。qty 恒为正（0007 的 CHECK qty <> 0）。
    const movementId = `${ctx.requestId}::count-adjustment::${index}`
    statements.push(
      db
        .prepare(
          `INSERT INTO inventory_movements
             (id, store_id, product_id, qty, from_bucket, to_bucket, source, occurred_at, actor_user_id, request_id)
           VALUES (?, ?, ?, ?, ?, ?, 'count_adjustment', ?, ?, ?)`,
        )
        .bind(
          movementId,
          ctx.storeId,
          line.productId,
          Math.abs(diff),
          diff < 0 ? 'available' : null,
          diff > 0 ? 'available' : null,
          occurredAt,
          ctx.actorUserId,
          ctx.requestId,
        ),
    )
    statements.push(
      db.prepare(`UPDATE inventory_count_lines SET adjustment_movement_id = ? WHERE id = ?`).bind(movementId, line.id),
    )
    adjustments.push({ productRef: line.productRef, bookQty: line.bookQty, countedQty: line.countedQty, diffQty: diff, movementId })
  }

  // 4. 批准落地：status → approved，记录理由 / 批准人 / 批准时间，版本 +1。
  statements.push(
    db
      .prepare(
        `UPDATE inventory_counts
            SET status = 'approved', approved_reason = ?, approved_by = ?, approved_at = ?,
                approve_request_id = ?, version = version + 1
          WHERE store_id = ? AND id = ? AND status = 'draft'`,
      )
      .bind(input.reason.trim(), ctx.actorUserId, occurredAt, ctx.requestId, ctx.storeId, count.id),
  )

  // 5. 硬守卫：批准确实落地。D1 的 batch 里「条件 UPDATE 影响 0 行」不是错误，
  //    不自己断言就会静默返回成功却什么都没改（T04 的整个理由）。
  statements.push(
    guardStatement(
      db,
      'VERSION_CONFLICT',
      `NOT EXISTS (SELECT 1 FROM inventory_counts WHERE store_id = ? AND id = ? AND status = 'approved' AND version = ?)`,
      ctx.storeId,
      count.id,
      nextVersion,
      { diagnostic: 'COUNT_APPROVE_NOT_APPLIED' },
    ),
  )

  statements.push(bumpVersionStatement(db, ctx, 'inventory_count', count.id, nextVersion))

  // 6. 差异事实写审计（契约 AuditEvent）。调整明细逐行留痕，每一笔都能追到具体流水。
  statements.push(
    db
      .prepare(
        `INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details)
         VALUES (?, ?, 'inventory_count_approve', 'inventory_count', ?, ?)`,
      )
      .bind(
        ctx.storeId,
        ctx.actorUserId,
        count.id,
        JSON.stringify({ countId: count.id, asOf: count.asOf, reason: input.reason.trim(), adjustments }),
      ),
  )

  const changed = adjustments.filter((entry) => entry.diffQty !== 0).length
  return {
    statements,
    outcome: {
      entityType: 'inventory_count',
      entityId: count.id,
      version: nextVersion,
      summary: `盘点差异已批准：共 ${adjustments.length} 行，其中 ${changed} 行生成差异调整`,
      effects: { countId: count.id, adjustments },
    },
    constraintCodes: {
      'inventory_movements.id': 'SERVICE_UNAVAILABLE',
      'inventory_count_lines.adjustment_movement_id': 'SERVICE_UNAVAILABLE',
    },
  }
}

/** B16 入口二：批准盘点差异（老板专属权限）。 */
export async function approveCount(
  db: OperationsDb,
  ctx: OperationContext,
  countId: string,
  input: CountApproveInput,
): Promise<RunResult | CountRequestFailure> {
  const invalid = validateCountApproveInput(input)
  if (invalid) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: invalid, retryable: false, httpStatus: 400 }
  }

  const resolved: OperationContext = { ...ctx, payloadHash: await hashPayload(input) }
  // 幂等优先：必须在「状态是不是草稿」之前。批准成功后状态就变 approved，
  // 若先查状态，合法的同 ID 重放会被误判成「重复批准」。
  const reused = await reuseExistingOperation(db, ctx, resolved.payloadHash)
  if (reused) return reused

  const count = await loadCount(db, ctx.storeId, countId)
  // 跨店与不存在一律 404：不泄露别家门店有没有这张盘点单。
  if (!count) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '盘点单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }

  const lines = await loadCountLines(db, ctx.storeId, countId)
  if (lines.length === 0) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '该盘点单没有实盘行，无法批准', retryable: false, httpStatus: 400 }
  }
  if (lines.some((line) => line.countedQty < line.bookQty)) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: '该盘点结果会减少账面可用库存；B39 报损流程暂缓，不能通过 B16 盘点差异冲减',
      retryable: false,
      httpStatus: 400,
    }
  }

  return runIdempotent(db, resolved, (context) => planCountApprove(db, context, count, lines, input))
}
