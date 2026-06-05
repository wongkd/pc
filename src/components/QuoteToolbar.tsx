import { useState, useRef, useEffect, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { Orientation, PreviewMode } from '../types/quote'

export type ExportFormat = 'png' | 'markdown' | 'word' | 'html'

interface QuoteToolbarProps {
  previewMode: PreviewMode
  orientation: Orientation
  onPreviewModeChange: (mode: PreviewMode) => void
  onOrientationChange: (orientation: Orientation) => void
  onPrint: () => void
  onExport: (format: ExportFormat) => void
}

const EXPORT_LABELS: Record<ExportFormat, string> = {
  png: 'PNG 图片',
  markdown: 'Markdown',
  word: 'Word 文档',
  html: 'HTML',
}

export function QuoteToolbar({
  previewMode,
  orientation,
  onPreviewModeChange,
  onOrientationChange,
  onPrint,
  onExport,
}: QuoteToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const portalRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      const inButton = menuRef.current?.contains(target)
      const inPortal = portalRef.current?.contains(target)
      if (!inButton && !inPortal) {
        setMenuOpen(false)
      }
    }
    if (menuOpen) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [menuOpen])

  function getMenuPos(): CSSProperties {
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return { visibility: 'hidden' }
    return {
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
    }
  }

  return (
    <section className="quote-toolbar">
      <div className="quote-toolbar-row">
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
            文档版
          </button>
          <button
            className={`segment-option ${previewMode === 'customer' ? 'active' : ''}`}
            type="button"
            onClick={() => onPreviewModeChange('customer')}
          >
            商品清单
          </button>
        </div>

        <div
          className="segmented-control preview-orientation-switch"
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

        <div className="toolbar-spacer" />

        <button className="btn primary btn-toolbar" type="button" onClick={onPrint}>
          打印
        </button>

        <div className="export-dropdown" ref={menuRef}>
          <button
            ref={btnRef}
            className="btn secondary btn-toolbar export-btn"
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
          >
            导出 <span className="export-caret">{menuOpen ? '▲' : '▼'}</span>
          </button>
          {menuOpen &&
            createPortal(
              <div className="export-menu" ref={portalRef} style={getMenuPos()}>
                {(Object.keys(EXPORT_LABELS) as ExportFormat[]).map((fmt) => (
                  <button
                    key={fmt}
                    className="export-menu-item"
                    type="button"
                    onClick={() => {
                      onExport(fmt)
                      setMenuOpen(false)
                    }}
                  >
                    {EXPORT_LABELS[fmt]}
                  </button>
                ))}
              </div>,
              document.body
            )}
        </div>
      </div>
    </section>
  )
}
