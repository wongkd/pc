/**
 * E10 · 售后维修页（网页端 ERP）。
 *
 * 一页两态：列表 → 详情（含按状态渲染的动作区）。数据全部来自 `/api/v2/service/orders*`，
 * 没有演示数据；服务端给什么就显示什么，无权限动作由服务端 403 兜底，本页只按 allowedActions 显隐入口。
 *
 * 业务口径（docs/2026-09-19-报价单业务规则.md、E10 设计）：
 *   · 客户财产不计自有库存：接修只落保管记录，换件（B23）才碰自有备件；
 *   · 未确认方案不产生应收：确认（B22）前 confirmed_charge_cents 为空，不能收款；
 *   · 归还闸门：费用结清（balance=0）才复测通过、才归还，首版不做欠款归还；
 *   · 收款（B41）与归还（B25）是两次独立提交，钱收了货没还，账依然成立。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { formatYuan } from './inventory-view'
import { AttachmentPanel } from './AttachmentPanel'
import {
  confirmProposal,
  createServiceOrder,
  dispatchExternal,
  fetchServiceOrderDetail,
  fetchServiceOrders,
  receiveExternal,
  registerServicePayment,
  replacePart,
  retestDevice,
  returnDevice,
  saveDiagnosis,
  saveProposal,
} from './service-api'
import type {
  CashMethod,
  ServiceOrderDetail,
  ServiceOrderListPayload,
  ServiceState,
} from './service-api'
import '../../styles/workbench.css'

const STATE_LABELS: Record<string, string> = {
  received: '已接修',
  diagnosing: '检测中',
  awaiting_approval: '待确认',
  repairing: '维修中',
  outsourced: '已外送',
  retesting: '复测中',
  ready_return: '待归还',
  returned: '已归还',
  closed: '已关闭',
}

const ACTION_LABELS: Record<string, string> = {
  diagnosis: '录入诊断',
  proposal: '录入方案',
  'confirm-proposal': '方案确认',
  dispatch: '外送 / 返厂',
  replace: '换件',
  'receive-external': '外送返回',
  retest: '复测通过',
  return: '归还客户',
  payment: '登记收款',
}

const METHOD_LABELS: Record<CashMethod, string> = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝',
  bank: '银行转账',
  other: '其他',
}

const CONFIRMATION_METHOD_LABELS: Record<string, string> = {
  phone: '电话',
  wechat: '微信',
  in_person: '到店',
  other: '其他',
}

const WARRANTY_DECISION_LABELS: Record<string, string> = {
  in_warranty: '保内',
  out_of_warranty: '保外',
  undetermined: '待定',
}

const OLD_ITEM_DISPOSITION_LABELS: Record<string, string> = {
  return_to_customer: '归还客户',
  scrapped: '报废',
  quarantine: '隔离待处理',
  return_to_supplier: '退回供应商',
}

/** 老板是 `*`；店员按契约码或旧码判断（与 domains/access.ts 的 LEGACY_EQUIVALENT 同源）。 */
function hasAny(permissions: readonly string[], codes: readonly string[]): boolean {
  return permissions.includes('*') || codes.some((code) => permissions.includes(code))
}

const VIEW_CODES = ['service/view', 'quote/view']
const EDIT_CODES = ['service/edit', 'quote/edit']
const CHARGE_CODES = ['service/charge', 'quote/edit']

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

const ALL_STATES: ServiceState[] = [
  'received', 'diagnosing', 'awaiting_approval', 'repairing', 'outsourced', 'retesting', 'ready_return', 'returned', 'closed',
]

