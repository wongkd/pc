import { forwardRef } from 'react'
import type { BrandInfo, Orientation, QuoteItem, QuoteMeta } from '../types/quote'
import { formatDisplayDate } from '../utils/date'
import { formatMoney } from '../utils/money'

interface QuotePreviewProps {
  brand: BrandInfo
  meta: QuoteMeta
  notes: string
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

export const QuotePreview = forwardRef<HTMLDivElement, QuotePreviewProps>(
  ({ brand, meta, notes, items, orientation }, ref) => {
    const visibleItems = items.filter((item) => !isBlankQuoteItem(item))

    const termRows = [
      [
        {
          title: '付款方式',
          content: '支持对公转账、微信转账或现款结算，具体以下单确认为准。',
        },
        {
          title: '售后说明',
          content: '整机安装调试后交付，提供硬件质保支持，故障问题可协助远程排查。',
        },
      ],
      [
        {
          title: '质保政策',
          content: '以收货日为准计算质保时长，整机一年质保，续保费用为整机费用 5% 每年。',
        },
        {
          title: '备注条款',
          content: notes || '暂无补充备注。',
        },
      ],
    ]

    return (
      <section className="panel quote-sheet">
        <div className="preview-frame">
          <div className="preview-frame-head">
            <div>
              <span className="eyebrow export-exclude" data-export-exclude="true">
                预览
              </span>
              <h2>客户报价单</h2>
            </div>
            <span className="preview-orientation export-exclude" data-export-exclude="true">
              {orientation === 'portrait' ? '竖版' : '横版'}
            </span>
          </div>

          <div className={`quote-page quote-page-document ${orientation}`} ref={ref} tabIndex={-1}>
            <div className="quote-content quote-document-content">
              <header className="quote-header quote-header-compact quote-print-header">
                <div className="brand-block brand-block-compact">
                  <div className="logo-box logo-box-brand">
                    {brand.logoDataUrl ? (
                      <img className="quote-brand-logo-image" src={brand.logoDataUrl} alt="公司标识" />
                    ) : (
                      <div className="logo-fallback">LOGO</div>
                    )}
                  </div>
                  <p className="quote-brand-slogan">
                    {brand.slogan || '专业工作站与电脑配置报价服务'}
                  </p>
                </div>

                <div className="preview-meta-grid preview-meta-grid-compact screen-only">
                  <div className="meta-item meta-mini">
                    <div className="label">报价编号</div>
                    <div className="value">{meta.quoteNo || '未填写'}</div>
                  </div>
                  <div className="meta-item meta-mini">
                    <div className="label">报价日期</div>
                    <div className="value">{formatDisplayDate(meta.quoteDate)}</div>
                  </div>
                  <div className="meta-item meta-mini">
                    <div className="label">客户名称</div>
                    <div className="value">{meta.customerName || '未填写'}</div>
                  </div>
                  <div className="meta-item meta-mini">
                    <div className="label">联系人 / 电话</div>
                    <div className="value">
                      {(brand.contactPerson || '未填写') + ' / ' + (brand.contactPhone || '未填写')}
                    </div>
                  </div>
                </div>

                <div className="quote-print-meta-shell print-only">
                  <table className="quote-print-meta-table">
                    <tbody>
                      <tr>
                        <td>
                          <div className="label">报价编号</div>
                          <div className="value">{meta.quoteNo || '未填写'}</div>
                        </td>
                        <td>
                          <div className="label">报价日期</div>
                          <div className="value">{formatDisplayDate(meta.quoteDate)}</div>
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <div className="label">客户名称</div>
                          <div className="value">{meta.customerName || '未填写'}</div>
                        </td>
                        <td>
                          <div className="label">联系人 / 电话</div>
                          <div className="value">
                            {(brand.contactPerson || '未填写') + ' / ' + (brand.contactPhone || '未填写')}
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </header>

              <section className="quote-hero quote-hero-compact quote-print-title">
                <div>
                  <h3>{meta.projectTitle || '待填写项目名称'}</h3>
                  <p>以下报价内容适用于客户确认、商务沟通与正式发送，请以最终下单确认为准。</p>
                </div>
              </section>

              <section className="quote-table-wrap screen-only">
                <table className="quote-table">
                  <thead>
                    <tr>
                      <th style={{ width: '16%' }}>分类</th>
                      <th>型号配置</th>
                      <th className="col-right" style={{ width: '10%' }}>
                        数量
                      </th>
                      <th className="col-right" style={{ width: '15%' }}>
                        单价
                      </th>
                      <th className="col-right" style={{ width: '15%' }}>
                        小计
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleItems.length === 0 ? (
                      <tr>
                        <td className="empty-cell" colSpan={5}>
                          暂无报价项目，请先在左侧编辑区补充内容。
                        </td>
                      </tr>
                    ) : (
                      visibleItems.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <span className="category-tag">{item.category || '其他'}</span>
                          </td>
                          <td>
                            <div className="quote-item-name">{item.name || item.category || '其他'}</div>
                            {item.details ? <div className="quote-item-details">{item.details}</div> : null}
                          </td>
                          <td className="col-right">{item.quantity}</td>
                          <td className="col-right">{formatMoney(item.unitPrice)}</td>
                          <td className="col-right">{formatMoney(item.quantity * item.unitPrice)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </section>

              <section className="quote-print-table-shell print-only">
                <table className="quote-print-table-grid">
                  <thead>
                    <tr>
                      <th style={{ width: '16%' }}>分类</th>
                      <th>型号配置</th>
                      <th className="col-right" style={{ width: '10%' }}>
                        数量
                      </th>
                      <th className="col-right" style={{ width: '15%' }}>
                        单价
                      </th>
                      <th className="col-right" style={{ width: '15%' }}>
                        小计
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleItems.length === 0 ? (
                      <tr>
                        <td colSpan={5}>暂无报价项目，请先在左侧编辑区补充内容。</td>
                      </tr>
                    ) : (
                      visibleItems.map((item) => (
                        <tr key={item.id}>
                          <td>{item.category || '其他'}</td>
                          <td>
                            <div className="quote-item-name">{item.name || item.category || '其他'}</div>
                            {item.details ? <div className="quote-item-details">{item.details}</div> : null}
                          </td>
                          <td className="col-right">{item.quantity}</td>
                          <td className="col-right">{formatMoney(item.unitPrice)}</td>
                          <td className="col-right">{formatMoney(item.quantity * item.unitPrice)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </section>

              <section className="quote-items-mobile" aria-label="移动端报价项目卡片">
                {visibleItems.length === 0 ? (
                  <div className="empty-state">暂无报价项目，请先在左侧编辑区补充内容。</div>
                ) : (
                  visibleItems.map((item, index) => (
                    <article className="mobile-item-card" key={item.id}>
                      <div className="mobile-item-head">
                        <span className="category-tag">{item.category || '其他'}</span>
                        <span className="mobile-item-index">#{String(index + 1).padStart(2, '0')}</span>
                      </div>
                      <h4>{item.name || item.category || '其他'}</h4>
                      {item.details ? <p>{item.details}</p> : null}
                      <div className="mobile-item-stats">
                        <div>
                          <span>数量</span>
                          <strong>{item.quantity}</strong>
                        </div>
                        <div>
                          <span>单价</span>
                          <strong>{formatMoney(item.unitPrice)}</strong>
                        </div>
                        <div>
                          <span>小计</span>
                          <strong>{formatMoney(item.quantity * item.unitPrice)}</strong>
                        </div>
                      </div>
                    </article>
                  ))
                )}
              </section>

              <section className="terms-grid terms-grid-compact quote-print-terms screen-only">
                {termRows.flat().map((item) => (
                  <div className="info-card term-card term-card-compact" key={item.title}>
                    <h4>{item.title}</h4>
                    <div className="notes">{item.content}</div>
                  </div>
                ))}
              </section>

              <section className="quote-print-terms-shell print-only">
                <table className="quote-print-terms-table">
                  <tbody>
                    {termRows.map((row, rowIndex) => (
                      <tr key={`term-row-${rowIndex}`}>
                        {row.map((item) => (
                          <td key={item.title}>
                            <h4>{item.title}</h4>
                            <div className="notes">{item.content}</div>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </div>
          </div>
        </div>
      </section>
    )
  },
)

QuotePreview.displayName = 'QuotePreview'
