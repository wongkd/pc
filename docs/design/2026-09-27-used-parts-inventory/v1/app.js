/*
 * 二手配件仓库与登记 · 交互原型逻辑。
 *
 * 这是一个**纯前端原型**：不写数据库、不调接口，所有数据来自 data.js 的虚构示例。
 * 它的唯一任务是把「操作顺序」跑给你看：进仓库 → 选类别 → 登记 → 看清单件 → 记录检测 →
 * 同型号补录 → 二手到货。业务规则和真实写入都不在这里。
 *
 * 四条必须走通的流（对应方案 README 第 3、4 节和 implementation.md 第 5 节的验收场景）：
 *   ① 无型号档案：选 CPU，输入新型号，成本留空 → 建资料 + 一件二手实物，状态为待检测
 *   ② 同型号两件：成本、检测情况、SN 各自独立，不能合成一个值
 *   ③ 分批补录：同型号再整理出一件，先看近期登记核对，再保存
 *   ④ 二手到货：来源选「新买到货」，保存后仍然是二手，且不显示已付款
 */
(function () {
  'use strict';

  var D = window.DEMO;

  var PREFIX = { 'CPU': 'CPU', '显卡': 'GPU', '主板': 'MB', '内存': 'MEM', '硬盘': 'SSD', '散热器': 'COOL', '电源': 'PSU', '机箱': 'CASE' };
  var QUANTITY_ONLY = ['线材', '其他'];

  /* ---------------- 状态 ---------------- */

  var state = {
    view: 'own',
    category: '全部配件',
    status: 'all',
    query: '',
    items: [],
    side: [],
    seq: 20,
    detailId: null,
    modal: null,            // 'register' | null
    tool: null,             // 更多菜单里的说明面板 key
    form: null,
    notice: null,
    unknown: null,          // 当前正在显示「结果未知」面板
    snHit: null,
    similar: null,
    showCost: true,
    copyOpen: false,
    moreOpen: false,
    scenarioHint: null,
    /* 演示开关：下一次保存时模拟两种真实世界里最常见的失败形态 */
    simNextUnknown: false,
    simNextPartial: false,
    showPartial: false,
  };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function resetData() {
    state.items = clone(D.items);
    state.side = clone(D.sideItems);
    state.seq = 20;
    state.view = 'own';
    state.category = '全部配件';
    state.status = 'all';
    state.query = '';
    state.detailId = null;
    state.modal = null;
    state.tool = null;
    state.form = null;
    state.notice = null;
    state.unknown = null;
    state.snHit = null;
    state.similar = null;
    state.scenarioHint = null;
    state.simNextUnknown = false;
    state.simNextPartial = false;
    state.showPartial = false;
  }

  /* ---------------- 口径 ---------------- */

  /** 库存状态由检测事实与占用推导，不单独录入。 */
  function statusOf(it) {
    if (it.bucket === 'sold') return { key: 'sold', label: '已售' };
    if (it.bucket === 'custody') return { key: 'custody', label: '客户暂存' };
    if (it.bucket === 'in_transit') return { key: 'in_transit', label: '在途' };
    if (it.bucket === 'reserved') return { key: 'reserved', label: '已预留' };
    if (it.inspection === 'ok') return { key: 'available', label: '可售' };
    if (it.inspection === 'pending') return { key: 'inspecting', label: '待检测' };
    return { key: 'handling', label: '待处理' };
  }

  function money(cents) { return '¥' + (cents / 100).toFixed(2); }

  function costText(it) {
    if (it.costCents === null || it.costCents === undefined || it.costBasis === 'unknown') return '待确认';
    if (it.costCents === 0) return '零成本';
    return money(it.costCents);
  }

  function trackingOf(it) { return it.tracking === 'quantity' ? 'quantity' : 'item'; }

  function defaultTracking(category) {
    return QUANTITY_ONLY.indexOf(category) >= 0 ? 'quantity' : 'item';
  }

  function sourceLabel(key) {
    var hit = D.sources.filter(function (s) { return s.key === key; })[0];
    return hit ? hit.label : '未记来源';
  }

  function matchesQuery(it) {
    var q = state.query.trim().toLowerCase();
    if (!q) return true;
    return [it.model, it.specs, it.code, it.sn, it.remark, it.category, it.brand, it.faultNote]
      .filter(Boolean).join(' ').toLowerCase().indexOf(q) >= 0;
  }

  /**
   * 同一个范围里统计：分类数量和状态数量都基于「当前搜索词」这一层，
   * 再各自叠加对方那一个条件 —— 不能拿当前页的数据当全店统计。
   */
  function countIn(category, statusKey, view) {
    var pool = view === 'own' ? state.items : state.side.filter(function (it) { return it.bucket === view; });
    return pool.filter(function (it) {
      if (!matchesQuery(it)) return false;
      if (view === 'own' && category !== '全部配件' && it.category !== category) return false;
      if (view === 'own' && statusKey !== 'all' && statusOf(it).key !== statusKey) return false;
      return true;
    }).length;
  }

  function visibleItems() {
    if (state.view !== 'own') {
      return state.side.filter(function (it) { return it.bucket === state.view && matchesQuery(it); });
    }
    return state.items.filter(function (it) {
      if (!matchesQuery(it)) return false;
      if (state.category !== '全部配件' && it.category !== state.category) return false;
      if (state.status !== 'all' && statusOf(it).key !== state.status) return false;
      return true;
    });
  }

  function ownTotals() {
    var t = { own: 0, custody: 0, transit: 0 };
    state.items.forEach(function (it) { t.own += 1; });
    state.side.forEach(function (it) {
      if (it.bucket === 'custody') t.custody += 1;
      if (it.bucket === 'in_transit') t.transit += 1;
    });
    return t;
  }

  /* ---------------- 小工具 ---------------- */

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function parseYuan(value) {
    var t = String(value === null || value === undefined ? '' : value).trim();
    if (!t) return { empty: true };
    var n = Number(t);
    if (!Number.isFinite(n) || n < 0) return { invalid: true };
    return { cents: Math.round(n * 100) };
  }

  function nextCode(category, index) {
    var prefix = PREFIX[category] || 'PART';
    var d = new Date();
    var stamp = String(d.getFullYear()).slice(2) + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
    state.seq += 1;
    return prefix + '-' + stamp + '-' + ('00' + (state.seq + index)).slice(-3);
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function el(id) { return document.getElementById(id); }

  /* ---------------- 渲染：分类 / 筛选 ---------------- */

  function renderCatbar() {
    if (state.view !== 'own') {
      el('catbar').innerHTML = '<button class="chip" type="button" data-act="back-own">← 返回自有在库</button>';
      return;
    }
    var cats = ['全部配件'].concat(D.categories);
    if (state.moreOpen) cats = cats.concat(D.moreCategories);
    var html = cats.map(function (c) {
      var n = countIn(c, state.status, 'own');
      return '<button class="chip" type="button" aria-pressed="' + (state.category === c) + '" data-act="set-category" data-category="' + esc(c) + '">'
        + esc(c) + '<span class="chip-count num">' + n + '</span></button>';
    }).join('');
    html += '<button class="chip" type="button" aria-pressed="' + state.moreOpen + '" data-act="toggle-more-cats">'
      + (state.moreOpen ? '收起' : '更多') + '</button>';
    el('catbar').innerHTML = html;
  }

  var VIEW_TEXT = {
    custody: { label: '客户暂存', note: '顾客的物品，还没成交，不算店里的库存，也不能当自有件卖。' },
    in_transit: { label: '在途', note: '已经下单但还没到手，先记在这里，到货后再登记成实物。' },
    sold: { label: '已售记录', note: '已经交付的记录，只用于回查去向。' },
  };

  function renderFilterbar() {
    if (state.view !== 'own') {
      var v = VIEW_TEXT[state.view] || { label: '', note: '' };
      el('filterbar').innerHTML = '<span class="badge">' + esc(v.label) + '</span>'
        + '<span class="hint" style="margin:0">' + esc(v.note) + '</span>';
      return;
    }
    var t = ownTotals();
    var html = D.statusFilters.map(function (f) {
      var n = countIn(state.category, f.key, 'own');
      return '<button class="chip" type="button" aria-pressed="' + (state.status === f.key) + '" data-act="set-status" data-status="' + esc(f.key) + '">'
        + esc(f.label) + '<span class="chip-count num">' + n + '</span></button>';
    }).join('');
    html += '<span class="hint" style="margin:0 0 0 8px">自有在库 <b class="num">' + t.own + '</b> 件'
      + ' · 客户暂存 <b class="num">' + t.custody + '</b> · 在途 <b class="num">' + t.transit + '</b>'
      + '（后两项不计入在库，见「更多」里的说明）</span>';
    el('filterbar').innerHTML = html;
  }

  /* ---------------- 渲染：列表 ---------------- */

  function renderList() {
    var list = visibleItems();
    var host = el('list');
    if (list.length === 0) { host.innerHTML = emptyHtml(); return; }

    var head = '<div class="inv-head" role="row">'
      + '<span role="columnheader">配件 / 型号与规格</span>'
      + '<span role="columnheader">状况说明</span>'
      + '<span role="columnheader">库存状态</span>'
      + (state.showCost ? '<span role="columnheader" class="cell-cost">成本</span>' : '')
      + '<span role="columnheader" class="cell-code">编号</span>'
      + '</div>';
    host.innerHTML = '<div class="inv-table" role="table">' + head + list.map(rowHtml).join('') + '</div>';
  }

  function rowHtml(it) {
    var s = statusOf(it);
    var showCategory = state.view !== 'own' || state.category === '全部配件';
    var title = showCategory ? (esc(it.category) + ' · ' + esc(it.model)) : esc(it.model);
    var meta = [it.specs, it.brand, it.condition === 'used' ? '二手' : '新品']
      .filter(Boolean).map(esc).join(' · ');
    var codeCell = trackingOf(it) === 'quantity' ? ('批次 ' + esc(it.code) + ' ×' + it.qty) : esc(it.code);
    return '<button class="inv-row" type="button" data-act="open-detail" data-id="' + esc(it.id) + '" aria-haspopup="dialog">'
      + '<span class="cell-name"><span class="parts">' + title + '</span><span class="meta">' + (meta || '—') + '</span></span>'
      + '<span class="cell-spec">' + (it.remark ? esc(it.remark) : '—') + '</span>'
      + '<span class="cell-status"><span class="badge badge--' + s.key + '">' + esc(s.label) + '</span></span>'
      + (state.showCost ? '<span class="cell-cost num">' + esc(costText(it)) + '</span>' : '')
      + '<span class="cell-code num">' + codeCell + '</span>'
      + '</button>';
  }

  function emptyHtml() {
    if (state.view !== 'own') {
      var v = VIEW_TEXT[state.view] || { label: '' };
      return '<div class="empty"><strong>这里还没有记录</strong><p>' + esc(v.label) + '的物品会出现在这里。</p></div>';
    }
    if (state.query.trim()) {
      return '<div class="empty"><strong>没有找到符合条件的配件</strong>'
        + '<p>已经按「' + esc(state.query.trim()) + '」找过型号、规格、内部编号和厂家 SN。分类和输入都还留着。</p>'
        + '<div class="empty-actions"><button class="btn" type="button" data-act="clear-filter">清除筛选</button></div></div>';
    }
    if (state.items.length === 0) {
      return '<div class="empty"><strong>还没有登记配件</strong>'
        + '<p>把店里的配件登记进来，就能按类别找货、按件记录成本和检测情况。</p>'
        + '<div class="empty-actions">'
        + '<button class="btn btn--primary" type="button" data-act="open-register">登记第一件配件</button>'
        + '<button class="btn" type="button" data-act="open-register" data-source="opening">登记店里已有的配件</button>'
        + '</div></div>';
    }
    if (state.category !== '全部配件') {
      return '<div class="empty"><strong>还没有登记 ' + esc(state.category) + '</strong>'
        + '<p>这个类别下暂时没有配件。</p>'
        + '<div class="empty-actions"><button class="btn btn--primary" type="button" data-act="open-register" data-category="' + esc(state.category) + '">登记 ' + esc(state.category) + '</button></div></div>';
    }
    return '<div class="empty"><strong>这个状态下没有配件</strong>'
      + '<p>换个状态，或者点分类看其他配件。</p>'
      + '<div class="empty-actions"><button class="btn" type="button" data-act="set-status" data-status="all">看全部在库</button></div></div>';
  }

  /* ---------------- 渲染：列表上方提示 ---------------- */

  function renderMessages() {
    var html = '';
    if (state.notice) {
      html += '<p class="notice" role="status">' + esc(state.notice.text)
        + (state.notice.actions || []).map(function (a) {
          return '<button class="btn btn--sm" type="button" data-act="' + esc(a.act) + '"'
            + (a.id ? ' data-id="' + esc(a.id) + '"' : '')
            + (a.category ? ' data-category="' + esc(a.category) + '"' : '')
            + '>' + esc(a.label) + '</button>';
        }).join('')
        + '<button class="btn btn--sm btn--ghost" type="button" data-act="clear-notice">知道了</button></p>';
    }
    if (state.unknown && !state.modal) {
      html += '<p class="notice notice--warn" role="status">登记配件的结果未知（请求编号 ' + esc(state.unknown.requestId) + '）。'
        + '先查这笔到底记上了没有，不要换一个新的请求号重复提交。</p>';
    }
    el('messages').innerHTML = html;
  }

  /* ---------------- 渲染：详情抽屉 ---------------- */

  function findItem(id) {
    var hit = state.items.filter(function (it) { return it.id === id; })[0];
    if (hit) return hit;
    return state.side.filter(function (it) { return it.id === id; })[0] || null;
  }

  function detailRow(label, value) {
    return '<div><dt>' + esc(label) + '</dt><dd>' + value + '</dd></div>';
  }

  function renderDetail() {
    var host = el('overlay');
    if (!state.detailId) { host.innerHTML = ''; return; }
    var it = findItem(state.detailId);
    if (!it) { state.detailId = null; host.innerHTML = ''; return; }

    var s = statusOf(it);
    var body = '';
    body += '<div class="section"><h3>这件配件</h3><dl class="detail-list">'
      + detailRow('类别', esc(it.category))
      + detailRow('型号 / 规格', esc(it.model) + (it.specs ? ' · ' + esc(it.specs) : '') + (it.brand ? ' · ' + esc(it.brand) : ''))
      + detailRow('内部编号', '<span class="num">' + esc(it.code) + '</span>')
      + detailRow('当前状态', '<span class="badge badge--' + s.key + '">' + esc(s.label) + '</span>')
      + detailRow('新旧', it.condition === 'used' ? '二手' : '新品')
      + detailRow('状况说明', esc(it.remark || '—'))
      + detailRow('登记时间', esc(it.acquiredAt))
      + '</dl></div>';

    if (state.showCost) {
      body += '<div class="section"><h3>成本</h3><dl class="detail-list">'
        + detailRow('单件成本', esc(costText(it)) + (it.costBasis === 'estimate' ? '（估算）' : ''))
        + detailRow('说明', it.costBasis === 'unknown' ? '成本还没确认，可以稍后补上；补之前不按 0 元算利润。' : '按实际付款登记。')
        + '</dl></div>';
    } else {
      body += '<div class="section"><h3>成本</h3><p class="hint">当前账号看不到成本 —— 这几个数字根本没有从后台发过来，不是页面上藏起来。</p></div>';
    }

    body += '<div class="section"><h3>来源</h3><dl class="detail-list">'
      + detailRow('来源', esc(sourceLabel(it.source)))
      + detailRow('来源说明', esc(it.sourceNote || '—'))
      + detailRow('厂家 SN', it.sn ? '<span class="num">' + esc(it.sn) + '</span>' : '未录')
      + detailRow('资金记录', it.amountPaid ? esc(it.amountPaid) : '这笔登记没有记付款。到货不等于付钱，要记收付请走对应的单据。')
      + '</dl></div>';

    if (it.inspection === 'faulty') {
      body += '<div class="section"><h3>检测发现</h3><p>' + esc(it.faultNote || '有问题，还没写具体说明。') + '</p>'
        + '<p class="hint">问题件留在待处理里，不进可售；处理完重新记录检测结果才能卖。</p></div>';
    }

    body += '<div class="section"><h3>下一步</h3>' + nextActionHtml(it) + '</div>';

    host.innerHTML = '<div class="drawer-mask" data-act="close-detail"></div>'
      + '<aside class="drawer" role="dialog" aria-modal="true" aria-label="配件详情">'
      + '<div class="drawer-head"><div><h2>' + esc(it.model) + '</h2>'
      + '<span class="sub">' + esc(it.category) + ' · <span class="num">' + esc(it.code) + '</span></span></div>'
      + '<div style="flex:1"></div><button class="btn btn--sm" type="button" data-act="close-detail">关闭</button></div>'
      + '<div class="drawer-body">' + body + '</div>'
      + '</aside>';
  }

  function nextActionHtml(it) {
    var s = statusOf(it);
    if (it.bucket === 'custody') return '<p>这是顾客的物品。要收下来先走「回收或置换」确认收购；确认之前不进店里库存。</p>';
    if (it.bucket === 'in_transit') return '<p>还没到货。到货后在采购里登记，再逐件录成实物。</p>';
    if (it.bucket === 'sold') return '<p>已经交付，去向见关联的单据。</p>';
    if (s.key === 'available') {
      return '<div class="similar-actions">'
        + '<button class="btn" type="button" data-act="open-register" data-category="' + esc(it.category) + '" data-model="' + esc(it.model) + '" data-source="opening">同型号再登记一件</button>'
        + '</div><p class="hint">可售件能加进报价。加进报价不占库存；成交先预留，确认交付才出库。</p>';
    }
    if (s.key === 'reserved') return '<p>已经被 ' + esc(it.reservedRef || '一张单据') + ' 占用，交付或取消后才会回到可售。</p>';
    if (it.inspection === 'pending') {
      return '<div class="similar-actions">'
        + '<button class="btn btn--primary" type="button" data-act="record-inspection" data-id="' + esc(it.id) + '" data-result="ok">记录检测：正常</button>'
        + '<button class="btn" type="button" data-act="record-inspection" data-id="' + esc(it.id) + '" data-result="faulty">记录检测：有问题</button>'
        + '</div><p class="hint">没确认检测结果之前，这件不能当可售卖。</p>';
    }
    return '<p>先处理发现的问题，再重新记录检测结果；处理过程写进状况说明。</p>';
  }

  /* ---------------- 渲染：登记表单 ---------------- */

  function newForm(seed) {
    seed = seed || {};
    var category = seed.category || 'CPU';
    return {
      category: category,
      model: seed.model || '',
      specs: '',
      brand: '',
      source: seed.source || null,
      qty: '1',
      condition: 'used',
      inspection: 'pending',
      costYuan: '',
      remark: '',
      sn: '',
      sourceNote: '',
      tracking: defaultTracking(category),
      rows: [],
      reviewed: false,
      error: '',
    };
  }

  function perItem() { return Boolean(state.form) && state.form.tracking === 'item'; }

  function rowCount() {
    var f = state.form;
    if (!f) return 0;
    var n = Number(f.qty);
    if (!Number.isInteger(n) || n < 1) return 0;
    return Math.min(n, 100);
  }

  function syncRows() {
    var f = state.form;
    var n = rowCount();
    while (f.rows.length < n) f.rows.push({ costYuan: '', inspection: '', remark: '', sn: '' });
    if (f.rows.length > n) f.rows.length = n;
  }

  function renderModal() {
    var host = el('overlay');
    if (!state.modal) { renderDetail(); return; }
    if (state.modal !== 'register') return;

    var f = state.form;
    syncRows();
    var title = rowCount() > 1 ? ('登记 ' + f.category + '（' + rowCount() + ' 件）') : ('登记 ' + f.category);

    host.innerHTML = '<div class="modal-mask" data-act="mask-close">'
      + '<div class="modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '" data-stop="1">'
      + '<div class="modal-head"><h2>' + esc(title) + '</h2>'
      + '<button class="btn btn--sm" type="button" data-act="close-modal">关闭</button></div>'
      + '<div class="modal-body">'
      + (state.scenarioHint ? '<p class="notice">' + esc(state.scenarioHint) + '</p>' : '')

      + '<div class="grid-2">'
      + '<label class="field"><span class="label">1 · 配件类别</span>'
      + '<select data-field="category">' + D.categories.map(function (c) {
        return '<option value="' + esc(c) + '"' + (f.category === c ? ' selected' : '') + '>' + esc(c) + '</option>';
      }).join('') + '</select></label>'
      + '<label class="field"><span class="label">2 · 型号 / 规格</span>'
      + '<input data-field="model" list="model-options" value="' + esc(f.model) + '" placeholder="如 i5-12400F、RTX 3060 12G">'
      + '<datalist id="model-options">' + modelOptions(f.category) + '</datalist>'
      + '<span class="hint">能认出是哪件货就行。已经有档案的会直接复用，没有匹配的就按你写的建立资料 —— 不用先跳去建商品再回来选。</span></label>'
      + '</div>'

      + '<div id="form-source">' + sourceHtml(f) + '</div>'

      + '<div class="grid-2">'
      + '<label class="field"><span class="label">4 · 数量</span>'
      + '<input data-field="qty" inputmode="numeric" value="' + esc(f.qty) + '">'
      + '<span class="hint">' + (perItem() ? '主要配件按件记录：每件有自己的编号、成本和检测情况。' : '线材一类按数量记录，不逐件编号。') + '</span></label>'
      + '<div class="field"><span class="label">新旧</span><div class="radios">'
      + radioBtn('condition', 'used', '二手', f.condition)
      + radioBtn('condition', 'new', '新品', f.condition)
      + '</div><span class="hint">默认二手。新旧和检测情况是两回事。</span></div>'
      + '</div>'

      + '<div class="field"><span class="label">检测情况</span><div class="radios">'
      + D.inspections.map(function (i) { return radioBtn('inspection', i.key, i.label, f.inspection); }).join('')
      + '</div><span class="hint">默认待检测。没确认之前不能标成可售；有问题件留在待处理，并写清是什么问题。</span></div>'

      + '<div class="grid-2">'
      + '<label class="field"><span class="label">5 · 单件成本（元）</span>'
      + '<input data-field="costYuan" inputmode="decimal" value="' + esc(f.costYuan) + '" placeholder="不知道就留空；确实零成本填 0">'
      + '<span class="hint">留空 = 成本还没确认；填 0 = 确实没花钱。两者不是一回事。</span></label>'
      + '<label class="field"><span class="label">状况说明</span>'
      + '<input data-field="remark" value="' + esc(f.remark) + '" placeholder="如 散片、无维修、缺挡板、暗病">'
      + '<span class="hint">写清这件的实际状况，报价和交付时按它说明。</span></label>'
      + '</div>'

      + '<details class="more-info"><summary>6 · 更多信息（厂家 SN、品牌、来源说明、记录方式）</summary>'
      + '<div class="more-body"><div class="grid-2">'
      + '<label class="field"><span class="label">厂家 SN</span><input data-field="sn" value="' + esc(f.sn) + '" placeholder="可选；填了会用来防止同一件重复登记"><span class="hint">没有 SN 也能登记，系统不会替你编一个。</span></label>'
      + '<label class="field"><span class="label">品牌</span><input data-field="brand" value="' + esc(f.brand) + '" placeholder="可选，不知道就留空"><span class="hint">品牌不填不影响登记，别为了填满字段编一个。</span></label>'
      + '<label class="field span-2"><span class="label">来源说明</span><input data-field="sourceNote" value="' + esc(f.sourceNote) + '" placeholder="如 本地同行、顾客张先生、整机拆件源设备编号"></label>'
      + '<div class="field span-2"><span class="label">记录方式（高级设置）</span><div class="radios">'
      + radioBtn('tracking', 'item', '逐件记录', f.tracking)
      + radioBtn('tracking', 'quantity', '按数量记录', f.tracking)
      + '</div><span class="hint">主要配件默认逐件。已经有数量库存的型号不能靠这里改成逐件。</span></div>'
      + '</div></div></details>'

      + (perItem() && rowCount() > 1 ? rowsHtml(f) : '')
      + '<div id="form-messages">' + formMessagesHtml(f) + '</div>'
      + '</div>'
      + '<div class="modal-foot">'
      + '<button class="btn btn--primary" type="button" data-act="save-continue">保存并继续</button>'
      + '<button class="btn" type="button" data-act="save-close">保存</button>'
      + '<button class="btn btn--ghost" type="button" data-act="close-modal">取消</button>'
      + '</div></div></div>';
  }

  function modelOptions(category) {
    var seen = {};
    var out = [];
    state.items.concat(state.side).forEach(function (it) {
      if (it.category !== category || seen[it.model]) return;
      seen[it.model] = true;
      out.push('<option value="' + esc(it.model) + '">已有档案 · ' + esc(statusOf(it).label) + '</option>');
    });
    return out.join('');
  }

  function radioBtn(field, value, label, current) {
    var on = String(current) === String(value);
    return '<button class="radio" type="button" data-act="set-' + esc(field) + '" data-value="' + esc(value) + '"'
      + ' aria-pressed="' + on + '" data-checked="' + on + '"><span>' + esc(label) + '</span></button>';
  }

  function sourceHtml(f) {
    var picked = D.sources.filter(function (s) { return s.key === f.source; })[0];
    return '<div class="field"><span class="label">3 · 来源</span><div class="radios">'
      + D.sources.map(function (s) { return radioBtn('source', s.key, s.label, f.source); }).join('')
      + '</div><span class="hint">'
      + (picked ? esc(picked.hint) : '还没选来源。从仓库点进来的入口要自己选，免得买来的货被记成开店前的存量。')
      + '</span></div>';
  }

  function rowsHtml(f) {
    syncRows();
    var head = '<div class="grid-2" style="margin-bottom:8px">'
      + '<p class="hint" style="margin:0">数量大于 1，下面每件可以单独改成本和检测情况。共同信息改上面；这里的改动只影响这一件。</p>'
      + '<div class="similar-actions" style="justify-content:flex-end">'
      + '<button class="btn btn--sm" type="button" data-act="fill-common">把共同信息填进每一件</button>'
      + '<button class="btn btn--sm" type="button" data-act="copy-first">复制第一件资料</button>'
      + '</div></div>';
    var rows = f.rows.map(function (r, i) {
      return '<div class="item-row">'
        + '<span class="idx num">' + (i + 1) + '</span>'
        + '<span><span class="label" style="display:block;font-size:13px">型号 / 规格</span><span>' + esc(f.model || '（同上）') + (f.specs ? ' · ' + esc(f.specs) : '') + '</span></span>'
        + '<label class="field"><span class="label">成本（元）</span><input data-row="' + i + '" data-rowfield="costYuan" value="' + esc(r.costYuan) + '" inputmode="decimal" placeholder="留空 = 待确认"></label>'
        + '<label class="field"><span class="label">检测情况</span><select data-row="' + i + '" data-rowfield="inspection">'
        + '<option value=""' + (r.inspection === '' ? ' selected' : '') + '>同上面</option>'
        + D.inspections.map(function (x) { return '<option value="' + esc(x.key) + '"' + (r.inspection === x.key ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('')
        + '</select></label>'
        + '<label class="field"><span class="label">状况说明</span><input data-row="' + i + '" data-rowfield="remark" value="' + esc(r.remark) + '" placeholder="同上"></label>'
        + '<label class="field"><span class="label">厂家 SN</span><input data-row="' + i + '" data-rowfield="sn" value="' + esc(r.sn) + '" placeholder="可选"></label>'
        + '<button class="item-row-remove" type="button" data-act="remove-row" data-value="' + i + '" aria-label="删除第 ' + (i + 1) + ' 件">×</button>'
        + '</div>';
    }).join('');
    return '<div class="item-rows">' + head + rows + '</div>';
  }

  function formMessagesHtml(f) {
    var html = '';
    if (state.snHit) {
      html += '<div class="similar"><strong>这个厂家 SN 已经登记过</strong>'
        + '<ul class="similar-list"><li><span class="code num">' + esc(state.snHit.code) + '</span><span>' + esc(state.snHit.model) + '</span>'
        + '<span>' + esc(statusOf(state.snHit).label) + '</span><span>登记于 ' + esc(state.snHit.acquiredAt) + '</span>'
        + (state.showCost ? '<span>' + esc(costText(state.snHit)) + '</span>' : '') + '</li></ul>'
        + '<p class="hint" style="margin:0">同一件货不要记两次。如果确实是另一件但 SN 一样，先核对一下标签是不是抄错了。</p>'
        + '<div class="similar-actions"><button class="btn btn--sm" type="button" data-act="use-existing">这件就是它，不重复登记</button>'
        + '<button class="btn btn--sm" type="button" data-act="clear-sn-hit">不是同一件，我去改 SN</button></div></div>';
    }
    if (state.similar && f.reviewed !== true) {
      html += '<div class="similar"><strong>同型号已经有 ' + state.similar.length + ' 件，先核对是不是同一件货</strong>'
        + '<ul class="similar-list">' + state.similar.map(function (it) {
          return '<li><span class="code num">' + esc(it.code) + '</span><span>' + esc(it.specs || '无规格') + '</span>'
            + '<span>' + esc(it.sn || '无 SN') + '</span><span>' + esc(statusOf(it).label) + '</span>'
            + (state.showCost ? '<span>' + esc(costText(it)) + '</span>' : '')
            + '<span class="code">登记于 ' + esc(it.acquiredAt) + '</span></li>';
        }).join('') + '</ul>'
        + '<p class="hint" style="margin:0">同型号可以分几次登记不同实物。两块一样的 CPU 可能是两件货，也可能是同一件被数了两次 —— 没有 SN 时系统不会替你判定。</p>'
        + '<div class="similar-actions"><button class="btn btn--sm btn--primary" type="button" data-act="ack-similar">核对过了，确实是另一件</button>'
        + '<button class="btn btn--sm" type="button" data-act="close-modal">先不登记</button></div></div>';
    }
    if (state.unknown) {
      html += '<div class="similar"><strong>暂未确认是否保存成功，正在查询结果</strong>'
        + '<p class="hint" style="margin:0">请求编号 ' + esc(state.unknown.requestId) + '。先查这笔的处置结果，不要换一个新的请求号重复提交 —— 那样可能记成两件。</p>'
        + '<div class="similar-actions"><button class="btn btn--sm" type="button" data-act="check-unknown">查询结果</button></div></div>';
    }
    if (state.showPartial) {
      html += '<div class="similar"><strong>资料已保存，库存还没登记</strong>'
        + '<p class="hint" style="margin:0">型号资料建好了，但实物这一笔没有写成。修好之后点保存继续登记就行；已经保存的型号资料不会重复建。</p>'
        + '<div class="similar-actions"><button class="btn btn--sm" type="button" data-act="retry-partial">继续登记库存</button></div></div>';
    }
    if (f.error) html += '<p class="field-error">' + esc(f.error) + '</p>';
    return html;
  }

  /* ---------------- 渲染：更多菜单 / 说明面板 ---------------- */

  function renderMoreMenu() {
    var menu = el('more-menu');
    menu.hidden = !state.moreOpen;
    el('btn-more').setAttribute('aria-expanded', String(state.moreOpen));
    if (!state.moreOpen) return;
    menu.innerHTML = '<div class="menu-title">更多视图（都不计入自有在库）</div>'
      + D.moreViews.map(function (v) { return '<button type="button" role="menuitem" data-act="go-view" data-view="' + esc(v.key) + '">' + esc(v.label) + '</button>'; }).join('')
      + '<div class="menu-sep"></div><div class="menu-title">管理</div>'
      + D.moreTools.map(function (t) { return '<button type="button" role="menuitem" data-act="open-tool" data-tool="' + esc(t.key) + '">' + esc(t.label) + '</button>'; }).join('');
  }

  var TOOL_TEXT = {
    activity: {
      title: '操作记录',
      body: '<p>谁、什么时候，把哪一件从什么状态改到什么状态。全体仓库成员都能看，最近 50 条。</p><p class="hint">原型不实现列表内容。</p>',
    },
    count: {
      title: '盘点库存',
      body: '<p>现场数到的数量和账面不一样时，先把差异记下来，由有权限的人确认后才入账。</p>'
        + '<p class="hint">目前盘点只能往上认；往下减要另走授权动作，所以这个入口不能当「随手改数量」用。</p>',
    },
    library: {
      title: '商品档案',
      body: '<p>型号资料和实物是两件事：档案描述「这是什么型号」，实物记录「店里到底有哪几件」。</p>'
        + '<p class="hint">登记配件时会自动复用匹配的档案，不需要先来这里建档再回去选。这里只用于集中维护型号资料。</p>',
    },
    cleanup: {
      title: '清理工具',
      body: '<p>清理没有任何业务引用的商品档案。</p><p class="hint">有实物或在单据里出现过的档案不会被清理掉。原型不实现。</p>',
    },
    backfill: {
      title: '流程③ · 分批补录',
      body: '<p>昨天登记过一件，今天又整理出一件，同型号再来一次 —— 这就是补录。</p>'
        + '<p class="hint">要点：同型号可以分几次登记不同实物，不用重复建型号；但保存前系统会把近期同型号登记摆出来让你核对，免得同一件货被数两遍。</p>'
        + '<p class="hint">入口在单件详情里的「同型号再登记一件」，不是让你去新建一个同名的型号档案。</p>',
      actions: '<div class="similar-actions"><button class="btn btn--primary" type="button" data-act="open-register" data-category="CPU" data-model="i5-12400F" data-source="opening">从这件 i5-12400F 开始补录</button></div>',
    },
  };

  function renderTool() {
    var t = TOOL_TEXT[state.tool];
    if (!t) { state.tool = null; el('overlay').innerHTML = ''; return; }
    el('overlay').innerHTML = '<div class="modal-mask" data-act="mask-close">'
      + '<div class="modal" style="width:min(560px,100%)" role="dialog" aria-modal="true" aria-label="' + esc(t.title) + '" data-stop="1">'
      + '<div class="modal-head"><h2>' + esc(t.title) + '</h2><button class="btn btn--sm" type="button" data-act="close-tool">关闭</button></div>'
      + '<div class="modal-body">' + t.body + (t.actions || '') + '</div></div></div>';
  }

  function renderCopyCompare() {
    var host = el('copy-compare');
    host.hidden = !state.copyOpen;
    if (!state.copyOpen) return;
    var rows = [
      ['实物收进来，或确认交出去', '删掉整块宣传式标题区，只留「仓库」和具体操作'],
      ['新增商品 / 登记现有库存 并列', '主入口「登记配件」；商品档案降到「更多」'],
      ['分类 / 商品名称', '配件类别 / 型号与规格'],
      ['管理方式、SKU 占主要位置', '类别默认逐件或数量；记录方式和自动编号进「高级设置」'],
      ['自有在库量由可卖、已订和待处理组成', '首页只显示数量和状态，口径放进「更多」的说明'],
      ['已取得所有权，实物进入待检', '回收确认成功后说「已收购，待检测」'],
      ['所有金额由服务端按整数分结算', '业务界面上不出现这类实现说明'],
      ['还没有商品档案', '「还没有登记配件」＋「登记第一件配件」'],
    ];
    el('copy-compare-body').innerHTML = '<table><thead><tr><th>旧文案 / 旧安排</th><th>这次怎么改</th></tr></thead><tbody>'
      + rows.map(function (r) { return '<tr><td class="strike">' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('')
      + '</tbody></table>';
  }

  /* ---------------- 总渲染 ---------------- */

  function render() {
    renderCatbar();
    renderFilterbar();
    renderMessages();
    renderList();
    renderMoreMenu();
    renderCopyCompare();
    if (state.tool) renderTool();
    else if (state.modal) renderModal();
    else if (state.detailId) renderDetail();
    else el('overlay').innerHTML = '';
  }

  /* ---------------- 动作 ---------------- */

  function openRegister(seed) {
    state.form = newForm(seed);
    state.modal = 'register';
    state.tool = null;
    state.snHit = null;
    state.similar = null;
    state.unknown = null;
    state.showPartial = false;
    render();
  }

  function closeModal() {
    state.modal = null;
    state.form = null;
    state.snHit = null;
    state.similar = null;
    state.unknown = null;
    state.showPartial = false;
    state.scenarioHint = null;
    render();
  }

  function submit(mode) {
    var f = state.form;
    if (!f) return;
    f.error = '';

    var errors = [];
    if (!f.model.trim()) errors.push('请填写型号或规格 —— 能认出是哪件货就行，不必先编 SKU。');
    var qtyNum = Number(f.qty);
    if (!Number.isInteger(qtyNum) || qtyNum < 1) errors.push('数量要是大于 0 的整数。');
    if (qtyNum > 100) errors.push('一次最多登记 100 件，多出来的下一批再录。');
    if (!f.source) errors.push('请先选来源：店里已有、新买到货、回收或置换、整机拆件。');

    var common = parseYuan(f.costYuan);
    if (common.invalid) errors.push('单件成本要是不小于 0 的金额；不知道就留空。');
    f.rows.forEach(function (r, i) {
      if (parseYuan(r.costYuan).invalid) errors.push('第 ' + (i + 1) + ' 件的成本要是不小于 0 的金额。');
    });
    if (f.inspection === 'faulty' && !f.remark.trim()) errors.push('检测有问题时，请在状况说明里写清是什么问题。');
    if (errors.length) { f.error = errors[0]; render(); return; }

    /* SN 命中已有实物：不生成第二件，先把已有记录给店员核对 */
    var sn = f.sn.trim();
    if (sn && !state.snHit) {
      var hit = state.items.filter(function (it) { return it.sn && it.sn === sn; })[0];
      if (hit) { state.snHit = hit; render(); return; }
    }

    /* 同型号已有登记：先核对，不自动合并也不自动另建 */
    if (f.reviewed !== true) {
      var similar = state.items.filter(function (it) { return it.category === f.category && it.model === f.model.trim(); });
      if (similar.length > 0) { state.similar = similar; render(); return; }
    }

    /* 演示：模拟两种真实世界里最常见的失败形态 */
    if (state.simNextUnknown) {
      state.simNextUnknown = false;
      state.unknown = { requestId: 'req-' + Math.random().toString(36).slice(2, 10) };
      render();
      return;
    }
    if (state.simNextPartial) {
      state.simNextPartial = false;
      state.showPartial = true;
      render();
      return;
    }

    var created = [];
    var total = perItem() ? rowCount() : 1;
    for (var i = 0; i < total; i += 1) {
      var r = f.rows[i] || {};
      var cents;
      var rowParsed = parseYuan(r.costYuan);
      if (!rowParsed.empty && rowParsed.cents !== undefined) cents = rowParsed.cents;
      else if (common.empty) cents = null;
      else cents = common.cents;
      var inspection = r.inspection || f.inspection;
      created.push({
        id: 'new-' + Date.now() + '-' + i,
        code: nextCode(f.category, i),
        category: f.category,
        model: f.model.trim(),
        specs: f.specs.trim(),
        brand: f.brand.trim(),
        condition: f.condition,
        inspection: inspection,
        faultNote: inspection === 'faulty' ? f.remark.trim() : '',
        bucket: inspection === 'ok' ? 'available' : 'quarantine',
        reservedRef: null,
        costCents: cents,
        costBasis: cents === null ? 'unknown' : 'actual',
        remark: String(r.remark || f.remark || '').trim(),
        source: f.source,
        sourceNote: f.sourceNote.trim(),
        sn: String(r.sn || f.sn || '').trim() || null,
        acquiredAt: today(),
        tracking: f.tracking,
        qty: perItem() ? 1 : rowCount(),
      });
    }
    state.items = created.concat(state.items);
    state.notice = {
      text: '已登记 ' + created.length + ' 件 ' + f.category,
      actions: [
        { act: 'open-register', label: '继续登记', category: f.category },
        { act: 'open-detail', label: '查看这件配件', id: created[0].id },
      ],
    };
    state.snHit = null;
    state.similar = null;
    state.unknown = null;
    state.showPartial = false;
    state.scenarioHint = null;

    if (mode === 'continue') {
      state.form = newForm({ category: f.category, source: f.source });
      render();
      return;
    }
    state.modal = null;
    state.form = null;
    state.detailId = created[0].id;
    render();
  }

  function runScenario(key) {
    if (key === '1') {
      openRegister({ category: 'CPU' });
      state.scenarioHint = '流程①：没有型号档案时，选 CPU、直接输入型号、成本留空 —— 保存后建资料并生成一件二手实物，状态是待检测。';
      render();
      return;
    }
    if (key === '2') {
      /* 来源按「同型号再登记」的入口带入：这条路径的货本来就是店里已有的那批。 */
      openRegister({ category: 'CPU', model: 'i5-12400F', source: 'opening' });
      state.scenarioHint = '流程②：同型号第二件。型号选已有的 i5-12400F，填一个不一样的成本、选另一种检测情况 —— 两件各自独立，不会被合成一行。保存时会先让你核对近期同型号登记。';
      render();
      return;
    }
    if (key === '3') {
      state.modal = null;
      state.detailId = null;
      state.tool = 'backfill';
      render();
      return;
    }
    if (key === '4') {
      openRegister({ category: '显卡', model: 'RX 6700 XT 12G', source: 'purchase' });
      state.form.costYuan = '950';
      state.form.sourceNote = '本地同行';
      state.scenarioHint = '流程④：二手显卡到货。来源选「新买到货」，保存后这件仍然是二手，而且不会自动显示「已付款」——到货不等于付钱。';
      render();
    }
  }

  /* ---------------- 事件 ---------------- */

  document.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-act]');
    if (!trigger) {
      if (state.moreOpen && !event.target.closest('.menu-wrap')) { state.moreOpen = false; renderMoreMenu(); }
      return;
    }
    var act = trigger.getAttribute('data-act');

    /* 点遮罩关闭：点在卡片/抽屉内部（带 data-stop 的那一层）不算 */
    if (act === 'mask-close') {
      if (event.target.closest('[data-stop]')) return;
      if (state.modal) { closeModal(); return; }
      state.tool = null;
      render();
      return;
    }

    switch (act) {
      case 'open-register': {
        var seeded = trigger.getAttribute('data-category');
        var cat = seeded || (state.category === '全部配件' ? 'CPU' : state.category);
        openRegister({
          category: cat,
          model: trigger.getAttribute('data-model') || '',
          source: trigger.getAttribute('data-source') || null,
        });
        break;
      }
      case 'close-modal':
        closeModal();
        break;
      case 'close-tool':
        state.tool = null;
        render();
        break;
      case 'open-detail':
        state.detailId = trigger.getAttribute('data-id');
        state.tool = null;
        state.modal = null;
        render();
        break;
      case 'close-detail':
        state.detailId = null;
        render();
        break;
      case 'set-category':
        state.category = trigger.getAttribute('data-category');
        render();
        break;
      case 'set-status':
        state.status = trigger.getAttribute('data-status');
        render();
        break;
      case 'toggle-more-cats':
        state.moreOpen = !state.moreOpen;
        renderCatbar();
        break;
      case 'clear-filter':
        state.query = '';
        el('search').value = '';
        state.status = 'all';
        state.category = '全部配件';
        render();
        break;
      case 'back-own':
        state.view = 'own';
        render();
        break;
      case 'go-view':
        state.view = trigger.getAttribute('data-view');
        state.moreOpen = false;
        render();
        break;
      case 'open-tool':
        state.tool = trigger.getAttribute('data-tool');
        state.detailId = null;
        state.moreOpen = false;
        render();
        break;
      case 'clear-notice':
        state.notice = null;
        renderMessages();
        break;
      case 'set-source':
        state.form.source = trigger.getAttribute('data-value');
        el('form-source').innerHTML = sourceHtml(state.form);
        break;
      case 'set-condition':
      case 'set-inspection':
      case 'set-tracking': {
        var field = act.replace('set-', '');
        state.form[field] = trigger.getAttribute('data-value');
        if (field === 'tracking') { state.form.qty = '1'; state.form.rows = []; }
        renderModal();
        break;
      }
      case 'save-continue':
        submit('continue');
        break;
      case 'save-close':
        submit('close');
        break;
      case 'ack-similar':
        state.form.reviewed = true;
        submit('close');
        break;
      case 'clear-sn-hit':
        state.snHit = null;
        renderModal();
        break;
      case 'use-existing':
        state.snHit = null;
        state.modal = null;
        state.form = null;
        state.notice = { text: '没有新建记录 —— 这件货已经在仓库里了。', actions: [] };
        render();
        break;
      case 'check-unknown':
        state.unknown = null;
        state.notice = { text: '后台查到这笔已经记上了，列表里能看到刚登记的配件。', actions: [] };
        state.modal = null;
        state.form = null;
        render();
        break;
      case 'retry-partial':
        state.showPartial = false;
        state.notice = { text: '库存已经补登记成功。', actions: [] };
        state.modal = null;
        state.form = null;
        render();
        break;
      case 'record-inspection': {
        var item = findItem(trigger.getAttribute('data-id'));
        var result = trigger.getAttribute('data-result');
        if (item) {
          item.inspection = result;
          item.bucket = result === 'ok' ? 'available' : 'quarantine';
          item.faultNote = result === 'faulty' ? (item.faultNote || '记录了问题，待处理。') : '';
          state.notice = {
            text: result === 'ok'
              ? ('检测记录完成，' + item.code + ' 现在可以卖了。')
              : ('已记录问题，' + item.code + ' 留在待处理。'),
            actions: [],
          };
        }
        render();
        break;
      }
      case 'remove-row': {
        var idx = Number(trigger.getAttribute('data-value'));
        state.form.rows.splice(idx, 1);
        state.form.qty = String(Math.max(1, state.form.rows.length));
        renderModal();
        break;
      }
      case 'fill-common':
        state.form.rows.forEach(function (r) {
          r.costYuan = state.form.costYuan;
          r.inspection = state.form.inspection;
          r.remark = state.form.remark;
        });
        renderModal();
        break;
      case 'copy-first':
        if (state.form.rows.length > 1) {
          var first = state.form.rows[0];
          state.form.rows = state.form.rows.map(function (r, i) {
            if (i === 0) return r;
            /* 复制只带基础资料；SN 清空，免得两件货共用一个序列号 */
            return { costYuan: first.costYuan, inspection: first.inspection, remark: first.remark, sn: '' };
          });
        }
        renderModal();
        break;
      default:
        break;
    }
  });

  document.addEventListener('input', function (event) {
    var t = event.target;
    if (!state.form || !t.getAttribute) return;
    if (t.getAttribute('data-field')) {
      var field = t.getAttribute('data-field');
      state.form[field] = t.value;
      if (field === 'qty') {
        var host = document.querySelector('.item-rows');
        var want = perItem() && rowCount() > 1;
        if (want) { syncRows(); if (host) host.outerHTML = rowsHtml(state.form); else renderModal(); }
        else if (host) host.remove();
      }
      return;
    }
    if (t.getAttribute('data-row') !== null) {
      var i = Number(t.getAttribute('data-row'));
      var row = state.form.rows[i];
      if (row) row[t.getAttribute('data-rowfield')] = t.value;
    }
  });

  document.addEventListener('change', function (event) {
    var t = event.target;
    if (!state.form || !t.getAttribute) return;
    if (t.getAttribute('data-field') === 'category') {
      state.form.category = t.value;
      if (QUANTITY_ONLY.indexOf(t.value) >= 0) state.form.tracking = 'quantity';
      else if (state.form.tracking === 'quantity') state.form.tracking = 'item';
      state.form.model = '';
      state.form.rows = [];
      state.similar = null;
      renderModal();
      return;
    }
    if (t.getAttribute('data-field') === 'model') {
      state.form.model = t.value;
      state.similar = null;
    }
  });

  el('search').addEventListener('input', function (e) {
    state.query = e.target.value;
    renderCatbar();
    renderFilterbar();
    renderList();
    renderMessages();
  });

  el('btn-register').addEventListener('click', function () {
    openRegister({ category: state.category === '全部配件' ? 'CPU' : state.category, source: null });
  });

  el('btn-more').addEventListener('click', function () {
    state.moreOpen = !state.moreOpen;
    renderMoreMenu();
  });

  el('demo-controls').addEventListener('click', function (event) {
    var btn = event.target.closest('[data-demo]');
    if (!btn) return;
    var key = btn.getAttribute('data-demo');
    if (key.indexOf('scenario-') === 0) { runScenario(key.slice(-1)); return; }
    if (key === 'toggle-cost') {
      state.showCost = !state.showCost;
      btn.textContent = '成本显示：' + (state.showCost ? '开' : '关');
      render();
      return;
    }
    if (key === 'copy-compare') {
      state.copyOpen = !state.copyOpen;
      renderCopyCompare();
      if (state.copyOpen) el('copy-compare').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (key === 'sim-unknown') {
      state.simNextUnknown = true;
      state.simNextPartial = false;
      state.notice = { text: '已经打开「结果未知」演示：下一次点保存，会看到「暂未确认是否保存成功」。', actions: [] };
      render();
      return;
    }
    if (key === 'sim-partial') {
      state.simNextPartial = true;
      state.simNextUnknown = false;
      state.notice = { text: '已经打开「资料已保存、库存没登记」演示：下一次点保存，会只保存资料。', actions: [] };
      render();
      return;
    }
    if (key === 'reset') {
      resetData();
      el('search').value = '';
      render();
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (state.tool) { state.tool = null; render(); return; }
    if (state.modal) { closeModal(); return; }
    if (state.detailId) { state.detailId = null; render(); }
  });

  resetData();
  render();
}());
