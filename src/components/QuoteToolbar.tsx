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
}

export function QuoteToolbar({
  previewMode,
  orientation,
  onPreviewModeChange,
  onOrientationChange,
  onPrint,
  onExportPng,
  onExportPdf,
  onExportHtml,
}: QuoteToolbarProps) {
  return (
    <section className="quote-toolbar">
      <div className="quote-toolbar-grid">
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
              用户端商品清单版
            </button>
          </div>
        </div>

        <div className="toolbar-group toolbar-group-compact">
          <span className="toolbar-label">页面方向</span>
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
        </div>
      </div>

      <div className="quote-toolbar-actions">
        <div className="toolbar-action-group">
          <span className="toolbar-label">导出</span>
          <div className="toolbar-action-row">
            <button className="btn primary" type="button" onClick={onPrint}>
              打印报价单
            </button>
            <button className="btn secondary" type="button" onClick={() => void onExportPng()}>
              导出 PNG
            </button>
            <button className="btn secondary" type="button" onClick={() => void onExportPdf()}>
              导出 PDF
            </button>
            <button className="btn ghost" type="button" onClick={onExportHtml}>
              导出 HTML
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
