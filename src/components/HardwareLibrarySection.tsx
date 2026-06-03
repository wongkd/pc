import { useMemo, useState } from 'react'
import type { HardwareLibraryItem } from '../types/quote'

const ALL_CATEGORIES = [
  'CPU', '主板', '内存', '显卡', '硬盘',
  '散热器', '电源', '机箱', '风扇', '显示器',
  '其他', '鼠标', '键盘', '耳机', '座椅',
]

const CATEGORY_ORDER = new Map(ALL_CATEGORIES.map((c, i) => [c, i]))

// 柔和分类色（用于行背景）
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

interface HardwareLibrarySectionProps {
  items: HardwareLibraryItem[]
  search: string
  categoryFilter: string
  onSearchChange: (value: string) => void
  onCategoryFilterChange: (value: string) => void
  onAddItem: (category: string, description: string, price: number) => void
  onUpdateItem: (id: string, field: keyof HardwareLibraryItem, value: string | number) => void
  onDeleteItem: (id: string) => void
}

function HwLibRow({
  item,
  bgColor,
  onUpdateItem,
  onDeleteItem,
}: {
  item: HardwareLibraryItem
  bgColor: string
  onUpdateItem: (id: string, field: keyof HardwareLibraryItem, value: string | number) => void
  onDeleteItem: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [desc, setDesc] = useState(item.description)
  const [price, setPrice] = useState(String(item.price))

  if (editing) {
    return (
      <tr className="hl-row hl-row-edit" style={{ backgroundColor: bgColor }}>
        <td colSpan={2}>
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
      <td className="hl-desc">{item.description}</td>
      <td className="hl-price">{item.price.toLocaleString()}</td>
      <td className="hl-act-col">
        <button className="hl-act" onClick={() => { setDesc(item.description); setPrice(String(item.price)); setEditing(true) }}>&#9998;</button>
        <button className="hl-act hl-act-del" onClick={() => onDeleteItem(item.id)}>&#10007;</button>
      </td>
    </tr>
  )
}

export function HardwareLibrarySection({
  items,
  search,
  categoryFilter,
  onSearchChange,
  onCategoryFilterChange,
  onAddItem,
  onUpdateItem,
  onDeleteItem,
}: HardwareLibrarySectionProps) {
  const [newCat, setNewCat] = useState('CPU')
  const [newDesc, setNewDesc] = useState('')
  const [newPrice, setNewPrice] = useState('')

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

  const handleAdd = () => {
    const desc = newDesc.trim()
    const price = Number(newPrice) || 0
    if (!desc) return
    onAddItem(newCat, desc, price)
    setNewDesc('')
    setNewPrice('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleAdd()
  }

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
        </div>
      </div>

      {items.length === 0 ? (
        <div className="hl-empty">硬件库为空，在下方添加常用硬件。</div>
      ) : (
        <div className="hl-table-wrap">
          <table className="hl-table">
            <thead>
              <tr>
                <th>型号</th>
                <th style={{ width: 80 }}>价格</th>
                <th style={{ width: 52 }}></th>
              </tr>
            </thead>
            {grouped.map(([cat, catItems]) => {
              const bgColor = CATEGORY_COLORS[cat] ?? 'transparent'
              return (
              <tbody key={cat}>
                <tr className="hl-group-head" style={{ backgroundColor: bgColor }}>
                  <td colSpan={3}>
                    <span className="hl-group-dot" style={{ backgroundColor: bgColor.replace('0.06', '0.5') }} />
                    {cat} <span className="hl-group-n">{catItems.length}</span>
                  </td>
                </tr>
                {catItems.map((item) => (
                  <HwLibRow key={item.id} item={item} bgColor={bgColor}
                    onUpdateItem={onUpdateItem} onDeleteItem={onDeleteItem} />
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
      </div>
    </section>
  )
}
