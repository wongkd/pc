/**
 * E04b · 库存与商品的接口装配（网页端）。
 *
 * 只做三件事，都是「界面不该自己拼」的部分：
 *   1. 走 T03b 的请求核心（`createWebApiClient`），不绕过它自己拼 fetch —— 重试复用同一个
 *      requestId 的规则写在核心里，任何一处绕过都会让「恰好一次」失效；
 *   2. 把契约字段翻成本页用的命名，**不在这里做业务判断**（成本该不该显示由服务端决定：
 *      无权限时响应里根本没有那几个键）；
 *   3. 把 `ApiResult` 原样交给调用方 —— 网络超时是「结果未知」不是失败，
 *      本层不抛异常、不把未知压成错误，否则界面会撒谎。
 *
 * 动作与权限继承 contracts/v1/actions.json；D10 成本四分类、行级盘点引用和正式窗口见
 * contracts/v2/inventory-opening.json。R06/R07/B12/B13 及库存读模型使用 v2 增量类型。
 */

import { createWebApiClient } from '../../api/client.ts'
import type { ApiResult } from '../../api/core.ts'
import type { InventoryMovementSource } from '../../contracts/generated/enums'
import type { FormalOpeningLineInput, OpeningCostBasis, OpeningWindowStatus } from '../../contracts/v2/generated/inventory-opening'
export type { OpeningCostBasis, OpeningWindowStatus } from '../../contracts/v2/generated/inventory-opening'

/** 页面共用一个客户端：会话、待确认动作、超时口径都只有一份。 */
export const inventoryClient = createWebApiClient()

export type TrackingModeValue = 'quantity' | 'item'
export type StockBucketValue =
  | 'available'
  | 'reserved'
  | 'quarantine'
  | 'in_transit'
  | 'customer_custody'
  | 'sold'
  | 'retired'
export type StockConditionValue = 'new' | 'used'

export interface InventoryProductRow {
  id: string
  sku: string | null
  name: string
  category: string
  brand: string | null
  defaultSalePriceCents: number
  version: number
  trackingMode: TrackingModeValue
  requiresSn: boolean
  status: 'active' | 'disabled'
  availableQty: number
  reservedQty: number
  quarantineQty: number
  ownOnHandQty: number
  storeItemCount: number
  customerCustodyCount: number
  /** 无成本权限时这两个键不存在（不是 null）。用 `'totalCostCents' in row` 判断列是否渲染。 */
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
  condition: StockConditionValue
  snRaw: string | null
  snNormalized: string | null
  ownership: 'store' | 'customer' | 'vendor'
  availability: StockBucketValue
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
  ownOnHandQty: number
  availableQty: number
  reservedQty: number
  quarantineQty: number
  customerCustodyCount: number
  inTransitQty: number
}

