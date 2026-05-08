import type { QuoteMeta } from '../types/quote'

interface QuoteInfoSectionProps {
  meta: QuoteMeta
  onChange: (field: keyof QuoteMeta, value: string) => void
}

export function QuoteInfoSection({ meta, onChange }: QuoteInfoSectionProps) {
  return (
    <section className="panel-section panel-section-secondary">
      <div className="section-head">
        <div className="section-head-copy">
          <h2>报价信息</h2>
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="quoteNo">报价单号</label>
          <input
            id="quoteNo"
            value={meta.quoteNo}
            onChange={(event) => onChange('quoteNo', event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="quoteDate">报价日期</label>
          <input
            id="quoteDate"
            type="date"
            value={meta.quoteDate}
            onChange={(event) => onChange('quoteDate', event.target.value)}
          />
        </div>
        <div className="field full">
          <label htmlFor="projectTitle">项目标题</label>
          <input
            id="projectTitle"
            value={meta.projectTitle}
            onChange={(event) => onChange('projectTitle', event.target.value)}
          />
        </div>
      </div>
    </section>
  )
}
