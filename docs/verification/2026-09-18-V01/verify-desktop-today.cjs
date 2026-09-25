/**
 * V01 · 桌面今天页视觉验收（本地隔离演示，不登录、不接触生产后端）。
 *
 * 通道：本机已有 puppeteer + Edge headless（装在仓库根 node_modules）。
 * 与 docs/design/2026-09-18-assets/verify.cjs 同一套做法：
 *   · harness 只挂本地组件、本地图片与演示数据，不请求任何外部地址；
 *   · 断言是「软断言」：失败记进 report.failed 但不中断，保证一次运行拿到完整报告
 *     （改前基线本来就带有已知差异，例如详情设备图 88px 不符 02 §65 的 220–244px）；
 *   · measurements 记实测尺寸，改前当基线、改后做对比。
 *
 * 用法：
 *   node docs/verification/2026-09-18-V01/verify-desktop-today.cjs --tag before
 *   node docs/verification/2026-09-18-V01/verify-desktop-today.cjs --tag after
 */
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const puppeteer = require('puppeteer')

const argv = process.argv
const TAG = argv.includes('--tag') ? argv[argv.indexOf('--tag') + 1] : 'before'
const PORT = 8825
const OUT = __dirname
const SHOT_DIR = path.join(OUT, 'screenshots')
const LOG_DIR = path.join(OUT, 'logs')

const HARNESS_HTML = '<html lang="zh-CN"><div id="root"></div><script type="module" src="./main.tsx"></script></html>'

