import { useState } from 'react'
import type { BrandInfo, Orientation, QuoteItem, QuoteMeta } from '../types/quote'
import { formatDisplayDate } from '../utils/date'
import { formatMoney, sumQuoteItems } from '../utils/money'

interface QuoteCustomerViewProps {
  brand: BrandInfo
  meta: QuoteMeta
  items: QuoteItem[]
  orientation: Orientation
}

function isBlankQuoteItem(item: QuoteItem) {
  return (
    !item.name.trim() &&
    !item.details.trim() &&
    item.unitPrice === 0 &&
    !(item.image ?? '').trim()
  )
}

function ProductImage({ image, alt }: { image?: string; alt: string }) {
  if (image) {
    return (
      <div className="customer-item-image">
        <img src={image} alt={alt} />
      </div>
    )
  }

  return (
    <div className="customer-item-image customer-item-image-placeholder" aria-hidden="true">
      <span>暂无图片</span>
    </div>
  )
}

export function QuoteCustomerView({ brand, meta, items, orientation }: QuoteCustomerViewProps) {
  const visibleItems = items.filter((item) => !isBlankQuoteItem(item))
  const total = sumQuoteItems(visibleItems)
  const [contactOpen, setContactOpen] = useState(false)

  return (
    <section className="panel customer-view-shell">
      <div className={`customer-view ${orientation}`}>
        <header className="customer-view-header">
          <div className="customer-view-brand">
            <div className="customer-view-logo">
              {brand.logoDataUrl ? <img src={brand.logoDataUrl} alt="店铺标识" /> : <span>LOGO</span>}
            </div>
            <div className="customer-view-brand-copy">
              <strong>{brand.companyName || '未填写店铺名称'}</strong>
              <span>{brand.slogan || '专业工作站与电脑配置报价服务'}</span>
            </div>
          </div>
        </header>

        <section className="customer-view-summary">
          <div className="customer-view-title-row">
            <div>
              <h3>{meta.projectTitle || '待填写方案名称'}</h3>
              <p className="customer-view-title-note">客户配置清单，供确认配置与报价参考。</p>
            </div>
            <span className="customer-view-price">{formatMoney(total)}</span>
          </div>
          <div className="customer-view-meta">
            <span>报价单号：{meta.quoteNo || '未填写'}</span>
            <span>报价日期：{formatDisplayDate(meta.quoteDate)}</span>
            <span>客户名称：{meta.customerName || '未填写'}</span>
          </div>
        </section>

        <section className="customer-view-list">
          {visibleItems.length === 0 ? (
            <div className="empty-state">暂无商品清单，请先补充报价项目内容。</div>
          ) : (
            visibleItems.map((item) => {
              const subtotal = item.quantity * item.unitPrice

              return (
                <article className="customer-item-card" key={item.id}>
                  <ProductImage image={item.image} alt={item.name || item.category || '商品图片'} />
                  <div className="customer-item-body">
                    <div className="customer-item-top">
                      <span className="customer-item-category">{item.category || '其他'}</span>
                      <span className="customer-item-subtotal">{formatMoney(subtotal)}</span>
                    </div>
                    <h4>{item.name || item.category || '其他'}</h4>
                    {item.details ? <p>{item.details}</p> : null}
                    <div className="customer-item-bottom">
                      <div className="customer-item-meta-inline">
                        <span className="customer-item-meta-label">数量</span>
                        <strong>{item.quantity}</strong>
                      </div>
                      <div className="customer-item-meta-inline">
                        <span className="customer-item-meta-label">单价</span>
                        <strong>{formatMoney(item.unitPrice)}</strong>
                      </div>
                      <div className="customer-item-meta-inline">
                        <span className="customer-item-meta-label">小计</span>
                        <strong>{formatMoney(subtotal)}</strong>
                      </div>
                    </div>
                  </div>
                </article>
              )
            })
          )}
        </section>

        <footer className="customer-view-footer">
          <div className={`customer-view-contact-panel ${contactOpen ? 'open' : ''}`}>
            <div className="customer-view-merchant-grid">
              <span>联系人：{brand.contactPerson || '未填写'}</span>
              <span>电话：{brand.contactPhone || '未填写'}</span>
              <span>微信：{brand.contactWechat || '未填写'}</span>
              <span>地址：{brand.contactAddress || '未填写'}</span>
            </div>
          </div>

          <div className="customer-view-footer-bar">
            <div className="customer-view-footer-total">
              <span>合计总价</span>
              <strong>{formatMoney(total)}</strong>
            </div>
            <button
              className="btn primary customer-view-footer-btn"
              type="button"
              onClick={() => setContactOpen((current) => !current)}
            >
              {contactOpen ? '收起联系方式' : '联系商家'}
            </button>
          </div>
        </footer>
      </div>
    </section>
  )
}
