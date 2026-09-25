/**
 * E06 · 销售单与收款的接口装配（网页端）。
 *
 * 与 `quote-api.ts`、`inventory-api.ts` 同一规矩，只做三件事：
 *   1. 走 T03b 的请求核心（`createWebApiClient`），不绕过它自己拼 fetch ——
 *      重试复用同一 requestId、超时按「结果未知」处理，这些规则都在核心里；
 *   2. 把契约字段翻成本页用的命名，不做业务判断（余额方向、可收上限由服务端给出）；
 *   3. `ApiResult` 原样交给调用方，本层不抛异常、不把未知压成错误。
 *
 * 契约路径：
 *   B03 POST /sales/quotes/:id/convert      报价转销售单
 *   B05 POST /sales/orders/:id/confirm      确认成交（含预留）
 *   B05 POST /sales/orders/:id/allocate     补分配缺口
 *   B08 POST /sales/orders/:id/payments     登记销售收款
 *   R04 GET  /sales/orders、/sales/orders/:id
 */

import { createWebApiClient } from '../../api/client.ts'
import type { ApiResult } from '../../api/core.ts'

export const salesClient = createWebApiClient()

export type SaleTradeState = 'draft' | 'confirmed' | 'cancelled' | 'closed'
export type SaleFulfillmentState = 'waiting_stock' | 'preparing' | 'testing' | 'ready_delivery' | 'delivered'
export type CashMethod = 'cash' | 'wechat' | 'alipay' | 'bank' | 'other'
export type SaleLineSource = 'new' | 'used' | 'customer' | 'service'

