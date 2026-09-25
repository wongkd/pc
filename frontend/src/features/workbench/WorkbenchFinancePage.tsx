/**
 * E09 · 账本页（网页端 ERP）。
 *
 * 数据全部来自 `/api/v2/finance/*`，没有演示数据。权限由服务端决定：
 * 无 finance/view 时本页整块不可见（连汇总都不拉）；反冲（finance/reverse）是老板专属，
 * 本页只按权限显隐入口，真正的边界在服务端（403）。
 *
 * 口径：
 *   · 现金净额 = 流入 − 流出，可能是负数（退款多于收款），照实显示不带正负包装；
 *   · 应收 = 还有余额的销售单合计；应付 = 成本已知采购订购金额扣除采购付款后的剩余应付；
 *   · 反冲是「纠正误录」，不是退款：只有非反冲笔（reversalOf 为空）才能反冲。
 */
import { useCallback, useEffect, useState } from 'react'

import { formatYuan } from './inventory-view'
import { fetchFinanceEntries, fetchFinanceOverview, reverseFinanceEntry } from './finance-api'
import type { FinanceEntriesPayload, FinanceEntryRow, FinanceOverview } from './finance-api'
import '../../styles/workbench.css'

const METHOD_LABELS: Record<string, string> = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝',
  bank: '银行转账',
  other: '其他',
}

const DIRECTION_LABELS: Record<string, string> = {
  in: '流入',
  out: '流出',
}

function hasAny(permissions: readonly string[], codes: readonly string[]): boolean {
  return permissions.includes('*') || codes.some((code) => permissions.includes(code))
}

const VIEW_CODES = ['finance/view', 'quote/view']
const REVERSE_CODES = ['finance/reverse']

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

type Notice = { kind: 'ok' | 'warn' | 'error'; text: string } | null

