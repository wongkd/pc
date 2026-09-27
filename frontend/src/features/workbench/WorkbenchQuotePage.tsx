/**
 * E05 · 报价单页（网页端 ERP）。
 *
 * 一页三态：列表 → 编辑（新建 / 改版）→ 详情。数据全部来自 `/api/v2/sales/quotes*`，
 * 没有演示数据；服务端给什么就显示什么，本页不自己判权限（无权限动作由服务端 403）。
 *
 * 业务口径（docs/2026-09-19-报价单业务规则.md）：
 *   · 草稿反复保存不涨版本号；已发出后再保存 = 新版本，旧版本原样留在账上；
 *   · 「记录顾客确认」（B42，E05b）：已发出且未过期的版本可记为顾客已确认，
 *     来源 = 小程序 / 微信 / 线下；确认 ≠ 付款、确认不锁库存：本页没有任何写库存的调用；
 *   · 确认后本版本不可再改：再保存会出新版本，需重新发出并重新确认；
 *   · 「确认成交（转销售单）」= B03（E06）：已发出或已确认且未过期的版本可转成销售单，
 *     转单本身不锁货、不收款；占用与收款在「订单处理」页完成；
 *   · 预算只是顾客心理预算，不进金额计算；措辞不写「省」，超预算只转警示色；
 *   · 打印视图天然脱敏：成本、供应商、SN、内部备注根本不在详情响应里（服务端不查）；
 *   · 配送 10km 外的阶梯档位未定（Q-03）→ 界面写「待设置」，不编造运费；
 *   · 续期 = 以当前版本为底稿保存新草稿再发出（内容不变、有效期重置），版本号 +1。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { formatYuan } from './inventory-view'
import {
  confirmQuoteVersion,
  createQuoteDraft,
  exportQuoteHtml,
  fetchAvailableStockItems,
  fetchCustomerDevices,
  fetchCustomerOptions,
  fetchProductOptions,
  fetchQuoteDetail,
  fetchQuotes,
  issueQuoteVersion,
  queryQuoteOperation,
  saveQuoteVersion,
} from './quote-api'
import type {
  CustomerDeviceOption,
  CustomerOption,
  FeedbackSource,
  InventoryProductRow,
  QuoteDetailPayload,
  QuoteDraftPayload,
  QuoteLineSource,
  QuoteListPayload,
  QuoteSettings,
  QuoteStatusFilter,
  QuoteWriteOutcome,
} from './quote-api'
import type { InventoryStockItemRow } from '../../contracts/v2/generated/inventory-opening'
// E06：报价成交（B03）转成销售单后跳到订单处理页，收款与占用在那一边完成。
import { convertQuote } from './sales-api'
import { applyQuoteScenario, createPresetLines, hasQuoteLineInput, type QuoteEditorLine, type QuotePresetCategory, type QuoteScenario } from './quote-presets'
import { serializeQuoteEditorLines, summarizeQuoteEditorLines } from './quote-editor-lines'
import QuotePresetToolbar from './QuotePresetToolbar'
import '../../styles/workbench.css'
import './quote-presets.css'
import './quote-editor.css'

// ─────────────────────────── 展示口径 ───────────────────────────

const SOURCE_LABELS: Record<QuoteLineSource, string> = {
  new: '新品',
  used: '二手件',
  customer: '客供件',
  service: '服务费',
}

const PRINT_SOURCE_LABELS: Record<QuoteLineSource, string> = {
  new: '全新',
  used: '二手',
  customer: '客供',
  service: '服务项目',
}

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  issued: '已发出',
  confirmed: '顾客已确认',
  converted: '已转订单',
  expired: '已过期',
  closed: '已关闭',
  missing: '版本缺失',
}

const FEEDBACK_LABELS: Record<FeedbackSource, string> = {
  miniprogram: '小程序',
  wechat: '微信',
  offline: '线下面谈',
}

const AVAILABILITY_LABELS: Record<string, string> = {
  available: '可取',
  reserved: '已被占用',
  unavailable: '当前不可取',
  missing: '引用已失效',
}

/** 老板是 `*`；店员按契约码或旧码判断（与 domains/access.ts 的 LEGACY_EQUIVALENT 同源）。 */
function hasAny(permissions: readonly string[], codes: readonly string[]): boolean {
  return permissions.includes('*') || codes.some((code) => permissions.includes(code))
}

const EDIT_CODES = ['sales/quote-edit', 'quote/edit', 'template/edit']
const VIEW_CODES = ['sales/quote-view', 'quote/view', 'template/view']

/** 元输入 → 整数分。空串 / 非法输入返回 null（调用方决定怎么提示）。 */
function yuanToCents(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}

function centsToYuanInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return ''
  return (cents / 100).toString()
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function addHours(value: string, hours: number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Date(date.getTime() + hours * 3_600_000).toISOString()
}

function hoursLeft(validUntil: string | null): number | null {
  if (!validUntil) return null
  const ms = new Date(validUntil).getTime() - Date.now()
  if (Number.isNaN(ms)) return null
  return ms / 3_600_000
}

// ─────────────────────────── 编辑器状态 ───────────────────────────

type EditLine = QuoteEditorLine

interface EditorState {
  quoteId: string | null
  expectedVersion: number | null
  title: string
  customerId: string
  lines: EditLine[]
  discountYuan: string
  budgetYuan: string
  deliveryMode: 'self_pickup' | 'delivery'
  distanceKm: string
  deliveryNote: string
  note: string
  changeReason: string
  feedbackSource: FeedbackSource
}

let lineKeySeq = 0
function nextLineKey(): string {
  lineKeySeq += 1
  return `line-${lineKeySeq}`
}

function createManualLine(category?: QuotePresetCategory): EditLine {
  const source: QuoteLineSource = category === '装机服务' ? 'service' : 'new'
  return { key: nextLineKey(), source, name: '', spec: '', remark: '', qty: '1', priceYuan: '', productRef: '', stockItemId: '', customerDeviceRef: '', category, origin: 'manual', initialSource: source }
}

function freshEditor(): EditorState {
  return {
    quoteId: null,
    expectedVersion: null,
    title: '',
    customerId: '',
    lines: createPresetLines('standard', nextLineKey),
    discountYuan: '',
    budgetYuan: '',
    deliveryMode: 'self_pickup',
    distanceKm: '',
    deliveryNote: '',
    note: '',
    changeReason: '',
    feedbackSource: 'offline',
  }
}

function editorFromDetail(detail: QuoteDetailPayload): EditorState {
  const terms = detail.version.termsSnapshot as {
    budgetCents?: number | null
    depositPercent?: number | null
    delivery?: { mode?: string; distanceKm?: number | null; feeCents?: number | null; note?: string | null } | null
    note?: string | null
    changeReason?: string | null
    feedbackSource?: string | null
  }
  const lines: EditLine[] = detail.lines.map((line) => ({
    key: nextLineKey(),
    source: line.source,
    name: line.nameSnapshot,
    spec: line.specSnapshot,
    remark: String(line.warrantySnapshot?.remark ?? ''),
    qty: String(line.qty),
    priceYuan: centsToYuanInput(line.unitPriceCents),
    productRef: line.productRef ?? '',
    stockItemId: line.stockItemId ?? '',
    customerDeviceRef: line.customerDeviceRef ?? '',
    origin: 'existing' as const,
    initialSource: line.source,
  }))
  const oldDeliveryFee = terms.delivery?.feeCents ?? 0
  if (oldDeliveryFee > 0 && !lines.some((line) => line.source === 'service' && line.name === '配送服务' && yuanToCents(line.priceYuan) === oldDeliveryFee)) {
    lines.push({
      key: nextLineKey(),
      source: 'service',
      name: '配送服务',
      spec: terms.delivery?.note ?? '由历史条款迁入收费行',
      remark: '',
      qty: '1',
      priceYuan: centsToYuanInput(oldDeliveryFee),
      productRef: '',
      stockItemId: '',
      customerDeviceRef: '',
      origin: 'existing',
      initialSource: 'service',
    })
  }
  return {
    quoteId: detail.quote.id,
    expectedVersion: detail.quote.version,
    title: detail.quote.title,
    customerId: detail.quote.customerId === null ? '' : String(detail.quote.customerId),
    lines,
    discountYuan: centsToYuanInput(detail.version.discountCents),
    budgetYuan: centsToYuanInput(terms.budgetCents),
    deliveryMode: terms.delivery?.mode === 'delivery' ? 'delivery' : 'self_pickup',
    distanceKm: terms.delivery?.distanceKm === undefined || terms.delivery.distanceKm === null ? '' : String(terms.delivery.distanceKm),
    deliveryNote: terms.delivery?.note ?? '',
    note: terms.note ?? '',
    changeReason: typeof terms.changeReason === 'string' ? terms.changeReason : '',
    feedbackSource: (['miniprogram', 'wechat', 'offline'] as const).includes(terms.feedbackSource as FeedbackSource)
      ? (terms.feedbackSource as FeedbackSource)
      : 'offline',
  }
}

