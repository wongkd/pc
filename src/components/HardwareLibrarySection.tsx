import { useMemo, useState } from 'react'
import type { HardwareLibraryItem } from '../types/quote'

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
  onUpdateItem,
  onDeleteItem,
}: {
  item: HardwareLibraryItem
  onUpdateItem: (id: string, field: keyof HardwareLibraryItem, value: string | number) => void
  onDeleteItem: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [cat, setCat] = useState(item.category)
  const [desc, setDesc] = useState(item.description)
  const [price, setPrice] = useState(String(item.price))

  if (editing) {
    return (
      <tr className="hl-row hl-row-edit">
        <td><input className="hl-inp" value={cat} onChange={(e) => setCat(e.target.value)} placeholder="分类" /></td>
        <td><input className="hl-inp" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="型号" /></td>
        <td><input className="hl-inp hl-inp-price" type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} /></td>
        <td className="hl-act-col">
          <button className="hl-act hl-act-ok" onClick={() => {
            onUpdateItem(item.id, 'category', cat.trim())
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
    <tr className="hl-row">
      <td className="hl-cat">{item.category}</td>
      <td className="hl-desc">{item.description}</td>
      <td className="hl-price">{item.price.toLocaleString()}</td>
      <td className="hl-act-col">
        <button className="hl-act" onClick={() => { setCat(item.category); setDesc(item.description); setPrice(String(item.price)); setEditing(true) }}>&#9998;</button>
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
      const c = item.category || '其他'
      const list = map.get(c) ?? []
      list.push(item)
      map.set(c, list)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [items])

  const categories = useMemo(
    () => ['全部', ...new Set(items.map((i) => i.category).filter(Boolean))],
    [items],
  )

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
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
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
                <th style={{ width: 100 }}>分类</th>
                <th>型号</th>
                <th style={{ width: 100 }}>价格</th>
                <th style={{ width: 56 }}></th>
              </tr>
            </thead>
            {grouped.map(([cat, catItems]) => (
              <tbody key={cat}>
                <tr className="hl-group-head">
                  <td colSpan={4}>{cat} <span className="hl-group-n">{catItems.length}</span></td>
                </tr>
                {catItems.map((item) => (
                  <HwLibRow key={item.id} item={item}
                    onUpdateItem={onUpdateItem} onDeleteItem={onDeleteItem} />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}

      <div className="hl-add-row">
        <select className="hl-inp hl-add-cat" value={newCat} onChange={(e) => setNewCat(e.target.value)}>
          {categories.filter((c) => c !== '全部').map((c) => <option key={c} value={c}>{c}</option>)}
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
