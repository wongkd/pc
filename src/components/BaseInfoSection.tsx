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
  brand,
  meta,
  templates,
  onBrandChange,
  onMetaChange,
  onLogoUpload,
  onSaveTemplate,
  onApplyTemplate,
  onDeleteTemplate,
}: BaseInfoSectionProps) {
  const [templateName, setTemplateName] = useState('')

  const handleSave = () => {
    const name = templateName.trim()
    if (!name) {
      window.alert('请先填写模板名称。')
      return
    }
    onSaveTemplate(name)
    setTemplateName('')
  }

  return (
    <section className="panel-section panel-section-secondary">
      <div className="info-two-col">
        {/* left: template */}
        <div className="info-card">
          <div className="section-head">
            <h2>商家信息模板</h2>
          </div>
          <div className="template-save-row">
            <div className="field">
              <input
                value={templateName}
                placeholder="模板名称，例如：企稳稳科技默认模板"
                onChange={(event) => setTemplateName(event.target.value)}
              />
            </div>
            <button className="btn secondary small" type="button" onClick={handleSave}>
              保存模板
            </button>
          </div>
          {templates.length > 0 && (
            <div className="stack template-list" style={{ marginTop: 8 }}>
              {templates.map((template) => (
                <div className="template-card" key={template.id}>
                  <div className="template-card-main">
                    <strong>{template.name}</strong>
                    <span>
                      {template.brand.contactPerson || '未填写联系人'}
                      {template.brand.contactPhone ? ` / ${template.brand.contactPhone}` : ''}
                    </span>
                  </div>
                  <div className="template-card-actions">
                    <button className="btn ghost small" type="button" onClick={() => onApplyTemplate(template.id)}>
                      套用
                    </button>
                    <button className="btn secondary small" type="button" onClick={() => onDeleteTemplate(template.id)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {templates.length === 0 && (
            <div className="empty-state" style={{ padding: '14px', marginTop: 8, fontSize: 12 }}>
              暂无模板，填写商家信息后保存一份模板方便复用。
            </div>
          )}
        </div>

        {/* right: customer info */}
        <div className="info-card">
          <CustomerInfoSection meta={meta} onChange={onMetaChange} />
          <QuoteInfoSection meta={meta} onChange={onMetaChange} />
        </div>
      </div>

      {/* collapsible: brand + contact */}
      <details className="info-collapse" style={{ marginTop: 10 }}>
        <summary>品牌与联系方式</summary>
        <div className="info-two-col" style={{ paddingTop: 10 }}>
          <div className="info-card">
            <BrandSection brand={brand} onChange={onBrandChange} onLogoUpload={onLogoUpload} />
          </div>
          <div className="info-card">
            <ContactSection brand={brand} onChange={onBrandChange} />
          </div>
        </div>
      </details>
    </section>
  )
}
