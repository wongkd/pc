/**
 * E11 · 回收置换页（网页端 ERP）。
 *
 * 一页两态：列表 → 详情（含按状态渲染的动作区）。数据全部来自 `/api/v2/recovery/orders*`
 * 与 `/api/v2/finance/payments`，没有演示数据；服务端给什么就显示什么，
 * 无权限动作由服务端 403 兜底，本页只按权限码显隐入口。
 *
 * 业务口径（契约 actions.json B26–B29 / B44 / B33，0020_recovery.sql）：
 *   · 登记的是客户暂存物：不进自有库存、不计成本，只有 B28 取得所有权后才归门店；
 *   · 收购后实物进 quarantine 待检，不自动可卖（需在库存页完成 B19 判定）；
 *   · 应付 = 最终收购价 − 已付现金，超付由服务端拒绝；
 *   · 拆件守恒：产出件成本 + 损耗 = 源整机成本，差额不为零整批回滚；
 *   · 抵用 / 折抵（B31/B32）在详情中通过 TradeInPanel 调用；金额与主体由服务端校验。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { formatYuan } from './inventory-view'
import { AttachmentPanel } from './AttachmentPanel'
import { TradeInPanel } from './TradeInPanel'
import { fetchInventory } from './inventory-api'
import type { InventoryProductRow } from './inventory-api'
import { resolveOfferPriceCents } from './recovery-view'
import { fetchCustomerOptions } from './quote-api'
import type { CustomerOption } from './quote-api'
import {
  acquireRecovery,
  fetchRecoveryOrderDetail,
  fetchRecoveryOrders,
  inspectRecovery,
  offerRecovery,
  payRecovery,
  registerRecovery,
  returnRecovery,
  teardownRecovery,
} from './recovery-api'
import type {
  AcquisitionLine,
  CashMethod,
  RecoveryItemInput,
  RecoveryOrderDetail,
  RecoveryOrderListPayload,
  RecoveryState,
  ScrapLineInput,
  TeardownOutputInput,
} from './recovery-api'
import '../../styles/workbench.css'
import './recovery-guidance.css'

const STATE_LABELS: Record<string, string> = {
  draft: '草稿',
  received_for_inspection: '待验机',
  inspecting: '验机中',
  offered: '已报价',
  acquired: '已收购',
  disassembled: '已拆件',
  refurbishing: '整备中',
  ready_for_sale: '可上架',
  return_pending: '待归还',
  returned: '已归还',
}

const METHOD_LABELS: Record<CashMethod, string> = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝',
  bank: '银行转账',
  other: '其他',
}

/** 老板是 `*`；店员按契约码或旧码判断（与 domains/access.ts 的 LEGACY_EQUIVALENT 同源）。 */
function hasAny(permissions: readonly string[], codes: readonly string[]): boolean {
  return permissions.includes('*') || codes.some((code) => permissions.includes(code))
}

const VIEW_CODES = ['recovery/view', 'quote/view']
const EDIT_CODES = ['recovery/edit', 'quote/edit']
const ACQUIRE_CODES = ['recovery/acquire']
const PAY_CODES = ['finance/payment']

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

function centsToYuan(cents: number | null): string {
  if (cents === null || cents === undefined) return ''
  return String(cents / 100)
}

type Notice = { kind: 'ok' | 'warn' | 'error'; text: string } | null
type ActionKey = 'intake' | 'offer' | 'acquire' | 'pay' | 'teardown' | 'return' | null

const ALL_STATES: RecoveryState[] = [
  'received_for_inspection', 'inspecting', 'offered', 'acquired', 'disassembled', 'returned',
]

const RECOVERY_FLOW_STEPS = [
  { title: '登记旧设备', detail: '客户暂存，不进入库存' },
  { title: '验机并报价', detail: '把最终价格告知卖方' },
  { title: '确认收购', detail: '取得所有权后才入待检库存' },
  { title: '结算并处理旧机', detail: '置换抵款、付款或拆件' },
] as const

type RecoveryNextStep = { title: string; detail: string; action: string | null; href?: string }

function recoveryNextStep(state: RecoveryState): RecoveryNextStep {
  switch (state) {
    case 'received_for_inspection':
      return { title: '下一步：验机，再发出最终报价', detail: '初步估价只是参考。核对实物后录入最终价；卖方接受后再确认收购。', action: '查看验机与报价操作' }
    case 'inspecting':
      return { title: '下一步：填写每件设备的最终报价', detail: '发出报价后等待卖方确认。卖方不接受时，可以写明原因并归还。', action: '查看报价操作' }
    case 'offered':
      return { title: '下一步：卖方同意后确认收购', detail: '选择对应商品并核对每件成本。确认后设备才归门店，并进入待检库存；回收应付也在这一步形成。', action: '查看收购操作' }
    case 'acquired':
      return { title: '设备已收购：选择结算方式', detail: '要抵新订单，使用下方「旧设备抵新购款」；要给卖方现金，则先在现实中付款，再登记付款记录。系统不会发起转账。', action: null }
    case 'disassembled':
      return { title: '拆件已登记', detail: '拆出的部件进入待检库存。请到库存页完成验收、整备后再上架。', action: '打开库存页', href: '/inventory' }
    case 'refurbishing':
      return { title: '设备正在整备', detail: '到库存页继续检查和整备；完成上架前，设备不会作为可售库存。', action: '打开库存页', href: '/inventory' }
    case 'ready_for_sale':
      return { title: '旧设备已可上架', detail: '回收处理已完成。后续销售从库存页选择这件实物。', action: '打开库存页', href: '/inventory' }
    case 'returned':
      return { title: '这张回收单已结束', detail: '设备已归还卖方，不会进入本店库存。', action: null }
    case 'return_pending':
      return { title: '这张回收单正在办理归还', detail: '核对归还原因与实物交接记录。', action: null }
    default:
      return { title: '先验机并给卖方报价', detail: '登记只代表收到待检查实物，不代表已经收购。', action: '查看验机与报价操作' }
  }
}