const HARNESS_TSX = `import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { WorkbenchTodayPage } from '../src/features/workbench/WorkbenchTodayPage';
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
  <MemoryRouter initialEntries={['/dashboard']}>
    <AppShell
      profile={profile}
      currentStore={{ id: 1, name: '演示门店', status: 'active' }}
      onStoreSelect={() => {}}
      onLogout={() => {}}
      onChangePassword={() => {}}
    >
      <WorkbenchTodayPage />
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
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      overflowX: el.scrollWidth - el.clientWidth,
    }
  }
  // 带 title 的元素靠省略号收敛、完整文本可悬停获取；.wb-visually-hidden 是 1px 屏读文本，
  // 两者都不算内容丢失，不计入溢流清单。
  const overflowers = [...document.querySelectorAll('.wb-workbench *')]
    .filter(
      (el) =>
        el.scrollWidth > el.clientWidth + 1 &&
        el.clientWidth > 0 &&
        !el.hasAttribute('title') &&
        !el.classList.contains('wb-visually-hidden'),
    )
    .slice(0, 8)
    .map((el) => `${el.className || el.tagName}:${el.scrollWidth}>${el.clientWidth}`)

  const taskRows = [...document.querySelectorAll('.wb-task-row')]

  return {
    viewport: { width: innerWidth, height: innerHeight },
    documentScrollHeight: document.documentElement.scrollHeight,
    pageHead: box('.wb-page-head'),
    metrics: box('.wb-metrics'),
    metricCells: [...document.querySelectorAll('.wb-metric')].map((el) => {
      const rect = el.getBoundingClientRect()
      return {
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 46),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        overflowX: el.scrollWidth - el.clientWidth,
      }
    }),
    metricAmount: box('.wb-metrics .wb-metric:last-child strong'),
    listPane: box('.wb-list-pane'),
    taskRowFirst: taskRows[0]
      ? {
          height: Math.round(taskRows[0].getBoundingClientRect().height),
          thumbnail: box('.wb-task-row .wb-device-photo img, .wb-task-row .wb-photo-placeholder'),
        }
      : null,
    detail: box('.wb-detail'),
    detailPhoto: box('.wb-detail .wb-device-photo'),
    detailPhotoFrame: box('.wb-detail .wb-device-photo img, .wb-detail .wb-photo-placeholder'),
    detailColumns: box('.wb-detail-columns'),
    detailAmount: box('.wb-detail-foot .wb-amount'),
    primaryAction: box('.wb-detail-action .wb-btn--primary'),
    overflowers,
  }
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  fs.mkdirSync(LOG_DIR, { recursive: true })

  const root = path.resolve(__dirname, '../../..')
  const frontend = path.join(root, 'frontend')
  const harness = path.join(frontend, '.validation-visual')
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
    scope: '本地隔离演示页（本地组件 + 本地图片 + 演示样本）；不是微信/真机验收，不是生产登录结果',
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

    const url = `http://127.0.0.1:${PORT}/.validation-visual/index.html`
    const settle = async () => {
      await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode().catch(() => {}))))
    }
    const open = async () => {
      await page.goto(url, { waitUntil: 'networkidle0' })
      await page.waitForSelector('.wb-device-photo img')
      await page.evaluate(() => window.scrollTo(0, 0))
      await settle()
    }
    const shot = async (name, options) => page.screenshot({ path: path.join(SHOT_DIR, `${TAG}-${name}.png`), ...options })

    // 1280 / 1024 是统计条最容易挤爆的两档，必须一起测不裁切
    for (const [width, height] of [[1366, 768], [1440, 1000], [1920, 1080], [1280, 800], [1024, 768]]) {
      await page.setViewport({ width, height })
      await open()
      const key = `${width}x${height}`
      report.viewports[key] = await page.evaluate(collectMetrics)
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${key}：无横向溢出`)
      check(await page.evaluate(() => document.querySelectorAll('.wb-metric').length === 5), `${key}：统计 5 格（含回收待验机与待收款）`)
      check(
        await page.evaluate(() => [...document.querySelectorAll('.wb-metric')].every((el) => el.scrollWidth <= el.clientWidth + 1)),
        `${key}：统计格内容不裁切`,
      )
      check(
        await page.evaluate(() => {
          const strong = document.querySelector('.wb-metrics .wb-metric:last-child strong')
          return Boolean(strong) && (strong.textContent || '').includes('12,800.00')
        }),
        `${key}：待收款金额完整渲染（不省略分位）`,
      )
      // 02 §65 的「主动作首屏可见」是桌面主验收尺寸（1366×768）的要求。
      // 1024 及以下详情转单栏，内容天然超出首屏，不套用这条。
      if (width >= 1366) {
        check(
          await page.evaluate(() => {
            const btn = document.querySelector('.wb-detail-action .wb-btn--primary')
            return Boolean(btn) && btn.getBoundingClientRect().bottom <= innerHeight
          }),
          `${key}：主动作在首屏内可见`,
        )
      }
      check(
        await page.evaluate(() => {
          const img = document.querySelector('.wb-detail .wb-device-photo img')
          return Boolean(img) && img.naturalWidth > 0
        }),
        `${key}：详情设备图本地加载成功`,
      )
      check(
        await page.evaluate(() => {
          const rows = [...document.querySelectorAll('.wb-task-row')]
          if (rows.length === 0) return false
          return rows.every((row) => row.scrollWidth <= row.clientWidth + 1)
        }),
        `${key}：待办行文本不横向溢出`,
      )
    }

    // ── 1440×1000：截图与核心尺寸基线 ──────────────────────────
    await page.setViewport({ width: 1440, height: 1000 })
    await open()
    await shot('1440x1000-list')
    await shot('1440x1000-list-fullpage', { fullPage: true })

    const measured = report.viewports['1440x1000']
    const shortView = report.viewports['1366x768']
    // 02 §65 的 220–244px 是 1366×768 主验收尺寸下的要求；
    // 1440×1000 按 v3 设计稿是 293px（设计稿只在「宽 ≥1101 且高 ≤820」时收到 244）。
    const shortPhoto = shortView.detailPhotoFrame
    const tallPhoto = measured.detailPhotoFrame
    report.checklist = {
      '02 §65 1366×768 照片高度落在 220–244px': Boolean(shortPhoto) && shortPhoto.height >= 220 && shortPhoto.height <= 244,
      '02 §65 1366×768 主动作首屏可见': (shortView.primaryAction?.bottom ?? 1e9) <= 768,
      '02 §65 1440×1000 主动作首屏可见': (measured.primaryAction?.bottom ?? 1e9) <= 1000,
      '02 §9 统计条高度不超过 96px（改前 106px）': Boolean(measured.metrics) && measured.metrics.height <= 96,
      '统计条金额格宽度预算（G-15，记录值）': measured.metricAmount?.width ?? null,
      '详情设备图实测尺寸（1366×768）': shortPhoto ? `${shortPhoto.width}×${shortPhoto.height}` : null,
      '详情设备图实测尺寸（1440×1000）': tallPhoto ? `${tallPhoto.width}×${tallPhoto.height}` : null,
      '待办首行高度（改前 145px）': measured.taskRowFirst?.height ?? null,
      '待办首行缩略图（设计稿 45×53）': measured.taskRowFirst?.thumbnail
        ? `${measured.taskRowFirst.thumbnail.width}×${measured.taskRowFirst.thumbnail.height}`
        : null,
    }

    // ── 列表 → 看板：同一结果集、7 张卡、图片本地加载 ──────────
    await page.evaluate(() => [...document.querySelectorAll('[role=tab]')].find((x) => (x.textContent || '').trim() === '设备看板').click())
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await settle()
    check(await page.evaluate(() => document.querySelectorAll('.wb-board-card').length === 7), '看板模式：7 张卡（与列表同一结果集）')
    const boardImages = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('.wb-board img')]
      return { total: imgs.length, loaded: imgs.filter((i) => i.naturalWidth > 0).length }
    })
    report.boardImages = boardImages
    check(boardImages.total === 7 && boardImages.loaded === 7, '看板模式：7 张缩略图全部本地加载')
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.evaluate(() => window.__wbShotReady = true)
    await shot('1440x1000-board')

    // ── 图片失败降级 ───────────────────────────────────────────
    await page.evaluate(() => [...document.querySelectorAll('[role=tab]')].find((x) => (x.textContent || '').trim() === '订单处理').click())
    await page.evaluate(() => document.querySelector('.wb-detail img').dispatchEvent(new Event('error')))
    check(await page.evaluate(() => Boolean(document.querySelector('.wb-detail .wb-photo-placeholder'))), '图片失败：详情显示降级占位')
    check(
      await page.evaluate(() => (document.querySelector('.wb-detail')?.textContent || '').includes('AI 示意')),
      '图片失败：仍标明「AI 示意 · 非实拍」',
    )
    check(
      await page.evaluate(() => (document.querySelector('.wb-detail')?.textContent || '').includes('白色设计主机')),
      '图片失败：设备名仍在（不因无图丢字段）',
    )
    await shot('1440x1000-photo-failed')

    // ── 搜索无结果 → 空状态并清空详情 ──────────────────────────
    await open()
    await page.type('input[placeholder="搜索单号 / 客户 / 设备"]', '不存在')
    await page.waitForSelector('.wb-empty .wb-state-graphic')
    check(await page.evaluate(() => Boolean(document.querySelector('.wb-empty .wb-state-graphic'))), '搜索无结果：显示空状态图形')
    check(await page.evaluate(() => !document.querySelector('article.wb-detail')), '搜索无结果：清空详情')
    await shot('1440x1000-empty')

    // ── 键盘可达 + 统计格仍能筛选 ──────────────────────────────
    // 注意：click 之后 React 在微任务里 flush，同一次 evaluate 内立刻读 DOM 会拿到旧值
    // （改前基线就是因此误报过一次「点击统计格不筛选」）。
    await open()
    const focusable = await page.evaluate(() => {
      const target = [...document.querySelectorAll('.wb-metric')].find((el) => (el.textContent || '').includes('待交机'))
      if (!target) return false
      target.focus()
      return document.activeElement === target
    })
    await page.evaluate(() => {
      const target = [...document.querySelectorAll('.wb-metric')].find((el) => (el.textContent || '').includes('待交机'))
      target.click()
    })
    let filtered = false
    try {
      await page.waitForFunction(
        () => (document.querySelector('.wb-list-head span')?.textContent || '').includes('2 项'),
        { timeout: 4000 },
      )
      filtered = true
    } catch {
      filtered = false
    }
    check(focusable, '键盘：统计格可获得焦点')
    check(filtered, '点击统计格：仍按类别筛选（2 项）')

    // ── 禁用主动作仍给阻断原因 ────────────────────────────────
    await open()
    check(
      await page.evaluate(() => {
        const btn = document.querySelector('.wb-detail-action .wb-btn--primary')
        return Boolean(btn) && btn.disabled === true && Boolean(document.querySelector('.wb-blocker'))
      }),
      '禁用主动作：仍显示阻断原因（视觉调整未放开交付）',
    )
    check(
      await page.evaluate(() => (document.querySelector('.wb-detail')?.textContent || '').includes('装机检查 2/3 项完成')),
      '详情仍显示卡点原文，不因改版丢字段',
    )

    check(report.errors.length === 0, '无页面 JS 错误')

    // ── 1366×768 与 1920 各留一张 ────────────────────────────
    await page.setViewport({ width: 1366, height: 768 })
    await open()
    await shot('1366x768-list')
    await page.setViewport({ width: 1920, height: 1080 })
    await open()
    await shot('1920x1080-list')
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
        boardImages: report.boardImages,
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
