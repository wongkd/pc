/**
 * E10 · 售后维修与收款闭环的接口装配（网页端）。
 *
 * 与 `sales-api.ts` 同一规矩：走 T03b 的请求核心（`createWebApiClient`），
 * 不自己拼 fetch；契约字段翻成本页用的命名；`ApiResult` 原样交给调用方。
 *
 * 契约路径：
 *   R09 GET  /service/orders、/service/orders/:id         工单列表 / 详情（service/view）
 *   B20 POST /service/orders                               接修登记（service/edit）
 *   B21 POST /service/orders/:id/diagnosis + /proposal     诊断与方案（service/edit）
 *   B22 POST /service/orders/:id/confirm-proposal          方案确认（service/edit）
 *   B23 POST /service/orders/:id/replace                   换件领用备件（service/edit）
 *   B24 POST /service/orders/:id/dispatch + /receive-external  外送 / 返回（service/edit）
 *   B25 POST /service/orders/:id/retest + /return          复测 / 归还（service/edit）
 *   B41 POST /service/orders/:id/payments                  售后收款（service/charge）
 */

import { createWebApiClient } from '../../api/client.ts'
import type { ApiResult } from '../../api/core.ts'
import type { AttachmentView } from './attachment-api'

export const serviceClient = createWebApiClient()

export type ServiceState =
  | 'received'
  | 'diagnosing'
  | 'awaiting_approval'
  | 'repairing'
  | 'outsourced'
  | 'retesting'
  | 'ready_return'
  | 'returned'
  | 'closed'

export type CashMethod = 'cash' | 'wechat' | 'alipay' | 'bank' | 'other'

export interface ServiceOrderListRow {
  id: string
  orderNo: string
  customerName: string
  deviceCode: string
  manufacturerSn: string | null
  symptom: string
  state: ServiceState
  confirmedChargeCents: number | null
  balanceCents: number
  version: number
  createdAt: string
}

export interface ServiceOrderListPayload {
  orders: ServiceOrderListRow[]
}

export interface ServiceOrderDetail {
  id: string
  orderNo: string
  customerId: number | null
  customerName: string
  deviceCode: string
  manufacturerSn: string | null
  symptom: string
  intakeSnapshot: Record<string, unknown>
  state: ServiceState
  proposalVersion: number | null
  confirmedChargeCents: number | null
  warrantyDecision: string | null
  cashNetCents: number
  balanceCents: number
  balanceDirection: 'client_due' | 'settled' | 'store_due'
  note: string
  version: number
  createdAt: string
  /** 当前状态允许的动作（服务端派生，前端据此渲染动作按钮）。 */
  allowedActions: string[]
  attachments: AttachmentView[]
}

export interface ServiceOrderDetailPayload {
  order: ServiceOrderDetail
}

export interface ServiceWriteOutcome {
  operationId: string
  entityId: string | null
  entityVersion: number | null
  state: string | null
  effects: Record<string, unknown>
  summary: string
}

export interface ProposalItemInput {
  name: string
  qty: number
  unitPriceCents: number
  chargeType: 'charge' | 'warranty'
}

export interface ReplaceComponentInput {
  oldComponentRef: string
  oldItemDisposition: string
  newStockItem?: string | null
  qty?: number
  chargeType: 'charge' | 'warranty'
}

/** R09：工单列表。state 只认 ServiceState，其余被服务端忽略。 */
export function fetchServiceOrders(filter: { state?: ServiceState | null; q?: string; limit?: number } = {}): Promise<ApiResult<ServiceOrderListPayload>> {
  return serviceClient.client.read<ServiceOrderListPayload>('/service/orders', {
    params: { state: filter.state, q: filter.q, limit: filter.limit },
  })
}

/** R09：工单详情。 */
export function fetchServiceOrderDetail(orderId: string): Promise<ApiResult<ServiceOrderDetailPayload>> {
  return serviceClient.client.read<ServiceOrderDetailPayload>(`/service/orders/${encodeURIComponent(orderId)}`)
}

/** B20：接修登记。散客传 customerName，客户传 customerId。 */
export function createServiceOrder(input: {
  customerId?: number | null
  customerName?: string | null
  manufacturerSn?: string
  symptom: string
  accessories?: string[] | null
  appearance?: string | null
  originalOrderId?: string | null
  warrantyDecision?: string | null
}): Promise<ApiResult<ServiceWriteOutcome>> {
  return serviceClient.client.write<ServiceWriteOutcome>('/service/orders', {
    action: 'B20',
    entityId: null,
    payload: {
      customerId: input.customerId ?? null,
      customerName: input.customerName ?? null,
      deviceCode: input.manufacturerSn ?? '',
      symptom: input.symptom,
      accessories: input.accessories ?? null,
      appearance: input.appearance ?? null,
      originalOrderId: input.originalOrderId ?? null,
      warrantyDecision: input.warrantyDecision ?? null,
    },
  })
}

