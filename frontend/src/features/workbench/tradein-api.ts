import { createWebApiClient } from '../../api/client.ts'
import type { ApiResult } from '../../api/core.ts'

const tradeinClient = createWebApiClient()

export interface TradeInDetail {
  id: string
  state: string
  version: number
  saleOrder: { id: string; orderNo: string; tradeState: string; balanceCents: number; version: number }
  recovery: { id: string; orderNo: string; state: string; payableCents: number; paidCents: number; version: number }
  offsets: { id: string; amountCents: number; state: 'applied' | 'reversed'; reversalOf: string | null; reversedReason: string | null; createdAt: string }[]
  validOffsetCents: number
  recoveryPayableRemainingCents: number
}

export interface TradeInWriteOutcome {
  operationId: string
  entityId: string | null
  entityVersion: number | null
  state: string | null
  effects: Record<string, unknown>
  summary: string
}

export function createTradeIn(input: { saleOrderId: string; recoveryId: string; saleOrderVersion: number; recoveryVersion: number }): Promise<ApiResult<TradeInWriteOutcome>> {
  return tradeinClient.client.write('/trade-ins', { action: 'B31', entityId: input.saleOrderId, payload: input })
}

export function applyTradeInOffset(tradeInId: string, input: { amountCents: number; saleOrderVersion: number; recoveryVersion: number }): Promise<ApiResult<TradeInWriteOutcome>> {
  return tradeinClient.client.write(`/trade-ins/${encodeURIComponent(tradeInId)}/apply-offset`, { action: 'B31', entityId: tradeInId, payload: input })
}

export function reverseTradeInOffset(tradeInId: string, input: { offsetId: string; reason: string; saleOrderVersion: number; recoveryVersion: number }): Promise<ApiResult<TradeInWriteOutcome>> {
  return tradeinClient.client.write(`/trade-ins/${encodeURIComponent(tradeInId)}/reverse-offset`, { action: 'B32', entityId: tradeInId, payload: input })
}

export function fetchTradeIn(tradeInId: string): Promise<ApiResult<TradeInDetail>> {
  return tradeinClient.client.read(`/trade-ins/${encodeURIComponent(tradeInId)}`)
}

export function queryTradeInOperation(requestId: string) {
  return tradeinClient.client.queryOperation(requestId)
}