export function WorkbenchFinancePage({ permissions }: { permissions: string[] }) {
  const [overview, setOverview] = useState<FinanceOverview | null>(null)
  const [entries, setEntries] = useState<FinanceEntriesPayload | null>(null)
  const [overviewState, setOverviewState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [entriesState, setEntriesState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [direction, setDirection] = useState<'all' | 'in' | 'out'>('all')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [actionError, setActionError] = useState('')
  const [reverseTarget, setReverseTarget] = useState<FinanceEntryRow | null>(null)
  const [reverseReason, setReverseReason] = useState('')

  const canView = hasAny(permissions, VIEW_CODES)
  const canReverse = hasAny(permissions, REVERSE_CODES)

  // ⚠️ 不在 effect 里同步 setState（`react-hooks/set-state-in-effect`）：加载态由初始值与事件处理设置，
  // 这里只 fetch，把 setState 放在 .then 回调里。overview 与 entries 分开拉，方向切换只重拉流水。
  useEffect(() => {
    if (!canView) return
    let active = true
    void fetchFinanceOverview().then((result) => {
      if (!active) return
      if (result.ok) {
        setOverview(result.data)
        setOverviewState('ready')
      } else {
        setOverviewState('error')
      }
    })
    return () => {
      active = false
    }
  }, [canView])

  useEffect(() => {
    if (!canView) return
    let active = true
    void fetchFinanceEntries(direction === 'all' ? null : direction).then((result) => {
      if (!active) return
      if (result.ok) {
        setEntries(result.data)
        setEntriesState('ready')
        setError('')
      } else {
        setEntriesState('error')
        setError(result.message)
      }
    })
    return () => {
      active = false
    }
  }, [canView, direction])

  const refresh = useCallback(() => {
    setOverviewState('loading')
    setEntriesState('loading')
    void fetchFinanceOverview().then((result) => {
      if (result.ok) {
        setOverview(result.data)
        setOverviewState('ready')
      } else {
        setOverviewState('error')
      }
    })
    void fetchFinanceEntries(direction === 'all' ? null : direction).then((result) => {
      if (result.ok) {
        setEntries(result.data)
        setEntriesState('ready')
        setError('')
      } else {
        setEntriesState('error')
        setError(result.message)
      }
    })
  }, [direction])

  const handleReverse = useCallback(async () => {
    if (!reverseTarget) return
    if (!reverseReason.trim()) {
      setActionError('反冲必须写明原因')
      return
    }
    setBusy(true)
    setActionError('')
    const result = await reverseFinanceEntry(reverseTarget.id, reverseReason.trim())
    setBusy(false)
    if (result.ok) {
      setNotice({ kind: 'ok', text: result.data.summary || '已反冲' })
      setReverseTarget(null)
      setReverseReason('')
      refresh()
      return
    }
    setActionError(result.message)
  }, [reverseTarget, reverseReason, refresh])

  if (!canView) {
    return (
      <div className="wb-page wb-sales-page">
        <div className="wb-page-head">
          <div>
            <p className="wb-kicker">收支与报表</p>
            <h1>账本</h1>
          </div>
        </div>
        <p className="wb-inv-notice wb-inv-notice--warn">
          当前账号没有查看账本的权限。请联系老板开通「查看应收应付与流水」。
        </p>
      </div>
    )
  }

  return (
    <div className="wb-page wb-sales-page">
      <div className="wb-page-head">
        <div>
          <p className="wb-kicker">收支与报表</p>
          <h1>账本</h1>
          <p className="wb-caption">现金流、应收与应付的基础对账。金额由服务端汇总，这里只读不编。</p>
        </div>
        <div className="wb-page-head-actions">
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

      {overviewState === 'ready' && overview ? (
        <div className="wb-inv-totals">
          <span>现金流入<b>{formatYuan(overview.cash.inTotalCents)}</b></span>
          <span>现金流出<b>{formatYuan(overview.cash.outTotalCents)}</b></span>
          <span>现金净额<b>{formatYuan(overview.cash.netCents)}</b></span>
          <span>销售待收（{overview.receivable.orderCount} 单）<b>{formatYuan(overview.receivable.totalCents)}</b></span>
          <span>维修待收（{overview.receivable.serviceCount} 单）<b>{formatYuan(overview.receivable.serviceTotalCents)}</b></span>
          <span>应付（{overview.payable.purchaseCount} 单）<b>{formatYuan(overview.payable.totalCents)}</b></span>
        </div>
      ) : null}
      {overviewState === 'error' ? (
        <p className="wb-inv-notice wb-inv-notice--warn">账本汇总加载失败。</p>
      ) : null}

      <div className="wb-inv-toolbar">
        <div className="wb-filter-row">
          {([
            ['all', '全部'],
            ['in', '流入'],
            ['out', '流出'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`wb-btn${direction === value ? ' wb-btn--primary' : ''}`}
              onClick={() => { setEntriesState('loading'); setDirection(value) }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {entriesState === 'loading' ? <p className="wb-inv-state">正在加载资金流水…</p> : null}
      {entriesState === 'error' ? (
        <div className="wb-inv-state wb-inv-state--error">
          <p>{error || '资金流水加载失败'}</p>
          <button type="button" className="wb-btn" onClick={refresh}>重试</button>
        </div>
      ) : null}
      {entriesState === 'ready' && entries && entries.entries.length === 0 ? (
        <p className="wb-inv-state">还没有资金流水。收款、退款、退货产生流水后会出现在这里。</p>
      ) : null}

      {entriesState === 'ready' && entries && entries.entries.length > 0 ? (
        <div className="wb-quote-table-scroll">
          <table className="wb-quote-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>方向</th>
                <th>金额</th>
                <th>方式</th>
                <th>备注</th>
                <th>状态</th>
                {canReverse ? <th>操作</th> : null}
              </tr>
            </thead>
            <tbody>
              {entries.entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="wb-caption">{formatDateTime(entry.occurredAt)}</td>
                  <td>
                    <span className={`wb-quote-stock wb-quote-stock--${entry.direction === 'in' ? 'available' : 'reserved'}`}>
                      {DIRECTION_LABELS[entry.direction] ?? entry.direction}
                    </span>
                  </td>
                  <td className="wb-tabular">{formatYuan(entry.amountCents)}</td>
                  <td>{METHOD_LABELS[entry.method] ?? entry.method}</td>
                  <td>
                    {entry.remark}
                    {entry.reversalOf ? <span className="wb-caption"> · 反冲笔</span> : null}
                  </td>
                  <td>{entry.verificationState === 'verified' ? '已对账' : '待对账'}</td>
                  {canReverse ? (
                    <td>
                      {entry.reversalOf === null ? (
                        <button
                          type="button"
                          className="wb-btn"
                          disabled={busy}
                          onClick={() => { setReverseTarget(entry); setReverseReason(''); setActionError('') }}
                        >
                          反冲
                        </button>
                      ) : (
                        <span className="wb-caption">—</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {reverseTarget ? (
        <div className="wb-inv-toolbar wb-form">
          <fieldset>
            <legend>反冲账务分录</legend>
            <p className="wb-caption">
              反冲「{formatDateTime(reverseTarget.occurredAt)} · {DIRECTION_LABELS[reverseTarget.direction] ?? reverseTarget.direction} {formatYuan(reverseTarget.amountCents)}」。
              会写一条等额反向分录，并连带重算关联订单的余额。
            </p>
            <label className="wb-field">
              <span>原因</span>
              <input value={reverseReason} onChange={(event) => setReverseReason(event.target.value)} placeholder="录错了，不是这单的收款" />
            </label>
            {actionError ? <p className="wb-inv-notice wb-inv-notice--warn">{actionError}</p> : null}
            <div className="wb-form-actions">
              <button type="button" className="wb-btn" disabled={busy || !reverseReason.trim()} onClick={() => void handleReverse()}>
                确认反冲
              </button>
              <button type="button" className="wb-btn" disabled={busy} onClick={() => { setReverseTarget(null); setReverseReason(''); setActionError('') }}>
                取消
              </button>
            </div>
          </fieldset>
        </div>
      ) : null}
    </div>
  )
}

export default WorkbenchFinancePage
