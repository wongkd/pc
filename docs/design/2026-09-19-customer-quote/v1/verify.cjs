/**
 * Q01 顾客报价原型 · 本地验收。
 *
 * 覆盖两件事：
 *   A. 控制台形态（评审用）—— 布局在 7 个视口不横向溢出、交互可点、键盘可用；
 *   B. 链接形态（#/q/... 直接打开）—— 10 个状态的渲染，其中
 *      未登录 / 无权访问 / 链接失效 / 加载中 / 加载失败 / 已撤回 六态
 *      **不得出现任何金额、配件名称与预算**，这是本卡的核心安全断言。
 *
 * 只用本机 Edge 与本原型目录，不连后端、不连生产。
 * 结果写入 verification.json，截图写入 screenshots/。
 *
 * 运行：node docs/design/2026-09-19-customer-quote/v1/verify.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

const ROOT = __dirname;
const PORT = 8819;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'screenshots');
const QUOTE_HASH = (state, budget) =>
  `#/q/BJ-2026-0919-001?t=demo_9f3c7a&state=${state}&budget=${budget || 'enough'}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png'
};

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];

/** 这些状态下，顾客一个字的价格和配置都不该看到。 */
const BLIND_STATES = ['auth', 'forbidden', 'notfound', 'loading', 'error', 'withdrawn'];

/** 预期金额（分 → 元字符串），与 quote.js 的虚构数据对应。 */
const EXPECTED = {
  v2: { hardware: '¥8,799.00', service: '¥350.00', total: '¥8,649.00', deposit: '¥1,297.35', balance: '¥7,351.65' },
  v3: { total: '¥8,749.00', deposit: '¥1,312.35' },
  // 应付 ¥8,649 对两档预算：够用时低 ¥3,351，不够时超 ¥649
  budget: {
    enough: '¥12,000.00',
    enoughDiff: '比预算低 ¥3,351.00',
    enoughPercent: '72.1%',
    tight: '¥8,000.00',
    tightDiff: '超出预算 ¥649.00',
    tightPercent: '108.1%'
  }
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      let pathname;
      try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
      catch { response.writeHead(400); return response.end('Bad request'); }
      if (pathname === '/') pathname = '/index.html';
      const file = path.resolve(ROOT, '.' + pathname);
      const relative = path.relative(ROOT, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403); return response.end('Forbidden'); }
      fs.readFile(file, (error, data) => {
        if (error) { response.writeHead(404); return response.end('Not found'); }
        response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        response.end(data);
      });
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function number(text) {
  return Number(String(text).replace(/[^\d.-]/g, ''));
}