export interface SaleOrderListRow {
  id: string
  orderNo: string
  customerName: string
  kind: string
  tradeState: SaleTradeState
  fulfillmentState: SaleFulfillmentState
  totalCents: number
  cashNetCents: number
  balanceCents: number
  balanceDirection: 'client_due' | 'settled' | 'store_due'
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

export interface SaleOrderListPayload {
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

export interface SaleOrderDetailLine {
  id: string
  position: number
  source: SaleLineSource
  nameSnapshot: string
  specSnapshot: string
  qty: number
  unitPriceCents: number
  discountAllocationCents: number
  netLineCents: number
  warrantySnapshot: { months?: number; note?: string; remark?: string } | null
  stockItemId: string | null
  stockItemAvailability: string | null
  stockItemAssetCode: string | null
  customerDeviceRef: string | null
}

export interface SaleOrderDetailPayload {
  order: {
    id: string
    orderNo: string
    customerName: string
    customerPhone: string
    kind: string
    tradeState: SaleTradeState
    fulfillmentState: SaleFulfillmentState
    dueAt: string | null
    totalCents: number
    subtotalCents: number
    discountCents: number
    adjustmentCents: number
    cashNetCents: number
    offsetNetCents: number
    returnCreditCents: number
    balanceCents: number
    balanceDirection: 'client_due' | 'settled' | 'store_due'
    isFullyPaid: boolean
    requiredDepositCents: number
    version: number
    note: string
    createdAt: string
    updatedAt: string
  }
  quote: { id: string; revision: number } | null
  warrantyPolicyLines: string[] | null
  lines: SaleOrderDetailLine[]
  payments: {
    id: string
    amountCents: number
    method: string
    verificationState: string
    occurredAt: string
    remark: string
  }[]
  reservations: {
    id: string
    stockItemId: string | null
    lineRef: string
    quantityBucketRef: string | null
    qty: number
    status: string
    createdAt: string
  }[]
  /** 缺口 = 行数量 − 已经锁住的数量。只含新品行；used 行成交前必须指实物。 */
  shortage: {
    lineId: string
    position: number
    nameSnapshot: string
    qty: number
    reservedQty: number
    shortageQty: number
  }[]
  /** 退货单列表（B17 登记，B43 批准后 creditState=approved）。 */
  returns: SaleReturnRow[]
}

export interface SaleReturnRow {
  id: string
  creditCents: number
  creditState: 'pending' | 'approved'
  acceptedQty: number
  reason: string
  createdAt: string
  approvedAt: string | null
}

export interface SaleWriteOutcome {
  operationId: string
  entityId: string | null
  entityVersion: number | null
  state: string | null
  effects: Record<string, unknown>
  summary: string
}

export interface AllocationChoice {
  position: number
  stockItemId?: string | null
}

/** R04：销售单列表。 */
export function fetchSaleOrders(filters: { tradeState?: SaleTradeState | null; q?: string | null; limit?: number } = {}): Promise<ApiResult<SaleOrderListPayload>> {
  return salesClient.client.read<SaleOrderListPayload>('/sales/orders', {
    params: { tradeState: filters.tradeState, q: filters.q, limit: filters.limit },
  })
}

/** R04：销售单详情。 */
export function fetchSaleOrderDetail(orderId: string): Promise<ApiResult<SaleOrderDetailPayload>> {
  return salesClient.client.read<SaleOrderDetailPayload>(`/sales/orders/${encodeURIComponent(orderId)}`)
}

/** B03：报价转销售单。 */
export function convertQuote(
  quoteId: string,
  quoteVersion: number,
  extra: { dueAt?: string | null; allocationChoices?: AllocationChoice[]; note?: string | null } = {},
): Promise<ApiResult<SaleWriteOutcome>> {
  return salesClient.client.write<SaleWriteOutcome>(`/sales/quotes/${encodeURIComponent(quoteId)}/convert`, {
    action: 'B03',
    entityId: quoteId,
    payload: { quoteVersion, ...extra },
  })
}

/** B05 confirm：确认成交并占用实物。未收到定金时服务端会拒绝（未付款不预留）。 */
export function confirmSaleOrder(
  orderId: string,
  extra: { dueAt?: string | null; allocationChoices?: AllocationChoice[]; note?: string | null } = {},
): Promise<ApiResult<SaleWriteOutcome>> {
  return salesClient.client.write<SaleWriteOutcome>(`/sales/orders/${encodeURIComponent(orderId)}/confirm`, {
    action: 'B05',
    entityId: orderId,
    payload: { ...extra },
  })
}

/** B05 allocate：为缺口行补分配实物，不改变交易状态。 */
export function allocateSaleOrder(
  orderId: string,
  allocationChoices: AllocationChoice[],
): Promise<ApiResult<SaleWriteOutcome>> {
  return salesClient.client.write<SaleWriteOutcome>(`/sales/orders/${encodeURIComponent(orderId)}/allocate`, {
    action: 'B05',
    entityId: orderId,
    payload: { allocationChoices },
  })
}

/** B08：登记销售收款。超收由服务端拒绝（BALANCE_EXCEEDED）。 */
export function registerSalePayment(
  orderId: string,
  amountCents: number,
  method: CashMethod,
  remark?: string | null,
): Promise<ApiResult<SaleWriteOutcome>> {
  return salesClient.client.write<SaleWriteOutcome>(`/sales/orders/${encodeURIComponent(orderId)}/payments`, {
    action: 'B08',
    entityId: orderId,
    payload: { amountCents, method, remark: remark ?? null, verificationState: 'verified' },
  })
}

/** 「结果未知」后的第一步：用原 requestId 查处置结果，不贸然重发。 */
export function querySaleOperation(requestId: string) {
  return salesClient.client.queryOperation(requestId)
}

// ─────────────────────────────── E09 · 取消 / 退货 / 退款 / 欠款交付 ───────────────────────────────

export interface RegisterReturnInput {
  originalOrderId: string
  lineAllocations: { position: number; qty: number }[]
  stockItemIds: string[]
  reason: string
  acceptedQty: number
  creditCents: number
}

export interface RefundInput {
  amountCents: number
  method: CashMethod
  /** 退款必须关联一张已批准的退货单。 */
  returnRef: string
  reason: string
}

/** B11：取消销售单。已交付的不能取消（走退货）。 */
export function cancelSaleOrder(orderId: string, reason: string): Promise<ApiResult<SaleWriteOutcome>> {
  return salesClient.client.write<SaleWriteOutcome>(`/sales/orders/${encodeURIComponent(orderId)}/cancel`, {
    action: 'B11',
    entityId: orderId,
    payload: { reason },
  })
}

/** B09：批准欠款交付（老板专属）。已成交且未结清才能批准。 */
export function approveCreditDelivery(orderId: string, dueDate: string, reason: string): Promise<ApiResult<SaleWriteOutcome>> {
  return salesClient.client.write<SaleWriteOutcome>(`/sales/orders/${encodeURIComponent(orderId)}/credit-approval`, {
    action: 'B09',
    entityId: orderId,
    payload: { dueDate, reason },
  })
}

/** B17：登记退货。只对已交付订单开放。 */
export function registerReturn(input: RegisterReturnInput): Promise<ApiResult<SaleWriteOutcome>> {
  return salesClient.client.write<SaleWriteOutcome>('/sales/returns', {
    action: 'B17',
    entityId: null,
    payload: { ...input },
  })
}

/** B43：批准退货贷项（老板专属）。pending → approved 才计入应退。 */
export function approveReturnCredit(returnId: string): Promise<ApiResult<SaleWriteOutcome>> {
  return salesClient.client.write<SaleWriteOutcome>(`/sales/returns/${encodeURIComponent(returnId)}/approve-credit`, {
    action: 'B43',
    entityId: returnId,
    payload: { reason: null },
  })
}

/** B18：登记现金退款（老板专属）。只能对已批准贷项退款，超上限由服务端拒绝。 */
export function refundSaleOrder(orderId: string, input: RefundInput): Promise<ApiResult<SaleWriteOutcome>> {
  return salesClient.client.write<SaleWriteOutcome>(`/sales/orders/${encodeURIComponent(orderId)}/refunds`, {
    action: 'B18',
    entityId: orderId,
    payload: { ...input },
  })
}
