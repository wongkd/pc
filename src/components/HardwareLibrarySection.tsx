import type { ChangeEvent } from 'react'
import type { HardwareLibraryItem } from '../types/quote'

interface HardwareLibrarySectionProps {
  items: HardwareLibraryItem[]
  categories: string[]
  search: string
  categoryFilter: string
  onSearchChange: (value: string) => void
  onCategoryFilterChange: (value: string) => void
  onAddItem: () => void
  onUpdateItem: (id: string, field: keyof HardwareLibraryItem, value: string | number) => void
  onDeleteItem: (id: string) => void
  onAddToQuote: (item: HardwareLibraryItem) => void
  onImportJson: (file: File) => Promise<void>
  onExportJson: () => void
  onImportExcel: (file: File) => Promise<void>
  onExportExcel: () => void
}

async function handleFile(
  event: ChangeEvent<HTMLInputElement>,
  onPick: (file: File) => Promise<void>,
) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (file) {
    await onPick(file)
  }
}

export function HardwareLibrarySection(props: HardwareLibrarySectionProps) {
  const {
    items,
    categories,
    search,
    categoryFilter,
    onSearchChange,
    onCategoryFilterChange,
    onAddItem,
    onUpdateItem,
    onDeleteItem,
    onAddToQuote,
    onImportJson,
    onExportJson,
    onImportExcel,
    onExportExcel,
  } = props

  return (
    <section className="panel-section panel-section-library">
      <div className="section-head">
        <div className="section-head-copy">
          <span className="eyebrow">低频工具</span>
          <h2>硬件库管理</h2>
          <p>维护常用硬件信息，支持搜索筛选，并可补充商品图片地址。</p>
        </div>
        <button className="btn ghost small" type="button" onClick={onAddItem}>
          新增硬件
        </button>
      </div>

      <div className="toolbar toolbar-wide hardware-toolbar">
        <input
          placeholder="按分类、型号或说明搜索"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        <select
          value={categoryFilter}
          onChange={(event) => onCategoryFilterChange(event.target.value)}
        >
          {categories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>
        <button className="btn secondary small" type="button" onClick={onExportJson}>
          导出 JSON
        </button>
        <label className="btn secondary small file-btn">
          导入 JSON
          <input
            type="file"
            accept=".json,application/json"
            onChange={(event) => void handleFile(event, onImportJson)}
          />
        </label>
        <button className="btn secondary small" type="button" onClick={onExportExcel}>
          导出 Excel
        </button>
        <label className="btn secondary small file-btn">
          导入 Excel
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => void handleFile(event, onImportExcel)}
          />
        </label>
      </div>

      <div className="stack">
        {items.length === 0 ? (
          <div className="empty-state">当前硬件库为空，先新增一条硬件数据。</div>
        ) : (
          items.map((item) => (
            <div className="hardware-card hardware-card-library" key={item.id}>
              <div className="hardware-grid">
                <div className="field">
                  <label>分类</label>
                  <input
                    placeholder="分类"
                    value={item.category}
                    onChange={(event) => onUpdateItem(item.id, 'category', event.target.value)}
                  />
                </div>
                <div className="field">
                  <label>型号或说明</label>
                  <input
                    placeholder="型号或说明"
                    value={item.description}
                    onChange={(event) => onUpdateItem(item.id, 'description', event.target.value)}
                  />
                </div>
                <div className="field">
                  <label>价格</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="价格"
                    value={item.price}
                    onChange={(event) => onUpdateItem(item.id, 'price', Number(event.target.value))}
                  />
                </div>
                <div className="field">
                  <label>图片地址</label>
                  <input
                    placeholder="https://..."
                    value={item.image ?? ''}
                    onChange={(event) => onUpdateItem(item.id, 'image', event.target.value)}
                  />
                </div>
              </div>
              <div className="hardware-grid hardware-grid-bottom hardware-grid-library-bottom">
                <div className="field">
                  <label>图片预览</label>
                  <div className="library-thumb">
                    {item.image ? (
                      <img src={item.image} alt={item.description || '硬件图片'} />
                    ) : (
                      <span>暂无图片</span>
                    )}
                  </div>
                </div>
                <div className="field">
                  <label>&nbsp;</label>
                  <button className="btn ghost small" type="button" onClick={() => onAddToQuote(item)}>
                    加入报价
                  </button>
                </div>
                <div className="field">
                  <label>&nbsp;</label>
                  <button
                    className="btn secondary small"
                    type="button"
                    onClick={() => onDeleteItem(item.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
