import { useState } from 'react'
import type { BrandInfo, MerchantTemplate, QuoteMeta } from '../types/quote'
import { BrandSection } from './BrandSection'
import { ContactSection } from './ContactSection'
import { CustomerInfoSection } from './CustomerInfoSection'
import { QuoteInfoSection } from './QuoteInfoSection'

interface BaseInfoSectionProps {
  brand: BrandInfo
  meta: QuoteMeta
  templates: MerchantTemplate[]
  onBrandChange: (field: keyof BrandInfo, value: string) => void
  onMetaChange: (field: keyof QuoteMeta, value: string) => void
  onLogoUpload: (file: File | null) => void
  onSaveTemplate: (name: string) => void
  onApplyTemplate: (id: string) => void
  onDeleteTemplate: (id: string) => void
}

export function BaseInfoSection({
  brand, meta, templates, onBrandChange, onMetaChange,
  onLogoUpload, onSaveTemplate, onApplyTemplate, onDeleteTemplate,
}: BaseInfoSectionProps) {
  const [templateName, setTemplateName] = useState('')

  const handleSave = () => {
    const name = templateName.trim()
    if (!name) { window.alert('请先填写模板名称。'); return }
    onSaveTemplate(name); setTemplateName('')
  }

  return (
    <section className="panel-section panel-section-secondary base-info-compact">
      {/* 三列紧凑卡片 */}
      <div className="info-3col">
        <div className="info-card info-card-sm">
          <div className="info-card-title">商家模板</div>
          <div className="info-compact-row">
            <input value={templateName} placeholder="模板名称…" onChange={(e) => setTemplateName(e.target.value)} />
            <button className="btn ghost small" type="button" onClick={handleSave}>保存</button>
          </div>
          {templates.length > 0 && (
            <div className="info-compact-list">
              {templates.map((t) => (
                <div className="info-compact-item" key={t.id}>
                  <span className="info-compact-name">{t.name}</span>
                  <button className="btn ghost small" type="button" onClick={() => onApplyTemplate(t.id)}>套用</button>
                  <button className="btn secondary small" type="button" onClick={() => onDeleteTemplate(t.id)}>删除</button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="info-card info-card-sm">
          <CustomerInfoSection meta={meta} onChange={onMetaChange} />
        </div>
        <div className="info-card info-card-sm">
          <QuoteInfoSection meta={meta} onChange={onMetaChange} />
        </div>
      </div>

      {/* 品牌与联系方式 折叠 */}
      <details className="info-collapse">
        <summary>品牌与联系方式</summary>
        <div className="info-two-col" style={{ paddingTop: 8, gap: 6 }}>
          <div className="info-card info-card-sm">
            <BrandSection brand={brand} onChange={onBrandChange} onLogoUpload={onLogoUpload} />
          </div>
          <div className="info-card info-card-sm">
            <ContactSection brand={brand} onChange={onBrandChange} />
          </div>
        </div>
      </details>
    </section>
  )
}
