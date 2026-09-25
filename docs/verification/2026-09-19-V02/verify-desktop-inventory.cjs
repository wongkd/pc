/**
 * V02 · 桌面库存页视觉验收（本地隔离演示，不登录、不接触生产后端）。
 *
 * 通道与 V01 相同：本机 puppeteer + Edge headless（仓库根 node_modules）。
 *   · harness 只挂本地组件、本地图片与演示样本（demoInventory.ts，契约 V5 的端内副本）；
 *   · 断言是「软断言」：失败记进 report.failed 但不中断，一次运行拿到完整报告；
 *   · measurements 记实测尺寸，首轮当基线，后续改动做对比。
 *
 * 本卡重点（与今天页不同的地方）：
 *   1. 表格是「表头与行各自写一份 grid 定义」（workbench.css 明确不用 subgrid），
 *      两份定义一旦漂移，表头与列就会错位 —— 逐列实测左边界比对；
 *   2. 7 列最小宽约 858px，而收敛到 5 列的断点只在 1024 —— 中间档位是否溢出；
 *   3. 三条硬口径的视觉证据：在途/客户保管单列、未知成本写「成本未知」、
 *      无成本权限时成本整列不渲染。
 *
 * 用法：
 *   node docs/verification/2026-09-19-V02/verify-desktop-inventory.cjs --tag before
 *   node docs/verification/2026-09-19-V02/verify-desktop-inventory.cjs --tag after
 */
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const puppeteer = require('puppeteer')

const argv = process.argv
const TAG = argv.includes('--tag') ? argv[argv.indexOf('--tag') + 1] : 'before'
const PORT = 8826
const OUT = __dirname
const SHOT_DIR = path.join(OUT, 'screenshots')
const LOG_DIR = path.join(OUT, 'logs')

/** harness 目录名避开块注释里的「星号紧跟斜杠」写法（P-15）。 */
const HARNESS_DIR = '.validation-inventory'
const HARNESS_HTML = '<html lang="zh-CN"><div id="root"></div><script type="module" src="./main.tsx"></script></html>'

const HARNESS_TSX = `import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { WorkbenchInventoryPage } from '../src/features/workbench/WorkbenchInventoryPage';
import { AppShell } from '../src/app/AppShell';
import '../src/index.css';
const profile = {
  user: { id: 1, email: 'demo@example.com' },
  stores: [{ id: 1, name: '演示门店' }],
  currentStoreId: 1,
  memberId: 1,
  roles: ['owner'],
  permissions: ['*'],
};
createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/inventory']}>
    <AppShell
      profile={profile}
      currentStore={{ id: 1, name: '演示门店', status: 'active' }}
      onStoreSelect={() => {}}
      onLogout={() => {}}
      onChangePassword={() => {}}
    >
      <WorkbenchInventoryPage />
    </AppShell>
  </MemoryRouter>,
);`