export function WorkbenchServicePage({ permissions }: { permissions: string[] }) {
  const workbenchOrderNo = new URLSearchParams(window.location.search).get('orderNo')?.trim() ?? ''
  const openedWorkbenchOrderNo = useRef<string | null>(null)
  const canView = hasAny(permissions, VIEW_CODES)
  const canEdit = hasAny(permissions, EDIT_CODES)
  const canCharge = hasAny(permissions, CHARGE_CODES)
  const canUploadAttachment = hasAny(permissions, ['attachment/upload', 'library/edit'])

  // 列表态
  const [view, setView] = useState<'list' | 'detail'>('list')
  const [orders, setOrders] = useState<ServiceOrderListPayload | null>(null)
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [stateFilter, setStateFilter] = useState<ServiceState | 'all'>('all')
  const [listError, setListError] = useState('')

  // 详情态
  const [detail, setDetail] = useState<ServiceOrderDetail | null>(null)
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'error'>('loading')

  // 动作与提示
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [activeAction, setActiveAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')

  // 接修表单
  const [showIntake, setShowIntake] = useState(false)
  const [intake, setIntake] = useState({ customerName: '', manufacturerSn: '', symptom: '', accessories: '', appearance: '' })
  const [deviceQuery, setDeviceQuery] = useState('')
  const [appliedDeviceQuery, setAppliedDeviceQuery] = useState('')

  const refreshList = useCallback(() => {
    setListState('loading')
    void fetchServiceOrders({ state: stateFilter === 'all' ? null : stateFilter, q: appliedDeviceQuery || undefined }).then((result) => {
      if (result.ok) {
        setOrders(result.data)
        setListState('ready')
        setListError('')
      } else {
        setListState('error')
        setListError(result.message)
      }
    })
  }, [stateFilter, appliedDeviceQuery])

  const openDetail = useCallback((orderId: string) => {
    setView('detail')
    setDetailState('loading')
    setDetail(null)
    setActiveAction(null)
    setActionError('')
    void fetchServiceOrderDetail(orderId).then((result) => {
      if (result.ok) {
        setDetail(result.data.order)
        setDetailState('ready')
      } else {
        setDetailState('error')
        setActionError(result.message)
      }
    })
  }, [])

  const reloadDetail = useCallback(() => {
    if (!detail) return
    void fetchServiceOrderDetail(detail.id).then((result) => {
      if (result.ok) setDetail(result.data.order)
    })
  }, [detail])

  // ⚠️ 不在 effect 里同步 setState（`react-hooks/set-state-in-effect`）：加载态由初始值
  // 与事件处理设置，effect 只内联发起请求，把 setState 放在 .then 回调里。
  useEffect(() => {
    if (!canView) return
    let active = true
    void fetchServiceOrders({ state: stateFilter === 'all' ? null : stateFilter, q: appliedDeviceQuery || undefined }).then((result) => {
      if (!active) return
      if (result.ok) {
        setOrders(result.data)
        setListState('ready')
        setListError('')
        if (workbenchOrderNo && openedWorkbenchOrderNo.current !== workbenchOrderNo) {
          const taskOrder = result.data.orders.find((row) => row.orderNo === workbenchOrderNo)
          openedWorkbenchOrderNo.current = workbenchOrderNo
          if (taskOrder) openDetail(taskOrder.id)
        }
      } else {
        setListState('error')
        setListError(result.message)
      }
    })
    return () => {
      active = false
    }
  }, [canView, stateFilter, appliedDeviceQuery, workbenchOrderNo, openDetail])

  const finishWrite = useCallback((result: ApiResultLike, successText: string) => {
    if (result.ok) {
      setNotice({ kind: 'ok', text: successText })
      setActiveAction(null)
      setActionError('')
      reloadDetail()
      return true
    }
    if (result.unknownResult) {
      setActionError('操作结果未知（可能已生效）。请刷新页面确认后再继续。')
    } else {
      setActionError(result.message ?? '')
    }
    return false
  }, [reloadDetail])

  // ── 各动作提交 ──

  const submitIntake = useCallback(async () => {
    if (!intake.symptom.trim()) {
      setActionError('故障描述必填')
      return
    }
    if (!intake.customerName.trim()) {
      setActionError('散客必须填客户称呼')
      return
    }
    setBusy(true)
    setActionError('')
    const result = await createServiceOrder({
      customerName: intake.customerName.trim(),
      manufacturerSn: intake.manufacturerSn.trim(),
      symptom: intake.symptom.trim(),
      accessories: intake.accessories.trim() ? intake.accessories.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : null,
      appearance: intake.appearance.trim() || null,
    })
    setBusy(false)
    if (result.ok) {
      setShowIntake(false)
      setIntake({ customerName: '', manufacturerSn: '', symptom: '', accessories: '', appearance: '' })
      setNotice({ kind: 'ok', text: result.data.summary || '接修已登记' })
      refreshList()
      if (result.data.entityId) openDetail(result.data.entityId)
      return
    }
    setActionError(result.message)
  }, [intake, refreshList, openDetail])

  const submitDiagnosis = useCallback(async (text: string) => {
    if (!detail) return
    if (!text.trim()) { setActionError('诊断说明必填'); return }
    setBusy(true); setActionError('')
    const result = await saveDiagnosis(detail.id, text.trim())
    setBusy(false)
    finishWrite(result, '已录入诊断')
  }, [detail, finishWrite])

  const submitProposal = useCallback(async (p: { name: string; qty: number; unitPriceCents: number; chargeType: 'charge' | 'warranty'; warrantyDecision: string }) => {
    if (!detail) return
    if (!p.name.trim()) { setActionError('维修项目名称必填'); return }
    if (!Number.isInteger(p.qty) || p.qty <= 0) { setActionError('数量必须是正整数'); return }
    if (!Number.isInteger(p.unitPriceCents) || p.unitPriceCents < 0) { setActionError('单价必须是非负整数分'); return }
    setBusy(true); setActionError('')
    const items = [{ name: p.name.trim(), qty: p.qty, unitPriceCents: p.unitPriceCents, chargeType: p.chargeType }]
    const chargeCents = p.qty * p.unitPriceCents
    const result = await saveProposal(detail.id, { items, chargeCents, warrantyDecision: p.warrantyDecision || null })
    setBusy(false)
    finishWrite(result, '已录入维修方案')
  }, [detail, finishWrite])

  const submitConfirm = useCallback(async (accepted: boolean, confirmationMethod: string) => {
    if (!detail) return
    if (!detail.proposalVersion) { setActionError('还没有方案版本，无法确认'); return }
    setBusy(true); setActionError('')
    const result = await confirmProposal(detail.id, {
      proposalVersion: detail.proposalVersion,
      confirmationMethod,
      confirmedAt: new Date().toISOString(),
      accepted,
    })
    setBusy(false)
    finishWrite(result, accepted ? '方案已确认，开始维修' : '已记录拒绝维修，转待归还')
  }, [detail, finishWrite])

  const submitReplace = useCallback(async (comp: { oldComponentRef: string; oldItemDisposition: string; newStockItem: string; chargeType: 'charge' | 'warranty' }) => {
    if (!detail) return
    if (!comp.oldComponentRef.trim()) { setActionError('旧件引用必填'); return }
    if (!detail.proposalVersion) { setActionError('没有方案版本，无法换件'); return }
    setBusy(true); setActionError('')
    const newStockItem = comp.newStockItem.trim() || null
    const result = await replacePart(detail.id, {
      approvedProposalVersion: detail.proposalVersion,
      components: [{ oldComponentRef: comp.oldComponentRef.trim(), oldItemDisposition: comp.oldItemDisposition, newStockItem, qty: newStockItem ? 1 : undefined, chargeType: comp.chargeType }],
    })
    setBusy(false)
    finishWrite(result, '换件完成，进入复测')
  }, [detail, finishWrite])

  const submitDispatch = useCallback(async (receiver: string, note: string) => {
    if (!detail) return
    if (!receiver.trim()) { setActionError('外送接收方必填'); return }
    setBusy(true); setActionError('')
    const result = await dispatchExternal(detail.id, { receiver: receiver.trim(), note: note.trim() || null })
    setBusy(false)
    finishWrite(result, '已外送')
  }, [detail, finishWrite])

  const submitReceiveExternal = useCallback(async () => {
    if (!detail) return
    setBusy(true); setActionError('')
    const result = await receiveExternal(detail.id, null)
    setBusy(false)
    finishWrite(result, '外送件已返回')
  }, [detail, finishWrite])

  const submitRetest = useCallback(async () => {
    if (!detail) return
    setBusy(true); setActionError('')
    const result = await retestDevice(detail.id, { passed: true })
    setBusy(false)
    finishWrite(result, '复测通过，可归还')
  }, [detail, finishWrite])

  const submitReturn = useCallback(async (returnedTo: string, note: string) => {
    if (!detail) return
    if (!returnedTo.trim()) { setActionError('归还人必填'); return }
    setBusy(true); setActionError('')
    const result = await returnDevice(detail.id, { returnedTo: returnedTo.trim(), note: note.trim() || null })
    setBusy(false)
    finishWrite(result, '已归还客户')
  }, [detail, finishWrite])

  const submitPayment = useCallback(async (amountCents: number, method: CashMethod, remark: string) => {
    if (!detail) return
    if (!Number.isInteger(amountCents) || amountCents <= 0) { setActionError('收款金额必须是正整数分'); return }
    setBusy(true); setActionError('')
    const result = await registerServicePayment(detail.id, {
      amountCents, method, occurredAt: new Date().toISOString(), remark: remark.trim() || null,
    })
    setBusy(false)
    finishWrite(result, '收款已登记')
  }, [detail, finishWrite])

  if (!canView) {
    return (
      <div className="wb-page wb-sales-page">
        <div className="wb-page-head">
          <div>
            <p className="wb-kicker">售后维修</p>
            <h1>维修工单</h1>
          </div>
        </div>
        <p className="wb-inv-notice wb-inv-notice--warn">
          当前账号没有查看售后工单的权限。请联系老板开通「查看售后维修」。
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
              <p className="wb-kicker">售后维修</p>
              <h1>维修工单</h1>
              <p className="wb-caption">接修、检测、方案、换件、收款、归还的闭环。金额由服务端汇总，这里只读不编。</p>
            </div>
            <div className="wb-page-head-actions">
              {canEdit ? (
                <button type="button" className="wb-btn wb-btn--primary" onClick={() => { setShowIntake(true); setActionError('') }}>
                  接修登记
                </button>
              ) : null}
              <button type="button" className="wb-btn" onClick={refreshList} disabled={busy}>刷新</button>
            </div>
          </div>

          {notice ? <p className={`wb-inv-notice${notice.kind === 'warn' ? ' wb-inv-notice--warn' : ''}`}>{notice.text}</p> : null}
          {actionError && !showIntake ? <p className="wb-inv-notice wb-inv-notice--warn">{actionError}</p> : null}

          <div className="wb-inv-toolbar">
            <div className="wb-filter-row">
              <form className="wb-inv-toolbar" onSubmit={(event) => { event.preventDefault(); setAppliedDeviceQuery(deviceQuery.trim()); setListState('loading') }}>
                <input className="wb-inv-search" value={deviceQuery} onChange={(event) => setDeviceQuery(event.target.value)} placeholder="查设备编号、厂家 SN 或工单" aria-label="查询维修设备编号" />
                <button type="submit" className="wb-btn">查询</button>
                {appliedDeviceQuery ? <button type="button" className="wb-btn" onClick={() => { setDeviceQuery(''); setAppliedDeviceQuery(''); setListState('loading') }}>清除</button> : null}
              </form>
            </div>
            <div className="wb-filter-row">
              <button type="button" className={`wb-btn${stateFilter === 'all' ? ' wb-btn--primary' : ''}`} onClick={() => { setListState('loading'); setStateFilter('all') }}>
                全部
              </button>
              {ALL_STATES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`wb-btn${stateFilter === s ? ' wb-btn--primary' : ''}`}
                  onClick={() => { setListState('loading'); setStateFilter(s) }}
                >
                  {STATE_LABELS[s] ?? s}
                </button>
              ))}
            </div>
          </div>

          {showIntake ? (
            <div className="wb-inv-toolbar wb-form">
              <fieldset>
                <legend>接修登记</legend>
                <label className="wb-field"><span>客户称呼</span><input value={intake.customerName} onChange={(e) => setIntake({ ...intake, customerName: e.target.value })} placeholder="散客必填，如 陈先生" /></label>
                <label className="wb-field"><span>厂家 SN（可选，可扫码）</span><input value={intake.manufacturerSn} onChange={(e) => setIntake({ ...intake, manufacturerSn: e.target.value })} placeholder="留空也会自动生成内部设备编号" /></label>
                <label className="wb-field"><span>故障描述</span><input value={intake.symptom} onChange={(e) => setIntake({ ...intake, symptom: e.target.value })} placeholder="客户描述的故障现象" /></label>
                <label className="wb-field"><span>随附配件（逗号分隔）</span><input value={intake.accessories} onChange={(e) => setIntake({ ...intake, accessories: e.target.value })} placeholder="充电器、鼠标…" /></label>
                <label className="wb-field"><span>外观备注</span><input value={intake.appearance} onChange={(e) => setIntake({ ...intake, appearance: e.target.value })} placeholder="划痕、磕碰…" /></label>
                {actionError ? <p className="wb-inv-notice wb-inv-notice--warn">{actionError}</p> : null}
                <div className="wb-form-actions">
                  <button type="button" className="wb-btn wb-btn--primary" disabled={busy} onClick={() => void submitIntake()}>确认接修</button>
                  <button type="button" className="wb-btn" disabled={busy} onClick={() => { setShowIntake(false); setActionError('') }}>取消</button>
                </div>
              </fieldset>
            </div>
          ) : null}

          {listState === 'loading' ? <p className="wb-inv-state">正在加载维修工单…</p> : null}
          {listState === 'error' ? (
            <div className="wb-inv-state wb-inv-state--error">
              <p>{listError || '工单列表加载失败'}</p>
              <button type="button" className="wb-btn" onClick={refreshList}>重试</button>
            </div>
          ) : null}
          {listState === 'ready' && orders && orders.orders.length === 0 ? (
            <p className="wb-inv-state">还没有维修工单。点「接修登记」登记第一台送修设备。</p>
          ) : null}
          {listState === 'ready' && orders && orders.orders.length > 0 ? (
            <div className="wb-quote-table-scroll">
              <table className="wb-quote-table">
                <thead>
                  <tr>
                    <th>工单号</th>
                    <th>客户</th>
                    <th>设备</th>
                    <th>厂家 SN</th>
                    <th>故障</th>
                    <th>状态</th>
                    <th>收费</th>
                    <th>待收</th>
                    <th>接修时间</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.orders.map((o) => (
                    <tr key={o.id} onClick={() => openDetail(o.id)} style={{ cursor: 'pointer' }}>
                      <td className="wb-tabular">{o.orderNo}</td>
                      <td>{o.customerName || '—'}</td>
                      <td>{o.deviceCode}</td>
                      <td className="wb-tabular">{o.manufacturerSn || '—'}</td>
                      <td>{o.symptom}</td>
                      <td><span className="wb-quote-stock wb-quote-stock--available">{STATE_LABELS[o.state] ?? o.state}</span></td>
                      <td className="wb-tabular">{o.confirmedChargeCents === null ? '—' : formatYuan(o.confirmedChargeCents)}</td>
                      <td className="wb-tabular">{o.balanceCents > 0 ? formatYuan(o.balanceCents) : '—'}</td>
                      <td className="wb-caption">{formatDateTime(o.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : (
        <ServiceDetail
          detail={detail}
          detailState={detailState}
          canEdit={canEdit}
          canCharge={canCharge}
          canUploadAttachment={canUploadAttachment}
          busy={busy}
          notice={notice}
          activeAction={activeAction}
          actionError={actionError}
          onBack={() => { setView('list'); setActiveAction(null); setNotice(null); setActionError(''); refreshList() }}
          onAction={setActiveAction}
          onCancelAction={() => { setActiveAction(null); setActionError('') }}
          onSubmitDiagnosis={submitDiagnosis}
          onSubmitProposal={submitProposal}
          onSubmitConfirm={submitConfirm}
          onSubmitReplace={submitReplace}
          onSubmitDispatch={submitDispatch}
          onSubmitReceiveExternal={submitReceiveExternal}
          onSubmitRetest={submitRetest}
          onSubmitReturn={submitReturn}
          onSubmitPayment={submitPayment}
          onClearError={() => setActionError('')}
          onReload={reloadDetail}
        />
      )}
    </div>
  )
}

type ApiResultLike = { ok: boolean; unknownResult?: boolean; message?: string }

interface ServiceDetailProps {
  detail: ServiceOrderDetail | null
  detailState: 'loading' | 'ready' | 'error'
  canEdit: boolean
  canCharge: boolean
  canUploadAttachment: boolean
  busy: boolean
  notice: Notice
  activeAction: string | null
  actionError: string
  onBack: () => void
  onAction: (action: string | null) => void
  onCancelAction: () => void
  onSubmitDiagnosis: (text: string) => void
  onSubmitProposal: (p: { name: string; qty: number; unitPriceCents: number; chargeType: 'charge' | 'warranty'; warrantyDecision: string }) => void
  onSubmitConfirm: (accepted: boolean, confirmationMethod: string) => void
  onSubmitReplace: (comp: { oldComponentRef: string; oldItemDisposition: string; newStockItem: string; chargeType: 'charge' | 'warranty' }) => void
  onSubmitDispatch: (receiver: string, note: string) => void
  onSubmitReceiveExternal: () => void
  onSubmitRetest: () => void
  onSubmitReturn: (returnedTo: string, note: string) => void
  onSubmitPayment: (amountCents: number, method: CashMethod, remark: string) => void
  onClearError: () => void
  onReload: () => void
}

function ServiceDetail(props: ServiceDetailProps) {
  const { detail, detailState, canEdit, canCharge, canUploadAttachment, busy, notice, activeAction, actionError } = props
  const [diagText, setDiagText] = useState('')
  const [proposal, setProposal] = useState({ name: '', qty: '1', unitPriceYuan: '', chargeType: 'charge' as 'charge' | 'warranty', warrantyDecision: 'out_of_warranty' })
  const [confirmAccepted, setConfirmAccepted] = useState(true)
  const [confirmMethod, setConfirmMethod] = useState('phone')
  const [replace, setReplace] = useState({ oldComponentRef: '', oldItemDisposition: 'quarantine', newStockItem: '', chargeType: 'charge' as 'charge' | 'warranty' })
  const [dispatchReceiver, setDispatchReceiver] = useState('')
  const [dispatchNote, setDispatchNote] = useState('')
  const [returnTo, setReturnTo] = useState('')
  const [returnNote, setReturnNote] = useState('')
  const [payYuan, setPayYuan] = useState('')
  const [payMethod, setPayMethod] = useState<CashMethod>('wechat')
  const [payRemark, setPayRemark] = useState('')

  if (detailState === 'loading') {
    return <p className="wb-inv-state">正在加载工单详情…</p>
  }
  if (detailState === 'error' || !detail) {
    return (
      <div className="wb-inv-state wb-inv-state--error">
        <p>{actionError || '工单详情加载失败'}</p>
        <button type="button" className="wb-btn" onClick={props.onBack}>返回列表</button>
      </div>
    )
  }

  const isRepairingOrRetesting = detail.state === 'repairing' || detail.state === 'retesting'

  const renderProposalSnapshot = () => {
    if (!detail.note) return null
    try {
      const parsed = JSON.parse(detail.note) as { items?: { name: string; qty: number; unitPriceCents: number; chargeType: string }[]; chargeCents?: number }
      if (!Array.isArray(parsed.items) || parsed.items.length === 0) return null
      return (
        <div className="wb-inv-toolbar">
          <p className="wb-caption">方案快照（第 {detail.proposalVersion} 版）</p>
          {parsed.items.map((item, i) => (
            <p key={i} className="wb-caption">
              {item.name} × {item.qty} · {item.chargeType === 'warranty' ? '保修' : '收费'} · {formatYuan(item.unitPriceCents * item.qty)}
            </p>
          ))}
          {typeof parsed.chargeCents === 'number' ? <p className="wb-caption">合计 {formatYuan(parsed.chargeCents)}</p> : null}
        </div>
      )
    } catch {
      return null
    }
  }

  return (
    <>
      <div className="wb-page-head">
        <div>
          <p className="wb-kicker">售后维修</p>
          <h1>{detail.orderNo}</h1>
          <p className="wb-caption">
            {detail.customerName || '散客'} · {detail.deviceCode} · {formatDateTime(detail.createdAt)}
          </p>
        </div>
        <div className="wb-page-head-actions">
          <button type="button" className="wb-btn" onClick={props.onBack}>返回列表</button>
        </div>
      </div>

      {notice ? <p className={`wb-inv-notice${notice.kind === 'warn' ? ' wb-inv-notice--warn' : ''}`}>{notice.text}</p> : null}

      <div className="wb-inv-totals">
        <span>状态<b>{STATE_LABELS[detail.state] ?? detail.state}</b></span>
        <span>故障<b>{detail.symptom}</b></span>
        <span>已确认收费<b>{detail.confirmedChargeCents === null ? '—' : formatYuan(detail.confirmedChargeCents)}</b></span>
        <span>已收<b>{formatYuan(detail.cashNetCents)}</b></span>
        <span>待收<b>{detail.balanceCents > 0 ? formatYuan(detail.balanceCents) : '—'}</b></span>
      </div>

      {detail.warrantyDecision ? (
        <p className="wb-caption">质保判定：{WARRANTY_DECISION_LABELS[detail.warrantyDecision] ?? detail.warrantyDecision}</p>
      ) : null}

      {renderProposalSnapshot()}

      <AttachmentPanel attachments={detail.attachments ?? []} ownerType="service_order" ownerId={detail.id} canUpload={canUploadAttachment} onUploaded={() => props.onReload()} />

      {actionError && !activeAction ? <p className="wb-inv-notice wb-inv-notice--warn">{actionError}</p> : null}

      {/* 动作区：按 allowedActions 渲染入口，具体表单展开在下方 */}
      {detail.allowedActions.length > 0 && (canEdit || canCharge) ? (
        <div className="wb-inv-toolbar">
          <div className="wb-filter-row">
            {detail.allowedActions.map((action) => {
              if (action === 'payment' && !canCharge) return null
              if (action !== 'payment' && !canEdit) return null
              return (
                <button
                  key={action}
                  type="button"
                  className={`wb-btn${activeAction === action ? ' wb-btn--primary' : ''}`}
                  onClick={() => { props.onAction(action); props.onClearError() }}
                >
                  {ACTION_LABELS[action] ?? action}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      {/* ── 诊断 ── */}
      {activeAction === 'diagnosis' ? (
        <ActionForm title="录入内部诊断" error={actionError} busy={busy} onCancel={props.onCancelAction}
          onSubmit={() => props.onSubmitDiagnosis(diagText)} submitLabel="保存诊断" disabled={!diagText.trim()}>
          <label className="wb-field"><span>诊断说明</span><textarea value={diagText} onChange={(e) => setDiagText(e.target.value)} placeholder="内部检测结论，与客户描述分开" /></label>
        </ActionForm>
      ) : null}

      {/* ── 方案 ── */}
      {activeAction === 'proposal' ? (
        <ActionForm title="录入维修方案" error={actionError} busy={busy} onCancel={props.onCancelAction}
          onSubmit={() => {
            const unitPriceCents = yuanToCents(proposal.unitPriceYuan)
            const qty = Number(proposal.qty)
            if (unitPriceCents === null) { props.onClearError(); return }
            props.onSubmitProposal({ name: proposal.name, qty, unitPriceCents, chargeType: proposal.chargeType, warrantyDecision: proposal.warrantyDecision })
          }} submitLabel="保存方案" disabled={!proposal.name.trim() || !proposal.unitPriceYuan.trim()}>
          <label className="wb-field"><span>维修项目</span><input value={proposal.name} onChange={(e) => setProposal({ ...proposal, name: e.target.value })} placeholder="如 更换内存条" /></label>
          <label className="wb-field"><span>数量</span><input type="number" min={1} value={proposal.qty} onChange={(e) => setProposal({ ...proposal, qty: e.target.value })} /></label>
          <label className="wb-field"><span>单价（元）</span><input value={proposal.unitPriceYuan} onChange={(e) => setProposal({ ...proposal, unitPriceYuan: e.target.value })} placeholder="如 300.00" /></label>
          <label className="wb-field"><span>收费类型</span>
            <select value={proposal.chargeType} onChange={(e) => setProposal({ ...proposal, chargeType: e.target.value as 'charge' | 'warranty' })}>
              <option value="charge">收费</option>
              <option value="warranty">保修</option>
            </select>
          </label>
          <label className="wb-field"><span>质保判定</span>
            <select value={proposal.warrantyDecision} onChange={(e) => setProposal({ ...proposal, warrantyDecision: e.target.value })}>
              <option value="out_of_warranty">保外</option>
              <option value="in_warranty">保内</option>
              <option value="undetermined">待定</option>
            </select>
          </label>
        </ActionForm>
      ) : null}

      {/* ── 确认 ── */}
      {activeAction === 'confirm-proposal' ? (
        <ActionForm title="方案确认" error={actionError} busy={busy} onCancel={props.onCancelAction}
          onSubmit={() => props.onSubmitConfirm(confirmAccepted, confirmMethod)} submitLabel="确认">
          <label className="wb-field"><span>客户决定</span>
            <select value={confirmAccepted ? 'accept' : 'reject'} onChange={(e) => setConfirmAccepted(e.target.value === 'accept')}>
              <option value="accept">接受维修</option>
              <option value="reject">拒绝 / 无需维修</option>
            </select>
          </label>
          <label className="wb-field"><span>确认方式</span>
            <select value={confirmMethod} onChange={(e) => setConfirmMethod(e.target.value)}>
              {Object.entries(CONFIRMATION_METHOD_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        </ActionForm>
      ) : null}

      {/* ── 换件 ── */}
      {activeAction === 'replace' ? (
        <ActionForm title="换件" error={actionError} busy={busy} onCancel={props.onCancelAction}
          onSubmit={() => props.onSubmitReplace(replace)} submitLabel="确认换件" disabled={!replace.oldComponentRef.trim()}>
          <label className="wb-field"><span>旧件引用</span><input value={replace.oldComponentRef} onChange={(e) => setReplace({ ...replace, oldComponentRef: e.target.value })} placeholder="如 旧内存条 DDR4 8G" /></label>
          <label className="wb-field"><span>旧件去向</span>
            <select value={replace.oldItemDisposition} onChange={(e) => setReplace({ ...replace, oldItemDisposition: e.target.value })}>
              {Object.entries(OLD_ITEM_DISPOSITION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="wb-field"><span>领用新备件（可选，填备件编号）</span><input value={replace.newStockItem} onChange={(e) => setReplace({ ...replace, newStockItem: e.target.value })} placeholder="留空表示只拆件不换新" /></label>
          <label className="wb-field"><span>收费类型</span>
            <select value={replace.chargeType} onChange={(e) => setReplace({ ...replace, chargeType: e.target.value as 'charge' | 'warranty' })}>
              <option value="charge">收费</option>
              <option value="warranty">保修</option>
            </select>
          </label>
        </ActionForm>
      ) : null}

      {/* ── 外送 ── */}
      {activeAction === 'dispatch' ? (
        <ActionForm title="外送 / 返厂" error={actionError} busy={busy} onCancel={props.onCancelAction}
          onSubmit={() => props.onSubmitDispatch(dispatchReceiver, dispatchNote)} submitLabel="确认外送" disabled={!dispatchReceiver.trim()}>
          <label className="wb-field"><span>接收方</span><input value={dispatchReceiver} onChange={(e) => setDispatchReceiver(e.target.value)} placeholder="如 厂家售后中心" /></label>
          <label className="wb-field"><span>备注</span><input value={dispatchNote} onChange={(e) => setDispatchNote(e.target.value)} placeholder="物流单号、返厂原因…" /></label>
        </ActionForm>
      ) : null}

      {/* ── 外送返回 ── */}
      {activeAction === 'receive-external' ? (
        <ActionForm title="外送返回" error={actionError} busy={busy} onCancel={props.onCancelAction}
          onSubmit={() => props.onSubmitReceiveExternal()} submitLabel="确认返回">
          <p className="wb-caption">确认外送件已回到门店，工单进入复测。</p>
        </ActionForm>
      ) : null}

      {/* ── 复测 ── */}
      {activeAction === 'retest' ? (
        <ActionForm title="复测通过" error={actionError} busy={busy} onCancel={props.onCancelAction}
          onSubmit={() => props.onSubmitRetest()} submitLabel="确认复测通过">
          <p className="wb-caption">费用结清（待收为 0）后才能复测通过进入待归还。</p>
        </ActionForm>
      ) : null}

      {/* ── 归还 ── */}
      {activeAction === 'return' ? (
        <ActionForm title="归还客户" error={actionError} busy={busy} onCancel={props.onCancelAction}
          onSubmit={() => props.onSubmitReturn(returnTo, returnNote)} submitLabel="确认归还" disabled={!returnTo.trim()}>
          <label className="wb-field"><span>归还人</span><input value={returnTo} onChange={(e) => setReturnTo(e.target.value)} placeholder="如 客户本人 / 代领人" /></label>
          <label className="wb-field"><span>备注</span><input value={returnNote} onChange={(e) => setReturnNote(e.target.value)} placeholder="签字确认、取机说明…" /></label>
        </ActionForm>
      ) : null}

      {/* ── 收款 ── */}
      {activeAction === 'payment' ? (
        <ActionForm title="登记收款" error={actionError} busy={busy} onCancel={props.onCancelAction}
          onSubmit={() => {
            const cents = yuanToCents(payYuan)
            if (cents === null) { props.onClearError(); return }
            props.onSubmitPayment(cents, payMethod, payRemark)
          }} submitLabel="确认收款" disabled={!payYuan.trim()}>
          <p className="wb-caption">剩余待收 {detail.balanceCents > 0 ? formatYuan(detail.balanceCents) : '0（已结清）'}，超出会被拒绝。</p>
          <label className="wb-field"><span>金额（元）</span><input value={payYuan} onChange={(e) => setPayYuan(e.target.value)} placeholder="如 300.00" /></label>
          <label className="wb-field"><span>方式</span>
            <select value={payMethod} onChange={(e) => setPayMethod(e.target.value as CashMethod)}>
              {Object.entries(METHOD_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="wb-field"><span>备注</span><input value={payRemark} onChange={(e) => setPayRemark(e.target.value)} placeholder="维修费结清…" /></label>
        </ActionForm>
      ) : null}

      {isRepairingOrRetesting && detail.balanceCents > 0 && canCharge ? (
        <p className="wb-inv-notice wb-inv-notice--warn">
          尚有 {formatYuan(detail.balanceCents)} 未结清，复测通过和归还会被服务端拒绝，请先收款。
        </p>
      ) : null}
    </>
  )
}

function ActionForm(props: {
  title: string
  error: string
  busy: boolean
  disabled?: boolean
  submitLabel: string
  onCancel: () => void
  onSubmit: () => void
  children: React.ReactNode
}) {
  return (
    <div className="wb-inv-toolbar wb-form">
      <fieldset>
        <legend>{props.title}</legend>
        {props.children}
        {props.error ? <p className="wb-inv-notice wb-inv-notice--warn">{props.error}</p> : null}
        <div className="wb-form-actions">
          <button type="button" className="wb-btn wb-btn--primary" disabled={props.busy || props.disabled} onClick={props.onSubmit}>
            {props.submitLabel}
          </button>
          <button type="button" className="wb-btn" disabled={props.busy} onClick={props.onCancel}>取消</button>
        </div>
      </fieldset>
    </div>
  )
}

export default WorkbenchServicePage