/** 编辑器 → 契约载荷。金额在这里统一换成整数分；无效值在 validate 阶段已经被拦。 */
function payloadFromEditor(editor: EditorState): QuoteDraftPayload | null {
  const serialized = serializeQuoteEditorLines(editor.lines, { customerId: editor.customerId })
  if (!serialized.ok) return null

  const budgetCents = yuanToCents(editor.budgetYuan)
  const distanceKm = editor.distanceKm.trim() ? Number(editor.distanceKm) : null

  return {
    customerId: editor.customerId ? Number(editor.customerId) : null,
    title: editor.title.trim(),
    lines: serialized.lines,
    discountCents: yuanToCents(editor.discountYuan) ?? 0,
    terms: {
      budgetCents,
      depositPercent: 15,
      delivery: {
        mode: editor.deliveryMode,
        distanceKm,
        note: editor.deliveryNote.trim() || null,
      },
      note: editor.note.trim() || null,
    },
    changeReason: editor.changeReason.trim() || null,
    feedbackSource: editor.feedbackSource,
  }
}

/** 提交前的可读校验。服务端才是权威（约束即断言），这里只挡明显的笔误。 */
function validateEditor(editor: EditorState): string | null {
  if (!editor.title.trim()) return '先给报价单起个标题'
  const serialized = serializeQuoteEditorLines(editor.lines, { customerId: editor.customerId })
  if (!serialized.ok) return serialized.errors[0]?.message ?? '请检查配置行'
  if (editor.discountYuan.trim() && yuanToCents(editor.discountYuan) === null) return '优惠金额不是合法数字'
  return null
}

// ─────────────────────────── 打印（脱敏） ───────────────────────────

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char)
}

/**
 * 打印给顾客看的配置单。
 * 脱敏靠数据源头：详情响应里本来就没有成本、供应商、SN 与内部备注，这里照实渲染即可，
 * 不存在「渲染出来再删掉」的步骤 —— 那种做法漏一次就是事故。
 */
