import type { BrandInfo } from '../types/quote'

interface BrandSectionProps {
  brand: BrandInfo
  onChange: (field: keyof BrandInfo, value: string) => void
  onLogoUpload: (file: File | null) => void
}

export function BrandSection({ brand, onChange, onLogoUpload }: BrandSectionProps) {
  return (
    <section className="panel-section panel-section-secondary">
      <div className="section-head">
        <div className="section-head-copy">
          <h2>品牌信息</h2>
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="companyName">品牌名称</label>
          <input
            id="companyName"
            value={brand.companyName}
            onChange={(event) => onChange('companyName', event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="slogan">品牌标语</label>
          <input
            id="slogan"
            value={brand.slogan}
            onChange={(event) => onChange('slogan', event.target.value)}
          />
        </div>
        <div className="field full">
          <label htmlFor="logoUpload">上传品牌标识</label>
          <input
            id="logoUpload"
            type="file"
            accept="image/*"
            onChange={(event) => onLogoUpload(event.target.files?.[0] ?? null)}
          />
        </div>
      </div>
    </section>
  )
}
