/**
 * T05b · 库存页的演示样本（V5 读模型样本）。
 *
 * 数据来源：`contracts/v1/fixtures.json` 的 `datasets.V5`。
 * 契约规定 `fixtures.json` 不生成端内文件（dtoGeneration.notGenerated），故此处是端内副本；
 * `demoInventory.test.ts` 会逐字段与契约比对，任何一方漂移都会使测试失败 ——
 * 不允许出现「两处手写、各自演化」。
 *
 * 演示约定（`fixtures.demoPolicy`）：
 *   - 标识由 ID 前缀 `DEMO-` 承载，不新增协议字段；
 *   - 样本整体不可导入生产；接真实服务后必须删除本文件，禁止生产模式回退到样本；
 *   - V5 只证明页面读模型，不构成任何业务前置条件已满足的证据。
 *
 * 金额单位一律为「分」（integer cents），展示时才除以 100。
 */
import type { ActiveStatus, InventoryMovementSource, LocationKind, OwnershipType, StockBucket, StockCondition, TrackingMode } from '../../contracts/generated/enums'

export interface DemoProduct {
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

export interface DemoBalance {
  productRef: string
  locationId: string
  availableQty: number
  reservedQty: number
  quarantineQty: number
  totalCostCents: number | null
  costKnown: boolean
}

export interface DemoStockItem {
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

export interface DemoMovement {
  movementId: string
  productRef: string
  stockItemId: string | null
  qty: number
  fromBucket: StockBucket | null
  toBucket: StockBucket | null
  costCents: number | null
  source: InventoryMovementSource
}

/** 固定演示日期（fixtures.demoPolicy）。 */
export const DEMO_DATE = '2026-09-17'

export const DEMO_PRODUCTS: DemoProduct[] = [
  {
    productRef: 'DEMO-PRODUCT-GPU',
    sku: 'DEMO-SKU-GPU-4060TI',
    name: '影驰 RTX 4060 Ti 金属大师',
    category: '显卡',
    brand: '影驰',
    specs: '8GB GDDR6',
    trackingMode: 'item',
    requiresSn: true,
    status: 'active',
    defaultSalePriceCents: 249900,
  },
  {
    productRef: 'DEMO-PRODUCT-MB',
    sku: 'DEMO-SKU-MB-B760M',
    name: '华硕 TUF B760M-PLUS',
    category: '主板',
    brand: '华硕',
    specs: 'DDR5 / LGA1700',
    trackingMode: 'item',
    requiresSn: true,
    status: 'active',
    defaultSalePriceCents: 119900,
  },
  {
    productRef: 'DEMO-PRODUCT-SSD',
    sku: 'DEMO-SKU-SSD-NV2',
    name: '金士顿 NV2 1TB',
    category: '存储',
    brand: '金士顿',
    specs: 'NVMe PCIe 4.0',
    trackingMode: 'quantity',
    requiresSn: false,
    status: 'active',
    defaultSalePriceCents: 39900,
  },
  {
    productRef: 'DEMO-PRODUCT-MEM',
    sku: 'DEMO-SKU-MEM-DDR5',
    name: '金百达 DDR5 16GB 6000',
    category: '内存',
    brand: '金百达',
    specs: '16GB / 6000MHz',
    trackingMode: 'quantity',
    requiresSn: false,
    status: 'disabled',
    defaultSalePriceCents: 29900,
  },
]

export const DEMO_STOCK_ITEMS: DemoStockItem[] = [
  {
    stockItemId: 'DEMO-ITEM-U017',
    assetCode: 'U-017',
    productRef: 'DEMO-PRODUCT-GPU',
    condition: 'used',
    snRaw: 'SN-GPU-8842-A',
    snNormalized: 'sngpu8842a',
    ownership: 'store',
    availability: 'available',
    location: 'store',
    acquisitionRef: 'DEMO-RC-001',
    acquisitionCostCents: 80000,
    refurbishmentCostCents: 8000,
    costKnown: true,
  },
  {
    stockItemId: 'DEMO-ITEM-N201',
    assetCode: 'N-201',
    productRef: 'DEMO-PRODUCT-GPU',
    condition: 'new',
    snRaw: 'SN-GPU-9001-B',
    snNormalized: 'sngpu9001b',
    ownership: 'store',
    availability: 'available',
    location: 'store',
    acquisitionRef: 'DEMO-PO-002',
    acquisitionCostCents: 198000,
    refurbishmentCostCents: null,
    costKnown: true,
  },
  {
    stockItemId: 'DEMO-ITEM-U032',
    assetCode: 'U-032',
    productRef: 'DEMO-PRODUCT-MB',
    condition: 'used',
    snRaw: null,
    snNormalized: null,
    ownership: 'store',
    availability: 'available',
    location: 'store',
    acquisitionRef: 'DEMO-RC-002',
    acquisitionCostCents: null,
    refurbishmentCostCents: null,
    costKnown: false,
  },
  {
    stockItemId: 'DEMO-ITEM-N118',
    assetCode: 'N-118',
    productRef: 'DEMO-PRODUCT-MB',
    condition: 'new',
    snRaw: 'SN-MB-5510-C',
    snNormalized: 'snmb5510c',
    ownership: 'store',
    availability: 'quarantine',
    location: 'store',
    acquisitionRef: 'DEMO-PO-002',
    acquisitionCostCents: 78000,
    refurbishmentCostCents: null,
    costKnown: true,
  },
  {
    stockItemId: 'DEMO-ITEM-C901',
    assetCode: 'C-901',
    productRef: 'DEMO-PRODUCT-GPU',
    condition: 'used',
    snRaw: 'SN-GPU-8842-A',
    snNormalized: 'sngpu8842a',
    ownership: 'customer',
    availability: 'customer_custody',
    location: 'customer',
    acquisitionRef: null,
    acquisitionCostCents: null,
    refurbishmentCostCents: null,
    costKnown: false,
  },
  {
    stockItemId: 'DEMO-ITEM-T501',
    assetCode: 'T-501',
    productRef: 'DEMO-PRODUCT-GPU',
    condition: 'new',
    snRaw: 'SN-GPU-9100-E',
    snNormalized: 'sngpu9100e',
    ownership: 'store',
    availability: 'in_transit',
    location: 'supplier',
    acquisitionRef: 'DEMO-PO-003',
    acquisitionCostCents: 196000,
    refurbishmentCostCents: null,
    costKnown: true,
  },
]

export const DEMO_BALANCES: DemoBalance[] = [
  {
    productRef: 'DEMO-PRODUCT-GPU',
    locationId: 'DEMO-LOC-STORE',
    availableQty: 2,
    reservedQty: 0,
    quarantineQty: 0,
    totalCostCents: 286000,
    costKnown: true,
  },
  {
    productRef: 'DEMO-PRODUCT-MB',
    locationId: 'DEMO-LOC-STORE',
    availableQty: 1,
    reservedQty: 0,
    quarantineQty: 1,
    totalCostCents: null,
    costKnown: false,
  },
  {
    productRef: 'DEMO-PRODUCT-SSD',
    locationId: 'DEMO-LOC-STORE',
    availableQty: 12,
    reservedQty: 3,
    quarantineQty: 1,
    totalCostCents: 424000,
    costKnown: true,
  },
  {
    productRef: 'DEMO-PRODUCT-MEM',
    locationId: 'DEMO-LOC-STORE',
    availableQty: 2,
    reservedQty: 0,
    quarantineQty: 0,
    totalCostCents: 43000,
    costKnown: true,
  },
]

export const DEMO_MOVEMENTS: DemoMovement[] = [
  {
    movementId: 'DEMO-MV-001',
    productRef: 'DEMO-PRODUCT-GPU',
    stockItemId: 'DEMO-ITEM-U017',
    qty: 1,
    fromBucket: null,
    toBucket: 'available',
    costCents: 88000,
    source: 'opening_balance',
  },
  {
    movementId: 'DEMO-MV-002',
    productRef: 'DEMO-PRODUCT-GPU',
    stockItemId: 'DEMO-ITEM-N201',
    qty: 1,
    fromBucket: null,
    toBucket: 'available',
    costCents: 198000,
    source: 'opening_balance',
  },
  {
    movementId: 'DEMO-MV-003',
    productRef: 'DEMO-PRODUCT-MB',
    stockItemId: 'DEMO-ITEM-U032',
    qty: 1,
    fromBucket: null,
    toBucket: 'available',
    costCents: null,
    source: 'opening_balance',
  },
  {
    movementId: 'DEMO-MV-004',
    productRef: 'DEMO-PRODUCT-MB',
    stockItemId: 'DEMO-ITEM-N118',
    qty: 1,
    fromBucket: null,
    toBucket: 'quarantine',
    costCents: 78000,
    source: 'purchase_receipt',
  },
  {
    movementId: 'DEMO-MV-005',
    productRef: 'DEMO-PRODUCT-SSD',
    stockItemId: null,
    qty: 15,
    fromBucket: null,
    toBucket: 'available',
    costCents: 397500,
    source: 'opening_balance',
  },
  {
    movementId: 'DEMO-MV-006',
    productRef: 'DEMO-PRODUCT-SSD',
    stockItemId: null,
    qty: 3,
    fromBucket: 'available',
    toBucket: 'reserved',
    costCents: null,
    source: 'reservation',
  },
  {
    movementId: 'DEMO-MV-007',
    productRef: 'DEMO-PRODUCT-SSD',
    stockItemId: null,
    qty: 1,
    fromBucket: null,
    toBucket: 'quarantine',
    costCents: 26500,
    source: 'purchase_receipt',
  },
  {
    movementId: 'DEMO-MV-008',
    productRef: 'DEMO-PRODUCT-MEM',
    stockItemId: null,
    qty: 2,
    fromBucket: null,
    toBucket: 'available',
    costCents: 43000,
    source: 'opening_balance',
  },
]

/** 在途：采购单的派生量，不落余额三列（03 §4 L84「在途不算在库」）。 */
export const DEMO_IN_TRANSIT = {
  purchaseRef: 'DEMO-PO-003',
  productRef: 'DEMO-PRODUCT-GPU',
  orderedQty: 1,
  receivedQty: 0,
  stockItemRef: 'DEMO-ITEM-T501',
  note: '在途是采购单的派生量，不落 stock_balances；余额三列里没有它的位置。',
}

/**
 * 是否有成本查看权限。
 *
 * 演示模式下用开关模拟，接真实服务后由服务端 profile 决定（04 §3 L57：
 * 权限决定 cost 字段是否存在）。本文件不伪造「权限校验」本身。
 */
export const DEMO_CAN_VIEW_COST = true
