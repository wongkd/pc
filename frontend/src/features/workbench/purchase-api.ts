/**
 * E07 · 采购到货的接口装配（网页端）。
 *
 * 与 `quote-api.ts`、`inventory-api.ts` 同一规矩：走请求核心、只翻译字段、原样返回 ApiResult。
 *
 * 契约路径：
 *   B14 POST /inventory/purchases                   创建采购（含快捷供应商）
 *   B15 POST /inventory/receipts                    登记到货与入库（支持分批）
 *   B38 POST /inventory/supplier-returns            退供
 *   B33 POST /finance/payments                      采购付款（老板专属）
 *   R08 GET  /inventory/purchases、/:id             采购、实到、在途、拒收
 */

import { createWebApiClient } from '../../api/client.ts'
import type { ApiResult } from '../../api/core.ts'

export const purchaseClient = createWebApiClient()

export type InspectionDisposition = 'available' | 'quarantine' | 'return_to_supplier' | 'return_to_customer' | 'scrapped'
export type CashMethod = 'cash' | 'wechat' | 'alipay' | 'bank' | 'other'

export interface PurchaseListRow {
  id: string
  purchaseNo: string
  supplierName: string
  supplierRef: string | null
  saleOrderId: string | null
  expectedAt: string | null
  orderedQty: number
  receivedQty: number
  rejectedQty: number
  cancelledQty: number
  pendingQty: number
  progress: string
  payableCents: number
  paidCents: number
  remainingPayableCents: number
  lineCount: number
  createdAt: string
}

export interface PurchaseListPayload {
  purchases: PurchaseListRow[]
  totals: { all: number; pending: number; completed: number; pendingQty: number }
}

export interface PurchaseDetailLine {
  id: string
  position: number
  productRef: string | null
  productId: number
  nameSnapshot: string
  qtyOrdered: number
  receivedQty: number
  rejectedQty: number
  pendingQty: number
  unitCostCents: number | null
  costKnown: boolean
}

export interface PurchaseReceiptView {
  id: string
  occurredAt: string
  note: string
  lines: {
    id: string
    position: number
    nameSnapshot: string
    qtyReceived: number
    qtyRejected: number
    disposition: string
    unitCostCents: number | null
    costKnown: boolean
    stockItemId: string | null
    assetCode: string | null
  }[]
}

export interface PurchaseDetailPayload {
  purchase: {
    id: string
    purchaseNo: string
    version: number
    supplierName: string
    supplierRef: string | null
    supplierNote: string | null
    saleOrderId: string | null
    expectedAt: string | null
    note: string
    orderedQty: number
    receivedQty: number
    rejectedQty: number
    cancelledQty: number
    pendingQty: number
    progress: string
    payableCents: number
    paidCents: number
    remainingPayableCents: number
    createdAt: string
  }
  lines: PurchaseDetailLine[]
  receipts: PurchaseReceiptView[]
}

export interface PurchaseWriteOutcome {
  operationId: string
  entityId: string | null
  entityVersion: number | null
  state: string | null
  effects: Record<string, unknown>
  summary: string
}

export interface PurchaseLinePayload {
  productRef: string
  nameSnapshot?: string | null
  qtyOrdered: number
  unitCostCents?: number | null
  costKnown?: boolean
}

export interface PurchaseCreatePayload {
  supplierName?: string | null
  supplierRef?: string | null
  supplierNote?: string | null
  saleOrderId?: string | null
  expectedAt?: string | null
  note?: string | null
  lines: PurchaseLinePayload[]
}

export interface ReceiptLinePayload {
  purchaseLineId?: string | null
  productRef: string
  qtyReceived: number
  qtyRejected?: number
  disposition: InspectionDisposition
  /** 成色（enums.json StockCondition）。省略按新品；买来的二手件必须显式给 used。 */
  condition?: 'new' | 'used'
  unitCostCents?: number | null
  costKnown?: boolean
  items?: { assetCode?: string | null; snRaw?: string | null }[]
  batchRemark?: string | null
}

