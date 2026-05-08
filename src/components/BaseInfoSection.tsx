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
    <section className="panel-section panel-section-secondary base-info-board">
      <div className="section-head">
        <div className="section-head-copy">
          <h2>基础信息</h2>
        </div>
      </div>

      <div className="base-info-groups">
        <section className="base-info-group base-info-group-template">
          <div className="section-head">
            <div className="section-head-copy">
              <h2>商家信息模板</h2>
            </div>
          </div>

          <div className="template-save-row">
            <div className="field">
              <label htmlFor="merchantTemplateName">模板名称</label>
              <input
                id="merchantTemplateName"
                value={templateName}
                placeholder="例如：企稳稳科技默认模板"
                onChange={(event) => setTemplateName(event.target.value)}
              />
            </div>
            <button className="btn secondary" type="button" onClick={handleSave}>
              保存为模板
            </button>
          </div>

          <div className="stack template-list">
            {templates.length === 0 ? (
              <div className="empty-state">当前还没有商家模板，先保存一份常用模板。</div>
            ) : (
              templates.map((template) => (
                <div className="template-card" key={template.id}>
                  <div className="template-card-main">
                    <strong>{template.name}</strong>
                    <p>{template.brand.companyName || '未填写品牌名称'}</p>
                    <span>
                      {template.brand.contactPerson || '未填写联系人'}
                      {template.brand.contactPhone ? ` / ${template.brand.contactPhone}` : ''}
                    </span>
                  </div>
                  <div className="template-card-actions">
                    <button
                      className="btn ghost small"
                      type="button"
                      onClick={() => onApplyTemplate(template.id)}
                    >
                      套用模板
                    </button>
                    <button
                      className="btn secondary small"
                      type="button"
                      onClick={() => onDeleteTemplate(template.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <BrandSection brand={brand} onChange={onBrandChange} onLogoUpload={onLogoUpload} />
        <ContactSection brand={brand} onChange={onBrandChange} />
        <CustomerInfoSection meta={meta} onChange={onMetaChange} />
        <QuoteInfoSection meta={meta} onChange={onMetaChange} />
      </div>
    </section>
  )
}
