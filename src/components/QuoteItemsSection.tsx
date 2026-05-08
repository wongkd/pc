import type { QuoteItem } from '../types/quote'
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

interface QuoteItemsSectionProps {
  title?: string
  items: QuoteItem[]
  highlightedItemId?: string | null
  onAddItem: () => void
  onDuplicateItem: (id: string) => void
  onDeleteItem: (id: string) => void
  onMoveItemUp: (id: string) => void
  onMoveItemDown: (id: string) => void
  onChangeItem: (id: string, field: keyof QuoteItem, value: string | number) => void
}

export function QuoteItemsSection({
  title,
  items,
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
              <div
                className={`hardware-card quote-item-card ${highlightedItemId === item.id ? 'is-highlighted' : ''}`}
                key={item.id}
              >
                <div className="item-card-head">
                  <div className="item-card-title">
                    <strong>{item.name || item.category || '其他'}</strong>
                  </div>
                  <div className="quote-item-actions">
                    <button
                      className="btn ghost small"
                      type="button"
                      onClick={() => onMoveItemUp(item.id)}
                      disabled={index === 0}
                    >
                      上移
                    </button>
                    <button
                      className="btn ghost small"
                      type="button"
                      onClick={() => onMoveItemDown(item.id)}
                      disabled={index === items.length - 1}
                    >
                      下移
                    </button>
                    <button
                      className="btn secondary small"
                      type="button"
                      onClick={() => onDeleteItem(item.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>

                <div className="hardware-grid">
                  <div className="field">
                    <label>分类</label>
                    <select
                      value={normalizedCategory}
                      onChange={(event) => onChangeItem(item.id, 'category', event.target.value)}
                    >
                      {CATEGORY_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>硬件名称</label>
                    <input
                      value={item.name}
                      onChange={(event) => onChangeItem(item.id, 'name', event.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>规格说明</label>
                    <input
                      value={item.details}
                      onChange={(event) => onChangeItem(item.id, 'details', event.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>数量</label>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={item.quantity}
                      onChange={(event) =>
                        onChangeItem(item.id, 'quantity', Number(event.target.value))
                      }
                    />
                  </div>
                </div>

                <div className="hardware-grid hardware-grid-bottom">
                  <div className="field">
                    <label>单价</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={item.unitPrice}
                      onChange={(event) =>
                        onChangeItem(item.id, 'unitPrice', Number(event.target.value))
                      }
                    />
                  </div>
                  <div className="field">
                    <label>图片地址</label>
                    <input
                      value={item.image ?? ''}
                      placeholder="https://..."
                      onChange={(event) => onChangeItem(item.id, 'image', event.target.value)}
                    />
                  </div>
                  <div className="field quote-item-subtotal">
                    <label>当前小计</label>
                    <div className="quote-item-subtotal-value">{formatMoney(subtotal)}</div>
                  </div>
                </div>
              </div>
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
