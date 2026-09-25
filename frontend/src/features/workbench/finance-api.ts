/**
 * E09 · 账本的接口装配（网页端）。
 *
 * 与 `sales-api.ts` 同一规矩：走 T03b 的请求核心（`createWebApiClient`），
 * 不自己拼 fetch；契约字段翻成本页用的命名；`ApiResult` 原样交给调用方。
 *
 * 契约路径：
 *   R12 GET  /finance/overview            汇总（现金流 / 应收 / 应付）
 *   R12 GET  /finance/entries             资金流水（可按方向过滤）
 *   B34 POST /finance/entries/:id/reverse 受控反冲账务分录（finance/reverse，owner_only）
 */

import { createWebApiClient } from '../../api/client.ts'
import type { ApiResult } from '../../api/core.ts'

export const financeClient = createWebApiClient()

export interface FinanceOverview {
  cash: { inTotalCents: number; outTotalCents: number; netCents: number }
  receivable: { orderCount: number; totalCents: number; serviceCount: number; serviceTotalCents: number }
  payable: { purchaseCount: number; totalCents: number }
}

export interface FinanceEntryRow {
  id: string
  direction: 'in' | 'out'
  amountCents: number
  method: string
  purpose: string
  counterpartyKind: string
  saleOrderId: string | null
  occurredAt: string
  verificationState: string
  remark: string
  reversalOf: string | null
}

export interface FinanceEntriesPayload {
  entries: FinanceEntryRow[]
  totals: { inTotalCents: number; outTotalCents: number }
}

export interface FinanceWriteOutcome {
  operationId: string
  entityId: string | null
  entityVersion: number | null
  state: string | null
  effects: Record<string, unknown>
  summary: string
}

/** R12：账本汇总。 */
export function fetchFinanceOverview(): Promise<ApiResult<FinanceOverview>> {
  return financeClient.client.read<FinanceOverview>('/finance/overview')
}

/** R12：资金流水。direction 只认 in / out。 */
export function fetchFinanceEntries(
  direction?: 'in' | 'out' | null,
  limit?: number | null,
): Promise<ApiResult<FinanceEntriesPayload>> {
  return financeClient.client.read<FinanceEntriesPayload>('/finance/entries', {
    params: { direction, limit },
  })
}

/** B34：反冲账务分录（老板专属）。反向等额分录 + 连带重算订单余额。 */
export function reverseFinanceEntry(entryId: string, reason: string): Promise<ApiResult<FinanceWriteOutcome>> {
  return financeClient.client.write<FinanceWriteOutcome>(`/finance/entries/${encodeURIComponent(entryId)}/reverse`, {
    action: 'B34',
    entityId: entryId,
    payload: { reason },
  })
}
