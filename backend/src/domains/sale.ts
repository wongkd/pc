/**
 * E06 · 销售单领域：报价成交（B03）、确认成交与补分配（B05）、登记销售收款（B08）。
 *
 * 契约依据（contracts/v1）：
 *   actions.json  B03  报价转为销售单 /sales/quotes/:id/convert（sales/quote-convert）
 *                 B05  确认成交与补分配 /sales/orders/:id/confirm | /allocate（sales/order-edit）
 *                 B08  登记销售收款 /sales/orders/:id/payments（sales/order-payment）
 *   objects.json  SaleOrder / SaleLine / Reservation / CashEntry
 *   enums.json    SaleKind / SaleTradeState / SaleFulfillmentState / LineSource /
 *                 BalanceDirection / CashDirection / CashMethod / CashVerificationState
 *   money-rules.json discountAllocation / collectableCents / balanceDirection
 *
 * ── 三条硬边界在这份代码里的落点 ──
 *
 * 1.「未付款不预留、不采购」（R07 / S2 R12–R16）
 *    B03 只生成销售单与缺口，一行库存都不写。占用由 B05 写，而 B05 带一道定金闸：
 *    已核实收款（含折抵）必须达到条款约定的定金门槛，否则 VALIDATION_ERROR。
 *    「确认 ≠ 付款、确认不锁库存」是报价侧的 B42；本侧「收款 → 预留」才成对。
 *
 * 2.「抢最后一件只有一单成功」（E06 放行证据 3）
 *    逐件占用写 0007 的 stock_reservations，靠部分唯一索引
 *    uq_stock_reservations_active_item (stock_item_id) WHERE status='active' 兜底。
 *    并发时后到的一批撞唯一索引 → 整批回滚 → STOCK_CONFLICT。这条路不查「还剩几件」，
 *    所以不存在检查与写入之间的窗口。
 *
 * 3.「预留失败不吞掉已收的钱」（放行证据 3 的后半句）
 *    收款（B08）与预留（B05）是两次独立的 runIdempotent 调用、两个独立 batch。
 *    预留失败只回滚它自己那一批；先前的 cash_entries 与订单余额变动照旧成立。
 *    这是「两次 batch」的结构结果，不需要任何补偿代码。
 *
 * ⚠️ 本轮范围（写进验证文档，不夸大）：占用只覆盖**逐件实物行**
 *    （sale_lines.stock_item_id 非空，即二手件与逐件管理的新品）。
 *    数量件（trackingMode=quantity 的新品行）与客供件、服务行不写占用：前者记为缺口走
 *    E07 采购，后两者本就不占店有库存。数量件占用需要契约 Reservation.quantityBucketRef
 *    与对应落库结构，而 0007 的 stock_reservations 只支持逐件（qty CHECK = 1 且按
 *    stock_item_id 建部分唯一索引）—— 扩容属另一刀，已登记为未决项。
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
import { QUOTE_SETTINGS, validateCheckoutTermsSnapshot } from './quote'
import { safeCustomerWarrantySnapshot, warrantyPolicyFromTermsSnapshot, type CustomerWarrantySnapshot } from './warranty'

// ─────────────────────────────── 枚举与常量 ───────────────────────────────

export const SALE_ORDER_KINDS = ['assembly', 'retail'] as const
export type SaleOrderKind = (typeof SALE_ORDER_KINDS)[number]

export const SALE_LINE_SOURCES = ['new', 'used', 'customer', 'service'] as const
export type SaleLineSource = (typeof SALE_LINE_SOURCES)[number]

export const SALE_TRADE_STATES = ['draft', 'confirmed', 'cancelled', 'closed'] as const
export type SaleTradeState = (typeof SALE_TRADE_STATES)[number]

export const SALE_FULFILLMENT_STATES = [
  'waiting_stock',
  'preparing',
  'testing',
  'ready_delivery',
  'delivered',
] as const
export type SaleFulfillmentState = (typeof SALE_FULFILLMENT_STATES)[number]

export const CASH_METHODS = ['cash', 'wechat', 'alipay', 'bank', 'other'] as const
export type CashMethod = (typeof CASH_METHODS)[number]

export const BALANCE_DIRECTIONS = ['client_due', 'settled', 'store_due'] as const
export type BalanceDirection = (typeof BALANCE_DIRECTIONS)[number]

/** 可成交的报价版本状态：已发出或顾客已确认。草稿、已转单、已过期都不行。 */
const CONVERTIBLE_QUOTE_STATUS = ['issued', 'confirmed'] as const

const MAX_LINES = 200

// ─────────────────────────────── 入参 ───────────────────────────────

/** 分配选择：给某个销售行指定具体实物。position 与报价行的 position 对齐。 */
export interface AllocationChoice {
  position: number
  stockItemId?: string | null
}

export interface ConvertQuoteInput {
  /** 要成交的报价版本号。契约 B03 inputs 的第一个字段。 */
  quoteVersion: number
  dueAt?: string | null
  allocationChoices?: AllocationChoice[]
  /**
   * 转单时补的商品引用（行序 → hardware.entity_id）。
   *
   * 报价行的 product_ref 允许为空（契约「草稿中的临时实物行可未建档」），历史报价更是
   * 全空（E05 收了 productRef 却没落库）。已发出的版本不可再改（契约「发出后不可覆盖」），
   * 所以补映射只能发生在这里：结果只写进 sale_lines，不回头改报价版本。
   */
  lineProductMap?: { position: number; productRef: string }[]
  note?: string | null
}

export interface ConfirmOrderInput {
  dueAt?: string | null
  /** 补分配时给的候选实物；confirm 与 allocate 共用。 */
  allocationChoices?: AllocationChoice[]
  note?: string | null
}

export interface SalePaymentInput {
  amountCents: number
  method: CashMethod
  occurredAt?: string | null
  remark?: string | null
  verificationState?: 'unverified' | 'verified'
}

// ─────────────────────────────── 纯函数（可单测） ───────────────────────────────

/**
 * 优惠分摊（money-rules.json discountAllocation）：
 *   按各行折前金额占比分配到分，先向下取整，余分按最大余数、再按稳定行序分配。
 *   只分配给有价行（unitPrice × qty > 0）；客供件这类 0 价行不参与分摊。
 *   不变式：各行之和 === discountCents。
 */
export function allocateDiscount(
  lines: readonly { position: number; unitPriceCents: number; qty: number }[],
  discountCents: number,
): number[] {
  const out = new Array<number>(lines.length).fill(0)
  if (!Number.isInteger(discountCents) || discountCents <= 0) return out

  const bases = lines.map((line) => line.unitPriceCents * line.qty)
  const totalBase = bases.reduce((sum, value) => sum + value, 0)
  if (totalBase <= 0) return out

  const remainders: { index: number; frac: number; position: number }[] = []
  let allocated = 0
  for (let index = 0; index < lines.length; index += 1) {
    if (bases[index] <= 0) continue
    const exact = (discountCents * bases[index]) / totalBase
    const floor = Math.floor(exact)
    out[index] = floor
    allocated += floor
    remainders.push({ index, frac: exact - floor, position: lines[index].position })
  }

  let rest = discountCents - allocated
  remainders.sort((a, b) => b.frac - a.frac || a.position - b.position)
  for (const item of remainders) {
    if (rest <= 0) break
    out[item.index] += 1
    rest -= 1
  }
  return out
}

/** balanceDirection（money-rules.json）：由余额符号派生，不是可编辑字段。 */
export function balanceDirectionFor(balanceCents: number): BalanceDirection {
  if (balanceCents > 0) return 'client_due'
  if (balanceCents < 0) return 'store_due'
  return 'settled'
}

/** 可收款上限（money-rules.json collectableCents）：max(余额, 0)。 */
export function collectableCents(balanceCents: number): number {
  return Math.max(balanceCents, 0)
}

/** 首发预付款按已确认应付金额的 15% 计算，快照里的旧/自定义比例不能降低门槛。 */
export function requiredDepositCents(totalCents: number, _termsSnapshot: string | null): number {
  if (totalCents <= 0) return 0
  return Math.ceil((totalCents * QUOTE_SETTINGS.depositPercent) / 100)
}

/** 订单号：日期 + requestId 派生的稳定后缀。确定性，重放同 requestId 得同一个号。 */
/**
 * 订单号：`SO-<日期>-<8 位十六进制>`。
 *
 * ⚠️ 这里原来取 requestId 去掉非字母数字后的**前 8 个字符**，那是个真缺陷：
 * 任何「公共前缀 + 顺序编号」的 requestId（真实业务里的 `req-20260921-001` / `-002`，
 * 或测试里的 `...-a-conv` / `...-b-conv`）前 8 位完全一样 ⇒ 订单号必然相撞
 * ⇒ 撞上 sale_orders 的 UNIQUE (store_id, order_no) ⇒ 整单失败，
 * 而错误还会被映射成「报价没有通过转单校验」，把人引到完全错误的方向去查。
 *
 * 改成对**整个** requestId 求 32 位稳定哈希再取 8 位 hex：
 *   · 无状态：同一个 requestId 永远得到同一个单号，幂等重放不会换号；
 *   · 覆盖全串：前缀相同的 requestId 也会散到不同单号；
 *   · 仍由 UNIQUE (store_id, order_no) 兜底 —— 哈希只是把碰撞概率降下来，不是取消约束。
 */
export function orderNoFor(requestId: string, now: string): string {
  const date = now.slice(0, 10).replace(/-/g, '')
  return `SO-${date}-${stableHash8(requestId)}`
}

/** FNV-1a 32 位 + 雪崩混合：输入任一字符不同都会明显改变结果。 */
function stableHash8(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  // 雪崩：把低位差异扩散到高位，避免「只差最后一个字符」时结果仍然挨得很近。
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d) >>> 0
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x846ca68b) >>> 0
  hash ^= hash >>> 16
  // ⚠️ 必须 >>> 0 转回无符号：^= 的结果是有符号 32 位，
  // 为负时 toString(16) 会带一个 '-'，订单号就成了 SO-20260921--7687B199。
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

// ─────────────────────────────── 读辅助（plan 必须同步，预读在这里） ───────────────────────────────

interface QuoteHeaderRow {
  id: string
  customer_id: number | null
  title: string
  current_revision: number
  version: number
}

interface QuoteVersionRow {
  revision: number
  status: string
  valid_until: string | null
  discount_cents: number
  subtotal_cents: number
  total_cents: number
  terms_snapshot: string
}

interface QuoteLineRow {
  position: number
  source: string
  name_snapshot: string
  spec_snapshot: string | null
  qty: number
  unit_price_cents: number
  /** 商品引用（hardware.entity_id）。E05 只收不落，0015 补列后这里才有值。 */
  product_ref: string | null
  stock_item_id: string | null
  customer_device_ref: string | null
  warranty_snapshot: string | null
}

/** 报价行 + 解析出来的商品。 */
interface ResolvedQuoteLine extends QuoteLineRow {
  product_id: number | null
  /** 商品的跟踪方式（item / quantity）。数量件占用要靠它判定，解析不到商品时为 null。 */
  tracking_mode: string | null
  /** 商品名。仅用于把「引用失效」说成人话，不参与金额。 */
  product_name: string | null
}

interface CustomerRow {
  id: number
  name: string
  phone: string
  address: string | null
}

async function readQuoteHeader(db: OperationsDb, storeId: number, quoteId: string): Promise<QuoteHeaderRow | null> {
  const row = await db
    .prepare(
      `SELECT id, customer_id, title, current_revision, version
       FROM quote_headers WHERE store_id = ? AND id = ?`,
    )
    .bind(storeId, quoteId)
    .first<QuoteHeaderRow>()
  return row ?? null
}

async function readQuoteVersion(
  db: OperationsDb,
  storeId: number,
  quoteId: string,
  revision: number,
): Promise<QuoteVersionRow | null> {
  const row = await db
    .prepare(
      `SELECT revision, status, valid_until, discount_cents, subtotal_cents, total_cents, terms_snapshot
       FROM quote_versions WHERE store_id = ? AND quote_id = ? AND revision = ?`,
    )
    .bind(storeId, quoteId, revision)
    .first<QuoteVersionRow>()
  return row ?? null
}

async function readQuoteLines(
  db: OperationsDb,
  storeId: number,
  quoteId: string,
  revision: number,
): Promise<QuoteLineRow[]> {
  const result = await db
    .prepare(
      `SELECT position, source, name_snapshot, spec_snapshot, qty, unit_price_cents,
              product_ref, stock_item_id, customer_device_ref, warranty_snapshot
       FROM quote_lines WHERE store_id = ? AND quote_id = ? AND revision = ?
       ORDER BY position ASC`,
    )
    .bind(storeId, quoteId, revision)
    .all<QuoteLineRow>()
  return result.results ?? []
}

