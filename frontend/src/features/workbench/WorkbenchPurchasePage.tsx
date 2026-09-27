/**
 * E07 · 缺件采购与到货页（网页端 ERP）。
 *
 * 一页两态：列表 → 详情（含分批到货与退供）。数据全部来自
 * `/api/v2/inventory/purchases*`，没有演示数据；服务端给什么就显示什么。
 *
 * 业务口径（docs/plans/2026-09-19-erp-first/ai-tasks/05-fulfillment.md 05b）：
 *   · 采购 5 件只到 3 件 → 在途自动剩 2；补到齐后进度变「到货完成」。
 *     在途不是记上去的状态，是 订购 − 实到 − 拒收 的派生值，所以不会出现两个真相。
 *   · 拒收的件不进可用量：处置去向选「退回供应商 / 报废」时数量要填在拒收里，
 *     这些货从未进入自有在库，也不会在途还挂着。
 *   · 现买现入（快速采购）不挂采购单，但仍要填商品、数量与成本，来源照样可查；
 *     成本未知就留空，不写 0。
 *   · 退供只能从可取或待处理库存出发，已成交占用的件不能退 —— 那会拆掉别的订单的货。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { formatYuan } from './inventory-view'
import './WorkbenchPurchasePage.css'
import {
  createPurchase,
  cancelPurchase,
  fetchPurchaseDetail,
  fetchPurchases,
  payPurchase,
  purchaseClient,
  registerReceipt,
  returnToSupplier,
} from './purchase-api'
import type {
  CashMethod,
  InspectionDisposition,
  PurchaseDetailPayload,
  PurchaseListPayload,
  PurchaseWriteOutcome,
} from './purchase-api'
import '../../styles/workbench.css'

const DISPOSITION_LABELS: Record<InspectionDisposition, string> = {
  available: '收下入库（可卖）',
  quarantine: '收下待检',
  return_to_supplier: '当场退回供应商',
  return_to_customer: '退还客户',
  scrapped: '报废',
}

/** 老板是 `*`；店员按契约码或旧码判断（与 domains/access.ts 的 LEGACY_EQUIVALENT 同源）。 */
function hasAny(permissions: readonly string[], codes: readonly string[]): boolean {
  return permissions.includes('*') || codes.some((code) => permissions.includes(code))
}

const VIEW_CODES = ['inventory/view', 'library/view']
const CREATE_CODES = ['inventory/purchase-create', 'library/edit']
const RECEIPT_CODES = ['inventory/receipt', 'library/edit']
const RETURN_CODES = ['inventory/supplier-return', 'library/edit']
const PAYMENT_CODES = ['finance/payment']
const CANCEL_CODES = ['inventory/purchase-cancel', 'library/edit']

const CASH_METHOD_LABELS: Record<CashMethod, string> = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝',
  bank: '银行转账',
  other: '其他',
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function yuanToCents(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}

type Notice = { kind: 'ok' | 'warn' | 'error'; text: string } | null
type UnknownWrite = { requestId: string; what: string } | null
type View = 'list' | 'detail' | 'create'

/** 新建采购时的一行。 */
interface DraftLine {
  productRef: string
  productLabel?: string
  qtyOrdered: string
  costYuan: string
}

