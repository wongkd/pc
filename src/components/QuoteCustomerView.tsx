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
  return !item.name.trim() && !item.details.trim() && item.unitPrice === 0 && !(item.image ?? '').trim()
}

const platformIcons: Record<string, string> = {
  京东: 'JD', 天猫: 'TM', 拼多多: 'PDD', 抖音: 'DY', 快手: 'KS', '1688': '88',
}

export function QuoteCustomerView({ brand, meta, items, orientation }: QuoteCustomerViewProps) {
  const visibleItems = items.filter((item) => !isBlankQuoteItem(item))
  const total = sumQuoteItems(visibleItems)

  return (
    <div className="cv-dark-bg">
      {/* 品牌头 */}
      <div className="cv-dark-header">
        <div className="cv-dark-logo">
          {brand.logoDataUrl ? <img src={brand.logoDataUrl} alt="" /> : <span className="cv-dark-logo-text">PC</span>}
        </div>
        <div>
          <div className="cv-dark-shop">{brand.companyName || '未填写店铺'}</div>
          <div className="cv-dark-slogan">{brand.slogan || '专业电脑配置报价'}</div>
        </div>
      </div>

      {/* 标题区 */}
      <div className="cv-dark-title">
        <div className="cv-dark-project">{meta.projectTitle || '报价方案'}</div>
        <div className="cv-dark-meta">
          {meta.quoteNo && <span>#{meta.quoteNo}</span>}
          {meta.quoteDate && <span>{formatDisplayDate(meta.quoteDate)}</span>}
          {meta.customerName && <span>{meta.customerName}</span>}
        </div>
      </div>

      {/* 商品列表 */}
      <div className="cv-dark-list">
        {visibleItems.length === 0 ? (
          <div className="cv-dark-empty">暂无商品清单</div>
        ) : (
          visibleItems.map((item) => (
            <div className="cv-dark-item" key={item.id}>
              <div className="cv-dark-thumb">
                {item.image ? <img src={item.image} alt="" /> : <span className="cv-dark-thumb-place">{item.category?.[0] || '?'}</span>}
              </div>
              <div className="cv-dark-info">
                <div className="cv-dark-name">{item.name || item.category}</div>
                {item.details ? <div className="cv-dark-specs">{item.details}</div> : null}
                <div className="cv-dark-meta-row">
                  {item.category && <span className="cv-dark-tag">{item.category}</span>}
                  {item.sourcePlatform && <span className="cv-dark-platform">{platformIcons[item.sourcePlatform] || item.sourcePlatform}</span>}
                </div>
              </div>
              <div className="cv-dark-price-col">
                <div className="cv-dark-price">{formatMoney(item.quantity * item.unitPrice)}</div>
                {item.quantity > 1 && (
                  <div className="cv-dark-unit">{formatMoney(item.unitPrice)}×{item.quantity}</div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 悬浮总价栏 */}
      <div className="cv-dark-footer">
        <div className="cv-dark-footer-inner">
          <div className="cv-dark-total-label">
            <span>合计</span>
            <span className="cv-dark-total-count">{visibleItems.length}件硬件</span>
          </div>
          <div className="cv-dark-total-price">{formatMoney(total)}</div>
        </div>
      </div>
    </div>
  )
}