async function readCustomer(db: OperationsDb, storeId: number, customerId: number): Promise<CustomerRow | null> {
  const row = await db
    .prepare(`SELECT id, name, phone, address FROM customers WHERE store_id = ? AND id = ?`)
    .bind(storeId, customerId)
    .first<CustomerRow>()
  return row ?? null
}

/**
 * 商品映射：契约 QuoteVersion.rules 第 1 条「草稿中的临时实物行可未建档；成交前必须映射到商品」，
 * 与 SaleLine.rules「new / used 成交时需商品映射」指向同一结论：
 * **成交（B03）时 new / used 行必须解析出商品主键，否则不许成交。**
 *
 * 两条映射路径，都是可靠来源，都不靠猜：
 *   · used 行（以及明确指定了实物的 new 行）：实物 stock_items.id 自带 product_id；
 *   · new 行：报价行携带的商品引用 quote_lines.product_ref（hardware.entity_id）。
 *
 * E06 当时只能走第一条：quote_lines 没有商品引用列（E05 收了 productRef 却没落库，0015 才补上），
 * 于是 new 行只能把 product_id 记 NULL 丢进「缺口」—— 那正好把「订单缺件 → 建采购」这条线弄断。
 * 现在引用有了，new 行映射不出来就是真错（引用失效，或压根没选商品），由调用方明确拒绝，
 * 不再静默降级成缺口 —— 静默降级会让用户以为「只是缺货」，实际是「这单不知道卖的是什么」。
 */
async function resolveLineProducts(
  db: OperationsDb,
  storeId: number,
  lines: readonly QuoteLineRow[],
): Promise<ResolvedQuoteLine[]> {
  const itemIds = [...new Set(lines.map((line) => line.stock_item_id).filter((v): v is string => Boolean(v)))]
  const byStockItem = new Map<string, number>()
  if (itemIds.length > 0) {
    const placeholders = itemIds.map(() => '?').join(', ')
    const rows = await db
      .prepare(`SELECT id, product_id FROM stock_items WHERE store_id = ? AND id IN (${placeholders})`)
      .bind(storeId, ...itemIds)
      .all<{ id: string; product_id: number }>()
    for (const row of rows.results ?? []) byStockItem.set(row.id, row.product_id)
  }

  const refs = [...new Set(lines.map((line) => line.product_ref).filter((v): v is string => Boolean(v)))]
  const byEntityId = new Map<string, number>()
  if (refs.length > 0) {
    const placeholders = refs.map(() => '?').join(', ')
    const rows = await db
      .prepare(`SELECT id, entity_id FROM hardware WHERE store_id = ? AND entity_id IN (${placeholders})`)
      .bind(storeId, ...refs)
      .all<{ id: number; entity_id: string | null }>()
    for (const row of rows.results ?? []) if (row.entity_id) byEntityId.set(row.entity_id, row.id)
  }

  const resolved = lines.map((line) => {
    const productId = line.stock_item_id
      ? byStockItem.get(line.stock_item_id) ?? null
      : line.product_ref
        ? byEntityId.get(line.product_ref) ?? null
        : null
    return { ...line, product_id: productId }
  })

  // 商品名与跟踪方式一并取回：数量件占用要判 tracking_mode，
  // 「引用失效」的提示也要能说出用户认得的是哪个商品。
  const productIds = [...new Set(resolved.map((line) => line.product_id).filter((v): v is number => v !== null))]
  const products = new Map<number, { name: string; tracking_mode: string }>()
  if (productIds.length > 0) {
    const placeholders = productIds.map(() => '?').join(', ')
    const rows = await db
      .prepare(`SELECT id, name, tracking_mode FROM hardware WHERE store_id = ? AND id IN (${placeholders})`)
      .bind(storeId, ...productIds)
      .all<{ id: number; name: string; tracking_mode: string }>()
    for (const row of rows.results ?? []) products.set(row.id, { name: row.name, tracking_mode: row.tracking_mode })
  }

  return resolved.map((line) => ({
    ...line,
    tracking_mode: line.product_id !== null ? products.get(line.product_id)?.tracking_mode ?? null : null,
    product_name: line.product_id !== null ? products.get(line.product_id)?.name ?? null : null,
  }))
}

export interface SaleOrderRow {
  id: string
  order_no: string
  quote_id: string | null
  quote_revision: number | null
  customer_id: number | null
  customer_snapshot: string
  kind: string
  trade_state: string
  fulfillment_state: string
  due_at: string | null
  configuration_version: number
  subtotal_cents: number
  discount_cents: number
  adjustment_cents: number
  total_cents: number
  cash_net_cents: number
  offset_net_cents: number
  return_credit_cents: number
  balance_cents: number
  balance_direction: string
  note: string
  terms_snapshot: string | null
  version: number
  created_at: string
  updated_at: string
}

// E08 起改为导出：装配域（domains/assembly.ts）复用同一套读辅助与行类型，
// 避免复制出第二份「读销售单」的实现。只加 export，不改任何行为。
export async function readOrder(db: OperationsDb, storeId: number, orderId: string): Promise<SaleOrderRow | null> {
  const row = await db
    .prepare(
      `SELECT id, order_no, quote_id, quote_revision, customer_id, customer_snapshot, kind,
              trade_state, fulfillment_state, due_at, configuration_version,
              subtotal_cents, discount_cents, adjustment_cents, total_cents,
              cash_net_cents, offset_net_cents, return_credit_cents, balance_cents, balance_direction,
              note, terms_snapshot, version, created_at, updated_at
       FROM sale_orders WHERE store_id = ? AND id = ?`,
    )
    .bind(storeId, orderId)
    .first<SaleOrderRow>()
  return row ?? null
}

export interface SaleLineRow {
  id: string
  position: number
  source: string
  name_snapshot: string
  spec_snapshot: string | null
  qty: number
  unit_price_cents: number
  discount_allocation_cents: number
  net_line_cents: number
  warranty_snapshot: string | null
  stock_item_id: string | null
  customer_device_ref: string | null
  product_id: number | null
}

export async function readSaleLines(db: OperationsDb, storeId: number, orderId: string): Promise<SaleLineRow[]> {
  const result = await db
    .prepare(
      `SELECT id, position, source, name_snapshot, spec_snapshot, qty, unit_price_cents,
              discount_allocation_cents, net_line_cents, warranty_snapshot, stock_item_id, customer_device_ref, product_id
       FROM sale_lines WHERE store_id = ? AND sale_order_id = ? ORDER BY position ASC`,
    )
    .bind(storeId, orderId)
    .all<SaleLineRow>()
  return result.results ?? []
}

export interface StockItemRow {
  id: string
  product_id: number
  availability: string
  ownership: string
}

export async function readStockItems(
  db: OperationsDb,
  storeId: number,
  ids: readonly string[],
): Promise<Map<string, StockItemRow>> {
  const out = new Map<string, StockItemRow>()
  if (ids.length === 0) return out
  const placeholders = ids.map(() => '?').join(', ')
  const result = await db
    .prepare(
      `SELECT id, product_id, availability, ownership
       FROM stock_items WHERE store_id = ? AND id IN (${placeholders})`,
    )
    .bind(storeId, ...ids)
    .all<StockItemRow>()
  for (const row of result.results ?? []) out.set(row.id, row)
  return out
}

// ─────────────────────────────── B03 报价转为销售单 ───────────────────────────────

/**
 * B03 的 plan。
 *
 * ⚠️ 这里刻意**不写 stock_reservations**，尽管 actions.json B03 的 result 提到「现货预留」。
 * 理由是优先级：R07（用户已确认的经营规则：未付款不预留不采购）高于 T01 冻结的
 * result 措辞；enums.json inventoryBucketRules 也把「available → reserved」绑在 B05 上；
 * E05b 已确立「确认 ≠ 付款、确认不锁库存」的先例。因此 B03 只做两件事：
 *   · 冲突预检：报价里指定的二手实物若当前不可占用，整次失败（STOCK_CONFLICT），
 *     不生成半张订单 —— 这是 B03 契约里「指定二手件冲突则整次失败」的落点；
 *   · 生成销售单与缺口清单，等 B05 在收到定金后再真正占用。
 * 预检之后到 B05 之间理论上有窗口，但真正的硬闸在 B05 的唯一索引上，预检只是友好提示。
 */
export function planConvertQuote(
  db: OperationsDb,
  ctx: OperationContext,
  quoteId: string,
  header: QuoteHeaderRow,
  version: QuoteVersionRow,
  lines: readonly ResolvedQuoteLine[],
  customerSnapshot: string,
  orderId: string,
  orderNo: string,
  dueAt: string | null,
  note: string,
  occurredAt: string,
): OperationPlan {
  const nextVersion = header.version + 1
  const discountCents = version.discount_cents
  // ⚠️ 数据库行是 snake_case（unit_price_cents），allocateDiscount 的入参是 camelCase ——
  // 直接传行对象会让折前金额算成 NaN，进而写出 NaN 的分摊额（实测就是这个症状）。
  const allocations = allocateDiscount(
    lines.map((line) => ({ position: line.position, unitPriceCents: line.unit_price_cents, qty: line.qty })),
    discountCents,
  )
  const subtotal = lines.reduce((sum, line) => sum + line.unit_price_cents * line.qty, 0)
  const total = subtotal - discountCents

  const statements: D1PreparedStatement[] = [
    guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM quote_headers WHERE store_id = ? AND id = ?)', ctx.storeId, quoteId),
    guardStatement(
      db,
      'VERSION_CONFLICT',
      'NOT EXISTS (SELECT 1 FROM quote_headers WHERE store_id = ? AND id = ? AND version = ?)',
      ctx.storeId,
      quoteId,
      header.version,
    ),
    guardStatement(
      db,
      'VALIDATION_ERROR',
      `NOT EXISTS (SELECT 1 FROM quote_versions
                   WHERE store_id = ? AND quote_id = ? AND revision = ? AND status IN ('issued', 'confirmed'))`,
      ctx.storeId,
      quoteId,
      version.revision,
    ),
    // 过期报价不能成交：先续期（重新发出）再转单，与 B42 的过期闸同一口径。
    guardStatement(
      db,
      'VALIDATION_ERROR',
      `EXISTS (SELECT 1 FROM quote_versions
               WHERE store_id = ? AND quote_id = ? AND revision = ?
                 AND valid_until IS NOT NULL AND valid_until < ?)`,
      ctx.storeId,
      quoteId,
      version.revision,
      occurredAt,
    ),
    // 同一份报价只能转一次单：重复成交会凭空多出一张要发货的单。
    guardStatement(
      db,
      'VALIDATION_ERROR',
      'EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND quote_id = ?)',
      ctx.storeId,
      quoteId,
    ),
    // 冲突预检：报价指定的二手实物必须仍可占用。找不到 / 已被占用 / 不是店有都算冲突。
    ...lines
      .filter((line) => line.stock_item_id)
      .map((line) =>
        guardStatement(
          db,
          'STOCK_CONFLICT',
          `NOT EXISTS (SELECT 1 FROM stock_items
                       WHERE store_id = ? AND id = ? AND ownership = 'store' AND availability = 'available')`,
          ctx.storeId,
          line.stock_item_id as string,
        ),
      ),

    db
      .prepare(
        `INSERT INTO sale_orders
           (id, store_id, order_no, quote_id, quote_revision, customer_id, customer_snapshot, kind,
            trade_state, fulfillment_state, due_at, configuration_version,
            subtotal_cents, discount_cents, adjustment_cents, total_cents,
            cash_net_cents, offset_net_cents, balance_cents, balance_direction,
            note, terms_snapshot, version, request_id, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'assembly',
                 'draft', 'waiting_stock', ?, 0,
                 ?, ?, 0, ?, 0, 0, ?, 'client_due', ?, ?, 1, ?, ?, ?)`,
      )
      .bind(
        orderId,
        ctx.storeId,
        orderNo,
        quoteId,
        version.revision,
        header.customer_id,
        customerSnapshot,
        dueAt,
        subtotal,
        discountCents,
        total,
        total,
        note,
        version.terms_snapshot,
        ctx.requestId,
        ctx.actorUserId,
        ctx.actorUserId,
      ),
    guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ?)', ctx.storeId, orderId),
  ]

  for (const [index, line] of lines.entries()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO sale_lines
             (id, store_id, sale_order_id, position, product_id, source, name_snapshot, spec_snapshot,
              qty, unit_price_cents, discount_allocation_cents, net_line_cents,
              warranty_snapshot, stock_item_id, customer_device_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `${ctx.requestId}::line-${line.position}`,
          ctx.storeId,
          orderId,
          line.position,
          line.product_id,
          line.source,
          line.name_snapshot,
          line.spec_snapshot ?? '',
          line.qty,
          line.unit_price_cents,
          allocations[index],
          line.unit_price_cents * line.qty - allocations[index],
          line.warranty_snapshot,
          line.stock_item_id,
          line.customer_device_ref,
        ),
    )
  }

  statements.push(
    // 报价状态置为已转单。QuoteVersion 契约规定确认字段只在 status=confirmed 时有值，
    // 因此 confirmed → converted 必须在同一条语句里清空状态专属字段；B42 的确认事实
    // 仍由幂等操作结果与版本日志追溯。否则 0012 的 CHECK 会让主流程整批回滚。
    db
      .prepare(
        `UPDATE quote_versions
         SET status = 'converted', confirmed_at = NULL, confirmed_source = NULL
         WHERE store_id = ? AND quote_id = ? AND revision = ? AND status IN ('issued', 'confirmed')`,
      )
      .bind(ctx.storeId, quoteId, version.revision),
    // 条件更新影响 0 行不报错 → 守卫确认状态真的变了（T04 的核心教训）。
    guardStatement(
      db,
      'VALIDATION_ERROR',
      `NOT EXISTS (SELECT 1 FROM quote_versions
                   WHERE store_id = ? AND quote_id = ? AND revision = ? AND status = 'converted')`,
      ctx.storeId,
      quoteId,
      version.revision,
    ),
    db
      .prepare(
        `UPDATE quote_headers SET version = ?, updated_by = ?, updated_at = datetime('now')
         WHERE store_id = ? AND id = ? AND version = ?`,
      )
      .bind(nextVersion, ctx.actorUserId, ctx.storeId, quoteId, header.version),
    assertRowVersionStatement(db, 'VERSION_CONFLICT', 'quote_headers', 'id', quoteId, nextVersion),
    bumpVersionStatement(db, ctx, 'Quote', quoteId, nextVersion),
    bumpVersionStatement(db, ctx, 'SaleOrder', orderId, 1),
  )

  return {
    statements,
    outcome: {
      entityType: 'SaleOrder',
      entityId: orderId,
      version: 1,
      summary: `由报价第 ${version.revision} 版生成销售单 ${orderNo}`,
      effects: {
        orderNo,
        quoteId,
        quoteRevision: version.revision,
        totalCents: total,
        lineCount: lines.length,
        // 缺口 = 有商品、但没有实物可占的新品行（数量件新品为主）—— 这才是「需要补货」。
        // 「没映射商品」的行已在入口被拒，不会走到这里混进缺口。
        shortageCount: lines.filter(
          (line) => line.source === 'new' && !line.stock_item_id && line.product_id !== null,
        ).length,
      },
    },
    constraintCodes: {
      'sale_orders.store_id, sale_orders.order_no': 'VALIDATION_ERROR',
      'sale_lines.sale_order_id, sale_lines.position': 'VALIDATION_ERROR',
    },
  }
}

