/* Local design fixture only. No business APIs, persistence, payments or stock mutations. */
const orders = [
  {
    id: 'chen', customer: '陈先生', device: '白色设计主机', shortName: '白色装机',
    no: 'SO-0917-003', sn: 'DEMO-PC-003', category: '交付', status: '待交机',
    photo: 'case', when: '今天 16:00', time: '16:00', timeLabel: '约定到店取机',
    note: '附件待打包 · 尾款 ¥4,280', action: '办理交付', total: 6280, paid: 2000, due: 4280,
    spec: '32GB 内存 / 1TB SSD · 新品装配',
    steps: ['已接单', '备货', '检测', '交付'], step: 3,
    checks: [{ label: '配置与序列号已核对', checked: true, time: '14:20' }, { label: '点亮、烤机测试通过', checked: true, time: '14:35' }, { label: '配件、附件已打包', checked: false }],
    history: '14:35 · 烤机测试通过，已记录检测结果。',
    config: [['处理器', 'Intel Core i5 · 示例'], ['主板', 'B760M · 示例'], ['内存', 'DDR5 32GB'], ['存储', 'NVMe SSD 1TB'], ['显卡', '独立显卡 · 型号待核实'], ['机箱', '白色设计机箱 · 图片示意'], ['电源', '650W'], ['散热器', '塔式风冷']],
  },
  {
    id: 'lin', customer: '林女士', device: '双屏设计工作站', shortName: '设计主机',
    no: 'SO-0917-002', sn: 'DEMO-PC-002', category: '缺货', status: '待补货',
    photo: 'desk', scene: true, when: '预计 17:30 到货', time: '17:30', timeLabel: '预计配件到货',
    note: '缺少固态硬盘 · 1 件', action: '核对到货', total: 8280, paid: 2000, due: 6280,
    spec: '64GB 内存 / 双屏 · SSD 待到货', steps: ['已接单', '备货', '装机', '交付'], step: 1,
    missing: 'NVMe 固态硬盘 2TB × 1', eta: '今天 17:30，待核实实物', supplier: '供应商 A · 示例',
    history: '13:10 · 已向供应商确认发货，尚未验收入库。',
  },
  {
    id: 'zhou', customer: '周先生', device: '显卡检测', shortName: '显卡检测',
    no: 'RE-0917-008', sn: 'DEMO-GPU-008', category: '维修', status: '待检测',
    photo: 'gpu', when: '待安排检测', time: '待安排', timeLabel: '检测时间',
    note: '间歇性黑屏 · 已接收', action: '开始检测', due: 0,
    spec: '客户送修设备 · 厂商型号待核对', steps: ['已接收', '检测', '维修', '归还'], step: 1,
    symptom: '使用中间歇性黑屏，重启后可恢复。',
    checks: [{ label: '外观与附件已记录', checked: true }, { label: '故障复现已完成', checked: false }, { label: '检测结论已记录', checked: false }],
    history: '11:20 · 已接收显卡，待上机复现故障。',
  },
  {
    id: 'zhao', customer: '赵先生', device: '日常办公主机', shortName: '办公主机',
    no: 'SO-0916-011', sn: 'DEMO-PC-011', category: '交付', status: '待交机',
    photo: 'pc', scene: true, when: '今天 18:00', time: '18:00', timeLabel: '约定到店取机',
    note: '检查已完成 · 已收齐款', action: '办理交付', total: 3680, paid: 3680, due: 0,
    spec: '16GB 内存 / 512GB SSD · 新品装配', steps: ['已接单', '备货', '检测', '交付'], step: 3,
    checks: [{ label: '配置与序列号已核对', checked: true }, { label: '点亮、烤机测试通过', checked: true }, { label: '配件、附件已打包', checked: true }],
    history: '14:00 · 配件、附件已打包，等待客户到店。',
    config: [['处理器', '办公处理器 · 型号待核实'], ['内存', 'DDR4 16GB'], ['存储', 'SSD 512GB'], ['机箱 / 电源', '办公套装 · 图片示意']],
  },
  {
    id: 'liu-repair', customer: '刘女士', device: '主板更换', shortName: '主板更换',
    no: 'RE-0916-006', sn: 'DEMO-MB-006', category: '维修', status: '待确认方案',
    photo: null, when: '等待客户确认', time: '待确认', timeLabel: '维修方案',
    note: '更换主板 · 预计 ¥480', action: '查看维修方案', due: 0,
    spec: '客户送修主机 · 原主板无法点亮', steps: ['已接收', '检测', '维修', '归还'], step: 2,
    symptom: '已完成检测，拟更换同规格主板；客户尚未确认。',
    history: '10:40 · 已拟定更换方案，未领料、未产生收费。',
  },
  {
    id: 'wu', customer: '吴先生', device: '双屏办公配置', shortName: '双屏配置',
    no: 'SO-0916-009', sn: 'DEMO-PC-009', category: '缺货', status: '待补货',
    photo: 'desk', scene: true, when: '明天到货', time: '明天', timeLabel: '预计配件到货',
    note: '缺少显示器 · 1 台在途', action: '查看缺件', total: 4240, paid: 2000, due: 2240,
    spec: '办公主机 / 双屏 · 显示器待到货', steps: ['已接单', '备货', '装机', '交付'], step: 1,
    missing: '27 英寸显示器 × 1', eta: '明天，具体时间待确认', supplier: '供应商 B · 示例',
    history: '昨天 16:30 · 已下采购单，显示器在途。',
  },
  {
    id: 'liu-trade', customer: '刘先生', device: '旧主机回收', shortName: '旧机估价',
    no: 'TR-0917-001', sn: 'DEMO-TRADE-001', category: '回收', status: '待验机',
    photo: null, when: '暂收待检测', time: '待验机', timeLabel: '回收进度',
    note: '预计折抵 ¥1,500 · 未定价', action: '开始验机', due: 0,
    spec: '客户暂存设备 · 尚未确认收购', steps: ['登记', '验机', '收购', '整备'], step: 1,
    checks: [{ label: '外观与附件已记录', checked: true }, { label: '性能与故障已检测', checked: false }, { label: '最终估价已确认', checked: false }],
    history: '09:40 · 暂收旧主机，初步估价 ¥1,500。',
  },
];

