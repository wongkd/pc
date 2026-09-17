import { useMemo, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { HardwareLibraryItem } from '../types/quote'
import { searchPrice } from '../utils/api'

const ALL_CATEGORIES = [
  'CPU', '主板', '内存', '显卡', '硬盘',
  '散热器', '电源', '机箱', '风扇', '显示器',
  '其他', '鼠标', '键盘', '耳机', '座椅',
]

const CATEGORY_ORDER = new Map(ALL_CATEGORIES.map((c, i) => [c, i]))

const CATEGORY_COLORS: Record<string, string> = {
  CPU: 'rgba(59, 130, 246, 0.06)',
  主板: 'rgba(99, 102, 241, 0.06)',
  内存: 'rgba(245, 158, 11, 0.06)',
  显卡: 'rgba(16, 185, 129, 0.06)',
  硬盘: 'rgba(139, 92, 246, 0.06)',
  散热器: 'rgba(14, 165, 233, 0.06)',
  电源: 'rgba(234, 179, 8, 0.06)',
  机箱: 'rgba(107, 114, 128, 0.06)',
  风扇: 'rgba(6, 182, 212, 0.06)',
  显示器: 'rgba(236, 72, 153, 0.06)',
  其他: 'rgba(148, 163, 184, 0.06)',
  鼠标: 'rgba(249, 115, 22, 0.06)',
  键盘: 'rgba(217, 70, 239, 0.06)',
  耳机: 'rgba(20, 184, 166, 0.06)',
  座椅: 'rgba(168, 85, 247, 0.06)',
}

// ── 搜索 API ──

interface SearchResult {
  goodsId: string
  source: number
  title: string
  shopName: string
  originalPrice: number
  actualPrice: number
  couponPrice: number
  monthSales: number
  picUrl: string
}


// ── 聚合商品检测：标题里堆砌多个型号词，一个链接包含多个 SKU ──

// 匹配 CPU / GPU 型号片段的增强正则
const MODEL_PATTERNS = /(i[3579]\s*\d{3,5}[a-z]*|r[3579]\s*\d{3,5}[a-z]*|rtx\s*\d{4}|gtx\s*\d{3,4}|rx\s*\d{3,4}|[a-z]\d{4,5}[a-z]*|\d{4,5}[a-z]+)/gi

// 从标题提取去重型号列表（用于多SKU标签展示）
function extractModelTags(title: string): string[] {
  const matches = title.match(MODEL_PATTERNS)
  if (!matches || matches.length <= 1) return []
  const seen = new Set<string>()
  const tags: string[] = []
  for (const m of matches) {
    const key = m.replace(/\s/g, '').toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      // 标准化格式：去掉多余空格，保留字母大小写
      tags.push(m.replace(/\s+/g, '').toUpperCase())
    }
  }
  return tags.slice(0, 8) // 最多展示 8 个
}

function isAggregateProduct(title: string): boolean {
  const tags = extractModelTags(title)
  return tags.length >= 3
}

// ── 黑名单：这写词说明结果是整机/套装，非单独硬件 ──
const BUILD_KEYWORDS = ['整机', '组装', '主机', '台式机', '全套', '套装', '套餐',
  '游戏电脑', '办公电脑', '电竞主机', 'DIY主机', '台式电脑', '游戏主机']

function isBuildResult(title: string): boolean {
  const t = title.toLowerCase()
  return BUILD_KEYWORDS.some((w) => t.includes(w))
}

function scoreResult(item: SearchResult, keyword: string): number {
  let s = 0
  const t = item.title.toLowerCase()
  const kw = keyword.toLowerCase()
  // 完整关键词匹配
  if (t.includes(kw)) s += 50
  // 单个关键词片段匹配
  for (const w of kw.split(/[\s\-/]+/)) {
    if (w.length < 2) continue
    if (t.includes(w)) s += 10
  }
  // 平台加分：淘宝(4) +6，京东(2) +4，拼多多(3) +2，天猫(1) +1
  if (item.source === 4) s += 6
  else if (item.source === 2) s += 4
  else if (item.source === 3) s += 2
  else if (item.source === 1) s += 1
  // 销量加分
  const sales = Number(item.monthSales) || 0
  if (sales > 100) s += 5
  else if (sales > 10) s += 2
  return s
}