/** B03 入口。重放保护放在业务预读之前（E05b 的教训：先查幂等，再谈业务）。 */
export async function convertQuoteToOrder(
  db: OperationsDb,
  ctx: OperationContext,
  quoteId: string,
  input: ConvertQuoteInput,
): Promise<RunResult> {
  const action = 'B03'
  const payloadHash = await hashPayload({ quoteId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  if (!Number.isInteger(input.quoteVersion) || input.quoteVersion < 1) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '必须指定要成交的报价版本号（quoteVersion）', retryable: false, httpStatus: 400 }
  }

  const header = await readQuoteHeader(db, ctx.storeId, quoteId)
  if (!header) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '报价单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  const version = await readQuoteVersion(db, ctx.storeId, quoteId, input.quoteVersion)
  if (!version) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: `报价第 ${input.quoteVersion} 版不存在`, retryable: false, httpStatus: 404 }
  }
  const termsProblem = validateCheckoutTermsSnapshot(version.terms_snapshot)
  if (termsProblem) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: termsProblem, retryable: false, httpStatus: 400 }
  }
  if (!(CONVERTIBLE_QUOTE_STATUS as readonly string[]).includes(version.status)) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: `只有已发出或顾客已确认的版本能成交，当前状态是「${version.status}」；草稿请先发出`,
      retryable: false,
      httpStatus: 400,
    }
  }
  const rawLines = await readQuoteLines(db, ctx.storeId, quoteId, input.quoteVersion)
  if (rawLines.length === 0) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '这一版没有任何配置行，无法成交', retryable: false, httpStatus: 400 }
  }
  if (rawLines.length > MAX_LINES) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: `销售行最多 ${MAX_LINES} 行`, retryable: false, httpStatus: 400 }
  }

  // 分配覆盖：允许为某一版里没指定实物的二手行补上实物（契约 B03 的 allocationChoices）。
  const overrides = new Map<number, string>()
  for (const choice of input.allocationChoices ?? []) {
    if (!Number.isInteger(choice.position)) continue
    const value = typeof choice.stockItemId === 'string' ? choice.stockItemId.trim() : ''
    if (value) overrides.set(choice.position, value)
  }
  const refOverrides = new Map<number, string>()
  for (const item of input.lineProductMap ?? []) {
    if (!Number.isInteger(item.position)) continue
    const value = typeof item.productRef === 'string' ? item.productRef.trim() : ''
    if (value) refOverrides.set(item.position, value)
  }
  const lines = rawLines.map((line) => {
    const stockOverride = overrides.get(line.position)
    const refOverride = refOverrides.get(line.position)
    if (!stockOverride && !refOverride) return line
    return {
      ...line,
      stock_item_id: stockOverride && line.source === 'used' ? stockOverride : line.stock_item_id,
      product_ref: refOverride ?? line.product_ref,
    }
  })

  const mapped = await resolveLineProducts(db, ctx.storeId, lines)

  // 契约 QuoteVersion.rules 第 1 条「成交前必须映射到商品」的落点。
  // new / used 行解析不出商品就整次失败 —— 不静默降级成「缺口」：
  // 缺口是「有商品但货不够」，不是「这单不知道卖的是什么」。两者混在一起，
  // 采购页就会拿着一条没有商品的缺口发愁（E06 实测）。
  const unmapped = mapped.filter(
    (line) => (line.source === 'new' || line.source === 'used') && line.product_id === null,
  )
  if (unmapped.length > 0) {
    const detail = unmapped
      .map((line) => {
        const at = `第 ${line.position + 1} 行「${line.name_snapshot}」`
        return line.product_ref ? `${at}关联的商品已不存在（引用 ${line.product_ref}）` : `${at}还没选商品`
      })
      .join('；')
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: `${detail}。成交前必须选好商品：在报价里选定后重新发出，或转单时指定商品引用`,
      retryable: false,
      httpStatus: 400,
    }
  }

  const customer = header.customer_id ? await readCustomer(db, ctx.storeId, header.customer_id) : null
  const customerSnapshot = JSON.stringify({
    customerId: customer?.id ?? header.customer_id ?? null,
    name: customer?.name ?? '',
    phone: customer?.phone ?? '',
    address: customer?.address ?? '',
    quoteTitle: header.title,
  })

  const now = new Date().toISOString()
  const orderId = `${ctx.requestId}::sale`
  const orderNo = orderNoFor(ctx.requestId, now)
  const dueAt = input.dueAt && !Number.isNaN(new Date(input.dueAt).getTime()) ? new Date(input.dueAt).toISOString() : null
  const note = (input.note ?? '').trim()

  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) =>
    planConvertQuote(db, context, quoteId, header, version, mapped, customerSnapshot, orderId, orderNo, dueAt, note, now),
  )
}

// ─────────────────────────────── B05 确认成交与补分配 ───────────────────────────────

export interface ReserveCandidate {
  position: number
  saleLineId: string
  stockItemId: string
  productId: number
}

interface ReserveBase {
  position: number
  saleLineId: string
  stockItemId: string
}

/**
 * 从销售行 + 分配选择推导出「这次要占用哪些实物」。
 *
 * 只有带 stock_item_id 的行参与：used 行天然带；new 行只有明确指定了实物（补分配）才算逐件占用。
 * 商品主键不在这里决定 —— 它由实物本身给出（见 reserveSaleOrder 的预读），
 * 因为报价行没有商品引用列，sale_lines.product_id 对新品行是 NULL。
 */
function reserveCandidates(
  lines: readonly SaleLineRow[],
  choices: readonly AllocationChoice[] | undefined,
): ReserveBase[] {
  const overrides = new Map<number, string>()
  for (const choice of choices ?? []) {
    const value = typeof choice.stockItemId === 'string' ? choice.stockItemId.trim() : ''
    if (Number.isInteger(choice.position) && value) overrides.set(choice.position, value)
  }
  const out: ReserveBase[] = []
  for (const line of lines) {
    const stockItemId = overrides.get(line.position) ?? line.stock_item_id
    if (!stockItemId) continue
    out.push({ position: line.position, saleLineId: line.id, stockItemId })
  }
  return out
}

/** 数量件占用候选：有商品、但没有指定具体实物的 new 行。 */
export interface QuantityCandidate {
  position: number
  saleLineId: string
  productId: number
  /** 这一行还需要锁住多少件（行数量 − 已经锁住的）。 */
  needed: number
  /** 本次能锁多少件（受可用量限制；真正写不写得进去，在 SQL 里还要再判一次）。 */
  reservable: number
}

/**
 * 数量件占用候选：有商品、但没有指定具体实物的 new 行（内存 / 硬盘 / 风扇这类按数量卖的）。
 *
 * 为什么必须补上：硬边界③「付定金即锁库存」对逐件实物由 stock_items.availability 守，
 * 而数量件没有 stock_items 行可改 —— 之前的实现里它们既不进 stock_reservations、
 * 也不动 stock_balances，于是「付了定金也锁不住」，货随时可能被别的单卖掉。
 *
 * 只对 tracking_mode = 'quantity' 的商品做：tracking_mode = 'item' 的商品没指定实物
 * 就是没指定，不能拿「数量」去占一个必须逐件指的型号（那会让「哪一台」变成一笔糊涂账）。
 *
 * 两个扣减，顺序都在这一步做完，写入时不再算计：
 *   · 已经锁住的（同一张单被反复点「确认成交」）要扣掉，否则会重复占用；
 *   · 同一商品被多行引用时按行序先后分配，后面的行只能拿剩下的。
 */
async function loadQuantityCandidates(
  db: OperationsDb,
  storeId: number,
  lines: readonly SaleLineRow[],
): Promise<QuantityCandidate[]> {
  const scoped = lines.filter((line) => line.source === 'new' && !line.stock_item_id && line.product_id !== null)
  if (scoped.length === 0) return []

  const productIds = [...new Set(scoped.map((line) => line.product_id as number))]
  const productPlaceholders = productIds.map(() => '?').join(', ')
  const stock = await db
    .prepare(
      `SELECT h.id AS product_id, h.tracking_mode, COALESCE(b.available_qty, 0) AS available_qty
       FROM hardware h
       LEFT JOIN stock_balances b
         ON b.store_id = h.store_id AND b.product_id = h.id AND b.location_id = 'store'
       WHERE h.store_id = ? AND h.id IN (${productPlaceholders})`,
    )
    .bind(storeId, ...productIds)
    .all<{ product_id: number; tracking_mode: string; available_qty: number }>()
  const meta = new Map<number, { trackingMode: string; available: number }>()
  for (const row of stock.results ?? []) {
    meta.set(row.product_id, { trackingMode: row.tracking_mode, available: Number(row.available_qty ?? 0) })
  }

  const lineIds = scoped.map((line) => line.id)
  const linePlaceholders = lineIds.map(() => '?').join(', ')
  const held = await db
    .prepare(
      `SELECT line_ref, SUM(qty) AS held FROM stock_reservations
       WHERE store_id = ? AND status = 'active' AND quantity_bucket_ref IS NOT NULL
         AND line_ref IN (${linePlaceholders})
       GROUP BY line_ref`,
    )
    .bind(storeId, ...lineIds)
    .all<{ line_ref: string; held: number }>()
  const heldByLine = new Map<string, number>()
  for (const row of held.results ?? []) heldByLine.set(row.line_ref, Number(row.held ?? 0))

  const out: QuantityCandidate[] = []
  const allocatedByProduct = new Map<number, number>()
  for (const line of scoped) {
    const productId = line.product_id as number
    const info = meta.get(productId)
    if (!info || info.trackingMode !== 'quantity') continue
    const needed = Math.max(0, line.qty - (heldByLine.get(line.id) ?? 0))
    if (needed === 0) continue
    const consumed = allocatedByProduct.get(productId) ?? 0
    const remaining = Math.max(0, info.available - consumed)
    const reservable = Math.min(needed, remaining)
    allocatedByProduct.set(productId, consumed + reservable)
    out.push({ position: line.position, saleLineId: line.id, productId, needed, reservable })
  }
  return out
}

