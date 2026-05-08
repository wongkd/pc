import type { BrandInfo } from '../types/quote'

interface ContactSectionProps {
  brand: BrandInfo
  onChange: (field: keyof BrandInfo, value: string) => void
}

export function ContactSection({ brand, onChange }: ContactSectionProps) {
  return (
    <section className="panel-section panel-section-secondary">
      <div className="section-head">
        <div className="section-head-copy">
          <h2>商家联系方式</h2>
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="contactPerson">联系人</label>
          <input
            id="contactPerson"
            value={brand.contactPerson}
            onChange={(event) => onChange('contactPerson', event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="contactPhoneBrand">电话</label>
          <input
            id="contactPhoneBrand"
            value={brand.contactPhone}
            onChange={(event) => onChange('contactPhone', event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="contactWechat">微信</label>
          <input
            id="contactWechat"
            value={brand.contactWechat}
            onChange={(event) => onChange('contactWechat', event.target.value)}
          />
        </div>
        <div className="field full">
          <label htmlFor="contactAddress">地址</label>
          <input
            id="contactAddress"
            value={brand.contactAddress}
            onChange={(event) => onChange('contactAddress', event.target.value)}
          />
        </div>
      </div>
    </section>
  )
}
