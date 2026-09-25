/**
 * E06 · 销售单与收款页（网页端 ERP）。
 *
 * 一页两态：列表 → 详情（含处理动作）。数据全部来自 `/api/v2/sales/orders*`，
 * 没有演示数据；服务端给什么就显示什么，本页不自己判权限（无权限动作由服务端 403）。
 *
 * 业务口径（docs/2026-09-19-报价单业务规则.md、05-fulfillment.md）：
  *   · 未付款不预留：已核实收款（含折抵）没到预付款门槛时，「确认成交」会被服务端拒绝，
 *     本页把门槛与当前已收都显示出来，不靠禁用按钮让人猜；
 *   · 确认 ≠ 付款、确认不锁库存 是报价侧的 B42；本页的「确认成交」才锁货（占用具体实物）；
 *   · 抢最后一件只有一单成功：失败那一单已经收过的钱仍在账上（收款与预留是两次独立提交）；
 *   · 缺件（新品行没有指定实物）在详情里单列，补分配后才能占用；
 *   · 余额方向由服务端派生：> 0 客户待付、= 0 已结清、< 0 门店待退 —— 界面不显示负尾款。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { formatYuan } from './inventory-view'
import {
  allocateSaleOrder,
  approveCreditDelivery,
  approveReturnCredit,
  cancelSaleOrder,
  confirmSaleOrder,
  fetchSaleOrderDetail,
  fetchSaleOrders,
  querySaleOperation,
  refundSaleOrder,
  registerReturn,
  registerSalePayment,
} from './sales-api'
import type {
  CashMethod,
  SaleOrderDetailPayload,
  SaleOrderListPayload,
  SaleTradeState,
  SaleWriteOutcome,
} from './sales-api'
import '../../styles/workbench.css'

const TRADE_LABELS: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  cancelled: '已取消',
  closed: '已关闭',
}

const FULFILLMENT_LABELS: Record<string, string> = {
  waiting_stock: '待备料',
  preparing: '备料中',
  testing: '检测中',
  ready_delivery: '待交付',
  delivered: '已交付',
}

const SOURCE_LABELS: Record<string, string> = {
  new: '新品',
  used: '二手件',
  customer: '客供件',
  service: '服务费',
}

const METHOD_LABELS: Record<CashMethod, string> = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝',
  bank: '银行转账',
  other: '其他',
}

const AVAILABILITY_LABELS: Record<string, string> = {
  available: '可取',
  reserved: '已被占用',
  quarantine: '待处理',
  sold: '已售出',
  retired: '已离店',
  missing: '引用已失效',
}

/** 老板是 `*`；店员按契约码或旧码判断（与 domains/access.ts 的 LEGACY_EQUIVALENT 同源）。 */
function hasAny(permissions: readonly string[], codes: readonly string[]): boolean {
  return permissions.includes('*') || codes.some((code) => permissions.includes(code))
}

const VIEW_CODES = ['sales/order-view', 'quote/view']
const EDIT_CODES = ['sales/order-edit', 'quote/edit']
const PAYMENT_CODES = ['sales/order-payment', 'quote/edit']
/** 退货登记（B17）等价 quote/edit；退款（B18）/ 批准贷项（B43）与欠款批准（B09）是 owner_only。 */
const RETURN_CODES = ['sales/return-create', 'quote/edit']
const REFUND_CODES = ['sales/refund']
const CREDIT_CODES = ['sales/order-credit-approval']

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 元输入 → 整数分。空串 / 非法输入返回 null。 */
function yuanToCents(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}

type Notice = { kind: 'ok' | 'warn' | 'error'; text: string } | null
type UnknownWrite = { requestId: string; what: string } | null