/**
 * B05 的 plan（confirm 与 allocate 共用同一段）。
 *
 * 定金闸：已核实收款 + 有效折抵 ≥ 定金门槛。这是「未付款不预留」在代码里的落点 ——
 * 不是靠界面禁用按钮，而是靠 SQL 里的一条断言。
 *
 * 逐件占用三步（顺序有意为之）：
 *   1. INSERT stock_reservations  —— 唯一索引在这一步决定谁赢，谁输谁整批回滚；
 *   2. UPDATE stock_items.availability = 'reserved'（条件更新，只命中 available 的行）；
 *   3. 守卫确认这些实物确实都成了 reserved —— 条件更新影响 0 行不报错，没守卫就会静默半截。
 * 另写一条 available → reserved 的库存流水，由 0007 的触发器同步 stock_balances ——
 * stock_balances 的 CHECK (available_qty >= 0) 是数量型超卖的兜底。
 *
 * 数量件占用走另一条路（quantityCandidates）：不碰 stock_items，只写一条
 * available → reserved 的数量流水 + 一条带 quantity_bucket_ref 的占用记录。
 * 与逐件的关键差别在**抢不到时怎么办**：逐件实物是「那一台没了」，必须让用户知道（整批失败）；
 * 数量件同型号可替换，抢不到就是缺货，少占、剩下进缺口去采购即可，不该把整单卡住。
 */
export function planReserveOrder(
  db: OperationsDb,
  ctx: OperationContext,
  order: SaleOrderRow,
  candidates: readonly ReserveCandidate[],
  quantityCandidates: readonly QuantityCandidate[],
  markConfirmed: boolean,
  occurredAt: string,
): OperationPlan {
  const nextVersion = order.version + 1
  const required = requiredDepositCents(order.total_cents, order.terms_snapshot)
  const paid = order.cash_net_cents + order.offset_net_cents
  const statements: D1PreparedStatement[] = [
    guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ?)', ctx.storeId, order.id),
    guardStatement(
      db,
      'VERSION_CONFLICT',
      'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND version = ?)',
      ctx.storeId,
      order.id,
      order.version,
    ),
    // 零价或纯客供单需要独立审批履约流程；该流程未上线前不能借 0 元门槛预留库存。
    guardStatement(
      db,
      'VALIDATION_ERROR',
      'EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND total_cents <= 0)',
      ctx.storeId,
      order.id,
    ),
    // 未付款不预留：已核实收款 + 折抵 必须达到定金门槛。
    guardStatement(
      db,
      'VALIDATION_ERROR',
      `EXISTS (SELECT 1 FROM sale_orders
               WHERE store_id = ? AND id = ? AND cash_net_cents + offset_net_cents < ?)`,
      ctx.storeId,
      order.id,
      required,
    ),
    // 已取消 / 已关闭的单不能占用库存。
    guardStatement(
      db,
      'VALIDATION_ERROR',
      `NOT EXISTS (SELECT 1 FROM sale_orders
                   WHERE store_id = ? AND id = ? AND trade_state IN ('draft', 'confirmed'))`,
      ctx.storeId,
      order.id,
    ),
  ]

  for (const candidate of candidates) {
    statements.push(
      db
        .prepare(
          `INSERT INTO stock_reservations
             (id, store_id, stock_item_id, order_ref, line_ref, qty, status, reason, version, request_id)
           VALUES (?, ?, ?, ?, ?, 1, 'active', ?, 1, ?)`,
        )
        .bind(
          `${ctx.requestId}::rsv-${candidate.position}`,
          ctx.storeId,
          candidate.stockItemId,
          order.id,
          candidate.saleLineId,
          `销售单 ${order.order_no} 成交占用`,
          ctx.requestId,
        ),
      db
        .prepare(
          `UPDATE stock_items SET availability = 'reserved', version = version + 1, updated_at = datetime('now')
           WHERE store_id = ? AND id = ? AND availability = 'available'`,
        )
        .bind(ctx.storeId, candidate.stockItemId),
      guardStatement(
        db,
        'STOCK_CONFLICT',
        `NOT EXISTS (SELECT 1 FROM stock_items WHERE store_id = ? AND id = ? AND availability = 'reserved')`,
        ctx.storeId,
        candidate.stockItemId,
      ),
      db
        .prepare(
          `INSERT INTO inventory_movements
             (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
              source, occurred_at, actor_user_id, request_id)
           VALUES (?, ?, ?, ?, 1, 'available', 'reserved', NULL, 'reservation', ?, ?, ?)`,
        )
        .bind(
          `${ctx.requestId}::mv-${candidate.position}`,
          ctx.storeId,
          candidate.productId,
          candidate.stockItemId,
          occurredAt,
          ctx.actorUserId,
          ctx.requestId,
        ),
    )
  }

  // 数量件占用：不碰 stock_items，只走库存流水的桶转换（available → reserved），
  // 由 0007 的触发器同步 stock_balances。这是硬边界③对「按数量卖的新品」的落点。
  for (const candidate of quantityCandidates) {
    if (candidate.reservable <= 0) continue
    const movementId = `${ctx.requestId}::qmv-${candidate.position}`
    const reservationId = `${ctx.requestId}::qrsv-${candidate.position}`
    statements.push(
      // 条件化写入：可用量够才占。预读到写入之间可能已被别的单抢走（并发），
      // 那就少占、不占 —— 差额留在缺口里走采购，而不是让整单失败。
      db
        .prepare(
          `INSERT INTO inventory_movements
             (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
              source, occurred_at, actor_user_id, request_id)
           SELECT ?, ?, ?, NULL, ?, 'available', 'reserved', NULL, 'reservation', ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM stock_balances
                         WHERE store_id = ? AND product_id = ? AND location_id = 'store'
                           AND available_qty >= ?)`,
        )
        .bind(
          movementId,
          ctx.storeId,
          candidate.productId,
          candidate.reservable,
          occurredAt,
          ctx.actorUserId,
          ctx.requestId,
          ctx.storeId,
          candidate.productId,
          candidate.reservable,
        ),
      // 占用记录跟随流水：流水真的插进去了才有这一条。
      // ⚠️ 不能再用 available_qty 判一次 —— 上一条语句已经把可用量扣掉了，再判必然为假。
      db
        .prepare(
          `INSERT INTO stock_reservations
             (id, store_id, stock_item_id, quantity_bucket_ref, order_ref, line_ref, qty,
              status, reason, version, request_id)
           SELECT ?, ?, NULL, 'store', ?, ?, ?, 'active', ?, 1, ?
           WHERE EXISTS (SELECT 1 FROM inventory_movements WHERE store_id = ? AND id = ?)`,
        )
        .bind(
          reservationId,
          ctx.storeId,
          order.id,
          candidate.saleLineId,
          candidate.reservable,
          `销售单 ${order.order_no} 数量件占用`,
          ctx.requestId,
          ctx.storeId,
          movementId,
        ),
    )
  }

  statements.push(
    db
      .prepare(
        `UPDATE sale_orders
         SET trade_state = CASE WHEN ? = 1 THEN 'confirmed' ELSE trade_state END,
             version = ?, updated_by = ?, updated_at = datetime('now')
         WHERE store_id = ? AND id = ? AND version = ?`,
      )
      .bind(markConfirmed ? 1 : 0, nextVersion, ctx.actorUserId, ctx.storeId, order.id, order.version),
    assertRowVersionStatement(db, 'VERSION_CONFLICT', 'sale_orders', 'id', order.id, nextVersion),
    guardStatement(
      db,
      'VALIDATION_ERROR',
      `NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ?
                   AND (? = 0 OR trade_state = 'confirmed'))`,
      ctx.storeId,
      order.id,
      markConfirmed ? 1 : 0,
    ),
    bumpVersionStatement(db, ctx, 'SaleOrder', order.id, nextVersion),
  )

  // 说清「占了几件实物 + 锁了几件数量库存」：数量件锁不满是常态（货不够就先补货），
  // 只报一个数会让人以为全锁上了。
  const reservedQtyTotal = quantityCandidates.reduce(
    (sum, candidate) => sum + Math.max(0, candidate.reservable),
    0,
  )
  const occupied =
    [
      candidates.length > 0 ? `${candidates.length} 件实物` : '',
      reservedQtyTotal > 0 ? `${reservedQtyTotal} 件数量库存` : '',
    ]
      .filter(Boolean)
      .join('、') || '0 件库存'

  return {
    statements,
    outcome: {
      entityType: 'SaleOrder',
      entityId: order.id,
      version: nextVersion,
      summary: markConfirmed
        ? `确认成交 ${order.order_no}，占用 ${occupied}`
        : `为 ${order.order_no} 补占用 ${occupied}`,
      effects: {
        orderNo: order.order_no,
        tradeState: markConfirmed ? 'confirmed' : order.trade_state,
        reservedCount: candidates.length,
        reservedQty: reservedQtyTotal,
        requiredDepositCents: required,
        paidCents: paid,
      },
    },
    constraintCodes: {
      'stock_reservations.stock_item_id': 'STOCK_CONFLICT',
      // 数量型超卖的兜底：available → reserved 的流水触发 stock_balances 更新，
      // 余额不足时 CHECK (available_qty >= 0) 失败。D1 报的片段是列名与条件本身。
      'available_qty >= 0': 'STOCK_CONFLICT',
      'inventory_movements.to_bucket': 'VALIDATION_ERROR',
    },
  }
}

/** B05 入口（confirm 与 allocate 共用）。 */
export async function reserveSaleOrder(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: ConfirmOrderInput,
  markConfirmed: boolean,
): Promise<RunResult> {
  const action = 'B05'
  const payloadHash = await hashPayload({ orderId, markConfirmed, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const order = await readOrder(db, ctx.storeId, orderId)
  if (!order) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '销售单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  if (order.total_cents <= 0) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: '零价或纯客供订单的特殊履约流程尚未开放，当前不能确认成交或预留库存',
      retryable: false,
      httpStatus: 400,
    }
  }
  if (!['draft', 'confirmed'].includes(order.trade_state)) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: `已${order.trade_state === 'cancelled' ? '取消' : '关闭'}的销售单不能再占用库存`,
      retryable: false,
      httpStatus: 400,
    }
  }
  if (markConfirmed && order.trade_state !== 'draft') {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: `只有草稿销售单能确认成交，当前状态是「${order.trade_state}」`,
      retryable: false,
      httpStatus: 400,
    }
  }

  const lines = await readSaleLines(db, ctx.storeId, orderId)
  const bases = reserveCandidates(lines, input.allocationChoices)

  // 逐件确认它们都属于本店且当前可取，并用实物给出的商品主键组装占用候选 ——
  // 与 plan 里的 SQL 守卫同一口径，但提前一步给出人话，避免用户只看到「库存冲突」四个字。
  const items = bases.length > 0 ? await readStockItems(db, ctx.storeId, bases.map((base) => base.stockItemId)) : new Map()
  const candidates: ReserveCandidate[] = []
  for (const base of bases) {
    const item = items.get(base.stockItemId)
    if (!item || item.ownership !== 'store') {
      return {
        ok: false,
        requestId: ctx.requestId,
        code: 'OWNERSHIP_INVALID',
        message: `实物 ${base.stockItemId} 不存在、不属于本店，或已被客人带走，无法占用`,
        retryable: false,
        httpStatus: 422,
      }
    }
    if (item.availability !== 'available') {
      return {
        ok: false,
        requestId: ctx.requestId,
        code: 'STOCK_CONFLICT',
        message: `实物 ${base.stockItemId} 当前不是可取状态（${item.availability}），可能已被别的订单占用；请换件或取消该行`,
        retryable: false,
        httpStatus: 409,
      }
    }
    candidates.push({ ...base, productId: item.product_id })
  }

  // 数量件：有商品、但没有实物可指的新品行（逐件的那些上面已经逐件查过了）。
  const quantityCandidates = await loadQuantityCandidates(db, ctx.storeId, lines)

  const now = new Date().toISOString()
  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) =>
    planReserveOrder(db, context, order, candidates, quantityCandidates, markConfirmed, now),
  )
}

// ─────────────────────────────── B08 登记销售收款 ───────────────────────────────

