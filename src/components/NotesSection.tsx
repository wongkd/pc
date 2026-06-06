import type { TermsData } from '../types/quote'

interface NotesSectionProps {
  notes: TermsData
  onChange: (value: TermsData) => void
}

type TermKey = keyof TermsData

function termField(label: string, key: TermKey, data: TermsData, onChange: NotesSectionProps['onChange']) {
  return (
    <div className="field" key={key}>
      <textarea
        id={`term-${key}`}
        value={data[key]}
        onChange={(e) => onChange({ ...data, [key]: e.target.value })}
        placeholder={label + '…'}
        rows={3}
      />
    </div>
  )
}

export function NotesSection({ notes, onChange }: NotesSectionProps) {
  return (
    <details className="info-collapse notes-collapse">
      <summary>条款与备注</summary>
      <div style={{ padding: '8px 4px 4px' }}>
        {/* 2×2 网格 */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          {termField('付款方式', 'payment', notes, onChange)}
          {termField('售后说明', 'afterSales', notes, onChange)}
          {termField('质保政策', 'warranty', notes, onChange)}
          {termField('备注条款', 'remarks', notes, onChange)}
        </div>
      </div>
    </details>
  )
}
