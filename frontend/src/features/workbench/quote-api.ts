/**
 * E05 · 报价单的接口装配（网页端）。
 *
 * 与 `inventory-api.ts` 同一规矩，只做三件事：
 *   1. 走 T03b 的请求核心（`createWebApiClient`），不绕过它自己拼 fetch ——
 *      重试复用同一 requestId、超时按「结果未知」处理，这些规则都在核心里；
 *   2. 把契约字段翻成本页用的命名，不做业务判断（状态与到期判定由服务端给出）；
 *   3. `ApiResult` 原样交给调用方，本层不抛异常、不把未知压成错误。
 *
 * 契约路径：B01 POST /sales/quotes、B02 /sales/quotes/:id/save 与 /issue、
 *           B42 /sales/quotes/:id/confirm（E05b）、R05 GET /sales/quotes 与 /sales/quotes/:id。
 *
 * ⚠️ 客户资料与设备清单仍走旧 `/api/customers`（E04 接的客户主数据），
 *    因此这里有两个客户端：v2 客户端管报价，根路径客户端管客户。
 *    两端**不得**对同一笔业务重复记账 —— 报价读写只走 v2。
 */

import { createWebApiClient } from '../../api/client.ts'
import type { ApiResult } from '../../api/core.ts'
import { fetchInventory } from './inventory-api.ts'
import type { InventoryItemRow, InventoryProductRow } from './inventory-api.ts'

export type { InventoryItemRow, InventoryProductRow }

/** 报价与客户共用一个会话存储，但 baseUrl 不同。baseUrl 必须是空串：
 *  传 '/' 会把 '/api/customers' 拼成 '//api/customers'（协议相对 URL），
 *  请求根本到不了后端 —— 浏览器验收实测抓到过。 */
export const quoteClient = createWebApiClient()
export const legacyClient = createWebApiClient({ baseUrl: '' })

export type QuoteStatusValue = 'draft' | 'issued' | 'confirmed' | 'converted' | 'expired' | 'closed'
export type QuoteLineSource = 'new' | 'used' | 'customer' | 'service'
export type StockItemAvailability = 'available' | 'reserved' | 'unavailable' | 'missing'
export type FeedbackSource = 'miniprogram' | 'wechat' | 'offline'

export interface QuoteSettings {
  validityHours: number
  reminderLeadHours: number
  reservationDays: number
  depositPercent: number
}

export interface QuoteListRow {
  id: string
  title: string
  customerId: number | null
  customerName: string | null
  /** 已发出版本指针；列表展示使用 workRevision。 */
  currentRevision: number
  workRevision: number | null
  publishedRevision: number | null
  publishedStatus: QuoteStatusValue | null
  publishedTotalCents: number | null
  version: number
  status: QuoteStatusValue | 'missing'
  validUntil: string | null
  issuedAt: string | null
  subtotalCents: number | null
  discountCents: number | null
  totalCents: number | null
  lineCount: number | null
  shared: boolean
  expired: boolean
  expiringSoon: boolean
  createdAt: string
  updatedAt: string
}

export interface QuoteListPayload {
  quotes: QuoteListRow[]
  totals: { all: number; draft: number; issued: number; confirmed: number; expired: number; issuedAmountCents: number }
  settings: QuoteSettings
}

export interface QuoteLineView {
  id: string
  position: number
  source: QuoteLineSource
  nameSnapshot: string
  specSnapshot: string
  qty: number
  unitPriceCents: number
  lineTotalCents: number
  /** 商品引用（hardware.entity_id）。报价阶段允许为空（临时行）；成交前必须选好。 */
  productRef: string | null
  stockItemId: string | null
  customerDeviceRef: string | null
  warrantySnapshot: Record<string, unknown>
  stockItemAvailability: StockItemAvailability | null
}

export interface QuoteRevisionView {
  revision: number
  status: QuoteStatusValue
  issuedAt: string | null
  validUntil: string | null
  confirmedAt: string | null
  confirmedSource: string | null
  totalCents: number
  lineCount: number
}