/**
 * B08 的 plan。
 *
 * 不超收（money-rules.json collectableCents：max(余额, 0)）写成断言守卫并带 BALANCE_EXCEEDED。
 * 刻意不写成表级 CHECK：契约允许 balanceDirection = store_due（门店待退），
 * 用 CHECK 一刀切会把那个枚举值变成永远不可达的死值。
 */
export function planRegisterSalePayment(
  db: OperationsDb,
  ctx: OperationContext,
  order: SaleOrderRow,
  input: SalePaymentInput,
  entryId: string,
  occurredAt: string,
  verificationState: 'unverified' | 'verified',
): OperationPlan {
  const nextVersion = order.version + 1
  const amount = input.amountCents
  // 未核实流水只保留待核对事实，不冲减应收，也不参与预付款预留门槛。
  const cashDelta = verificationState === 'verified' ? amount : 0
  const nextCashNet = order.cash_net_cents + cashDelta
  const nextBalance = order.total_cents - order.return_credit_cents - nextCashNet - order.offset_net_cents
  const nextDirection = balanceDirectionFor(nextBalance)

  const statements: D1PreparedStatement[] = [
    guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ?)', ctx.storeId, order.id),
    guardStatement(
      db,
      'VERSION_CONFLICT',
      'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND version = ?)',
      ctx.storeId,
      order.id,
      order.version,
    ),
    // 超收：可收上限 = max(余额, 0)。多收的钱不属于这张单，也不是「客户预付余额」。
    guardStatement(
      db,
      'BALANCE_EXCEEDED',
      `EXISTS (SELECT 1 FROM sale_orders
               WHERE store_id = ? AND id = ?
                 AND ? > max(total_cents - return_credit_cents - cash_net_cents - offset_net_cents, 0))`,
      ctx.storeId,
      order.id,
      amount,
    ),
    // 已取消的单不收钱。
    guardStatement(
      db,
      'VALIDATION_ERROR',
      `NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND trade_state <> 'cancelled')`,
      ctx.storeId,
      order.id,
    ),
    db
      .prepare(
        `INSERT INTO cash_entries
           (id, store_id, direction, amount_cents, method, verification_state, verified_at,
            counterparty_kind, counterparty_ref, purpose, allocation_type, allocation_id,
            sale_order_id, occurred_at, remark, reversal_of, version, request_id, created_by)
         VALUES (?, ?, 'in', ?, ?, ?, ?, 'customer', ?, 'sale_order', 'sale_order', ?, ?, ?, ?, NULL, 1, ?, ?)`,
      )
      .bind(
        entryId,
        ctx.storeId,
        amount,
        input.method,
        verificationState,
        verificationState === 'verified' ? occurredAt : null,
        order.customer_id === null ? null : String(order.customer_id),
        order.id,
        order.id,
        occurredAt,
        (input.remark ?? '').trim(),
        ctx.requestId,
        ctx.actorUserId,
      ),
    db
      .prepare(
        `UPDATE sale_orders
         SET cash_net_cents = ?, balance_cents = ?, balance_direction = ?,
             version = ?, updated_by = ?, updated_at = datetime('now')
         WHERE store_id = ? AND id = ? AND version = ?`,
      )
      .bind(nextCashNet, nextBalance, nextDirection, nextVersion, ctx.actorUserId, ctx.storeId, order.id, order.version),
    assertRowVersionStatement(db, 'VERSION_CONFLICT', 'sale_orders', 'id', order.id, nextVersion),
    // 恒等式在表级 CHECK 也有一份；这里再断言一次是为了让失败落在具体错误码上。
    guardStatement(
      db,
      'VALIDATION_ERROR',
      'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND balance_cents = ?)',
      ctx.storeId,
      order.id,
      nextBalance,
    ),
    bumpVersionStatement(db, ctx, 'SaleOrder', order.id, nextVersion),
  ]

  return {
    statements,
    outcome: {
      entityType: 'SaleOrder',
      entityId: order.id,
      version: nextVersion,
      summary: verificationState === 'verified'
        ? `登记已核实收款 ${(amount / 100).toFixed(2)} 元（${input.method}）`
        : `记录待核实收款 ${(amount / 100).toFixed(2)} 元（${input.method}，未计入已收）`,
      effects: {
        orderNo: order.order_no,
        cashEntryId: entryId,
        cashNetCents: nextCashNet,
        balanceCents: nextBalance,
        balanceDirection: nextDirection,
      },
    },
    constraintCodes: {
      'cash_entries.sale_order_id': 'ENTITY_NOT_FOUND',
    },
  }
}

/** B08 入口。 */
export async function registerSalePayment(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: SalePaymentInput,
): Promise<RunResult> {
  const action = 'B08'
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '收款金额必须是正整数分', retryable: false, httpStatus: 400 }
  }
  if (!(CASH_METHODS as readonly string[]).includes(input.method)) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '收款方式只能是 cash / wechat / alipay / bank / other', retryable: false, httpStatus: 400 }
  }

  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const order = await readOrder(db, ctx.storeId, orderId)
  if (!order) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '销售单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }

  const occurredAt = input.occurredAt && !Number.isNaN(new Date(input.occurredAt).getTime())
    ? new Date(input.occurredAt).toISOString()
    : new Date().toISOString()
  const verificationState = input.verificationState === 'verified' ? 'verified' : 'unverified'
  const entryId = `${ctx.requestId}::cash`

  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) =>
    planRegisterSalePayment(db, context, order, input, entryId, occurredAt, verificationState),
  )
}

// ─────────────────────────────── 读模型 ───────────────────────────────

export interface SaleOrderListRow {
  id: string
  orderNo: string
  customerName: string
  kind: string
  tradeState: string
  fulfillmentState: string
  totalCents: number
  cashNetCents: number
  balanceCents: number
  balanceDirection: string
  isFullyPaid: boolean
  quoteId: string | null
  quoteRevision: number | null
  lineCount: number
  reservedCount: number
  shortageCount: number
  dueAt: string | null
  createdAt: string
  updatedAt: string
}

export interface SaleOrderListResult {
  orders: SaleOrderListRow[]
  totals: {
    all: number
    draft: number
    confirmed: number
    awaitingPayment: number
    receivableCents: number
  }
  settings: { depositPercent: number }
}

export interface SaleOrderListFilter {
  tradeState?: string | null
  q?: string | null
  limit?: number | null
}

interface SaleOrderListRaw extends SaleOrderRow {
  line_count: number
  reserved_count: number
  shortage_count: number
}

function customerNameFrom(snapshot: string): string {
  try {
    const parsed = JSON.parse(snapshot) as Record<string, unknown>
    const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
    if (name) return name
    const phone = typeof parsed.phone === 'string' ? parsed.phone.trim() : ''
    return phone ? `散客 ${phone}` : '未填写客户'
  } catch {
    return '未填写客户'
  }
}