/** B21a：录入内部诊断（received → diagnosing）。 */
export function saveDiagnosis(orderId: string, diagnosisNote: string): Promise<ApiResult<ServiceWriteOutcome>> {
  return serviceClient.client.write<ServiceWriteOutcome>(`/service/orders/${encodeURIComponent(orderId)}/diagnosis`, {
    action: 'B21',
    entityId: orderId,
    payload: { diagnosisNote },
  })
}

/** B21b：录入维修方案（diagnosing → awaiting_approval）。 */
export function saveProposal(
  orderId: string,
  input: { items: ProposalItemInput[]; chargeCents: number; warrantyDecision?: string | null },
): Promise<ApiResult<ServiceWriteOutcome>> {
  return serviceClient.client.write<ServiceWriteOutcome>(`/service/orders/${encodeURIComponent(orderId)}/proposal`, {
    action: 'B21',
    entityId: orderId,
    payload: {
      items: input.items,
      chargeCents: input.chargeCents,
      warrantyDecision: input.warrantyDecision ?? null,
    },
  })
}

/** B22：记录方案确认（awaiting_approval → repairing / ready_return）。 */
export function confirmProposal(
  orderId: string,
  input: { proposalVersion: number; confirmationMethod: string; confirmedAt: string; accepted: boolean; note?: string | null },
): Promise<ApiResult<ServiceWriteOutcome>> {
  return serviceClient.client.write<ServiceWriteOutcome>(`/service/orders/${encodeURIComponent(orderId)}/confirm-proposal`, {
    action: 'B22',
    entityId: orderId,
    payload: {
      proposalVersion: input.proposalVersion,
      confirmationMethod: input.confirmationMethod,
      confirmedAt: input.confirmedAt,
      accepted: input.accepted,
      note: input.note ?? null,
    },
  })
}

/** B23：换件（repairing → retesting，领用自有备件）。 */
export function replacePart(
  orderId: string,
  input: { components: ReplaceComponentInput[]; approvedProposalVersion: number },
): Promise<ApiResult<ServiceWriteOutcome>> {
  return serviceClient.client.write<ServiceWriteOutcome>(`/service/orders/${encodeURIComponent(orderId)}/replace`, {
    action: 'B23',
    entityId: orderId,
    payload: { components: input.components, approvedProposalVersion: input.approvedProposalVersion },
  })
}

/** B24a：外送 / 返厂（awaiting_approval → outsourced）。 */
export function dispatchExternal(
  orderId: string,
  input: { receiver: string; logistics?: string | null; expectedReturnAt?: string | null; note?: string | null },
): Promise<ApiResult<ServiceWriteOutcome>> {
  return serviceClient.client.write<ServiceWriteOutcome>(`/service/orders/${encodeURIComponent(orderId)}/dispatch`, {
    action: 'B24',
    entityId: orderId,
    payload: {
      receiver: input.receiver,
      logistics: input.logistics ?? null,
      expectedReturnAt: input.expectedReturnAt ?? null,
      note: input.note ?? null,
    },
  })
}

/** B24b：外送返回（outsourced → retesting）。 */
export function receiveExternal(orderId: string, note?: string | null): Promise<ApiResult<ServiceWriteOutcome>> {
  return serviceClient.client.write<ServiceWriteOutcome>(`/service/orders/${encodeURIComponent(orderId)}/receive-external`, {
    action: 'B24',
    entityId: orderId,
    payload: { note: note ?? null },
  })
}

/** B25a：复测通过（retesting → ready_return，费用结清才放行）。 */
export function retestDevice(orderId: string, input: { passed: boolean; note?: string | null }): Promise<ApiResult<ServiceWriteOutcome>> {
  return serviceClient.client.write<ServiceWriteOutcome>(`/service/orders/${encodeURIComponent(orderId)}/retest`, {
    action: 'B25',
    entityId: orderId,
    payload: { passed: input.passed, note: input.note ?? null },
  })
}

/** B25b：归还客户（ready_return → returned）。 */
export function returnDevice(orderId: string, input: { returnedTo: string; note?: string | null }): Promise<ApiResult<ServiceWriteOutcome>> {
  return serviceClient.client.write<ServiceWriteOutcome>(`/service/orders/${encodeURIComponent(orderId)}/return`, {
    action: 'B25',
    entityId: orderId,
    payload: { returnedTo: input.returnedTo, note: input.note ?? null },
  })
}

/** B41：登记售后收款。超收由服务端拒绝（BALANCE_EXCEEDED）。 */
export function registerServicePayment(
  orderId: string,
  input: { amountCents: number; method: CashMethod; occurredAt: string; remark?: string | null },
): Promise<ApiResult<ServiceWriteOutcome>> {
  return serviceClient.client.write<ServiceWriteOutcome>(`/service/orders/${encodeURIComponent(orderId)}/payments`, {
    action: 'B41',
    entityId: orderId,
    payload: {
      amountCents: input.amountCents,
      method: input.method,
      occurredAt: input.occurredAt,
      remark: input.remark ?? null,
    },
  })
}

/** 「结果未知」后的第一步：用原 requestId 查处置结果，不贸然重发。 */
export function queryServiceOperation(requestId: string) {
  return serviceClient.client.queryOperation(requestId)
}