export interface InventoryListPayload {
  items: InventoryProductRow[]
  lotItems: InventoryItemRow[]
  batches: StockBatchRow[]
  totals: InventoryTotals
  filters: Record<string, unknown>
  nextCursor: string | null
  hasMore: boolean
  openingWindow: OpeningWindowStatus
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

export interface InventoryFilters {
  q?: string
  productRef?: string
  condition?: StockConditionValue
  availability?: StockBucketValue
  limit?: number
  cursor?: string
}

export function fetchInventory(filters: InventoryFilters = {}): Promise<ApiResult<InventoryListPayload>> {
  return inventoryClient.client.read<InventoryListPayload>('/inventory', {
    params: {
      q: filters.q,
      productRef: filters.productRef,
      condition: filters.condition,
      availability: filters.availability,
      limit: filters.limit,
      cursor: filters.cursor,
    },
  })
}

/** R07 的实物详情：来源、有效占用与最近流水。 */
export interface StockItemDetail {
  item: InventoryItemRow
  attachments: import('./attachment-api').AttachmentView[]
  recoveryState: string | null
  refurbishmentCosts?: Array<{
    id: string
    category: string
    amountCents: number
    capitalizable: boolean
    paymentEntryRef: string | null
    evidenceRef: string | null
    occurredAt: string
  }>
  product: { id: string; sku: string | null; name: string; trackingMode: TrackingModeValue }
  activeReservation: { id: string; orderRef: string; lineRef: string; status: string; createdAt: string } | null
  acquisition: { kind: 'opening'; id: string; approvedCountRef: string; createdAt: string } | null
  movements: Array<{
    id: string
    qty: number
    fromBucket: StockBucketValue | null
    toBucket: StockBucketValue | null
    source: InventoryMovementSource
    occurredAt: string
  }>
}

/** R07：单件实物详情。跨店或不存在时服务端返回 ENTITY_NOT_FOUND。 */
export function fetchStockItem(stockItemId: string): Promise<ApiResult<StockItemDetail>> {
  return inventoryClient.client.read<StockItemDetail>(`/inventory/items/${encodeURIComponent(stockItemId)}`)
}

export interface ProductWritePayload {
  productRef?: string | null
  sku?: string | null
  name: string
  category?: string | null
  brand?: string | null
  specs?: string | null
  defaultSalePriceCents?: number | null
  trackingMode: TrackingModeValue
  requiresSn: boolean
  status?: 'active' | 'disabled'
}

export interface WriteOutcome {
  operationId: string
  entityId: string | null
  entityVersion: number | null
  summary: string
}

/** B12：建立或修改商品主数据。修改必须给 expectedVersion。 */
export function saveProduct(input: ProductWritePayload, expectedVersion?: number | null): Promise<ApiResult<WriteOutcome>> {
  return inventoryClient.client.write<WriteOutcome>('/inventory/products', {
    action: 'B12',
    entityId: input.productRef ?? null,
    payload: { ...input },
    expectedVersion: expectedVersion ?? null,
  })
}

export interface OpeningLinePayload extends Omit<FormalOpeningLineInput, 'approvedCountLineRef' | 'costBasis'> {
  approvedCountLineRef?: string
  /** 省略或 null = 成本未知。绝不用 0 冒充「免费」。 */
  unitCostCents?: number | null
  costBasis?: OpeningCostBasis | null
  costEvidenceRef?: string | null
  costAssessedAt?: string | null
}

export interface OpeningPayload {
  approvedCountRef: string
  costBasis?: { kind: 'known' | 'unknown'; note?: string | null } | null
  note?: string | null
  lines: OpeningLinePayload[]
}

/** B13：录入期初库存（老板专属）。不是日常入库的捷径。 */
export function recordOpening(input: OpeningPayload): Promise<ApiResult<WriteOutcome>> {
  return inventoryClient.client.write<WriteOutcome>('/inventory/openings', {
    action: 'B13',
    payload: { ...input },
  })
}

/** B13：老板开启正式期初窗口。期限由服务端核算，最长 7 天，一店只能开启一次。 */
export function openInventoryOpeningWindow(durationDays: number): Promise<ApiResult<WriteOutcome>> {
  return inventoryClient.client.write<WriteOutcome>('/inventory/openings', {
    action: 'B13',
    payload: { command: 'open_window', durationDays },
  })
}

/** B16：实盘只保存快照；批准才会生成库存调整。 */
export function createInventoryCount(input: {
  asOf: string
  note?: string | null
  lines: Array<{ productRef: string; countedQty: number; note?: string | null }>
}): Promise<ApiResult<WriteOutcome>> {
  return inventoryClient.client.write<WriteOutcome>('/inventory/counts', {
    action: 'B16',
    payload: { scope: { asOf: input.asOf, note: input.note ?? null }, lines: input.lines },
  })
}

/** B16：老板批准已保存的盘点差异。 */
export function approveInventoryCount(countId: string, expectedVersion: number, reason: string): Promise<ApiResult<WriteOutcome>> {
  return inventoryClient.client.write<WriteOutcome>(`/inventory/counts/${encodeURIComponent(countId)}/approve`, {
    action: 'B16', entityId: countId, expectedVersion, payload: { reason },
  })
}

/** B19：隔离实物只有放行可卖或退役两种出口；放行必须提交已关联附件 ID。 */
export function inspectQuarantinedItem(input: {
  itemId: string
  expectedVersion: number
  result: 'pass' | 'fail'
  findings: string
  evidence?: string[]
  disposition: 'available' | 'retired'
}): Promise<ApiResult<WriteOutcome>> {
  return inventoryClient.client.write<WriteOutcome>(`/inventory/items/${encodeURIComponent(input.itemId)}/inspection`, {
    action: 'B19', entityId: input.itemId, expectedVersion: input.expectedVersion,
    payload: { result: input.result, findings: input.findings, evidence: input.evidence ?? [], disposition: input.disposition },
  })
}

export function recordRefurbishment(itemId: string, input: { category: string; amountCents: number; capitalizable: boolean; paymentEntryRef?: string | null; evidenceRef?: string | null }): Promise<ApiResult<WriteOutcome>> {
  return inventoryClient.client.write<WriteOutcome>(`/inventory/items/${encodeURIComponent(itemId)}/refurbishments`, { action: 'B30', entityId: itemId, payload: input })
}

export function makeItemAvailable(itemId: string, input: { conditionGrade: 'brand_new' | 'like_new' | 'excellent' | 'good' | 'fair'; salePriceCents: number; disclosureNote: string; dataDisposed: boolean; warrantyTerm: '3' | '6' | '12' | '24'; expectedVersion: number }): Promise<ApiResult<WriteOutcome>> {
  return inventoryClient.client.write<WriteOutcome>(`/inventory/items/${encodeURIComponent(itemId)}/make-available`, { action: 'B30', entityId: itemId, expectedVersion: input.expectedVersion, payload: input })
}

export interface OperationStatus {
  status: 'pending' | 'succeeded' | 'failed' | 'unknown'
  code: string | null
  message: string
  resultRef: string | null
}

/** 「结果未知」后的第一步：用原 requestId 查处置结果，不贸然重发。 */
export function queryOperationResult(requestId: string): Promise<OperationStatus> {
  return inventoryClient.client.queryOperation(requestId)
}
