import { useMemo, useState, useCallback } from 'react'
import type { HardwareLibraryItem } from '../types/quote'

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

async function searchHardware(keyword: string): Promise<SearchResult[]> {
  const body = new URLSearchParams({
    isCoupon: '0', keyword,
    openid: '564bdce0fa408fc9e1d5d42fd022ef0b',
    order: 'desc', page: '1', pddListId: '',
    sort: '', sourceType: '0', user_id: '',
  })
  const res = await fetch('https://appapi.maishou88.com/api/v1/homepage/searchList', {
    method: 'POST',
    headers: {
      'User-Agent': 'MaiShouApp/3.7.7 (iPhone; iOS 26.3; Scale/3.00)',
      'openid': '564bdce0fa408fc9e1d5d42fd022ef0b',
      'version': '3.7.7.2',
    },
    body,
  })
  const data: any = await res.json()
  return (data?.data || []).map((v: any) => ({
    goodsId: v.goodsId, source: v.sourceType, title: v.title,
    shopName: v.shopName, originalPrice: v.originalPrice,
    actualPrice: v.actualPrice, couponPrice: v.couponPrice,
    monthSales: v.monthSales, picUrl: v.picUrl,
  }))
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
  // 平台加分：京东 +3，天猫 +2
  if (item.source === 2) s += 3
  else if (item.source === 1) s += 2
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
  const map: Record<number, string> = { 1: '天猫', 2: '京东', 3: '拼多多', 7: '抖音', 8: '快手', 10: '1688' }
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
  isAdmin?: boolean
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
        <button className="hl-act" disabled={refreshing} onClick={() => { setRefreshing(true); onRefreshItem(item); setTimeout(() => setRefreshing(false), 500) }}
          title="单独刷新此硬件价格">{refreshing ? '⏳' : '🔄'}</button>
        <button className="hl-act hl-act-del" onClick={() => onDeleteItem(item.id)}>&#10007;</button>
      </td>
    </tr>
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
  const [newImage, setNewImage] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [refreshProgress, setRefreshProgress] = useState('')
  const [searchingPrice, setSearchingPrice] = useState(false)

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
    onAddItem(newCat, desc, price, newImage || undefined)
    setNewDesc('')
    setNewPrice('')
    setNewImage('')
  }, [newCat, newDesc, newPrice, newImage, onAddItem])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleAdd()
  }

  // ── 单条查价 ──
  const handlePriceSearch = useCallback(async () => {
    const desc = newDesc.trim()
    if (!desc || searchingPrice) return
    setSearchingPrice(true)
    try {
      const results = await searchHardware(desc)
      const best = pickBest(results, desc)
      if (best && best.actualPrice > 0) {
        setNewPrice(String(best.actualPrice))
        // 如果标题更完整，替换型号名
        if (best.title && best.title.length > desc.length) {
          setNewDesc(best.title)
        }
        // 同步获取图片 URL
        if (best.picUrl) {
          setNewImage(best.picUrl)
        }
      }
    } catch { /* ignore */ }
    setSearchingPrice(false)
  }, [newDesc, searchingPrice])

  // ── 单条刷新 ──
  const handleSingleRefresh = useCallback(async (item: HardwareLibraryItem) => {
    try {
      const results = await searchHardware(item.description)
      const best = pickBest(results, item.description)
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
    } catch { /* ignore */ }
  }, [onUpdateItem])
  const handleBatchRefresh = useCallback(async () => {
    if (refreshing || items.length === 0) return
    setRefreshing(true)
    const total = items.length
    for (let i = 0; i < total; i++) {
      const item = items[i]
      setRefreshProgress(`正在比价 ${i + 1}/${total}: ${item.description}`)
      await handleSingleRefresh(item)
      await new Promise((r) => setTimeout(r, 300))
    }
    setRefreshProgress('')
    setRefreshing(false)
  }, [refreshing, items, handleSingleRefresh])

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
    </section>
  )
}