async function verify() {
  const puppeteer = await import('puppeteer');
  const executablePath = EDGE_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  assert.ok(executablePath, '本机没有找到 Edge，无法做浏览器验收');

  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  const browser = await puppeteer.launch({ executablePath, headless: true });

  const report = {
    scope: '本地网页原型；不代表微信小程序、真机、后端或真实支付已验收',
    checkedAt: new Date().toISOString(),
    layouts: [],
    states: [],
    interactions: [],
    failures: [],
    browserErrors: []
  };

  const pass = (description) => report.interactions.push(description);
  const expect = (condition, description) => {
    try {
      assert.ok(condition, description);
      pass(description);
    } catch (error) {
      report.failures.push(description);
      console.error('FAIL:', description);
    }
  };

  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => report.browserErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') report.browserErrors.push('console: ' + message.text());
    });

    const open = async (width, height, hash) => {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await page.goto(BASE + '/index.html' + (hash || ''), { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => document.fonts && document.fonts.ready);
    };
    const shoot = (name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });

    /* ---------- A. 布局 ---------- */

    for (const [width, height] of [[320, 740], [375, 812], [390, 844], [430, 932], [768, 1024], [1366, 768], [1440, 1000]]) {
      await open(width, height);
      const layout = await page.evaluate(() => {
        const device = document.getElementById('device');
        return {
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          deviceOverflow: device.scrollWidth > device.clientWidth + 1,
          screenOverflow: document.getElementById('screen').scrollWidth > document.getElementById('screen').clientWidth + 1,
          deviceWidth: Math.round(device.getBoundingClientRect().width)
        };
      });
      expect(!layout.pageOverflow, `${width}×${height} 页面无横向溢出`);
      expect(!layout.deviceOverflow, `${width}×${height} 手机框无横向溢出`);
      expect(!layout.screenOverflow, `${width}×${height} 报价页面无横向溢出`);
      report.layouts.push({ width, height, ...layout });
      if (width <= 430) await shoot(`customer-valid-${width}`);
    }

    /* ---------- B. 链接形态：各状态渲染与信息隔离 ---------- */

    const STATE_LABELS = {
      valid: '待你确认',
      loading: null,
      error: '没能打开这份报价',
      auth: '验证手机号后查看',
      forbidden: '这份报价不属于当前账号',
      notfound: '没有找到这份报价',
      expired: '报价已过期',
      withdrawn: '门店撤回了这份报价',
      updated: '你正在看的是 v2',
      deposit: '演示：已下定金'
    };

    for (const stateName of Object.keys(STATE_LABELS)) {
      await open(390, 844, QUOTE_HASH(stateName));
      const info = await page.evaluate(() => {
        const body = document.body.classList.contains('solo');
        const text = document.getElementById('screen').innerText;
        return {
          solo: body,
          consoleHidden: getComputedStyle(document.getElementById('console')).display === 'none',
          text,
          overflow: document.getElementById('screen').scrollWidth > document.getElementById('screen').clientWidth + 1
        };
      });

      expect(info.solo, `state=${stateName} 链接形态隐藏演示控制台`);
      expect(info.consoleHidden, `state=${stateName} 控制台不可见`);
      expect(!info.overflow, `state=${stateName} 无横向溢出`);

      const label = STATE_LABELS[stateName];
      if (label) expect(info.text.includes(label), `state=${stateName} 呈现「${label}」`);

      // 核心：这六个状态一个价格都不能出现。
      if (BLIND_STATES.includes(stateName)) {
        expect(!info.text.includes('¥'), `state=${stateName} 不出现任何金额`);
        expect(!info.text.includes('i5-14600KF'), `state=${stateName} 不出现配件明细`);
        expect(!info.text.includes('4060'), `state=${stateName} 不出现型号信息`);
        // 预算也是顾客的钱，六态里一个字都不能露。
        expect(!info.text.includes('预算'), `state=${stateName} 不出现预算字样`);
      } else {
        expect(info.text.includes('¥'), `state=${stateName} 正常展示金额`);
      }

      report.states.push({ state: stateName, blind: BLIND_STATES.includes(stateName), ok: true });
      await shoot(`state-${stateName}-390`);
    }

    /* ---------- C. 单价明细 ---------- */

    await open(390, 844, QUOTE_HASH('valid'));
    const detail = await page.evaluate(() => {
      const lines = [...document.querySelectorAll('.line')];
      return {
        count: lines.length,
        calcs: lines.map((line) => line.querySelector('.line-calc').textContent.trim()),
        subs: lines.map((line) => line.querySelector('.line-sub').textContent.trim()),
        names: lines.map((line) => line.querySelector('.line-name').textContent.trim()),
        tags: [...document.querySelectorAll('.line .tag')].map((tag) => tag.textContent.trim()),
        text: document.getElementById('screen').innerText
      };
    });

    expect(detail.count === 12, `明细共 12 行（10 件硬件 + 2 项服务），实际 ${detail.count}`);
    expect(detail.calcs.every((item) => /^¥[\d,]+\.\d{2} × \d+$/.test(item)), '每行都写清「单价 × 数量」');
    expect(detail.subs.every((item) => /^¥[\d,]+\.\d{2}$/.test(item)), '每行都写清小计');
    expect(detail.names[0] === '英特尔 i5-14600KF', '第一行是 CPU');
    expect(detail.tags.includes('本店二手'), '二手件有来源标记');
    expect(detail.tags.includes('质保 3 个月'), '二手件写 3 个月质保');
    expect(detail.tags.includes('顾客自带'), '客供件有来源标记');
    expect(detail.tags.includes('不提供质保'), '客供件写明不质保');
    expect(detail.text.includes('¥0.00'), '客供件单价写 ¥0.00，不写成空白');

    /* ---------- D. 金额口径 ---------- */

    const amounts = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.sum-row, .sum-total')].map((row) => ({
        key: row.querySelector('span').textContent.trim(),
        value: row.querySelector('.v').textContent.trim()
      }));
      const options = [...document.querySelectorAll('.pay-option')].map((node) => ({
        plan: node.getAttribute('data-plan'),
        amount: node.querySelector('.pay-amount').textContent.trim(),
        desc: node.querySelector('.pay-desc').textContent.trim()
      }));
      return { rows, options };
    });

    const find = (key) => (amounts.rows.find((row) => row.key === key) || {}).value;
    expect(find('配件合计') === EXPECTED.v2.hardware, `配件合计 ${EXPECTED.v2.hardware}`);
    expect(find('服务与调试') === EXPECTED.v2.service, `服务与调试 ${EXPECTED.v2.service}`);
    expect(find('门店优惠') === '−¥500.00', '门店优惠写 −¥500.00');
    expect(find('应付总额') === EXPECTED.v2.total, `应付总额 ${EXPECTED.v2.total}`);

    const depositOption = amounts.options.find((option) => option.plan === 'deposit');
    const fullOption = amounts.options.find((option) => option.plan === 'full');
    expect(depositOption.amount === EXPECTED.v2.deposit, `定金 ${EXPECTED.v2.deposit}`);
    expect(depositOption.desc.includes(EXPECTED.v2.balance), `定金说明含尾款 ${EXPECTED.v2.balance}`);
    expect(depositOption.desc.includes('不退'), '定金写明不退');
    expect(fullOption.amount === EXPECTED.v2.total, `全款 ${EXPECTED.v2.total}`);

    // 恒等式核对：配件 + 服务 − 优惠 = 应付；定金 + 尾款 = 应付
    const hardware = number(find('配件合计'));
    const service = number(find('服务与调试'));
    const discount = number(find('门店优惠'));
    const total = number(find('应付总额'));
    const deposit = number(depositOption.amount);
    const balance = number(EXPECTED.v2.balance);
    expect(Math.round((hardware + service - discount) * 100) === Math.round(total * 100), '配件 + 服务 − 优惠 = 应付总额');
    expect(Math.round((deposit + balance) * 100) === Math.round(total * 100), '定金 + 尾款 = 应付总额');

    /* ---------- D2. 预算对照条 ---------- */

    const readCompare = () => page.evaluate(() => {
      const node = document.querySelector('.cmp');
      if (!node) return { exists: false };
      const rows = [...node.querySelectorAll('.cmp-row')];
      const verdict = node.querySelector('.cmp-verdict');
      return {
        exists: true,
        over: node.classList.contains('cmp-over'),
        budgetLabel: rows[0].querySelector('span').textContent.trim(),
        budgetValue: rows[0].querySelector('.v').textContent.trim(),
        verdictLeft: verdict.querySelector('span').textContent.trim(),
        verdictRight: verdict.querySelector('.v').textContent.trim(),
        fillWidth: node.querySelector('.cmp-fill').style.width,
        aria: node.querySelector('.cmp-bar').getAttribute('aria-label')
      };
    });

    const enoughCmp = await readCompare();
    expect(enoughCmp.exists, '汇总块里有预算对照条');
    expect(enoughCmp.budgetLabel === '你的预算', '预算行写明这是顾客的预算');
    expect(enoughCmp.budgetValue === EXPECTED.budget.enough, `预算显示 ${EXPECTED.budget.enough}`);
    expect(enoughCmp.verdictLeft === '本单 ' + EXPECTED.v2.total, '对照行写明本单金额');
    expect(enoughCmp.verdictRight === EXPECTED.budget.enoughDiff, `预算够用时写「${EXPECTED.budget.enoughDiff}」`);
    expect(!enoughCmp.over, '预算够用时不用警示色');
    expect(enoughCmp.fillWidth === EXPECTED.budget.enoughPercent,
      `进度按 应付/预算 算，预期 ${EXPECTED.budget.enoughPercent}，实际 ${enoughCmp.fillWidth}`);
    expect(enoughCmp.aria.includes(EXPECTED.budget.enoughPercent), '进度条有无障碍描述');
    expect(Math.round((number(EXPECTED.v2.total) / number(EXPECTED.budget.enough)) * 1000) / 10 === 72.1,
      '预算占比算式自洽（应付 ÷ 预算）');

    await open(390, 844, QUOTE_HASH('valid', 'tight'));
    const tightCmp = await readCompare();
    expect(tightCmp.budgetValue === EXPECTED.budget.tight, `切到超预算档显示 ${EXPECTED.budget.tight}`);
    expect(tightCmp.verdictRight === EXPECTED.budget.tightDiff, `超预算时写「${EXPECTED.budget.tightDiff}」`);
    expect(tightCmp.over, '超预算时换成警示色');
    expect(tightCmp.fillWidth === '100%', '超预算时进度条封顶 100%，不撑破容器');
    expect(tightCmp.aria.includes(EXPECTED.budget.tightPercent),
      `超预算的无障碍描述保留真实占比 ${EXPECTED.budget.tightPercent}`);
    expect(!tightCmp.verdictRight.includes('省'), '对照条不写「省下多少」，避免暗示还有余量可花');

    // 预算条只出现在能看见金额的状态里，与六态断言互为反证
    for (const stateName of ['expired', 'updated', 'deposit']) {
      await open(390, 844, QUOTE_HASH(stateName));
      expect(await page.evaluate(() => !!document.querySelector('.cmp')), `state=${stateName} 保留预算对照条`);
    }

    // 最窄视口下两个 span 仍要在同一行，否则「本单」和结论会被挤散
    await open(320, 740, QUOTE_HASH('valid'));
    const narrowRow = await page.evaluate(() => {
      const spans = [...document.querySelector('.cmp-verdict').querySelectorAll('span')];
      return { sameLine: spans[0].offsetTop === spans[1].offsetTop, tops: spans.map((s) => s.offsetTop) };
    });
    expect(narrowRow.sameLine, `320px 下「本单」与结论仍在同一行（实际 top ${narrowRow.tops.join(' / ')}）`);

    await open(390, 844, QUOTE_HASH('valid'));

    /* ---------- E. 付款未接通 ---------- */

    await page.click('[data-demo="pay"]');
    let dialog = await page.evaluate(() => {
      const node = document.getElementById('demoDialog');
      return { open: node.open, title: document.getElementById('demoDialogTitle').textContent, body: document.getElementById('demoDialogBody').innerText };
    });
    expect(dialog.open, '点付款会弹出说明层');
    expect(dialog.title.includes('支付尚未接通'), '弹层标题写明支付尚未接通');
    expect(dialog.body.includes('不会发起真实微信支付'), '弹层说明不会真实扣款');
    expect(dialog.body.includes(EXPECTED.v2.deposit), '弹层回显当前选中的定金金额');
    await shoot('dialog-pay-390');

    await page.keyboard.press('Escape');
    dialog = await page.evaluate(() => document.getElementById('demoDialog').open);
    expect(dialog === false, 'Escape 可关闭弹层');

    // 切到全款
    await page.click('[data-plan="full"]');
    const fullButton = await page.$eval('.btn-primary', (node) => node.textContent.trim());
    expect(fullButton === '确认支付全款 ' + EXPECTED.v2.total, '切全款后主按钮金额跟着变');
    await page.click('[data-plan="deposit"]');
    const depositButton = await page.$eval('.btn-primary', (node) => node.textContent.trim());
    expect(depositButton === '确认支付定金 ' + EXPECTED.v2.deposit, '切回定金后主按钮金额跟着变');

    // 键盘可用：聚焦后按空格应能选中
    await page.focus('[data-plan="full"]');
    await page.keyboard.press('Space');
    const byKeyboard = await page.$eval('[data-plan="full"]', (node) => node.getAttribute('aria-checked'));
    expect(byKeyboard === 'true', '键盘可以选中付款方式');
    await page.click('[data-plan="deposit"]');

    /* ---------- F. 版本与异常分支 ---------- */

    await open(390, 844, QUOTE_HASH('updated'));
    const updated = await page.evaluate(() => ({
      primaryDisabled: document.querySelector('.btn-primary').disabled,
      label: document.querySelector('.btn-primary').textContent.trim(),
      hasLatest: !!document.querySelector('[data-demo="latest"]'),
      text: document.getElementById('screen').innerText
    }));
    expect(updated.primaryDisabled, '版本已更新时主付款按钮不可点');
    expect(updated.label.includes('请先查看最新版本'), '版本已更新时按钮写明原因');
    expect(updated.hasLatest, '版本已更新时提供「查看最新版本」入口');
    expect(updated.text.includes('v3'), '版本已更新时说明新版是 v3');

    await page.click('[data-demo="latest"]');
    const afterLatest = await page.evaluate(() => ({
      text: document.getElementById('screen').innerText,
      primaryDisabled: document.querySelector('.btn-primary').disabled
    }));
    expect(afterLatest.text.includes('最新版本 v3'), '查看最新版本后进入 v3');
    expect(afterLatest.text.includes(EXPECTED.v3.total), `v3 应付总额 ${EXPECTED.v3.total}`);
    expect(afterLatest.primaryDisabled === false, 'v3 可以正常付款');

    await open(390, 844, QUOTE_HASH('expired'));
    const expired = await page.evaluate(() => ({
      hasLines: document.querySelectorAll('.line').length,
      disabled: document.querySelector('.btn-primary').disabled,
      label: document.querySelector('.btn-primary').textContent.trim()
    }));
    expect(expired.hasLines === 12, '过期报价仍然保留明细，方便顾客核对');
    expect(expired.disabled, '过期报价不能付款');
    expect(expired.label.includes('过期'), '过期报价说明为什么不能付');

    await open(390, 844, QUOTE_HASH('deposit'));
    const depositState = await page.evaluate(() => ({
      disabled: document.querySelector('.btn-primary').disabled,
      text: document.getElementById('screen').innerText
    }));
    expect(depositState.disabled, '已付定金状态主按钮不可重复支付');
    expect(depositState.text.includes('不是真实到账'), '模拟付款明确标注不是真实到账');

    /* ---------- G. 顾客侧不得出现的内部信息 ---------- */

    for (const stateName of ['valid', 'expired', 'updated', 'deposit']) {
      await open(390, 844, QUOTE_HASH(stateName));
      const leak = await page.evaluate(() => {
        const text = document.getElementById('screen').innerText;
        return {
          cost: text.includes('成本'),
          supplier: text.includes('供应商'),
          margin: text.includes('毛利') || text.includes('进价'),
          otherCustomer: text.includes('李先生') || text.includes('林女士'),
          dingjin: text.includes('订金')
        };
      });
      expect(!leak.cost, `state=${stateName} 不出现成本`);
      expect(!leak.supplier, `state=${stateName} 不出现供应商`);
      expect(!leak.margin, `state=${stateName} 不出现进价/毛利`);
      expect(!leak.otherCustomer, `state=${stateName} 不出现其他顾客`);
      expect(!leak.dingjin, `state=${stateName} 写「定金」不写「订金」`);
    }

    /* ---------- H. 控制台与链接互转 ---------- */

    await open(1366, 768);
    const share = await page.$eval('#shareUrl', (node) => node.value);
    expect(share.includes('#/q/BJ-2026-0919-001?t='), '控制台给出带凭证的专属链接');
    expect(share.includes('state=valid'), '分享链接带当前状态参数');
    await shoot('console-desktop-1366');

    await page.click('#btnOpen');
    await page.waitForFunction(() => document.body.classList.contains('solo'));
    const soloChrome = await page.evaluate(() => ({
      chromeHidden: getComputedStyle(document.getElementById('console')).display === 'none',
      width: Math.round(document.getElementById('device').getBoundingClientRect().width)
    }));
    expect(soloChrome.chromeHidden, '打开链接后只剩顾客页面');
    await shoot('customer-valid-1440');

    await page.click('#btnBack');
    await page.waitForFunction(() => !document.body.classList.contains('solo'));
    expect(true, '顾客视角可以退回演示控制台');

    /* ---------- H2. 控制台切换预算档 ---------- */

    await page.click('[data-budget="tight"]');
    const budgetSwitch = await page.evaluate(() => ({
      pressed: document.querySelector('[data-budget="tight"]').getAttribute('aria-pressed'),
      url: document.getElementById('shareUrl').value,
      note: document.getElementById('stageNote').textContent
    }));
    expect(budgetSwitch.pressed === 'true', '控制台能切到超预算档');
    expect(budgetSwitch.url.includes('budget=tight'), '预算档写进链接参数，便于逐条走查');
    expect(budgetSwitch.note.includes('预算 ¥8,000'), '控制台状态条显示当前预算档');

    // 换预算不该把正在看的版本重置回 v2
    await page.click('[data-state="updated"]');
    await page.click('[data-demo="latest"]');
    await page.click('[data-budget="enough"]');
    const keepVersion = await page.$eval('#chromeTitle', (node) => node.textContent);
    expect(keepVersion.includes('v3'), '切预算不会把正在看的版本重置回 v2');

    await page.click('[data-state="valid"]');
    expect(await page.$eval('[data-budget="enough"]', (node) => node.getAttribute('aria-pressed')) === 'true',
      '切回够用档后按钮状态正确');

    /* ---------- I. 整页长图：评审时一眼看完信息顺序 ---------- */

    for (const stateName of ['valid', 'expired', 'updated']) {
      await open(390, 844, QUOTE_HASH(stateName));
      // 解开手机框与 stage 的固定高度 / 内部滚动，让整页一次截完。
      // 只作用于截图这一刻，原型本身的滚动行为不变。
      await page.addStyleTag({
        content: 'html,body{height:auto !important}'
          + '.stage{height:auto !important;overflow:visible !important}'
          + '.device{height:auto !important}.screen{overflow:visible !important}'
      });
      await page.screenshot({ path: path.join(SHOTS, `long-${stateName}-390.png`), fullPage: true });

      // 金额汇总、预算对照与付款区是这张卡的重点，单独出图，免得在长图里被缩得看不清。
      if (stateName === 'valid') {
        for (const [selector, name] of [['.sum', 'panel-sum-390'], ['.cmp', 'panel-cmp-390'], ['.pay-options', 'panel-pay-390']]) {
          const node = await page.$(selector);
          await node.screenshot({ path: path.join(SHOTS, name + '.png') });
        }
      }
    }
    pass('生成 valid / expired / updated 三张整页长图');

    // 超预算那一档单独出整页长图与特写，用来核对警示色与措辞
    await open(390, 844, QUOTE_HASH('valid', 'tight'));
    await page.addStyleTag({
      content: 'html,body{height:auto !important}'
        + '.stage{height:auto !important;overflow:visible !important}'
        + '.device{height:auto !important}.screen{overflow:visible !important}'
    });
    await page.screenshot({ path: path.join(SHOTS, 'long-valid-tight-390.png'), fullPage: true });
    const cmpNode = await page.$('.cmp');
    await cmpNode.screenshot({ path: path.join(SHOTS, 'panel-cmp-over-390.png') });
    pass('生成超预算档整页长图与对照条特写');
    // 长图走的是链接形态（控制台隐藏），这里回到控制台形态再继续后面几步
    await open(1366, 768);

    // 切状态时链接参数跟着变，便于逐条走查
    await page.click('[data-state="expired"]');
    const switched = await page.$eval('#shareUrl', (node) => node.value);
    expect(switched.includes('state=expired'), '切换状态后链接参数同步更新');
    const note = await page.$eval('#stageNote', (node) => node.textContent);
    expect(note.includes('报价已过期'), '控制台显示当前状态说明');

    report.passed = report.interactions.length;
    report.failed = report.failures.length;

    // 先落盘再断言：断言失败时也要能看到是哪一条、以及浏览器报了什么。
    fs.writeFileSync(path.join(ROOT, 'verification.json'), JSON.stringify(report, null, 2) + '\n');

    if (report.browserErrors.length) console.error('浏览器错误:', report.browserErrors.join(' | '));
    if (report.failures.length) console.error('未通过:', report.failures.join(' | '));
    console.log(`通过 ${report.passed} 项，失败 ${report.failed} 项，浏览器错误 ${report.browserErrors.length} 条。截图 ${fs.readdirSync(SHOTS).length} 张，见 screenshots/。`);

    assert.equal(report.browserErrors.length, 0, '浏览器无运行时错误');
    assert.equal(report.failures.length, 0, `有 ${report.failures.length} 项断言未通过`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

verify().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