export function WorkbenchSalesPage({ permissions }: { permissions: string[] }) {
  const workbenchOrderNo = new URLSearchParams(window.location.search).get('orderNo')?.trim() ?? ''
  const openedWorkbenchOrderNo = useRef<string | null>(null)
  const [view, setView] = useState<'list' | 'detail'>('list')
  const [orders, setOrders] = useState<SaleOrderListPayload | null>(null)
  const [detail, setDetail] = useState<SaleOrderDetailPayload | null>(null)
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listError, setListError] = useState('')
  const [tradeFilter, setTradeFilter] = useState<SaleTradeState | 'all' | 'awaiting'>('all')
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [actionError, setActionError] = useState('')
  const [unknownWrite, setUnknownWrite] = useState<UnknownWrite>(null)

  /**
   * 每一行按数量锁住了多少件（数量件占用）。
   * 实物列要分得清「按台卖的还没指实物」和「按量卖的已经锁了 N 件」——
   * 两种都写「未指定实物（缺件）」会把已经锁住货的单说成缺货。
   */
  const reservedByLine = useMemo(() => {
    const map = new Map<string, number>()
    for (const reservation of detail?.reservations ?? []) {
      if (reservation.status !== 'active' || !reservation.quantityBucketRef) continue
      map.set(reservation.lineRef, (map.get(reservation.lineRef) ?? 0) + reservation.qty)
    }
    return map
  }, [detail])
  const [paymentYuan, setPaymentYuan] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<CashMethod>('wechat')
  const [paymentRemark, setPaymentRemark] = useState('')
  const [paymentVerified, setPaymentVerified] = useState(false)
  const [allocatePosition, setAllocatePosition] = useState<number | null>(null)
  const [allocateItemId, setAllocateItemId] = useState('')
  const [cancelReason, setCancelReason] = useState('')
  const [creditDueDate, setCreditDueDate] = useState('')
  const [creditReason, setCreditReason] = useState('')
  const [returnPosition, setReturnPosition] = useState('')
  const [returnQty, setReturnQty] = useState('1')
  const [returnCreditYuan, setReturnCreditYuan] = useState('')
  const [returnReason, setReturnReason] = useState('')
  const [returnItemId, setReturnItemId] = useState('')
  const [refundReturnRef, setRefundReturnRef] = useState('')
  const [refundYuan, setRefundYuan] = useState('')
  const [refundMethod, setRefundMethod] = useState<CashMethod>('wechat')
  const [refundReason, setRefundReason] = useState('')
  const [refundVerified, setRefundVerified] = useState(false)

  const canView = hasAny(permissions, VIEW_CODES)
  const canEdit = hasAny(permissions, EDIT_CODES)
  const canPay = hasAny(permissions, PAYMENT_CODES)
  const canReturn = hasAny(permissions, RETURN_CODES)
  const canRefund = hasAny(permissions, REFUND_CODES)
  const canCredit = hasAny(permissions, CREDIT_CODES)

  // ⚠️ 不在本函数的开头同步 setState：「在 effect 里同步 setState」会被 lint 判为级联渲染
  // （WorkbenchInventoryPage 用同一个写法绕过）。加载态由初始值与事件处理设置。
  const loadList = useCallback(async (filter: SaleTradeState | 'all' | 'awaiting', q: string) => {
    const result = await fetchSaleOrders({
      // 「待付款」不是一个交易状态，而是「还有余额」——服务端没有这个筛选值，
      // 所以这里取全量后在页面上筛，不用语义不清的假状态去请求。
      tradeState: filter === 'all' || filter === 'awaiting' ? null : filter,
      q: q || null,
      limit: 200,
    })
    if (result.ok) {
      setOrders(result.data)
      setListState('ready')
      setListError('')
      return
    }
    setListState('error')
    setListError(result.message)
  }, [])

  const refresh = useCallback(() => {
    setListState('loading')
    void loadList(tradeFilter, keyword)
  }, [loadList, tradeFilter, keyword])

  const openDetail = useCallback(async (orderId: string) => {
    setView('detail')
    setDetailState('loading')
    setDetail(null)
    setActionError('')
    setNotice(null)
    setPaymentVerified(false)
    setRefundVerified(false)
    const result = await fetchSaleOrderDetail(orderId)
    if (result.ok) {
      setDetail(result.data)
      setDetailState('ready')
      const balance = result.data.order.balanceCents
      setPaymentYuan(balance > 0 ? (balance / 100).toString() : '')
      return
    }
    setDetailState('error')
    setActionError(result.message)
  }, [])

  // ⚠️ effect 里必须把 setState 放在 .then 回调中（`react-hooks/set-state-in-effect`）：
  // 直接调用一个会同步 setState 的加载函数会被判为级联渲染 —— WorkbenchInventoryPage 同一写法。
  useEffect(() => {
    if (!canView) return
    let active = true
    void fetchSaleOrders({
      tradeState: tradeFilter === 'all' || tradeFilter === 'awaiting' ? null : tradeFilter,
      q: keyword || null,
      limit: 200,
    }).then((result) => {
      if (!active) return
      if (result.ok) {
        setOrders(result.data)
        setListState('ready')
        setListError('')
        if (workbenchOrderNo && openedWorkbenchOrderNo.current !== workbenchOrderNo) {
          const taskOrder = result.data.orders.find((row) => row.orderNo === workbenchOrderNo)
          openedWorkbenchOrderNo.current = workbenchOrderNo
          if (taskOrder) void openDetail(taskOrder.id)
        }
        return
      }
      setListState('error')
      setListError(result.message)
    })
    return () => {
      active = false
    }
  }, [canView, tradeFilter, keyword, workbenchOrderNo, openDetail])

  /** 写动作的统一出口：成功刷新数据；「结果未知」进待确认状态，不当失败。 */
  const runWrite = useCallback(
    async (what: string, action: () => Promise<{ ok: boolean; message?: string; data?: SaleWriteOutcome }>): Promise<SaleWriteOutcome | null> => {
      setBusy(true)
      setActionError('')
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
        setActionError(fail.message)
        return null
      }
      setActionError(result.message ?? '操作失败')
      return null
    },
    [],
  )

  const checkUnknownResult = useCallback(async () => {
    if (!unknownWrite?.requestId || !detail) return
    const status = await querySaleOperation(unknownWrite.requestId)
    if (status.status === 'succeeded') {
      setNotice({ kind: 'ok', text: `${unknownWrite.what}：后台确认这笔已经生效。` })
      setUnknownWrite(null)
      await openDetail(detail.order.id)
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
  }, [unknownWrite, detail, openDetail])

  const handleConfirm = useCallback(async () => {
    if (!detail) return
    const done = await runWrite('确认成交', () => confirmSaleOrder(detail.order.id))
    if (done) {
      await loadList(tradeFilter, keyword)
      await openDetail(detail.order.id)
      // 提示放在刷新之后：openDetail 会清掉上一轮提示，先设会被自己的刷新抹掉。
      setNotice({ kind: 'ok', text: done.summary || '已确认成交' })
    }
  }, [detail, runWrite, loadList, tradeFilter, keyword, openDetail])

  const handleAllocate = useCallback(async () => {
    if (!detail || allocatePosition === null || !allocateItemId.trim()) return
    const done = await runWrite('补分配', () =>
      allocateSaleOrder(detail.order.id, [{ position: allocatePosition, stockItemId: allocateItemId.trim() }]),
    )
    if (done) {
      setNotice({ kind: 'ok', text: done.summary || '已补分配' })
      setAllocatePosition(null)
      setAllocateItemId('')
      await openDetail(detail.order.id)
    }
  }, [detail, allocatePosition, allocateItemId, runWrite, openDetail])

  const handlePayment = useCallback(async () => {
    if (!detail) return
    if (!paymentVerified) {
      setActionError('先核实款项已实际到账；处理中或结果未知不能登记为已收款')
      return
    }
    const cents = yuanToCents(paymentYuan)
    if (cents === null || cents <= 0) {
      setActionError('收款金额要填一个大于 0 的数字')
      return
    }
    const done = await runWrite('登记收款', () =>
      registerSalePayment(detail.order.id, cents, paymentMethod, paymentRemark),
    )
    if (done) {
      setPaymentRemark('')
      setPaymentVerified(false)
      await loadList(tradeFilter, keyword)
      await openDetail(detail.order.id)
      setNotice({ kind: 'ok', text: done.summary || '已登记收款' })
    }
  }, [detail, paymentYuan, paymentMethod, paymentRemark, paymentVerified, runWrite, loadList, tradeFilter, keyword, openDetail])

  const handleCancel = useCallback(async () => {
    if (!detail) return
    if (!cancelReason.trim()) {
      setActionError('取消销售单要写明原因')
      return
    }
    const done = await runWrite('取消销售单', () => cancelSaleOrder(detail.order.id, cancelReason.trim()))
    if (done) {
      setCancelReason('')
      await loadList(tradeFilter, keyword)
      await openDetail(detail.order.id)
      setNotice({ kind: 'ok', text: done.summary || '已取消销售单' })
    }
  }, [detail, cancelReason, runWrite, loadList, tradeFilter, keyword, openDetail])

  const handleCredit = useCallback(async () => {
    if (!detail) return
    if (!creditDueDate || !creditReason.trim()) {
      setActionError('欠款交付要填到期日和原因')
      return
    }
    const done = await runWrite('批准欠款交付', () =>
      approveCreditDelivery(detail.order.id, creditDueDate, creditReason.trim()),
    )
    if (done) {
      setCreditDueDate('')
      setCreditReason('')
      await openDetail(detail.order.id)
      setNotice({ kind: 'ok', text: done.summary || '已批准欠款交付' })
    }
  }, [detail, creditDueDate, creditReason, runWrite, openDetail])

  const handleReturn = useCallback(async () => {
    if (!detail) return
    const position = Number(returnPosition)
    const qty = Number(returnQty)
    const creditCents = yuanToCents(returnCreditYuan)
    if (!Number.isInteger(position) || position < 0) {
      setActionError('退货行号要填非负整数 position（第 1 行是 0）')
      return
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      setActionError('退货数量要填正整数')
      return
    }
    if (creditCents === null || creditCents <= 0) {
      setActionError('退货贷项要填大于 0 的金额')
      return
    }
    if (!returnReason.trim()) {
      setActionError('退货要写明原因')
      return
    }
    const done = await runWrite('登记退货', () =>
      registerReturn({
        originalOrderId: detail.order.id,
        lineAllocations: [{ position, qty }],
        stockItemIds: returnItemId.trim() ? [returnItemId.trim()] : [],
        reason: returnReason.trim(),
        acceptedQty: qty,
        creditCents,
      }),
    )
    if (done) {
      setReturnPosition('')
      setReturnQty('1')
      setReturnCreditYuan('')
      setReturnReason('')
      setReturnItemId('')
      await loadList(tradeFilter, keyword)
      await openDetail(detail.order.id)
      setNotice({ kind: 'ok', text: done.summary || '已登记退货' })
    }
  }, [detail, returnPosition, returnQty, returnCreditYuan, returnReason, returnItemId, runWrite, loadList, tradeFilter, keyword, openDetail])

  const handleApproveReturn = useCallback(async (returnId: string) => {
    const done = await runWrite('批准退货贷项', () => approveReturnCredit(returnId))
    if (done) {
      await openDetail(detail?.order.id ?? '')
      setNotice({ kind: 'ok', text: done.summary || '已批准退货贷项' })
    }
  }, [runWrite, openDetail, detail])

  const handleRefund = useCallback(async () => {
    if (!detail) return
    if (!refundVerified) {
      setActionError('先核实退款已经实际付出/到账；申请中、处理中或结果未知不能登记为已退款')
      return
    }
    if (!refundReturnRef) {
      setActionError('退款要选一张已批准的退货单')
      return
    }
    const amountCents = yuanToCents(refundYuan)
    if (amountCents === null || amountCents <= 0) {
      setActionError('退款金额要填大于 0 的数字')
      return
    }
    if (!refundReason.trim()) {
      setActionError('退款要写明原因')
      return
    }
    const done = await runWrite('登记退款', () =>
      refundSaleOrder(detail.order.id, {
        amountCents,
        method: refundMethod,
        returnRef: refundReturnRef,
        reason: refundReason.trim(),
      }),
    )
    if (done) {
      setRefundReturnRef('')
      setRefundYuan('')
      setRefundReason('')
      setRefundVerified(false)
      await loadList(tradeFilter, keyword)
      await openDetail(detail.order.id)
      setNotice({ kind: 'ok', text: done.summary || '已登记退款' })
    }
  }, [detail, refundReturnRef, refundYuan, refundMethod, refundReason, refundVerified, runWrite, loadList, tradeFilter, keyword, openDetail])

  if (!canView) {
    return (
      <div className="wb-page wb-sales-page">
        <div className="wb-page-head">
          <div>
            <p className="wb-kicker">销售与收款</p>
            <h1>订单处理</h1>
          </div>
        </div>
        <p className="wb-inv-notice wb-inv-notice--warn">
          当前账号没有查看销售单的权限。请联系老板开通「查看销售单、客户与设备资料」。
        </p>
      </div>
    )
  }

  const visibleOrders = (orders?.orders ?? []).filter((row) =>
    tradeFilter === 'awaiting' ? row.balanceCents > 0 : true,
  )

  return (
    <div className="wb-page wb-sales-page">
      <div className="wb-page-head">
        <div>
          <p className="wb-kicker">销售与收款</p>
          <h1>{view === 'list' ? '订单处理' : detail?.order.orderNo ?? '销售单'}</h1>
          <p className="wb-caption">
            {view === 'list'
              ? '报价成交后在这里收款、确认成交并占用实物。未达到已核实的预付款门槛不会尝试预留。'
              : '这一页是这张单的钱、货与履约状态；服务端确认后才算数。'}
          </p>
        </div>
        <div className="wb-page-head-actions">
          {view === 'detail' ? (
            <button type="button" className="wb-btn" onClick={() => { setView('list'); setDetail(null) }}>
              返回列表
            </button>
          ) : null}
          <button type="button" className="wb-btn" onClick={refresh} disabled={busy}>
            刷新
          </button>
        </div>
      </div>

      {notice ? (
        <p className={`wb-inv-notice${notice.kind === 'warn' ? ' wb-inv-notice--warn' : ''}`}>
          {notice.text}
        </p>
      ) : null}
      {unknownWrite ? (
        <div className="wb-inv-toolbar">
          <button type="button" className="wb-btn wb-btn--primary" onClick={() => void checkUnknownResult()}>
            查询结果（{unknownWrite.what}）
          </button>
        </div>
      ) : null}

      {view === 'list' ? (
        <>
          {orders ? (
            <div className="wb-inv-totals">
              <span>全部销售单<b>{orders.totals.all}</b></span>
              <span>草稿（未成交）<b>{orders.totals.draft}</b></span>
              <span>已确认<b>{orders.totals.confirmed}</b></span>
              <span>待付款<b>{orders.totals.awaitingPayment}</b></span>
              <span>待收金额<b>{formatYuan(orders.totals.receivableCents)}</b></span>
            </div>
          ) : null}

          <div className="wb-inv-toolbar">
            <div className="wb-filter-row">
              {([
                ['all', '全部'],
                ['draft', '草稿'],
                ['confirmed', '已确认'],
                ['awaiting', '待付款'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`wb-btn${tradeFilter === value ? ' wb-btn--primary' : ''}`}
                  onClick={() => { setListState('loading'); setTradeFilter(value) }}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="wb-inv-search">
              <span className="wb-caption">搜索</span>
              <input
                value={keyword}
                placeholder="单号或客户"
                onChange={(event) => setKeyword(event.target.value)}
              />
            </label>
          </div>

          {listState === 'loading' ? <p className="wb-inv-state">正在加载销售单…</p> : null}
          {listState === 'error' ? (
            <div className="wb-inv-state wb-inv-state--error">
              <p>{listError || '销售单加载失败'}</p>
              <button type="button" className="wb-btn" onClick={refresh}>重试</button>
            </div>
          ) : null}
          {listState === 'ready' && visibleOrders.length === 0 ? (
            <p className="wb-inv-state">
              没有符合条件的销售单。销售单来自报价：在「开单 → 新建装机报价」里发出报价后确认成交。
            </p>
          ) : null}

          {listState === 'ready' && visibleOrders.length > 0 ? (
            <div className="wb-quote-table-scroll">
              <table className="wb-quote-table">
                <thead>
                  <tr>
                    <th>单号</th>
                    <th>客户</th>
                    <th>状态</th>
                    <th>履约</th>
                    <th>总额</th>
                    <th>已收</th>
                    <th>待收</th>
                    <th>实物</th>
                    <th>创建</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOrders.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <button type="button" className="wb-btn" onClick={() => void openDetail(row.id)}>
                          {row.orderNo}
                        </button>
                      </td>
                      <td>{row.customerName || '未填写客户'}</td>
                      <td>
                        <span className={`wb-quote-stock wb-quote-stock--${row.tradeState === 'confirmed' ? 'available' : 'reserved'}`}>
                          {TRADE_LABELS[row.tradeState] ?? row.tradeState}
                        </span>
                      </td>
                      <td>{FULFILLMENT_LABELS[row.fulfillmentState] ?? row.fulfillmentState}</td>
                      <td className="wb-tabular">{formatYuan(row.totalCents)}</td>
                      <td className="wb-tabular">{formatYuan(row.cashNetCents)}</td>
                      <td className="wb-tabular">
                        {row.balanceCents > 0
                          ? formatYuan(row.balanceCents)
                          : row.isFullyPaid
                            ? '已结清'
                            : '—'}
                      </td>
                      <td>
                        已占 {row.reservedCount} 件
                        {row.shortageCount > 0 ? <span className="wb-caption"> · 缺 {row.shortageCount} 项</span> : null}
                      </td>
                      <td className="wb-caption">{formatDateTime(row.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}

      {view === 'detail' ? (
        <>
          {detailState === 'loading' ? <p className="wb-inv-state">正在加载销售单…</p> : null}
          {detailState === 'error' ? (
            <div className="wb-inv-state wb-inv-state--error">
              <p>{actionError || '销售单加载失败'}</p>
              <button type="button" className="wb-btn" onClick={() => void loadList(tradeFilter, keyword)}>返回列表</button>
            </div>
          ) : null}

          {detailState === 'ready' && detail ? (
            <>
              <div className="wb-inv-totals">
                <span>总额<b>{formatYuan(detail.order.totalCents)}</b></span>
                <span>已收<b>{formatYuan(detail.order.cashNetCents)}</b></span>
                <span>
                  {detail.order.balanceDirection === 'store_due' ? '门店待退' : '待收'}
                  <b>{formatYuan(Math.abs(detail.order.balanceCents))}</b>
                </span>
                <span>预付款门槛<b>{formatYuan(detail.order.requiredDepositCents)}</b></span>
                <span>状态<b>{TRADE_LABELS[detail.order.tradeState] ?? detail.order.tradeState}</b></span>
              </div>

              {detail.order.balanceDirection === 'store_due' ? (
                <p className="wb-inv-notice wb-inv-notice--warn">
                  这张单目前多收了 {formatYuan(Math.abs(detail.order.balanceCents))}，属门店待退，不是负尾款。
                </p>
              ) : null}

              <div className="wb-detail">
                <h2>客户与来源</h2>
                <dl>
                  <div><dt>客户</dt><dd>{detail.order.customerName || '未填写客户'}</dd></div>
                  <div><dt>联系电话</dt><dd>{detail.order.customerPhone || '—'}</dd></div>
                  <div>
                    <dt>来源报价</dt>
                    <dd>
                      {detail.quote ? `第 ${detail.quote.revision} 版` : '无（直接建单）'}
                    </dd>
                  </div>
                  <div><dt>交期</dt><dd>{detail.order.dueAt ? formatDateTime(detail.order.dueAt) : '未约定'}</dd></div>
                  <div><dt>创建时间</dt><dd>{formatDateTime(detail.order.createdAt)}</dd></div>
                  <div><dt>最近更新</dt><dd>{formatDateTime(detail.order.updatedAt)}</dd></div>
                </dl>
              </div>

              <div className="wb-quote-table-scroll">
                <table className="wb-quote-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>来源</th>
                      <th>名称</th>
                      <th>数量</th>
                      <th>单价</th>
                      <th>分摊优惠</th>
                      <th>净额</th>
                      <th>实物</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line) => (
                      <tr key={line.id}>
                        <td>{line.position + 1}</td>
                        <td>{SOURCE_LABELS[line.source] ?? line.source}</td>
                        <td>
                          {line.nameSnapshot}
                          {line.specSnapshot ? <span className="wb-caption"> · {line.specSnapshot}</span> : null}
                          {line.warrantySnapshot?.note ? <span className="wb-caption"> · 保修：{line.warrantySnapshot.note}</span> : null}
                          {line.warrantySnapshot?.remark ? <span className="wb-caption"> · {line.warrantySnapshot.remark}</span> : null}
                        </td>
                        <td className="wb-tabular">{line.qty}</td>
                        <td className="wb-tabular">{formatYuan(line.unitPriceCents)}</td>
                        <td className="wb-tabular">{formatYuan(line.discountAllocationCents)}</td>
                        <td className="wb-tabular">{formatYuan(line.netLineCents)}</td>
                        <td>
                          {line.stockItemId ? (
                            <span className={`wb-quote-stock wb-quote-stock--${line.stockItemAvailability === 'available' ? 'available' : 'reserved'}`}>
                              {line.stockItemAssetCode || line.stockItemId} · {AVAILABILITY_LABELS[line.stockItemAvailability ?? 'missing'] ?? line.stockItemAvailability}
                            </span>
                          ) : line.source === 'new' ? (
                            reservedByLine.get(line.id) ? (
                              <span className="wb-quote-stock wb-quote-stock--reserved">
                                按数量已锁 {reservedByLine.get(line.id)} 件
                              </span>
                            ) : (
                              <span className="wb-caption">未指定实物（缺件）</span>
                            )
                          ) : (
                            <span className="wb-caption">不占库存</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <section className="wb-inv-group" aria-label="订单保修条款快照">
                <div className="wb-inv-head"><span>订单保修条款快照</span></div>
                {detail.warrantyPolicyLines?.length ? (
                  <ul className="wb-caption">
                    {detail.warrantyPolicyLines.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
                  </ul>
                ) : (
                  <p className="wb-inv-notice wb-inv-notice--warn">该历史订单未保存完整保修条款快照；请核对原始报价版本及已作出的书面承诺。</p>
                )}
              </section>

              {detail.shortage.length > 0 ? (
                <div className="wb-inv-notice wb-inv-notice--warn">
                  <p>
                    待补 {detail.shortage.length} 项，共{' '}
                    {detail.shortage.reduce((sum, row) => sum + row.shortageQty, 0)} 件：
                    {detail.shortage.map((row) => `${row.nameSnapshot} ×${row.shortageQty}`).join('、')}
                  </p>
                  <p className="wb-caption">
                    数字是「行数量 − 已经锁住的」。未付款时一件都没锁，所以这里列的是全部数量 ——
                    未达到预付款门槛时不预留库存。按量卖的商品在确认成交时会自动锁住能锁的部分，
                    锁不满的差额才需要补货（库存 → 缺件处理）；按台卖的则要补分配具体实物。
                  </p>
                </div>
              ) : null}

              <div className="wb-detail">
                <h2>收款记录（本金）</h2>
                {detail.payments.length === 0 ? (
                  <p className="wb-caption">还没有收款记录。登记收款后才会锁货。</p>
                ) : (
                  <ul>
                    {detail.payments.map((payment) => (
                      <li key={payment.id}>
                        {formatDateTime(payment.occurredAt)} · {formatYuan(payment.amountCents)} · {METHOD_LABELS[payment.method as CashMethod] ?? payment.method}
                        {payment.verificationState === 'verified' ? ' · 已对账' : ' · 待对账'}
                        {payment.remark ? ` · ${payment.remark}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {actionError ? <p className="wb-inv-notice wb-inv-notice--warn">{actionError}</p> : null}

              <div className="wb-inv-toolbar wb-form">
                {canPay ? (
                  <fieldset>
                    <legend>登记收款</legend>
                    <label className="wb-field">
                      <span>金额（元）</span>
                      <input value={paymentYuan} onChange={(event) => setPaymentYuan(event.target.value)} placeholder="0.00" />
                    </label>
                    <label className="wb-field">
                      <span>方式</span>
                      <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as CashMethod)}>
                        {Object.entries(METHOD_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="wb-field">
                      <span>备注</span>
                      <input value={paymentRemark} onChange={(event) => setPaymentRemark(event.target.value)} placeholder="可留空" />
                    </label>
                    <label className="wb-check">
                      <span><input type="checkbox" checked={paymentVerified} onChange={(event) => setPaymentVerified(event.target.checked)} /> 我已核实款项实际到账；处理中或结果未知不算收款成功</span>
                    </label>
                    <div className="wb-form-actions">
                      <button
                        type="button"
                        className="wb-btn wb-btn--primary"
                        disabled={busy || !paymentVerified || detail.order.tradeState === 'cancelled'}
                        onClick={() => void handlePayment()}
                      >
                        {busy ? '提交中…' : '登记收款'}
                      </button>
                      <p className="wb-form-hint">
                        可收上限 = 剩余应收（{formatYuan(Math.max(detail.order.balanceCents, 0))}），超收会被服务端拒绝。
                      </p>
                    </div>
                  </fieldset>
                ) : (
                  <p className="wb-caption">当前账号没有登记收款的权限。</p>
                )}

                {canEdit ? (
                  <fieldset>
                    <legend>成交与占货</legend>
                    <div className="wb-form-actions">
                      <button
                        type="button"
                        className="wb-btn wb-btn--primary"
                        disabled={busy || detail.order.tradeState !== 'draft'}
                        onClick={() => void handleConfirm()}
                      >
                        确认成交（占用实物）
                      </button>
                      <p className="wb-form-hint">
                        {detail.order.tradeState === 'draft'
                          ? `已核实现金净收 ${formatYuan(detail.order.cashNetCents)} + 有效折抵 ${formatYuan(detail.order.offsetNetCents)} / 预付款门槛 ${formatYuan(detail.order.requiredDepositCents)}。未达门槛时服务端会拒绝确认成交并预留库存。`
                          : `当前状态是「${TRADE_LABELS[detail.order.tradeState] ?? detail.order.tradeState}」，不能再确认成交。`}
                      </p>
                    </div>

                    {detail.shortage.length > 0 ? (
                      <div className="wb-form-actions">
                        <label className="wb-field">
                          <span>要补分配的缺件行</span>
                          <select
                            value={allocatePosition === null ? '' : String(allocatePosition)}
                            onChange={(event) => setAllocatePosition(event.target.value === '' ? null : Number(event.target.value))}
                          >
                            <option value="">请选择</option>
                            {detail.shortage.map((row) => (
                              <option key={row.lineId} value={row.position}>
                                {row.position + 1}. {row.nameSnapshot}（待补 {row.shortageQty} 件）
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="wb-field">
                          <span>指定实物编号</span>
                          <input value={allocateItemId} onChange={(event) => setAllocateItemId(event.target.value)} placeholder="实物 ID 或内部编号" />
                        </label>
                        <button
                          type="button"
                          className="wb-btn"
                          disabled={busy || allocatePosition === null || !allocateItemId.trim()}
                          onClick={() => void handleAllocate()}
                        >
                          补分配
                        </button>
                        <p className="wb-form-hint">
                          只能占用本店当前可取的实物；已被别的订单占用的会被服务端拒绝（抢最后一件只有一单成功）。
                        </p>
                      </div>
                    ) : null}
                  </fieldset>
                ) : (
                  <p className="wb-caption">当前账号没有确认成交或补分配的权限。</p>
                )}
              </div>

              {detail.returns.length > 0 ? (
                <div className="wb-detail">
                  <h2>退货与退款</h2>
                  <ul>
                    {detail.returns.map((ret) => (
                      <li key={ret.id}>
                        {formatDateTime(ret.createdAt)} · 贷项 {formatYuan(ret.creditCents)} · 退 {ret.acceptedQty} 件 · {ret.creditState === 'approved' ? '已批准' : '待批准'}
                        {ret.reason ? ` · ${ret.reason}` : ''}
                        {ret.creditState === 'pending' && canRefund ? (
                          <button
                            type="button"
                            className="wb-btn"
                            disabled={busy}
                            onClick={() => void handleApproveReturn(ret.id)}
                          >
                            批准贷项
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="wb-inv-toolbar wb-form">
                {canEdit && detail.order.tradeState === 'confirmed' && detail.order.fulfillmentState !== 'delivered' ? (
                  <fieldset>
                    <legend>取消销售单</legend>
                    <label className="wb-field">
                      <span>原因</span>
                      <input value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} placeholder="客户改主意 / 报价作废等" />
                    </label>
                    <div className="wb-form-actions">
                      <button type="button" className="wb-btn" disabled={busy || !cancelReason.trim()} onClick={() => void handleCancel()}>
                        取消销售单
                      </button>
                      <p className="wb-form-hint">已交付的订单不能取消（走退货）；取消会释放占用，已收的钱转为门店待退。</p>
                    </div>
                  </fieldset>
                ) : null}

                {canCredit && detail.order.tradeState === 'confirmed' && detail.order.balanceCents > 0 && detail.order.fulfillmentState !== 'delivered' ? (
                  <fieldset>
                    <legend>批准欠款交付</legend>
                    <label className="wb-field">
                      <span>到期日</span>
                      <input type="date" value={creditDueDate} onChange={(event) => setCreditDueDate(event.target.value)} />
                    </label>
                    <label className="wb-field">
                      <span>原因</span>
                      <input value={creditReason} onChange={(event) => setCreditReason(event.target.value)} placeholder="客户月底结清等" />
                    </label>
                    <div className="wb-form-actions">
                      <button type="button" className="wb-btn" disabled={busy || !creditDueDate || !creditReason.trim()} onClick={() => void handleCredit()}>
                        批准欠款交付
                      </button>
                      <p className="wb-form-hint">批准后交付会挂欠款凭证；到期日只作提醒，系统不自动扣款。</p>
                    </div>
                  </fieldset>
                ) : null}

                {canReturn && detail.order.fulfillmentState === 'delivered' ? (
                  <fieldset>
                    <legend>登记退货</legend>
                    <label className="wb-field">
                      <span>行号 position</span>
                      <input value={returnPosition} onChange={(event) => setReturnPosition(event.target.value)} placeholder="第 1 行是 0" />
                    </label>
                    <label className="wb-field">
                      <span>数量</span>
                      <input value={returnQty} onChange={(event) => setReturnQty(event.target.value)} />
                    </label>
                    <label className="wb-field">
                      <span>贷项金额（元）</span>
                      <input value={returnCreditYuan} onChange={(event) => setReturnCreditYuan(event.target.value)} placeholder="退多少钱" />
                    </label>
                    <label className="wb-field">
                      <span>二手件实物编号（可留空）</span>
                      <input value={returnItemId} onChange={(event) => setReturnItemId(event.target.value)} placeholder="退二手件时填实物 ID" />
                    </label>
                    <label className="wb-field">
                      <span>原因</span>
                      <input value={returnReason} onChange={(event) => setReturnReason(event.target.value)} placeholder="花屏 / 客户退等" />
                    </label>
                    <div className="wb-form-actions">
                      <button type="button" className="wb-btn" disabled={busy || returnPosition.trim() === '' || !returnQty.trim() || !returnCreditYuan.trim() || !returnReason.trim()} onClick={() => void handleReturn()}>
                        登记退货
                      </button>
                      <p className="wb-form-hint">退货登记为「待批准」，老板批准贷项后才计入应退、才可退款。</p>
                    </div>
                  </fieldset>
                ) : null}

                {canRefund && detail.returns.some((ret) => ret.creditState === 'approved') ? (
                  <fieldset>
                    <legend>登记退款</legend>
                    <label className="wb-field">
                      <span>退货单</span>
                      <select value={refundReturnRef} onChange={(event) => setRefundReturnRef(event.target.value)}>
                        <option value="">请选择已批准的退货单</option>
                        {detail.returns.filter((ret) => ret.creditState === 'approved').map((ret) => (
                          <option key={ret.id} value={ret.id}>
                            {formatDateTime(ret.createdAt)} · 贷项 {formatYuan(ret.creditCents)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="wb-field">
                      <span>退款金额（元）</span>
                      <input value={refundYuan} onChange={(event) => setRefundYuan(event.target.value)} placeholder="0.00" />
                    </label>
                    <label className="wb-field">
                      <span>方式</span>
                      <select value={refundMethod} onChange={(event) => setRefundMethod(event.target.value as CashMethod)}>
                        {Object.entries(METHOD_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="wb-field">
                      <span>原因</span>
                      <input value={refundReason} onChange={(event) => setRefundReason(event.target.value)} placeholder="退显卡款等" />
                    </label>
                    <label className="wb-check">
                      <span><input type="checkbox" checked={refundVerified} onChange={(event) => setRefundVerified(event.target.checked)} /> 我已核实退款实际付出/到账；申请中、处理中或结果未知不算退款成功</span>
                    </label>
                    <div className="wb-form-actions">
                      <button type="button" className="wb-btn" disabled={busy || !refundVerified || !refundReturnRef || !refundYuan.trim() || !refundReason.trim()} onClick={() => void handleRefund()}>
                        登记退款
                      </button>
                      <p className="wb-form-hint">此操作只登记已实际完成的退款；申请中、处理中或结果未知不得登记。只能对已批准的退货贷项登记，超可退上限由服务端拒绝。</p>
                    </div>
                  </fieldset>
                ) : null}
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

export default WorkbenchSalesPage
