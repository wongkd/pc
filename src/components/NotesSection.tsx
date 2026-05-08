interface NotesSectionProps {
  notes: string
  onChange: (value: string) => void
}

export function NotesSection({ notes, onChange }: NotesSectionProps) {
  return (
    <section className="panel-section panel-section-tertiary">
      <div className="section-head">
        <div className="section-head-copy">
          <span className="eyebrow">补充内容</span>
          <h2>条款与备注</h2>
          <p>填写质保、交付、备注条款及其他需要展示在报价单上的补充说明。</p>
        </div>
      </div>
      <div className="notes-shell">
        <div className="field">
          <label htmlFor="notes">条款与备注内容</label>
          <textarea id="notes" value={notes} onChange={(event) => onChange(event.target.value)} />
        </div>
      </div>
    </section>
  )
}