export interface QuoteDetailPayload {
  quote: {
    id: string
    title: string
    customerId: number | null
    customerName: string | null
    currentRevision: number
    version: number
    createdAt: string
    updatedAt: string
  }
  customer: { id: number; name: string; phone: string } | null
  version: {
    revision: number
    status: QuoteStatusValue
    validUntil: string | null
    issuedAt: string | null
    confirmedAt: string | null
    confirmedSource: string | null
    discountCents: number
    subtotalCents: number
    totalCents: number
    termsSnapshot: Record<string, unknown>
  }
  lines: QuoteLineView[]
  revisions: QuoteRevisionView[]
  hasDraft: boolean
  share: { active: boolean; expiresAt: string | null; createdAt: string | null; revision: number } | null
  expired: boolean
  expiringSoon: boolean
  settings: QuoteSettings
}

export interface QuoteLinePayload {
  source: QuoteLineSource
  nameSnapshot: string
  specSnapshot?: string | null
  qty: number
  unitPriceCents: number
  productRef?: string | null
  stockItemId?: string | null
  customerDeviceRef?: string | null
  warrantySnapshot?: Record<string, unknown> | null
}

export interface QuoteTermsPayload {
  budgetCents?: number | null
  depositPercent?: number | null
  delivery?: {
    mode: 'self_pickup' | 'delivery'
    distanceKm?: number | null
    feeCents?: number | null
    note?: string | null
  } | null
  warranty?: Record<string, unknown> | null
  note?: string | null
}

export interface QuoteDraftPayload {
  customerId?: number | null
  title: string
  lines: QuoteLinePayload[]
  terms?: QuoteTermsPayload | null
  discountCents?: number | null
  changeReason?: string | null
  feedbackSource?: string | null
}

export interface QuoteWriteOutcome {
  operationId: string
  entityId: string | null
  entityVersion: number | null
  state: string | null
  effects: Record<string, unknown>
  summary: string
  /** 分享凭证明文。只在本次签发时出现；命中幂等记录时服务端不再返回（0009 设计要点 5）。 */
  shareToken?: string
}

export interface DocumentExportPayload {
  entityRef: string
  snapshotVersion: number
  audience: 'customer' | 'internal'
  format: 'html'
  html: string
  attachmentId: string
  downloadPath: string
  storagePersistent: boolean
  summary: string
  effects: { format: 'html'; audience: 'customer' | 'internal'; delivery: 'none' }
}

/** B36：报价详情通过服务端白名单生成 HTML，同时由服务端保存可追溯附件。 */
export function exportQuoteHtml(quoteId: string, revision: number): Promise<ApiResult<DocumentExportPayload>> {
  return quoteClient.client.write<DocumentExportPayload>('/documents', {
    action: 'B36',
    entityId: quoteId,
    payload: {
      entityRef: `quote:${quoteId}`,
      snapshotVersion: revision,
      audience: 'customer',
      format: 'html',
    },
  })
}

export type QuoteStatusFilter = 'draft' | 'issued' | 'expired'

/** R05：报价列表。 */
export function fetchQuotes(filters: { status?: QuoteStatusFilter | null; q?: string | null; limit?: number } = {}): Promise<ApiResult<QuoteListPayload>> {
  return quoteClient.client.read<QuoteListPayload>('/sales/quotes', {
    params: { status: filters.status, q: filters.q, limit: filters.limit },
  })
}

/** R05：报价详情。revision 省略时读「当前工作版本」（有草稿读草稿，否则最新已发版）。 */
export function fetchQuoteDetail(quoteId: string, revision?: number | null): Promise<ApiResult<QuoteDetailPayload>> {
  return quoteClient.client.read<QuoteDetailPayload>(`/sales/quotes/${encodeURIComponent(quoteId)}`, {
    params: { revision: revision ?? undefined },
  })
}

