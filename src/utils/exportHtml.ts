import type { QuoteDocument, QuoteItem } from '../types/quote'
import type { Orientation } from '../types/quote'
import { formatDisplayDate } from './date'
import { formatMoney } from './money'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderRows(items: QuoteItem[]): string {
  // 过滤空白项目
  const filled = items.filter((item) => item.name.trim() || item.details.trim() || item.unitPrice > 0)
  if (filled.length === 0) {
    return '<tr><td colspan="5" style="padding:28px;text-align:center;color:#64748b;">暂无硬件报价项目</td></tr>'
  }

  return filled
    .map((item) => {
      const subtotal = item.quantity * item.unitPrice
      return `
        <tr>
          <td><span class="tag">${escapeHtml(item.category || '其他')}</span></td>
          <td>
            <div class="item-name">${escapeHtml(item.name || '')}</div>
            ${item.details ? `<div class="item-details">${escapeHtml(item.details)}</div>` : ''}
          </td>
          <td style="text-align:right;">${item.quantity}</td>
          <td style="text-align:right;">${formatMoney(item.unitPrice)}</td>
          <td style="text-align:right;">${formatMoney(subtotal)}</td>
        </tr>
      `
    })
    .join('')
}

export function buildQuoteHtml(document: QuoteDocument, orientation: Orientation = 'portrait'): string {
  const isLandscape = orientation === 'landscape'

  return `<!DOCTYPE html>
  <html lang="zh-CN">
    <head>
      <meta charset="UTF-8" />
      <title>${escapeHtml(document.meta.projectTitle || '电脑报价单')}</title>
      <style>
        /* ===== 页面打印设置 ===== */
        @page {
          size: A4 ${isLandscape ? 'landscape' : 'portrait'};
          margin: 12mm;
        }

        /* ===== 屏幕预览（新窗口） ===== */
        body {
          font-family: "PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;
          margin: 0;
          padding: 24px;
          color: #18222d;
          background: #f5f7fa;
        }
        .sheet {
          max-width: ${isLandscape ? '260mm' : '190mm'};
          margin: 0 auto;
          background: #fff;
          border: 1px solid #e2e8f0;
          border-radius: 16px;
          padding: 24px 28px;
          box-shadow: 0 2px 12px rgba(0,0,0,0.04);
        }

        /* ===== 头部 ===== */
        .header {
          display: grid;
          grid-template-columns: minmax(0,1fr) 260px;
          gap: 10px;
          align-items: start;
          padding-bottom: 10px;
          border-bottom: 1px solid #e2e8f0;
        }
        .brand {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 10px;
          min-height: 56px;
        }
        .logo {
          width: min(100%, 220px);
          max-height: 64px;
          display: flex;
          align-items: center;
          justify-content: flex-start;
        }
        .logo img {
          width: auto;
          height: auto;
          max-width: 100%;
          max-height: 64px;
          display: block;
          object-fit: contain;
          object-position: left center;
        }
        .slogan {
          margin: 0;
          max-width: 160px;
          font-size: 10px;
          color: #64748b;
          line-height: 1.4;
        }
        .meta {
          display: grid;
          grid-template-columns: repeat(2, minmax(0,1fr));
          gap: 4px;
        }
        .meta-card {
          padding: 5px 8px;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          background: #fafbfd;
          min-height: 36px;
        }
        .meta-label {
          color: #94a3b8;
          font-size: 8px;
          letter-spacing: .06em;
          text-transform: uppercase;
          margin-bottom: 2px;
        }
        .meta-value {
          font-size: 9px;
          font-weight: 700;
          line-height: 1.25;
          color: #18222d;
        }

        /* ===== 标题区 ===== */
        .hero {
          padding: 10px 0 8px;
          border-bottom: 1px solid #edf2f7;
        }
        .hero-title {
          margin: 0 0 2px;
          font-size: 22px;
          line-height: 1.15;
        }
        .muted {
          color: #64748b;
          font-size: 10px;
          line-height: 1.5;
          margin: 0;
        }

        /* ===== 表格 ===== */
        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 10px;
        }
        th, td {
          padding: 8px 10px;
          border-bottom: 1px solid #dfe7ef;
          text-align: left;
          vertical-align: middle;
          font-size: 11px;
        }
        th {
          background: #f8fafc;
          color: #7b8794;
          font-size: 9px;
          text-transform: uppercase;
          letter-spacing: .06em;
          padding: 6px 10px;
        }
        .tag {
          display: inline-flex;
          align-items: center;
          padding: 3px 9px;
          border-radius: 999px;
          background: linear-gradient(180deg,#f9fbfd,#eef3f8);
          color: #425466;
          font-size: 10px;
          font-weight: 700;
          border: 1px solid #e2e8f0;
          white-space: nowrap;
        }
        .item-name {
          font-size: 12px;
          font-weight: 700;
          line-height: 1.35;
          color: #12202f;
        }
        .item-details {
          margin-top: 3px;
          font-size: 10px;
          line-height: 1.45;
          color: #7b8794;
        }

        /* ===== 条款 ===== */
        .terms {
          display: grid;
          grid-template-columns: repeat(2, minmax(0,1fr));
          gap: 6px;
          margin-top: 10px;
        }
        .term-card {
          min-height: 72px;
          padding: 7px 10px;
          border-radius: 10px;
          border: 1px solid #edf2f7;
          background: #fcfdfe;
        }
        .term-card h3 {
          margin: 0 0 4px;
          font-size: 11px;
          font-weight: 700;
          color: #334155;
        }
        .term-card div {
          color: #64748b;
          line-height: 1.45;
          white-space: pre-wrap;
          font-size: 10px;
        }

        /* ===== 打印专用 ===== */
        @media print {
          body {
            background: #fff;
            padding: 0;
            margin: 0;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .sheet {
            max-width: none;
            margin: 0;
            border: none;
            border-radius: 0;
            box-shadow: none;
            padding: 0;
          }
          .header { padding-bottom: 8px; }
          table { page-break-inside: auto; }
          tr { page-break-inside: avoid; }
          thead { display: table-header-group; }
          .hero, .terms { page-break-inside: avoid; }
          .terms { page-break-before: auto; margin-top: 8px; }

          /* 如果内容太多，允许条款部分自动分页 */
          @media print and (min-height: 900px) {
            .terms { page-break-inside: avoid; }
          }
        }
      </style>
    </head>
    <body>
      <div class="sheet">
        <div class="header">
          <div class="brand">
            <div class="logo">
              ${
                document.brand.logoDataUrl
                  ? `<img src="${document.brand.logoDataUrl}" alt="公司标识" />`
                  : '<strong>LOGO</strong>'
              }
            </div>
            <p class="slogan">${escapeHtml(document.brand.slogan || '专业工作站与电脑配置报价服务')}</p>
          </div>
          <div class="meta">
            <div class="meta-card"><div class="meta-label">报价编号</div><div class="meta-value">${escapeHtml(document.meta.quoteNo || '')}</div></div>
            <div class="meta-card"><div class="meta-label">报价日期</div><div class="meta-value">${escapeHtml(formatDisplayDate(document.meta.quoteDate))}</div></div>
            <div class="meta-card"><div class="meta-label">客户名称</div><div class="meta-value">${escapeHtml(document.meta.customerName || '')}</div></div>
            <div class="meta-card"><div class="meta-label">联系人 / 电话</div><div class="meta-value">${escapeHtml(document.brand.contactPerson || '')} ${document.brand.contactPerson && document.brand.contactPhone ? '/' : ''} ${escapeHtml(document.brand.contactPhone || '')}</div></div>
          </div>
        </div>

        <div class="hero">
          <h2 class="hero-title">${escapeHtml(document.meta.projectTitle || '')}</h2>
          <p class="muted">以下报价内容适用于客户确认、商务沟通与正式发送，请以最终下单确认为准。</p>
        </div>

        <table>
          <thead>
            <tr>
              <th>分类</th>
              <th>型号配置</th>
              <th style="text-align:right;">数量</th>
              <th style="text-align:right;">单价</th>
              <th style="text-align:right;">小计</th>
            </tr>
          </thead>
          <tbody>${renderRows(document.quoteItems)}</tbody>
        </table>

        <div class="terms">
          <div class="term-card">
            <h3>付款方式</h3>
            <div>${escapeHtml(document.notes.payment || '支持对公转账、微信转账或现款结算，具体以下单确认为准。').replace(/\n/g, '<br />')}</div>
          </div>
          <div class="term-card">
            <h3>售后说明</h3>
            <div>${escapeHtml(document.notes.afterSales || '整机安装调试后交付，提供硬件质保支持，故障问题可协助远程排查。').replace(/\n/g, '<br />')}</div>
          </div>
          <div class="term-card">
            <h3>质保政策</h3>
            <div>${escapeHtml(document.notes.warranty || '以收货日为准计算质保时长，整机一年质保，续保费用为整机费用 5% 每年。').replace(/\n/g, '<br />')}</div>
          </div>
          <div class="term-card">
            <h3>备注条款</h3>
            <div>${escapeHtml(document.notes.remarks || '暂无补充备注。').replace(/\n/g, '<br />')}</div>
          </div>
        </div>
      </div>
    </body>
  </html>`
}