function openPrintWindow(detail: QuoteDetailPayload, settings: QuoteSettings): void {
  const win = window.open('', '_blank', 'width=860,height=920')
  if (!win) return
  const terms = detail.version.termsSnapshot as {
    budgetCents?: number | null
    depositPercent?: number | null
    delivery?: { mode?: string; note?: string | null } | null
    warrantyPolicyLines?: string[] | null
    note?: string | null
  }
  const rows = detail.lines
    .map(
      (line) => `<tr>
        <td>${line.position + 1}</td>
        <td>${escapeHtml(line.nameSnapshot)}</td>
        <td>${escapeHtml(line.specSnapshot || '—')}</td>
        <td>${escapeHtml(PRINT_SOURCE_LABELS[line.source] ?? line.source)}</td>
        <td class="num">${line.qty}</td>
        <td class="num">${formatYuan(line.unitPriceCents)}</td>
        <td class="num">${formatYuan(line.lineTotalCents)}</td>
        <td>${escapeHtml(String(line.warrantySnapshot?.remark ?? ''))}</td>
      </tr>`,
    )
    .join('')
  const budgetRow =
    terms.budgetCents && terms.budgetCents > detail.version.totalCents
      ? ''
      : terms.budgetCents
        ? `<p class="warn">预算对照：${formatYuan(terms.budgetCents)}（本单金额超出顾客预算，请与顾客确认）</p>`
        : ''
  const deliveryText =
    terms.delivery?.mode === 'delivery'
      ? `送货${terms.delivery.note ? `：${escapeHtml(terms.delivery.note)}` : '：运费档位待设置，下单时与门店确认'}`
      : '门店自取'
  const quoteDate = detail.version.issuedAt ?? detail.quote.updatedAt ?? detail.quote.createdAt
  const validUntil = detail.version.validUntil ?? addHours(quoteDate, 24)
  const depositPercent = terms.depositPercent ?? settings.depositPercent
  const warrantyPolicyHtml = Array.isArray(terms.warrantyPolicyLines) && terms.warrantyPolicyLines.length
    ? terms.warrantyPolicyLines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')
    : `<p>${escapeHtml('该历史报价未留存完整保修条款快照，请以原始报价或订单书面承诺为准，并联系门店核对。')}</p>`
  win.document.write(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(detail.quote.title)}</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing: border-box; }
  html { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  body { font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif; color: #182433; margin: 0; font-size: 10pt; line-height: 1.45; }
  h1 { font-size: 21pt; margin: 5mm 0 0; letter-spacing: 2px; }
  .quote-name { margin-top:1.5mm; color:#596779; font-size:9pt; }
  .brand { color: #1d5f9e; font-size: 10pt; font-weight: 700; letter-spacing: 2px; }
  header { display: flex; justify-content: space-between; align-items: start; border-bottom: 2px solid #1d5f9e; padding-bottom: 4mm; }
  .draft { color: #98630e; border: 1px solid #e7a943; background: #fff8e8; padding: 2mm 3mm; border-radius: 2px; font-size: 8pt; }
  .meta { display:flex; justify-content:space-between; color: #596779; font-size: 8.5pt; margin: 3mm 0 5mm; }
  .customer { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); background:#f2f7fb; padding:3mm; margin-bottom:4mm; font-size:9pt; break-inside:avoid; page-break-inside:avoid; }
  table { width: 100%; border-collapse: collapse; table-layout:fixed; font-size: 8.5pt; }
  th, td { border: 1px solid #d9e0e8; padding: 2.5mm 1.5mm; text-align: left; vertical-align: top; overflow-wrap:anywhere; }
  th { background: #edf3f8; }
  thead { display: table-header-group; }
  tfoot { display: table-row-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .num { text-align: right; white-space:nowrap; font-variant-numeric: tabular-nums; }
  .center { text-align:center; }
  tfoot td { font-weight: 600; }
  .totals { width: 68mm; margin: 4mm 0 0 auto; font-size: 9pt; break-inside:avoid; page-break-inside:avoid; }
  .total { display:flex; justify-content:space-between; padding:1mm; }
  .payable { border-top:1px solid #d9e0e8; color:#1d5f9e; font-size:12pt; font-weight:700; padding-top:2mm; }
  .terms { border:1px solid #d9e0e8; border-radius:2px; padding:3mm; color:#455467; font-size:8pt; margin-top:2mm; line-height:1.55; }
  .terms p { margin:.7mm 0; }
  .warranty-copy { font-size:7.5pt; line-height:1.38; }
  .terms strong { color:#25364a; }
  .section-title { font-size:10pt; margin:5mm 0 2mm; break-after:avoid; page-break-after:avoid; }
  .section-title:before { content:''; display:inline-block; width:1mm; height:3.5mm; background:#1d5f9e; margin-right:2mm; vertical-align:middle; }
  .warn { color: #9a5a08; }
  .signatures { display:grid; grid-template-columns:1fr 1fr; gap:12mm; margin-top:12mm; font-size:8.5pt; color:#596779; break-inside:avoid; page-break-inside:avoid; }
  .sign { border-top:1px solid #aeb9c5; padding-top:2mm; }
  footer { display:flex; justify-content:space-between; margin-top:5mm; border-top:1px solid #e5eaf0; padding-top:2mm; color:#8792a0; font-size:7pt; break-inside:avoid; page-break-inside:avoid; }
</style></head><body>
<header><div><div class="brand">徐闻闻所未闻科技 · 电脑配置服务</div><h1>电脑配置报价单</h1><div class="quote-name">${escapeHtml(detail.quote.title)}</div></div><span class="draft">${detail.version.issuedAt ? '正式报价' : '草稿预览'}</span></header>
<div class="meta"><span>报价单号：${escapeHtml(detail.quote.id)}</span><span>报价日期：${escapeHtml(formatDateTime(quoteDate))}</span><span>有效期至：${escapeHtml(formatDateTime(validUntil))}</span></div>
<div class="customer"><span><strong>客户：</strong>${detail.customer ? escapeHtml(detail.customer.name) : '散客'}</span><span><strong>联系电话：</strong>${detail.customer?.phone ? escapeHtml(detail.customer.phone) : '—'}</span><span><strong>报价版本：</strong>第 ${detail.version.revision} 版</span></div>
<table>
  <colgroup><col style="width:5%"><col style="width:12%"><col style="width:19%"><col style="width:10%"><col style="width:7%"><col style="width:13%"><col style="width:13%"><col style="width:21%"></colgroup>
  <thead><tr><th class="center">#</th><th>配件</th><th>型号</th><th>来源</th><th class="center">数量</th><th class="num">单价</th><th class="num">小计</th><th>备注</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr><td colspan="6">商品小计</td><td class="num">${formatYuan(detail.version.subtotalCents)}</td><td></td></tr>
    <tr><td colspan="6">优惠</td><td class="num">− ${formatYuan(detail.version.discountCents)}</td><td></td></tr></tfoot>
</table>
<div class="totals"><div class="total payable"><span>应付金额</span><strong>${formatYuan(detail.version.totalCents)}</strong></div><div class="total"><span>预付款参考（${depositPercent}%）</span><strong>${formatYuan(Math.ceil(detail.version.totalCents * (depositPercent ?? 0) / 100))}</strong></div></div>
<div class="terms">
  ${budgetRow}
  <p><strong>质保与售后服务说明</strong></p>
  <div class="warranty-copy">${warrantyPolicyHtml}</div>
</div>
<h2 class="section-title">交易与交付</h2><div class="terms">
  <p>预付款：${depositPercent}%（核实到账后，按订单约定处理库存预留；退款按订单条款及适用规定办理。）</p>
  <p>交付：${deliveryText}</p>
  ${terms.note ? `<p>顾客备注：${escapeHtml(terms.note)}</p>` : ''}
</div>
<div class="signatures"><div class="sign">客户确认：________________ 日期：__________</div><div class="sign">门店经办：________________ 日期：__________</div></div>
<footer><span>请在确认前核对商品型号、来源、数量、价格与备注。</span><span>电脑配置报价单</span></footer>
</body></html>`)
  win.document.close()
  win.focus()
  win.print()
}

// ─────────────────────────── 组件 ───────────────────────────

type PageView = 'list' | 'edit' | 'detail'
type Notice = { kind: 'ok' | 'warn' | 'error'; text: string } | null

interface UnknownWrite {
  requestId: string
  what: string
}

/**
 * `onConverted` 由外层（App 的路由）注入：转单成功后跳到订单处理页。
 * 做成回调而不是在本组件里 `useNavigate`，是为了让本页不依赖 router ——
 * 渲染测试可以直接把它挂起来测，不必额外包 MemoryRouter。
 */
export default function WorkbenchQuotePage({ permissions, onConverted }: { permissions: string[]; onConverted?: () => void }) {
  const routeParams = new URLSearchParams(window.location.search)
  const requestedStockItemId = routeParams.get('stockItemId')?.trim() ?? ''
  const requestedStockCode = routeParams.get('stockCode')?.trim() ?? ''
  const canEdit = hasAny(permissions, EDIT_CODES)
  const canView = hasAny(permissions, VIEW_CODES)
  const canManageStore = hasAny(permissions, ['store/manage'])

  const [view, setView] = useState<PageView>('list')
  const [statusFilter, setStatusFilter] = useState<QuoteStatusFilter | 'all'>('all')
  const [searchText, setSearchText] = useState('')
  const [list, setList] = useState<QuoteListPayload | null>(null)
  // 只在首屏用：筛选/搜索刷新时保持旧数据原地显示，避免闪烁，也避免在 effect 体内同步 setState。
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const [editor, setEditor] = useState<EditorState>(freshEditor)
  const [scenario, setScenario] = useState<QuoteScenario>('standard')
  const [retainedCount, setRetainedCount] = useState(0)
  const [retainedKeys, setRetainedKeys] = useState<string[]>([])
  const [editorError, setEditorError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [detail, setDetail] = useState<QuoteDetailPayload | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [documentBusy, setDocumentBusy] = useState(false)

  const [notice, setNotice] = useState<Notice>(null)
  const [unknownWrite, setUnknownWrite] = useState<UnknownWrite | null>(null)
  const [issuedShare, setIssuedShare] = useState<{ token: string; revision: number } | null>(null)
  /** B42 记录顾客确认时的来源选择（R10：小程序 / 微信 / 线下）。 */
  const [confirmSource, setConfirmSource] = useState<FeedbackSource>('offline')

  const handleExportHtml = async () => {
    if (!detail || documentBusy) return
    setDocumentBusy(true)
    setNotice(null)
    try {
      const result = await exportQuoteHtml(detail.quote.id, detail.version.revision)
      if (!result.ok) {
        setNotice({ kind: 'error', text: result.message || '单据生成失败，请重试' })
        return
      }
      const blob = new Blob([result.data.html], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = window.document.createElement('a')
      anchor.href = url
      anchor.download = `${detail.quote.title}-第${detail.version.revision}版.html`
      anchor.click()
      URL.revokeObjectURL(url)
      setNotice({ kind: 'ok', text: result.data.storagePersistent
        ? '服务端已生成脱敏 HTML、保存单据附件并开始下载。'
        : '服务端已生成脱敏 HTML、保存本地预览附件并开始下载；本地预览存储不会跨进程保留。' })
    } catch {
      setNotice({ kind: 'error', text: '单据生成请求未完成，请查询网络状态后重试。' })
    } finally {
      setDocumentBusy(false)
    }
  }

  const [customers, setCustomers] = useState<CustomerOption[]>([])
  const [customerSearch, setCustomerSearch] = useState('')
  const [customerSearchBusy, setCustomerSearchBusy] = useState(false)
  const [customerSearchError, setCustomerSearchError] = useState('')
  const [customerNextCursor, setCustomerNextCursor] = useState<string | null>(null)
  const [devices, setDevices] = useState<CustomerDeviceOption[]>([])
  const [stockOptions, setStockOptions] = useState<InventoryStockItemRow[]>([])
  const [stockCategories, setStockCategories] = useState<string[]>([])
  const [stockSearch, setStockSearch] = useState('')
  const [stockCategory, setStockCategory] = useState('')
  const [stockSearchState, setStockSearchState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [stockSearchError, setStockSearchError] = useState('')
  const [stockPrefillError, setStockPrefillError] = useState('')
  /** 商品清单：新品行的「关联商品」从这里选（值是 hardware.entity_id，也就是 productRef）。 */
  const [productOptions, setProductOptions] = useState<InventoryProductRow[]>([])
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const optionsLoaded = useRef(false)
  const stockPrefillHandled = useRef(false)

  const searchAvailableStock = useCallback(async (q = stockSearch, category = stockCategory) => {
    setStockSearchState('loading')
    setStockSearchError('')
    const result = await fetchAvailableStockItems({ q: q.trim(), category: category || null })
    if (result.ok) {
      setStockOptions(result.data.items)
      setStockCategories(result.data.categoryCounts.map((item) => item.category))
      setStockSearchState('idle')
      return
    }
    setStockSearchState('error')
    setStockSearchError(result.message || '可售配件读取失败。')
  }, [stockSearch, stockCategory])

  const searchCustomers = useCallback(async (cursor?: string) => {
    setCustomerSearchBusy(true)
    setCustomerSearchError('')
    try {
      const result = await fetchCustomerOptions(customerSearch.trim(), cursor)
      if (result.ok) {
        setCustomers((previous) => {
          const selected = previous.find((customer) => String(customer.id) === editor.customerId)
          const matches = cursor
            ? [...previous, ...result.data.items.filter((customer) => !previous.some((old) => old.id === customer.id))]
            : result.data.items
          return selected && !matches.some((customer) => customer.id === selected.id)
            ? [selected, ...matches]
            : matches
        })
        setCustomerNextCursor(result.data.nextCursor)
      } else {
        setCustomerSearchError(result.message || '客户搜索失败，请重试。')
      }
    } catch {
      setCustomerSearchError('客户搜索失败，请检查网络后重试。')
    } finally {
      setCustomerSearchBusy(false)
    }
  }, [customerSearch, editor.customerId])

  // setState 只出现在 Promise 回调里（react-hooks/set-state-in-effect）
  useEffect(() => {
    if (view !== 'list' || !canView) return
    let alive = true
    fetchQuotes({ status: statusFilter === 'all' ? null : statusFilter, q: searchText || null }).then((result) => {
      if (!alive) return
      setListLoading(false)
      if (result.ok) setList(result.data)
      else setListError(result.message)
    })
    return () => {
      alive = false
    }
  }, [view, canView, statusFilter, searchText])

  const loadOptions = useCallback(async () => {
    if (optionsLoaded.current) return
    optionsLoaded.current = true
    const [customerResult, stockResult, productResult] = await Promise.all([
      fetchCustomerOptions(),
      fetchAvailableStockItems(),
      fetchProductOptions(),
    ])
    if (productResult.ok) {
      setProductOptions(productResult.data.items)
    } else {
      setOptionsError(
        (prev) =>
          `${prev ? `${prev}；` : ''}商品清单加载失败（需要库存查看权限），新品行的关联商品请手填编号：${productResult.message}`,
      )
    }
    if (customerResult.ok) {
      setCustomers(customerResult.data.items)
      setCustomerNextCursor(customerResult.data.nextCursor)
    } else {
      setOptionsError(`客户名单加载失败：${customerResult.message}`)
    }
    if (stockResult.ok) {
      setStockOptions(stockResult.data.items)
      setStockCategories(stockResult.data.categoryCounts.map((item) => item.category))
    } else {
      setOptionsError((prev) => `${prev ? `${prev}；` : ''}可选二手实物加载失败（需要库存查看权限），二手行请手填实物编号：${stockResult.message}`)
    }
  }, [])

  useEffect(() => {
    if (!requestedStockItemId || stockPrefillHandled.current) return
    stockPrefillHandled.current = true
    const cleanParams = new URLSearchParams(window.location.search)
    cleanParams.delete('stockItemId')
    cleanParams.delete('stockCode')
    window.history.replaceState(null, '', window.location.pathname + (cleanParams.size ? '?' + cleanParams.toString() : '') + window.location.hash)
    void Promise.resolve().then(async () => {
      const next = freshEditor()
      const line = createManualLine()
      line.source = 'used'
      line.initialSource = 'used'
      line.stockItemId = requestedStockItemId
      next.lines = [line]
      setEditor(next)
      setView('edit')
      await loadOptions()
      if (!requestedStockCode) {
        setStockPrefillError('没有可核对的配件编号；请按类别和型号重新查找。')
        setEditor((current) => ({ ...current, lines: current.lines.map((item) => item.stockItemId === requestedStockItemId ? { ...item, stockItemId: '' } : item) }))
        return
      }
      const result = await fetchAvailableStockItems({ q: requestedStockCode })
      if (!result.ok) {
        setStockPrefillError(result.message || '这件配件暂时无法读取；请重新查找后选择。')
        setEditor((current) => ({ ...current, lines: current.lines.map((item) => item.stockItemId === requestedStockItemId ? { ...item, stockItemId: '' } : item) }))
        return
      }
      const selected = result.data.items.find((item) => item.id === requestedStockItemId)
      if (!selected) {
        setStockPrefillError('这件配件目前不能用于报价，请确认库存状态后重新选择。')
        setEditor((current) => ({ ...current, lines: current.lines.map((item) => item.stockItemId === requestedStockItemId ? { ...item, stockItemId: '' } : item) }))
        return
      }
      setStockOptions((current) => [...current.filter((item) => item.id !== selected.id), selected])
      setStockCategories((current) => current.includes(selected.category) ? current : [...current, selected.category])
    })
  }, [loadOptions, requestedStockCode, requestedStockItemId])

  // 选了客户就顺手把设备清单拿回来，客供行的下拉才有的选。
  // 逻辑包在 Promise 回调里：effect 体内不同步 setState（react-hooks/set-state-in-effect）。
  useEffect(() => {
    const customerId = Number(editor.customerId)
    let alive = true
    void Promise.resolve().then(() => {
      if (!alive) return
      if (!editor.customerId || !Number.isInteger(customerId) || customerId < 1) {
        setDevices([])
        return
      }
      fetchCustomerDevices(customerId).then((result) => {
        if (!alive) return
        setDevices(result.ok ? result.data.devices ?? [] : [])
      })
    })
    return () => {
      alive = false
    }
  }, [editor.customerId])

  const openDetail = useCallback(async (quoteId: string, revision?: number) => {
    setView('detail')
    setDetailLoading(true)
    setDetailError(null)
    // 注意：这里**不清** issuedShare —— 发出/续期成功后要立刻打开详情，而凭证明文
    // 只显示一次，清掉了顾客就拿不到链接。从列表进入详情时由调用方显式清除。
    const result = await fetchQuoteDetail(quoteId, revision)
    setDetailLoading(false)
    if (result.ok) {
      setDetail(result.data)
    } else {
      setDetailError(result.message)
    }
  }, [])

  const startCreate = useCallback(() => {
    setEditor(freshEditor())
    setScenario('standard')
    setRetainedCount(0)
    setRetainedKeys([])
    setEditorError(null)
    setIssuedShare(null)
    setView('edit')
    // 选择数据（客户名单 / 可选实物）在进入编辑视图时拉取 —— 由事件处理发起，
    // 不放在 effect 里同步 setState。
    loadOptions()
  }, [loadOptions])

  const startRevise = useCallback((payload: QuoteDetailPayload) => {
    setEditor(editorFromDetail(payload))
    setRetainedCount(0)
    setRetainedKeys([])
    setEditorError(null)
    setIssuedShare(null)
    setView('edit')
    loadOptions()
  }, [loadOptions])

  /** 写动作的统一出口：成功刷新数据；「结果未知」进待确认状态，不当失败。 */
  const runWrite = useCallback(
    async (what: string, action: () => Promise<{ ok: boolean; message?: string; data?: QuoteWriteOutcome }>): Promise<QuoteWriteOutcome | null> => {
      setBusy(true)
      setEditorError(null)
      const result = await action()
      setBusy(false)
      if (result.ok && result.data) return result.data
      if (!result.ok && result.message !== undefined) {
        const fail = result as { ok: false; unknownResult?: boolean; requestId?: string | null; message: string }
        if (fail.unknownResult && fail.requestId) {
          setUnknownWrite({ requestId: fail.requestId, what })
          setNotice({ kind: 'warn', text: `${what}：网络没有给出明确结果。这笔请求已在后台登记，先点「查询结果」，不要重复提交。` })
          return null
        }
        setEditorError(fail.message)
        return null
      }
      setEditorError(result.message ?? '操作失败')
      return null
    },
    [],
  )

  const checkUnknownResult = useCallback(async () => {
    if (!unknownWrite?.requestId) return
    const status = await queryQuoteOperation(unknownWrite.requestId)
    if (status.status === 'succeeded') {
      setNotice({ kind: 'ok', text: `${unknownWrite.what}：后台确认这笔已经生效。` })
      setUnknownWrite(null)
      if (editor.quoteId) await openDetail(editor.quoteId)
      return
    }
    if (status.status === 'pending') {
      setNotice({ kind: 'warn', text: `${unknownWrite.what}：后台还在处理，过一会儿再点「查询结果」。` })
      return
    }
    if (status.status === 'unknown') {
      setNotice({ kind: 'warn', text: `${unknownWrite.what}：后台查不到这个请求编号，可以重新提交。` })
      setUnknownWrite(null)
      return
    }
    setNotice({ kind: 'error', text: `${unknownWrite.what}：这次没有成功（${status.code ?? '原因未知'}）。` })
  }, [unknownWrite, editor.quoteId, openDetail])

  /** 把一份详情内容存成新草稿版并发出（「发出草稿版」与「续期」共用）。 */
  const issueFromDetail = useCallback(
    async (payloadDetail: QuoteDetailPayload, changeReason: string | null): Promise<boolean> => {
      const payload = payloadFromEditor(editorFromDetail(payloadDetail))
      if (!payload) {
        setNotice({ kind: 'error', text: '服务端报价明细未通过本地校验，未保存或发出。请返回编辑并核对配置。' })
        return false
      }
      if (changeReason) payload.changeReason = changeReason
      const saved = await runWrite('保存新版本', () => saveQuoteVersion(payloadDetail.quote.id, payload, payloadDetail.quote.version))
      if (!saved) return false
      const nextVersion = saved.entityVersion ?? payloadDetail.quote.version + 1
      const issued = await runWrite('发出报价', () => issueQuoteVersion(payloadDetail.quote.id, nextVersion, null))
      if (!issued) return false
      if (issued.shareToken) {
        setIssuedShare({ token: issued.shareToken, revision: Number(issued.effects?.revision ?? 0) })
      }
      setNotice({ kind: 'ok', text: `${issued.summary || '已发出'}。旧链接锁定的是旧版本，请把新链接发给顾客。` })
      await openDetail(payloadDetail.quote.id)
      return true
    },
    [runWrite, openDetail],
  )

  const handleCreate = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      const problem = validateEditor(editor)
      if (problem) {
        setEditorError(problem)
        return
      }
      const payload = payloadFromEditor(editor)
      if (!payload) { setEditorError('请检查配置行'); return }
      const outcome = await runWrite('创建报价草稿', () => createQuoteDraft(payload))
      if (!outcome?.entityId) return
      setNotice({ kind: 'ok', text: outcome.summary || '草稿已创建' })
      await openDetail(outcome.entityId)
    },
    [editor, runWrite, openDetail],
  )

  const handleSave = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      const problem = validateEditor(editor)
      if (problem) {
        setEditorError(problem)
        return
      }
      if (!editor.quoteId || editor.expectedVersion === null) {
        setEditorError('这份报价缺少版本信息，请回列表重新打开')
        return
      }
      const payload = payloadFromEditor(editor)
      if (!payload) { setEditorError('请检查配置行'); return }
      const outcome = await runWrite('保存报价', () => saveQuoteVersion(editor.quoteId!, payload, editor.expectedVersion!))
      if (!outcome) return
      setNotice({ kind: 'ok', text: outcome.summary || '已保存' })
      await openDetail(editor.quoteId)
    },
    [editor, runWrite, openDetail],
  )

  /** 发出：编辑视图里有未保存内容就先保存，再对最新草稿发出。 */
  const handleIssueFromEditor = useCallback(async () => {
    const problem = validateEditor(editor)
    if (problem) {
      setEditorError(problem)
      return
    }
    if (!editor.quoteId || editor.expectedVersion === null) {
      setEditorError('这份报价缺少版本信息，请回列表重新打开')
      return
    }
    const payload = payloadFromEditor(editor)
    if (!payload) { setEditorError('请检查配置行'); return }
    const saved = await runWrite('保存报价', () => saveQuoteVersion(editor.quoteId!, payload, editor.expectedVersion!))
    if (!saved) return
    const nextVersion = saved.entityVersion ?? editor.expectedVersion + 1
    const issued = await runWrite('发出报价', () => issueQuoteVersion(editor.quoteId!, nextVersion, null))
    if (!issued) return
    const token = issued.shareToken
    if (token) {
      setIssuedShare({ token, revision: Number(issued.effects?.revision ?? 0) })
      setNotice({ kind: 'ok', text: `${issued.summary || '已发出'}。分享链接已生成，见页面提示。` })
    } else {
      setNotice({ kind: 'ok', text: issued.summary || '已发出' })
    }
    await openDetail(editor.quoteId)
  }, [editor, runWrite, openDetail])

  /** 续期：以当前版本为底稿保存新草稿（内容不变）再发出，版本号 +1。 */
  const handleRenew = useCallback(async () => {
    if (!detail) return
    const done = await issueFromDetail(detail, '续期（内容不变，有效期重置）')
    if (done) {
      setNotice({ kind: 'ok', text: '已续期：新版本已发出。旧链接锁定的是旧版本，请把新链接发给顾客。' })
    }
  }, [detail, issueFromDetail])

  /** B42 记录顾客确认：确认 ≠ 付款、确认不锁库存；确认后本版本不能再改。 */
  const handleConfirm = useCallback(async () => {
    if (!detail || !canEdit) return
    const outcome = await runWrite('记录顾客确认', () =>
      confirmQuoteVersion(detail.quote.id, detail.quote.version, confirmSource),
    )
    if (!outcome) return
    setNotice({ kind: 'ok', text: `${outcome.summary || '已记录顾客确认'}。确认 ≠ 付款，达到已核实的预付款门槛后才尝试预留库存。` })
    await openDetail(detail.quote.id)
  }, [detail, canEdit, confirmSource, runWrite, openDetail])

  /** B03 确认成交：把这一版转成销售单（E06）。转单本身不锁货、不收款。 */
  const handleConvert = useCallback(async () => {
    if (!detail || !canEdit) return
    const outcome = await runWrite('确认成交（转销售单）', () =>
      convertQuote(detail.quote.id, detail.version.revision, { note: null }),
    )
    if (!outcome) return
    setNotice({ kind: 'ok', text: `${outcome.summary || '已生成销售单'}。到「订单处理」里登记收款并确认成交后才会占用实物。` })
    onConverted?.()
  }, [detail, canEdit, runWrite, onConverted])

  const lineSummary = useMemo(() => summarizeQuoteEditorLines(editor.lines, { customerId: editor.customerId }), [editor.lines, editor.customerId])
  const subtotalCents = lineSummary.totalCents
  const discountCents = yuanToCents(editor.discountYuan) ?? 0
  const totalCents = Math.max(0, subtotalCents - discountCents)
  const budgetCents = yuanToCents(editor.budgetYuan)

  if (!canView) {
    return (
      <div className="wb-page wb-quote-page">
        <header className="wb-page-head">
          <div>
            <p className="wb-kicker">报价与销售工作区</p>
            <h1>装机报价</h1>
            <p className="wb-caption">当前账号没有报价查看权限（sales/quote-view）。</p>
          </div>
        </header>
      </div>
    )
  }

  // ─────────────── 编辑视图 ───────────────
  if (view === 'edit') {
    return (
      <div className="wb-page wb-quote-page">
        <header className="wb-page-head">
          <div>
            <p className="wb-kicker">报价与销售工作区</p>
            <h1>{editor.quoteId ? `编辑报价（将生成新版本）` : '新建装机报价'}</h1>
            <p className="wb-caption">
              报价只记录拟售配件，不改库存；转销售单后按实物预留，实际交付才出库。报价金额按元填写；发出后修改会生成新版本，旧版留档。
            </p>
          </div>
          <div className="wb-page-head-actions">
            <button type="button" className="wb-btn" onClick={() => setView('list')} disabled={busy}>
              返回列表
            </button>
          </div>
        </header>

        {notice ? <p className={`wb-inv-notice${notice.kind === 'warn' ? ' wb-inv-notice--warn' : ''}`}>{notice.text}</p> : null}
        {stockPrefillError ? <p className="wb-form-error" role="alert">{stockPrefillError}</p> : null}
        {unknownWrite ? (
          <div className="wb-inv-notice wb-inv-notice--warn">
            <button type="button" className="wb-btn" onClick={checkUnknownResult} disabled={busy}>
              查询结果
            </button>
          </div>
        ) : null}
        {issuedShare ? (
          <div className="wb-inv-notice wb-inv-notice--warn">
            第 {issuedShare.revision} 版的分享凭证明文（只显示这一次）：
            <code>{issuedShare.token}</code>
            <br />
            顾客端页面尚未开通，这条链接暂时打不开；先把编号记下来，顾客端上线后可直接使用。
          </div>
        ) : null}
        {editorError ? <p className="wb-form-error">{editorError}</p> : null}
        {optionsError ? <p className="wb-form-hint">{optionsError}</p> : null}

        <form className="wb-form wb-quote-editor" onSubmit={editor.quoteId ? handleSave : handleCreate}>
          <div className="wb-field">
            <label htmlFor="quote-title">标题</label>
            <input
              id="quote-title"
              value={editor.title}
              onChange={(event) => setEditor((prev) => ({ ...prev, title: event.target.value }))}
              placeholder="例如：i5-14400F 办公主机"
            />
          </div>

          <div className="wb-field">
            <label htmlFor="quote-customer">客户</label>
            <div className="wb-customer-search">
              <input
                aria-label="搜索客户名单"
                value={customerSearch}
                onChange={(event) => { setCustomerSearch(event.target.value); setCustomerNextCursor(null) }}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void searchCustomers() } }}
                placeholder="输入姓名或手机号搜索"
              />
              <button className="wb-btn" type="button" disabled={customerSearchBusy} onClick={() => void searchCustomers()}>
                {customerSearchBusy ? '搜索中…' : '搜索客户'}
              </button>
            </div>
            {customerNextCursor ? (
              <button className="wb-btn wb-customer-search-more" type="button" disabled={customerSearchBusy} onClick={() => void searchCustomers(customerNextCursor)}>
                {customerSearchBusy ? '正在加载…' : customerSearch.trim() ? '加载更多匹配客户' : '加载更多客户'}
              </button>
            ) : null}
            <select
              id="quote-customer"
              value={editor.customerId}
              onChange={(event) => setEditor((prev) => ({ ...prev, customerId: event.target.value }))}
            >
              <option value="">散客（暂不关联）</option>
              {customers.map((customer) => (
                <option key={customer.id} value={String(customer.id)}>
                  {customer.name}
                  {customer.phone ? ` · ${customer.phone}` : ''}
                </option>
              ))}
            </select>
            {customerSearchError ? <p className="wb-form-error">{customerSearchError}</p> : null}
            <p className="wb-form-hint">先显示最近更新的客户；名单较长时按姓名或手机号搜索。客户在「客户台账」里维护；散客可以先不选。</p>
          </div>

          <fieldset className="wb-inv-group">
            <legend>配置行</legend>
            {!editor.quoteId ? <QuotePresetToolbar scenario={scenario} retainedCount={retainedCount} onScenarioChange={(target) => {
              const nextLines = applyQuoteScenario(editor.lines, scenario, target, nextLineKey)
              const previousKeys = new Set(editor.lines.map((line) => line.key))
              const retained = nextLines.filter((line) => previousKeys.has(line.key) && hasQuoteLineInput(line))
              setRetainedCount(retained.length)
              setRetainedKeys(retained.map((line) => line.key))
              setEditor((prev) => ({ ...prev, lines: nextLines }))
              setScenario(target)
            }} onAdd={(category) => setEditor((prev) => ({ ...prev, lines: [...prev.lines, createManualLine(category)] }))} /> : null}
            {editor.lines.some((line) => line.source === 'used') ? (
              <div className="wb-parts-quote-stock-search">
                <label className="wb-field">
                  <span>筛选可选二手配件</span>
                  <input value={stockSearch} onChange={(event) => setStockSearch(event.target.value)} placeholder="型号、规格、内部编号或厂家编号" />
                </label>
                <label className="wb-field">
                  <span>配件类别</span>
                  <select value={stockCategory} onChange={(event) => setStockCategory(event.target.value)}>
                    <option value="">全部类别</option>
                    {stockCategories.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </label>
                <button type="button" className="wb-btn" disabled={stockSearchState === 'loading'} onClick={() => void searchAvailableStock()}>
                  {stockSearchState === 'loading' ? '正在查找…' : '查找可售实物'}
                </button>
                <span>{stockOptions.length} 件可选 · 按编号逐件区分</span>
                {stockSearchState === 'error' ? <p className="wb-form-error">{stockSearchError}</p> : null}
              </div>
            ) : null}
            <div className="wb-quote-lines">
              {editor.lines.map((line, index) => (
                <section key={line.key} className={`wb-quote-line${line.source === 'service' ? ' wb-quote-line--service' : ''}`} aria-label={`第 ${index + 1} 行配置`}>
                  <div className="wb-quote-line-head">
                    <div className="wb-quote-line-heading">
                      {line.category ? <span className="wb-quote-line-category">{line.category}</span> : null}
                      {!line.category ? <span className="wb-quote-line-category">自定义配置</span> : null}
                      {retainedKeys.includes(line.key) ? <span className="wb-quote-retained">已填写内容保留</span> : null}
                    </div>
                    <button
                      type="button"
                      className="wb-btn wb-quote-line-remove"
                      aria-label={`删除第 ${index + 1} 行`}
                      onClick={() => { if (hasQuoteLineInput(line) && !window.confirm('这行已有填写内容，确定删除吗？')) return; setEditor((prev) => ({ ...prev, lines: prev.lines.filter((item) => item.key !== line.key) })) }}
                      disabled={editor.lines.length <= 1}
                    >
                      删除本行
                    </button>
                  </div>
                  <div className={`wb-quote-line-fields${line.source === 'service' ? '' : ' wb-quote-line-fields--with-reference'}`}>
                    <label className="wb-quote-field wb-quote-field--name">
                      <span>商品名称</span>
                      <input
                        aria-label={`第 ${index + 1} 行名称`}
                        value={line.name}
                        onChange={(event) => setEditor((prev) => ({ ...prev, lines: prev.lines.map((item) => (item.key === line.key ? { ...item, name: event.target.value } : item)) }))}
                        placeholder={line.category ? `填写具体商品名称（如 ${line.category} 型号）` : '商品名称'}
                      />
                    </label>
                    <label className="wb-quote-field wb-quote-field--spec">
                      <span>规格</span>
                      <input
                        aria-label={`第 ${index + 1} 行规格`}
                        value={line.spec}
                        onChange={(event) => setEditor((prev) => ({ ...prev, lines: prev.lines.map((item) => (item.key === line.key ? { ...item, spec: event.target.value } : item)) }))}
                        placeholder="可选"
                      />
                    </label>
                    <label className="wb-quote-field wb-quote-field--source">
                      <span>来源</span>
                      <select
                        aria-label={`第 ${index + 1} 行来源`}
                        value={line.source}
                        onChange={(event) =>
                          setEditor((prev) => ({
                            ...prev,
                            lines: prev.lines.map((item) =>
                              item.key === line.key
                                ? { ...item, source: event.target.value as QuoteLineSource, initialSource: item.initialSource ?? item.source, priceYuan: event.target.value === 'customer' ? '0' : item.source === 'customer' ? '' : item.priceYuan, qty: ['used', 'customer'].includes(event.target.value) ? '1' : item.qty, productRef: event.target.value === 'new' ? item.productRef : '', stockItemId: event.target.value === 'used' ? item.stockItemId : '', customerDeviceRef: event.target.value === 'customer' ? item.customerDeviceRef : '' }
                                : item,
                            ),
                          }))
                        }
                      >
                        {(Object.keys(SOURCE_LABELS) as QuoteLineSource[]).map((source) => (
                          <option key={source} value={source}>
                            {SOURCE_LABELS[source]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="wb-quote-field wb-quote-field--quantity">
                      <span>数量</span>
                      <input
                        aria-label={`第 ${index + 1} 行数量`}
                        className="wb-quote-num"
                        value={line.qty}
                        onChange={(event) => setEditor((prev) => ({ ...prev, lines: prev.lines.map((item) => (item.key === line.key ? { ...item, qty: event.target.value } : item)) }))}
                        inputMode="numeric"
                        disabled={line.source === 'used' || line.source === 'customer'}
                      />
                    </label>
                    <label className="wb-quote-field wb-quote-field--price">
                      <span>单价（元）</span>
                      <input
                        aria-label={`第 ${index + 1} 行单价（元）`}
                        className="wb-quote-num"
                        value={line.source === 'customer' ? '0' : line.priceYuan}
                        onChange={(event) => setEditor((prev) => ({ ...prev, lines: prev.lines.map((item) => (item.key === line.key ? { ...item, priceYuan: event.target.value } : item)) }))}
                        inputMode="decimal"
                        placeholder="0.00"
                        disabled={line.source === 'customer'}
                      />
                    </label>
                    <label className="wb-quote-field wb-quote-field--remark">
                      <span>顾客可见备注</span>
                      <input
                        aria-label={`第 ${index + 1} 行备注`}
                        value={line.remark ?? ''}
                        onChange={(event) => setEditor((prev) => ({ ...prev, lines: prev.lines.map((item) => (item.key === line.key ? { ...item, remark: event.target.value } : item)) }))}
                        placeholder="例如：成色九成新"
                      />
                    </label>
                    {line.source === 'used' ? (
                      <label className="wb-quote-field wb-quote-field--reference">
                        <span>关联二手实物</span>
                        {stockOptions.length ? (
                          <select
                            aria-label={`第 ${index + 1} 行实物`}
                            value={line.stockItemId}
                            onChange={(event) => setEditor((prev) => ({ ...prev, lines: prev.lines.map((item) => (item.key === line.key ? { ...item, stockItemId: event.target.value } : item)) }))}
                          >
                            <option value="">选择实物…</option>
                            {stockOptions.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.category} · {item.productName} · {item.assetCode} · {item.condition === 'used' ? '二手' : '新品'} · {item.inspectionStatus === 'passed' ? '已检测' : item.inspectionStatus === 'pending' ? '待检测' : item.inspectionStatus === 'failed' ? '有问题' : '历史未记录'}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            aria-label={`第 ${index + 1} 行实物编号`}
                            value={line.stockItemId}
                            onChange={(event) => setEditor((prev) => ({ ...prev, lines: prev.lines.map((item) => (item.key === line.key ? { ...item, stockItemId: event.target.value } : item)) }))}
                            placeholder="填写实物编号"
                          />
                        )}
                      </label>
                    ) : null}
                    {line.source === 'new' ? (
                      <label className="wb-quote-field wb-quote-field--reference">
                        <span>关联商品</span>
                        <input
                          aria-label={`第 ${index + 1} 行关联商品`}
                          list="wb-quote-product-options"
                          value={line.productRef}
                          onChange={(event) =>
                            setEditor((prev) => ({
                              ...prev,
                              lines: prev.lines.map((item) =>
                                item.key === line.key ? { ...item, productRef: event.target.value } : item,
                              ),
                            }))
                          }
                          placeholder="成交前必填"
                        />
                      </label>
                    ) : null}
                    {line.source === 'customer' ? (
                      <label className="wb-quote-field wb-quote-field--reference">
                        <span>关联顾客设备</span>
                        {devices.length ? (
                          <select
                            aria-label={`第 ${index + 1} 行来源设备`}
                            value={line.customerDeviceRef}
                            onChange={(event) => setEditor((prev) => ({ ...prev, lines: prev.lines.map((item) => (item.key === line.key ? { ...item, customerDeviceRef: event.target.value } : item)) }))}
                          >
                            <option value="">选择设备…</option>
                            {devices.map((device) => (
                              <option key={device.id} value={String(device.id)}>
                                {device.label}
                                {device.serialNumber ? ` · ${device.serialNumber}` : ''}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="wb-form-hint">该客户暂无设备记录</span>
                        )}
                      </label>
                    ) : null}
                  </div>
                </section>
              ))}
            </div>
            <button type="button" className="wb-btn" onClick={() => setEditor((prev) => ({ ...prev, lines: [...prev.lines, createManualLine()] }))}>
              加一行
            </button>
            {/*
              商品清单只在这里出现一次。input 用 list 引用它 —— 下拉里带现货数量，
              报价时就能看出「这个型号现在有几件」，而不是等达到预付款门槛后才发现要采购。
            */}
            <datalist id="wb-quote-product-options">
              {productOptions.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                  {product.sku ? ` · ${product.sku}` : ''}
                  {`（现货 ${product.availableQty}）`}
                </option>
              ))}
            </datalist>
          </fieldset>

          <div className="wb-quote-summary">
            <span>{lineSummary.incompleteCount ? `已填金额合计 ${formatYuan(subtotalCents)} / ${lineSummary.incompleteCount} 项待完善` : lineSummary.emptySlotCount === editor.lines.length ? '小计 —' : `小计 ${formatYuan(subtotalCents)}${lineSummary.emptySlotCount ? ` / ${lineSummary.emptySlotCount} 个空槽不提交` : ''}`}</span>
            <span>优惠 −{formatYuan(discountCents)}</span>
            <strong>应付 {formatYuan(totalCents)}</strong>
            {budgetCents !== null && budgetCents > 0 ? (
              <span className={budgetCents < totalCents ? 'wb-quote-budget-over' : undefined}>
                顾客预算 {formatYuan(budgetCents)}（预算只是参考，不进金额计算）
              </span>
            ) : null}
          </div>

          <div className="wb-quote-terms">
            <div className="wb-field">
              <label htmlFor="quote-discount">优惠（元）</label>
              <input
                id="quote-discount"
                className="wb-quote-num"
                value={editor.discountYuan}
                onChange={(event) => setEditor((prev) => ({ ...prev, discountYuan: event.target.value }))}
                inputMode="decimal"
              />
            </div>
            <div className="wb-field">
              <label htmlFor="quote-budget">顾客预算（元）</label>
              <input
                id="quote-budget"
                className="wb-quote-num"
                value={editor.budgetYuan}
                onChange={(event) => setEditor((prev) => ({ ...prev, budgetYuan: event.target.value }))}
                inputMode="decimal"
              />
            </div>
            <div className="wb-field">
              <label>预付款比例</label>
              <p className="wb-form-hint">首发统一 15%；按已确认应付金额向上取整到分。报价中不能单独改比例。</p>
            </div>
            <div className="wb-field">
              <label htmlFor="quote-delivery">交付方式</label>
              <select
                id="quote-delivery"
                value={editor.deliveryMode}
                onChange={(event) => setEditor((prev) => ({ ...prev, deliveryMode: event.target.value as 'self_pickup' | 'delivery' }))}
              >
                <option value="self_pickup">门店自取</option>
                <option value="delivery">送货（湛江全市）</option>
              </select>
            </div>
            {editor.deliveryMode === 'delivery' ? (
              <>
                <div className="wb-field">
                  <label htmlFor="quote-distance">驾车距离（km）</label>
                  <input
                    id="quote-distance"
                    className="wb-quote-num"
                    value={editor.distanceKm}
                    onChange={(event) => setEditor((prev) => ({ ...prev, distanceKm: event.target.value }))}
                    inputMode="decimal"
                  />
                </div>
                <div className="wb-field">
                  <label>配送收费</label>
                  <p className="wb-form-hint">自动配送计费暂缓。若已与顾客确认人工配送费用，请添加“配送服务”收费行，让金额计入应付与 15% 预付款。</p>
                </div>
              </>
            ) : null}
            <div className="wb-field">
              <label htmlFor="quote-note">备注（顾客可见）</label>
              <input
                id="quote-note"
                value={editor.note}
                onChange={(event) => setEditor((prev) => ({ ...prev, note: event.target.value }))}
              />
            </div>
            {editor.quoteId ? (
              <>
                <div className="wb-field">
                  <label htmlFor="quote-reason">改版原因</label>
                  <input
                    id="quote-reason"
                    value={editor.changeReason}
                    onChange={(event) => setEditor((prev) => ({ ...prev, changeReason: event.target.value }))}
                    placeholder="例如：顾客要求换显卡"
                  />
                </div>
                <div className="wb-field">
                  <label htmlFor="quote-feedback">反馈来源</label>
                  <select
                    id="quote-feedback"
                    value={editor.feedbackSource}
                    onChange={(event) => setEditor((prev) => ({ ...prev, feedbackSource: event.target.value as FeedbackSource }))}
                  >
                    {(Object.keys(FEEDBACK_LABELS) as FeedbackSource[]).map((source) => (
                      <option key={source} value={source}>
                        {FEEDBACK_LABELS[source]}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : null}
          </div>

          <div className="wb-form-actions">
            <button type="submit" className="wb-btn wb-btn--primary" disabled={busy}>
              {editor.quoteId ? '保存新版本' : '创建草稿'}
            </button>
            {editor.quoteId && canEdit ? (
              <button type="button" className="wb-btn wb-btn--primary" onClick={handleIssueFromEditor} disabled={busy}>
                保存并发出
              </button>
            ) : null}
            <button type="button" className="wb-btn" onClick={() => setView('list')} disabled={busy}>
              取消
            </button>
          </div>
          {!canEdit ? <p className="wb-form-hint">当前账号只有查看权限，保存与发出需要 sales/quote-edit。</p> : null}
        </form>
      </div>
    )
  }

  // ─────────────── 详情视图 ───────────────
  if (view === 'detail') {
    if (detailLoading) {
      return (
        <div className="wb-page wb-quote-page">
          <p className="wb-inv-state">正在加载报价单…</p>
        </div>
      )
    }
    if (!detail) {
      return (
        <div className="wb-page wb-quote-page">
          <header className="wb-page-head">
            <div>
              <h1>装机报价</h1>
            </div>
            <div className="wb-page-head-actions">
              <button type="button" className="wb-btn" onClick={() => setView('list')}>
                返回列表
              </button>
            </div>
          </header>
          <p className="wb-inv-state wb-inv-state--error">{detailError ?? '报价单不存在或不属于当前门店'}</p>
        </div>
      )
    }

    const terms = detail.version.termsSnapshot as {
      budgetCents?: number | null
      depositPercent?: number | null
      delivery?: { mode?: string; distanceKm?: number | null; feeCents?: number | null; note?: string | null } | null
      note?: string | null
      changeReason?: string | null
      feedbackSource?: string | null
    }
    const remaining = hoursLeft(detail.version.validUntil)
    // 服务端会把「超过 validUntil 的 issued」直接算成 expired（enums.json 里该转换无动作），
    // 所以续期按钮的判断不能写 `status === 'issued'` —— 那样过期单永远等不到续期按钮（实测抓到）。
    const canRenew = canEdit && Boolean(detail.version.issuedAt) && (detail.expired || detail.expiringSoon)
    // B03：已发出或顾客已确认、且未过期的版本可以成交转销售单（enums.json QuoteStatus：
    // issued → converted 与 confirmed → converted）。过期报价不能成交，先续期 —— 与 B42 同一口径。
    const canConvert =
      canEdit
      && !detail.expired
      && (detail.version.status === 'issued' || detail.version.status === 'confirmed')
    // B42：只对「当前版本 = 已发出且未过期」的报价提供确认入口；
    // 看历史版本（revision 参数）或已过期时不给点，避免确认到不是当前谈的那一版。
    const canConfirm =
      canEdit
      && detail.version.status === 'issued'
      && !detail.expired
      && detail.version.revision === detail.quote.currentRevision

    return (
      <div className="wb-page wb-quote-page">
        <header className="wb-page-head">
          <div>
            <p className="wb-kicker">报价与销售工作区</p>
            <h1>{detail.quote.title}</h1>
            <p className="wb-caption">
              {detail.customer ? `${detail.customer.name}${detail.customer.phone ? ` · ${detail.customer.phone}` : ''} · ` : '散客 · '}
              第 {detail.version.revision} 版 · {STATUS_LABELS[detail.version.status] ?? detail.version.status}
              {detail.version.validUntil ? ` · 有效期至 ${formatDateTime(detail.version.validUntil)}` : ''}
              {detail.expired ? '（已过期）' : detail.expiringSoon && remaining !== null ? `（剩 ${Math.max(0, Math.round(remaining))} 小时）` : ''}
            </p>
          </div>
          <div className="wb-page-head-actions">
            <button type="button" className="wb-btn" onClick={() => setView('list')}>
              返回列表
            </button>
            {canEdit ? (
              <button type="button" className="wb-btn wb-btn--primary" onClick={() => startRevise(detail)}>
                {detail.hasDraft ? '继续编辑草稿' : '改一版'}
              </button>
            ) : null}
            {detail.hasDraft && canEdit ? (
              <button type="button" className="wb-btn wb-btn--primary" onClick={() => issueFromDetail(detail, null)} disabled={busy}>
                发出草稿版
              </button>
            ) : null}
            {canRenew ? (
              <button type="button" className="wb-btn wb-btn--primary" onClick={handleRenew} disabled={busy}>
                续期 24 小时
              </button>
            ) : null}
            {canConfirm ? (
              <>
                <select
                  aria-label="确认来源"
                  value={confirmSource}
                  onChange={(event) => setConfirmSource(event.target.value as FeedbackSource)}
                >
                  {(Object.keys(FEEDBACK_LABELS) as FeedbackSource[]).map((source) => (
                    <option key={source} value={source}>
                      {FEEDBACK_LABELS[source]}
                    </option>
                  ))}
                </select>
                <button type="button" className="wb-btn wb-btn--primary" onClick={handleConfirm} disabled={busy}>
                  记录顾客确认
                </button>
              </>
            ) : null}
            {canConvert ? (
              <button type="button" className="wb-btn wb-btn--primary" onClick={() => void handleConvert()} disabled={busy}>
                确认成交（转销售单）
              </button>
            ) : null}
            <button type="button" className="wb-btn" onClick={() => openPrintWindow(detail, detail.settings)}>
              打印配置单
            </button>
            <button type="button" className="wb-btn" onClick={() => void handleExportHtml()} disabled={documentBusy}>
              {documentBusy ? '正在生成…' : '导出脱敏 HTML'}
            </button>
          </div>
        </header>

        {notice ? <p className={`wb-inv-notice${notice.kind === 'warn' ? ' wb-inv-notice--warn' : ''}`}>{notice.text}</p> : null}
        {unknownWrite ? (
          <div className="wb-inv-notice wb-inv-notice--warn">
            <button type="button" className="wb-btn" onClick={checkUnknownResult} disabled={busy}>
              查询结果
            </button>
          </div>
        ) : null}
        {issuedShare ? (
          <div className="wb-inv-notice wb-inv-notice--warn">
            第 {issuedShare.revision} 版的分享凭证明文（只显示这一次）：<code>{issuedShare.token}</code>
            <br />
            顾客端页面尚未开通，这条链接暂时打不开；先把编号记下来，顾客端上线后可直接使用。
          </div>
        ) : null}
        {detail.share ? (
          <p className="wb-form-hint">
            本版本已签发分享凭证（{formatDateTime(detail.share.createdAt)} 签发
            {detail.share.expiresAt ? `，${formatDateTime(detail.share.expiresAt)} 失效` : ''}）。明文链接只在发出当时显示过一次。
          </p>
        ) : null}
        {detail.version.status === 'confirmed' ? (
          <p className="wb-form-hint">
            顾客已确认第 {detail.version.revision} 版
            {detail.version.confirmedAt ? `（${formatDateTime(detail.version.confirmedAt)}` : '（'}
            {detail.version.confirmedSource ? ` · 来源：${FEEDBACK_LABELS[detail.version.confirmedSource as FeedbackSource] ?? detail.version.confirmedSource}` : ''}
            ）。确认 ≠ 付款，达到已核实的预付款门槛后才尝试预留库存；要改请先「改一版」出新版本，重新发出并再次确认。
          </p>
        ) : null}

        <div className="wb-inv-group">
          <div className="wb-inv-head">
            <span>配置明细（第 {detail.version.revision} 版）</span>
            <span>共 {detail.lines.length} 行</span>
          </div>
          <div className="wb-quote-table-scroll" role="region" aria-label="报价数据表" tabIndex={0}><table className="wb-quote-table">
            <thead>
              <tr>
                <th>#</th>
                <th>项目</th>
                <th>来源</th>
                <th className="wb-tabular">数量</th>
                <th className="wb-tabular">单价</th>
                <th className="wb-tabular">小计</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {detail.lines.map((line) => (
                <tr key={line.id}>
                  <td className="wb-tabular">{line.position + 1}</td>
                  <td>
                    {line.nameSnapshot}
                    {line.specSnapshot ? <span className="wb-quote-spec"> {line.specSnapshot}</span> : null}
                    {line.source === 'used' && line.stockItemAvailability ? (
                      <span className={`wb-quote-stock wb-quote-stock--${line.stockItemAvailability}`}>
                        {AVAILABILITY_LABELS[line.stockItemAvailability]}
                      </span>
                    ) : null}
                  </td>
                  <td>{SOURCE_LABELS[line.source] ?? line.source}</td>
                  <td className="wb-tabular">{line.qty}</td>
                  <td className="wb-tabular">{formatYuan(line.unitPriceCents)}</td>
                  <td className="wb-tabular">{formatYuan(line.lineTotalCents)}</td>
                  <td>{String(line.warrantySnapshot?.remark ?? '')}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <div className="wb-quote-summary">
            <span>小计 {formatYuan(detail.version.subtotalCents)}</span>
            <span>优惠 −{formatYuan(detail.version.discountCents)}</span>
            <strong>应付 {formatYuan(detail.version.totalCents)}</strong>
            {terms.budgetCents ? (
              <span className={terms.budgetCents < detail.version.totalCents ? 'wb-quote-budget-over' : undefined}>
                顾客预算 {formatYuan(terms.budgetCents)}
              </span>
            ) : null}
          </div>
        </div>

        <div className="wb-quote-terms-view">
          <h2>条款</h2>
          <ul>
            <li>预付款比例：{terms.depositPercent ?? detail.settings.depositPercent}%（退款按订单条款及适用规定处理；顾客确认后本版本配置与价格锁定）</li>
            <li>交付：{terms.delivery?.mode === 'delivery' ? `送货${terms.delivery.note ? `（${terms.delivery.note}）` : '，运费档位待设置'}` : '门店自取'}</li>
            {terms.note ? <li>备注：{terms.note}</li> : null}
            {terms.changeReason ? <li>改版原因：{terms.changeReason}（{FEEDBACK_LABELS[(terms.feedbackSource as FeedbackSource) ?? 'offline']}）</li> : null}
          </ul>
        </div>

        {detail.revisions.length > 1 ? (
          <div className="wb-inv-group">
            <div className="wb-inv-head">
              <span>版本历史</span>
              <span>共 {detail.revisions.length} 版</span>
            </div>
            <div className="wb-quote-table-scroll" role="region" aria-label="报价数据表" tabIndex={0}><table className="wb-quote-table">
              <thead>
                <tr>
                  <th>版本</th>
                  <th>状态</th>
                  <th>发出时间</th>
                  <th>有效期至</th>
                  <th className="wb-tabular">应付</th>
                  <th className="wb-tabular">行数</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {detail.revisions.map((revision) => (
                  <tr key={revision.revision}>
                    <td className="wb-tabular">v{revision.revision}</td>
                    <td>{STATUS_LABELS[revision.status] ?? revision.status}</td>
                    <td>{formatDateTime(revision.issuedAt)}</td>
                    <td>{formatDateTime(revision.validUntil)}</td>
                    <td className="wb-tabular">{formatYuan(revision.totalCents)}</td>
                    <td className="wb-tabular">{revision.lineCount}</td>
                    <td>
                      <button type="button" className="wb-btn" onClick={() => openDetail(detail.quote.id, revision.revision)}>
                        查看
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        ) : null}
      </div>
    )
  }

  // ─────────────── 列表视图 ───────────────
  const filters: Array<{ key: QuoteStatusFilter | 'all'; label: string }> = [
    { key: 'all', label: '全部' },
    { key: 'draft', label: '草稿' },
    { key: 'issued', label: '已发出' },
    { key: 'expired', label: '已过期' },
  ]

  return (
    <div className="wb-page wb-quote-page">
      <header className="wb-page-head">
        <div>
          <p className="wb-kicker">报价与销售工作区</p>
          <h1>装机报价</h1>
          <p className="wb-caption">
            草稿 → 发出 → 记录顾客确认（不锁库存）→ 确认成交转销售单 → 到「订单处理」收款后锁货。
            有效期 {list?.settings.validityHours ?? 24} 小时，到期前 {list?.settings.reminderLeadHours ?? 2} 小时在这里标出。
          </p>
        </div>
        <div className="wb-page-head-actions">
          {canManageStore ? <a className="wb-btn" href="/settings/data-cleanup#quote-drafts">删除未发出报价</a> : null}
          {canEdit ? (
            <button type="button" className="wb-btn wb-btn--primary" onClick={startCreate}>
              新建装机报价
            </button>
          ) : null}
        </div>
      </header>

      <div className="wb-inv-toolbar">
        <div className="wb-filter-row" role="group" aria-label="状态筛选">
          {filters.map((filter) => (
            <button
              key={filter.key}
              type="button"
              className={`wb-btn${statusFilter === filter.key ? ' wb-btn--primary' : ''}`}
              onClick={() => setStatusFilter(filter.key)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <input
          className="wb-inv-search"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder="搜标题或客户名"
          aria-label="搜索报价单"
        />
      </div>

      {list ? (
        <p className="wb-inv-totals">
          草稿 {list.totals.draft} · 在谈 {list.totals.issued}（{formatYuan(list.totals.issuedAmountCents)}） · 已确认 {list.totals.confirmed} · 已过期 {list.totals.expired}
        </p>
      ) : null}

      {listError ? <p className="wb-inv-state wb-inv-state--error">{listError}</p> : null}
      {listLoading ? <p className="wb-inv-state">正在加载…</p> : null}
      {!listLoading && list && list.quotes.length === 0 ? (
        <p className="wb-inv-state">
          {statusFilter === 'all' && !searchText ? '还没有报价单。点右上角「新建装机报价」开始第一单。' : '没有符合条件的报价单。'}
        </p>
      ) : null}

      {list && list.quotes.length > 0 ? (
        <div className="wb-quote-table-scroll" role="region" aria-label="报价数据表" tabIndex={0}><table className="wb-quote-table">
          <thead>
            <tr>
              <th>标题</th>
              <th>客户</th>
              <th>状态</th>
              <th className="wb-tabular">明细</th>
              <th className="wb-tabular">版本</th>
              <th className="wb-tabular">应付</th>
              <th>有效期</th>
              <th>更新时间</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.quotes.map((row) => (
              <tr key={row.id}>
                <td>{row.title}</td>
                <td>{row.customerName ?? '散客'}</td>
                <td>
                  {STATUS_LABELS[row.status] ?? row.status}
                  {row.status === 'draft' && row.publishedRevision !== null ? (
                    <span className="wb-quote-stock">（已发出 v{row.publishedRevision} · {STATUS_LABELS[row.publishedStatus ?? ''] ?? row.publishedStatus} · {row.publishedTotalCents === null ? '金额缺失' : formatYuan(row.publishedTotalCents)}）</span>
                  ) : null}
                  {row.expiringSoon && !row.expired ? <span className="wb-quote-stock wb-quote-stock--reserved">（即将到期）</span> : null}
                </td>
                <td className="wb-tabular">{row.lineCount === null ? '—' : `${row.lineCount} 行`}</td>
                <td className="wb-tabular">v{row.workRevision ?? '—'}</td>
                <td className="wb-tabular">{row.totalCents === null ? '—' : formatYuan(row.totalCents)}</td>
                <td>{row.validUntil ? formatDateTime(row.validUntil) : '—'}</td>
                <td>{formatDateTime(row.updatedAt)}</td>
                <td>
                  <button
                    type="button"
                    className="wb-btn"
                    onClick={() => {
                      setIssuedShare(null)
                      openDetail(row.id)
                    }}
                  >
                    查看
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : null}
    </div>
  )
}
