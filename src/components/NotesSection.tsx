interface NotesSectionProps {
  notes: string
  onChange: (value: string) => void
}

export function NotesSection({ notes, onChange }: NotesSectionProps) {
  return (
    <details className="info-collapse notes-collapse">
      <summary>条款与备注</summary>
      <div style={{ padding: '8px 4px 4px' }}>
        <div className="field">
          <textarea id="notes" value={notes} onChange={(event) => onChange(event.target.value)}
            placeholder="质保政策、交付说明、备注条款…" rows={4} />
        </div>
      </div>
    </details>
  )
}
