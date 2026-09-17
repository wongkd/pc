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
  runIdempotent,
  type OperationContext,
  type OperationPlan,
  type OperationsDb,
  type RunResult,
} from './operations'

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
] as const
export type MovementSource = (typeof MOVEMENT_SOURCES)[number]

export type TrackingMode = 'quantity' | 'item'
export type StockCondition = 'new' | 'used'
export type ProductStatus = 'active' | 'disabled'

/** 权限码（contracts/v1/actions.json 的 B12 / B13），由请求层装配。 */
export const INVENTORY_PERMISSIONS = {
  productEdit: 'inventory/product-edit',
  productView: 'inventory/product-view',
  itemView: 'inventory/item-view',
  costView: 'inventory/cost-view',
  opening: 'inventory/opening',
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
  category?: string | null
  brandNote?: string | null
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
  const statements: D1PreparedStatement[] = []

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
      ),
    )
  }

  if (!input.productRef) {
    const entityId = `${ctx.requestId}::product`
    statements.push(
      db
        .prepare(
          `INSERT INTO hardware
             (user_id, store_id, created_by, updated_by, category, name, entity_id, sku,
              tracking_mode, requires_sn, is_serialized, specs, status, default_price_cents,
              item_type, version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'product', 1, datetime('now'))`,
        )
        .bind(
          ctx.actorUserId,
          ctx.storeId,
          ctx.actorUserId,
          ctx.actorUserId,
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
           name = ?, category = ?, sku = ?, specs = ?, status = ?, default_price_cents = ?,
           tracking_mode = ?, requires_sn = ?, is_serialized = ?,
           version = ?, updated_by = ?, updated_at = datetime('now')
         WHERE store_id = ? AND entity_id = ? AND version = ?`,
      )
      .bind(
        input.name.trim(),
        category,
        input.sku ?? null,
        input.specs ?? null,
        status,
        input.defaultSalePriceCents ?? 0,
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

export interface OpeningLineInput {
  /** 商品引用（hardware.entity_id）。 */
  productRef: string
  qty: number
  /** 逐件商品必填（新件也填，便于区分成色）。 */
  condition?: StockCondition
  /** 逐件商品必填：内部唯一编号（没有厂商 SN 的二手也必须有，03 §4 L86）。 */
  assetCode?: string
  snRaw?: string
  /** 省略或 null 表示成本未知；不得用 0 冒充已知的零成本（R01）。 */
  unitCostCents?: number | null
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
    if (line.condition && line.condition !== 'new' && line.condition !== 'used') return `${at}：condition 取值无效`
    if (line.unitCostCents !== undefined && line.unitCostCents !== null) {
      if (!isValidCents(line.unitCostCents)) return `${at}：unitCostCents 必须为非负整数分`
    } else if (basis === 'known') {
      // 整单声明成本已知，却有一行给不出金额 —— 声明与事实矛盾。
      // 反过来（声明 unknown 但个别行有金额）是允许的：期初常有「大部分说不清、少数有单据」。
      return `${at}：整单声明成本已知，却缺少 unitCostCents`
    }
  }
  return null
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
): OperationPlan {
  const openingId = `${ctx.requestId}::opening`
  const occurredAt = input.occurredAt ?? nowIso()
  const statements: D1PreparedStatement[] = []

  statements.push(
    db
      .prepare(
        `INSERT INTO inventory_openings
           (id, store_id, approved_count_ref, cost_basis_note, note, actor_user_id, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        openingId,
        ctx.storeId,
        input.approvedCountRef.trim(),
        input.costBasis?.note ?? null,
        input.note ?? null,
        ctx.actorUserId,
        ctx.requestId,
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
    const costKnown = line.unitCostCents !== undefined && line.unitCostCents !== null
    const unitCost = costKnown ? (line.unitCostCents as number) : null
    const assetCode = (line.assetCode ?? '').trim()
    const snNormalized = line.snRaw ? normalizeSn(line.snRaw) : null

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
        assetCode,
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
      ),
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `EXISTS (SELECT 1 FROM inventory_movements im
                 WHERE im.store_id = ? AND im.product_id = ? AND im.request_id <> ?)`,
        ctx.storeId,
        product.hardwareId,
        ctx.requestId,
      ),
    )

    const lineId = `${ctx.requestId}::opening-line::${index}`
    let stockItemId: string | null = null

    if (perItem) {
      stockItemId = `${ctx.requestId}::item::${index}`
      statements.push(
        db
          .prepare(
            `INSERT INTO stock_items
               (id, store_id, product_id, asset_code, condition, sn_raw, sn_normalized,
                ownership, availability, location, acquisition_ref,
                acquisition_cost_cents, cost_known, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'store', 'available', 'store', ?, ?, ?, ?)`,
          )
          .bind(
            stockItemId,
            ctx.storeId,
            product.hardwareId,
            assetCode,
            isUsed ? 'used' : 'new',
            line.snRaw ?? null,
            snNormalized,
            openingId,
            unitCost,
            costKnown ? 1 : 0,
            ctx.actorUserId,
          ),
      )
      itemIds.push(stockItemId)
    }

    const movementId = `${ctx.requestId}::movement::${index}`
    statements.push(
      db
        .prepare(
          `INSERT INTO inventory_movements
             (id, store_id, product_id, stock_item_id, qty, to_bucket, cost_cents,
              source, occurred_at, actor_user_id, request_id)
           VALUES (?, ?, ?, ?, ?, 'available', ?, 'opening_balance', ?, ?, ?)`,
        )
        .bind(
          movementId,
          ctx.storeId,
          product.hardwareId,
          stockItemId,
          line.qty,
          unitCost,
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
              asset_code, sn_raw, unit_cost_cents, cost_known)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        ),
    )

    const entry = costByProduct.get(product.hardwareId) ?? { allKnown: true, cents: 0 }
    if (costKnown) entry.cents += (unitCost as number) * line.qty
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
): Promise<RunResult | OpeningRequestFailure> {
  const invalid = validateOpeningInput(input)
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
    if (product.trackingMode === 'item' && !(line.assetCode ?? '').trim()) {
      return {
        ok: false,
        requestId: ctx.requestId,
        code: 'VALIDATION_ERROR',
        message: `第 ${index + 1} 行：逐件商品必须提供内部唯一编号 assetCode`,
        retryable: false,
        httpStatus: 400,
      }
    }
  }

  const resolved: OperationContext = { ...ctx, payloadHash: await hashPayload(input) }
  return runIdempotent(db, resolved, (context) => planOpening(db, context, input, products))
}

