import { useMemo, useState } from 'react'
import type { HardwareLibraryItem, QuoteItem } from '../types/quote'
import { formatMoney } from '../utils/money'

const ALL_CATEGORIES = [
  'CPU',
  '主板',
  '内存',
  '显卡',
  '硬盘',
  '散热器',
  '电源',
  '机箱',
  '风扇',
  '显示器',
  '其他',
  '鼠标',
  '键盘',
  '耳机',
  '座椅',
] as const

const DEFAULT_VISIBLE_COUNT = 11 // first 11 always visible; 鼠标/键盘/耳机/座椅 only when non-empty

const CATEGORY_EMOJI: Record<string, string> = {
  CPU: '\u{1F4BB}',
  主板: '\u{1F527}',
  内存: '\u{1F9E0}',
  显卡: '\u{1F3AE}',
  硬盘: '\u{1F4BE}',
  散热器: '\u{2744}\u{FE0F}',
  电源: '\u{26A1}',
  机箱: '\u{1F5B3}\u{FE0F}',
  风扇: '\u{1F32C}\u{FE0F}',
  显示器: '\u{1F5A5}\u{FE0F}',
  其他: '\u{1F4E6}',
  鼠标: '\u{1F5B1}\u{FE0F}',
  键盘: '\u{2328}\u{FE0F}',
  耳机: '\u{1F3A7}',
  座椅: '\u{1FA91}',
}

function pickSuggestions(
  keyword: string,
  library: readonly HardwareLibraryItem[],
  limit = 5,
): HardwareLibraryItem[] {
  if (!keyword || keyword.length < 2) return []
  const kw = keyword.toLowerCase()
  return library
    .filter(
      (item) =>
        item.description.toLowerCase().includes(kw) || item.category.toLowerCase().includes(kw),
    )
    .slice(0, limit)
}

interface QuoteItemsSectionProps {
  title?: string
  items: QuoteItem[]
  libraryItems: readonly HardwareLibraryItem[]
  highlightedItemId?: string | null
  onAddItem: (category?: string) => void
  onDeleteItem: (id: string) => void
  onMoveItemUp: (id: string) => void
  onMoveItemDown: (id: string) => void
  onChangeItem: (id: string, field: keyof QuoteItem, value: string | number) => void
}

