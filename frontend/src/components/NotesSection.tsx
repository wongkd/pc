import type { QuoteNotes } from '../types/quote'

interface NotesSectionProps {
  notes: QuoteNotes
  onChange: (value: QuoteNotes) => void
}

export function NotesSection({ notes, onChange }: NotesSectionProps) {
  const handleChange = (field: keyof QuoteNotes, value: string) => {
    onChange({ ...notes, [field]: value })
  }

  return (
    <details className="info-collapse notes-collapse">
      <summary>条款与备注</summary>
      <div className="notes-grid">
        <div className="field">
          <label className="notes-label">付款方式</label>
          <textarea
            value={notes.payment}
            onChange={(e) => handleChange('payment', e.target.value)}
            placeholder="如：支持对公转账、微信转账或现款结算…"
            rows={3}
          />
        </div>
        <div className="field">
          <label className="notes-label">售后说明</label>
          <textarea
            value={notes.afterSales}
            onChange={(e) => handleChange('afterSales', e.target.value)}
            placeholder="如：整机安装调试后交付，提供硬件质保支持…"
            rows={3}
          />
        </div>
        <div className="field">
          <label className="notes-label">质保政策</label>
          <textarea
            value={notes.warranty}
            onChange={(e) => handleChange('warranty', e.target.value)}
            placeholder="如：以收货日为准计算质保，整机一年…"
            rows={3}
          />
        </div>
        <div className="field">
          <label className="notes-label">备注条款</label>
          <textarea
            value={notes.remarks}
            onChange={(e) => handleChange('remarks', e.target.value)}
            placeholder="如：报价含整机装配、基础驱动安装…"
            rows={3}
          />
        </div>
      </div>
    </details>
  )
}
