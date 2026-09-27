/**
 * T05b · 库存显示口径（小程序端）。
 *
 * 单独成模块的原因有两个：
 *   1. 库存的标签与数量口径是**业务口径**，不是某个页面的排版细节。两端各写一份必然漂移
 *      （OPEN-ITEMS T-10 的教训：金额方向在网页端被写反，直到人工并排实跑才发现）。
 *      故本模块与网页侧 `frontend/src/features/workbench/inventory-view.ts` 由
 *      `node contracts/tools/check-client-parity.mjs` 逐项比对。
 *   2. 被门禁直接加载，故本模块**只含 import type**（类型擦除后消失），不导入运行时值。
 *
 * 口径来源：
 *   - 三桶与在库口径：03 §4 L84「自有在库量 = 可卖 + 已订 + 待处理，三类互斥。在途不算在库。客户保管另列。」
 *   - 未知成本：03 §1 R01「未知成本为 null，不是 0」
 *   - 成本可见性：04 §3 L57「权限决定 cost 字段是否存在」
 *
 * 该视图只作网页/小程序口径一致性检查；旧店员库存页和演示数据已移除。
 *
 * ⚠️ 本文件是网页端 inventory-view.ts 的端内副本：导出名、标签文案、函数返回值必须一字不差，
 *    门禁脚本会跨端 deepEqual。改这里必须同步改网页端，反之亦然。
 */

import type {
  ActiveStatus,
  InventoryMovementSource,
  LocationKind,
  OwnershipType,
  StockBucket,
  StockCondition,
  TrackingMode,
} from '../contracts/generated/enums'

export interface InventoryProduct {
  productRef: string
  sku: string
  name: string
  category: string
  brand: string | null
  specs: string | null
  trackingMode: TrackingMode
  requiresSn: boolean
  status: ActiveStatus
  defaultSalePriceCents: number
}

export interface InventoryBalance {
  productRef: string
  locationId: string
  availableQty: number
  reservedQty: number
  quarantineQty: number
  totalCostCents: number | null
  costKnown: boolean
}

export interface InventoryStockItem {
  stockItemId: string
  assetCode: string
  productRef: string
  condition: StockCondition
  snRaw: string | null
  snNormalized: string | null
  ownership: OwnershipType
  availability: StockBucket
  location: LocationKind
  acquisitionRef: string | null
  acquisitionCostCents: number | null
  refurbishmentCostCents: number | null
  costKnown: boolean
}

export interface InventoryMovement {
  movementId: string
  productRef: string
  stockItemId: string | null
  qty: number
  fromBucket: StockBucket | null
  toBucket: StockBucket | null
  costCents: number | null
  source: InventoryMovementSource
}

export const BUCKET_LABELS: Record<StockBucket, string> = {
  available: '可卖',
  reserved: '已订',
  quarantine: '待处理',
  in_transit: '在途',
  customer_custody: '客户保管',
  sold: '已售出',
  retired: '已离店',
}

export const CONDITION_LABELS: Record<StockCondition, string> = {
  new: '新品',
  used: '二手',
}

export const OWNERSHIP_LABELS: Record<OwnershipType, string> = {
  store: '门店所有',
  customer: '客户所有',
  vendor: '供应商所有',
}

export const LOCATION_LABELS: Record<LocationKind, string> = {
  store: '店内',
  customer: '客户处',
  external: '外部',
  supplier: '供应商处',
}

export const TRACKING_LABELS: Record<TrackingMode, string> = {
  item: '逐件管理',
  quantity: '按数量',
}

export const STATUS_LABELS: Record<ActiveStatus, string> = {
  active: '启用',
  disabled: '已停用',
}

export const MOVEMENT_SOURCE_LABELS: Record<InventoryMovementSource, string> = {
  purchase_receipt: '采购到货',
  quick_purchase: '快速采购',
  opening_balance: '期初建账',
  reservation: '成交预留',
  unreservation: '取消预留',
  assembly_pick: '领料装机',
  delivery: '交付出库',
  return_receipt: '退货入库',
  service_part_consumption: '售后耗用',
  scrap: '报损',
  supplier_return: '退供',
  count_adjustment: '盘点调整',
  conversion: '拆件转换',
  inspection_quarantine: '检测隔离',
  recovery_acquisition: '回收收购',
  inspection_release: '检机放行',
  stock_backfill: '已有库存补录',
}

/** 计入自有在库量的三桶（03 §4 L84）。在途与客户保管不在其中。 */
export const OWN_ON_HAND_BUCKETS: readonly StockBucket[] = ['available', 'reserved', 'quarantine']

/**
 * 分 → 显示文案。
 *
 * 不用 `toLocaleString`：小程序 JSCore 的 Intl 支持不完整，同一段代码在不同机型上
 * 可能给出不同的千分位结果。金额显示错误是业务事故，故用纯字符串运算，任何环境一致。
 */