/** 在页面里量尺寸。改前后共用，保证口径一致。 */
function collectMetrics() {
  const box = (selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      fontSize: style.fontSize,
      overflowX: el.scrollWidth - el.clientWidth,
    }
  }
  const cellsOf = (selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    return [...el.children].map((child) => ({
      text: (child.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
      left: Math.round(child.getBoundingClientRect().left),
      width: Math.round(child.getBoundingClientRect().width),
    }))
  }
  const gridCols = (selector) => {
    const el = document.querySelector(selector)
    return el ? getComputedStyle(el).gridTemplateColumns : null
  }

  // 带 title 的元素靠省略号收敛、完整文本可悬停获取；不计入溢流清单。
  const overflowers = [...document.querySelectorAll('.wb-page *')]
    .filter(
      (el) =>
        el.scrollWidth > el.clientWidth + 1 &&
        el.clientWidth > 0 &&
        !el.hasAttribute('title') &&
        !el.classList.contains('wb-visually-hidden'),
    )
    .slice(0, 10)
    .map((el) => `${el.className || el.tagName}:${el.scrollWidth}>${el.clientWidth}`)

  const rows = [...document.querySelectorAll('.wb-inv-row')]

  return {
    viewport: { width: innerWidth, height: innerHeight },
    documentScrollHeight: document.documentElement.scrollHeight,
    page: box('.wb-page'),
    toolbar: box('.wb-inv-toolbar'),
    table: box('.wb-inv-table'),
    head: box('.wb-inv-head'),
    headCells: cellsOf('.wb-inv-head'),
    firstRow: box('.wb-inv-row'),
    firstRowCells: cellsOf('.wb-inv-row'),
    headGrid: gridCols('.wb-inv-head'),
    rowGrid: gridCols('.wb-inv-row'),
    rowCount: rows.length,
    rowHeights: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
    rowOverflows: rows.map((r) => r.scrollWidth - r.clientWidth),
    qtyByRow: rows.map((r) => [...r.querySelectorAll('.wb-inv-qty')].map((q) => q.textContent.trim())),
    costCellByRow: rows.map((r) => {
      const el = r.querySelector('.wb-inv-cost')
      return el ? el.textContent.trim() : null
    }),
    foot: box('.wb-inv-foot'),
    overflowers,
  }
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  fs.mkdirSync(LOG_DIR, { recursive: true })

  const root = path.resolve(__dirname, '../../..')
  const frontend = path.join(root, 'frontend')
  const harness = path.join(frontend, HARNESS_DIR)
  fs.mkdirSync(harness, { recursive: true })
  fs.writeFileSync(path.join(harness, 'index.html'), HARNESS_HTML)
  fs.writeFileSync(path.join(harness, 'main.tsx'), HARNESS_TSX)

  const viteEntry = path.join(frontend, 'node_modules/vite/dist/node/index.js')
  if (!fs.existsSync(viteEntry)) throw new Error(`vite 未安装：${viteEntry}`)

  const { createServer } = await import(pathToFileURL(viteEntry))
  const react = (await import(pathToFileURL(path.join(frontend, 'node_modules/@vitejs/plugin-react/dist/index.js')))).default
  const server = await createServer({
    configFile: false,
    root: frontend,
    plugins: [react()],
    server: { host: '127.0.0.1', port: PORT, strictPort: true },
  })
  await server.listen()

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  })

  const report = {
    tag: TAG,
    scope: '本地隔离演示页（本地组件 + 演示样本 demoInventory）；不是微信/真机验收，不是生产登录结果',
    viewports: {},
    checks: [],
    failed: [],
    errors: [],
  }
  const check = (value, label) => {
    report.checks.push(label)
    if (!value) report.failed.push(label)
  }

  try {
    const page = await browser.newPage()
    page.on('pageerror', (e) => report.errors.push(e.message))

    const url = `http://127.0.0.1:${PORT}/${HARNESS_DIR}/index.html`
    const settle = async () => {
      await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode().catch(() => {}))))
    }
    const open = async () => {
      await page.goto(url, { waitUntil: 'networkidle0' })
      await page.waitForSelector('.wb-inv-row')
      await page.evaluate(() => window.scrollTo(0, 0))
      await settle()
    }
    const shot = async (name, options) => page.screenshot({ path: path.join(SHOT_DIR, `${TAG}-${name}.png`), ...options })
    /** 点一个筛选/开关按钮并等 React flush（同一次 evaluate 内读 DOM 会拿到旧值）。 */
    const clickAndWait = async (text, waitFor) => {
      await page.evaluate((t) => {
        const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === t)
        if (btn) btn.click()
      }, text)
      if (waitFor) await page.waitForFunction(waitFor, { timeout: 4000 })
      await settle()
    }

    // ── 多视口：表格排版与溢出 ──────────────────────────────────
    // 1025–1100 是最可疑的区间：7 列定义最小宽约 858px，而收敛到 5 列的断点只在 1024。
    for (const [width, height] of [[1366, 768], [1440, 1000], [1920, 1080], [1280, 800], [1152, 864], [1100, 800], [1024, 768]]) {
      await page.setViewport({ width, height })
      await open()
      const key = `${width}x${height}`
      report.viewports[key] = await page.evaluate(collectMetrics)
      const m = report.viewports[key]

      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${key}：页面无横向溢出`)
      check(m.table !== null && m.table.overflowX <= 1, `${key}：库存表格容器不横向溢出`)
      check(m.rowOverflows.every((v) => v <= 1), `${key}：每个型号行不横向溢出`)
      // 表头与行各自写一份 grid；两份定义漂移会让列错位
      check(m.headGrid === m.rowGrid, `${key}：表头与行使用同一套列定义`)
      check(Boolean(m.headCells) && Boolean(m.firstRowCells) && m.headCells.length === m.firstRowCells.length, `${key}：表头列数 = 行内单元格数`)
      const aligned =
        m.headCells &&
        m.firstRowCells &&
        m.headCells.length === m.firstRowCells.length &&
        m.headCells.every((c, i) => Math.abs(c.left - m.firstRowCells[i].left) <= 1)
      check(Boolean(aligned), `${key}：表头与行逐列左边界对齐（≤1px）`)
      check(m.rowCount === 4, `${key}：4 个型号行（契约 V5）`)
      check(m.overflowers.length === 0, `${key}：无可视元素内容溢出（不计 title 与屏读文本）`)
    }

    // ── 核心尺寸基线（1440×1000）────────────────────────────────
    await page.setViewport({ width: 1440, height: 1000 })
    await open()
    await shot('1440x1000-list')
    await shot('1440x1000-list-fullpage', { fullPage: true })
    const measured = report.viewports['1440x1000']
    const narrow = report.viewports['1100x800']
    report.checklist = {
      '1440×1000 表头高度': measured.head?.height ?? null,
      '1440×1000 型号行高度': measured.rowHeights?.[0] ?? null,
      '1440×1000 型号列宽': measured.firstRowCells?.[0]?.width ?? null,
      '1440×1000 行数与契约 V5 一致': measured.rowCount === 4,
      '1440×1000 三桶数量（GPU 可卖/已订/待处理）': (measured.qtyByRow?.[0] || []).join(' / '),
      '1440×1000 成本格文本（SSD 行）': measured.costCellByRow?.[2] ?? null,
      '1100×800 表格是否溢出': narrow?.table ? narrow.table.overflowX : null,
      '1100×800 表头列宽合计': narrow?.headCells ? narrow.headCells.reduce((s, c) => s + c.width, 0) : null,
      '1100×800 型号列实测宽': narrow?.firstRowCells?.[0]?.width ?? null,
    }

    // ── 三桶数量口径（契约 V5 的 4 组）──────────────────────────
    const expectedQty = [
      ['2', '0', '0'], // GPU
      ['1', '0', '1'], // MB
      ['12', '3', '1'], // SSD
      ['2', '0', '0'], // MEM
    ]
    const qtyOk = (measured.qtyByRow || []).length === 4 && expectedQty.every((e, i) => e.join() === (measured.qtyByRow[i] || []).join())
    check(qtyOk, '三桶数量与契约 V5 一致（可卖/已订/待处理）')

    // ── 未知成本：写「成本未知」而不是 ¥0.00 ────────────────────
    check(
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.wb-inv-row')]
        const mb = rows[1]
        return Boolean(mb) && (mb.querySelector('.wb-inv-cost')?.textContent || '').includes('成本未知')
      }),
      '未知成本型号（主板）：成本格显示「成本未知」',
    )
    check(
      await page.evaluate(() => !document.querySelector('.wb-inv-cost')?.textContent.includes('¥0.00')),
      '未知成本未用 ¥0.00 冒充已知',
    )
    check(
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.wb-inv-row')]
        const ssd = rows[2]?.querySelector('.wb-inv-cost')?.textContent || ''
        return ssd.includes('4,240.00')
      }),
      '已知成本完整渲染到分位（SSD ¥4,240.00，不省略）',
    )

    // ── 点行展开：逐件构成 / 在途与客户保管单列 / 流水 ──────────
    await page.evaluate(() => document.querySelectorAll('.wb-inv-row')[0].click())
    await page.waitForSelector('.wb-inv-breakdown')
    await settle()
    check(
      await page.evaluate(() => (document.querySelector('.wb-inv-breakdown')?.textContent || '').includes('自有在库 2 件')),
      '展开 GPU：数量构成写明「自有在库 2 件」',
    )
    check(
      await page.evaluate(() => document.querySelectorAll('.wb-inv-breakdown .wb-inv-item').length >= 2),
      '展开 GPU：逐件管理的型号列出实物',
    )
    check(
      await page.evaluate(() => {
        const text = document.querySelector('.wb-inv-breakdown')?.textContent || ''
        return text.includes('在途') && text.includes('不计入自有在库量')
      }),
      '展开 GPU：在途单列并标明不计入自有在库量',
    )
    check(
      await page.evaluate(() => {
        const text = document.querySelector('.wb-inv-breakdown')?.textContent || ''
        return text.includes('客户保管') && text.includes('他人财产')
      }),
      '展开 GPU：客户保管单列并标明他人财产',
    )
    check(
      await page.evaluate(() => document.querySelectorAll('.wb-inv-breakdown .wb-inv-move').length >= 2),
      '展开 GPU：流水列出数量来源',
    )
    check(
      await page.evaluate(() => Boolean(document.querySelector('.wb-inv-row[aria-expanded="true"]'))),
      '展开后行的 aria-expanded 转为 true',
    )
    await shot('1440x1000-expanded')
    await shot('1440x1000-expanded-fullpage', { fullPage: true })

    // ── 按数量管理的型号：不逐件编号并说明原因 ──────────────────
    await open()
    await page.evaluate(() => document.querySelectorAll('.wb-inv-row')[2].click())
    await page.waitForSelector('.wb-inv-breakdown')
    await settle()
    check(
      await page.evaluate(() => (document.querySelector('.wb-inv-breakdown')?.textContent || '').includes('按数量管理')),
      '展开 SSD：按数量管理的型号说明不逐件编号',
    )
    await shot('1440x1000-quantity-mode')

    // ── 成本列开关：无成本权限时整列不渲染 ──────────────────────
    await open()
    await clickAndWait('隐藏成本', () => document.querySelector('.wb-inv-table')?.classList.contains('is-nocost'))
    check(
      await page.evaluate(() => ![...document.querySelectorAll('.wb-inv-head span')].some((s) => s.textContent.trim() === '成本')),
      '隐藏成本：表头不再有「成本」列',
    )
    check(await page.evaluate(() => document.querySelectorAll('.wb-inv-cost').length === 0), '隐藏成本：行内成本单元格整列移除（非置空）')
    check(await page.evaluate(() => document.querySelectorAll('.wb-inv-row').length === 4), '隐藏成本：型号行数量不变')
    await shot('1440x1000-cost-hidden')

    // ── 搜索空状态 ─────────────────────────────────────────────
    await open()
    await page.type('.wb-inv-search', '不存在的型号')
    await page.waitForFunction(() => Boolean(document.querySelector('.wb-empty')), { timeout: 4000 })
    check(await page.evaluate(() => Boolean(document.querySelector('.wb-empty'))), '搜索无结果：显示空状态文案')
    check(await page.evaluate(() => !document.querySelector('.wb-inv-table')), '搜索无结果：表格移除（不残留空表头）')
    await shot('1440x1000-empty')

    // ── 筛选口径：在途 / 客户保管只出对应型号 ──────────────────
    await open()
    await clickAndWait('在途', () => document.querySelectorAll('.wb-inv-row').length === 1)
    check(await page.evaluate(() => document.querySelectorAll('.wb-inv-row').length === 1), '筛选「在途」：只剩 1 个型号')
    await open()
    await clickAndWait('客户保管', () => document.querySelectorAll('.wb-inv-row').length === 1)
    check(await page.evaluate(() => document.querySelectorAll('.wb-inv-row').length === 1), '筛选「客户保管」：只剩 1 个型号')
    await shot('1440x1000-filter-custody')

    // ── 键盘可达：行可聚焦并可用回车展开 ────────────────────────
    await open()
    const focusable = await page.evaluate(() => {
      const row = document.querySelector('.wb-inv-row')
      row.focus()
      return document.activeElement === row
    })
    check(focusable, '键盘：型号行可获得焦点')
    await page.keyboard.press('Enter')
    let expandedByKey = false
    try {
      await page.waitForFunction(() => Boolean(document.querySelector('.wb-inv-breakdown')), { timeout: 4000 })
      expandedByKey = true
    } catch {
      expandedByKey = false
    }
    check(expandedByKey, '键盘：回车可展开型号构成')
    check(await page.evaluate(() => Boolean(document.querySelector('.wb-inv-search:focus-visible, .wb-inv-search'))), '键盘：搜索框在文档流中可达')

    // ── 1024 档：收敛到 5 列且不溢出 ────────────────────────────
    await page.setViewport({ width: 1024, height: 768 })
    await open()
    check(
      await page.evaluate(() => {
        const head = document.querySelector('.wb-inv-head')
        const visible = [...head.children].filter((el) => getComputedStyle(el).display !== 'none')
        return visible.length === 5
      }),
      '1024×768：表头收敛为 5 列（位置与成本隐藏）',
    )
    await shot('1024x768-list')

    check(report.errors.length === 0, '无页面 JS 错误')

    // ── 其余档位各留一张 ────────────────────────────────────────
    for (const [w, h] of [[1366, 768], [1920, 1080], [1280, 800], [1152, 864], [1100, 800]]) {
      await page.setViewport({ width: w, height: h })
      await open()
      await shot(`${w}x${h}-list`)
    }
  } finally {
    fs.writeFileSync(path.join(LOG_DIR, `${TAG}-report.json`), `${JSON.stringify(report, null, 2)}\n`)
    await browser.close()
    await server.close()
  }

  console.log(
    JSON.stringify(
      {
        tag: report.tag,
        checks: report.checks.length,
        failed: report.failed,
        checklist: report.checklist,
        errors: report.errors,
      },
      null,
      2,
    ),
  )
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