/** 销售单列表。默认按创建时间倒序；tradeState 只接受契约枚举值。 */
export async function querySaleOrders(
  db: OperationsDb,
  storeId: number,
  filter: SaleOrderListFilter = {},
): Promise<SaleOrderListResult> {
  const limit = Number.isInteger(filter.limit) && (filter.limit as number) > 0 ? Math.min(filter.limit as number, 200) : 50
  const conditions: string[] = ['o.store_id = ?']
  const params: (string | number)[] = [storeId]

  if (filter.tradeState) {
    conditions.push('o.trade_state = ?')
    params.push(filter.tradeState)
  }
  const q = filter.q?.trim()
  if (q) {
    conditions.push('(o.order_no LIKE ? OR o.customer_snapshot LIKE ?)')
    params.push(`%${q}%`, `%${q}%`)
  }

  const result = await db
    .prepare(
      `SELECT o.id, o.order_no, o.quote_id, o.quote_revision, o.customer_id, o.customer_snapshot,
              o.kind, o.trade_state, o.fulfillment_state, o.due_at, o.configuration_version,
              o.subtotal_cents, o.discount_cents, o.adjustment_cents, o.total_cents,
              o.cash_net_cents, o.offset_net_cents, o.balance_cents, o.balance_direction,
              o.note, o.terms_snapshot, o.version, o.created_at, o.updated_at,
              (SELECT COUNT(*) FROM sale_lines l WHERE l.sale_order_id = o.id) AS line_count,
              (SELECT COUNT(*) FROM stock_reservations r WHERE r.order_ref = o.id AND r.status = 'active') AS reserved_count,
              (SELECT COUNT(*) FROM sale_lines l
                WHERE l.sale_order_id = o.id AND l.source = 'new' AND l.stock_item_id IS NULL
                  AND l.qty > COALESCE((SELECT SUM(r.qty) FROM stock_reservations r
                                        WHERE r.store_id = o.store_id AND r.line_ref = l.id
                                          AND r.status = 'active'
                                          AND r.quantity_bucket_ref IS NOT NULL), 0)) AS shortage_count
       FROM sale_orders o
       WHERE ${conditions.join(' AND ')}
       ORDER BY o.created_at DESC
       LIMIT ?`,
    )
    .bind(...params, limit)
    .all<SaleOrderListRaw>()

  const orders: SaleOrderListRow[] = (result.results ?? []).map((row) => ({
    id: row.id,
    orderNo: row.order_no,
    customerName: customerNameFrom(row.customer_snapshot),
    kind: row.kind,
    tradeState: row.trade_state,
    fulfillmentState: row.fulfillment_state,
    totalCents: row.total_cents,
    cashNetCents: row.cash_net_cents,
    balanceCents: row.balance_cents,
    balanceDirection: row.balance_direction,
    isFullyPaid: row.total_cents > 0 && row.balance_cents <= 0,
    quoteId: row.quote_id,
    quoteRevision: row.quote_revision,
    lineCount: row.line_count,
    reservedCount: row.reserved_count,
    shortageCount: row.shortage_count,
    dueAt: row.due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))

  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS all_count,
              SUM(CASE WHEN trade_state = 'draft' THEN 1 ELSE 0 END) AS draft_count,
              SUM(CASE WHEN trade_state = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_count,
              SUM(CASE WHEN balance_cents > 0 THEN 1 ELSE 0 END) AS awaiting_payment,
              SUM(CASE WHEN balance_cents > 0 THEN balance_cents ELSE 0 END) AS receivable
       FROM sale_orders WHERE store_id = ?`,
    )
    .bind(storeId)
    .first<Record<string, number | null>>()

  return {
    orders,
    totals: {
      all: Number(totals?.all_count ?? 0),
      draft: Number(totals?.draft_count ?? 0),
      confirmed: Number(totals?.confirmed_count ?? 0),
      awaitingPayment: Number(totals?.awaiting_payment ?? 0),
      receivableCents: Number(totals?.receivable ?? 0),
    },
    settings: { depositPercent: QUOTE_SETTINGS.depositPercent },
  }
}

export interface SaleOrderDetailLine {
  id: string
  position: number
  source: string
  nameSnapshot: string
  specSnapshot: string
  qty: number
  unitPriceCents: number
  discountAllocationCents: number
  netLineCents: number
  warrantySnapshot: CustomerWarrantySnapshot | null
  stockItemId: string | null
  /** 这一件实物当前是否已被占用 / 取不到时为 missing。 */
  stockItemAvailability: string | null
  stockItemAssetCode: string | null
  customerDeviceRef: string | null
}

export interface SaleOrderPaymentRow {
  id: string
  amountCents: number
  method: string
  verificationState: string
  occurredAt: string
  remark: string
}

export interface SaleReturnRow {
  id: string
  creditCents: number
  creditState: string
  acceptedQty: number
  reason: string
  createdAt: string
  approvedAt: string | null
}

export interface SaleOrderDetail {
  order: {
    id: string
    orderNo: string
    customerName: string
    customerPhone: string
    kind: string
    tradeState: string
    fulfillmentState: string
    dueAt: string | null
    totalCents: number
    subtotalCents: number
    discountCents: number
    adjustmentCents: number
    cashNetCents: number
    offsetNetCents: number
    /** 累计已批准退货贷项（B43 批准时增加；B11 取消时置为总额）。 */
    returnCreditCents: number
    balanceCents: number
    balanceDirection: string
    /** 是否已结清（总额 > 0 且余额 ≤ 0）。界面用「已结清」而不是显示负尾款。 */
    isFullyPaid: boolean
    requiredDepositCents: number
    version: number
    note: string
    createdAt: string
    updatedAt: string
  }
  quote: { id: string; revision: number } | null
  /** 顾客保修政策的订单快照；旧单未存该快照时为 null。 */
  warrantyPolicyLines: string[] | null
  lines: SaleOrderDetailLine[]
  payments: SaleOrderPaymentRow[]
  reservations: {
    id: string
    stockItemId: string | null
    /** 占用归属的销售行。数量件占用要靠它把「锁了多少」算回行上。 */
    lineRef: string
    /** 数量件占用时有值（当前为 'store'）；逐件占用为 null。 */
    quantityBucketRef: string | null
    qty: number
    status: string
    createdAt: string
  }[]
  /**
   * 缺口：还需要补货的部分 = 行数量 − 已经锁住的数量。
   * 只含 new 行 —— used 行成交前必须指实物，客供件与服务行不进库存。
   * 未付款时一件未锁，缺口即全部数量（没付定金就没锁货，界面照实说）。
   */
  shortage: {
    lineId: string
    position: number
    nameSnapshot: string
    qty: number
    reservedQty: number
    shortageQty: number
  }[]
  /** 退货单列表（B17 登记，B43 批准后 creditState=approved）。用于批准贷项与退款。 */
  returns: SaleReturnRow[]
}

export async function querySaleOrderDetail(
  db: OperationsDb,
  storeId: number,
  orderId: string,
): Promise<SaleOrderDetail | null> {
  const row = await readOrder(db, storeId, orderId)
  if (!row) return null

  const lines = await readSaleLines(db, storeId, orderId)
  const stockIds = lines.map((line) => line.stock_item_id).filter((value): value is string => Boolean(value))
  const items = await readStockItems(db, storeId, stockIds)
  const assetCodes = new Map<string, string>()
  if (stockIds.length > 0) {
    const placeholders = stockIds.map(() => '?').join(', ')
    const rows = await db
      .prepare(`SELECT id, asset_code FROM stock_items WHERE store_id = ? AND id IN (${placeholders})`)
      .bind(storeId, ...stockIds)
      .all<{ id: string; asset_code: string }>()
    for (const item of rows.results ?? []) assetCodes.set(item.id, item.asset_code)
  }

  const reservationRows = await db
    .prepare(
      `SELECT id, stock_item_id, quantity_bucket_ref, line_ref, qty, status, created_at
       FROM stock_reservations
       WHERE store_id = ? AND order_ref = ? ORDER BY created_at DESC`,
    )
    .bind(storeId, orderId)
    .all<{
      id: string
      stock_item_id: string | null
      quantity_bucket_ref: string | null
      line_ref: string
      qty: number
      status: string
      created_at: string
    }>()
  // 每一行已经锁住多少件（只算数量件占用）。缺口必须扣掉它 ——
  // 否则界面会说「缺 2 件」，而这行其实已经锁住 1 件、只缺 1 件，采购会买多。
  const reservedByLine = new Map<string, number>()
  for (const row of reservationRows.results ?? []) {
    if (row.status !== 'active' || !row.quantity_bucket_ref) continue
    reservedByLine.set(row.line_ref, (reservedByLine.get(row.line_ref) ?? 0) + Number(row.qty ?? 0))
  }

  const paymentRows = await db
    .prepare(
      `SELECT id, amount_cents, method, verification_state, occurred_at, remark
       FROM cash_entries WHERE store_id = ? AND sale_order_id = ? ORDER BY occurred_at DESC`,
    )
    .bind(storeId, orderId)
    .all<{ id: string; amount_cents: number; method: string; verification_state: string; occurred_at: string; remark: string }>()

  const returnRows = await db
    .prepare(
      `SELECT id, credit_cents, credit_state, accepted_qty, reason, created_at, approved_at
       FROM sale_returns WHERE store_id = ? AND sale_order_id = ? ORDER BY created_at DESC`,
    )
    .bind(storeId, orderId)
    .all<{ id: string; credit_cents: number; credit_state: string; accepted_qty: number; reason: string; created_at: string; approved_at: string | null }>()

  const customer = { name: '', phone: '' }
  try {
    const parsed = JSON.parse(row.customer_snapshot) as Record<string, unknown>
    customer.name = typeof parsed.name === 'string' ? parsed.name : ''
    customer.phone = typeof parsed.phone === 'string' ? parsed.phone : ''
  } catch {
    // 快照坏了不影响读单：显示空值，不编造客户名。
  }

  return {
    order: {
      id: row.id,
      orderNo: row.order_no,
      customerName: customer.name,
      customerPhone: customer.phone,
      kind: row.kind,
      tradeState: row.trade_state,
      fulfillmentState: row.fulfillment_state,
      dueAt: row.due_at,
      totalCents: row.total_cents,
      subtotalCents: row.subtotal_cents,
      discountCents: row.discount_cents,
      adjustmentCents: row.adjustment_cents,
      cashNetCents: row.cash_net_cents,
      offsetNetCents: row.offset_net_cents,
      returnCreditCents: row.return_credit_cents,
      balanceCents: row.balance_cents,
      balanceDirection: row.balance_direction,
      isFullyPaid: row.total_cents > 0 && row.balance_cents <= 0,
      requiredDepositCents: requiredDepositCents(row.total_cents, row.terms_snapshot),
      version: row.version,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    quote: row.quote_id ? { id: row.quote_id, revision: row.quote_revision ?? 0 } : null,
    warrantyPolicyLines: warrantyPolicyFromTermsSnapshot(row.terms_snapshot),
    lines: lines.map((line) => ({
      id: line.id,
      position: line.position,
      source: line.source,
      nameSnapshot: line.name_snapshot,
      specSnapshot: line.spec_snapshot ?? '',
      qty: line.qty,
      unitPriceCents: line.unit_price_cents,
      discountAllocationCents: line.discount_allocation_cents,
      netLineCents: line.net_line_cents,
      warrantySnapshot: safeCustomerWarrantySnapshot(line.warranty_snapshot),
      stockItemId: line.stock_item_id,
      stockItemAvailability: line.stock_item_id ? items.get(line.stock_item_id)?.availability ?? 'missing' : null,
      stockItemAssetCode: line.stock_item_id ? assetCodes.get(line.stock_item_id) ?? null : null,
      customerDeviceRef: line.customer_device_ref,
    })),
    payments: (paymentRows.results ?? []).map((payment) => ({
      id: payment.id,
      amountCents: payment.amount_cents,
      method: payment.method,
      verificationState: payment.verification_state,
      occurredAt: payment.occurred_at,
      remark: payment.remark,
    })),
    reservations: (reservationRows.results ?? []).map((reservation) => ({
      id: reservation.id,
      stockItemId: reservation.stock_item_id,
      lineRef: reservation.line_ref,
      quantityBucketRef: reservation.quantity_bucket_ref,
      qty: reservation.qty,
      status: reservation.status,
      createdAt: reservation.created_at,
    })),
    // 缺口 = 还需要补货的部分：行数量 − 这行已经锁住的数量。
    // 未付款时一件都没锁，缺口就是全部数量 —— 那是对的：没付定金就没锁货，
    // 仓里的随时可能被别的单卖掉，界面必须照实说，不能用「已占用」让它显得稳当。
    shortage: lines
      .filter((line) => line.source === 'new' && !line.stock_item_id)
      .map((line) => {
        const reservedQty = reservedByLine.get(line.id) ?? 0
        return {
          lineId: line.id,
          position: line.position,
          nameSnapshot: line.name_snapshot,
          qty: line.qty,
          reservedQty,
          shortageQty: Math.max(0, line.qty - reservedQty),
        }
      })
      .filter((item) => item.shortageQty > 0),
    returns: (returnRows.results ?? []).map((ret) => ({
      id: ret.id,
      creditCents: ret.credit_cents,
      creditState: ret.credit_state,
      acceptedQty: ret.accepted_qty,
      reason: ret.reason,
      createdAt: ret.created_at,
      approvedAt: ret.approved_at,
    })),
  }
}

// ─────────────────────────────── E09 · 取消 / 退货 / 退款 / 欠款交付 ───────────────────────────────
//
// 契约依据（contracts/v1）：
//   actions.json  B09  批准欠款交付 /sales/orders/:id/credit-approval（sales/order-credit-approval，owner_only）
//                 B11  取消销售单  /sales/orders/:id/cancel（sales/order-edit）
//                 B17  登记退货    /sales/returns（sales/return-create）
//                 B43  批准退货贷项 /sales/returns/:id/approve-credit（sales/refund，owner_only）
//                 B18  登记现金退款 /sales/orders/:id/refunds（sales/refund，owner_only）
//   objects.json  ReturnRecord / Refund
//   enums.json    CreditState（pending / approved）/ FinancialDisposition
//   money-rules.json refundableCashCents / partialReturn / reversalPolicy
//
// ── 余额模型扩展（0017 重建 sale_orders 后）──
//   balance = total - return_credit - cash_net - offset
//   · return_credit_cents —— 累计已批准退货贷项（B43 批准时增加；B11 取消时置为 total_cents
//     全额冲销应计，让已收的钱变成「门店待退」）；
//   · cash_net_cents      —— 净收现金（B08 加、B18 减）。
//
// ── 四条硬边界在这份代码里的落点 ──
// 1.「取消不自动退钱」：B11 只释放占用 + 把已收转为应退（return_credit 全额冲销），
//    不写任何 out 现金流。退多少走 B18 由人填，系统只卡累计不超上限（R19）。
// 2.「退货贷项老板审批才生效」：B17 登记的贷项 credit_state = pending，不计入应退；
//    B43 批准转 approved 才 return_credit += creditCents，B18 只能对 approved 贷项退款。
// 3.「退货收货不自动可卖」：B17 的实物写 sold → quarantine 流水（source=return_receipt），
//    由 0007 触发器同步 stock_balances 的 quarantine_qty，绝不回流 available。
// 4.「退款上限」：B18 的 refundable = min(-balance, cash_net)，超退由 BALANCE_EXCEEDED 拒绝。

export const CREDIT_STATES = ['pending', 'approved'] as const
export type CreditState = (typeof CREDIT_STATES)[number]

// ─────────────────────────────── 入参 ───────────────────────────────

export interface CreditApprovalInput {
  /** 到期日：仅作提醒线索，系统不据此自动扣款或自动取消（03 §8）。 */
  dueDate: string
  reason: string
}

export interface CancelOrderInput {
  reason: string
}

export interface ReturnLineAllocation {
  position: number
  qty: number
}

export interface RegisterReturnInput {
  originalOrderId: string
  lineAllocations: ReturnLineAllocation[]
  stockItemIds: string[]
  reason: string
  acceptedQty: number
  creditCents: number
}

export interface ApproveReturnCreditInput {
  reason?: string | null
}

export interface RefundInput {
  amountCents: number
  method: CashMethod
  occurredAt?: string | null
  returnRef?: string | null
  adjustmentRef?: string | null
  reason: string
}

// ─────────────────────────────── 读辅助 ───────────────────────────────

interface ReturnRow {
  id: string
  sale_order_id: string
  credit_cents: number
  credit_state: string
  version: number
}

async function readReturn(db: OperationsDb, storeId: number, returnId: string): Promise<ReturnRow | null> {
  const row = await db
    .prepare(`SELECT id, sale_order_id, credit_cents, credit_state, version FROM sale_returns WHERE store_id = ? AND id = ?`)
    .bind(storeId, returnId)
    .first<ReturnRow>()
  return row ?? null
}

// ─────────────────────────────── B09 批准欠款交付 ───────────────────────────────

/** B09 入口：记录老板批准的当时欠款余额 + 到期日 + 原因。不改订单余额，交付时由 B10 校验。 */
export async function approveCreditDelivery(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: CreditApprovalInput,
): Promise<RunResult> {
  const action = 'B09'
  const dueDate = (input.dueDate ?? '').trim()
  if (!dueDate) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '欠款交付必须给到期日', retryable: false, httpStatus: 400 }
  }
  const reason = (input.reason ?? '').trim()
  if (!reason) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '欠款交付必须写明原因', retryable: false, httpStatus: 400 }
  }

  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const order = await readOrder(db, ctx.storeId, orderId)
  if (!order) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '销售单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  if (order.trade_state !== 'confirmed') {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: `只有已成交的单能批准欠款交付，这张单目前是「${order.trade_state}」`, retryable: false, httpStatus: 400 }
  }
  if (order.balance_cents <= 0) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '这张单已经结清，不需要欠款批准', retryable: false, httpStatus: 400 }
  }

  const approvalId = `${ctx.requestId}::credit`
  const now = new Date().toISOString()
  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements: D1PreparedStatement[] = [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ?)', context.storeId, order.id),
      // 服务端复算：批准时余额必须仍为正（欠款才有意义），且未被取消。
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `NOT EXISTS (SELECT 1 FROM sale_orders
                     WHERE store_id = ? AND id = ? AND trade_state = 'confirmed' AND balance_cents > 0)`,
        context.storeId,
        order.id,
      ),
      db
        .prepare(
          `INSERT INTO sale_credit_approvals
             (id, store_id, sale_order_id, balance_cents, due_date, reason, approved_by, version, request_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .bind(approvalId, context.storeId, order.id, order.balance_cents, dueDate, reason, context.actorUserId, context.requestId),
      guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM sale_credit_approvals WHERE store_id = ? AND id = ?)', context.storeId, approvalId),
      db
        .prepare(
          `INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details)
           VALUES (?, ?, 'B09.credit-approval', 'SaleOrder', ?, ?)`,
        )
        .bind(
          context.storeId,
          context.actorUserId,
          order.id,
          JSON.stringify({ creditApprovalId: approvalId, balanceCents: order.balance_cents, dueDate, reason, at: now }),
        ),
    ]
    return {
      statements,
      outcome: {
        entityType: 'SaleOrder',
        entityId: order.id,
        version: order.version,
        summary: `批准欠款交付 ${order.order_no}，欠款 ${(order.balance_cents / 100).toFixed(2)} 元（到期 ${dueDate}）`,
        effects: {
          creditApprovalId: approvalId,
          balanceCents: order.balance_cents,
          dueDate,
        },
      },
    }
  })
}

