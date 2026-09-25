/**
 * E11 · 回收拆件与抵用收尾的接口装配（网页端 ERP）。
 *
 * 与 `service-api.ts` 同一规矩：走 T03b 的请求核心（`createWebApiClient`），
 * 不自己拼 fetch；契约字段翻成本页用的命名；`ApiResult` 原样交给调用方。
 *
 * 契约路径：
 *   R10 GET  /recovery/orders、/recovery/orders/:id          回收单列表 / 详情（recovery/view）
 *   B26 POST /recovery/orders                                回收登记（recovery/edit）
 *   B27 POST /recovery/orders/:id/inspect + /offer           验机与估价（recovery/edit）
 *   B28 POST /recovery/orders/:id/acquire                    取得所有权（recovery/acquire，老板专属）
 *   B29 POST /recovery/orders/:id/return                     归还客户（recovery/edit）
 *   B44 POST /recovery/orders/:id/teardown                   拆件入库（recovery/edit）
 *   B33 POST /finance/payments                               登记对外付款（finance/payment，老板专属）
 *   B31/B32/R11 POST/GET /trade-ins*                          置换关联、应用/撤销折抵与查询（tradein）
 *
 * 口径：
 *   · 登记阶段是客户暂存物，不进自有库存、不计成本（服务端 ownership=customer）；
 *   · 只有 B28 才转门店所有，实物进 quarantine 待检，不自动可卖；
 *   · 应付 = 最终收购价 − 已付现金；超付由服务端拒绝（BALANCE_EXCEEDED）；
 *   · 拆件守恒：产出件成本 + 损耗 = 源整机成本，差额不为零整批回滚。
 */

import { createWebApiClient } from '../../api/client.ts'
import type { ApiResult } from '../../api/core.ts'
import type { AttachmentView } from './attachment-api'

export const recoveryClient = createWebApiClient()

export type RecoveryState =
  | 'draft'
  | 'received_for_inspection'
  | 'inspecting'
  | 'offered'
  | 'acquired'
  | 'disassembled'
  | 'refurbishing'
  | 'ready_for_sale'
  | 'return_pending'
  | 'returned'

export type CashMethod = 'cash' | 'wechat' | 'alipay' | 'bank' | 'other'

export interface RecoveryOrderListRow {
  id: string
  orderNo: string
  seller: { customerId: number | null; name: string; phone: string }
  state: RecoveryState
  initialEstimateCents: number | null
  offerVersion: number
  finalAcquisitionCents: number | null
  payableCents: number
  paidCents: number
  /** E12：有效非现金折抵金额。 */
  offsetCents: number
  receivedAt: string | null
  acceptedAt: string | null
  note: string
  version: number
  createdAt: string
}

export interface RecoveryOrderListPayload {
  orders: RecoveryOrderListRow[]
}

export interface RecoveryItemView {
  id: string
  stockItemId: string | null
  description: string
  condition: 'new' | 'used'
  snRaw: string | null
  estimatedCents: number | null
  acquiredCostCents: number | null
}

export interface RecoveryOrderDetail extends RecoveryOrderListRow {
  items: RecoveryItemView[]
  attachments: AttachmentView[]
  tradeIns: { id: string; saleOrderId: string; saleOrderNo: string }[]
}

export interface RecoveryWriteOutcome {
  operationId: string
  entityId: string | null
  entityVersion: number | null
  state: string | null
  effects: Record<string, unknown>
  summary: string
}

export interface RecoveryItemInput {
  description: string
  condition?: 'new' | 'used'
  snRaw?: string | null
  estimatedCents?: number | null
}

export interface AcquisitionLine {
  recoveryItemId: string
  productRef: string
  assetCode?: string | null
  condition?: 'new' | 'used'
  snRaw?: string | null
  remark?: string | null
  costCents: number
}

export interface TeardownOutputInput {
  productRef: string
  assetCode?: string | null
  condition?: 'new' | 'used'
  snRaw?: string | null
  remark?: string | null
  costCents: number
}

export interface ScrapLineInput {
  description: string
  costCents: number
}

/** R10：回收单列表。state 只认 RecoveryState，其余被服务端忽略。 */
export function fetchRecoveryOrders(
  filter: { state?: RecoveryState | null; limit?: number } = {},
): Promise<ApiResult<RecoveryOrderListPayload>> {
  return recoveryClient.client.read<RecoveryOrderListPayload>('/recovery/orders', {
    params: { state: filter.state, limit: filter.limit },
  })
}

/**
 * R10：回收单详情（含逐件明细）。
 * ⚠️ 服务端在 data 里直接给回收单对象（不是 `{ order }` 包一层），列表才是 `{ orders }`。
 */
export function fetchRecoveryOrderDetail(orderId: string): Promise<ApiResult<RecoveryOrderDetail>> {
  return recoveryClient.client.read<RecoveryOrderDetail>(`/recovery/orders/${encodeURIComponent(orderId)}`)
}

