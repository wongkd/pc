import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchSaleOrderDetail, fetchSaleOrders } from './sales-api'
import type { RecoveryOrderDetail } from './recovery-api'
import { applyTradeInOffset, createTradeIn, fetchTradeIn, queryTradeInOperation, reverseTradeInOffset } from './tradein-api'
import type { TradeInDetail } from './tradein-api'
import { formatYuan } from './inventory-view'

function hasAny(permissions: string[], codes: string[]) {
  return permissions.includes('*') || codes.some((code) => permissions.includes(code))
}

function yuanToCents(value: string): number | null {
  if (!value.trim()) return null
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null
}

export function TradeInPanel({ recovery, permissions, onChanged }: {
  recovery: RecoveryOrderDetail
  permissions: string[]
  onChanged: () => void
}) {
  const canView = hasAny(permissions, ['tradein/view', 'quote/view'])
  const canCreate = hasAny(permissions, ['tradein/create', 'quote/edit'])
  const canApply = hasAny(permissions, ['tradein/offset'])
  const canReverse = hasAny(permissions, ['tradein/reverse'])
  const [sales, setSales] = useState<{ id: string; orderNo: string; customerName: string; tradeState: string; balanceCents: number }[]>([])
  const [saleState, setSaleState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [saleError, setSaleError] = useState('')
  const [saleId, setSaleId] = useState('')
  const [tradeInId, setTradeInId] = useState('')
  const [detail, setDetail] = useState<TradeInDetail | null>(null)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [unknownWrite, setUnknownWrite] = useState<{ requestId: string; action: string; tradeInId?: string } | null>(null)

  useEffect(() => {
    if (!canCreate || recovery.seller.customerId === null) { setSaleState('ready'); return }
    let active = true
    void fetchSaleOrders({ limit: 200 }).then((result) => {
      if (!active) return
      if (result.ok) {
        setSales(result.data.orders.filter((order) => ['draft', 'confirmed'].includes(order.tradeState) && order.balanceCents > 0))
        setSaleState('ready')
      } else {
        setSaleError(result.message)
        setSaleState('error')
      }
    })
    return () => { active = false }
  }, [canCreate, recovery.seller.customerId])

  const selectedSale = useMemo(() => sales.find((sale) => sale.id === saleId), [sales, saleId])
  const suggestedCents = detail
    ? Math.min(Math.max(detail.saleOrder.balanceCents, 0), Math.max(detail.recoveryPayableRemainingCents, 0))
    : selectedSale ? Math.min(Math.max(selectedSale.balanceCents, 0), Math.max(recovery.payableCents - recovery.offsetCents, 0)) : 0

  const loadTradeIn = useCallback(async (id: string) => {
    setBusy(true); setError(''); setNotice('')
    const result = await fetchTradeIn(id.trim())
    if (result.ok) {
      setTradeInId(result.data.id)
      setDetail(result.data)
      setAmount(result.data.recoveryPayableRemainingCents > 0 ? (Math.min(Math.max(result.data.saleOrder.balanceCents, 0), result.data.recoveryPayableRemainingCents) / 100).toFixed(2) : '')
      setError('')
    } else setError(result.message)
    setBusy(false)
  }, [])

  const handleUnknown = (result: { unknownResult?: boolean; requestId?: string | null; message: string }, action: string, id?: string) => {
    if (result.unknownResult && result.requestId) {
      setUnknownWrite({ requestId: result.requestId, action, tradeInId: id })
      setNotice(`${action}结果未知，请查询这笔请求，不要重复提交。`)
      return true
    }
    setError(result.message)
    return false
  }

  const checkUnknownWrite = async () => {
    if (!unknownWrite) return
    const result = await queryTradeInOperation(unknownWrite.requestId)
    if (result.status === 'pending') { setNotice(`${unknownWrite.action}仍在处理中，请稍后再查。`); return }
    if (result.status === 'succeeded') {
      const completed = unknownWrite
      setUnknownWrite(null)
      setNotice(`${completed.action}已由服务端确认。`)
      if (completed.tradeInId) await loadTradeIn(completed.tradeInId)
      onChanged()
      return
    }
    if (result.status === 'unknown') {
      setUnknownWrite(null)
      setNotice('服务端没有这笔请求记录；核对单据后可以重新提交。')
      return
    }
    setUnknownWrite(null)
    setError(`操作未成功（${result.code ?? '原因未知'}）：${result.message}`)
  }

  useEffect(() => {
    if (!canView || recovery.tradeIns.length !== 1 || detail) return
    const [existing] = recovery.tradeIns
    setTradeInId(existing.id)
    void loadTradeIn(existing.id)
  // The association list is refreshed by the parent after successful writes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView, recovery.tradeIns, detail, loadTradeIn])

  const createAssociation = async () => {
    if (!selectedSale) return
    setBusy(true); setError(''); setNotice('')
    const saleDetail = await fetchSaleOrderDetail(selectedSale.id)
    if (!saleDetail.ok) { setError(saleDetail.message); setBusy(false); return }
    const result = await createTradeIn({ saleOrderId: selectedSale.id, recoveryId: recovery.id, saleOrderVersion: saleDetail.data.order.version, recoveryVersion: recovery.version })
    if (!result.ok) {
      if (result.message.includes('客户主体不一致')) {
        setError('这张回收单与所选销售单不是同一客户。请换选该客户自己的销售单；散客回收单不能做置换折抵。')
      } else {
        handleUnknown(result, '建立置换关联')
      }
      setBusy(false)
      return
    }
    if (!result.data.entityId) { setError('服务端未返回置换关联编号，请刷新后核对单据状态。'); setBusy(false); return }
    setTradeInId(result.data.entityId)
    const detailResult = await fetchTradeIn(result.data.entityId)
    if (detailResult.ok) {
      setDetail(detailResult.data)
      setAmount(Math.min(Math.max(detailResult.data.saleOrder.balanceCents, 0), Math.max(detailResult.data.recoveryPayableRemainingCents, 0)) > 0
        ? (Math.min(Math.max(detailResult.data.saleOrder.balanceCents, 0), Math.max(detailResult.data.recoveryPayableRemainingCents, 0)) / 100).toFixed(2) : '')
      setNotice('置换关联已建立。请核对服务端读取的双方单据，再提交折抵金额。')
      onChanged()
    } else setError(detailResult.message)
    setBusy(false)
  }

  const apply = async () => {
    if (!detail) return
    const amountCents = yuanToCents(amount)
    if (amountCents === null) { setError('请输入大于 0 的折抵金额。'); return }
    setBusy(true); setError(''); setNotice('')
    const result = await applyTradeInOffset(detail.id, { amountCents, saleOrderVersion: detail.saleOrder.version, recoveryVersion: recovery.version })
    if (!result.ok) handleUnknown(result, '应用折抵', detail.id)
    else { setNotice(result.data.summary || '折抵已提交。'); await loadTradeIn(detail.id); onChanged() }
    setBusy(false)
  }

  const reverse = async (offsetId: string) => {
    if (!detail) return
    if (!reason.trim()) { setError('撤销折抵前请填写原因。'); return }
    setBusy(true); setError(''); setNotice('')
    const result = await reverseTradeInOffset(detail.id, { offsetId, reason: reason.trim(), saleOrderVersion: detail.saleOrder.version, recoveryVersion: recovery.version })
    if (!result.ok) handleUnknown(result, '撤销折抵', detail.id)
    else { setReason(''); setNotice(result.data.summary || '已新增撤销记录，原折抵仍保留。'); await loadTradeIn(detail.id); onChanged() }
    setBusy(false)
  }

  if (!canView && !canCreate) return null
  return (
    <section id="recovery-tradein" className="wb-detail wb-tradein-panel wb-recovery-tradein" aria-label="用旧设备抵新购款">
      <div className="wb-recovery-tradein__heading">
        <div>
          <p className="wb-kicker">可选结算方式</p>
          <h2>用旧设备抵新购款</h2>
        </div>
        <p className="wb-recovery-tradein__summary">这是两张单据之间的抵扣记录，不是现金收款。客户仍需支付抵扣后的余额。</p>
      </div>
      <ol className="wb-recovery-tradein__steps">
        <li><span>1</span><div><strong>选同一客户的销售单</strong><small>散客回收单不能做置换抵扣</small></div></li>
        <li><span>2</span><div><strong>建立关联</strong><small>先核对销售单号和客户</small></div></li>
        <li><span>3</span><div><strong>填写并应用金额</strong><small>销售待收和回收应付都会减少</small></div></li>
      </ol>
      {canCreate ? <>
        {saleState === 'loading' ? <p className="wb-caption">正在加载可折抵销售单…</p> : null}
        {saleState === 'error' ? <p className="wb-inv-notice wb-inv-notice--warn">{saleError} <button type="button" className="wb-btn" onClick={() => { setSaleState('loading'); void fetchSaleOrders({ limit: 200 }).then((result) => { if (result.ok) { setSales(result.data.orders.filter((order) => ['draft', 'confirmed'].includes(order.tradeState) && order.balanceCents > 0)); setSaleState('ready'); setSaleError('') } else { setSaleError(result.message); setSaleState('error') } }) }}>重试</button></p> : null}
        {recovery.state !== 'acquired' ? <p className="wb-caption">取得回收单所有权后，才可以建立抵用关联。</p> : null}
        {recovery.state === 'acquired' && recovery.seller.customerId === null ? <p className="wb-recovery-tradein__blocker" role="note">这张回收单登记为散客，没有关联客户档案，因此不能和销售单做置换折抵。可以在“本单可执行操作”里直接登记付款。</p> : null}
        {saleState === 'ready' && recovery.state === 'acquired' && recovery.seller.customerId !== null ? <>
          <p className="wb-recovery-tradein__customer">回收客户：<strong>{recovery.seller.name || '未命名客户'}</strong>。请选择该客户自己的待收销售单；其他客户的单据无法关联。</p>
          <p className="wb-caption">候选列表会显示本店有余额的销售单，请核对单号和客户。系统会再次校验客户归属。</p>
          <div className="wb-form-actions">
          <label className="wb-field"><span>选择待收款销售单（草稿或已成交）</span><select value={saleId} onChange={(event) => setSaleId(event.target.value)}>
            <option value="">请选择销售单</option>{sales.map((sale) => <option key={sale.id} value={sale.id}>{sale.orderNo} · {sale.tradeState === 'draft' ? '草稿' : '已成交'} · {sale.customerName || '未填写客户'} · 待收 {formatYuan(sale.balanceCents)}</option>)}
          </select></label>
          <button type="button" className="wb-btn" disabled={busy || Boolean(unknownWrite) || !selectedSale} onClick={() => void createAssociation()}>建立置换关联</button>
          {sales.length === 0 ? <span className="wb-caption">当前没有待收销售单；请先给这位客户建立报价或销售单。</span> : null}
          </div>
        </> : null}
      </> : null}
      {canView && recovery.tradeIns.length > 1 ? <div className="wb-form-actions">
        <label className="wb-field"><span>已有置换关联</span><select value={tradeInId} onChange={(event) => { setTradeInId(event.target.value); if (event.target.value) void loadTradeIn(event.target.value); else setDetail(null) }}>
          <option value="">选择关联</option>{recovery.tradeIns.map((item) => <option key={item.id} value={item.id}>{item.saleOrderNo} · {item.id}</option>)}
        </select></label>
      </div> : null}
      {canView && recovery.tradeIns.length === 1 && !detail ? <p className="wb-caption">正在读取已建立的置换关联…</p> : null}
      {canView && recovery.tradeIns.length === 0 && tradeInId && !detail ? <div className="wb-form-actions">
        <label className="wb-field"><span>置换关联编号</span><input value={tradeInId} onChange={(event) => setTradeInId(event.target.value)} /></label>
        <button type="button" className="wb-btn" disabled={busy || !tradeInId.trim()} onClick={() => void loadTradeIn(tradeInId)}>读取关联</button>
      </div> : null}
      {detail ? <>
        <p className="wb-recovery-tradein__association"><strong>关联编号 {detail.id}</strong> · 销售单 <strong>{detail.saleOrder.orderNo}</strong> ↔ 回收单 <strong>{detail.recovery.orderNo}</strong></p>
        <div className="wb-recovery-tradein__balances">
          <div><span>销售单还需收</span><strong>{formatYuan(Math.max(detail.saleOrder.balanceCents, 0))}</strong></div>
          <div><span>回收单尚应付</span><strong>{formatYuan(detail.recoveryPayableRemainingCents)}</strong></div>
          <div className="is-limit"><span>本次最多可抵</span><strong>{formatYuan(Math.min(Math.max(detail.saleOrder.balanceCents, 0), Math.max(detail.recoveryPayableRemainingCents, 0)))}</strong></div>
        </div>
        <p className="wb-caption">折抵后剩余的销售货款仍需收取；回收款若还有余额，可单独登记付款。</p>
        {detail.saleOrder.tradeState === 'draft' ? <p className="wb-caption">该销售单仍为草稿。员工核实到账与有效折抵合计达到15%门槛后，须回销售单确认成交；服务端只在确认时尝试预留库存。</p> : null}
        {detail.offsets.length === 0 ? <p className="wb-caption">暂无折抵记录。</p> : <ul>{detail.offsets.map((offset) => <li key={offset.id}>
          {formatYuan(offset.amountCents)} · {offset.state === 'applied' ? '已应用' : '已撤销'} · {offset.createdAt}{offset.reversedReason ? ` · 原因：${offset.reversedReason}` : ''}
          {offset.state === 'applied' && canReverse ? <button type="button" className="wb-btn" disabled={busy || Boolean(unknownWrite)} onClick={() => void reverse(offset.id)}>撤销这笔</button> : null}
        </li>)}</ul>}
        {canApply && suggestedCents > 0 ? <div className="wb-form-actions">
          <label className="wb-field"><span>本次折抵金额（元，最多 {formatYuan(suggestedCents)}）</span><input value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="输入客户同意的金额" /></label>
          <button type="button" className="wb-btn wb-btn--primary" disabled={busy || Boolean(unknownWrite)} onClick={() => void apply()}>应用折抵</button>
        </div> : null}
        {canReverse && detail.offsets.some((offset) => offset.state === 'applied') ? <label className="wb-field"><span>撤销原因</span><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="填写撤销原因" /></label> : null}
      </> : null}
      {error ? <p className="wb-inv-notice wb-inv-notice--warn" role="alert">{error}</p> : null}
      {notice ? <p className="wb-inv-notice" role="status">{notice}</p> : null}
      {unknownWrite ? <button type="button" className="wb-btn" disabled={busy} onClick={() => void checkUnknownWrite()}>查询结果</button> : null}
    </section>
  )
}
