/**
 * E08 · 装机检测与交付的接口装配（网页端）。
 *
 * 与 `sales-api.ts` 同一规矩：走 T03b 的请求核心（`createWebApiClient`），
 * 不自己拼 fetch；契约字段翻成本页用的命名；`ApiResult` 原样交给调用方。
 *
 * 契约路径：
 *   B04 POST /sales/orders                      创建零售与直接销售单
 *   B06 POST /sales/orders/:id/start-assembly   开始备料与装机
 *   B07 POST /sales/orders/:id/checks           保存装机检测结果
 *   B10 POST /sales/orders/:id/deliver          确认交付
 *   R04 GET  /sales/orders、/sales/orders/:id   列表与完整处理视图（详情带 fulfillment 看板）
 */

import {
  salesClient,
  type SaleOrderDetailPayload,
} from './sales-api'
import type { ApiResult } from '../../api/core.ts'

export type {
  SaleOrderListPayload,
  SaleOrderListRow,
  SaleOrderDetailPayload,
  CashMethod,
  SaleLineSource,
} from './sales-api'
export { fetchSaleOrders, querySaleOperation } from './sales-api'

export type CheckItemState = 'pending' | 'pass' | 'fail'
export type CheckItemKind = 'check' | 'test'
export type CheckResult = 'incomplete' | 'passed' | 'failed'

export interface CoverageGap {
  lineId: string
  position: number
  nameSnapshot: string
  qty: number
  reservedQty: number
  shortageQty: number
}

export interface CheckItemPayload {
  key: string
  label: string
  kind: CheckItemKind
  state: CheckItemState
  note: string
  /** 逐件坏件隔离：检测不通过时指向具体坏掉的实物（数量件与未命名实物不填）。 */
  stockItemId?: string | null
}

export interface ChecklistRowPayload {
  id: string
  checklistVersion: number
  templateVersion: string
  configurationVersion: number
  result: CheckResult
  itemCount: number
  failCount: number
  performedAt: string
  performedByName: string
}

export interface FulfillmentBoardPayload {
  order: {
    id: string
    orderNo: string
    kind: string
    tradeState: string
    fulfillmentState: string
    configurationVersion: number
    totalCents: number
    balanceCents: number
    balanceDirection: string
    isFullyPaid: boolean
    requiredDepositCents: number
    version: number
    customerName: string
  }
  gaps: CoverageGap[]
  missingSnItems: string[]
  checklists: ChecklistRowPayload[]
  latestChecklist: {
    id: string
    checklistVersion: number
    result: CheckResult
    configurationVersion: number
    items: CheckItemPayload[]
  } | null
  delivery: {
    id: string
    configurationVersion: number
    checklistVersion: number | null
    deliveryNote: string
    receivedByNote: string
    financialDisposition: string
    deliveredAt: string
  } | null
}

/** R04 详情 + 装配看板。 */
export interface FulfillmentDetailPayload extends SaleOrderDetailPayload {
  fulfillment?: FulfillmentBoardPayload
}

export interface FulfillmentWriteOutcome {
  operationId: string
  entityId: string | null
  entityVersion: number | null
  state: string | null
  effects: Record<string, unknown>
  summary: string
}

/** R04：销售单详情（含装配看板）。 */
export function fetchFulfillmentDetail(orderId: string): Promise<ApiResult<FulfillmentDetailPayload>> {
  return salesClient.client.read<FulfillmentDetailPayload>(`/sales/orders/${encodeURIComponent(orderId)}`)
}

/** B06：开始备料（waiting_stock → preparing），备料完成后再次提交即进入检测（preparing → testing）。 */
export function startAssembly(
  orderId: string,
  customerReceiptRef?: string | null,
): Promise<ApiResult<FulfillmentWriteOutcome>> {
  return salesClient.client.write<FulfillmentWriteOutcome>(
    `/sales/orders/${encodeURIComponent(orderId)}/start-assembly`,
    {
      action: 'B06',
      entityId: orderId,
      payload: { location: 'store', customerReceiptRef: customerReceiptRef ?? null },
    },
  )
}

/** B07：保存装机检测结果。结论由服务端按检查项派生，前端不报「通过」。 */
export function saveAssemblyChecks(
  orderId: string,
  items: CheckItemPayload[],
  templateVersion = 'asm-v1',
): Promise<ApiResult<FulfillmentWriteOutcome>> {
  return salesClient.client.write<FulfillmentWriteOutcome>(`/sales/orders/${encodeURIComponent(orderId)}/checks`, {
    action: 'B07',
    entityId: orderId,
    payload: { templateVersion, configurationVersion: 0, items },
  })
}

/** B10：确认交付。尾款没结清或货没占住时服务端会拒绝。 */
export function deliverOrder(
  orderId: string,
  deliveryNote: string,
  receivedByNote?: string | null,
): Promise<ApiResult<FulfillmentWriteOutcome>> {
  return salesClient.client.write<FulfillmentWriteOutcome>(`/sales/orders/${encodeURIComponent(orderId)}/deliver`, {
    action: 'B10',
    entityId: orderId,
    payload: { configurationVersion: 0, checklistVersion: null, deliveryNote, receivedByNote: receivedByNote ?? null },
  })
}

/** B04：创建零售单草稿（直接零售入口）。建单不写库存，收款与成交照旧走 B08 / B05。 */
export function createRetailOrder(input: {
  lines: {
    source: 'new' | 'used' | 'customer' | 'service'
    nameSnapshot: string
    qty: number
    unitPriceCents: number
    productRef?: string | null
    stockItemId?: string | null
  }[]
  customerName: string
  customerPhone: string
  discountCents?: number
  note?: string | null
}): Promise<ApiResult<FulfillmentWriteOutcome>> {
  return salesClient.client.write<FulfillmentWriteOutcome>('/sales/orders', {
    action: 'B04',
    entityId: null,
    payload: {
      kind: 'retail',
      customerSnapshot: { name: input.customerName, phone: input.customerPhone },
      lines: input.lines,
      discountCents: input.discountCents ?? 0,
      note: input.note ?? null,
    },
  })
}
