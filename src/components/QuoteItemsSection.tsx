import { useMemo, useState } from 'react'
import type { HardwareLibraryItem, QuoteItem } from '../types/quote'
import { formatMoney } from '../utils/money'

const CATEGORY_OPTIONS = [
  'CPU',
  '主板',
  '内存',
  '显卡',
  '硬盘',
  '电源',
  '散热器',
  '机箱',
  '风扇',
  '显示器',
  '其他',
] as const

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
  onAddItem: () => void
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
          <button className="btn primary small" type="button" onClick={onAddItem}>
            新增项目
          </button>
        </div>
      </div>

      <div className="stack">
        {items.length === 0 ? (
          <div className="empty-state">当前还没有报价项目，可手动新增或从硬件库加入。</div>
        ) : (
          items.map((item, index) => {
            const subtotal = item.quantity * item.unitPrice
            const normalizedCategory = CATEGORY_OPTIONS.includes(
              item.category as (typeof CATEGORY_OPTIONS)[number],
            )
              ? item.category
              : '其他'

            return (
              <QuoteItemCard
                key={item.id}
                item={item}
                index={index}
                total={items.length}
                normalizedCategory={normalizedCategory}
                subtotal={subtotal}
                highlighted={highlightedItemId === item.id}
                libraryItems={libraryItems}
                onChangeItem={onChangeItem}
                onMoveUp={() => onMoveItemUp(item.id)}
                onMoveDown={() => onMoveItemDown(item.id)}
                onDelete={() => onDeleteItem(item.id)}
              />
            )
          })
        )}
      </div>

      <div className="quote-items-summary">
        <div className="quote-items-summary-row total">
          <span>报价合计</span>
          <strong>{formatMoney(totalAmount)}</strong>
        </div>
      </div>
    </section>
  )
}

/* ──────────── Compact Card with Autocomplete ──────────── */

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
  normalizedCategory,
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

  const showSuggestions =
    suggestOpen && suggestions.length > 0 && inputFocused

  return (
    <div className={`quote-item-compact ${highlighted ? 'is-highlighted' : ''}`}>
      {/* row 1: category tag + name + delete */}
      <div className="qic-row qic-row-top">
        <div className="qic-left">
          <select
            className="qic-category"
            value={normalizedCategory}
            onChange={(e) => onChangeItem(item.id, 'category', e.target.value)}
          >
            {CATEGORY_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>

          <div className="qic-name-wrap">
            <input
              className="qic-name"
              placeholder="输入硬件名称…"
              value={item.name}
              onFocus={() => {
                setInputFocused(true)
                if (item.name.length >= 2) setSuggestOpen(true)
              }}
              onBlur={() => setTimeout(() => { setInputFocused(false); setSuggestOpen(false) }, 150)}
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

        <button className="qic-delete" type="button" onClick={onDelete} title="删除">
          ×
        </button>
      </div>

      {/* row 2: quantity / unit price / subtotal */}
      <div className="qic-row qic-row-bottom">
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
        <div className="qic-field qic-field-subtotal">
          <label>小计</label>
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
            ↑
          </button>
          <button
            className="qic-btn"
            type="button"
            disabled={index === total - 1}
            onClick={onMoveDown}
            title="下移"
          >
            ↓
          </button>
        </div>
      </div>
    </div>
  )
}
