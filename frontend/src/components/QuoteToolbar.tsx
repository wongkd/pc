import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Orientation, PreviewMode } from '../types/quote'

interface QuoteToolbarProps {
  previewMode: PreviewMode
  orientation: Orientation
  onPreviewModeChange: (mode: PreviewMode) => void
  onOrientationChange: (orientation: Orientation) => void
  onPrint: () => void
  onExportPng: () => Promise<void>
  onExportPdf: () => Promise<void>
  onExportHtml: () => void
  onConvertToOrder: () => void
  canConvertToOrder: boolean
}

const EXPORT_MENU_ITEMS = [
  {
    id: 'print',
    label: '打印报价单',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M3 5V1h10v4M3 11H1.5A1.5 1.5 0 010 9.5v-4A1.5 1.5 0 011.5 4h13A1.5 1.5 0 0116 5.5v4A1.5 1.5 0 0114.5 11H13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="3" y="9" width="10" height="6" rx="1" stroke="currentColor" strokeWidth="1.3" />
        <path d="M11 6.5h2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'png',
    label: '导出 PNG',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="5.5" cy="5.5" r="1.5" fill="currentColor" />
        <path d="M1 11l4-4 3 3 2-2 5 5v2a1 1 0 01-1 1H2a1 1 0 01-1-1v-4z" fill="currentColor" opacity="0.3" />
        <path d="M1 11l4-4 3 3 2-2 5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'pdf',
    label: '导出 PDF',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M3 1h7l4 4v9a1 1 0 01-1 1H3a1 1 0 01-1-1V2a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M10 1v4h4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <text x="5" y="12" fontSize="6" fontWeight="700" fill="currentColor">PDF</text>
      </svg>
    ),
  },
  {
    id: 'html',
    label: '导出 HTML',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M4 5l-3 3 3 3M12 5l3 3-3 3M9 2l-2 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
] as const

export function QuoteToolbar({
  previewMode,
  orientation,
  onPreviewModeChange,
  onOrientationChange,
  onPrint,
  onExportPng,
  onExportPdf,
  onExportHtml,
  onConvertToOrder,
  canConvertToOrder,
}: QuoteToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Click outside to close
  const handleClickOutside = useCallback((event: MouseEvent) => {
    if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
      setMenuOpen(false)
    }
  }, [])

  useEffect(() => {
    if (menuOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen, handleClickOutside])

  const handleMenuItemClick = useCallback(
    async (id: string) => {
      setMenuOpen(false)
      switch (id) {
        case 'print':
          onPrint()
          break
        case 'png':
          await onExportPng()
          break
        case 'pdf':
          await onExportPdf()
          break
        case 'html':
          onExportHtml()
          break
      }
    },
    [onPrint, onExportPng, onExportPdf, onExportHtml],
  )

  return (
    <section className="quote-toolbar">
      <div className="toolbar-row">
        <div className="toolbar-group">
          <span className="toolbar-label">预览模式</span>
          <div
            className="segmented-control preview-mode-switch"
            style={{ ['--segment-index' as string]: previewMode === 'document' ? 0 : 1 } as CSSProperties}
          >
            <span className="segmented-thumb" aria-hidden="true" />
            <button
              className={`segment-option ${previewMode === 'document' ? 'active' : ''}`}
              type="button"
              onClick={() => onPreviewModeChange('document')}
            >
              文档版预览
            </button>
            <button
              className={`segment-option ${previewMode === 'customer' ? 'active' : ''}`}
              type="button"
              onClick={() => onPreviewModeChange('customer')}
            >
              用户端版
            </button>
          </div>
        </div>

        <div className="toolbar-group toolbar-group-orientation">
          <span className="toolbar-label">页面方向</span>
          <div
            className="segmented-control"
            style={{ ['--segment-index' as string]: orientation === 'portrait' ? 0 : 1 } as CSSProperties}
          >
            <span className="segmented-thumb" aria-hidden="true" />
            <button
              className={`segment-option ${orientation === 'portrait' ? 'active' : ''}`}
              type="button"
              onClick={() => onOrientationChange('portrait')}
            >
              竖版
            </button>
            <button
              className={`segment-option ${orientation === 'landscape' ? 'active' : ''}`}
              type="button"
              onClick={() => onOrientationChange('landscape')}
            >
              横版
            </button>
          </div>
        </div>

        <div className="toolbar-group toolbar-group-export" ref={menuRef}>
          <span className="toolbar-label">订单</span>
          <button className="btn order-convert-button" type="button" disabled={!canConvertToOrder} onClick={onConvertToOrder} title={canConvertToOrder ? '将当前报价快照转为订单' : '请先填写客户名称并至少配置一条明细'}>转为订单</button>
        </div>

        <div className="toolbar-group toolbar-group-export" ref={menuRef}>
          <span className="toolbar-label">导出</span>
          <div className="export-dropdown">
            <button
              className="btn primary export-dropdown-trigger"
              type="button"
              onClick={() => setMenuOpen((prev) => !prev)}
              aria-haspopup="true"
              aria-expanded={menuOpen}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 1v10M4 7l4 4 4-4M1 12v2a1 1 0 001 1h12a1 1 0 001-1v-2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              导出报价单
              <svg
                width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"
                className={`export-chevron ${menuOpen ? 'open' : ''}`}
              >
                <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {menuOpen && (
              <ul className="export-dropdown-menu" role="menu">
                {EXPORT_MENU_ITEMS.map((item) => (
                  <li key={item.id} role="none">
                    <button
                      className="export-dropdown-item"
                      type="button"
                      role="menuitem"
                      onClick={() => void handleMenuItemClick(item.id)}
                    >
                      <span className="export-dropdown-icon">{item.icon}</span>
                      <span>{item.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