// ─────────────────────────────────────────────────────────────────────────────
// 查询 · GET /inventory、GET /inventory/items/:id（04 §3 L57-L58）
// 成本字段由 includeCost 决定是否出现在响应里 —— 不是在返回后再抹掉，而是根本不查
// （04 §2 globalRules：「内部成本…不靠前端隐藏」）。
// ─────────────────────────────────────────────────────────────────────────────

export interface InventoryQuery {
  q?: string | null
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
  brandId: number | null
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
  productId: string
  productName: string
  assetCode: string
  condition: StockCondition
  snRaw: string | null
  snNormalized: string | null
  ownership: 'store' | 'customer' | 'vendor'
  availability: StockBucket
  location: 'store' | 'customer' | 'external' | 'supplier'
  activeReservationRef: string | null
  acquisitionCostCents?: number | null
  costKnown?: boolean
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
  totals: InventoryTotals
  filters: InventoryQuery
  nextCursor: string | null
  hasMore: boolean
}

interface ProductRowRaw {
  entity_id: string | null
  hardware_id: number
  sku: string | null
  name: string
  category: string
  brand_id: number | null
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
  if (query.cursor) {
    const [lastName, lastId] = query.cursor.split('\u0001')
    conditions.push(`(h.name > ? OR (h.name = ? AND h.id > ?))`)
    params.push(lastName, lastName, Number(lastId))
  }

  const rows = await db
    .prepare(
      `SELECT h.id AS hardware_id, h.entity_id, h.sku, h.name, h.category, h.brand_id,
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
      brandId: row.brand_id,
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
      `SELECT si.id, si.asset_code, si.condition, si.sn_raw, si.sn_normalized,
              si.ownership, si.availability, si.location,
              si.acquisition_cost_cents, si.cost_known,
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
      asset_code: string
      condition: string
      sn_raw: string | null
      sn_normalized: string | null
      ownership: string
      availability: string
      location: string
      acquisition_cost_cents: number | null
      cost_known: number
      product_entity_id: string | null
      product_name: string
      active_reservation_ref: string | null
    }>()

  const lotItems: InventoryItemRow[] = (itemRows.results ?? []).map((row) => {
    const item: InventoryItemRow = {
      id: row.id,
      productId: row.product_entity_id ?? '',
      productName: row.product_name,
      assetCode: row.asset_code,
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
      item.costKnown = row.cost_known === 1
    }
    return item
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
      `SELECT si.id, si.asset_code, si.condition, si.sn_raw, si.sn_normalized,
              si.ownership, si.availability, si.location, si.acquisition_ref,
              si.acquisition_cost_cents, si.cost_known,
              h.id AS hardware_id, h.entity_id, h.sku, h.name, COALESCE(h.tracking_mode,'quantity') AS tracking_mode
       FROM stock_items si
       JOIN hardware h ON h.id = si.product_id
       WHERE si.store_id = ? AND si.id = ?`,
    )
    .bind(storeId, stockItemId)
    .first<{
      id: string
      asset_code: string
      condition: string
      sn_raw: string | null
      sn_normalized: string | null
      ownership: string
      availability: string
      location: string
      acquisition_ref: string | null
      acquisition_cost_cents: number | null
      cost_known: number
      hardware_id: number
      entity_id: string | null
      sku: string | null
      name: string
      tracking_mode: string
    }>()

  if (!row) return null

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

  const item: InventoryItemRow = {
    id: row.id,
    productId: row.entity_id ?? `hardware-${row.hardware_id}`,
    productName: row.name,
    assetCode: row.asset_code,
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
    item.costKnown = row.cost_known === 1
  }

  return {
    item,
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