function recoveryInventoryImpact(state: RecoveryState, itemCount: number, ownedItemCount: number) {
  if (state === 'returned') return '已归还卖方 · 不进入本店库存'
  if (state === 'disassembled') return '源设备已出库 · 拆出的配件分别入待检库存'
  if (state === 'acquired') return `${ownedItemCount} / ${itemCount} 件已取得并进入待检库存`
  if (state === 'refurbishing' || state === 'ready_for_sale') return `${ownedItemCount} 件归店实物继续由配件台账跟踪`
  return '客户暂存中 · 登记、验机和估价都不改变库存'
}

function RecoveryFlowGuide({ state, itemCount = 0, ownedItemCount = 0 }: {
  state?: RecoveryState
  itemCount?: number
  ownedItemCount?: number
}) {
  const nextStep = state ? recoveryNextStep(state) : null

  return (
    <section className="wb-recovery-guide" aria-label="回收操作指引">
      <div className="wb-recovery-guide__heading">
        <div>
          <p className="wb-kicker">配件流转</p>
          <h2>{nextStep?.title ?? '收旧件只在确认收购时入库'}</h2>
        </div>
      </div>
      {state ? <>
        <div className="wb-recovery-next">
          <div>
            <span className="wb-recovery-next__eyebrow">当前库存影响</span>
            <p>{recoveryInventoryImpact(state, itemCount, ownedItemCount)}</p>
          </div>
          {nextStep?.action ? <a className="wb-btn wb-btn--primary" href={nextStep.href ?? '#recovery-actions'}>{nextStep.action} <span aria-hidden="true">↓</span></a> : null}
          {state === 'acquired' ? <div className="wb-recovery-next__choices">
            <a href="#recovery-tradein">选择销售单并抵扣 <span aria-hidden="true">↓</span></a>
            <a href="#recovery-actions">登记实际付款 <span aria-hidden="true">↓</span></a>
          </div> : null}
        </div>
        {nextStep ? <p className="wb-recovery-guide__note">{nextStep.detail}</p> : null}
      </> : <p className="wb-recovery-guide__note">登记、验机、估价不会入库；确认取得所有权时入待检库存。拆件会记录源设备出库和产出配件入库。</p>}
      <details className="wb-recovery-guide__more">
        <summary>{state ? '查看完整处理规则' : '查看处理步骤与置换规则'}</summary>
        <ol className="wb-recovery-guide__steps">
          {RECOVERY_FLOW_STEPS.map((step) => <li key={step.title}>
            <span className="wb-recovery-guide__step-copy"><strong>{step.title}</strong><small>{step.detail}</small></span>
          </li>)}
        </ol>
        <p className="wb-recovery-guide__note"><strong>置换抵款：</strong>只有已取得所有权、且同一客户有待收销售单时才能折抵；折抵不是现金收款，散客回收按实际付款登记。</p>
      </details>
    </section>
  )
}

