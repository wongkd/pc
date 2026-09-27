/*
 * 原型验收脚本：真实浏览器里跑一遍交互，断言四条主流程与默认值。
 *
 * 为什么要有它：原型改的是「操作顺序」，只靠肉眼看截图发现不了
 * 「保存被前置校验拦住、根本走不到核对面板」这类断链。这里把每条流写成交互断言。
 *
 * 用法（仓库根执行）：
 *   node docs/design/2026-09-27-used-parts-inventory/v1/smoke.cjs
 * 可选环境变量：
 *   EDGE_PATH  浏览器可执行文件（默认取本机 Edge）
 *   SMOKE_KEEP 设为 1 时保留临时目录，便于人工打开排错
 *
 * 退出码：全部通过 0；有失败 1；脚本自身出错 2。
 * 只读：临时目录建在系统临时区，不碰仓库、不写数据库、不联网。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HERE = __dirname;
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const ASSERTIONS = `
<script>
(function () {
  var out = [];
  var errors = [];
  window.addEventListener('error', function (e) {
    errors.push(String(e.message) + ' @line ' + e.lineno + ':' + e.colno);
  });
  function check(name, ok, extra) {
    out.push((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ::  ' + extra : ''));
  }
  function q(sel) { return document.querySelector(sel); }
  function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function click(elm) { if (!elm) throw new Error('missing element: ' + elm); elm.click(); }
  function type(elm, value) {
    elm.value = value;
    elm.dispatchEvent(new Event('input', { bubbles: true }));
    elm.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function rows() { return all('.inv-row'); }
  function rowTexts() { return rows().map(function (r) { return r.textContent.replace(/\\s+/g, ' ').trim(); }); }
  function findAct(act, attr, value) {
    return all('[data-act="' + act + '"]').filter(function (e) {
      return !attr || e.getAttribute(attr) === value;
    })[0];
  }

  try {
    /* 1. 首页逐件列表：同型号两件货各自独立 */
    check('首页列表按件呈现', rows().length >= 9, 'rows=' + rows().length);
    var cpuRows = rowTexts().filter(function (x) { return x.indexOf('i5-12400F') >= 0; });
    check('同型号两件显示为两条独立记录', cpuRows.length === 2, 'matched=' + cpuRows.length);
    check('两件成本不同且都显示',
      cpuRows.some(function (x) { return x.indexOf('430.00') >= 0; }) && cpuRows.some(function (x) { return x.indexOf('460.00') >= 0; }));
    check('两件状态不同（可售 / 待检测）',
      cpuRows.some(function (x) { return x.indexOf('可售') >= 0; }) && cpuRows.some(function (x) { return x.indexOf('待检测') >= 0; }));
    check('列表不把参考售价当二手售价', rowTexts().join(' ').indexOf('参考售价') < 0);

    /* 2. 分类与状态筛选 */
    click(findAct('set-category', 'data-category', '显卡'));
    check('分类筛选生效且不重复写类别名',
      rowTexts().every(function (x) { return x.indexOf('RTX') >= 0; }) && rows().length === 2, 'rows=' + rows().length);
    click(findAct('set-category', 'data-category', '全部配件'));
    click(findAct('set-status', 'data-status', 'inspecting'));
    check('状态筛选「待检测」只留待检测',
      all('.cell-status .badge').every(function (b) { return b.textContent === '待检测'; }), 'rows=' + rows().length);
    click(findAct('set-status', 'data-status', 'all'));

    /* 3. 登记表单默认值 */
    click(q('#btn-register'));
    check('登记面板打开并带入当前类别', /登记 CPU/.test(q('.modal-head h2').textContent), q('.modal-head h2').textContent);
    check('通用入口不预选来源', all('[data-act="set-source"][data-checked="true"]').length === 0);
    check('默认二手', (q('[data-act="set-condition"][data-checked="true"]') || {}).getAttribute
      && q('[data-act="set-condition"][data-checked="true"]').getAttribute('data-value') === 'used');
    check('默认待检测', (q('[data-act="set-inspection"][data-checked="true"]') || {}).getAttribute
      && q('[data-act="set-inspection"][data-checked="true"]').getAttribute('data-value') === 'pending');

    /* 4. 流程① 无型号档案 + 成本留空 */
    type(q('[data-field="model"]'), 'i5-13400F');
    click(findAct('set-source', 'data-value', 'opening'));
    click(q('[data-act="save-close"]'));
    check('保存后提示已登记 1 件', q('#messages').textContent.indexOf('已登记 1 件 CPU') >= 0);
    var newRow = rowTexts().filter(function (x) { return x.indexOf('i5-13400F') >= 0; })[0] || '';
    check('新件默认待检测', newRow.indexOf('待检测') >= 0, newRow);
    check('成本留空显示待确认而不是 ¥0.00', newRow.indexOf('待确认') >= 0, newRow);
    check('保存后可直接看这件配件', /i5-13400F/.test((q('.drawer-head h2') || {}).textContent || ''));
    click(findAct('close-detail'));

    /* 5. 流程④ 二手到货 */
    click(q('[data-demo="scenario-4"]'));
    check('到货场景带入来源「新买到货」',
      q('[data-act="set-source"][data-checked="true"]').getAttribute('data-value') === 'purchase');
    click(q('[data-act="save-close"]'));
    var gpuRow = rowTexts().filter(function (x) { return x.indexOf('RX 6700 XT') >= 0; })[0] || '';
    check('到货后仍然是二手', gpuRow.indexOf('二手') >= 0, gpuRow);
    check('成本按实际填的记', gpuRow.indexOf('950.00') >= 0, gpuRow);
    check('到货不等于已付款', ((q('.drawer-body') || {}).textContent || '').indexOf('没有记付款') >= 0);
    click(findAct('close-detail'));

    /* 6. 流程② 同型号第二件，先核对 */
    click(q('[data-demo="scenario-2"]'));
    click(q('[data-act="save-close"]'));
    var similar = q('#form-messages .similar');
    check('同型号保存前要求核对近期登记', similar && /同型号已经有/.test(similar.textContent));
    click(q('[data-act="ack-similar"]'));
    check('核对后新增第三件',
      rowTexts().filter(function (x) { return x.indexOf('i5-12400F') >= 0; }).length === 3);
    check('保存后打开这件配件详情', !!q('.drawer'));
    click(findAct('close-detail'));

    /* 7. SN 命中不重复建 */
    click(q('[data-demo="reset"]'));
    click(q('#btn-register'));
    var catSel = q('[data-field="category"]');
    catSel.value = '显卡';
    catSel.dispatchEvent(new Event('change', { bubbles: true }));
    type(q('[data-field="model"]'), 'RTX 3060 12G');
    click(findAct('set-source', 'data-value', 'purchase'));
    type(q('[data-field="sn"]'), 'SN3060A00317');
    click(q('[data-act="save-close"]'));
    check('SN 命中已有实物时不新增', /SN 已经登记过/.test((q('#form-messages .similar') || {}).textContent || ''));
    check('列表没有多出同 SN 记录',
      rowTexts().filter(function (x) { return x.indexOf('RTX 3060 12G') >= 0; }).length === 1);

    /* 8. 检测流转：待检测 → 可售 */
    click(q('[data-act="close-modal"]'));
    click(all('.inv-row').filter(function (r) { return r.textContent.indexOf('待检测') >= 0; })[0]);
    click(findAct('record-inspection', 'data-result', 'ok'));
    check('记录检测正常后变为可售', ((q('.drawer-body') || {}).textContent || '').indexOf('可售') >= 0);
    click(findAct('close-detail'));

    /* 9. 成本权限：关掉后列与行都没有金额 */
    click(q('[data-demo="toggle-cost"]'));
    check('无成本权限时列表不出现成本列', ((q('.inv-head') || {}).textContent || '').indexOf('成本') < 0);
    check('无成本权限时行里也没有金额', !rowTexts().some(function (x) { return x.indexOf('¥') >= 0; }));
    click(q('[data-demo="toggle-cost"]'));

    /* 10. 文案闸门：只看真实界面，对照表本身当然列着旧文案 */
    var shell = [q('.topbar'), q('.catbar-wrap'), q('#filterbar'), q('.list-wrap'), q('#overlay')]
      .map(function (e) { return e ? e.textContent : ''; }).join(' ');
    check('界面里没有旧的宣传式标题', shell.indexOf('实物收进来') < 0);
    check('界面里没有实现术语', ['整数分', '幂等', '契约'].every(function (w) { return shell.indexOf(w) < 0; }));
    check('页面标注了虚构数据', document.body.textContent.indexOf('虚构示例') >= 0);
  } catch (err) {
    out.push('ERROR ' + (err && err.stack ? err.stack : err));
  }

  var failed = out.filter(function (x) { return x.indexOf('PASS') !== 0; }).length;
  var head = 'SMOKE TOTAL=' + out.length + ' FAILED=' + failed + ' ERRORS=' + errors.length;
  document.body.innerHTML = '<pre id="smoke-out">' + head + '\\n\\n' + out.join('\\n').replace(/</g, '&lt;')
    + (errors.length ? '\\n\\n-- 运行时错误 --\\n' + errors.join('\\n') : '') + '</pre>';
  document.title = head;
}());
</script>
`;

function main() {
  if (!fs.existsSync(EDGE)) {
    console.error('找不到浏览器：' + EDGE + '（可用 EDGE_PATH 指定）');
    process.exit(2);
  }
  const assets = ['index.html', 'styles.css', 'data.js', 'app.js'];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'used-parts-smoke-'));
  for (const name of assets) {
    fs.copyFileSync(path.join(HERE, name), path.join(work, name));
  }
  const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8').replace('</body>', ASSERTIONS + '</body>');
  fs.writeFileSync(path.join(work, 'smoke.html'), html, 'utf8');

  const url = 'file:///' + path.join(work, 'smoke.html').replace(/\\/g, '/');
  const run = spawnSync(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
    '--virtual-time-budget=8000', '--dump-dom', url,
  ], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 });

  const dom = run.stdout || '';
  const match = dom.match(/<pre id="smoke-out">([\s\S]*?)<\/pre>/);
  if (!match) {
    console.error('没有拿到检查结果。DOM 长度=' + dom.length + '；临时目录=' + work);
    process.exit(2);
  }
  const report = match[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  console.log(report);
  if (!process.env.SMOKE_KEEP) fs.rmSync(work, { recursive: true, force: true });
  else console.log('临时目录保留：' + work);

  const failed = /FAILED=0 ERRORS=0/.test(report.split('\n')[0]);
  process.exit(failed ? 0 : 1);
}

main();