function pickBest(results: SearchResult[], keyword: string): SearchResult | null {
  if (results.length === 0) return null
  // 过滤整机/套装
  const filtered = results.filter((r) => !isBuildResult(r.title))
  const pool = filtered.length > 0 ? filtered : results
  // 按评分排序
  const scored = pool.map((r) => ({ item: r, score: scoreResult(r, keyword) }))
  scored.sort((a, b) => b.score - a.score)
  return scored[0]?.item ?? null
}

function sourceName(source: number): string {
  const map: Record<number, string> = { 1: '天猫', 2: '京东', 3: '拼多多', 4: '淘宝', 7: '抖音', 8: '快手', 10: '1688' }
  return map[source] ?? `平台${source}`
}

function relativeTime(iso: string): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return '刚刚'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  return `${Math.floor(h / 24)}天前`
}

// ── Props ──

interface HardwareLibrarySectionProps {
  items: HardwareLibraryItem[]
  search: string
  categoryFilter: string
  onSearchChange: (value: string) => void
  onCategoryFilterChange: (value: string) => void
  onAddItem: (category: string, description: string, price: number, image?: string) => void
  onUpdateItem: (id: string, field: keyof HardwareLibraryItem, value: string | number) => void
  onDeleteItem: (id: string) => void
}

// ── 行组件 ──

function HwLibRow({
  item, bgColor, onUpdateItem, onDeleteItem, onRefreshItem,
}: {
  item: HardwareLibraryItem
  bgColor: string
  onUpdateItem: (id: string, field: keyof HardwareLibraryItem, value: string | number) => void
  onDeleteItem: (id: string) => void
  onRefreshItem: (item: HardwareLibraryItem) => void
}) {
  const [editing, setEditing] = useState(false)
  const [desc, setDesc] = useState(item.description)
  const [price, setPrice] = useState(String(item.price))
  const [refreshing, setRefreshing] = useState(false)

  if (editing) {
    return (
      <tr className="hl-row hl-row-edit" style={{ backgroundColor: bgColor }}>
        <td className="hl-thumb-cell">{item.image ? <img className="hl-thumb" src={item.image} alt="" /> : null}</td>
        <td>
          <input className="hl-inp" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="型号" autoFocus />
          <input className="hl-inp hl-inp-price" type="number" min="0" step="0.01" value={price}
            onChange={(e) => setPrice(e.target.value)} style={{ width: 90, marginLeft: 6 }} />
        </td>
        <td className="hl-act-col">
          <button className="hl-act hl-act-ok" onClick={() => {
            onUpdateItem(item.id, 'description', desc.trim())
            onUpdateItem(item.id, 'price', Number(price) || 0)
            setEditing(false)
          }}>&#10003;</button>
          <button className="hl-act hl-act-no" onClick={() => setEditing(false)}>&#10007;</button>
        </td>
      </tr>
    )
  }

  return (
    <tr className="hl-row" style={{ backgroundColor: bgColor }}>
      <td className="hl-thumb-cell">
        {item.image ? <img className="hl-thumb" src={item.image} alt="" /> : null}
      </td>
      <td>
        <span className="hl-desc">{item.description}</span>
        {item.lastRefreshed ? (
          <span className="hl-refresh" title={item.lastRefreshed}>
            {item.sourcePlatform ? ` · ${item.sourcePlatform}` : ''} · {relativeTime(item.lastRefreshed)}
          </span>
        ) : null}
      </td>
      <td className="hl-price">{item.price.toLocaleString()}</td>
      <td className="hl-act-col">
        <button className="hl-act" onClick={() => { setDesc(item.description); setPrice(String(item.price)); setEditing(true) }}>&#9998;</button>
        <button className="hl-act" disabled={refreshing} onClick={async () => { setRefreshing(true); await onRefreshItem(item); setRefreshing(false) }}
          title="单独刷新此硬件价格">{refreshing ? '⏳' : '🔄'}</button>
        <button className="hl-act hl-act-del" onClick={() => onDeleteItem(item.id)}>&#10007;</button>
      </td>
    </tr>
  )
}

// ── 候选商品弹窗 ──