export function WorkbenchRecoveryPage({ permissions }: { permissions: string[] }) {
  const searchParams = new URLSearchParams(window.location.search)
  const workbenchOrderNo = searchParams.get('orderNo')?.trim() ?? ''
  const workbenchOrderId = searchParams.get('orderId')?.trim() ?? ''
  const startRecoveryCreate = searchParams.get('create') === '1'
  const draftDescription = searchParams.get('draftDescription')?.trim() ?? ''
  const draftSn = searchParams.get('draftSn')?.trim() ?? ''
  const draftNote = searchParams.get('draftNote')?.trim() ?? ''
  const openedWorkbenchOrderNo = useRef<string | null>(null)
  const openedWorkbenchOrderId = useRef<string | null>(null)
  const canView = hasAny(permissions, VIEW_CODES)
  const canEdit = hasAny(permissions, EDIT_CODES)
  const canUploadAttachment = hasAny(permissions, ['attachment/upload', 'library/edit'])
  const canAcquire = hasAny(permissions, ACQUIRE_CODES)
  const canPay = hasAny(permissions, PAY_CODES)

  const [view, setView] = useState<'list' | 'detail'>('list')
  const [orders, setOrders] = useState<RecoveryOrderListPayload | null>(null)
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listError, setListError] = useState('')
  const [stateFilter, setStateFilter] = useState<RecoveryState | 'all'>('all')

  const [detail, setDetail] = useState<RecoveryOrderDetail | null>(null)
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detailError, setDetailError] = useState('')

  const [products, setProducts] = useState<InventoryProductRow[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [actionError, setActionError] = useState('')
  const [activeAction, setActiveAction] = useState<ActionKey>(null)

  // ── 表单 ──
  const [intake, setIntake] = useState({ sellerCustomerId: '', sellerName: '', sellerPhone: '', description: draftDescription, snRaw: draftSn, estimate: '', note: draftNote })
  const [customerOptions, setCustomerOptions] = useState<CustomerOption[]>([])
  const [customerOptionsState, setCustomerOptionsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [customerOptionsError, setCustomerOptionsError] = useState('')
  const [offerPrices, setOfferPrices] = useState<Record<string, string>>({})
  const [acquireRows, setAcquireRows] = useState<AcquisitionLine[]>([])
  const [evidence, setEvidence] = useState('')
  const [payForm, setPayForm] = useState({ amount: '', method: 'cash' as CashMethod, remark: '' })
  const [teardownSource, setTeardownSource] = useState('')
  const [outputs, setOutputs] = useState<TeardownOutputInput[]>([{ productRef: '', costCents: 0 }])
  const [scraps, setScraps] = useState<ScrapLineInput[]>([])
  const [returnReason, setReturnReason] = useState('')

  const refreshList = useCallback(() => {
    setListState('loading')
    setListError('')
    void fetchRecoveryOrders({ state: stateFilter === 'all' ? null : stateFilter, limit: 100 }).then((result) => {
      if (result.ok) {
        setOrders(result.data)
        setListState('ready')
      } else {
        setListError(result.message)
        setListState('error')
      }
    })
  }, [stateFilter])

  const openIntake = useCallback(() => {
    setActiveAction('intake')
    setActionError('')
    setCustomerOptionsState('loading')
    setCustomerOptionsError('')
    void fetchCustomerOptions().then((result) => {
      if (result.ok) {
        setCustomerOptions(result.data.items)
        setCustomerOptionsState('ready')
      } else {
        setCustomerOptionsError(result.message)
        setCustomerOptionsState('error')
      }
    })
  }, [])

  const loadDetail = useCallback((orderId: string) => {
    setDetailState('loading')
    setDetailError('')
    void fetchRecoveryOrderDetail(orderId).then((result) => {
      if (result.ok) {
        setDetail(result.data)
        setDetailState('ready')
      } else {
        setDetailError(result.message)
        setDetailState('error')
      }
    })
  }, [])

  const openDetail = useCallback((orderId: string) => {
    setView('detail')
    setActiveAction(null)
    setActionError('')
    loadDetail(orderId)
  }, [loadDetail])

  // ⚠️ effect 内不能同步 setState（react-hooks/set-state-in-effect，lint 基线会当回归）：
  //    加载态由 useState 的初始值给出，这里只在回调里写结果。
  useEffect(() => {
    if (!canView) return
    let active = true
    void fetchRecoveryOrders({ state: stateFilter === 'all' ? null : stateFilter, limit: 100 }).then((result) => {
      if (!active) return
      if (result.ok) {
        setOrders(result.data)
        setListState('ready')
        setListError('')
        if (workbenchOrderId && openedWorkbenchOrderId.current !== workbenchOrderId) {
          openedWorkbenchOrderId.current = workbenchOrderId
          openDetail(workbenchOrderId)
        } else if (workbenchOrderNo && openedWorkbenchOrderNo.current !== workbenchOrderNo) {
          const taskOrder = result.data.orders.find((row) => row.orderNo === workbenchOrderNo)
          openedWorkbenchOrderNo.current = workbenchOrderNo
          if (taskOrder) openDetail(taskOrder.id)
        }
      } else {
        setListState('error')
        setListError(result.message)
      }
    })
    void fetchInventory({}).then((result) => {
      if (!active) return
      if (result.ok) setProducts(result.data.items)
    })
    return () => { active = false }
  }, [canView, stateFilter, workbenchOrderNo, workbenchOrderId, openDetail])

  useEffect(() => {
    if (!canEdit || !startRecoveryCreate) return
    let active = true
    void Promise.resolve().then(() => {
      if (active) openIntake()
    })
    return () => { active = false }
  }, [canEdit, startRecoveryCreate, openIntake])

  const reloadDetail = useCallback(() => {
    if (!detail) return
    void fetchRecoveryOrderDetail(detail.id).then((result) => {
      if (result.ok) setDetail(result.data)
    })
  }, [detail])

  const finishWrite = useCallback(
    (result: { ok: boolean; unknownResult?: boolean; message?: string }, successText: string) => {
      if (result.ok) {
        setNotice({ kind: 'ok', text: successText })
        setActiveAction(null)
        setActionError('')
        reloadDetail()
        return true
      }
      setActionError(result.unknownResult ? '结果未知（可能已生效），请刷新确认后再继续' : result.message ?? '操作失败')
      return false
    },
    [reloadDetail],
  )

  // ── B26 回收登记 ──
  const submitIntake = useCallback(async () => {
    if (!intake.sellerName.trim()) { setActionError('卖方姓名必填'); return }
    if (!intake.description.trim()) { setActionError('至少登记一件实物'); return }
    const estimate = yuanToCents(intake.estimate)
    const items: RecoveryItemInput[] = [{
      description: intake.description.trim(),
      condition: 'used',
      snRaw: intake.snRaw.trim() || null,
      estimatedCents: estimate,
    }]
    setBusy(true); setActionError('')
    const result = await registerRecovery({
      sellerName: intake.sellerName.trim(),
      sellerPhone: intake.sellerPhone.trim() || null,
      sellerCustomerId: intake.sellerCustomerId ? Number(intake.sellerCustomerId) : null,
      items,
      initialEstimateCents: estimate,
      note: intake.note.trim() || null,
    })
    setBusy(false)
    if (result.ok) {
      setIntake({ sellerCustomerId: '', sellerName: '', sellerPhone: '', description: '', snRaw: '', estimate: '', note: '' })
      setActiveAction(null)
      setNotice({ kind: 'ok', text: result.data.summary || '回收已登记' })
      refreshList()
      if (result.data.entityId) openDetail(result.data.entityId)
      return
    }
    setActionError(result.message)
  }, [intake, openDetail, refreshList])

  // ── B27 ──
  const submitInspect = useCallback(async () => {
    if (!detail) return
    setBusy(true); setActionError('')
    const result = await inspectRecovery(detail.id, null)
    setBusy(false)
    finishWrite(result, '已开始验机')
  }, [detail, finishWrite])

  const submitOffer = useCallback(async () => {
    if (!detail) return
    const itemPrices = detail.items.map((item) => ({
      recoveryItemId: item.id,
      estimatedCents: resolveOfferPriceCents(offerPrices[item.id], item.estimatedCents),
    }))
    setBusy(true); setActionError('')
    const result = await offerRecovery(detail.id, { itemPrices })
    setBusy(false)
    finishWrite(result, '估价已发出')
  }, [detail, finishWrite, offerPrices])

  // ── B28 取得所有权 ──
  const submitAcquire = useCallback(async () => {
    if (!detail) return
    const rows = acquireRows.filter((row) => row.recoveryItemId)
    if (rows.length === 0) { setActionError('至少要填一行收购明细'); return }
    for (const row of rows) {
      if (!row.productRef) { setActionError('每行都要选商品'); return }
      if (!Number.isInteger(row.costCents) || row.costCents < 0) { setActionError('成本不能小于 0，请检查填写金额。'); return }
    }
    const finalAcquisitionCents = rows.reduce((sum, row) => sum + row.costCents, 0)
    setBusy(true); setActionError('')
    const result = await acquireRecovery(detail.id, {
      finalAcquisitionCents,
      lines: rows.map((row) => ({ ...row, assetCode: row.assetCode || undefined })),
      evidenceRef: evidence.trim() || null,
    })
    setBusy(false)
    finishWrite(result, '已取得所有权，实物进入待检')
  }, [acquireRows, detail, evidence, finishWrite])

  // ── B33 付款 ──
  const submitPay = useCallback(async () => {
    if (!detail) return
    const amountCents = yuanToCents(payForm.amount)
    if (!amountCents || amountCents <= 0) { setActionError('付款金额必须是正数'); return }
    setBusy(true); setActionError('')
    const result = await payRecovery(detail.id, {
      amountCents,
      method: payForm.method,
      occurredAt: new Date().toISOString(),
      remark: payForm.remark.trim() || null,
    })
    setBusy(false)
    if (finishWrite(result, '付款已登记')) setPayForm({ amount: '', method: 'cash', remark: '' })
  }, [detail, finishWrite, payForm])

  // ── B44 拆件 ──
  const submitTeardown = useCallback(async () => {
    if (!detail) return
    if (!teardownSource) { setActionError('先选要拆的源实物'); return }
    const lines = outputs.filter((out) => out.productRef)
    if (lines.length === 0) { setActionError('至少选择一个产出商品'); return }
    setBusy(true); setActionError('')
    const result = await teardownRecovery(detail.id, {
      sourceStockItemId: teardownSource,
      outputs: lines,
      scrapLines: scraps.filter((scrap) => scrap.description.trim() && scrap.costCents > 0),
      occurredAt: new Date().toISOString(),
    })
    setBusy(false)
    finishWrite(result, '拆件已入库，产出件进入待检')
  }, [detail, finishWrite, outputs, scraps, teardownSource])

  // ── B29 归还 ──
  const submitReturn = useCallback(async () => {
    if (!detail) return
    if (!returnReason.trim()) { setActionError('归还必须写明原因'); return }
    setBusy(true); setActionError('')
    const result = await returnRecovery(detail.id, returnReason.trim())
    setBusy(false)
    finishWrite(result, '已归还客户')
  }, [detail, finishWrite, returnReason])

  if (!canView) {
    return (
      <div className="wb-page wb-sales-page">
        <div className="wb-page-head">
          <div>
            <p className="wb-kicker">回收与置换</p>
            <h1>回收单</h1>
          </div>
        </div>
        <p className="wb-inv-notice wb-inv-notice--warn">
          当前账号没有查看回收单的权限。请联系老板开通「查看回收」。
        </p>
      </div>
    )
  }

  return (
    <div className="wb-page wb-sales-page">
      {view === 'list' ? (
        <>
          <div className="wb-page-head">
            <div>
              <p className="wb-kicker">回收与置换</p>
              <h1>回收单</h1>
              <p className="wb-caption">登记、验机、估价、收购、付款、拆件与归还。确认收购前实物仍属于卖方，不会进入本店库存。</p>
            </div>
            <div className="wb-page-head-actions">
              {canEdit ? (
                <button type="button" className="wb-btn wb-btn--primary" onClick={openIntake}>
                  回收登记
                </button>
              ) : null}
              <button type="button" className="wb-btn" onClick={refreshList} disabled={busy}>刷新</button>
            </div>
          </div>

          {notice ? <p className="wb-inv-notice">{notice.text}</p> : null}
          {actionError && activeAction === 'intake' ? <p className="wb-inv-notice wb-inv-notice--warn">{actionError}</p> : null}

          <RecoveryFlowGuide />

          <div className="wb-inv-toolbar">
            <div className="wb-filter-row">
              <button type="button" className={`wb-btn${stateFilter === 'all' ? ' wb-btn--primary' : ''}`} onClick={() => setStateFilter('all')}>全部</button>
              {ALL_STATES.map((s) => (
                <button key={s} type="button" className={`wb-btn${stateFilter === s ? ' wb-btn--primary' : ''}`} onClick={() => setStateFilter(s)}>
                  {STATE_LABELS[s] ?? s}
                </button>
              ))}
            </div>
          </div>

          {activeAction === 'intake' ? (
            <div className="wb-inv-toolbar wb-form">
              <fieldset>
                <legend>登记旧设备（客户暂存，不计库存）</legend>
                {draftDescription ? <p className="wb-inv-notice">已从仓库登记草稿带入实物描述和可用编号，请核对后补齐卖方信息。收购确认前不会计入库存。</p> : null}
                <label className="wb-field"><span>关联客户档案</span><select value={intake.sellerCustomerId} disabled={customerOptionsState === 'loading'} onChange={(e) => {
                  const customerId = e.target.value
                  const customer = customerOptions.find((row) => String(row.id) === customerId)
                  setIntake({ ...intake, sellerCustomerId: customerId, sellerName: customer?.name ?? intake.sellerName, sellerPhone: customer?.phone ?? (customerId ? '' : intake.sellerPhone) })
                }}>
                  <option value="">散客（不关联客户档案）</option>
                  {customerOptions.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}{customer.phone ? ` · ${customer.phone}` : ''}</option>)}
                </select></label>
                <p className="wb-recovery-form-hint">要把旧设备抵新订单，请在这里选择客户档案。新销售单也必须属于同一客户；散客登记不能做置换折抵。</p>
                {customerOptionsState === 'loading' ? <p className="wb-caption">正在读取客户档案…</p> : null}
                {customerOptionsState === 'error' ? <p className="wb-inv-notice wb-inv-notice--warn">客户档案读取失败：{customerOptionsError}。想做置换折抵，请先重试并选择客户档案；按散客登记后，这张回收单不能关联客户销售单。<button type="button" className="wb-btn" onClick={openIntake}>重试读取</button></p> : null}
                <label className="wb-field"><span>卖方姓名</span><input value={intake.sellerName} onChange={(e) => setIntake({ ...intake, sellerName: e.target.value })} placeholder="如 陈师傅" /></label>
                <label className="wb-field"><span>联系电话</span><input value={intake.sellerPhone} onChange={(e) => setIntake({ ...intake, sellerPhone: e.target.value })} placeholder="选填" /></label>
                <label className="wb-field"><span>实物描述</span><input value={intake.description} onChange={(e) => setIntake({ ...intake, description: e.target.value })} placeholder="如 联想 ThinkPad T14 整机" /></label>
                <label className="wb-field"><span>序列号</span><input value={intake.snRaw} onChange={(e) => setIntake({ ...intake, snRaw: e.target.value })} placeholder="选填" /></label>
                <label className="wb-field"><span>初步估价（元）</span><input value={intake.estimate} onChange={(e) => setIntake({ ...intake, estimate: e.target.value })} placeholder="选填，如 800" /></label>
                <label className="wb-field"><span>备注</span><input value={intake.note} onChange={(e) => setIntake({ ...intake, note: e.target.value })} placeholder="选填" /></label>
                <div className="wb-form-actions">
                  <button type="button" className="wb-btn wb-btn--primary" disabled={busy} onClick={() => void submitIntake()}>确认登记</button>
                  <button type="button" className="wb-btn" disabled={busy} onClick={() => { setActiveAction(null); setActionError('') }}>取消</button>
                </div>
              </fieldset>
            </div>
          ) : null}

          {listState === 'loading' ? <p className="wb-inv-state">正在加载回收单…</p> : null}
          {listState === 'error' ? (
            <div className="wb-inv-state wb-inv-state--error">
              <p>{listError || '回收单列表加载失败'}</p>
              <button type="button" className="wb-btn" onClick={refreshList}>重试</button>
            </div>
          ) : null}
          {listState === 'ready' && orders && orders.orders.length === 0 ? (
            <p className="wb-inv-state">还没有回收单。点「回收登记」登记第一件旧机。</p>
          ) : null}
          {listState === 'ready' && orders && orders.orders.length > 0 ? (
            <div className="wb-quote-table-scroll">
              <table className="wb-quote-table">
                <thead>
                  <tr>
                    <th>单号</th>
                    <th>卖方</th>
                    <th>状态</th>
                    <th>估价</th>
                    <th>最终价</th>
                    <th>已折抵</th>
                    <th>待结算</th>
                    <th>现金已付</th>
                    <th>登记时间</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.orders.map((o) => (
                    <tr key={o.id} onClick={() => openDetail(o.id)} style={{ cursor: 'pointer' }}>
                      <td className="wb-tabular">{o.orderNo}</td>
                      <td>{o.seller.name || '—'}</td>
                      <td><span className="wb-quote-stock wb-quote-stock--available">{STATE_LABELS[o.state] ?? o.state}</span></td>
                      <td className="wb-tabular">{o.initialEstimateCents === null ? '—' : formatYuan(o.initialEstimateCents)}</td>
                      <td className="wb-tabular">{o.finalAcquisitionCents === null ? '—' : formatYuan(o.finalAcquisitionCents)}</td>
                      <td className="wb-tabular">{o.offsetCents > 0 ? formatYuan(o.offsetCents) : '—'}</td>
                      <td className="wb-tabular">{Math.max(o.payableCents - o.offsetCents, 0) > 0 ? formatYuan(Math.max(o.payableCents - o.offsetCents, 0)) : '—'}</td>
                      <td className="wb-tabular">{o.paidCents > 0 ? formatYuan(o.paidCents) : '—'}</td>
                      <td className="wb-caption">{formatDateTime(o.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : (
        <RecoveryDetail
          detail={detail}
          canUpload={canUploadAttachment}
          permissions={permissions}
          detailState={detailState}
          detailError={detailError}
          products={products}
          canEdit={canEdit}
          canAcquire={canAcquire}
          canPay={canPay}
          busy={busy}
          actionError={actionError}
          activeAction={activeAction}
          setActiveAction={setActiveAction}
          onBack={() => { setView('list'); refreshList() }}
          onReload={loadDetail}
          offerPrices={offerPrices}
          setOfferPrices={setOfferPrices}
          acquireRows={acquireRows}
          setAcquireRows={setAcquireRows}
          evidence={evidence}
          setEvidence={setEvidence}
          payForm={payForm}
          setPayForm={setPayForm}
          teardownSource={teardownSource}
          setTeardownSource={setTeardownSource}
          outputs={outputs}
          setOutputs={setOutputs}
          scraps={scraps}
          setScraps={setScraps}
          returnReason={returnReason}
          setReturnReason={setReturnReason}
          onInspect={() => void submitInspect()}
          onOffer={() => void submitOffer()}
          onAcquire={() => void submitAcquire()}
          onPay={() => void submitPay()}
          onTeardown={() => void submitTeardown()}
          onReturn={() => void submitReturn()}
        />
      )}
    </div>
  )
}

interface DetailProps {
  detail: RecoveryOrderDetail | null
  canUpload: boolean
  permissions: string[]
  detailState: 'loading' | 'ready' | 'error'
  detailError: string
  products: InventoryProductRow[]
  canEdit: boolean
  canAcquire: boolean
  canPay: boolean
  busy: boolean
  actionError: string
  activeAction: ActionKey
  setActiveAction: (key: ActionKey) => void
  onBack: () => void
  onReload: (orderId: string) => void
  offerPrices: Record<string, string>
  setOfferPrices: (value: Record<string, string>) => void
  acquireRows: AcquisitionLine[]
  setAcquireRows: (value: AcquisitionLine[]) => void
  evidence: string
  setEvidence: (value: string) => void
  payForm: { amount: string; method: CashMethod; remark: string }
  setPayForm: (value: { amount: string; method: CashMethod; remark: string }) => void
  teardownSource: string
  setTeardownSource: (value: string) => void
  outputs: TeardownOutputInput[]
  setOutputs: (value: TeardownOutputInput[]) => void
  scraps: ScrapLineInput[]
  setScraps: (value: ScrapLineInput[]) => void
  returnReason: string
  setReturnReason: (value: string) => void
  onInspect: () => void
  onOffer: () => void
  onAcquire: () => void
  onPay: () => void
  onTeardown: () => void
  onReturn: () => void
}

function RecoveryDetail(props: DetailProps) {
  const { detail, detailState, detailError, products, canEdit, canAcquire, canPay, busy } = props
  const { actionError, activeAction, setActiveAction, onBack, onReload } = props

  if (detailState === 'loading' || !detail) {
    return (
      <div className="wb-page-head">
        <div>
          <p className="wb-kicker">回收与置换</p>
          <h1>{detailState === 'error' ? '加载失败' : '正在加载回收单…'}</h1>
          {detailState === 'error' ? <p className="wb-inv-notice wb-inv-notice--warn">{detailError}</p> : null}
        </div>
        <div className="wb-page-head-actions">
          <button type="button" className="wb-btn" onClick={onBack}>返回列表</button>
        </div>
      </div>
    )
  }

  const startAcquire = () => {
    props.setAcquireRows(detail.items.map((item) => ({
      recoveryItemId: item.id,
      productRef: '',
      assetCode: '',
      condition: 'used',
      costCents: item.estimatedCents ?? 0,
    })))
    setActiveAction('acquire')
  }

  const startTeardown = () => {
    const first = detail.items.find((item) => item.stockItemId)
    props.setTeardownSource(first?.stockItemId ?? '')
    props.setOutputs([{ productRef: '', costCents: 0 }])
    props.setScraps([])
    setActiveAction('teardown')
  }

  const ownedItems = detail.items.filter((item) => item.stockItemId)

  return (
    <>
      <div className="wb-page-head">
        <div>
          <p className="wb-kicker">回收与置换</p>
          <h1>{detail.orderNo}</h1>
          <p className="wb-caption">
            卖方 {detail.seller.name || '—'} · 状态 {STATE_LABELS[detail.state] ?? detail.state} · 版本 {detail.version}
          </p>
        </div>
        <div className="wb-page-head-actions">
          <button type="button" className="wb-btn" onClick={onBack}>返回列表</button>
          <button type="button" className="wb-btn" disabled={busy} onClick={() => onReload(detail.id)}>刷新</button>
        </div>
      </div>

      <RecoveryFlowGuide state={detail.state} itemCount={detail.items.length} ownedItemCount={ownedItems.length} />

      {actionError ? <p className="wb-inv-notice wb-inv-notice--warn">{actionError}</p> : null}

      <div className="wb-quote-table-scroll">
        <table className="wb-quote-table">
          <thead>
            <tr>
              <th>实物</th>
              <th>成色</th>
              <th>序列号</th>
              <th>估价</th>
              <th>取得成本</th>
              <th>实物编号</th>
            </tr>
          </thead>
          <tbody>
            {detail.items.map((item) => (
              <tr key={item.id}>
                <td>{item.description}</td>
                <td>{item.condition === 'new' ? '全新' : '二手'}</td>
                <td className="wb-tabular">{item.snRaw || '—'}</td>
                <td className="wb-tabular">{item.estimatedCents === null ? '—' : formatYuan(item.estimatedCents)}</td>
                <td className="wb-tabular">{item.acquiredCostCents === null ? '—' : formatYuan(item.acquiredCostCents)}</td>
                <td className="wb-caption">{item.stockItemId ? <a href={'/inventory?itemId=' + encodeURIComponent(item.stockItemId)}>{item.stockItemId} · 在仓库查看</a> : '未取得所有权'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="wb-recovery-optional">
        <summary>结算金额 · 待结算 {formatYuan(Math.max(detail.payableCents - detail.offsetCents - detail.paidCents, 0))}</summary>
        <div className="wb-inv-totals">
          <div className="wb-inv-total"><span>初步估价</span><strong>{detail.initialEstimateCents === null ? '—' : formatYuan(detail.initialEstimateCents)}</strong></div>
          <div className="wb-inv-total"><span>最终收购价</span><strong>{detail.finalAcquisitionCents === null ? '—' : formatYuan(detail.finalAcquisitionCents)}</strong></div>
          <div className="wb-inv-total"><span>已折抵</span><strong>{formatYuan(detail.offsetCents)}</strong></div>
          <div className="wb-inv-total"><span>现金已付</span><strong>{formatYuan(detail.paidCents)}</strong></div>
          <div className="wb-inv-total"><span>待结算</span><strong>{formatYuan(Math.max(detail.payableCents - detail.offsetCents - detail.paidCents, 0))}</strong></div>
        </div>
      </details>

      <details className="wb-recovery-optional">
        <summary>照片与附件 · {detail.attachments?.length ?? 0} 项</summary>
        <AttachmentPanel attachments={detail.attachments ?? []} ownerType="recovery_order" ownerId={detail.id} canUpload={props.canUpload} onUploaded={() => onReload(detail.id)} />
      </details>
      <TradeInPanel recovery={detail} permissions={props.permissions} onChanged={() => onReload(detail.id)} />

      <section id="recovery-actions" className="wb-recovery-actions" aria-label="本单可执行操作">
        <h2>本单可执行操作</h2>
        <p>按上方“本单下一步”提示操作；其他动作按实际需要选择。</p>
        <div className="wb-inv-toolbar">
          <div className="wb-filter-row">
            {canEdit && detail.state === 'received_for_inspection' ? (
              <button type="button" className="wb-btn" disabled={busy} onClick={props.onInspect}>开始验机</button>
            ) : null}
            {canEdit && (detail.state === 'inspecting' || detail.state === 'received_for_inspection') ? (
              <button type="button" className="wb-btn" disabled={busy} onClick={() => setActiveAction('offer')}>出估价</button>
            ) : null}
            {canAcquire && detail.state === 'offered' ? (
              <button type="button" className="wb-btn wb-btn--primary" disabled={busy} onClick={startAcquire}>取得所有权</button>
            ) : null}
            {canPay && detail.payableCents > 0 ? (
              <button type="button" className="wb-btn" disabled={busy} onClick={() => setActiveAction('pay')}>登记付款</button>
            ) : null}
            {canEdit && detail.state === 'acquired' && ownedItems.length > 0 ? (
              <button type="button" className="wb-btn" disabled={busy} onClick={startTeardown}>拆件入库</button>
            ) : null}
            {canEdit && (detail.state === 'offered' || detail.state === 'inspecting' || detail.state === 'received_for_inspection') ? (
              <button type="button" className="wb-btn" disabled={busy} onClick={() => setActiveAction('return')}>归还客户</button>
            ) : null}
          </div>
        </div>
      </section>

      {activeAction === 'offer' ? (
        <div className="wb-inv-toolbar wb-form">
          <fieldset>
            <legend>出估价（逐件，单位：元）</legend>
            {detail.items.map((item) => (
              <label key={item.id} className="wb-field">
                <span>{item.description}</span>
                <input
                  value={props.offerPrices[item.id] ?? centsToYuan(item.estimatedCents)}
                  onChange={(e) => props.setOfferPrices({ ...props.offerPrices, [item.id]: e.target.value })}
                  placeholder="0"
                />
              </label>
            ))}
            <div className="wb-form-actions">
              <button type="button" className="wb-btn wb-btn--primary" disabled={busy} onClick={props.onOffer}>发出估价</button>
              <button type="button" className="wb-btn" disabled={busy} onClick={() => setActiveAction(null)}>取消</button>
            </div>
          </fieldset>
        </div>
      ) : null}

      {activeAction === 'acquire' ? (
        <div className="wb-inv-toolbar wb-form">
          <fieldset>
            <legend>确认收购并入待检库存</legend>
            <p className="wb-recovery-form-hint">核对每件实物对应的商品和成本。这里确认后，设备才归门店并开始计入库存；逐件成本合计必须等于最终收购价。</p>
            {props.acquireRows.map((row, index) => (
              <div key={row.recoveryItemId} className="wb-filter-row">
                <span className="wb-caption">{detail.items[index]?.description ?? row.recoveryItemId}</span>
                <select value={row.productRef} onChange={(e) => {
                  const next = [...props.acquireRows]
                  next[index] = { ...row, productRef: e.target.value }
                  props.setAcquireRows(next)
                }}>
                  <option value="">选择商品…</option>
                  {products.map((p) => (<option key={p.id} value={p.id}>{p.category} · {p.name}</option>))}
                </select>
                <span className="wb-caption">内部编号：取得后自动生成</span>
                <input value={row.snRaw ?? ''} placeholder="厂家 SN（选填，可扫码）" onChange={(e) => {
                  const next = [...props.acquireRows]
                  next[index] = { ...row, snRaw: e.target.value }
                  props.setAcquireRows(next)
                }} />
                <input value={row.remark ?? ''} placeholder="实物备注（选填）" onChange={(e) => {
                  const next = [...props.acquireRows]
                  next[index] = { ...row, remark: e.target.value }
                  props.setAcquireRows(next)
                }} />
                <input
                  value={centsToYuan(row.costCents)}
                  placeholder="成本（元）"
                  onChange={(e) => {
                    const next = [...props.acquireRows]
                    next[index] = { ...row, costCents: yuanToCents(e.target.value) ?? 0 }
                    props.setAcquireRows(next)
                  }}
                />
              </div>
            ))}
            <label className="wb-field"><span>收购凭证（选填）</span><input value={props.evidence} onChange={(e) => props.setEvidence(e.target.value)} placeholder="照片 / 身份证复印件编号" /></label>
            <div className="wb-form-actions">
              <button type="button" className="wb-btn wb-btn--primary" disabled={busy} onClick={props.onAcquire}>确认收购并入库存</button>
              <button type="button" className="wb-btn" disabled={busy} onClick={() => setActiveAction(null)}>取消</button>
            </div>
          </fieldset>
        </div>
      ) : null}

      {activeAction === 'pay' ? (
        <div className="wb-inv-toolbar wb-form">
          <fieldset>
            <legend>登记已付给卖方的金额</legend>
            <p className="wb-recovery-form-hint">只记录现实中已经付出的金额，不会从系统发起转账。最多可登记剩余待结算金额 {formatYuan(Math.max(detail.payableCents - detail.offsetCents, 0))}。</p>
            <label className="wb-field"><span>本次已付款（元）</span><input value={props.payForm.amount} onChange={(e) => props.setPayForm({ ...props.payForm, amount: e.target.value })} placeholder="输入实际付给卖方的金额" /></label>
            <label className="wb-field">
              <span>方式</span>
              <select value={props.payForm.method} onChange={(e) => props.setPayForm({ ...props.payForm, method: e.target.value as CashMethod })}>
                {(Object.keys(METHOD_LABELS) as CashMethod[]).map((m) => (<option key={m} value={m}>{METHOD_LABELS[m]}</option>))}
              </select>
            </label>
            <label className="wb-field"><span>备注</span><input value={props.payForm.remark} onChange={(e) => props.setPayForm({ ...props.payForm, remark: e.target.value })} placeholder="选填" /></label>
            <div className="wb-form-actions">
              <button type="button" className="wb-btn wb-btn--primary" disabled={busy} onClick={props.onPay}>保存付款记录</button>
              <button type="button" className="wb-btn" disabled={busy} onClick={() => setActiveAction(null)}>取消</button>
            </div>
          </fieldset>
        </div>
      ) : null}

      {activeAction === 'teardown' ? (
        <div className="wb-inv-toolbar wb-form">
          <fieldset>
            <legend>拆件入库（产出成本 + 损耗 = 源整机成本）</legend>
            <label className="wb-field">
              <span>源实物</span>
              <select value={props.teardownSource} onChange={(e) => props.setTeardownSource(e.target.value)}>
                <option value="">选择…</option>
                {ownedItems.map((item) => (
                  <option key={item.stockItemId} value={item.stockItemId ?? ''}>
                    {item.description}（成本 {item.acquiredCostCents === null ? '—' : formatYuan(item.acquiredCostCents)}）
                  </option>
                ))}
              </select>
            </label>
            {props.outputs.map((out, index) => (
              <div key={`out-${index}`} className="wb-filter-row">
                <select value={out.productRef} onChange={(e) => {
                  const next = [...props.outputs]
                  next[index] = { ...out, productRef: e.target.value }
                  props.setOutputs(next)
                }}>
                  <option value="">产出商品…</option>
                  {products.map((p) => (<option key={p.id} value={p.id}>{p.category} · {p.name}</option>))}
                </select>
                <span className="wb-caption">内部编号：入库后自动生成</span>
                <input value={out.snRaw ?? ''} placeholder="厂家 SN（选填，可扫码）" onChange={(e) => {
                  const next = [...props.outputs]
                  next[index] = { ...out, snRaw: e.target.value }
                  props.setOutputs(next)
                }} />
                <input value={out.remark ?? ''} placeholder="实物备注（选填）" onChange={(e) => {
                  const next = [...props.outputs]
                  next[index] = { ...out, remark: e.target.value }
                  props.setOutputs(next)
                }} />
                <input value={centsToYuan(out.costCents)} placeholder="成本（元）" onChange={(e) => {
                  const next = [...props.outputs]
                  next[index] = { ...out, costCents: yuanToCents(e.target.value) ?? 0 }
                  props.setOutputs(next)
                }} />
              </div>
            ))}
            <button type="button" className="wb-btn" disabled={busy} onClick={() => props.setOutputs([...props.outputs, { productRef: '', costCents: 0 }])}>再加一个产出件</button>
            {props.scraps.map((scrap, index) => (
              <div key={`scrap-${index}`} className="wb-filter-row">
                <input value={scrap.description} placeholder="损耗说明（如 主板腐蚀）" onChange={(e) => {
                  const next = [...props.scraps]
                  next[index] = { ...scrap, description: e.target.value }
                  props.setScraps(next)
                }} />
                <input value={centsToYuan(scrap.costCents)} placeholder="损耗金额（元）" onChange={(e) => {
                  const next = [...props.scraps]
                  next[index] = { ...scrap, costCents: yuanToCents(e.target.value) ?? 0 }
                  props.setScraps(next)
                }} />
              </div>
            ))}
            <button type="button" className="wb-btn" disabled={busy} onClick={() => props.setScraps([...props.scraps, { description: '', costCents: 0 }])}>加一行损耗</button>
            <div className="wb-form-actions">
              <button type="button" className="wb-btn wb-btn--primary" disabled={busy} onClick={props.onTeardown}>确认拆件</button>
              <button type="button" className="wb-btn" disabled={busy} onClick={() => setActiveAction(null)}>取消</button>
            </div>
          </fieldset>
        </div>
      ) : null}

      {activeAction === 'return' ? (
        <div className="wb-inv-toolbar wb-form">
          <fieldset>
            <legend>归还客户（不产生采购成本与可卖库存）</legend>
            <label className="wb-field"><span>原因</span><input value={props.returnReason} onChange={(e) => props.setReturnReason(e.target.value)} placeholder="如 客户嫌价低，不卖了" /></label>
            <div className="wb-form-actions">
              <button type="button" className="wb-btn wb-btn--primary" disabled={busy} onClick={props.onReturn}>确认归还</button>
              <button type="button" className="wb-btn" disabled={busy} onClick={() => setActiveAction(null)}>取消</button>
            </div>
          </fieldset>
        </div>
      ) : null}
    </>
  )
}