/** B01：创建报价草稿。 */
export function createQuoteDraft(payload: QuoteDraftPayload): Promise<ApiResult<QuoteWriteOutcome>> {
  return quoteClient.client.write<QuoteWriteOutcome>('/sales/quotes', { action: 'B01', payload: { ...payload } })
}

/** B02 save：保存版本。草稿反复保存不涨版本号；已发出后再保存会生成新版本。 */
export function saveQuoteVersion(quoteId: string, payload: QuoteDraftPayload, expectedVersion: number): Promise<ApiResult<QuoteWriteOutcome>> {
  return quoteClient.client.write<QuoteWriteOutcome>(`/sales/quotes/${encodeURIComponent(quoteId)}/save`, {
    action: 'B02',
    entityId: quoteId,
    payload: { ...payload },
    expectedVersion,
  })
}

/** B02 issue：发出。只允许草稿 → 已发出；有效值缺省 = 现在 + 门店参数的有效期。 */
export function issueQuoteVersion(quoteId: string, expectedVersion: number, validUntil?: string | null): Promise<ApiResult<QuoteWriteOutcome>> {
  return quoteClient.client.write<QuoteWriteOutcome>(`/sales/quotes/${encodeURIComponent(quoteId)}/issue`, {
    action: 'B02',
    entityId: quoteId,
    payload: { validUntil: validUntil ?? null },
    expectedVersion,
  })
}

/** B42：记录顾客确认（E05b 契约修订）。只允许已发出且未过期的版本；确认 ≠ 付款、确认不锁库存。 */
export function confirmQuoteVersion(
  quoteId: string,
  expectedVersion: number,
  source: FeedbackSource,
  note?: string | null,
): Promise<ApiResult<QuoteWriteOutcome>> {
  return quoteClient.client.write<QuoteWriteOutcome>(`/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, {
    action: 'B42',
    entityId: quoteId,
    payload: { source, note: note ?? null },
    expectedVersion,
  })
}

// ─────────────────────────── 编辑页要用的两份选择数据 ───────────────────────────

export interface CustomerOption {
  id: number
  name: string
  phone: string
}

export interface CustomerDeviceOption {
  id: number
  label: string
  serialNumber: string
}

/** 客户下拉（旧客户接口，E04 的主数据）。 */
export async function fetchCustomerOptions(q: string = ''): Promise<ApiResult<{ items: CustomerOption[] }>> {
  return legacyClient.client.read<{ items: CustomerOption[] }>('/api/customers', {
    params: { q: q || undefined },
  })
}

/** 客户设备清单：客供件行的来源设备从这里选。 */
export async function fetchCustomerDevices(customerId: number): Promise<ApiResult<CustomerOption & { devices: CustomerDeviceOption[]; status?: string }>> {
  return legacyClient.client.read<CustomerOption & { devices: CustomerDeviceOption[]; status?: string }>(
    `/api/customers/${customerId}`,
  )
}

/** 可选二手实物：来自 E04b 的库存读接口（逐件、可用）。需要 inventory/view 权限。 */
export async function fetchAvailableStockItems(): Promise<ApiResult<{ lotItems: InventoryItemRow[] }>> {
  return fetchInventory({ availability: 'available', limit: 100 })
}

/**
 * 商品清单：报价行的「关联商品」从这里选，取的是 hardware.entity_id。
 *
 * 报价时选好商品是必须的：契约 QuoteVersion.rules 要求「成交前必须映射到商品」，
 * 而映射只能靠报价行带来的商品引用 —— 报价阶段不选，转单时就没有任何可靠依据。
 * 同样需要 inventory/view 权限；没有权限时这个列表为空，关联商品只能手填编号。
 */
export async function fetchProductOptions(): Promise<ApiResult<{ items: InventoryProductRow[] }>> {
  return fetchInventory({ limit: 200 })
}

/** 「结果未知」后的第一步：用原 requestId 查处置结果，不贸然重发。 */
export function queryQuoteOperation(requestId: string) {
  return quoteClient.client.queryOperation(requestId)
}