export function WorkbenchPurchasePage({ permissions }: { permissions: string[] }) {
  const searchParams = new URLSearchParams(window.location.search)
  const sourceOrderNo = searchParams.get('sourceOrderNo')?.trim() ?? ''
  const linkedPurchaseId = searchParams.get('purchaseId')?.trim() ?? ''
  const prefilledProductRef = searchParams.get('productRef')?.trim() ?? ''
  const prefilledProductLabel = searchParams.get('productLabel')?.trim() ?? ''
  const requestedPrefillQty = Number(searchParams.get('qty'))
  const prefilledQtyOrdered = Number.isInteger(requestedPrefillQty) && requestedPrefillQty > 0 ? String(requestedPrefillQty) : '1'
  const prefilledCostYuan = searchParams.get('costYuan')?.trim() ?? ''
  const prefilledReceiptCondition = searchParams.get('receiptCondition') === 'new' ? 'new' : 'used'
  const prefilledReceiptSerials = (() => {
    try {
      const value = searchParams.get('receiptSerials')
      if (!value) return []
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) && parsed.length <= 50
        ? parsed.map((item) => typeof item === 'string' ? item : '')
        : []
    } catch { return [] }
  })()
  const prefilledReceiptBatchRemark = searchParams.get('receiptBatchRemark') ?? ''
  const prefilledReceiptItemRemark = searchParams.get('receiptItemRemark') ?? ''
  const startNewPurchase = searchParams.get('new') === '1'
  const openedLinkedRecord = useRef<string | null>(null)
  const [view, setView] = useState<View>('list')
  const [list, setList] = useState<PurchaseListPayload | null>(null)
  const [detail, setDetail] = useState<PurchaseDetailPayload | null>(null)
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [scope, setScope] = useState<'all' | 'open' | 'done'>('open')
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [actionError, setActionError] = useState('')
  const [unknownWrite, setUnknownWrite] = useState<UnknownWrite>(null)
  const [checkingUnknown, setCheckingUnknown] = useState(false)

  // 新建采购
  const [supplierName, setSupplierName] = useState('')
  const [supplierNote, setSupplierNote] = useState('')
  const [expectedAt, setExpectedAt] = useState('')
  const [draftLines, setDraftLines] = useState<DraftLine[]>([{ productRef: prefilledProductRef, productLabel: prefilledProductLabel, qtyOrdered: prefilledQtyOrdered, costYuan: prefilledCostYuan }])

  // 到货
  const [receiptLineId, setReceiptLineId] = useState('')
  const [receiptQty, setReceiptQty] = useState('')
  const [receiptRejected, setReceiptRejected] = useState('0')
  const [receiptDisposition, setReceiptDisposition] = useState<InspectionDisposition>('available')
  const [receiptCondition, setReceiptCondition] = useState<'new' | 'used'>(prefilledReceiptCondition)
  const [receiptItems, setReceiptItems] = useState(prefilledReceiptSerials.join('\n'))
  const [receiptBatchRemark, setReceiptBatchRemark] = useState(prefilledReceiptBatchRemark)
  const [receiptItemRemark, setReceiptItemRemark] = useState(prefilledReceiptItemRemark)

  // 退供
  const [returnLineId, setReturnLineId] = useState('')
  const [returnQty, setReturnQty] = useState('1')
  const [returnReason, setReturnReason] = useState('')
  const [returnBucket, setReturnBucket] = useState<'available' | 'quarantine'>('available')

  // 付款
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<CashMethod>('bank')
  const [paymentRemark, setPaymentRemark] = useState('')
  const [cancelQuantities, setCancelQuantities] = useState<Record<string, string>>({})
  const [cancelReason, setCancelReason] = useState<'supplier_unavailable' | 'supplier_delay' | 'customer_cancelled' | 'duplicate_purchase'>('supplier_unavailable')
  const [cancelNote, setCancelNote] = useState('')

  const canView = hasAny(permissions, VIEW_CODES)
  const canCreate = hasAny(permissions, CREATE_CODES)
  const canReceive = hasAny(permissions, RECEIPT_CODES)
  const canReturn = hasAny(permissions, RETURN_CODES)
  const canPay = hasAny(permissions, PAYMENT_CODES)
  const canCancel = hasAny(permissions, CANCEL_CODES)

  // ⚠️ 不在本函数的开头同步 setState：「在 effect 里同步 setState」会被 lint 判为级联渲染。
  // 加载态由初始值与事件处理设置（WorkbenchInventoryPage 用同一个写法绕过）。
  const loadList = useCallback(async (nextScope: 'all' | 'open' | 'done', q: string) => {
    const result = await fetchPurchases({
      scope: nextScope === 'all' ? null : nextScope,
      q: q || null,
      limit: 200,
    })
    if (result.ok) {
      setList(result.data)
      setListState('ready')
      return
    }
    setListState('error')
    setActionError(result.message)
  }, [])

  const refresh = useCallback(() => {
    setListState('loading')
    void loadList(scope, keyword)
  }, [loadList, scope, keyword])

  const openDetail = useCallback(async (purchaseId: string) => {
    setView('detail')
    setDetailState('loading')
    setDetail(null)
    setActionError('')
    setNotice(null)
    const result = await fetchPurchaseDetail(purchaseId)
    if (result.ok) {
      setDetail(result.data)
      setDetailState('ready')
      const first = result.data.lines.find((line) => line.pendingQty > 0) ?? result.data.lines[0]
      setReceiptLineId(first?.id ?? '')
      setReceiptQty(first && first.pendingQty > 0 ? String(first.pendingQty) : '')
      setReceiptRejected('0')
      setReturnLineId(result.data.lines[0]?.id ?? '')
      setPaymentAmount('')
      setPaymentRemark('')
      setCancelQuantities(Object.fromEntries(result.data.lines.filter((line) => line.pendingQty > 0).map((line) => [line.id, String(line.pendingQty)])))
      setCancelNote('')
      return
    }
    setDetailState('error')
    setActionError(result.message)
  }, [])

  useEffect(() => {
    if (!canView) return
    let active = true
    void Promise.resolve().then(() => {
      if (!active) return
      if (linkedPurchaseId && openedLinkedRecord.current !== linkedPurchaseId) {
        openedLinkedRecord.current = linkedPurchaseId
        void openDetail(linkedPurchaseId)
      } else if (!linkedPurchaseId && canCreate && (startNewPurchase || prefilledProductRef) && openedLinkedRecord.current !== 'new-purchase') {
        openedLinkedRecord.current = 'new-purchase'
        setView('create')
      }
    })
    return () => { active = false }
  }, [canView, canCreate, linkedPurchaseId, startNewPurchase, prefilledProductRef, openDetail])

  // ⚠️ effect 里必须把 setState 放在 .then 回调中（`react-hooks/set-state-in-effect`）。
  useEffect(() => {
    if (!canView) return
    let active = true
    void fetchPurchases({ scope: scope === 'all' ? null : scope, q: keyword || null, limit: 200 }).then((result) => {
      if (!active) return
      if (result.ok) {
        setList(result.data)
        setListState('ready')
        return
      }
      setListState('error')
      setActionError(result.message)
    })
    return () => {
      active = false
    }
  }, [canView, scope, keyword])

  const runWrite = useCallback(
    async (what: string, action: () => Promise<{ ok: boolean; message?: string; data?: PurchaseWriteOutcome }>): Promise<PurchaseWriteOutcome | null> => {
      setBusy(true)
      setActionError('')
      const result = await action()
      setBusy(false)
      if (result.ok && result.data) return result.data
      if (!result.ok && result.message !== undefined) {
        const fail = result as { ok: false; unknownResult?: boolean; requestId?: string | null; message: string }
        if (fail.unknownResult && fail.requestId) {
          setUnknownWrite({ requestId: fail.requestId, what })
          setNotice({ kind: 'warn', text: `${what}：网络没有给出明确结果。先查询编号；若后台查不到，保留原输入并按相同内容重试会复用此请求号。` })
          return null
        }
        setActionError(fail.message)
        return null
      }
      setActionError(result.message ?? '操作失败')
      return null
    },
    [],
  )

  const checkUnknownWrite = useCallback(async () => {
    if (!unknownWrite) return
    setCheckingUnknown(true)
    try {
      const result = await purchaseClient.client.queryOperation(unknownWrite.requestId)
      if (result.status === 'pending') {
        setNotice({ kind: 'warn', text: `「${unknownWrite.what}」仍在处理中，稍后可再查询。` })
        return
      }
      if (result.status === 'unknown') {
        setNotice({ kind: 'warn', text: `后台暂时查不到「${unknownWrite.what}」。表单内容已保留；确认未执行后可按原内容重试。` })
        return
      }

      purchaseClient.client.resolvePendingAction(unknownWrite.requestId)
      setUnknownWrite(null)
      if (result.status === 'succeeded') {
        await loadList(scope, keyword)
        if (detail) await openDetail(detail.purchase.id)
        else if (unknownWrite.what === '新建采购单' && result.resultRef) {
          setSupplierName('')
          setSupplierNote('')
          setExpectedAt('')
          setDraftLines([{ productRef: '', qtyOrdered: '1', costYuan: '' }])
          await openDetail(result.resultRef)
        }
        setNotice({ kind: 'ok', text: `「${unknownWrite.what}」已由后台确认为成功。` })
        return
      }
      setActionError(`「${unknownWrite.what}」已确认未成功：${result.message || result.code || '原因未知'}。修正内容后可重新提交。`)
    } finally {
      setCheckingUnknown(false)
    }
  }, [unknownWrite, loadList, scope, keyword, detail, openDetail])

  const handleCreate = useCallback(async () => {
    const lines = draftLines
      .filter((line) => line.productRef.trim())
      .map((line) => {
        const qty = Number(line.qtyOrdered.trim() || '0')
        const cost = yuanToCents(line.costYuan)
        return {
          productRef: line.productRef.trim(),
          qtyOrdered: Number.isInteger(qty) ? qty : 0,
          unitCostCents: cost,
          costKnown: cost !== null,
        }
      })
    if (lines.length === 0) {
      setActionError('至少填一行要采购的商品')
      return
    }
    if (!supplierName.trim()) {
      setActionError('请填写供应商名称（快捷供应商直接写档口名即可）')
      return
    }
    const done = await runWrite('新建采购单', () =>
      createPurchase({
        supplierName: supplierName.trim(),
        supplierNote: supplierNote.trim() || null,
        expectedAt: expectedAt || null,
        lines,
      }),
    )
    if (done) {
      setSupplierName('')
      setSupplierNote('')
      setExpectedAt('')
      setDraftLines([{ productRef: '', qtyOrdered: '1', costYuan: '' }])
      await loadList(scope, keyword)
      if (done.entityId) await openDetail(done.entityId)
      // 提示放在刷新之后：openDetail 会清掉上一轮提示，先设会被自己的刷新抹掉。
      setNotice({ kind: 'ok', text: done.summary || '已建采购单' })
    }
  }, [draftLines, supplierName, supplierNote, expectedAt, runWrite, loadList, scope, keyword, openDetail])

  const handleCancel = useCallback(async () => {
    if (!detail) return
    const lines = detail.lines.map((line) => ({ purchaseLineId: line.id, qty: Number(cancelQuantities[line.id] ?? '0') }))
      .filter((line) => Number.isInteger(line.qty) && line.qty > 0)
    if (lines.length === 0) {
      setActionError('至少填写一行要取消的未到数量')
      return
    }
    const done = await runWrite('取消未到数量', () => cancelPurchase({ purchaseId: detail.purchase.id, lines, reason: cancelReason, note: cancelNote.trim() || null }))
    if (done) {
      await openDetail(detail.purchase.id)
      setNotice({ kind: 'ok', text: done.summary || '已取消未到数量' })
    }
  }, [detail, cancelQuantities, cancelReason, cancelNote, runWrite, openDetail])

  const handleReceipt = useCallback(async () => {
    if (!detail) return
    const target = detail.lines.find((line) => line.id === receiptLineId)
    if (!target || !target.productRef) {
      setActionError('请选择要登记的采购行')
      return
    }
    const qty = Number(receiptQty.trim() || '0')
    const rejected = Number(receiptRejected.trim() || '0')
    if (!Number.isInteger(qty) || qty < 0 || !Number.isInteger(rejected) || rejected < 0) {
      setActionError('实到与拒收数量要填非负整数')
      return
    }
    if (qty + rejected === 0) {
      setActionError('实到和拒收至少要填一个')
      return
    }
    // 「不进库」的去向必须把数量填在拒收里 —— 与服务端的校验同一口径，提前说清楚。
    const stocked = receiptDisposition === 'available' || receiptDisposition === 'quarantine'
    if (!stocked && qty > 0) {
      setActionError('这个处置去向的货不进店有库存，请把数量填在「拒收」里')
      return
    }
    const rawSerialLines = receiptItems.trim() ? receiptItems.split(/\r?\n/).map((line) => line.trim()) : []
    const items = rawSerialLines.map((value) => ({ snRaw: value || null, remark: receiptItemRemark.trim() || null }))

    const done = await runWrite('登记到货', () =>
      registerReceipt({
        purchaseId: detail.purchase.id,
        lines: [{
          purchaseLineId: target.id,
          productRef: target.productRef as string,
          qtyReceived: qty,
          qtyRejected: rejected,
          disposition: receiptDisposition,
          condition: receiptCondition,
          items,
          batchRemark: receiptBatchRemark.trim() || null,
        }],
      }),
    )
    if (done) {
      setReceiptItems('')
      setReceiptBatchRemark('')
      setReceiptItemRemark('')
      setReceiptRejected('0')
      await loadList(scope, keyword)
      await openDetail(detail.purchase.id)
      setNotice({ kind: 'ok', text: done.summary || '已登记到货' })
    }
  }, [detail, receiptLineId, receiptQty, receiptRejected, receiptDisposition, receiptCondition, receiptItems, receiptBatchRemark, receiptItemRemark, runWrite, loadList, scope, keyword, openDetail])

  const handleReturn = useCallback(async () => {
    if (!detail || !returnLineId) return
    const qty = Number(returnQty.trim() || '0')
    if (!Number.isInteger(qty) || qty < 1) {
      setActionError('退供数量必须是正整数')
      return
    }
    const target = detail.lines.find((line) => line.id === returnLineId)
    if (!target) return
    const done = await runWrite('退供', () =>
      returnToSupplier({
        purchaseId: detail.purchase.id,
        productRef: target.productRef,
        qty,
        fromBucket: returnBucket,
        reason: returnReason.trim() || '未填写原因',
        supplierName: detail.purchase.supplierName,
      }),
    )
    if (done) {
      setReturnReason('')
      await loadList(scope, keyword)
      await openDetail(detail.purchase.id)
      setNotice({ kind: 'ok', text: done.summary || '已退供' })
    }
  }, [detail, returnLineId, returnQty, returnBucket, returnReason, runWrite, loadList, scope, keyword, openDetail])

  const handlePayment = useCallback(async () => {
    if (!detail) return
    const amountCents = yuanToCents(paymentAmount)
    if (amountCents === null || amountCents <= 0) {
      setActionError('付款金额必须是正数，按元填写')
      return
    }
    const done = await runWrite('采购付款', () =>
      payPurchase(detail.purchase.id, {
        amountCents,
        method: paymentMethod,
        remark: paymentRemark.trim() || null,
      }),
    )
    if (done) {
      setPaymentAmount('')
      setPaymentRemark('')
      await loadList(scope, keyword)
      await openDetail(detail.purchase.id)
      setNotice({ kind: 'ok', text: done.summary || '已登记采购付款' })
    }
  }, [detail, paymentAmount, paymentMethod, paymentRemark, runWrite, loadList, scope, keyword, openDetail])

  if (!canView) {
    return (
      <div className="wb-page wb-purchase-page">
        <div className="wb-page-head">
          <div>
            <p className="wb-kicker">采购与到货</p>
            <h1>缺件处理</h1>
          </div>
        </div>
        <p className="wb-inv-notice wb-inv-notice--warn">
          当前账号没有查看采购的权限。请联系老板开通「查看库存汇总、采购单与流水」。
        </p>
      </div>
    )
  }

  const selectedLine = detail?.lines.find((line) => line.id === receiptLineId)

  return (
    <div className="wb-page wb-purchase-page">
      <div className="wb-page-head">
        <div>
          <p className="wb-kicker">采购与到货</p>
          <h1>{view === 'list' ? '缺件处理' : view === 'create' ? '新建采购单' : detail?.purchase.purchaseNo ?? '采购单'}</h1>
          <p className="wb-caption">
            {view === 'list'
              ? '缺件在这里下单、到货、分批收齐。在途 = 订购 − 实到 − 拒收，永远是算出来的。'
              : view === 'create'
                ? '供应商可以直接写名字（快捷供应商），不必先建档。'
                : '到货按批登记：这一轮到多少填多少，剩下的还在在途。'}
          </p>
        </div>
        <div className="wb-page-head-actions">
          {view !== 'list' ? (
            <button type="button" className="wb-btn" onClick={() => { setView('list'); setDetail(null) }}>
              返回列表
            </button>
          ) : null}
          {view === 'list' && canCreate ? (
            <button type="button" className="wb-btn wb-btn--primary" onClick={() => { setView('create'); setNotice(null); setActionError('') }}>
              新建采购单
            </button>
          ) : null}
          <button type="button" className="wb-btn" onClick={refresh} disabled={busy}>
            刷新
          </button>
        </div>
      </div>

      {sourceOrderNo ? (
        <p className="wb-inv-notice" role="status">
          从销售待办 {sourceOrderNo} 进入。请在此核对采购行并登记到货；完成后回销售单补分配实物。
          {' '}
          <a className="wb-btn" href={`/sales/orders?orderNo=${encodeURIComponent(sourceOrderNo)}`}>回到销售单</a>
        </p>
      ) : null}

      {notice ? (
        <p className={`wb-inv-notice${notice.kind === 'warn' ? ' wb-inv-notice--warn' : ''}`}>{notice.text}</p>
      ) : null}
      {unknownWrite ? (
        <p className="wb-inv-notice wb-inv-notice--warn">
          「{unknownWrite.what}」的结果还没确认（请求编号 {unknownWrite.requestId}）。
          <button type="button" className="wb-btn" disabled={checkingUnknown} onClick={() => void checkUnknownWrite()}>
            {checkingUnknown ? '查询中…' : '查询结果'}
          </button>
        </p>
      ) : null}

      {view === 'list' ? (
        <>
          {list ? (
            <div className="wb-inv-totals">
              <span>采购单<b>{list.totals.all}</b></span>
              <span>未到齐<b>{list.totals.pending}</b></span>
              <span>已到齐<b>{list.totals.completed}</b></span>
              <span>在途总件数<b>{list.totals.pendingQty}</b></span>
            </div>
          ) : null}

          <div className="wb-inv-toolbar">
            <div className="wb-filter-row">
              {([['open', '未到齐'], ['done', '已到齐'], ['all', '全部']] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`wb-btn${scope === value ? ' wb-btn--primary' : ''}`}
                  onClick={() => { setListState('loading'); setScope(value) }}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="wb-inv-search">
              <span className="wb-caption">搜索</span>
              <input value={keyword} placeholder="单号或供应商" onChange={(event) => setKeyword(event.target.value)} />
            </label>
          </div>

          {listState === 'loading' ? <p className="wb-inv-state">正在加载采购单…</p> : null}
          {listState === 'error' ? (
            <div className="wb-inv-state wb-inv-state--error">
              <p>{actionError || '采购单加载失败'}</p>
              <button type="button" className="wb-btn" onClick={refresh}>重试</button>
            </div>
          ) : null}
          {listState === 'ready' && (list?.purchases.length ?? 0) === 0 ? (
            <p className="wb-inv-state">
              没有符合条件的采购单。缺件可以从订单详情里看到，也可以直接在这里新建采购单。
            </p>
          ) : null}

          {listState === 'ready' && (list?.purchases.length ?? 0) > 0 ? (
            <div className="wb-quote-table-scroll">
              <table className="wb-quote-table">
                <thead>
                  <tr>
                    <th>单号</th>
                    <th>供应商</th>
                    <th>订购</th>
                    <th>实到</th>
                    <th>拒收</th>
                    <th>在途</th>
                    <th>进度</th>
                    <th>剩余应付</th>
                    <th>创建</th>
                  </tr>
                </thead>
                <tbody>
                  {list?.purchases.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <button type="button" className="wb-btn" onClick={() => void openDetail(row.id)}>
                          {row.purchaseNo}
                        </button>
                      </td>
                      <td>{row.supplierName || '未填供应商'}</td>
                      <td className="wb-tabular">{row.orderedQty}</td>
                      <td className="wb-tabular">{row.receivedQty}</td>
                      <td className="wb-tabular">{row.rejectedQty}</td>
                      <td className="wb-tabular">
                        <span className={`wb-quote-stock wb-quote-stock--${row.pendingQty > 0 ? 'reserved' : 'available'}`}>
                          {row.pendingQty}
                        </span>
                      </td>
                      <td>{row.progress}</td>
                      <td className="wb-tabular">{formatYuan(row.remainingPayableCents)}</td>
                      <td className="wb-caption">{formatDateTime(row.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}

      {view === 'create' ? (
        <div className="wb-inv-toolbar wb-form">
          {actionError ? <p className="wb-inv-notice wb-inv-notice--warn">{actionError}</p> : null}
          <fieldset>
            <legend>供应商</legend>
            <label className="wb-field">
              <span>供应商名称（快捷建档）</span>
              <input value={supplierName} onChange={(event) => setSupplierName(event.target.value)} placeholder="例：华强北路 3 号档口" />
            </label>
            <label className="wb-field">
              <span>说明</span>
              <input value={supplierNote} onChange={(event) => setSupplierNote(event.target.value)} placeholder="可留空（散采说明）" />
            </label>
            <label className="wb-field">
              <span>预计到货</span>
              <input type="date" value={expectedAt} onChange={(event) => setExpectedAt(event.target.value)} />
            </label>
          </fieldset>

          <fieldset>
            <legend>采购明细</legend>
            {draftLines.map((line, index) => (
              <div className={`wb-quote-line${line.productLabel ? ' wb-quote-line--prefilled-product' : ''}`} key={index}>
                {line.productLabel ? (
                  <div className="wb-field wb-purchase-product-field">
                    <span>商品</span>
                    <div className="wb-purchase-prefilled-product">
                      <strong>{line.productLabel}</strong>
                      <input type="hidden" value={line.productRef} readOnly />
                      <button type="button" className="wb-btn" onClick={() => setDraftLines((current) => current.map((row, i) => (i === index ? { ...row, productRef: '', productLabel: undefined } : row)))}>更换商品</button>
                    </div>
                  </div>
                ) : (
                  <label className="wb-field">
                    <span>商品</span>
                    <input
                      value={line.productRef}
                      placeholder="商品 ID（库存里的商品编号）"
                      onChange={(event) => setDraftLines((current) => current.map((row, i) => (i === index ? { ...row, productRef: event.target.value, productLabel: undefined } : row)))}
                    />
                  </label>
                )}
                <label className="wb-field">
                  <span>数量</span>
                  <input
                    value={line.qtyOrdered}
                    onChange={(event) => setDraftLines((current) => current.map((row, i) => (i === index ? { ...row, qtyOrdered: event.target.value } : row)))}
                  />
                </label>
                <label className="wb-field">
                  <span>约定单价（元）</span>
                  <input
                    value={line.costYuan}
                    placeholder="留空 = 成本未知"
                    onChange={(event) => setDraftLines((current) => current.map((row, i) => (i === index ? { ...row, costYuan: event.target.value } : row)))}
                  />
                </label>
                <button
                  type="button"
                  className="wb-btn"
                  disabled={draftLines.length <= 1}
                  onClick={() => setDraftLines((current) => current.filter((_, i) => i !== index))}
                >
                  删行
                </button>
              </div>
            ))}
            <div className="wb-form-actions">
              <button
                type="button"
                className="wb-btn"
                onClick={() => setDraftLines((current) => [...current, { productRef: '', qtyOrdered: '1', costYuan: '' }])}
              >
                加一行
              </button>
              <button type="button" className="wb-btn wb-btn--primary" disabled={busy} onClick={() => void handleCreate()}>
                {busy ? '提交中…' : '创建采购单'}
              </button>
              <p className="wb-form-hint">
                成本留空表示「还没谈定」，到货时会记成成本未知，不会写成 0。
              </p>
            </div>
          </fieldset>
        </div>
      ) : null}

      {view === 'detail' ? (
        <>
          {detailState === 'loading' ? <p className="wb-inv-state">正在加载采购单…</p> : null}
          {detailState === 'error' ? (
            <div className="wb-inv-state wb-inv-state--error">
              <p>{actionError || '采购单加载失败'}</p>
              <button type="button" className="wb-btn" onClick={() => setView('list')}>返回列表</button>
            </div>
          ) : null}

          {detailState === 'ready' && detail ? (
            <>
              <div className="wb-inv-totals">
                <span>订购<b>{detail.purchase.orderedQty}</b></span>
                <span>实到<b>{detail.purchase.receivedQty}</b></span>
                <span>拒收<b>{detail.purchase.rejectedQty}</b></span>
                <span>在途<b>{detail.purchase.pendingQty}</b></span>
                <span>进度<b>{detail.purchase.progress}</b></span>
                <span>应付<b>{formatYuan(detail.purchase.payableCents)}</b></span>
                <span>已付<b>{formatYuan(detail.purchase.paidCents)}</b></span>
                <span>剩余应付<b>{formatYuan(detail.purchase.remainingPayableCents)}</b></span>
              </div>

              <div className="wb-detail">
                <h2>采购信息</h2>
                <dl>
                  <div><dt>供应商</dt><dd>{detail.purchase.supplierName || '未填'}</dd></div>
                  <div><dt>说明</dt><dd>{detail.purchase.supplierNote || '—'}</dd></div>
                  <div><dt>预计到货</dt><dd>{detail.purchase.expectedAt || '未约定'}</dd></div>
                  <div><dt>来源订单</dt><dd>{detail.purchase.saleOrderId || '不挂单（散采）'}</dd></div>
                  <div><dt>创建时间</dt><dd>{formatDateTime(detail.purchase.createdAt)}</dd></div>
                </dl>
              </div>

              <div className="wb-quote-table-scroll">
                <table className="wb-quote-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>商品</th>
                      <th>订购</th>
                      <th>实到</th>
                      <th>拒收</th>
                      <th>在途</th>
                      <th>约定成本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line) => (
                      <tr key={line.id}>
                        <td>{line.position + 1}</td>
                        <td>
                          {line.nameSnapshot}
                          <span className="wb-caption"> · {line.productRef ?? line.productId}</span>
                        </td>
                        <td className="wb-tabular">{line.qtyOrdered}</td>
                        <td className="wb-tabular">{line.receivedQty}</td>
                        <td className="wb-tabular">{line.rejectedQty}</td>
                        <td className="wb-tabular">{line.pendingQty}</td>
                        <td className="wb-tabular">{line.costKnown ? formatYuan(line.unitCostCents ?? 0) : '成本未知'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="wb-detail">
                <h2>到货记录</h2>
                {detail.receipts.length === 0 ? (
                  <p className="wb-caption">还没有到货记录。</p>
                ) : (
                  detail.receipts.map((receipt) => (
                    <div key={receipt.id} className="wb-inv-group">
                      <p className="wb-caption">
                        {formatDateTime(receipt.occurredAt)} · 入库{' '}
                        {receipt.lines.filter((line) => line.disposition === 'available' || line.disposition === 'quarantine')
                          .reduce((sum, line) => sum + line.qtyReceived, 0)}{' '}
                        件 · 拒收 {receipt.lines.reduce((sum, line) => sum + line.qtyRejected, 0)} 件
                      </p>
                      <ul>
                        {receipt.lines.map((line) => (
                          <li key={line.id}>
                            {line.nameSnapshot || `第 ${line.position + 1} 行`}：实到 {line.qtyReceived} / 拒收 {line.qtyRejected} ·{' '}
                            {DISPOSITION_LABELS[line.disposition as InspectionDisposition] ?? line.disposition}
                            {line.stockItemId ? <a href={'/inventory?itemId=' + encodeURIComponent(line.stockItemId)}> · 在仓库查看实物</a> : null}
                            {line.assetCode ? ` · 编号 ${line.assetCode}` : ''}
                            {line.costKnown ? ` · 成本 ${formatYuan(line.unitCostCents ?? 0)}` : ' · 成本未知'}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </div>

              {actionError ? <p className="wb-inv-notice wb-inv-notice--warn">{actionError}</p> : null}

              <div className="wb-inv-toolbar wb-form">
                {canCancel ? (
                  <fieldset>
                    <legend>取消未到数量</legend>
                    <p className="wb-caption">只取消仍在途的数量，不改原订购量。已有净付款时服务端会拒绝取消，且不会自动退款。</p>
                    {detail.lines.filter((line) => line.pendingQty > 0).length === 0 ? <p className="wb-form-hint">这张采购单没有可取消的在途数量。</p> : detail.lines.filter((line) => line.pendingQty > 0).map((line) => (
                      <label key={line.id} className="wb-field">
                        <span>{line.position + 1}. {line.nameSnapshot}（已到 {line.receivedQty} / 拒收 {line.rejectedQty} / 在途 {line.pendingQty}）</span>
                        <input inputMode="numeric" value={cancelQuantities[line.id] ?? ''} onChange={(event) => setCancelQuantities({ ...cancelQuantities, [line.id]: event.target.value })} />
                      </label>
                    ))}
                    <label className="wb-field"><span>取消原因</span><select value={cancelReason} onChange={(event) => setCancelReason(event.target.value as typeof cancelReason)}><option value="supplier_unavailable">供应商无法供货</option><option value="supplier_delay">供应商延期</option><option value="customer_cancelled">客户取消</option><option value="duplicate_purchase">重复采购</option></select></label>
                    <label className="wb-field"><span>说明（可选）</span><input value={cancelNote} onChange={(event) => setCancelNote(event.target.value)} /></label>
                    <div className="wb-form-actions"><button type="button" className="wb-btn" disabled={busy || detail.purchase.pendingQty <= 0} onClick={() => void handleCancel()}>{busy ? '提交中…' : '确认取消未到数量'}</button></div>
                  </fieldset>
                ) : <p className="wb-caption">当前账号没有取消采购权限。</p>}
                {canPay ? (
                  <fieldset>
                    <legend>采购付款（老板）</legend>
                    <p className="wb-caption">
                      应付 {formatYuan(detail.purchase.payableCents)} · 已付 {formatYuan(detail.purchase.paidCents)} ·
                      剩余 {formatYuan(detail.purchase.remainingPayableCents)}。付款会写入真实资金流水。
                    </p>
                    {detail.lines.some((line) => !line.costKnown) ? (
                      <p className="wb-form-hint">本采购单还有成本未知的行，补齐每行成本后才能付款。</p>
                    ) : null}
                    <label className="wb-field">
                      <span>本次付款（元）</span>
                      <input value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} placeholder="0.00" />
                    </label>
                    <label className="wb-field">
                      <span>付款方式</span>
                      <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as CashMethod)}>
                        {Object.entries(CASH_METHOD_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="wb-field">
                      <span>备注</span>
                      <input value={paymentRemark} onChange={(event) => setPaymentRemark(event.target.value)} placeholder="可选" />
                    </label>
                    <div className="wb-form-actions">
                      <button
                        type="button"
                        className="wb-btn wb-btn--primary"
                        disabled={busy || detail.purchase.remainingPayableCents <= 0 || detail.lines.some((line) => !line.costKnown)}
                        onClick={() => void handlePayment()}
                      >
                        {busy ? '提交中…' : '登记付款'}
                      </button>
                      <p className="wb-form-hint">超付会由服务端拒绝；同一请求重试不会重复记账。</p>
                    </div>
                  </fieldset>
                ) : (
                  <p className="wb-caption">采购付款是老板专属动作，当前账号没有付款权限。</p>
                )}

                {canReceive ? (
                  <fieldset>
                    <legend>登记这一轮到货</legend>
                    <label className="wb-field">
                      <span>采购行</span>
                      <select value={receiptLineId} onChange={(event) => setReceiptLineId(event.target.value)}>
                        {detail.lines.map((line) => (
                          <option key={line.id} value={line.id}>
                            {line.position + 1}. {line.nameSnapshot}（在途 {line.pendingQty}）
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="wb-field">
                      <span>本次实到</span>
                      <input value={receiptQty} onChange={(event) => setReceiptQty(event.target.value)} placeholder="0" />
                    </label>
                    <label className="wb-field">
                      <span>本次拒收</span>
                      <input value={receiptRejected} onChange={(event) => setReceiptRejected(event.target.value)} placeholder="0" />
                    </label>
                    <label className="wb-field">
                      <span>处置去向</span>
                      <select value={receiptDisposition} onChange={(event) => setReceiptDisposition(event.target.value as InspectionDisposition)}>
                        {Object.entries(DISPOSITION_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="wb-field">
                      <span>本次实到成色</span>
                      <select value={receiptCondition} onChange={(event) => setReceiptCondition(event.target.value as 'new' | 'used')}>
                        <option value="used">二手</option>
                        <option value="new">新品</option>
                      </select>
                    </label>
                    <label className="wb-field">
                      <span>厂家 SN（可选，每行一件，可扫码或留空）</span>
                      <textarea
                        rows={3}
                        value={receiptItems}
                        onChange={(event) => setReceiptItems(event.target.value)}
                        placeholder={'扫码或输入厂家 SN，每行对应一件\n留空时内部编号仍会自动生成'}
                      />
                    </label>
                    <label className="wb-field">
                      <span>本次逐件实物备注</span>
                      <input value={receiptItemRemark} onChange={(event) => setReceiptItemRemark(event.target.value)} placeholder="可选，将应用到本次逐件到货" />
                    </label>
                    <label className="wb-field">
                      <span>本次批次备注（数量管理商品）</span>
                      <input value={receiptBatchRemark} onChange={(event) => setReceiptBatchRemark(event.target.value)} placeholder="可选，如供应商批号、颜色或存放位置" />
                    </label>
                    <div className="wb-form-actions">
                      <button type="button" className="wb-btn wb-btn--primary" disabled={busy} onClick={() => void handleReceipt()}>
                        {busy ? '提交中…' : '登记到货'}
                      </button>
                      <p className="wb-form-hint">
                        {selectedLine && selectedLine.pendingQty > 0
                          ? `这一行还剩 ${selectedLine.pendingQty} 件没到；本次实到 + 拒收不能超过它。`
                          : '这一行已经到齐；再收就是超量，服务端会拒绝。'}
                      </p>
                    </div>
                  </fieldset>
                ) : (
                  <p className="wb-caption">当前账号没有登记到货的权限。</p>
                )}

                {canReturn ? (
                  <fieldset>
                    <legend>退供</legend>
                    <label className="wb-field">
                      <span>采购行</span>
                      <select value={returnLineId} onChange={(event) => setReturnLineId(event.target.value)}>
                        {detail.lines.map((line) => (
                          <option key={line.id} value={line.id}>
                            {line.position + 1}. {line.nameSnapshot}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="wb-field">
                      <span>退供数量</span>
                      <input value={returnQty} onChange={(event) => setReturnQty(event.target.value)} />
                    </label>
                    <label className="wb-field">
                      <span>从哪个库退</span>
                      <select value={returnBucket} onChange={(event) => setReturnBucket(event.target.value as 'available' | 'quarantine')}>
                        <option value="available">可取件</option>
                        <option value="quarantine">待处理件</option>
                      </select>
                    </label>
                    <label className="wb-field">
                      <span>原因</span>
                      <input value={returnReason} onChange={(event) => setReturnReason(event.target.value)} placeholder="例：点不亮，退回换新" />
                    </label>
                    <div className="wb-form-actions">
                      <button type="button" className="wb-btn" disabled={busy} onClick={() => void handleReturn()}>
                        {busy ? '提交中…' : '登记退供'}
                      </button>
                      <p className="wb-form-hint">
                        退供只减不增：可退数量超过本店可取 + 待处理库存时会被拒绝。已成交占用的件不能退。
                      </p>
                    </div>
                  </fieldset>
                ) : (
                  <p className="wb-caption">当前账号没有退供权限。</p>
                )}
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

export default WorkbenchPurchasePage