const state = { selected: 'chen', filter: '全部', query: '', view: 'orders', returnView: 'orders', mobileOpen: false };
const $ = (selector) => document.querySelector(selector);
const money = (value) => '¥' + value.toLocaleString('zh-CN');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const currentOrder = () => orders.find((order) => order.id === state.selected);
const isMobile = () => matchMedia('(max-width: 760px)').matches;

function matchingOrders() {
  const query = state.query.trim().toLowerCase();
  return orders.filter((order) =>
    (state.filter === '全部' || (state.filter === '待收款' ? order.due > 0 : order.category === state.filter)) &&
    (!query || [order.customer, order.device, order.shortName, order.no, order.sn].some((text) => text.toLowerCase().includes(query)))
  );
}

function picture(order, className = '') {
  if (!order.photo) return `<span class="device-placeholder">${icon(order.category === '回收' ? 'recycle' : 'repair')}<span>待补设备照片</span></span>`;
  return `<img src="${MEDIA[order.photo]}" class="${className} ${order.scene ? 'scene' : ''}" alt="${escapeHtml(order.device)}示意图" referrerpolicy="no-referrer">`;
}

function pill(order) {
  return `<span class="status-label ${order.category === '缺货' ? 'amber' : ''}">${order.status}</span>`;
}

function renderList(list) {
  $('#taskList').innerHTML = list.map((order) => `<button class="task-row" data-order="${order.id}" aria-current="${order.id === state.selected}" aria-label="${order.customer}，${order.device}，${order.note}，${order.action}">
    <span class="task-thumb">${order.photo ? picture(order) : icon(order.category === '回收' ? 'recycle' : 'repair')}</span>
    <span class="task-copy"><strong>${order.customer} · ${order.shortName}</strong><small>${order.category === '交付' ? `${order.checks.every((check) => check.checked) ? '检查已完成' : '交付检查待完成'} · ${order.due ? '尾款 ' + money(order.due) : '已收齐款'}` : order.note}</small><span class="task-meta"><span class="${order.category === '缺货' ? 'amber' : ''}">${order.when}</span><span>${order.action} →</span></span></span>
  </button>`).join('');
  $('#emptyList').hidden = list.length > 0;
  $('#resultCount').textContent = String(list.length).padStart(2, '0');
  $('#filterCaption').textContent = (state.filter === '全部' ? '今日待处理' : state.filter + (state.filter === '待收款' ? '订单' : '事项')) + ' · ' + list.length;
  $('#resetFilters').hidden = state.filter === '全部' && !state.query;
  document.querySelectorAll('[data-filter]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter)));
}

function steps(order) {
  return `<ol class="stepper" aria-label="当前阶段：${order.steps[order.step]}">${order.steps.map((step, index) => `<li class="${index < order.step ? 'done' : index === order.step ? 'current' : ''}" ${index === order.step ? 'aria-current="step"' : ''}><i aria-hidden="true">${index < order.step ? '✓' : index + 1}</i>${step}</li>`).join('')}</ol>`;
}

function checklist(order) {
  return `<div class="checklist">${order.checks.map((check, index) => `<label><input type="checkbox" data-check="${index}" ${check.checked ? 'checked' : ''}><span>${check.label}</span><small>${check.time || ''}</small></label>`).join('')}</div>`;
}

function processContent(order) {
  if (order.category === '缺货') {
    return `<div class="process-header"><h3>先处理缺件</h3><span>1 项</span></div><p class="process-description">到货验收后，再安排后续装机。</p><div class="exception-box"><strong>${order.missing}</strong><p>缺件尚未入库，这张订单暂不能交付。</p></div><dl class="facts"><div><dt>预计到货</dt><dd>${order.eta}</dd></div><div><dt>采购来源</dt><dd>${order.supplier}</dd></div><div><dt>其他配件</dt><dd>已预留</dd></div></dl><div class="next-step">${icon('box')}<span>下一步：核对型号、数量与 SN，再登记入库。</span></div>`;
  }
  if (order.id === 'liu-repair') {
    return `<div class="process-header"><h3>等待确认维修方案</h3></div><p class="process-description">客户同意后再领料更换。</p><div class="exception-box"><strong>更换同规格主板 · 预计 ¥480</strong><p>${order.symptom}</p></div><dl class="facts"><div><dt>检测结果</dt><dd>原主板无法点亮</dd></div><div><dt>客户确认</dt><dd>尚未确认</dd></div><div><dt>收费情况</dt><dd>未产生应收</dd></div></dl><div class="next-step">${icon('phone')}<span>下一步：联系客户确认方案及费用。</span></div>`;
  }
  const title = order.category === '交付' ? '交付检查' : order.category === '回收' ? '回收验机' : '检测记录';
  const description = order.category === '交付' ? '交机前，把最后几件事核对好。' : order.category === '回收' ? '暂收设备仍属于客户，未计入库存。' : order.symptom;
  return `<div class="process-header"><h3>${title}</h3><span id="checkCount" aria-live="polite">${order.checks.filter((item) => item.checked).length} / ${order.checks.length}</span></div><p class="process-description">${description}</p>${checklist(order)}<div class="next-step">${icon('clock')}<span id="nextStepText">${nextStep(order)}</span></div>`;
}

function nextStep(order) {
  const missing = order.checks?.filter((check) => !check.checked);
  if (missing?.length) return `下一步：${missing[0].label.replace(/已/g, '')}。`;
  if (order.category === '交付') return order.due ? '检查已齐，办理交付前还需登记尾款。' : '检查已齐、款项已结清，可进入交付核对。';
  if (order.category === '回收') return '检查已齐，下一步确认收购与最终价格。';
  return '检测项已齐，下一步确认处理方案。';
}

function settlement(order) {
  const sale = order.total !== undefined;
  const label = sale ? (order.due ? '待收尾款' : '款项已结清') : order.category === '回收' ? '预计折抵 · 待验机定价' : '当前费用';
  const value = sale ? money(order.due) : order.category === '回收' ? '¥1,500' : '待确认';
  const sub = sale ? `总额 ${money(order.total)} · 已收 ${money(order.paid)}` : order.category === '回收' ? '未确认收购，不进入可卖库存' : '以客户确认的维修方案为准';
  return `<div class="settlement"><div><span class="amount-label">${label}</span><strong class="amount ${value === '待确认' ? 'text-amount' : ''}">${value}</strong><span class="amount-sub">${sub}</span></div><button class="primary" data-action="primary">${order.action}${icon('arrow')}</button></div>`;
}

function renderDetail() {
  const order = currentOrder();
  const detail = $('#orderDetail');
  if (!order) { detail.innerHTML = ''; return; }
  detail.innerHTML = `<button class="mobile-back" id="backToList">${icon('back')}返回待办</button>
    <header class="detail-heading"><div><div class="detail-eyebrow"><span class="order-number">${order.no}</span>${pill(order)}</div><h2 id="detailTitle">${order.customer} · ${order.shortName}</h2></div><div class="appointment">${order.timeLabel}<strong>${order.time}</strong></div></header>
    <div class="detail-grid"><section class="device-column" aria-label="设备资料"><div class="device-hero">${picture(order)}<span class="image-note">${order.photo ? '设备示意' : '尚未拍照'}</span><button class="photo-tool" data-action="photo" aria-label="查看设备照片">${icon('photo')}</button></div><div class="device-caption"><h3>${order.device}</h3><p>${order.spec}</p></div><div class="device-links"><button class="text-button" data-action="config">${order.config ? `查看 ${order.config.length} 项配置` : '查看设备资料'} ${icon('arrow')}</button><button class="text-button" data-action="customer">客户资料 ${icon('phone')}</button></div></section>
    <section class="process-panel" aria-label="订单处理">${steps(order)}${processContent(order)}${settlement(order)}</section></div>
    <div class="context-note">${icon('clock')}<span>${order.history}</span><button class="text-button" data-action="history">处理记录 ↗</button></div>`;
}

function renderGallery(list) {
  $('#deviceGallery').innerHTML = list.map((order) => `<button class="gallery-card" data-order="${order.id}" data-from-gallery="true"><span class="gallery-photo">${pill(order)}${picture(order)}</span><span class="order-number">${order.no}</span><h3>${order.device}</h3><p>${order.customer} · ${order.when}</p><span class="gallery-action"><span>${order.action}</span><span>↗</span></span></button>`).join('');
}

function render() {
  const list = matchingOrders();
  if (!list.some((order) => order.id === state.selected)) state.selected = list[0]?.id ?? null;
  renderList(list);
  renderDetail();
  renderGallery(list);
  $('#orderDetail').hidden = !list.length || state.view === 'devices';
  $('#emptyDetail').hidden = list.length > 0;
  $('#deviceGallery').hidden = state.view !== 'devices' || !list.length;
  $('#workbench').dataset.view = state.view;
  $('#workspaceTitle').textContent = state.view === 'devices' ? '设备看板' : '待办订单';
  document.querySelectorAll('button[data-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === state.view)));
}

function setMobileOpen(open) {
  state.mobileOpen = open;
  document.body.classList.toggle('task-open', open);
  $('#orderDetail').classList.toggle('open', open);
  for (const selector of ['.shop-header', '.page-heading', '.daily-strip', '.workspace-toolbar', '.task-pane', '.page-footer', '.mobile-nav']) $(selector).inert = open;
}

function selectOrder(id, fromGallery = false) {
  state.selected = id;
  state.returnView = fromGallery ? 'devices' : 'orders';
  state.view = 'orders';
  render();
  if (isMobile()) {
    setMobileOpen(true);
    $('#orderDetail').scrollTop = 0;
    history.pushState({ orderDetail: true }, '');
  }
  $('#orderDetail').focus({ preventScroll: true });
}

function closeMobile() {
  setMobileOpen(false);
  state.view = state.returnView;
  render();
  const target = state.view === 'devices' ? `#deviceGallery [data-order="${state.selected}"]` : `#taskList [data-order="${state.selected}"]`;
  $(target)?.focus({ preventScroll: true });
}

function resetFilters() {
  state.filter = '全部'; state.query = ''; $('#search').value = ''; render();
}

function showDialog(title, html) {
  $('#dialogTitle').textContent = title;
  $('#dialogContent').innerHTML = html;
  $('#actionDialog').showModal();
}

function primaryAction(order) {
  if (order.category === '交付') {
    const missing = order.checks.filter((check) => !check.checked);
    const issues = [...missing.map((check) => check.label.replace(/已/g, '') + '：待核对'), ...(order.due ? [`尾款 ${money(order.due)}：待登记收款`] : [])];
    showDialog('交付核对', `<p class="dialog-lead">${order.customer} · ${order.no}</p><ul class="dialog-list">${issues.length ? issues.map((issue) => `<li>${issue}</li>`).join('') : '<li>检查齐全，款项已结清。</li><li>下一步核对实物，再由服务端确认交付出库。</li>'}</ul><div class="dialog-total"><span>待收尾款</span><strong>${money(order.due)}</strong></div>`);
  } else if (order.category === '缺货') {
    showDialog('到货核对', `<p class="dialog-lead">${order.customer} · ${order.no}</p><ul class="dialog-list"><li>${order.missing}</li><li>预计到货：${order.eta}</li><li>核实实物型号、数量及 SN。</li><li>验收入库后，再分配给本订单。</li></ul>`);
  } else if (order.category === '回收') {
    showDialog('回收验机', '<p class="dialog-lead">刘先生 · 旧主机</p><ul class="dialog-list"><li>初步估价 ¥1,500，尚未最终定价。</li><li>核对外观、附件、性能与故障。</li><li>客户确认最终价格及收购事实后，进入待整备库存。</li></ul>');
  } else {
    showDialog(order.action, `<p class="dialog-lead">${order.customer} · ${order.device}</p><ul class="dialog-list"><li>${order.symptom}</li><li>${order.id === 'zhou' ? '先复现故障，再记录检测结果与处理建议。' : '方案与费用需客户确认后才能执行。'}</li><li>送修设备属于客户，不计入门店可卖库存。</li></ul>`);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const count = (category) => String(orders.filter((order) => order.category === category).length).padStart(2, '0');
  $('#deliveryCount').textContent = count('交付');
  $('#shortageCount').textContent = count('缺货');
  $('#repairCount').textContent = count('维修');
  $('#receivableTotal').textContent = money(orders.reduce((sum, order) => sum + order.due, 0));
  render();
  $('#search').addEventListener('input', (event) => { state.query = event.target.value; render(); });
  $('#resetFilters').onclick = resetFilters;
  $('#clearSearch').onclick = resetFilters;
  const focusSearch = () => { $('#search').focus(); $('#search').scrollIntoView({ block: 'center' }); };
  $('#searchShortcut').onclick = focusSearch;
  $('#findDevice').onclick = () => { focusSearch(); toast('输入设备编号或 SN，例如 DEMO-PC-003'); };
  $('#closeDialog').onclick = () => $('#actionDialog').close();

  document.addEventListener('click', (event) => {
    const orderButton = event.target.closest('[data-order]');
    if (orderButton) return selectOrder(orderButton.dataset.order, orderButton.dataset.fromGallery === 'true');
    const filter = event.target.closest('[data-filter]');
    if (filter) { state.filter = filter.dataset.filter; render(); return; }
    const view = event.target.closest('button[data-view]');
    if (view) { state.view = view.dataset.view; render(); return; }
    if (event.target.closest('#backToList')) { history.back(); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    const order = currentOrder();
    if (!action || !order) return;
    if (action === 'primary') return primaryAction(order);
    if (action === 'config') {
      const rows = order.config || [['设备', order.device], ['内部编号 / SN', order.sn], ['当前状态', order.status], ['备注', order.spec]];
      showDialog(order.config ? '设备配置' : '设备资料', `<dl class="facts">${rows.map(([key, value]) => `<div><dt>${key}</dt><dd>${value}</dd></div>`).join('')}</dl>`);
    } else if (action === 'customer') {
      showDialog('客户资料', `<dl class="facts"><div><dt>客户</dt><dd>${order.customer}</dd></div><div><dt>关联单据</dt><dd>${order.no}</dd></div><div><dt>手机号</dt><dd>示例未提供</dd></div></dl>`);
    } else if (action === 'photo') {
      showDialog('设备照片', order.photo ? `<div class="device-hero">${picture(order)}<span class="image-note">设备示意，非此订单实拍</span></div>` : '<p class="dialog-lead">尚未拍摄设备照片。正式产品在此拍照归档。</p>');
    } else if (action === 'history') {
      showDialog('处理记录', `<p class="dialog-lead">${order.no}</p><ul class="dialog-list"><li>${order.history}</li></ul>`);
    }
  });

  document.addEventListener('change', (event) => {
    if (!event.target.matches('[data-check]')) return;
    const order = currentOrder();
    order.checks[Number(event.target.dataset.check)].checked = event.target.checked;
    $('#checkCount').textContent = `${order.checks.filter((check) => check.checked).length} / ${order.checks.length}`;
    $('#nextStepText').textContent = nextStep(order);
    renderList(matchingOrders());
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !state.mobileOpen && !$('#actionDialog').open) { event.preventDefault(); focusSearch(); }
    if (event.key === 'Escape' && state.mobileOpen && !$('#actionDialog').open) history.back();
  });
  window.addEventListener('popstate', () => { if (state.mobileOpen) closeMobile(); });
  matchMedia('(max-width: 760px)').addEventListener('change', () => {
    if (state.mobileOpen) { closeMobile(); history.replaceState({}, ''); }
  });
  // Keep a missing external photo from breaking the rest of the local task UI.
  document.addEventListener('error', (event) => {
    if (event.target.tagName === 'IMG') {
      const fallback = document.createElement('span'); fallback.className = 'device-placeholder';
      fallback.textContent = '图片暂不可用'; event.target.replaceWith(fallback);
    }
  }, true);
});
