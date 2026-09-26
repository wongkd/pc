import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { deleteDraftQuote, fetchQuotes, type QuoteListRow } from '../workbench/quote-api'
import { deleteUnusedProduct, fetchUnusedProducts, type UnusedProductCandidate } from './test-data-cleanup-api'
import { inventoryClient } from '../workbench/inventory-api'
import './TestDataCleanupPage.css'

type LoadState = 'loading' | 'error' | 'ready'
type UnknownRequest = { requestId: string; label: string }

function canDeleteDraft(row: QuoteListRow): boolean {
  return row.status === 'draft'
    && row.currentRevision === 0
    && row.publishedRevision === null
    && !row.shared
}

export function TestDataCleanupPage({ permissions }: { permissions: string[] }) {
  const canManageStore = permissions.includes('*') || permissions.includes('store/manage')
  const [quotes, setQuotes] = useState<QuoteListRow[]>([])
  const [products, setProducts] = useState<UnusedProductCandidate[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [unknownRequest, setUnknownRequest] = useState<UnknownRequest | null>(null)
  const [checking, setChecking] = useState(false)

  const reload = useCallback(async () => {
    setLoadState('loading')
    setError('')
    const [quoteResult, productResult] = await Promise.all([
      fetchQuotes({ status: 'draft', limit: 100 }),
      fetchUnusedProducts(),
    ])
    if (!quoteResult.ok || !productResult.ok) {
      setError(!quoteResult.ok ? quoteResult.message : !productResult.ok ? productResult.message : '读取失败')
      setLoadState('error')
      return
    }
    setQuotes(quoteResult.data.quotes)
    setProducts(productResult.data.products)
    setLoadState('ready')
  }, [])

  useEffect(() => {
    if (canManageStore) void reload()
  }, [canManageStore, reload])

  const deletableQuotes = useMemo(() => quotes.filter(canDeleteDraft), [quotes])
  const protectedQuotes = quotes.length - deletableQuotes.length

  const removeDraft = async (row: QuoteListRow) => {
    if (!canDeleteDraft(row) || busyId) return
    const title = row.title.trim() || '未命名报价草稿'
    if (!window.confirm(`确定删除「${title}」吗？此操作只清除未发出、未分享、未转销售单的草稿，并留下管理员操作记录。`)) return
    setBusyId(`quote:${row.id}`)
    setError('')
    setNotice('')
    const result = await deleteDraftQuote(row.id, '管理员清理未发出的测试报价草稿')
    setBusyId(null)
    if (result.ok) {
      setNotice(`已删除「${title}」；操作记录已保留。`)
      setUnknownRequest(null)
      await reload()
      return
    }
    if (result.unknownResult && result.requestId) {
      setUnknownRequest({ requestId: result.requestId, label: `报价「${title}」` })
      setNotice('请求结果暂不明确。先查询原请求结果，不要重复提交。')
      return
    }
    await reload()
    setError(result.message)
  }

  const removeProduct = async (row: UnusedProductCandidate) => {
    if (busyId) return
    if (!window.confirm(`确定删除商品档案「${row.name}」吗？只删除没有库存、单据、流水和附件引用的商品主档，操作记录会保留。`)) return
    setBusyId(`product:${row.id}`)
    setError('')
    setNotice('')
    const result = await deleteUnusedProduct(row.id, `管理员清理未引用的测试商品档案「${row.name.slice(0, 140)}」`)
    setBusyId(null)
    if (result.ok) {
      setNotice(`已删除商品档案「${row.name}」；操作记录已保留。`)
      setUnknownRequest(null)
      await reload()
      return
    }
    if (result.unknownResult && result.requestId) {
      setUnknownRequest({ requestId: result.requestId, label: `商品「${row.name}」` })
      setNotice('请求结果暂不明确。先查询原请求结果，不要重复提交。')
      return
    }
    await reload()
    setError(result.message)
  }

  const checkUnknown = async () => {
    if (!unknownRequest || checking) return
    setChecking(true)
    const result = await inventoryClient.client.queryOperation(unknownRequest.requestId)
    setChecking(false)
    if (!result.ok) {
      setNotice('暂时无法查询服务端结果。稍后重试查询，不要重新提交清理请求。')
    } else if (result.status === 'succeeded') {
      setNotice(`后台确认${unknownRequest.label}已清理，操作记录已保留。`)
      setUnknownRequest(null)
      await reload()
    } else if (result.status === 'pending') {
      setNotice('后台仍在处理，稍后再查询。')
    } else if (result.status === 'failed') {
      setUnknownRequest(null)
      await reload()
      setError(`清理没有成功：${result.message || result.code || '请刷新列表确认状态'}`)
    } else {
      setNotice('后台查不到这笔请求。刷新列表确认状态后，可以重新提交。')
      setUnknownRequest(null)
      await reload()
    }
  }

  if (!canManageStore) {
    return <main className="wb-page cleanup-page"><h1>测试数据清理</h1><p className="wb-inv-state wb-inv-state--error">此页面仅对门店管理员开放。</p></main>
  }

  return (
    <main className="wb-page cleanup-page">
      <header className="wb-page-head">
        <div>
          <p className="wb-kicker">管理员工具</p>
          <h1>测试数据清理</h1>
          <p className="wb-caption">可以删除没有业务影响的报价草稿和空商品档案。库存实物、资金、顾客交接与历史单据保留并按业务流程更正。</p>
        </div>
        <div className="wb-page-head-actions">
          <button type="button" className="wb-btn" onClick={() => void reload()} disabled={loadState === 'loading'}>刷新</button>
        </div>
      </header>

      {notice ? <p className="cleanup-notice" role="status">{notice}</p> : null}
      {error ? <p className="wb-inv-state wb-inv-state--error" role="alert">{error}</p> : null}
      {unknownRequest ? (
        <div className="cleanup-unknown" role="status">
          <span>{unknownRequest.label}的服务端结果尚未确认。</span>
          <button type="button" className="wb-btn" disabled={checking} onClick={() => void checkUnknown()}>{checking ? '查询中…' : '查询原请求结果'}</button>
        </div>
      ) : null}

      <section className="cleanup-section">
        <div className="cleanup-section-head">
          <div><h2>未发出报价草稿</h2><p>可以删除 {deletableQuotes.length} 份{protectedQuotes ? `；另有 ${protectedQuotes} 份因曾发出或分享而保留` : ''}。</p><span className="cleanup-protected">仅列新版报价；旧版报价工作副本的 data 结构尚未核实，暂不纳入清理。</span></div>
          <Link className="wb-btn" to="/sales/quotes">打开报价列表</Link>
        </div>
        {loadState === 'loading' ? <p className="wb-inv-state">正在读取可清理数据…</p> : null}
        {loadState === 'error' ? <p className="wb-inv-state">读取失败。点击“刷新”重试。</p> : null}
        {loadState === 'ready' && quotes.length === 0 ? <p className="wb-inv-state">没有未发出的报价草稿。</p> : null}
        {loadState === 'ready' && quotes.length > 0 ? (
          <div className="cleanup-table-scroll" role="region" aria-label="可清理报价草稿" tabIndex={0}>
            <table className="cleanup-table">
              <thead><tr><th>报价标题</th><th>客户</th><th>更新时间</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>{quotes.map((row) => {
                const allowed = canDeleteDraft(row)
                return <tr key={row.id}>
                  <td>{row.title || '未命名报价'}</td>
                  <td>{row.customerName || '散客'}</td>
                  <td>{row.updatedAt}</td>
                  <td>{allowed ? '未发出草稿' : '历史记录需保留'}</td>
                  <td>
                    {allowed ? <button type="button" className="wb-btn cleanup-danger" disabled={busyId !== null} onClick={() => void removeDraft(row)}>{busyId === `quote:${row.id}` ? '删除中…' : '删除草稿'}</button>
                      : <span className="cleanup-protected">不可硬删</span>}
                  </td>
                </tr>
              })}</tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="cleanup-section">
        <div className="cleanup-section-head">
          <div><h2>未被引用的商品档案</h2><p>可以删除 {products.length} 条。只移除商品主档，不删库存、单据、流水、附件或审计记录。</p></div>
          <Link className="wb-btn" to="/inventory/products">打开商品管理</Link>
        </div>
        {loadState === 'ready' && products.length === 0 ? <p className="wb-inv-state">没有可删除的空商品档案。已被报价、采购、销售、库存或附件引用的商品，以及旧版报价工作副本尚未核实时，都会保留。</p> : null}
        {loadState === 'ready' && products.length > 0 ? (
          <div className="cleanup-table-scroll" role="region" aria-label="可清理商品档案" tabIndex={0}>
            <table className="cleanup-table">
              <thead><tr><th>商品</th><th>SKU</th><th>分类</th><th>建档时间</th><th>操作</th></tr></thead>
              <tbody>{products.map((row) => <tr key={row.id}>
                <td>{row.name}</td>
                <td>{row.sku || '—'}</td>
                <td>{row.category || '未分类'}</td>
                <td>{row.createdAt}</td>
                <td><button type="button" className="wb-btn cleanup-danger" disabled={busyId !== null} onClick={() => void removeProduct(row)}>{busyId === `product:${row.id}` ? '删除中…' : '删除档案'}</button></td>
              </tr>)}</tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="cleanup-section">
        <div className="cleanup-section-head"><div><h2>需要业务更正的记录</h2><p>库存流水、顾客设备交接、收付款和已形成的业务单据必须保留原始记录。</p></div></div>
        <div className="cleanup-links">
          <Link to="/inventory"><strong>库存与实物</strong><span>实物和流水保留；隔离件可退役，盘差走盘点差异流程。B39 报损动作尚未开放。</span></Link>
          <Link to="/recovery"><strong>回收单</strong><span>回收登记即产生顾客设备暂存记录；通过“归还客户”结束并保留交接轨迹。</span></Link>
          <Link to="/sales/orders"><strong>销售单</strong><span>未交付订单使用“取消销售单”；已交付订单走退货与退款。</span></Link>
          <Link to="/purchases"><strong>采购单</strong><span>使用“取消未到数量”；到货和付款记录保留。</span></Link>
          <Link to="/after-sales"><strong>售后工单</strong><span>按工单流程完成归还和结算，不删除客户设备交接记录。</span></Link>
        </div>
      </section>
    </main>
  )
}
