/**
 * E08 · 装机检测与交付页（网页端 ERP）。
 *
 * 一页两态：销售单列表 → 单据的装机检测与交付面板。
 * 数据全部来自 `/api/v2/sales/orders*`（R04 详情 + fulfillment 看板），没有演示数据；
 * 服务端给什么就显示什么，本页不自己判权限（无权限动作由服务端 403）。
 *
 * 业务口径：
 *   · 未付款不预留 —— 零售单同样要先收款、确认成交，才能备料与交付；
 *   · 检测结论由服务端按检查项派生，本页只让店员逐项记 pass / fail，不提供「整单通过」按钮；
 *   · 交付才扣库，扣库一次；「结果未知」进待确认状态，不当失败、不重复提交；
 *   · 欠款交付（B09）尚未实现，界面如实说明，不提供绕过入口。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { formatYuan } from './inventory-view'
import { fetchSaleOrders } from './sales-api'
import type { SaleOrderListPayload, SaleTradeState } from './sales-api'
import {
  deliverOrder,
  fetchFulfillmentDetail,
  saveAssemblyChecks,
  startAssembly,
} from './fulfillment-api'
import type {
  CheckItemPayload,
  FulfillmentDetailPayload,
} from './fulfillment-api'
import {
  CHECK_ITEM_STATE_LABELS,
  CHECK_KIND_LABELS,
  CHECK_RESULT_LABELS,
  DISPOSITION_LABELS,
  FULFILLMENT_LABELS,
  KIND_LABELS,
  SOURCE_LABELS,
  assemblyStep,
  defaultChecklistItems,
  deliveryGates,
  gapSummary,
} from './fulfillment-view'
import '../../styles/workbench.css'
import './fulfillment.css'

const VIEW_CODES = ['sales/order-view', 'quote/view']
const ASSEMBLY_CODES = ['sales/order-assembly', 'quote/edit']
const DELIVER_CODES = ['sales/order-deliver', 'quote/edit']

/** 老板是 `*`；店员按契约码或旧码判断（与 domains/access.ts 的 LEGACY_EQUIVALENT 同源）。 */
function hasAny(permissions: readonly string[], codes: readonly string[]): boolean {
  return permissions.includes('*') || codes.some((code) => permissions.includes(code))
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

type Notice = { kind: 'ok' | 'warn' | 'error'; text: string } | null

const STAGE_FILTERS: [SaleTradeState | 'all', string][] = [
  ['all', '全部'],
  ['confirmed', '进行中'],
  ['draft', '草稿'],
]

export function WorkbenchFulfillmentPage({ permissions }: { permissions: string[] }) {
  const workbenchOrderNo = new URLSearchParams(window.location.search).get('orderNo')?.trim() ?? ''
  const openedWorkbenchOrderNo = useRef<string | null>(null)
  const [view, setView] = useState<'list' | 'detail'>('list')
  const [orders, setOrders] = useState<SaleOrderListPayload | null>(null)
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listError, setListError] = useState('')
  const [stageFilter, setStageFilter] = useState<SaleTradeState | 'all'>('all')
  /** 重试的真实入口：改这个值让加载 effect 重新跑一次（setStageFilter 同值不会触发重渲染请求）。 */
  const [reloadKey, setReloadKey] = useState(0)
  const [detail, setDetail] = useState<FulfillmentDetailPayload | null>(null)
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detailError, setDetailError] = useState('')
  const [items, setItems] = useState<CheckItemPayload[]>([])
  const [receiptRef, setReceiptRef] = useState('')
  const [deliveryNote, setDeliveryNote] = useState('')
  const [receivedByNote, setReceivedByNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [actionError, setActionError] = useState('')

  const canView = hasAny(permissions, VIEW_CODES)
  const canAssemble = hasAny(permissions, ASSEMBLY_CODES)
  const canDeliver = hasAny(permissions, DELIVER_CODES)

  const board = detail?.fulfillment ?? null

  const openDetail = useCallback(async (orderId: string) => {
    setView('detail')
    setDetailState('loading')
    setDetail(null)
    setActionError('')
    setNotice(null)
    setReceiptRef('')
    setDeliveryNote('')
    setReceivedByNote('')
    const result = await fetchFulfillmentDetail(orderId)
    if (result.ok) {
      setDetail(result.data)
      setDetailState('ready')
      setItems(defaultChecklistItems(result.data.order?.kind ?? 'assembly'))
      return
    }
    setDetailState('error')
    setDetailError(result.message)
  }, [])

  // ⚠️ effect 里把 setState 放在 .then 回调中（`react-hooks/set-state-in-effect`）。
  useEffect(() => {
    if (!canView) return
    let active = true
    void fetchSaleOrders({
      tradeState: stageFilter === 'all' ? null : stageFilter,
      q: null,
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
  }, [canView, stageFilter, reloadKey, workbenchOrderNo, openDetail])

  const refreshDetail = useCallback(async () => {
    if (!detail) return
    const result = await fetchFulfillmentDetail(detail.order.id)
    if (result.ok) {
      setDetail(result.data)
      setDetailState('ready')
    }
  }, [detail])

  const runWrite = useCallback(
    async (what: string, action: () => Promise<{ ok: boolean; message?: string; data?: { summary: string } }>): Promise<boolean> => {
      setBusy(true)
      setActionError('')
      const result = await action()
      setBusy(false)
      if (result.ok && result.data) {
        setNotice({ kind: 'ok', text: result.data.summary || `${what}完成` })
        return true
      }
      if (!result.ok && result.message !== undefined) {
        setActionError(result.message)
        return false
      }
      setActionError(result.message ?? '操作失败')
      return false
    },
    [],
  )

  const handleAssembly = useCallback(async () => {
    if (!board) return
    const done = await runWrite('备料', () => startAssembly(board.order.id, receiptRef || null))
    if (done) {
      setReceiptRef('')
      await refreshDetail()
    }
  }, [board, receiptRef, runWrite, refreshDetail])

  const handleSaveChecks = useCallback(async () => {
    if (!board || items.length === 0) return
    const done = await runWrite('保存检测结果', () => saveAssemblyChecks(board.order.id, items))
    if (done) await refreshDetail()
  }, [board, items, runWrite, refreshDetail])

  const handleDeliver = useCallback(async () => {
    if (!board) return
    const done = await runWrite('确认交付', () => deliverOrder(board.order.id, deliveryNote, receivedByNote || null))
    if (done) {
      setDeliveryNote('')
      setReceivedByNote('')
      await refreshDetail()
    }
  }, [board, deliveryNote, receivedByNote, runWrite, refreshDetail])

  if (!canView) {
    return (
      <div className="wb-page wb-fulfillment-page">
        <div className="wb-page-head">
          <div>
            <p className="wb-kicker">装机与交付</p>
            <h1>装机检测与交付</h1>
          </div>
        </div>
        <p className="wb-inv-notice wb-inv-notice--warn">
          当前账号没有查看销售单的权限。请联系老板开通「查看销售单、客户与设备资料」。
        </p>
      </div>
    )
  }

  const visibleOrders = (orders?.orders ?? []).filter((row) => row.fulfillmentState !== undefined)
  const step = board ? assemblyStep(board.order.fulfillmentState, board.order.kind) : null
  const gates = board ? deliveryGates(board) : []
  const gapText = board ? gapSummary(board.gaps) : null
  /** 检测不通过时可关联的实物：来自本单 detail.lines 里 stock_item_id 非空的行（assetCode + name）。 */
  const linkableItems = detail ? detail.lines.filter((line) => line.stockItemId) : []

  return (
    <div className="wb-page wb-fulfillment-page">
      <div className="wb-page-head">
        <div>
          <p className="wb-kicker">装机与交付</p>
          <h1>{view === 'list' ? '装机检测与交付' : board?.order.orderNo ?? '销售单'}</h1>
          <p className="wb-caption">
            {view === 'list'
              ? '成交之后的事都在这里：备料装机、逐项检测、核对尾款、确认交付。交付才扣库存。'
              : '这一页记录的是「机器是不是真的装好、测好、交出去了」。服务端确认后才算数。'}
          </p>
        </div>
        <div className="wb-page-head-actions">
          {view === 'detail' ? (
            <button type="button" className="wb-btn" onClick={() => { setView('list'); setDetail(null) }}>
              返回列表
            </button>
          ) : null}
          {view === 'detail' ? (
            <button type="button" className="wb-btn" onClick={() => void refreshDetail()} disabled={busy}>
              刷新
            </button>
          ) : null}
        </div>
      </div>

      {notice ? (
        <p className={`wb-inv-notice${notice.kind === 'warn' ? ' wb-inv-notice--warn' : ''}`}>{notice.text}</p>
      ) : null}

      {view === 'list' ? (
        <>
          <div className="wb-inv-toolbar">
            <div className="wb-filter-row">
              {STAGE_FILTERS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`wb-btn${stageFilter === value ? ' wb-btn--primary' : ''}`}
                  onClick={() => { setListState('loading'); setStageFilter(value) }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {listState === 'loading' ? <p className="wb-inv-state">正在加载销售单…</p> : null}
          {listState === 'error' ? (
            <div className="wb-inv-state wb-inv-state--error">
              <p>{listError || '销售单加载失败'}</p>
              <button type="button" className="wb-btn" onClick={() => setReloadKey((key) => key + 1)}>重试</button>
            </div>
          ) : null}
          {listState === 'ready' && visibleOrders.length === 0 ? (
            <p className="wb-inv-state">
              还没有可处理的销售单。先在「开单」里报价成交，或直接建一张零售单。
            </p>
          ) : null}

          {listState === 'ready' && visibleOrders.length > 0 ? (
            <div className="wb-quote-table-scroll">
              <table className="wb-quote-table">
                <thead>
                  <tr>
                    <th>单号</th>
                    <th>客户</th>
                    <th>类型</th>
                    <th>交易</th>
                    <th>履约</th>
                    <th>总额</th>
                    <th>待收</th>
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
                      <td>{KIND_LABELS[row.kind] ?? row.kind}</td>
                      <td>{row.tradeState === 'confirmed' ? '已成交' : row.tradeState === 'draft' ? '草稿' : row.tradeState}</td>
                      <td>
                        <span className={`wb-quote-stock wb-quote-stock--${row.fulfillmentState === 'delivered' ? 'available' : 'reserved'}`}>
                          {FULFILLMENT_LABELS[row.fulfillmentState] ?? row.fulfillmentState}
                        </span>
                      </td>
                      <td className="wb-tabular">{formatYuan(row.totalCents)}</td>
                      <td className="wb-tabular">
                        {row.balanceCents > 0 ? formatYuan(row.balanceCents) : row.isFullyPaid ? '已结清' : '—'}
                      </td>
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
              <p>{detailError || '销售单加载失败'}</p>
              <button type="button" className="wb-btn" onClick={() => setView('list')}>返回列表</button>
            </div>
          ) : null}

          {detailState === 'ready' && detail && board ? (
            <>
              <div className="wb-inv-totals">
                <span>类型<b>{KIND_LABELS[board.order.kind] ?? board.order.kind}</b></span>
                <span>客户<b>{board.order.customerName || '未填写'}</b></span>
                <span>总额<b>{formatYuan(board.order.totalCents)}</b></span>
                <span>待收尾款<b>{formatYuan(Math.max(board.order.balanceCents, 0))}</b></span>
                <span>履约阶段<b>{FULFILLMENT_LABELS[board.order.fulfillmentState] ?? board.order.fulfillmentState}</b></span>
              </div>

              {gapText ? (
                <p className="wb-inv-notice wb-inv-notice--warn">
                  还有货没占住：{gapText}。先去「库存 → 缺件处理」补货，或回订单处理页补分配实物。
                </p>
              ) : null}

              <div className="wb-detail">
                <h2>销售行</h2>
                <div className="wb-quote-table-scroll">
                  <table className="wb-quote-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>来源</th>
                        <th>名称</th>
                        <th>数量</th>
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
                          </td>
                          <td className="wb-tabular">{line.qty}</td>
                          <td className="wb-tabular">{formatYuan(line.netLineCents)}</td>
                          <td>
                            {line.stockItemId
                              ? line.stockItemAssetCode || line.stockItemId
                              : line.source === 'customer' || line.source === 'service'
                                ? <span className="wb-caption">不占库存</span>
                                : <span className="wb-caption">按数量占用</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="wb-detail">
                <h2>备料与装机</h2>
                {canAssemble ? (
                  step?.action ? (
                    <div className="wb-inv-toolbar wb-form">
                      <div className="wb-form-actions">
                        <button
                          type="button"
                          className="wb-btn wb-btn--primary"
                          disabled={busy || board.order.tradeState !== 'confirmed'}
                          onClick={() => void handleAssembly()}
                        >
                          {busy ? '提交中…' : step.action}
                        </button>
                        <p className="wb-form-hint">{step.hint}</p>
                      </div>
                      {board.gaps.some((gap) => gap.shortageQty > 0) && detail.lines.some((line) => line.source === 'customer') ? (
                        <label className="wb-field">
                          <span>客供件接收引用（机器确实拿到手里了）</span>
                          <input
                            value={receiptRef}
                            onChange={(event) => setReceiptRef(event.target.value)}
                            placeholder="例：客户 9-21 到店交付主机"
                          />
                        </label>
                      ) : null}
                    </div>
                  ) : (
                    <p className="wb-caption">{step?.hint}</p>
                  )
                ) : (
                  <p className="wb-caption">当前账号没有备料与检测的权限。</p>
                )}
              </div>

              <div className="wb-detail">
                <h2>装机检测</h2>
                {canAssemble ? (
                  <>
                    <div className="wb-quote-table-scroll">
                      <table className="wb-quote-table">
                        <thead>
                          <tr>
                            <th>项</th>
                            <th>类型</th>
                            <th>结论</th>
                            <th>说明</th>
                            <th>关联实物</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((item, index) => (
                            <tr key={item.key}>
                              <td>{item.label}</td>
                              <td>{CHECK_KIND_LABELS[item.kind] ?? item.kind}</td>
                              <td>
                                <select
                                  value={item.state}
                                  disabled={busy || board.order.fulfillmentState === 'delivered'}
                                  onChange={(event) => {
                                    const state = event.target.value as CheckItemPayload['state']
                                    setItems((current) => current.map((row, at) => (at === index ? { ...row, state } : row)))
                                  }}
                                >
                                  {Object.entries(CHECK_ITEM_STATE_LABELS).map(([value, label]) => (
                                    <option key={value} value={value}>{label}</option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <input
                                  value={item.note}
                                  disabled={busy || board.order.fulfillmentState === 'delivered'}
                                  placeholder="可留空；不通过时写清现象"
                                  onChange={(event) => {
                                    const note = event.target.value
                                    setItems((current) => current.map((row, at) => (at === index ? { ...row, note } : row)))
                                  }}
                                />
                              </td>
                              <td>
                                {item.state === 'fail' ? (
                                  <select
                                    value={item.stockItemId ?? ''}
                                    disabled={busy || board.order.fulfillmentState === 'delivered'}
                                    onChange={(event) => {
                                      const stockItemId = event.target.value || null
                                      setItems((current) => current.map((row, at) => (at === index ? { ...row, stockItemId } : row)))
                                    }}
                                  >
                                    <option value="">（选坏件实物）</option>
                                    {linkableItems.map((line) => (
                                      <option key={line.stockItemId as string} value={line.stockItemId as string}>
                                        {line.stockItemAssetCode || line.stockItemId} · {line.nameSnapshot}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <span className="wb-caption">—</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="wb-form-actions">
                      <button
                        type="button"
                        className="wb-btn wb-btn--primary"
                        disabled={busy || board.order.fulfillmentState === 'delivered' || board.order.tradeState !== 'confirmed'}
                        onClick={() => void handleSaveChecks()}
                      >
                        {busy ? '提交中…' : '保存检测结果'}
                      </button>
                      <p className="wb-form-hint">
                        结论由服务端按各项派生：有「不通过」就是不通过，全部通过才算通过 —— 没测过的项不会替你打勾。
                      </p>
                    </div>
                  </>
                ) : (
                  <p className="wb-caption">当前账号没有备料与检测的权限。</p>
                )}

                {board.checklists.length > 0 ? (
                  <div className="wb-quote-table-scroll">
                    <table className="wb-quote-table">
                      <thead>
                        <tr>
                          <th>第几版</th>
                          <th>结论</th>
                          <th>项数</th>
                          <th>不通过</th>
                          <th>记录时间</th>
                          <th>记录人</th>
                        </tr>
                      </thead>
                      <tbody>
                        {board.checklists.map((row) => (
                          <tr key={row.id}>
                            <td>第 {row.checklistVersion} 版</td>
                            <td>{CHECK_RESULT_LABELS[row.result] ?? row.result}</td>
                            <td className="wb-tabular">{row.itemCount}</td>
                            <td className="wb-tabular">{row.failCount}</td>
                            <td className="wb-caption">{formatDateTime(row.performedAt)}</td>
                            <td className="wb-caption">{row.performedByName || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="wb-caption">还没有检测记录。</p>
                )}
              </div>

              <div className="wb-detail">
                <h2>确认交付</h2>
                {board.delivery ? (
                  <dl>
                    <div><dt>交付时间</dt><dd>{formatDateTime(board.delivery.deliveredAt)}</dd></div>
                    <div><dt>资金处置</dt><dd>{DISPOSITION_LABELS[board.delivery.financialDisposition] ?? board.delivery.financialDisposition}</dd></div>
                    <div><dt>交付备注</dt><dd>{board.delivery.deliveryNote || '—'}</dd></div>
                    <div><dt>收货备注</dt><dd>{board.delivery.receivedByNote || '—'}</dd></div>
                  </dl>
                ) : canDeliver ? (
                  <>
                    <ul className="wb-gate-list">
                      {gates.map((gate) => (
                        <li key={gate.key} className={gate.ok ? 'is-ok' : 'is-blocked'}>
                          <span className="wb-gate-dot" aria-hidden="true">{gate.ok ? '✓' : '·'}</span>
                          <b>{gate.label}</b>
                          <span className="wb-caption">{gate.hint}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="wb-inv-toolbar wb-form">
                      <div className="wb-form-actions">
                        <label className="wb-field">
                          <span>交付备注（必填）</span>
                          <input
                            value={deliveryNote}
                            onChange={(event) => setDeliveryNote(event.target.value)}
                            placeholder="例：本人到店自提，当场开机验机"
                          />
                        </label>
                        <label className="wb-field">
                          <span>收货备注</span>
                          <input
                            value={receivedByNote}
                            onChange={(event) => setReceivedByNote(event.target.value)}
                            placeholder="可留空；代收时写清代收人"
                          />
                        </label>
                        <button
                          type="button"
                          className="wb-btn wb-btn--primary"
                          disabled={busy || board.order.fulfillmentState !== 'ready_delivery' || !deliveryNote.trim()}
                          onClick={() => void handleDeliver()}
                        >
                          {busy ? '提交中…' : '确认交付（扣库存）'}
                        </button>
                        <p className="wb-form-hint">
                          交付与收款是两次独立动作：交付失败不会动已经收过的钱；重复提交由服务端幂等兜底，不会扣两次库存。
                          尾款没结清时服务端会拒绝 —— 欠款交付需要老板批准（B09，尚未实现）。
                        </p>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="wb-caption">当前账号没有确认交付的权限。</p>
                )}
              </div>

              {actionError ? <p className="wb-inv-notice wb-inv-notice--warn">{actionError}</p> : null}
            </>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

export default WorkbenchFulfillmentPage