interface CandidateModalProps {
  results: SearchResult[]
  keyword: string
  onConfirm: (selected: SearchResult) => void
  onCancel: () => void
  onSearchKeyword?: (model: string) => void
}

function CandidateModal({ results, keyword, onConfirm, onCancel, onSearchKeyword }: CandidateModalProps) {
  const filtered = results.filter((r) => !isBuildResult(r.title))
  const pool = filtered.length > 0 ? filtered : results
  const scored = pool.map((r, i) => ({ item: r, score: scoreResult(r, keyword), origIdx: i }))
  scored.sort((a, b) => b.score - a.score)
  const [selectedIdx, setSelectedIdx] = useState(0)

  return createPortal(
    <div className="cand-overlay" onClick={onCancel}>
      <div className="cand-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cand-head">
          <span>找到 <b>{scored.length}</b> 个候选商品，请选择</span>
        </div>
        <div className="cand-body">
          {scored.map((s, i) => {
            const r = s.item
            const missingPrice = !r.actualPrice || r.actualPrice <= 0
            const isAgg = isAggregateProduct(r.title)
            const skuTags = isAgg ? extractModelTags(r.title) : []
            return (
              <div
                key={r.goodsId || i}
                className={`cand-card ${i === selectedIdx ? 'cand-sel' : ''} ${isAgg ? 'cand-agg' : ''}`}
                onClick={() => setSelectedIdx(i)}
              >
                <div className="cand-badges">
                  {i === 0 && <span className="cand-badge cand-badge-rec">推荐</span>}
                  {isAgg && <span className="cand-badge cand-badge-agg">⚠️ 多SKU</span>}
                </div>
                <div className="cand-pic">
                  {r.picUrl
                    ? <img src={r.picUrl} alt="" />
                    : <span className="cand-noimg">暂无图片</span>}
                </div>
                <div className="cand-info">
                  <div className="cand-title">{r.title || '未知商品'}</div>
                  {skuTags.length > 0 && (
                    <div className="cand-skus">
                      {skuTags.map((tag) => (
                        <span
                          key={tag}
                          className={`cand-sku-tag ${onSearchKeyword ? 'cand-sku-clickable' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            onSearchKeyword?.(tag)
                          }}
                          title={onSearchKeyword ? '点击用此型号重新查价' : undefined}
                        >{tag}</span>
                      ))}
                    </div>
                  )}
                  <div className="cand-meta">
                    <span className="cand-platform">{sourceName(r.source)}</span>
                    {r.shopName && <span className="cand-shop">{r.shopName}</span>}
                  </div>
                  <div className="cand-price-row">
                    {missingPrice ? (
                      <span className="cand-noprice">暂无报价</span>
                    ) : (
                      <>
                        <span className="cand-price">¥{r.actualPrice.toLocaleString()}</span>
                        {r.originalPrice > r.actualPrice && (
                          <span className="cand-orig">¥{r.originalPrice.toLocaleString()}</span>
                        )}
                        {r.couponPrice > 0 && (
                          <span className="cand-coupon">券后 ¥{r.couponPrice.toLocaleString()}</span>
                        )}
                      </>
                    )}
                  </div>
                  <div className="cand-sales">
                    月销 {Number(r.monthSales) || 0}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        <div className="cand-foot">
          <button className="cand-btn cand-btn-cancel" type="button" onClick={onCancel}>取消</button>
          <button className="cand-btn cand-btn-confirm" type="button" onClick={() => onConfirm(scored[selectedIdx].item)}>确认选择</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── 主组件 ──

export function HardwareLibrarySection({
  items, search, categoryFilter, onSearchChange, onCategoryFilterChange,
  onAddItem, onUpdateItem, onDeleteItem,
}: HardwareLibrarySectionProps) {
  const [newCat, setNewCat] = useState('CPU')
  const [newDesc, setNewDesc] = useState('')
  const [newPrice, setNewPrice] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [refreshProgress, setRefreshProgress] = useState('')
  const [searchingPrice, setSearchingPrice] = useState(false)
  const [priceImage, setPriceImage] = useState('')
  const [searchError, setSearchError] = useState('')
  const [candidates, setCandidates] = useState<{ results: SearchResult[]; keyword: string; mode: 'search' | 'refresh'; item?: HardwareLibraryItem } | null>(null)

  const grouped = useMemo(() => {
    const map = new Map<string, HardwareLibraryItem[]>()
    for (const item of items) {
      const c = ALL_CATEGORIES.includes(item.category) ? item.category : '其他'
      const list = map.get(c) ?? []
      list.push(item)
      map.set(c, list)
    }
    return Array.from(map.entries()).sort(([a], [b]) =>
      (CATEGORY_ORDER.get(a) ?? 99) - (CATEGORY_ORDER.get(b) ?? 99),
    )
  }, [items])

  const filterOptions = useMemo(() => {
    const opts = ['全部']
    for (const cat of ALL_CATEGORIES) {
      if (grouped.find(([c]) => c === cat)) opts.push(cat)
    }
    return opts
  }, [grouped])

  const handleAdd = useCallback(async () => {
    const desc = newDesc.trim()
    const price = Number(newPrice) || 0
    if (!desc) return
    onAddItem(newCat, desc, price, priceImage || undefined)
    setNewDesc('')
    setNewPrice('')
    setPriceImage('')
  }, [newCat, newDesc, newPrice, onAddItem])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleAdd()
  }

  // ── 单条查价 ──
  const handlePriceSearch = useCallback(async () => {
    const desc = newDesc.trim()
    if (!desc || searchingPrice) return
    setSearchingPrice(true)
    setSearchError('')
    try {
      const results = await searchPrice(desc) as SearchResult[]
      if (results.length === 0) {
        setSearchError('未找到匹配商品，请尝试其他关键词')
      } else if (results.length === 1) {
        const best = results[0]
        if (best.actualPrice > 0) setNewPrice(String(best.actualPrice))
        if (best.title && best.title.length > desc.length) setNewDesc(best.title)
        if (best.picUrl) setPriceImage(best.picUrl)
      } else {
        setCandidates({ results, keyword: desc, mode: 'search' })
      }
    } catch {
      setSearchError('查询失败，请稍后重试')
    }
    setSearchingPrice(false)
  }, [newDesc, searchingPrice])

  // ── 单条刷新 ──
  const handleSingleRefresh = useCallback(async (item: HardwareLibraryItem, skipCandidate = false) => {
    try {
      const results = await searchPrice(item.description) as SearchResult[]
      if (results.length === 0) return
      if (results.length === 1 || skipCandidate) {
        const best = skipCandidate ? pickBest(results, item.description) : results[0]
        if (best) {
          if (best.title && best.title.length > item.description.length) {
            onUpdateItem(item.id, 'description', best.title)
          }
          if (best.actualPrice && best.actualPrice > 0) {
            onUpdateItem(item.id, 'price', best.actualPrice)
          }
          if (best.picUrl) {
            onUpdateItem(item.id, 'image', best.picUrl)
          }
          onUpdateItem(item.id, 'lastRefreshed', new Date().toISOString())
          onUpdateItem(item.id, 'sourcePlatform', sourceName(best.source))
        }
      } else {
        setCandidates({ results, keyword: item.description, mode: 'refresh', item })
      }
    } catch { /* ignore */ }
  }, [onUpdateItem])
  const handleBatchRefresh = useCallback(async () => {
    if (refreshing || items.length === 0) return
    setRefreshing(true)
    const total = items.length
    for (let i = 0; i < total; i++) {
      const item = items[i]
      setRefreshProgress(`正在比价 ${i + 1}/${total}: ${item.description}`)
      await handleSingleRefresh(item, true)
      await new Promise((r) => setTimeout(r, 300))
    }
    setRefreshProgress('')
    setRefreshing(false)
  }, [refreshing, items, handleSingleRefresh])

  // ── 候选商品确认 ──
  const handleCandidateConfirm = useCallback((selected: SearchResult) => {
    if (!candidates) return
    if (candidates.mode === 'search') {
      if (selected.actualPrice > 0) setNewPrice(String(selected.actualPrice))
      if (selected.title && selected.title.length > newDesc.trim().length) setNewDesc(selected.title)
      if (selected.picUrl) setPriceImage(selected.picUrl)
    } else if (candidates.mode === 'refresh' && candidates.item) {
      const item = candidates.item
      if (selected.title && selected.title.length > item.description.length) {
        onUpdateItem(item.id, 'description', selected.title)
      }
      if (selected.actualPrice && selected.actualPrice > 0) {
        onUpdateItem(item.id, 'price', selected.actualPrice)
      }
      if (selected.picUrl) {
        onUpdateItem(item.id, 'image', selected.picUrl)
      }
      onUpdateItem(item.id, 'lastRefreshed', new Date().toISOString())
      onUpdateItem(item.id, 'sourcePlatform', sourceName(selected.source))
    }
    setCandidates(null)
  }, [candidates, newDesc, onUpdateItem])

  return (
    <section className="panel-section panel-section-library">
      <div className="hl-head">
        <h2 className="hl-title">硬件库</h2>
        <div className="hl-tools">
          <input className="hl-search" placeholder="搜索硬件…" value={search}
            onChange={(e) => onSearchChange(e.target.value)} />
          <select className="hl-filter" value={categoryFilter}
            onChange={(e) => onCategoryFilterChange(e.target.value)}>
            {filterOptions.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button
            className="hl-batch-btn"
            disabled={refreshing || items.length === 0}
            onClick={handleBatchRefresh}
            title="全网比价刷新所有硬件"
          >
            {refreshing ? '⏳' : '⚡'} 一键比价
          </button>
        </div>
      </div>

      {refreshing && refreshProgress ? (
        <div className="hl-progress">{refreshProgress}</div>
      ) : null}

      {items.length === 0 ? (
        <div className="hl-empty">硬件库为空，在下方添加常用硬件后点击「⚡ 一键比价」自动搜集价格和图片。</div>
      ) : (
        <div className="hl-table-wrap">
          <table className="hl-table">
            <thead>
              <tr>
                <th style={{ width: 32 }}></th>
                <th>型号</th>
                <th style={{ width: 88 }}>价格</th>
                <th style={{ width: 52 }}></th>
              </tr>
            </thead>
            {grouped.map(([cat, catItems]) => {
              const bgColor = CATEGORY_COLORS[cat] ?? 'transparent'
              return (
              <tbody key={cat}>
                <tr className="hl-group-head" style={{ backgroundColor: bgColor }}>
                  <td colSpan={4}>
                    <span className="hl-group-dot" style={{ backgroundColor: bgColor.replace('0.06', '0.5') }} />
                    {cat} <span className="hl-group-n">{catItems.length}</span>
                  </td>
                </tr>
                {catItems.map((item) => (
                  <HwLibRow key={item.id} item={item} bgColor={bgColor}
                    onUpdateItem={onUpdateItem} onDeleteItem={onDeleteItem}
                    onRefreshItem={handleSingleRefresh} />
                ))}
              </tbody>
            )})}
          </table>
        </div>
      )}

      <div className="hl-add-row">
        <select className="hl-inp hl-add-cat" value={newCat} onChange={(e) => setNewCat(e.target.value)}>
          {ALL_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input className="hl-inp hl-add-desc" placeholder="输入型号" value={newDesc}
          onChange={(e) => setNewDesc(e.target.value)} onKeyDown={handleKeyDown} />
        <input className="hl-inp hl-inp-price hl-add-price" type="number" min="0" step="0.01"
          placeholder="价格" value={newPrice}
          onChange={(e) => setNewPrice(e.target.value)} onKeyDown={handleKeyDown} />
        <button className="hl-add-btn" onClick={handleAdd}>添加</button>
        <button className="hl-price-btn" onClick={handlePriceSearch} disabled={searchingPrice || !newDesc.trim()}
          title="自动查价并纠错名称">
          {searchingPrice ? '⏳' : '🔍'} 查价
        </button>
      </div>
      {searchError && <div className="hl-error">{searchError}</div>}
      {candidates && (
        <CandidateModal
          results={candidates.results}
          keyword={candidates.keyword}
          onConfirm={handleCandidateConfirm}
          onCancel={() => setCandidates(null)}
          onSearchKeyword={(model) => {
            setCandidates(null)
            setNewDesc(model)
            // 延迟触发查价，确保输入框已更新
            setTimeout(() => handlePriceSearch(), 50)
          }}
        />
      )}
    </section>
  )
}
