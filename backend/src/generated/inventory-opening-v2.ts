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

export interface OpenFormalOpeningWindowCommand {
  command: 'open_window'
  durationDays: number
}