export interface ReceiptPayload {
  purchaseId?: string | null
  quickPurchaseNote?: string | null
  note?: string | null
  lines: ReceiptLinePayload[]
}

/** R08：采购列表。scope=open 只看还有在途的。 */
export function fetchPurchases(filters: { scope?: 'open' | 'done' | null; q?: string | null; saleOrderId?: string | null; limit?: number } = {}): Promise<ApiResult<PurchaseListPayload>> {
  return purchaseClient.client.read<PurchaseListPayload>('/inventory/purchases', {
    params: { scope: filters.scope, q: filters.q, saleOrderId: filters.saleOrderId, limit: filters.limit },
  })
}

/** R08：采购详情（含每一轮到货）。 */
export function fetchPurchaseDetail(purchaseId: string): Promise<ApiResult<PurchaseDetailPayload>> {
  return purchaseClient.client.read<PurchaseDetailPayload>(
    `/inventory/purchases/${encodeURIComponent(purchaseId)}`,
  )
}

/** B14：创建采购。supplierName 即快捷供应商（不要求先建档）。 */
export function createPurchase(payload: PurchaseCreatePayload): Promise<ApiResult<PurchaseWriteOutcome>> {
  return purchaseClient.client.write<PurchaseWriteOutcome>('/inventory/purchases', {
    action: 'B14',
    payload: { ...payload },
  })
}

/** B15：登记到货。部分到货分次提交，每次一个新 requestId。 */
export function registerReceipt(payload: ReceiptPayload): Promise<ApiResult<PurchaseWriteOutcome>> {
  return purchaseClient.client.write<PurchaseWriteOutcome>('/inventory/receipts', {
    action: 'B15',
    entityId: payload.purchaseId ?? null,
    payload: { ...payload },
  })
}

/** B38：退供。只从可取或待处理库存出发。 */
export function returnToSupplier(payload: {
  purchaseId?: string | null
  stockItemId?: string | null
  productRef?: string | null
  qty: number
  fromBucket: 'available' | 'quarantine'
  reason: string
  supplierName?: string | null
}): Promise<ApiResult<PurchaseWriteOutcome>> {
  return purchaseClient.client.write<PurchaseWriteOutcome>('/inventory/supplier-returns', {
    action: 'B38',
    entityId: payload.stockItemId ?? payload.purchaseId ?? null,
    payload: { ...payload },
  })
}

/** B33：登记采购付款。服务端按采购行成本与既有资金流水重算余额。 */
export function payPurchase(
  purchaseId: string,
  input: { amountCents: number; method: CashMethod; occurredAt?: string | null; remark?: string | null },
): Promise<ApiResult<PurchaseWriteOutcome>> {
  return purchaseClient.client.write<PurchaseWriteOutcome>('/finance/payments', {
    action: 'B33',
    entityId: purchaseId,
    payload: {
      sourceDocument: `purchase:${purchaseId}`,
      amountCents: input.amountCents,
      method: input.method,
      occurredAt: input.occurredAt ?? null,
      remark: input.remark ?? null,
    },
  })
}

/** B37：只取消尚未到货的数量；已有净付款由服务端拒绝，绝不自动退款。 */
export function cancelPurchase(input: {
  purchaseId: string
  lines: Array<{ purchaseLineId: string; qty: number }>
  reason: 'supplier_unavailable' | 'supplier_delay' | 'customer_cancelled' | 'duplicate_purchase'
  note?: string | null
}): Promise<ApiResult<PurchaseWriteOutcome>> {
  return purchaseClient.client.write<PurchaseWriteOutcome>(`/inventory/purchases/${encodeURIComponent(input.purchaseId)}/cancel`, {
    action: 'B37', entityId: input.purchaseId,
    payload: { lines: input.lines, reason: input.reason, note: input.note ?? null },
  })
}