export function formatCents(cents: number): string {
  const rounded = Math.round(cents)
  const negative = rounded < 0
  const abs = Math.abs(rounded)
  const yuan = Math.floor(abs / 100)
  const fen = abs % 100
  const grouped = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}${grouped}.${String(fen).padStart(2, '0')}`
}

export function formatYuan(cents: number): string {
  return `¥${formatCents(cents)}`
}

/** 自有在库量 = 可卖 + 已订 + 待处理（03 §4 L84）。 */
export function ownOnHandQty(balance: InventoryBalance): number {
  return balance.availableQty + balance.reservedQty + balance.quarantineQty
}

export function isOwnOnHand(bucket: StockBucket): boolean {
  return OWN_ON_HAND_BUCKETS.indexOf(bucket) >= 0
}

/**
 * 成本文案。未知成本必须写「未知」，不得写成 0（03 §1 R01）。
 *
 * 权限不在这里判：调用方没有成本权限时根本不调用本函数、不渲染该列
 * （04 §3 L57：无权限时字段不存在，不是置空）。
 */
export function costText(cents: number | null, costKnown: boolean): string {
  if (!costKnown || cents === null) return '成本未知'
  return formatYuan(cents)
}

/** 成本单元格：无权限返回 null，调用方据此整列不渲染，而不是显示 ¥0.00。 */
export function costCellText(cents: number | null, costKnown: boolean, canViewCost: boolean): string | null {
  if (!canViewCost) return null
  return costText(cents, costKnown)
}

/** 三桶的展示分组，顺序固定：可卖 → 已订 → 待处理。 */
export function bucketGroups(balance: InventoryBalance): Array<{ key: StockBucket; label: string; qty: number }> {
  return [
    { key: 'available', label: BUCKET_LABELS.available, qty: balance.availableQty },
    { key: 'reserved', label: BUCKET_LABELS.reserved, qty: balance.reservedQty },
    { key: 'quarantine', label: BUCKET_LABELS.quarantine, qty: balance.quarantineQty },
  ]
}

/** 搜索词规范化：去空白、转小写，供型号名与 SN 的比较。 */
export function normalizeQuery(q: string | null): string {
  if (!q) return ''
  return q.trim().toLowerCase()
}

/** 型号是否命中关键词：型号名、品牌、规格、SKU 都参与匹配。 */
export function productMatches(product: InventoryProduct, query: string): boolean {
  const q = normalizeQuery(query)
  if (!q) return true
  const haystack = [product.name, product.brand ?? '', product.specs ?? '', product.sku, product.category]
    .join(' ')
    .toLowerCase()
  return haystack.indexOf(q) >= 0
}

/** 实物是否命中关键词：编号、SN 显示值、SN 规范化值都参与匹配。 */
export function itemMatches(item: InventoryStockItem, query: string): boolean {
  const q = normalizeQuery(query)
  if (!q) return true
  const haystack = [item.assetCode, item.snRaw ?? '', item.snNormalized ?? ''].join(' ').toLowerCase()
  return haystack.indexOf(q) >= 0
}

export interface InventoryFilter {
  q: string
  /** 成色筛选；'all' 表示不过滤。 */
  condition: StockCondition | 'all'
  /** 可用性筛选；'all' 表示不过滤。 */
  availability: StockBucket | 'all'
}

/**
 * 型号行筛选。
 *
 * 数量件没有实物，成色只存在于逐件实物上，故对按数量管理的型号，
 * 成色筛选用「该型号名下任意实物的成色」判断，避免数量件在筛选后凭空消失。
 */
export function filterProductRows(
  rows: InventoryRow[],
  items: InventoryStockItem[],
  filter: InventoryFilter,
): InventoryRow[] {
  const q = normalizeQuery(filter.q)
  return rows.filter((row) => {
    if (!productMatches(row.product, q) && !items.some((i) => i.productRef === row.product.productRef && itemMatches(i, q))) {
      return false
    }
    if (filter.availability !== 'all') {
      const hit = bucketGroups(row.balance).some((g) => g.key === filter.availability && g.qty > 0)
      const itemHit = items.some((i) => i.productRef === row.product.productRef && i.availability === filter.availability)
      if (!hit && !itemHit) return false
    }
    if (filter.condition !== 'all') {
      const itemHit = items.some((i) => i.productRef === row.product.productRef && i.condition === filter.condition)
      if (!itemHit) return false
    }
    return true
  })
}

/** 型号行：型号 + 余额 + 该型号名下的实物（可能为空，按数量管理时为空是正常形态）。 */
export interface InventoryRow {
  product: InventoryProduct
  balance: InventoryBalance
  items: InventoryStockItem[]
}

/** 按型号装配行视图。数量件没有实物，逐件件按编号排序便于人工核对。 */
export function buildInventoryRows(
  products: InventoryProduct[],
  balances: InventoryBalance[],
  items: InventoryStockItem[],
): InventoryRow[] {
  return products.map((product) => {
    const balance =
      balances.find((b) => b.productRef === product.productRef) ?? {
        productRef: product.productRef,
        locationId: '',
        availableQty: 0,
        reservedQty: 0,
        quarantineQty: 0,
        totalCostCents: null,
        costKnown: false,
      }
    return {
      product,
      balance,
      items: items
        .filter((i) => i.productRef === product.productRef)
        .slice()
        .sort((a, b) => (a.assetCode < b.assetCode ? -1 : a.assetCode > b.assetCode ? 1 : 0)),
    }
  })
}

/** 实物的单件成本（取得成本 + 整备成本），未知返回 null。 */
export function itemCostCents(item: InventoryStockItem): number | null {
  if (!item.costKnown) return null
  if (item.acquisitionCostCents === null && item.refurbishmentCostCents === null) return null
  return (item.acquisitionCostCents ?? 0) + (item.refurbishmentCostCents ?? 0)
}

/** 实物状态串：可用性 + 所有权 + 位置，三者分别记录、不互相推断。 */
export function describeItemState(item: InventoryStockItem): string {
  return `${BUCKET_LABELS[item.availability]} · ${OWNERSHIP_LABELS[item.ownership]} · ${LOCATION_LABELS[item.location]}`
}
