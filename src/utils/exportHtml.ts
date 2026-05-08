import type { QuoteDocument, QuoteItem } from '../types/quote'
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
  if (items.length === 0) {
    return '<tr><td colspan="5" style="padding:28px;text-align:center;color:#64748b;">暂无硬件报价项目</td></tr>'
  }

  return items
    .map((item) => {
      const subtotal = item.quantity * item.unitPrice
      return `
        <tr>
          <td><span class="tag">${escapeHtml(item.category || '其他')}</span></td>
          <td>
            <div class="item-name">${escapeHtml(item.name || '未填写')}</div>
            <div class="item-details">${escapeHtml(item.details || '未填写')}</div>
          </td>
          <td style="text-align:right;">${item.quantity}</td>
          <td style="text-align:right;">${formatMoney(item.unitPrice)}</td>
          <td style="text-align:right;">${formatMoney(subtotal)}</td>
        </tr>
      `
    })
    .join('')
}

export function buildQuoteHtml(document: QuoteDocument): string {
  return `<!DOCTYPE html>
  <html lang="zh-CN">
    <head>
      <meta charset="UTF-8" />
      <title>${escapeHtml(document.meta.projectTitle || '电脑报价单')}</title>
      <style>
        body { font-family: "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; margin: 0; padding: 32px; color:#18222d; background:#f5f7fa; }
        .sheet { max-width: 1100px; margin: 0 auto; background:#fff; border:1px solid #e2e8f0; border-radius:24px; padding:30px 32px; }
        .header { display:grid; grid-template-columns:minmax(0,1fr) 290px; gap:12px; align-items:start; padding-bottom:12px; border-bottom:1px solid #e2e8f0; }
        .brand { display:flex; flex-direction:column; align-items:flex-start; gap:6px; min-height:64px; }
        .logo { width:min(100%,186px); min-height:36px; max-height:64px; overflow:visible; background:transparent; display:flex; align-items:center; justify-content:flex-start; flex-shrink:0; padding:0; }
        .logo img { width:auto; height:auto; max-width:100%; max-height:100%; display:block; object-fit:contain; object-position:center; }
        .slogan { margin:0; max-width:172px; font-size:11px; color:#64748b; line-height:1.45; }
        .meta { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:5px; }
        .meta-card { padding:7px 9px; border:1px solid #e2e8f0; border-radius:10px; background:#fafbfd; min-height:44px; }
        .meta-label { color:#94a3b8; font-size:9px; letter-spacing:.06em; text-transform:uppercase; margin-bottom:3px; }
        .meta-value { font-size:10px; font-weight:700; line-height:1.3; color:#18222d; }
        .hero { padding:14px 0 12px; border-bottom:1px solid #edf2f7; }
        .hero-title { margin:0 0 4px; font-size:28px; line-height:1.14; }
        .muted { color:#64748b; font-size:12px; line-height:1.6; }
        table { width:100%; border-collapse:collapse; margin-top:16px; }
        th, td { padding:18px 18px; border-bottom:1px solid #dfe7ef; text-align:left; vertical-align:middle; }
        th { background:#f8fafc; color:#7b8794; font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
        .tag { display:inline-flex; align-items:center; padding:6px 11px; border-radius:999px; background:linear-gradient(180deg,#f9fbfd,#eef3f8); color:#425466; font-size:11px; font-weight:700; border:1px solid #e2e8f0; }
        .item-name { font-size:15px; font-weight:700; line-height:1.45; color:#12202f; }
        .item-details { margin-top:5px; font-size:11px; line-height:1.6; color:#7b8794; }
        .terms { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-top:14px; }
        .term-card { min-height:96px; padding:10px 12px; border-radius:12px; border:1px solid #edf2f7; background:#fcfdfe; }
        .term-card h3 { margin:0 0 6px; font-size:13px; font-weight:700; color:#334155; }
        .term-card div { color:#64748b; line-height:1.55; white-space:pre-wrap; font-size:11px; }
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
            <div class="meta-card"><div class="meta-label">报价编号</div><div class="meta-value">${escapeHtml(document.meta.quoteNo || '未填写')}</div></div>
            <div class="meta-card"><div class="meta-label">报价日期</div><div class="meta-value">${escapeHtml(formatDisplayDate(document.meta.quoteDate))}</div></div>
            <div class="meta-card"><div class="meta-label">客户名称</div><div class="meta-value">${escapeHtml(document.meta.customerName || '未填写')}</div></div>
            <div class="meta-card"><div class="meta-label">联系人 / 电话</div><div class="meta-value">${escapeHtml(document.brand.contactPerson || '未填写')} / ${escapeHtml(document.brand.contactPhone || '未填写')}</div></div>
          </div>
        </div>

        <div class="hero">
          <h2 class="hero-title">${escapeHtml(document.meta.projectTitle || '未填写项目名称')}</h2>
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
            <div>支持对公转账、微信转账或现款结算，具体以下单确认为准。</div>
          </div>
          <div class="term-card">
            <h3>售后说明</h3>
            <div>整机安装调试后交付，提供硬件质保支持，故障问题可协助远程排查。</div>
          </div>
          <div class="term-card">
            <h3>质保政策</h3>
            <div>以收货日为准计算质保时长，整机一年质保，续保费用为整机费用 5% 每年。</div>
          </div>
          <div class="term-card">
            <h3>备注条款</h3>
            <div>${escapeHtml(document.notes || '暂无补充备注。').replace(/\n/g, '<br />')}</div>
          </div>
        </div>
      </div>
    </body>
  </html>`
}