/** B26：回收登记。散客只留姓名电话，已有客户传 sellerCustomerId。 */
export function registerRecovery(input: {
  sellerName: string
  sellerPhone?: string | null
  sellerCustomerId?: number | null
  items: RecoveryItemInput[]
  initialEstimateCents?: number | null
  note?: string | null
}): Promise<ApiResult<RecoveryWriteOutcome>> {
  return recoveryClient.client.write<RecoveryWriteOutcome>('/recovery/orders', {
    action: 'B26',
    entityId: null,
    payload: {
      sellerName: input.sellerName,
      sellerPhone: input.sellerPhone ?? null,
      sellerCustomerId: input.sellerCustomerId ?? null,
      items: input.items,
      initialEstimateCents: input.initialEstimateCents ?? null,
      note: input.note ?? null,
    },
  })
}

/** B27a：开始验机（received_for_inspection → inspecting）。 */
export function inspectRecovery(orderId: string, note?: string | null): Promise<ApiResult<RecoveryWriteOutcome>> {
  return recoveryClient.client.write<RecoveryWriteOutcome>(`/recovery/orders/${encodeURIComponent(orderId)}/inspect`, {
    action: 'B27',
    entityId: orderId,
    payload: { note: note ?? null },
  })
}

/** B27b：出估价（→ offered）。逐件价与整单金额二选一，逐件优先。 */
export function offerRecovery(
  orderId: string,
  input: { estimatedCents?: number | null; itemPrices?: { recoveryItemId: string; estimatedCents: number }[]; note?: string | null },
): Promise<ApiResult<RecoveryWriteOutcome>> {
  return recoveryClient.client.write<RecoveryWriteOutcome>(`/recovery/orders/${encodeURIComponent(orderId)}/offer`, {
    action: 'B27',
    entityId: orderId,
    payload: {
      estimatedCents: input.estimatedCents ?? null,
      itemPrices: input.itemPrices ?? null,
      note: input.note ?? null,
    },
  })
}

/** B28：取得所有权（offered → acquired）。逐件成本之和必须等于最终收购价。 */
export function acquireRecovery(
  orderId: string,
  input: { finalAcquisitionCents: number; lines: AcquisitionLine[]; evidenceRef?: string | null; note?: string | null },
): Promise<ApiResult<RecoveryWriteOutcome>> {
  return recoveryClient.client.write<RecoveryWriteOutcome>(`/recovery/orders/${encodeURIComponent(orderId)}/acquire`, {
    action: 'B28',
    entityId: orderId,
    payload: {
      finalAcquisitionCents: input.finalAcquisitionCents,
      lines: input.lines,
      evidenceRef: input.evidenceRef ?? null,
      note: input.note ?? null,
    },
  })
}

/** B29：归还客户（→ returned）。原因必填。 */
export function returnRecovery(orderId: string, reason: string): Promise<ApiResult<RecoveryWriteOutcome>> {
  return recoveryClient.client.write<RecoveryWriteOutcome>(`/recovery/orders/${encodeURIComponent(orderId)}/return`, {
    action: 'B29',
    entityId: orderId,
    payload: { reason },
  })
}

/** B44：拆件入库（acquired → disassembled）。产出 + 损耗 = 源成本，服务端校验。 */
export function teardownRecovery(
  orderId: string,
  input: {
    sourceStockItemId: string
    outputs: TeardownOutputInput[]
    scrapLines?: ScrapLineInput[]
    occurredAt?: string | null
  },
): Promise<ApiResult<RecoveryWriteOutcome>> {
  return recoveryClient.client.write<RecoveryWriteOutcome>(`/recovery/orders/${encodeURIComponent(orderId)}/teardown`, {
    action: 'B44',
    entityId: orderId,
    payload: {
      sourceStockItemId: input.sourceStockItemId,
      outputs: input.outputs,
      scrapLines: input.scrapLines ?? [],
      occurredAt: input.occurredAt ?? null,
    },
  })
}

/**
 * B33：登记回收付款。路径归 finance 域，sourceDocument 指回回收单。
 * 采购付款服务端尚未实现，这里只发回收来源，别拿它去付别的。
 */
export function payRecovery(
  orderId: string,
  input: { amountCents: number; method: CashMethod; occurredAt?: string | null; remark?: string | null },
): Promise<ApiResult<RecoveryWriteOutcome>> {
  return recoveryClient.client.write<RecoveryWriteOutcome>('/finance/payments', {
    action: 'B33',
    entityId: orderId,
    payload: {
      sourceDocument: `recovery:${orderId}`,
      amountCents: input.amountCents,
      method: input.method,
      occurredAt: input.occurredAt ?? null,
      remark: input.remark ?? null,
    },
  })
}

/** 「结果未知」后的第一步：用原 requestId 查处置结果，不贸然重发。 */
export function queryRecoveryOperation(requestId: string) {
  return recoveryClient.client.queryOperation(requestId)
}
