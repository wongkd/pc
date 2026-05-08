import type { QuoteMeta } from '../types/quote'

interface CustomerInfoSectionProps {
  meta: QuoteMeta
  onChange: (field: keyof QuoteMeta, value: string) => void
}

export function CustomerInfoSection({ meta, onChange }: CustomerInfoSectionProps) {
  return (
    <section className="panel-section panel-section-secondary">
      <div className="section-head">
        <div className="section-head-copy">
          <h2>客户信息</h2>
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="customerName">客户名称</label>
          <input
            id="customerName"
            value={meta.customerName}
            onChange={(event) => onChange('customerName', event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="contactName">客户联系人</label>
          <input
            id="contactName"
            value={meta.contactName}
            onChange={(event) => onChange('contactName', event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="contactPhone">客户电话</label>
          <input
            id="contactPhone"
            value={meta.contactPhone}
            onChange={(event) => onChange('contactPhone', event.target.value)}
          />
        </div>
      </div>
    </section>
  )
}
