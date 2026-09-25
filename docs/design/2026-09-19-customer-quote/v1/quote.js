/**
 * Q01 · 顾客打开专属报价链接 —— 原型渲染逻辑。
 *
 * 三条硬规则写在这里，改代码时别绕过：
 *   1. 未登录（auth）、无权访问（forbidden）两个状态不渲染任何金额与明细；
 *   2. 付款、联系门店、手机号验证都只弹说明，不伪造成功、不写任何数据；
 *   3. 顾客侧数据里不出现成本、供应商、内部备注与 SN。
 *
 * 金额一律用整数“分”存储，格式化用纯字符串运算 ——
 * 小程序 JSCore 的 toLocaleString 不完整，原型先按同一口径写，避免两端漂移。
 */
(function () {
  'use strict';

  /* ================= 金额工具 ================= */

  function money(cents) {
    var negative = cents < 0;
    var value = Math.abs(Math.round(cents));
    var yuan = Math.floor(value / 100);
    var fen = value - yuan * 100;
    var digits = String(yuan);
    var grouped = '';
    for (var i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 === 0) grouped += ',';
      grouped += digits.charAt(i);
    }
    return (negative ? '-' : '') + '¥' + grouped + '.' + (fen < 10 ? '0' + fen : String(fen));
  }

  function esc(text) {
    return String(text).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /* ================= 虚构演示数据 ================= */

  var STORE = {
    name: '装一下机 · 湛江店',
    phone: '0759-321 0000（演示号码）',
    hours: '每天 10:00 – 21:00'
  };

  var QUOTE = {
    id: 'BJ-2026-0919-001',
    version: 2,
    issuedAt: '2026-09-19',
    validUntil: '2026-09-26',
    customer: { name: '周先生' },
    purpose: '视频剪辑与游戏',
    depositPercent: 15,
    discount: 50000,
    // 顾客咨询时说的心理预算，是配置单的输入参数，不是一个付款动作。
    // 它只用于「本单比预算高还是低」的对照，不参与任何金额计算。
    budget: 1200000,
    hardware: [
      { name: '英特尔 i5-14600KF', spec: '14 核 20 线程 · 盒装', origin: 'new', qty: 1, unitPrice: 249900, warranty: '质保 1 年' },
      { name: '微星 B760M 迫击炮 WiFi', spec: 'DDR5 · 双 M.2', origin: 'new', qty: 1, unitPrice: 119900, warranty: '质保 1 年' },
      { name: '金士顿 32GB（16G×2）', spec: 'DDR5 6000MHz', origin: 'new', qty: 1, unitPrice: 69900, warranty: '质保 1 年' },
      { name: '影驰 RTX 4060 Ti 8G 金属大师', spec: '三风扇 · 全新盒装', origin: 'new', qty: 1, unitPrice: 289900, warranty: '质保 1 年' },
      { name: '三星 990 PRO 1TB', spec: 'PCIe 4.0 · 读取 7450MB/s', origin: 'new', qty: 1, unitPrice: 74900, warranty: '质保 1 年' },
      { name: '海盗船 RM750e 750W', spec: '金牌全模组 · 本店二手，已整备', origin: 'used', qty: 1, unitPrice: 24900, warranty: '质保 3 个月' },
      { name: '先马 平头哥 M1', spec: '中塔 · 侧透', origin: 'new', qty: 1, unitPrice: 19900, warranty: '质保 1 年' },
      { name: '利民 PA120 SE', spec: '双塔六热管', origin: 'new', qty: 1, unitPrice: 18900, warranty: '质保 1 年' },
      { name: '先马 12cm 机箱风扇', spec: '风量扇 · 带防尘网', origin: 'new', qty: 3, unitPrice: 3900, warranty: '质保 1 年' },
      { name: '西数 WD_BLACK 1TB', spec: '顾客自带，装机前已当面确认收货', origin: 'customer', qty: 1, unitPrice: 0, warranty: '不提供质保' }
    ],
    services: [
      { name: '整机装机与系统调试', spec: '含系统、驱动与常用软件', origin: 'service', qty: 1, unitPrice: 20000, warranty: '服务项' },
      { name: '装机检测与烤机', spec: '含 24 小时稳定性测试', origin: 'service', qty: 1, unitPrice: 15000, warranty: '服务项' }
    ],
    delivery: {
      method: '到店自提，或湛江市区送货',
      free: '10km 以内免费送达',
      note: '超出 10km 的配送费由门店确认后另行告知',
      eta: '确认付款后 3 个工作日',
      place: '湛江市赤坎区（演示地址）'
    },
    warranty: [
      '全新整机：质保 1 年',
      '本店全新配件：质保 1 年',
      '本店二手配件：质保 3 个月',
      '顾客自带件：不提供质保',
      '可另付费用延长保修，条件由门店确认'
    ]
  };

  /** 演示用两档顾客预算：够用与不够用。两种文案都得能走查，别只验好看的。 */
  var BUDGETS = {
    enough: { label: '预算 ¥12,000', value: 1200000 },
    tight: { label: '预算 ¥8,000', value: 800000 }
  };

  /** 门店改一次报价就出一个新版本；老版本保留当时的金额快照。 */
  function quoteFor(version) {
    var quote = clone(QUOTE);
    quote.version = version;
    quote.latestVersion = 3;
    quote.budget = BUDGETS[budgetLevel].value;
    if (version >= 3) {
      quote.issuedAt = '2026-09-21';
      quote.validUntil = '2026-09-28';
      quote.hardware[3].unitPrice = 299900;
      quote.hardware[3].spec = '三风扇 · 全新盒装（门店更新：行情上涨）';
    }
    return quote;
  }

  function subtotalOf(lines) {
    return lines.reduce(function (total, line) {
      return total + line.unitPrice * line.qty;
    }, 0);
  }

  function compute(quote) {
    var hardwareTotal = subtotalOf(quote.hardware);
    var serviceTotal = subtotalOf(quote.services);
    var subtotal = hardwareTotal + serviceTotal;
    var payable = subtotal - quote.discount;
    var deposit = Math.round(payable * quote.depositPercent / 100);
    return {
      hardwareTotal: hardwareTotal,
      serviceTotal: serviceTotal,
      subtotal: subtotal,
      payable: payable,
      deposit: deposit,
      balance: payable - deposit,
      count: quote.hardware.length + quote.services.length,
      // 预算只做对照，不参与上面任何一步金额计算。
      // 差额一律按「应付 − 预算」算：正数是超预算，负数是没花到预算。
      budget: quote.budget,
      budgetDiff: payable - quote.budget,
      budgetPercent: quote.budget > 0 ? (payable / quote.budget) * 100 : 0
    };
  }

  /* ================= 演示状态 ================= */

  var STATES = [
    { key: 'valid', label: '正常 · 待确认', note: '顾客能看单价明细，能选定金或全款' },
    { key: 'loading', label: '首次加载', note: '结构占位，不拿 ¥0 冒充真实金额' },
    { key: 'error', label: '加载失败', note: '保留重试，可转人工联系门店' },
    { key: 'auth', label: '未登录', note: '不渲染任何金额与明细，先验证手机号' },
    { key: 'forbidden', label: '无权访问', note: '别人的报价，同样不渲染任何金额' },
    { key: 'notfound', label: '链接失效', note: '单号不存在或门店已删除这份报价' },
    { key: 'expired', label: '报价已过期', note: '明细仍在，但不能再付款' },
    { key: 'withdrawn', label: '门店已撤回', note: '只留摘要，逐项明细不再展示' },
    { key: 'updated', label: '版本已更新', note: '看的是 v2，门店已发 v3，必须先看新版' },
    { key: 'deposit', label: '已下定金（演示）', note: '模拟付款后看状态，明确标注非真实到账' }
  ];

  var ART = {
    lock: '<svg class="state-art" viewBox="0 0 56 56" fill="none" stroke="#687365" stroke-width="1.6" aria-hidden="true">'
      + '<rect x="14" y="24" width="28" height="20" rx="3"/><path d="M21 24v-6a7 7 0 0 1 14 0v6"/>'
      + '<circle cx="28" cy="34" r="2.4" fill="#687365" stroke="none"/></svg>',
    clock: '<svg class="state-art" viewBox="0 0 56 56" fill="none" stroke="#687365" stroke-width="1.6" aria-hidden="true">'
      + '<circle cx="28" cy="28" r="17"/><path d="M28 18v11l7 5"/></svg>',
    alert: '<svg class="state-art" viewBox="0 0 56 56" fill="none" stroke="#687365" stroke-width="1.6" aria-hidden="true">'
      + '<circle cx="28" cy="28" r="17"/><path d="M28 19v13"/>'
      + '<circle cx="28" cy="37.5" r="1.6" fill="#687365" stroke="none"/></svg>',
    search: '<svg class="state-art" viewBox="0 0 56 56" fill="none" stroke="#687365" stroke-width="1.6" aria-hidden="true">'
      + '<circle cx="25" cy="25" r="13"/><path d="M34.5 34.5 44 44"/></svg>'
  };

  /* ================= DOM ================= */

  var screenEl = document.getElementById('screen');
  var statesEl = document.getElementById('states');
  var budgetsEl = document.getElementById('budgets');
  var shareInput = document.getElementById('shareUrl');
  var stageNoteEl = document.getElementById('stageNote');
  var chromeTitleEl = document.getElementById('chromeTitle');
  var dialogEl = document.getElementById('demoDialog');
  var dialogTitleEl = document.getElementById('demoDialogTitle');
  var dialogBodyEl = document.getElementById('demoDialogBody');
  var dialogActionsEl = document.getElementById('demoDialogActions');
  var token = 'demo_9f3c7a';

  var state = 'valid';
  var plan = 'deposit';
  var viewingVersion = 2;
  // 预算与版本、付款方式一样是独立维度：换预算不该重置正在看的版本。
  var budgetLevel = 'enough';

  /* ================= 渲染片段 ================= */

  function headHtml(quote, badge) {
    return '<header class="q-head">'
      + '<p class="q-kicker">' + esc(STORE.name) + '</p>'
      + '<h1 class="q-title">' + esc(quote.customer.name) + '，这是你的配置单</h1>'
      + '<p class="q-meta">报价单号 ' + esc(quote.id) + ' · 版本 v' + quote.version
      + '<br>出具 <span class="nowrap">' + esc(quote.issuedAt) + '</span>'
      + ' · 有效期至 <span class="nowrap">' + esc(quote.validUntil) + '</span>'
      + '<br>用途：' + esc(quote.purpose) + '</p>'
      + badge
      + '</header>';
  }

  function tagsOf(line) {
    var tags = [];
    if (line.origin === 'customer') tags.push('<span class="tag tag-supply">顾客自带</span>');
    else if (line.origin === 'used') tags.push('<span class="tag tag-used">本店二手</span>');
    else if (line.origin === 'new') tags.push('<span class="tag tag-new">全新</span>');
    if (line.warranty) tags.push('<span class="tag">' + esc(line.warranty) + '</span>');
    return tags.join('');
  }

  function lineHtml(line) {
    return '<li class="line">'
      + '<div class="line-main">'
      + '<p class="line-name">' + esc(line.name) + '</p>'
      + '<p class="line-spec">' + esc(line.spec) + '</p>'
      + '<p class="line-tags">' + tagsOf(line) + '</p>'
      + '</div>'
      + '<div class="line-money">'
      + '<p class="line-sub">' + money(line.unitPrice * line.qty) + '</p>'
      + '<p class="line-calc">' + money(line.unitPrice) + ' × ' + line.qty + '</p>'
      + '</div>'
      + '</li>';
  }

  function linesHtml(quote, computed) {
    return '<section class="sec">'
      + '<h2 class="sec-title">配件明细<span class="sec-note">共 ' + computed.count + ' 项</span></h2>'
      + '<ul class="lines">' + quote.hardware.map(lineHtml).join('') + '</ul>'
      + '</section>'
      + '<section class="sec">'
      + '<h2 class="sec-title">服务与调试<span class="sec-note">共 ' + quote.services.length + ' 项</span></h2>'
      + '<ul class="lines">' + quote.services.map(lineHtml).join('') + '</ul>'
      + '</section>';
  }

  /**
   * 预算对照条。
   *
   * 措辞刻意中立：只陈述「比预算低 / 超出预算」，不写「省下 ¥X，还可以再加配置」。
   * 后者等于当着顾客的面暗示还有余量可花，会把一次确认变成一轮加价。
   * 超预算时颜色转警示，但不劝退、不催付。
   */
  function compareHtml(quote, computed) {
    if (!computed.budget) return '';
    var over = computed.budgetDiff > 0;
    var percent = Math.round(Math.abs(computed.budgetPercent) * 10) / 10;
    var width = Math.min(100, percent);
    var verdict = over
      ? '超出预算 ' + money(computed.budgetDiff)
      : (computed.budgetDiff < 0 ? '比预算低 ' + money(-computed.budgetDiff) : '正好用完预算');
    var aria = '你的预算 ' + money(computed.budget) + '，本单 ' + money(computed.payable)
      + '，占预算 ' + percent.toFixed(1) + '%';

    return '<div class="cmp' + (over ? ' cmp-over' : '') + '">'
      + '<p class="cmp-row"><span>你的预算</span><span class="v">' + money(computed.budget) + '</span></p>'
      + '<div class="cmp-bar" role="img" aria-label="' + esc(aria) + '">'
      + '<span class="cmp-fill" style="width:' + width + '%"></span>'
      + '</div>'
      + '<p class="cmp-row cmp-verdict"><span>本单 ' + money(computed.payable) + '</span>'
      + '<span class="v">' + verdict + '</span></p>'
      + '</div>';
  }

  function sumHtml(quote, computed) {
    return '<div class="sum">'
      + '<div class="sum-row"><span>配件合计</span><span class="v">' + money(computed.hardwareTotal) + '</span></div>'
      + '<div class="sum-row"><span>服务与调试</span><span class="v">' + money(computed.serviceTotal) + '</span></div>'
      + (quote.discount
        ? '<div class="sum-row sum-row-discount"><span>门店优惠</span><span class="v">−' + money(quote.discount) + '</span></div>'
        : '')
      + '<div class="sum-total"><span>应付总额</span><span class="v">' + money(computed.payable) + '</span></div>'
      + compareHtml(quote, computed)
      + '</div>';
  }

  function payHtml(quote, computed, options) {
    var disabled = options.disabled;
    var selected = plan === 'full' ? 'full' : 'deposit';
    var depositAmount = money(computed.deposit);
    var fullAmount = money(computed.payable);
    var balanceAmount = money(computed.balance);

    var html = '<section class="sec">'
      + '<h2 class="sec-title">怎么付款<span class="sec-note">两种选一种</span></h2>'
      + '<div class="pay-options" role="radiogroup" aria-label="付款方式">'
      + '<button type="button" class="pay-option" role="radio" data-plan="deposit" aria-checked="'
      + (selected === 'deposit') + '"' + (disabled ? ' disabled' : '') + '>'
      + '<span class="pay-dot" aria-hidden="true"></span>'
      + '<span class="pay-name">先付定金，排产装机</span>'
      + '<span class="pay-amount">' + depositAmount + '</span>'
      + '<p class="pay-desc">按应付总额的 ' + quote.depositPercent + '% 收取。交付时结清尾款 ' + balanceAmount
      + '。定金不退。</p>'
      + '</button>'
      + '<button type="button" class="pay-option" role="radio" data-plan="full" aria-checked="'
      + (selected === 'full') + '"' + (disabled ? ' disabled' : '') + '>'
      + '<span class="pay-dot" aria-hidden="true"></span>'
      + '<span class="pay-name">一次付清</span>'
      + '<span class="pay-amount">' + fullAmount + '</span>'
      + '<p class="pay-desc">交付时不需要再付款，到店直接验机取机。</p>'
      + '</button>'
      + '</div>';

    if (disabled) {
      html += '<button type="button" class="btn-primary" disabled>' + esc(options.blockLabel || '暂不能付款') + '</button>';
    } else {
      html += '<button type="button" class="btn-primary" data-demo="pay">'
        + (selected === 'full' ? '确认支付全款 ' + fullAmount : '确认支付定金 ' + depositAmount)
        + '</button>';
    }

    if (options.footHint) html += '<p class="foot-note" style="margin-top:12px;padding-top:0;border-top:0">' + options.footHint + '</p>';

    return html + '</section>';
  }

  function infoWarranty(quote) {
    return '<div class="info"><h2 class="info-title">质保</h2><ul class="info-list">'
      + quote.warranty.map(function (item) {
        return '<li><span class="v">' + esc(item) + '</span></li>';
      }).join('')
      + '</ul></div>';
  }

  function infoDelivery(quote) {
    var d = quote.delivery;
    return '<div class="info"><h2 class="info-title">交付</h2><ul class="info-list">'
      + '<li><span class="k">方式</span><span class="v">' + esc(d.method) + '</span></li>'
      + '<li><span class="k">送货</span><span class="v">' + esc(d.free) + '<br>' + esc(d.note) + '</span></li>'
      + '<li><span class="k">预计</span><span class="v">' + esc(d.eta) + '</span></li>'
      + '<li><span class="k">地点</span><span class="v">' + esc(d.place) + '</span></li>'
      + '</ul></div>';
  }

  function infoStore() {
    return '<div class="info"><h2 class="info-title">联系门店</h2><ul class="info-list">'
      + '<li><span class="k">门店</span><span class="v">' + esc(STORE.name) + '</span></li>'
      + '<li><span class="k">电话</span><span class="v num">' + esc(STORE.phone) + '</span></li>'
      + '<li><span class="k">营业</span><span class="v">' + esc(STORE.hours) + '</span></li>'
      + '</ul>'
      + '<button type="button" class="btn-ghost" data-demo="contact">有问题，联系门店客服</button>'
      + '</div>';
  }

  function footHtml() {
    return '<div class="foot-note">'
      + '<p>报价不锁定库存，以门店确认到货后为准；未付款不会排产。</p>'
      + '<p>最终金额以门店确认与交付清单为准。</p>'
      + '<p>流程原型 · 虚构数据，不会产生真实交易。</p>'
      + '</div>';
  }

  function statePageHtml(art, title, desc, actions, fine) {
    return '<div class="state">' + ART[art]
      + '<h1 class="state-title">' + esc(title) + '</h1>'
      + '<p class="state-desc">' + desc + '</p>'
      + '<div class="state-actions">' + actions + '</div>'
      + (fine ? '<p class="state-fine">' + fine + '</p>' : '')
      + '</div>';
  }

  /* ================= 状态渲染 ================= */

  function detailHtml(quote, options) {
    var computed = compute(quote);
    return '<div class="screen-inner">'
      + headHtml(quote, options.badge)
      + (options.notice || '')
      + linesHtml(quote, computed)
      + sumHtml(quote, computed)
      + payHtml(quote, computed, options.pay || {})
      + infoWarranty(quote)
      + infoDelivery(quote)
      + infoStore()
      + footHtml()
      + '</div>';
  }

  function renderState() {
    var quote = quoteFor(viewingVersion);

    switch (state) {
      case 'loading':
        return '<div class="screen-inner">'
          + '<div class="sk"><div class="sk-line sk-w40"></div><div class="sk-line sk-w70"></div>'
          + '<div class="sk-line sk-w55"></div></div>'
          + '<div class="sk-hairline"></div>'
          + '<div class="sk"><div class="sk-block"></div><div class="sk-block"></div>'
          + '<div class="sk-block"></div></div></div>'
          + '<p class="sr-only">正在加载这份报价</p>';

      case 'error':
        return statePageHtml('alert', '没能打开这份报价',
          '网络或服务暂时不可用。可以重试；如果一直打不开，直接把单号发给门店。',
          '<button type="button" class="btn-primary" data-demo="retry">重新加载</button>'
          + '<button type="button" class="btn-ghost" data-demo="contact">联系门店</button>',
          '单号 ' + esc(quote.id));

      case 'auth':
        return statePageHtml('lock', '验证手机号后查看',
          '这份报价只对下单时预留的手机号开放。验证之后会直接回到这一份配置单。',
          '<button type="button" class="btn-primary" data-demo="auth">用微信手机号验证（演示）</button>'
          + '<button type="button" class="btn-ghost" data-demo="contact">联系门店</button>',
          '验证只用于确认这份报价归你，不会向其他人展示报价内容。');

      case 'forbidden':
        return statePageHtml('lock', '这份报价不属于当前账号',
          '报价只对下单时预留的手机号开放。如果你确实收到了门店发来的链接，请用同一个手机号登录查看。',
          '<button type="button" class="btn-primary" data-demo="auth">换手机号重新验证</button>'
          + '<button type="button" class="btn-ghost" data-demo="contact">联系门店</button>',
          '为保护客户隐私，这里不会显示这份报价的任何内容。');

      case 'notfound':
        return statePageHtml('search', '没有找到这份报价',
          '链接可能已经失效，或者门店已经删除了这份配置单。可以让门店重新发一次。',
          '<button type="button" class="btn-primary" data-demo="contact">联系门店</button>',
          '不会向其他人透露这份报价是否存在。');

      case 'expired':
        return detailHtml(quote, {
          badge: '<span class="badge badge-warn">报价已过期</span>',
          notice: '<div class="notice notice-warn">'
            + '<p class="notice-title">这份报价的有效期到 ' + esc(quote.validUntil) + ' 已经结束</p>'
            + '<p class="notice-desc">配件价格随行情变动，超期报价不能直接付款。'
            + '联系门店重新确认，我们会发一份新的给你。</p></div>',
          pay: { disabled: true, blockLabel: '报价已过期，不能付款' }
        });

      case 'withdrawn':
        return '<div class="screen-inner">'
          + headHtml(quote, '<span class="badge badge-danger">门店已撤回</span>')
          + '<div class="notice notice-danger">'
          + '<p class="notice-title">门店撤回了这份报价</p>'
          + '<p class="notice-desc">撤回之后不能再付款，逐项明细也不再展示。'
          + '如果还想按这套配置装机，请联系门店重新开单。</p></div>'
          + '<div class="sum">'
          + '<div class="sum-row sum-row-muted"><span>报价单号</span><span class="v">' + esc(quote.id) + '</span></div>'
          + '<div class="sum-row sum-row-muted"><span>撤回前版本</span><span class="v">v' + quote.version + '</span></div>'
          + '</div>'
          + '<button type="button" class="btn-primary" data-demo="contact">联系门店重新开单</button>'
          + infoStore()
          + footHtml()
          + '</div>';

      case 'updated':
        return detailHtml(quote, {
          badge: '<span class="badge badge-warn">门店已出新版本</span>',
          notice: '<div class="notice notice-warn">'
            + '<p class="notice-title">你正在看的是 v' + quote.version + '，门店已经发出 v3</p>'
            + '<p class="notice-desc">配置和价格可能已经变化。为免按旧价格付款，'
            + '请先看最新版本，再决定付不付。</p></div>',
          pay: {
            disabled: true,
            blockLabel: '请先查看最新版本',
            footHint: '<button type="button" class="btn-ghost" style="margin-top:0" data-demo="latest">查看最新版本 v3</button>'
          }
        });

      case 'deposit':
        return detailHtml(quote, {
          badge: '<span class="badge badge-demo">演示：已下定金</span>',
          notice: '<div class="notice notice-demo">'
            + '<p class="notice-title">演示状态 · 模拟已付定金，不是真实到账</p>'
            + '<p class="notice-desc">真实支付要等后续卡片接入服务端下单与回调核验。'
            + '这里只用来走查「付了定金之后顾客看到什么」。</p></div>',
          pay: {
            disabled: true,
            blockLabel: '定金已付，等待排产'
          }
        });

      case 'valid':
      default:
        return detailHtml(quote, {
          badge: '<span class="badge badge-await">待你确认</span>',
          notice: (viewingVersion >= 3
            ? '<div class="notice notice-ok"><p class="notice-title">这是门店刚发出的最新版本 v3</p>'
              + '<p class="notice-desc">显卡价格比 v2 高 ¥100.00，其余配置不变。</p></div>'
            : ''),
          pay: {}
        });
    }
  }

  /* ================= 演示弹层 ================= */

  function openDialog(title, bodyHtml, actions) {
    dialogTitleEl.textContent = title;
    dialogBodyEl.innerHTML = bodyHtml;
    dialogActionsEl.innerHTML = '';
    (actions && actions.length ? actions : [{ label: '知道了' }]).forEach(function (action) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = action.ghost ? 'btn-ghost' : 'btn-primary';
      button.textContent = action.label;
      button.addEventListener('click', function () {
        dialogEl.close();
        if (action.onClick) action.onClick();
      });
      dialogActionsEl.appendChild(button);
    });
    dialogEl.showModal();
    var first = dialogActionsEl.querySelector('button');
    if (first) first.focus();
  }

  function payingLabel(computed) {
    return plan === 'full' ? '全款 ' + money(computed.payable) : '定金 ' + money(computed.deposit);
  }

  function handleDemoAction(action) {
    var computed = compute(quoteFor(viewingVersion));

    if (action === 'pay') {
      openDialog('支付尚未接通', '<p>你选的是<strong>' + esc(payingLabel(computed)) + '</strong>。</p>'
        + '<p>这是流程原型，<strong>不会发起真实微信支付，也不会扣款</strong>。'
        + '真实支付要等后续卡片接入服务端下单、金额核验与回调确认；'
        + '到账与否以服务端为准，前端显示成功不算数。</p>'
        + '<p>这一步能确认的只是：单价明细、应付金额和两种付款方式已经定下来了。</p>');
      return;
    }

    if (action === 'contact') {
      openDialog('门店联系方式', '<p>' + esc(STORE.name) + '<br>' + esc(STORE.phone) + '<br>' + esc(STORE.hours) + '</p>'
        + '<p>原型<strong>不会真的拨号或发送消息</strong>；真实版本会走小程序的客服消息。</p>');
      return;
    }

    if (action === 'auth') {
      openDialog('演示：手机号验证', '<p>真实版本会用微信手机号快速验证，把顾客身份和这份报价绑定，'
        + '再按身份过滤能看的内容。</p>'
        + '<p>原型<strong>不会真的验证，也不会保存任何身份信息</strong>。</p>',
        [{ label: '继续演示：验证通过', onClick: function () { go('valid'); } }, { label: '返回', ghost: true }]);
      return;
    }

    if (action === 'retry') {
      openDialog('演示：重新加载', '<p>原型是本地页面，不会真的请求服务端。</p>'
        + '<p>真实版本会带着这份报价的分享凭证重新拉取，并核验是不是仍然可支付的最新版本。</p>');
      return;
    }

    if (action === 'latest') {
      viewingVersion = 3;
      plan = 'deposit';
      go('valid');
      return;
    }
  }

  /* ================= 控制台与路由 ================= */

  /** 顾客链接的形状：#/q/<单号>?t=<凭证>&state=<演示状态>&budget=<演示预算档>。 */
  function quoteHash(nextState) {
    return '#/q/' + QUOTE.id + '?t=' + token
      + '&state=' + (nextState || state) + '&budget=' + budgetLevel;
  }

  function shareLink(nextState) {
    return location.origin + location.pathname + quoteHash(nextState);
  }

  function activeState() {
    for (var i = 0; i < STATES.length; i++) {
      if (STATES[i].key === state) return STATES[i];
    }
    return STATES[0];
  }

  function paint() {
    var keepScroll = screenEl.scrollTop;
    screenEl.innerHTML = renderState();

    Array.prototype.forEach.call(statesEl.querySelectorAll('[data-state]'), function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-state') === state));
    });

    Array.prototype.forEach.call(budgetsEl.querySelectorAll('[data-budget]'), function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-budget') === budgetLevel));
    });

    var meta = activeState();
    shareInput.value = shareLink(state);
    stageNoteEl.textContent = '当前状态：' + meta.label + ' —— ' + meta.note
      + '｜顾客预算：' + BUDGETS[budgetLevel].label;
    chromeTitleEl.textContent = '专属报价单 v' + viewingVersion;

    if (state === 'loading') screenEl.scrollTop = 0;
    else screenEl.scrollTop = keepScroll;
  }

  function go(nextState, options) {
    if (nextState) state = nextState;
    if (!options || !options.keepScroll) screenEl.scrollTop = 0;
    paint();
    syncHash();
  }

  function syncHash() {
    var solo = document.body.classList.contains('solo');
    if (!solo) return;
    var next = quoteHash(state);
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  function readHash() {
    var raw = location.hash.replace(/^#\/?/, '');
    var solo = raw.indexOf('q/') === 0;
    document.body.classList.toggle('solo', solo);
    if (!solo) return;
    var parts = raw.split('?');
    var params = new URLSearchParams(parts[1] || '');
    var wanted = params.get('state') || 'valid';
    var known = STATES.some(function (item) { return item.key === wanted; });
    state = known ? wanted : 'valid';
    token = params.get('t') || token;
    var wantedBudget = params.get('budget');
    budgetLevel = BUDGETS[wantedBudget] ? wantedBudget : 'enough';
    viewingVersion = 2;
    plan = 'deposit';
  }

  function buildStateButtons() {
    statesEl.innerHTML = STATES.map(function (item) {
      return '<button type="button" class="state-btn" data-state="' + item.key + '" aria-pressed="false">'
        + esc(item.label) + '</button>';
    }).join('');
  }

  function buildBudgetButtons() {
    budgetsEl.innerHTML = Object.keys(BUDGETS).map(function (key) {
      return '<button type="button" class="state-btn" data-budget="' + key + '" aria-pressed="false">'
        + esc(BUDGETS[key].label) + '</button>';
    }).join('');
  }

  /* ================= 事件 ================= */

  buildStateButtons();
  buildBudgetButtons();

  statesEl.addEventListener('click', function (event) {
    var button = event.target.closest('[data-state]');
    if (!button) return;
    viewingVersion = 2;
    plan = 'deposit';
    go(button.getAttribute('data-state'));
  });

  budgetsEl.addEventListener('click', function (event) {
    var button = event.target.closest('[data-budget]');
    if (!button) return;
    // 只换预算档，不重置正在看的版本与付款方式。
    budgetLevel = button.getAttribute('data-budget');
    paint();
  });

  screenEl.addEventListener('click', function (event) {
    var planButton = event.target.closest('[data-plan]');
    if (planButton && !planButton.disabled) {
      plan = planButton.getAttribute('data-plan');
      paint();
      return;
    }
    var actionButton = event.target.closest('[data-demo]');
    if (actionButton) handleDemoAction(actionButton.getAttribute('data-demo'));
  });

  document.getElementById('btnOpen').addEventListener('click', function () {
    location.hash = quoteHash(state);
  });

  document.getElementById('btnCopy').addEventListener('click', function () {
    shareInput.select();
    var done = function () {
      var button = document.getElementById('btnCopy');
      button.textContent = '已复制';
      setTimeout(function () { button.textContent = '复制'; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(shareInput.value).then(done, done);
    } else {
      done();
    }
  });

  document.getElementById('btnBack').addEventListener('click', function () {
    if (document.body.classList.contains('solo')) {
      location.hash = '';
      document.body.classList.remove('solo');
      paint();
    } else {
      screenEl.focus();
    }
  });

  window.addEventListener('hashchange', function () {
    readHash();
    paint();
  });

  readHash();
  paint();
})();