export function QuoteItemsSection({
  title,
  items,
  libraryItems,
  highlightedItemId,
  onAddItem,
  onDeleteItem,
  onMoveItemUp,
  onMoveItemDown,
  onChangeItem,
}: QuoteItemsSectionProps) {
  const totalAmount = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
  const [showCategoryModal, setShowCategoryModal] = useState(false)

  const categories = useMemo(() => {
    const map = new Map<string, QuoteItem[]>()
    for (const item of items) {
      const cat = ALL_CATEGORIES.includes(item.category as (typeof ALL_CATEGORIES)[number])
        ? item.category
        : '其他'
      const list = map.get(cat) ?? []
      list.push(item)
      map.set(cat, list)
    }

    // Show all categories that have items; plus first 11 if they don't
    const ordered: string[] = []
    for (const cat of ALL_CATEGORIES) {
      const idx = ALL_CATEGORIES.indexOf(cat)
      if (map.has(cat) || idx < DEFAULT_VISIBLE_COUNT) {
        ordered.push(cat)
      }
    }
    return { map, ordered }
  }, [items])

  const [activeCategory, setActiveCategory] = useState<string>(
    categories.ordered[0] ?? ALL_CATEGORIES[0],
  )

  const activeItems = categories.map.get(activeCategory) ?? []

  const handleSelectCategory = (cat: string) => {
    setShowCategoryModal(false)
    onAddItem(cat)
    setActiveCategory(cat)
  }

  return (
    <section className="panel-section panel-section-primary">
      <div className="section-head section-head-emphasis">
        <div className="section-head-copy">
          <h2>{title?.trim() || '当前报价项目'}</h2>
        </div>
        <div className="section-head-side">
          <div className="section-mini-stats">
            <span>共 {items.length} 项</span>
            <span>合计 {formatMoney(totalAmount)}</span>
          </div>
          <button
            className="btn primary small"
            type="button"
            onClick={() => setShowCategoryModal(true)}
          >
            新增项目
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">当前还没有报价项目，请点击「新增项目」开始添加配件。</div>
      ) : (
        <div className="split-layout">
          <nav className="split-nav">
            {categories.ordered.map((cat) => {
              const catItems = categories.map.get(cat) ?? []
              return (
                <button
                  key={cat}
                  className={`split-nav-item ${cat === activeCategory ? 'active' : ''}`}
                  type="button"
                  onClick={() => setActiveCategory(cat)}
                >
                  <span className="split-nav-emoji">{CATEGORY_EMOJI[cat] ?? '\u{1F4E6}'}</span>
                  <span className="split-nav-label">{cat}</span>
                  <span className="split-nav-count">{catItems.length}</span>
                </button>
              )
            })}
          </nav>

          <div className="split-content">
            <div className="split-content-head">
              <span>
                {CATEGORY_EMOJI[activeCategory] ?? ''} {activeCategory}
              </span>
              <div className="split-content-head-actions">
                <span className="split-content-head-meta">
                  {activeItems.length} 项 · 合计{' '}
                  {formatMoney(
                    activeItems.reduce((s, i) => s + i.quantity * i.unitPrice, 0),
                  )}
                </span>
                <button
                  className="split-content-add"
                  type="button"
                  onClick={() => onAddItem(activeCategory)}
                  title={`新增 ${activeCategory}`}
                >
                  + 新增
                </button>
              </div>
            </div>

            <div className="stack">
              {activeItems.map((item, index) => {
                const subtotal = item.quantity * item.unitPrice
                return (
                  <QuoteItemCard
                    key={item.id}
                    item={item}
                    index={index}
                    total={activeItems.length}
                    normalizedCategory={activeCategory}
                    subtotal={subtotal}
                    highlighted={highlightedItemId === item.id}
                    libraryItems={libraryItems}
                    onChangeItem={onChangeItem}
                    onMoveUp={() => onMoveItemUp(item.id)}
                    onMoveDown={() => onMoveItemDown(item.id)}
                    onDelete={() => onDeleteItem(item.id)}
                  />
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Category selection modal */}
      {showCategoryModal && (
        <div className="cat-modal-overlay" onClick={() => setShowCategoryModal(false)}>
          <div className="cat-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cat-modal-grid">
              {ALL_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  className="cat-modal-item"
                  type="button"
                  onClick={() => handleSelectCategory(cat)}
                >
                  <span className="cat-modal-emoji">{CATEGORY_EMOJI[cat] ?? '\u{1F4E6}'}</span>
                  <span>{cat}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

/* ──────────── Card ──────────── */

interface QuoteItemCardProps {
  item: QuoteItem
  index: number
  total: number
  normalizedCategory: string
  subtotal: number
  highlighted: boolean
  libraryItems: readonly HardwareLibraryItem[]
  onChangeItem: (id: string, field: keyof QuoteItem, value: string | number) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDelete: () => void
}

function QuoteItemCard({
  item,
  index,
  total,
  normalizedCategory: _normalizedCategory,
  subtotal,
  highlighted,
  libraryItems,
  onChangeItem,
  onMoveUp,
  onMoveDown,
  onDelete,
}: QuoteItemCardProps) {
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [inputFocused, setInputFocused] = useState(false)

  const suggestions = useMemo(
    () => pickSuggestions(item.name, libraryItems),
    [item.name, libraryItems],
  )

  const handleApplySuggestion = (libItem: HardwareLibraryItem) => {
    onChangeItem(item.id, 'name', libItem.description)
    onChangeItem(item.id, 'category', libItem.category)
    onChangeItem(item.id, 'details', libItem.description)
    onChangeItem(item.id, 'unitPrice', libItem.price)
    if (libItem.image) onChangeItem(item.id, 'image', libItem.image)
    setSuggestOpen(false)
  }

  const showSuggestions = suggestOpen && suggestions.length > 0 && inputFocused

  return (
    <div className={`qic-card ${highlighted ? 'is-highlighted' : ''}`}>
      <div className="qic-card-row">
        <div className="qic-name-wrap">
          <input
            className="qic-name"
            placeholder="输入硬件名称…"
            value={item.name}
            onFocus={() => {
              setInputFocused(true)
              if (item.name.length >= 2) setSuggestOpen(true)
            }}
            onBlur={() =>
              setTimeout(() => {
                setInputFocused(false)
                setSuggestOpen(false)
              }, 150)
            }
            onChange={(e) => {
              onChangeItem(item.id, 'name', e.target.value)
              if (e.target.value.length >= 2) setSuggestOpen(true)
              else setSuggestOpen(false)
            }}
          />
          {showSuggestions && (
            <ul className="qic-suggest-list">
              {suggestions.map((lib) => (
                <li
                  key={lib.id}
                  className="qic-suggest-item"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handleApplySuggestion(lib)}
                >
                  <span className="qic-suggest-name">{lib.description}</span>
                  <span className="qic-suggest-price">{formatMoney(lib.price)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="qic-card-row qic-card-meta">
        <div className="qic-field">
          <label>数量</label>
          <input
            type="number"
            min="1"
            step="1"
            value={item.quantity}
            className="qic-qty"
            onChange={(e) => onChangeItem(item.id, 'quantity', Number(e.target.value))}
          />
        </div>
        <div className="qic-field">
          <label>单价</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={item.unitPrice}
            className="qic-price"
            onChange={(e) => onChangeItem(item.id, 'unitPrice', Number(e.target.value))}
          />
        </div>
        <div className="qic-subtotal-badge">
          <span className="qic-subtotal">{formatMoney(subtotal)}</span>
        </div>
        <div className="qic-actions">
          <button
            className="qic-btn"
            type="button"
            disabled={index === 0}
            onClick={onMoveUp}
            title="上移"
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M6 2L2 7h8z" fill="currentColor" />
            </svg>
          </button>
          <button
            className="qic-btn"
            type="button"
            disabled={index === total - 1}
            onClick={onMoveDown}
            title="下移"
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M6 10L10 5H2z" fill="currentColor" />
            </svg>
          </button>
          <button className="qic-btn qic-btn-del" type="button" onClick={onDelete} title="删除">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
