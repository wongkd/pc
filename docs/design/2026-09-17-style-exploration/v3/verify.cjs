const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

async function verify() {
  const puppeteer = await import('puppeteer');
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const report = { scope: 'Local browser prototype only; no backend, WeChat or native App validation', layouts: [], interactions: [], errors: [] };
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => { report.errors.push(error.message); console.error('Browser error:', error.message); });
    const open = async (width, height) => {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await page.goto('http://127.0.0.1:8818/v3/index.html', { waitUntil: 'networkidle2' });
      await page.evaluate(() => document.fonts.ready);
    };
    const capture = (name) => page.screenshot({ path: path.join(__dirname, name + '.png'), fullPage: false });
    const check = (condition, description) => { assert.ok(condition, description); report.interactions.push(description); };

    await open(1440, 1000);
    await capture('hybrid-desktop');
    await page.click('[data-view="devices"]');
    await capture('hybrid-devices-desktop');
    await open(390, 844);
    await capture('hybrid-mobile');
    await page.click('[data-order="chen"]');
    await capture('hybrid-mobile-detail');
    if (process.argv.includes('--render-only')) { console.log('Rendered 4 screenshots.'); return; }

    for (const [width, height] of [[1366, 768], [1440, 1000], [1024, 768], [768, 1024], [320, 740], [375, 812], [390, 844], [430, 932]]) {
      await open(width, height);
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        badImages: [...document.images].filter((image) => !image.complete || !image.naturalWidth).length,
        fallbacks: [...document.querySelectorAll('.device-placeholder')].filter((node) => node.textContent.includes('图片暂不可用')).length,
        visibleTasks: [...document.querySelectorAll('.task-row')].filter((node) => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight - (innerWidth <= 760 ? 68 : 0); }).length,
        mainActionBottom: document.querySelector('#orderDetail [data-action="primary"]').getBoundingClientRect().bottom,
      }));
      assert.equal(layout.overflow, false, `No page overflow at ${width}`);
      assert.equal(layout.badImages + layout.fallbacks, 0, `Photos loaded at ${width}`);
      if (width === 1366) assert.ok(layout.mainActionBottom <= height, 'Primary desktop action visible at 1366×768');
      if (width <= 760) assert.ok(layout.visibleTasks >= 3, `At least 3 full task rows visible at ${width}`);
      report.layouts.push({ width, height, ...layout });
      if (width <= 760) {
        await page.click('[data-order="chen"]');
        const detail = await page.evaluate(() => {
          const panel = document.querySelector('#orderDetail');
          const action = panel.querySelector('[data-action="primary"]').getBoundingClientRect();
          const check = panel.querySelector('.checklist').getBoundingClientRect();
          return { overflow: panel.scrollWidth > panel.clientWidth, actionVisible: action.top > 0 && action.bottom <= innerHeight, checksVisible: check.bottom < document.querySelector('.settlement').getBoundingClientRect().top };
        });
        assert.equal(detail.overflow, false, `No detail overflow at ${width}`);
        assert.ok(detail.actionVisible && detail.checksVisible, `Checklist and primary action visible at ${width}`);
        await capture(`hybrid-detail-${width}`);
      }
    }

    await open(1440, 1000);
    await page.click('.daily-strip [data-filter="缺货"]');
    check(await page.$$eval('.task-row', (nodes) => nodes.length === 2), 'Summary filters to two shortage orders');
    check(await page.$eval('#detailTitle', (node) => node.textContent.includes('林女士')), 'Filtering automatically opens matching order');
    check(await page.$eval('.process-panel', (node) => node.textContent.includes('2TB × 1') && !node.textContent.includes('交付检查')), 'Shortage view has its own facts and actions');
    await page.click('#resetFilters');
    await page.type('#search', 'demo-pc-009');
    check(await page.$$eval('.task-row', (nodes) => nodes.length === 1 && nodes[0].textContent.includes('吴先生')), 'SN search is case insensitive');
    await page.type('#search', 'no-match');
    check(await page.$eval('#emptyList', (node) => !node.hidden) && await page.$eval('#orderDetail', (node) => node.hidden), 'No results clears stale detail');
    await page.click('#clearSearch');
    await page.click('.daily-strip [data-filter="待收款"]');
    check(await page.$$eval('.task-row', (nodes) => nodes.length === 3), 'Receivable total links to three outstanding orders');
    await page.click('#resetFilters');
    await page.click('[data-order="chen"]');
    await page.click('[data-action="primary"]');
    check(await page.$eval('#actionDialog', (node) => node.open && node.textContent.includes('打包') && node.textContent.includes('¥4,280')), 'Delivery dialog shows outstanding checklist and payment');
    await page.keyboard.press('Escape');
    await page.click('[data-check="2"]');
    check(await page.$eval('#checkCount', (node) => node.textContent === '3 / 3'), 'Checklist updates count');
    await page.click('[data-order="zhao"]');
    check(await page.$eval('.settlement', (node) => node.textContent.includes('已收 ¥3,680') && node.textContent.includes('¥0')), 'Switching orders updates amount and paid status');
    await page.click('[data-check="0"]');
    await page.click('[data-order="chen"]');
    check(await page.$eval('#checkCount', (node) => node.textContent === '3 / 3'), 'Checklist state is isolated and retained by order');
    await page.click('[data-order="liu-trade"]');
    check(await page.$eval('.process-panel', (node) => node.textContent.includes('未计入库存') && node.textContent.includes('待验机定价')), 'Trade-in separates provisional estimate and ownership');
    await page.click('[data-view="devices"]');
    check(await page.$$eval('.gallery-card', (nodes) => nodes.length === 7), 'Gallery has all seven devices');
    await page.click('#deviceGallery [data-order="zhou"]');
    check(await page.$eval('#detailTitle', (node) => node.textContent.includes('周先生')) && await page.$eval('#deviceGallery', (node) => node.hidden), 'Gallery opens same order processing view');
    await page.click('[data-action="config"]');
    check(await page.$eval('#actionDialog', (node) => node.open && node.textContent.includes('DEMO-GPU-008')), 'Device details use selected order data');
    await page.keyboard.press('Escape');
    await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
    check(await page.evaluate(() => document.activeElement.id === 'search'), 'Ctrl+K focuses order search');

    await open(390, 844);
    await page.click('[data-order="chen"]');
    check(await page.$eval('#orderDetail', (node) => node.classList.contains('open')), 'Mobile opens full task details');
    await page.click('[data-action="primary"]');
    await page.keyboard.press('Escape');
    check(await page.$eval('#orderDetail', (node) => node.classList.contains('open')), 'Closing dialog preserves mobile detail');
    await page.click('#backToList');
    await page.waitForFunction(() => !document.body.classList.contains('task-open'));
    check(await page.evaluate(() => !document.querySelector('.task-pane').inert), 'Mobile back restores task list interaction');
    await page.click('[data-view="devices"]');
    await page.click('#deviceGallery [data-order="lin"]');
    await page.goBack();
    await page.waitForFunction(() => !document.body.classList.contains('task-open'));
    check(await page.$eval('#deviceGallery', (node) => !node.hidden), 'Browser back restores originating device gallery');
    await page.click('#deviceGallery [data-order="chen"]');
    await page.click('[data-action="photo"]');
    check(await page.$eval('#actionDialog', (node) => node.open && !!node.querySelector('img')), 'Compact mobile photo expands on demand');
    await page.keyboard.press('Escape');
    await page.setViewport({ width: 1440, height: 1000 });
    await page.waitForFunction(() => !document.body.classList.contains('task-open'));
    check(await page.evaluate(() => !document.querySelector('.task-pane').inert), 'Resizing restores desktop controls');

    await page.setViewport({ width: 898, height: 1055, deviceScaleFactor: 1 });
    await page.goto('http://127.0.0.1:8818/v3/mobile-review.html', { waitUntil: 'networkidle2' });
    await capture('hybrid-mobile-board');

    assert.equal(report.errors.length, 0, 'No browser runtime errors');
    report.checkedAt = new Date().toISOString();
    fs.writeFileSync(path.join(__dirname, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
}
verify().catch((error) => { console.error(error); process.exitCode = 1; });