// ─────────────────────────────── B11 取消销售单 ───────────────────────────────

/**
 * B11 入口：释放占用（逐件 + 数量件都回 available），把已收转为应退。
 * 不写任何 out 现金流 —— 退多少走 B18 由人填，系统只卡累计不超上限（R19）。
 */
export async function cancelSaleOrder(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: CancelOrderInput,
): Promise<RunResult> {
  const action = 'B11'
  const reason = (input.reason ?? '').trim()
  if (!reason) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '取消销售单必须写明原因', retryable: false, httpStatus: 400 }
  }

  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const order = await readOrder(db, ctx.storeId, orderId)
  if (!order) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '销售单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  if (order.trade_state === 'cancelled') {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '这张单已经取消过', retryable: false, httpStatus: 400 }
  }
  if (order.trade_state === 'closed') {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '已关闭的销售单不能再取消', retryable: false, httpStatus: 400 }
  }
  if (order.fulfillment_state === 'delivered') {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '已交付的订单不能取消，请走退货', retryable: false, httpStatus: 400 }
  }
  if (order.offset_net_cents > 0) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '取消销售单前请先撤销关联的置换折抵，再按实际收退款处理', retryable: false, httpStatus: 400 }
  }

  const nextVersion = order.version + 1
  // return_credit 全额冲销应计：balance = total - total - cash_net - offset = -cash_net - offset。
  const nextReturnCredit = order.total_cents
  const nextBalance = -order.cash_net_cents - order.offset_net_cents
  const nextDirection = balanceDirectionFor(nextBalance)
  const now = new Date().toISOString()

  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements: D1PreparedStatement[] = [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ?)', context.storeId, order.id),
      guardStatement(
        db,
        'VERSION_CONFLICT',
        'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND version = ?)',
        context.storeId,
        order.id,
        order.version,
      ),
      // 只能取消草稿或已成交的单；已交付/已取消/已关闭都在这里被拦（enums.json draft/confirmed → cancelled）。
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `NOT EXISTS (SELECT 1 FROM sale_orders
                     WHERE store_id = ? AND id = ? AND trade_state IN ('draft', 'confirmed'))`,
        context.storeId,
        order.id,
      ),
      // 先撤销非现金折抵再取消；否则 B11 会把 offset 留在「门店待退」余额里，无法走现金退款结清。
      guardStatement(
        db,
        'VALIDATION_ERROR',
        'EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND offset_net_cents > 0)',
        context.storeId,
        order.id,
      ),
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND fulfillment_state = 'delivered')`,
        context.storeId,
        order.id,
      ),
      // 释放占用（逐件 + 数量件都回 available；取消没有「坏件隔离」，全部回流）。
      db
        .prepare(
          `UPDATE stock_reservations SET status = 'released', closed_at = ?, version = version + 1
           WHERE store_id = ? AND order_ref = ? AND status = 'active'`,
        )
        .bind(now, context.storeId, order.id),
      // 逐件：reserved → available（条件式，只在仍 reserved 时生效）。
      db
        .prepare(
          `INSERT INTO inventory_movements
             (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
              source, occurred_at, actor_user_id, request_id)
           SELECT ?, si.store_id, si.product_id, si.id, 1, 'reserved', 'available', NULL,
                  'unreservation', ?, ?, ?
           FROM stock_items si
           WHERE si.store_id = ? AND si.availability = 'reserved' AND si.id IN (
             SELECT stock_item_id FROM stock_reservations
             WHERE store_id = ? AND order_ref = ? AND status = 'released' AND closed_at = ?
               AND stock_item_id IS NOT NULL)`,
        )
        .bind(
          `${context.requestId}::cancel-mv`,
          now,
          context.actorUserId,
          context.requestId,
          context.storeId,
          context.storeId,
          order.id,
          now,
        ),
      db
        .prepare(
          `UPDATE stock_items SET availability = 'available', version = version + 1, updated_at = ?
           WHERE store_id = ? AND availability = 'reserved' AND id IN (
             SELECT stock_item_id FROM stock_reservations
             WHERE store_id = ? AND order_ref = ? AND status = 'released' AND closed_at = ?
               AND stock_item_id IS NOT NULL)`,
        )
        .bind(now, context.storeId, context.storeId, order.id, now),
      guardStatement(
        db,
        'STOCK_CONFLICT',
        `EXISTS (SELECT 1 FROM stock_reservations r JOIN stock_items si ON si.id = r.stock_item_id
                 WHERE r.store_id = ? AND r.order_ref = ? AND r.status = 'released' AND r.closed_at = ?
                   AND r.stock_item_id IS NOT NULL AND si.availability = 'reserved')`,
        context.storeId,
        order.id,
        now,
      ),
      // 数量件：reserved → available（按商品汇总；没有数量件占用时 SELECT 0 行，无副作用）。
      db
        .prepare(
          `INSERT INTO inventory_movements
             (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
              source, occurred_at, actor_user_id, request_id)
           SELECT ?, r.store_id, l.product_id, NULL, SUM(r.qty), 'reserved', 'available', NULL,
                  'unreservation', ?, ?, ?
           FROM stock_reservations r
             JOIN sale_lines l ON l.store_id = r.store_id AND l.id = r.line_ref
           WHERE r.store_id = ? AND r.order_ref = ? AND r.status = 'released' AND r.closed_at = ?
             AND r.quantity_bucket_ref IS NOT NULL
           GROUP BY l.product_id`,
        )
        .bind(
          `${context.requestId}::cancel-qmv`,
          now,
          context.actorUserId,
          context.requestId,
          context.storeId,
          order.id,
          now,
        ),
      db
        .prepare(
          `UPDATE sale_orders
           SET trade_state = 'cancelled', return_credit_cents = ?, balance_cents = ?, balance_direction = ?,
               version = ?, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ?`,
        )
        .bind(nextReturnCredit, nextBalance, nextDirection, nextVersion, context.actorUserId, now, context.storeId, order.id, order.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'sale_orders', 'id', order.id, nextVersion),
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND trade_state = 'cancelled' AND balance_cents = ?)`,
        context.storeId,
        order.id,
        nextBalance,
      ),
      bumpVersionStatement(db, context, 'SaleOrder', order.id, nextVersion),
      db
        .prepare(
          `INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details)
           VALUES (?, ?, 'B11.cancel', 'SaleOrder', ?, ?)`,
        )
        .bind(context.storeId, context.actorUserId, order.id, JSON.stringify({ reason, at: now })),
    ]
    return {
      statements,
      outcome: {
        entityType: 'SaleOrder',
        entityId: order.id,
        version: nextVersion,
        summary: `已取消 ${order.order_no}${nextBalance < 0 ? `，转为应退 ${(-nextBalance / 100).toFixed(2)} 元` : ''}`,
        effects: {
          orderNo: order.order_no,
          tradeState: 'cancelled',
          refundableCents: Math.max(0, -nextBalance),
          reason,
        },
      },
      constraintCodes: {
        'stock_balances.available_qty': 'STOCK_CONFLICT',
      },
    }
  })
}

// ─────────────────────────────── B17 登记退货 ───────────────────────────────

/**
 * B17 入口：登记退货接收（sold → quarantine 流水，不自动可卖）+ 贷项（pending，未生效）。
 * 只对已交付订单开放（栋哥 2026-09-21 拍板）。累计退货贷项不得超过订单总额。
 */
