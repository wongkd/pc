// AUTO-GENERATED FROM contracts/v2/inventory-opening.json — DO NOT EDIT

export const INVENTORY_ACTIVITY_KINDS = ["movement","operation"] as const
export type InventoryActivityKind = (typeof INVENTORY_ACTIVITY_KINDS)[number]

export const OPENING_COST_BASES = ["known_actual","assessed_estimate","unknown","zero_cost"] as const
export type OpeningCostBasis = (typeof OPENING_COST_BASES)[number]

export const OPENING_WINDOW_MODES = ["disabled","preview","formal"] as const
export type OpeningWindowMode = (typeof OPENING_WINDOW_MODES)[number]

export const OPENING_WINDOW_STATES = ["disabled","preview","not_started","open","expired","closed"] as const
export type OpeningWindowState = (typeof OPENING_WINDOW_STATES)[number]

export const OPENING_WINDOW_CLOSE_REASONS = ["first_business_movement"] as const
export type OpeningWindowCloseReason = (typeof OPENING_WINDOW_CLOSE_REASONS)[number]

export const INVENTORY_ON_HAND_BUCKETS = ["available","reserved","quarantine"] as const
export type InventoryOnHandBucket = (typeof INVENTORY_ON_HAND_BUCKETS)[number]

export const INSPECTION_STATUSES = ["unrecorded","pending","passed","failed"] as const
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number]

export interface InventoryActivityEntry {
  id: string
  kind: InventoryActivityKind
  occurredAt: string
  actorUserId: number | null
  actorRole: 'owner' | 'member' | 'system'
  action: string
  entityType: string | null
  entityId: string | null
  productName: string | null
  qty: number | null
  fromBucket: string | null
  toBucket: string | null
}

export interface InventoryActivityListPayload {
  items: InventoryActivityEntry[]
}

export interface InventoryReadMetrics {
  ownOnHandQty: number
  quantityTrackedQty: number
  itemCount: number
  availableQty: number
  reservedQty: number
  quarantineQty: number
}

export interface InventoryCategoryCount {
  category: string
  metrics: InventoryReadMetrics
}

export interface InventoryAvailabilityCount {
  availability: InventoryOnHandBucket
  quantityTrackedQty: number
  itemCount: number
  qty: number
}

export interface InspectionStatusCount {
  inspectionStatus: InspectionStatus
  itemCount: number
}

export interface InventoryStockItemReadFilters {
  q: string
  category: string | null
  condition: 'new' | 'used' | null
  availability: InventoryOnHandBucket | null
  inspectionStatus: InspectionStatus | null
  limit: number
  cursor: string | null
  quantityCursor: string | null
}

export interface InventoryStockItemRow {
  id: string
  version: number
  productId: string
  productName: string
  category: string
  brand: string | null
  sku: string | null
  assetCode: string
  remark: string
  condition: 'new' | 'used'
  availability: InventoryOnHandBucket
  inspectionStatus: InspectionStatus
  acquisitionCostCents?: number | null
  assessedEstimateCents?: number | null
  costKnown?: boolean
  acquisitionCostBasis?: OpeningCostBasis | null
  costEvidenceRef?: string | null
  costAssessedAt?: string | null
}

export interface InventoryQuantityProductRow {
  id: string
  name: string
  category: string
  sku: string | null
  brand: string | null
  trackingMode: 'quantity'
  availableQty: number
  reservedQty: number
  quarantineQty: number
  ownOnHandQty: number
  totalCostCents?: number | null
  costKnown?: boolean
}

export interface InventoryStockItemPagePayload {
  items: InventoryStockItemRow[]
  quantityProducts: InventoryQuantityProductRow[]
  filters: InventoryStockItemReadFilters
  totals: InventoryReadMetrics
  categoryCounts: InventoryCategoryCount[]
  availabilityCounts: InventoryAvailabilityCount[]
  inspectionCounts: InspectionStatusCount[]
  nextCursor: string | null
  hasMore: boolean
  quantityNextCursor: string | null
  quantityHasMore: boolean
}

export interface InventoryItemCostMetadata {
  acquisitionCostCents?: number | null
  assessedEstimateCents?: number | null
  acquisitionCostBasis?: OpeningCostBasis | null
  costEvidenceRef?: string | null
  costAssessedAt?: string | null
}

export interface InventoryBatchCostMetadata {
  unitCostCents?: number | null
  estimatedUnitCostCents?: number | null
  costBasis?: OpeningCostBasis | null
  costEvidenceRef?: string | null
  costAssessedAt?: string | null
}

export interface OpeningWindowStatus {
  mode: OpeningWindowMode
  status: OpeningWindowState
  openedAt: string | null
  closesAt: string | null
  closedAt: string | null
  closeReason: OpeningWindowCloseReason | null
}

export interface FormalOpeningLineInput {
  approvedCountLineRef: string
  productRef: string
  qty: number
  condition?: 'new' | 'used'
  assetCode?: string
  snRaw?: string
  remark?: string | null
  unitCostCents?: number | null
  costBasis: OpeningCostBasis
  costEvidenceRef?: string | null
  costAssessedAt?: string | null
}

export interface FormalOpeningInput {
  approvedCountRef: string
  note?: string | null
  occurredAt?: string | null
  lines: FormalOpeningLineInput[]
}

export interface InspectionInput {
  result: 'pass' | 'fail'
  findings: string
  evidence: string[]
  disposition: 'available' | 'quarantine' | 'retired'
  expectedVersion: number
  occurredAt?: string | null
}

export interface InspectionReworkInput {
  findings: string
  expectedVersion: number
  occurredAt?: string | null
}

export interface StockBackfillLineInput {
  lineRef: string
  productRef: string
  qty: number
  condition?: 'new' | 'used'
  assetCode?: string
  snRaw?: string | null
  remark?: string | null
  costBasis: OpeningCostBasis
  unitCostCents?: number | null
  costEvidenceRef?: string | null
  costAssessedAt?: string | null
}

export interface StockBackfillInput {
  batchRef: string
  note?: string | null
  occurredAt?: string | null
  lines: StockBackfillLineInput[]
}

export interface InventoryStockItemSourceRecord {
  kind: 'opening' | 'stock_backfill' | 'purchase_order' | 'quick_purchase' | 'recovery_order' | 'unresolved'
  recordId: string
  displayCode: string | null
  occurredAt: string | null
}

export interface OpenFormalOpeningWindowCommand {
  command: 'open_window'
  durationDays: number
}
