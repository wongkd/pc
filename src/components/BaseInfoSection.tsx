import { useState } from 'react'
import type { BrandInfo, MerchantTemplate, QuoteMeta } from '../types/quote'
import { BrandSection } from './BrandSection'
import { ContactSection } from './ContactSection'

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
    <>
      {/* 模板模块：独立卡片 */}
      <section className="panel-section">
        <div className="section-head">
          <div className="section-head-copy">
            <h2>商家模板</h2>
            <span className="section-head-note">快速套用品牌信息</span>
          </div>
        </div>
        <div className="info-compact-row" style={{ gap: 8 }}>
          <input value={templateName} placeholder="模板名称…" onChange={(e) => setTemplateName(e.target.value)} style={{ flex: 1 }} />
          <button className="btn ghost small" type="button" onClick={handleSave}>保存</button>
        </div>
        {templates.length > 0 && (
          <div className="info-compact-list" style={{ marginTop: 8 }}>
            {templates.map((t) => (
              <div className="info-compact-item" key={t.id}>
                <span className="info-compact-name">{t.name}</span>
                <button className="btn ghost small" type="button" onClick={() => onApplyTemplate(t.id)}>套用</button>
                <button className="btn secondary small" type="button" onClick={() => onDeleteTemplate(t.id)}>删除</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 客户＆报价信息：3列横向网格 */}
      <section className="panel-section">
        <div className="section-head">
          <div className="section-head-copy">
            <h2>客户与报价信息</h2>
          </div>
        </div>
        <div className="form-grid-3col">
          <div className="field">
            <label htmlFor="customerName">客户名称</label>
            <input
              id="customerName"
              value={meta.customerName}
              onChange={(event) => onMetaChange('customerName', event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="contactName">联系人</label>
            <input
              id="contactName"
              value={meta.contactName}
              onChange={(event) => onMetaChange('contactName', event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="contactPhone">客户电话</label>
            <input
              id="contactPhone"
              value={meta.contactPhone}
              onChange={(event) => onMetaChange('contactPhone', event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="quoteNo">报价单号</label>
            <input
              id="quoteNo"
              value={meta.quoteNo}
              onChange={(event) => onMetaChange('quoteNo', event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="quoteDate">报价日期</label>
            <input
              id="quoteDate"
              type="date"
              value={meta.quoteDate}
              onChange={(event) => onMetaChange('quoteDate', event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="projectTitle">项目标题</label>
            <input
              id="projectTitle"
              value={meta.projectTitle}
              onChange={(event) => onMetaChange('projectTitle', event.target.value)}
            />
          </div>
        </div>
      </section>

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
    </>
  )
}