export async function registerReturn(
  db: OperationsDb,
  ctx: OperationContext,
  input: RegisterReturnInput,
): Promise<RunResult> {
  const action = 'B17'
  const originalOrderId = (input.originalOrderId ?? '').trim()
  if (!originalOrderId) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '退货必须挂在原订单上', retryable: false, httpStatus: 400 }
  }
  const reason = (input.reason ?? '').trim()
  if (!reason) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '退货必须写明原因', retryable: false, httpStatus: 400 }
  }
  if (!Array.isArray(input.lineAllocations) || input.lineAllocations.length === 0) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '退货必须给原行分配（lineAllocations）', retryable: false, httpStatus: 400 }
  }
  if (!Number.isInteger(input.acceptedQty) || input.acceptedQty <= 0) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '接收数量必须是正整数', retryable: false, httpStatus: 400 }
  }
  if (!Number.isInteger(input.creditCents) || input.creditCents <= 0) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '退货贷项必须是正整数分', retryable: false, httpStatus: 400 }
  }
  if (!Array.isArray(input.stockItemIds)) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: 'stockItemIds 必须是数组', retryable: false, httpStatus: 400 }
  }

  const payloadHash = await hashPayload({ input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const order = await readOrder(db, ctx.storeId, originalOrderId)
  if (!order) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '原订单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  if (order.fulfillment_state !== 'delivered') {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '只有已交付的订单能退货；未交付的取消走「取消销售单」', retryable: false, httpStatus: 400 }
  }

  // 校验要收货的实物都属于这张单的逐件实物行（不能乱收别单/别家的货）。
  const stockItemIds = [...new Set(input.stockItemIds.map((id) => String(id).trim()).filter(Boolean))]
  if (stockItemIds.length > 0) {
    const lines = await readSaleLines(db, ctx.storeId, originalOrderId)
    const orderItemIds = new Set(lines.map((line) => line.stock_item_id).filter((v): v is string => Boolean(v)))
    for (const itemId of stockItemIds) {
      if (!orderItemIds.has(itemId)) {
        return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: `实物「${itemId}」不属于这张单，不能退货接收`, retryable: false, httpStatus: 400 }
      }
    }
  }

  const returnId = `${ctx.requestId}::return`
  const now = new Date().toISOString()
  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements: D1PreparedStatement[] = [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ?)', context.storeId, order.id),
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND fulfillment_state = 'delivered')`,
        context.storeId,
        order.id,
      ),
      // 累计退货贷项（含本次，pending + approved 都占额度）不得超过订单总额（partialReturn.cap 的 MVP 口径）。
      guardStatement(
        db,
        'BALANCE_EXCEEDED',
        `EXISTS (SELECT 1 FROM sale_orders
                 WHERE store_id = ? AND id = ? AND total_cents < (
                   COALESCE((SELECT SUM(credit_cents) FROM sale_returns WHERE store_id = ? AND sale_order_id = ?), 0) + ?))`,
        context.storeId,
        order.id,
        context.storeId,
        order.id,
        input.creditCents,
      ),
      db
        .prepare(
          `INSERT INTO sale_returns
             (id, store_id, sale_order_id, reason, accepted_qty, credit_cents, credit_state,
              line_allocations_json, stock_item_ids_json, version, request_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1, ?, ?)`,
        )
        .bind(
          returnId,
          context.storeId,
          order.id,
          reason,
          input.acceptedQty,
          input.creditCents,
          JSON.stringify(input.lineAllocations),
          JSON.stringify(stockItemIds),
          context.requestId,
          context.actorUserId,
        ),
      guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM sale_returns WHERE store_id = ? AND id = ?)', context.storeId, returnId),
    ]

    // 逐件收货：sold → quarantine（source=return_receipt），由 0007 触发器同步 quarantine_qty，绝不自动可卖。
    stockItemIds.forEach((itemId, index) => {
      statements.push(
        db
          .prepare(
            `UPDATE stock_items SET availability = 'quarantine', version = version + 1, updated_at = ?
             WHERE store_id = ? AND id = ? AND availability = 'sold'`,
          )
          .bind(now, context.storeId, itemId),
        guardStatement(
          db,
          'STOCK_CONFLICT',
          `NOT EXISTS (SELECT 1 FROM stock_items WHERE store_id = ? AND id = ? AND availability = 'quarantine')`,
          context.storeId,
          itemId,
        ),
        db
          .prepare(
            `INSERT INTO inventory_movements
               (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
                source, occurred_at, actor_user_id, request_id)
             SELECT ?, si.store_id, si.product_id, si.id, 1, 'sold', 'quarantine', NULL,
                    'return_receipt', ?, ?, ?
             FROM stock_items si
             WHERE si.store_id = ? AND si.id = ? AND si.availability = 'quarantine'`,
          )
          .bind(
            `${context.requestId}::ret-mv-${index}`,
            now,
            context.actorUserId,
            context.requestId,
            context.storeId,
            itemId,
          ),
      )
    })

    return {
      statements,
      outcome: {
        entityType: 'ReturnRecord',
        entityId: returnId,
        version: 1,
        summary: `登记退货：接收 ${input.acceptedQty} 件，贷项 ${(input.creditCents / 100).toFixed(2)} 元（待老板批准）`,
        effects: {
          returnId,
          orderId: order.id,
          acceptedQty: input.acceptedQty,
          creditCents: input.creditCents,
          creditState: 'pending',
          receivedItemCount: stockItemIds.length,
        },
      },
      constraintCodes: {
        'sale_returns.sale_order_id': 'ENTITY_NOT_FOUND',
        'stock_balances.quarantine_qty': 'VALIDATION_ERROR',
      },
    }
  })
}

// ─────────────────────────────── B43 批准退货贷项 ───────────────────────────────

/**
 * B43 入口：把退货单的贷项由 pending 批准为 approved，计入订单应退。
 * 未批准前不生效；批准后累计退货贷项不得超过订单总额（partialReturn.cap）。
 */
export async function approveReturnCredit(
  db: OperationsDb,
  ctx: OperationContext,
  returnId: string,
  input: ApproveReturnCreditInput,
): Promise<RunResult> {
  const action = 'B43'
  const payloadHash = await hashPayload({ returnId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const ret = await readReturn(db, ctx.storeId, returnId)
  if (!ret) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '退货单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  if (ret.credit_state !== 'pending') {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: `这张退货单的贷项已是「${ret.credit_state}」，不能重复批准`, retryable: false, httpStatus: 400 }
  }
  const order = await readOrder(db, ctx.storeId, ret.sale_order_id)
  if (!order) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '退货单对应的订单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }

  const nextReturnVersion = ret.version + 1
  const nextOrderVersion = order.version + 1
  const nextReturnCredit = order.return_credit_cents + ret.credit_cents
  const nextBalance = order.total_cents - nextReturnCredit - order.cash_net_cents - order.offset_net_cents
  const nextDirection = balanceDirectionFor(nextBalance)
  const now = new Date().toISOString()
  const reason = (input.reason ?? '').trim()

  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements: D1PreparedStatement[] = [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM sale_returns WHERE store_id = ? AND id = ?)', context.storeId, returnId),
      guardStatement(
        db,
        'VERSION_CONFLICT',
        'NOT EXISTS (SELECT 1 FROM sale_returns WHERE store_id = ? AND id = ? AND version = ?)',
        context.storeId,
        returnId,
        ret.version,
      ),
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `NOT EXISTS (SELECT 1 FROM sale_returns WHERE store_id = ? AND id = ? AND credit_state = 'pending')`,
        context.storeId,
        returnId,
      ),
      // 批准后累计退货贷项不得超过订单总额（partialReturn.cap）。
      guardStatement(
        db,
        'BALANCE_EXCEEDED',
        `EXISTS (SELECT 1 FROM sale_orders
                 WHERE store_id = ? AND id = ? AND total_cents < return_credit_cents + ?)`,
        context.storeId,
        order.id,
        ret.credit_cents,
      ),
      db
        .prepare(
          `UPDATE sale_returns
           SET credit_state = 'approved', approved_by = ?, approved_at = ?, version = version + 1
           WHERE store_id = ? AND id = ? AND version = ? AND credit_state = 'pending'`,
        )
        .bind(context.actorUserId, now, context.storeId, returnId, ret.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'sale_returns', 'id', returnId, nextReturnVersion),
      db
        .prepare(
          `UPDATE sale_orders
           SET return_credit_cents = ?, balance_cents = ?, balance_direction = ?,
               version = ?, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ?`,
        )
        .bind(nextReturnCredit, nextBalance, nextDirection, nextOrderVersion, context.actorUserId, now, context.storeId, order.id, order.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'sale_orders', 'id', order.id, nextOrderVersion),
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND balance_cents = ?)`,
        context.storeId,
        order.id,
        nextBalance,
      ),
      bumpVersionStatement(db, context, 'SaleOrder', order.id, nextOrderVersion),
    ]
    return {
      statements,
      outcome: {
        entityType: 'ReturnRecord',
        entityId: returnId,
        version: nextReturnVersion,
        summary: `批准退货贷项 ${(ret.credit_cents / 100).toFixed(2)} 元，计入订单应退`,
        effects: {
          returnId,
          creditState: 'approved',
          creditCents: ret.credit_cents,
          returnCreditCents: nextReturnCredit,
          ...(reason ? { reason } : {}),
        },
      },
    }
  })
}

// ─────────────────────────────── B18 登记现金退款 ───────────────────────────────

/**
 * B18 入口：写 direction='out' 的现金退款分录 + cash_net 减少。
 * 退款上限 = min(-balance, cash_net)（money-rules refundableCashCents）。
 * returnRef 若给，必须是 approved 的退货单；adjustmentRef 是调整引用（自由文本，本刀无调整单实体）。
 */
export async function registerRefund(
  db: OperationsDb,
  ctx: OperationContext,
  orderId: string,
  input: RefundInput,
): Promise<RunResult> {
  const action = 'B18'
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '退款金额必须是正整数分', retryable: false, httpStatus: 400 }
  }
  if (!(CASH_METHODS as readonly string[]).includes(input.method)) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '退款方式只能是 cash / wechat / alipay / bank / other', retryable: false, httpStatus: 400 }
  }
  const reason = (input.reason ?? '').trim()
  if (!reason) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '退款必须写明原因', retryable: false, httpStatus: 400 }
  }
  const returnRef = (input.returnRef ?? '').trim()
  const adjustmentRef = (input.adjustmentRef ?? '').trim()
  if (!returnRef && !adjustmentRef) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '退款必须关联退货单（returnRef）或调整（adjustmentRef），二者至少给一个', retryable: false, httpStatus: 400 }
  }

  const payloadHash = await hashPayload({ orderId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const order = await readOrder(db, ctx.storeId, orderId)
  if (!order) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '销售单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }

  // returnRef 指向的退货单必须已批准，且属于这张单。
  if (returnRef) {
    const ret = await readReturn(db, ctx.storeId, returnRef)
    if (!ret || ret.sale_order_id !== orderId) {
      return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '退货单不存在，或不属于这张销售单', retryable: false, httpStatus: 400 }
    }
    if (ret.credit_state !== 'approved') {
      return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '这张退货单的贷项还没批准，不能退款', retryable: false, httpStatus: 400 }
    }
  }

  // 预读校验退款上限（友好提示；真正的硬闸在 plan 的守卫）。
  const refundable = Math.min(Math.max(0, -order.balance_cents), order.cash_net_cents)
  if (refundable <= 0) {
    return { ok: false, requestId: ctx.requestId, code: 'BALANCE_EXCEEDED', message: '这张单没有可退现金（余额不为负，或已无现金净收）', retryable: false, httpStatus: 422 }
  }
  if (input.amountCents > refundable) {
    return { ok: false, requestId: ctx.requestId, code: 'BALANCE_EXCEEDED', message: `退款上限 ${(refundable / 100).toFixed(2)} 元，超出请检查金额`, retryable: false, httpStatus: 422 }
  }

  const refundId = `${ctx.requestId}::refund`
  const entryId = `${ctx.requestId}::refund-cash`
  const occurredAt = input.occurredAt && !Number.isNaN(new Date(input.occurredAt).getTime())
    ? new Date(input.occurredAt).toISOString()
    : new Date().toISOString()
  const nextVersion = order.version + 1
  const nextCashNet = order.cash_net_cents - input.amountCents
  const nextBalance = order.total_cents - order.return_credit_cents - nextCashNet - order.offset_net_cents
  const nextDirection = balanceDirectionFor(nextBalance)

  const resolvedCtx: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolvedCtx, (context) => {
    const statements: D1PreparedStatement[] = [
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ?)', context.storeId, order.id),
      guardStatement(
        db,
        'VERSION_CONFLICT',
        'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND version = ?)',
        context.storeId,
        order.id,
        order.version,
      ),
      // 退款上限三闸（money-rules refundableCashCents = min(-balance, cash_net)）：
      // 余额不为负时没有应退；超应退；超现金净收。
      guardStatement(
        db,
        'BALANCE_EXCEEDED',
        `EXISTS (SELECT 1 FROM sale_orders
                 WHERE store_id = ? AND id = ?
                   AND total_cents - return_credit_cents - cash_net_cents - offset_net_cents >= 0)`,
        context.storeId,
        order.id,
      ),
      guardStatement(
        db,
        'BALANCE_EXCEEDED',
        `EXISTS (SELECT 1 FROM sale_orders
                 WHERE store_id = ? AND id = ?
                   AND ? > -(total_cents - return_credit_cents - cash_net_cents - offset_net_cents))`,
        context.storeId,
        order.id,
        input.amountCents,
      ),
      guardStatement(
        db,
        'BALANCE_EXCEEDED',
        `EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND ? > cash_net_cents)`,
        context.storeId,
        order.id,
        input.amountCents,
      ),
      db
        .prepare(
          `INSERT INTO sale_refunds
             (id, store_id, sale_order_id, return_ref, adjustment_ref, amount_cents, method,
              occurred_at, reason, version, request_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(
          refundId,
          context.storeId,
          order.id,
          returnRef || null,
          adjustmentRef || null,
          input.amountCents,
          input.method,
          occurredAt,
          reason,
          context.requestId,
          context.actorUserId,
        ),
      guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM sale_refunds WHERE store_id = ? AND id = ?)', context.storeId, refundId),
      db
        .prepare(
          `INSERT INTO cash_entries
             (id, store_id, direction, amount_cents, method, verification_state, verified_at,
              counterparty_kind, counterparty_ref, purpose, allocation_type, allocation_id,
              sale_order_id, occurred_at, remark, reversal_of, version, request_id, created_by)
           VALUES (?, ?, 'out', ?, ?, 'verified', ?, 'customer', ?, 'sale_order', 'sale_order', ?, ?, ?, ?, NULL, 1, ?, ?)`,
        )
        .bind(
          entryId,
          context.storeId,
          input.amountCents,
          input.method,
          occurredAt,
          order.customer_id === null ? null : String(order.customer_id),
          order.id,
          order.id,
          occurredAt,
          reason,
          context.requestId,
          context.actorUserId,
        ),
      db
        .prepare(
          `UPDATE sale_orders
           SET cash_net_cents = ?, balance_cents = ?, balance_direction = ?,
               version = ?, updated_by = ?, updated_at = ?
           WHERE store_id = ? AND id = ? AND version = ?`,
        )
        .bind(nextCashNet, nextBalance, nextDirection, nextVersion, context.actorUserId, occurredAt, context.storeId, order.id, order.version),
      assertRowVersionStatement(db, 'VERSION_CONFLICT', 'sale_orders', 'id', order.id, nextVersion),
      guardStatement(
        db,
        'VALIDATION_ERROR',
        `NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ? AND balance_cents = ?)`,
        context.storeId,
        order.id,
        nextBalance,
      ),
      bumpVersionStatement(db, context, 'SaleOrder', order.id, nextVersion),
    ]
    return {
      statements,
      outcome: {
        entityType: 'Refund',
        entityId: refundId,
        version: nextVersion,
        summary: `登记已核实现金退款 ${(input.amountCents / 100).toFixed(2)} 元（${input.method}）`,
        effects: {
          refundId,
          cashEntryId: entryId,
          amountCents: input.amountCents,
          cashNetCents: nextCashNet,
          balanceCents: nextBalance,
          returnRef: returnRef || null,
          adjustmentRef: adjustmentRef || null,
        },
      },
      constraintCodes: {
        'sale_refunds.sale_order_id': 'ENTITY_NOT_FOUND',
        'cash_entries.sale_order_id': 'ENTITY_NOT_FOUND',
      },
    }
  })
}
