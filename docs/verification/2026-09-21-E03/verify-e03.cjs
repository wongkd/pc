/**
 * E03 · 界面换肤收尾浏览器验收（本地隔离环境，不接触生产）。
 *
 * 目的：证明订单 / 商品 / SN 台账 / 系统设置 / 模块占位五类页面已并入 E03 彩色视觉层；
 *       同时回归证明旧报价编辑器与顾客打印没有被这次追加的样式污染。
 *
 * 断言打在**承载该样式的容器**上（computed style），不用整页文本包含式断言 —— 见 PITFALLS P-25。
 * 软断言：失败记进 report.failed 但不中断，一次运行拿到完整报告。
 *
 * 用法：node docs/verification/2026-09-21-E03/verify-e03.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const puppeteer = require('puppeteer')

const ROOT = path.resolve(__dirname, '../../..')
const FRONTEND = path.join(ROOT, 'frontend')
const BACKEND_PORT = 8816
const DEV_PORT = 5204
const OUT = __dirname
const SHOT_DIR = path.join(OUT, 'screenshots')
const LOG_DIR = path.join(OUT, 'logs')

const EMAIL = 'owner@local.test'
const PASSWORD = 'local-preview-pass'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForHttp(url, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.status > 0) return true
    } catch {
      // 还没起来
    }
    await sleep(300)
  }
  throw new Error(`等待服务超时：${url}`)
}

function startProcess(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  const logs = []
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()))
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()))
  return { child, logs }
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  fs.mkdirSync(LOG_DIR, { recursive: true })

  const backend = startProcess(process.execPath, [path.join(ROOT, 'backend/scripts/dev-server.mjs')], {
    cwd: path.join(ROOT, 'backend'),
    env: { ...process.env, PORT: String(BACKEND_PORT) },
  })
  const backendUrl = `http://127.0.0.1:${BACKEND_PORT}`
  await waitForHttp(`${backendUrl}/api/customers`)

  const dev = startProcess(
    process.execPath,
    [path.join(FRONTEND, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(DEV_PORT), '--strictPort'],
    { cwd: FRONTEND, env: { ...process.env, VITE_API_TARGET: backendUrl } },
  )
  const devUrl = `http://127.0.0.1:${DEV_PORT}`
  await waitForHttp(`${devUrl}/`)

  const report = {
    scope: '本地隔离环境（真实 Worker + 内存 D1 + 真实 HTTP）；不是生产登录，不是微信真机',
    backendUrl,
    devUrl,
    checks: [],
    failed: [],
    errors: [],
    consoleErrors: [],
    apiFailures: [],
  }
  const check = (value, label) => {
    report.checks.push(label)
    if (!value) report.failed.push(label)
  }

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  })

  try {
    const page = await browser.newPage()
    page.on('pageerror', (error) => report.errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const location = message.location()?.url ?? ''
      report.consoleErrors.push(location ? `${message.text()} @ ${location}` : message.text())
    })
    page.on('response', async (response) => {
      if (response.status() < 400 || !response.url().includes('/api/')) return
      let body = ''
      try {
        body = (await response.text()).slice(0, 300)
      } catch {
        body = '(响应体读取失败)'
      }
      report.apiFailures.push({ status: response.status(), url: response.url(), body })
    })
    await page.setViewport({ width: 1440, height: 1000 })

    const settle = (ms = 500) => sleep(ms)
    const shot = (name) => page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
    const cs = (selector, prop) =>
      page.evaluate(
        (sel, p) => {
          const el = document.querySelector(sel)
          return el ? getComputedStyle(el)[p] : null
        },
        selector,
        prop,
      )
    const go = async (pathname, waitSelector) => {
      await page.goto(`${devUrl}${pathname}`, { waitUntil: 'networkidle0' })
      if (waitSelector) {
        try {
          await page.waitForSelector(waitSelector, { timeout: 15000 })
        } catch {
          // 交给后续断言报出
        }
      }
      await settle()
    }
    const clickByText = async (selector, label) => {
      const clicked = await page.evaluate(
        (sel, wanted) => {
          const target = [...document.querySelectorAll(sel)].find((el) => (el.textContent || '').trim() === wanted)
          if (!target) return false
          target.click()
          return true
        },
        selector,
        label,
      )
      await settle()
      return clicked
    }

    // ── 登录页 ────────────────────────────────────────────────
    await page.goto(`${devUrl}/`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('.login-card', { timeout: 15000 })
    const loginCardBg = await cs('.login-card', 'backgroundColor')
    check(loginCardBg === 'rgb(255, 255, 255)', `登录卡为白底卡片（实际 ${loginCardBg}）`)
    await shot('01-login')

    // ── 真实登录 ──────────────────────────────────────────────
    await page.type('input[placeholder="邮箱"]', EMAIL)
    await page.type('input[placeholder="密码"]', PASSWORD)
    await clickByText('button', '登录')
    await page.waitForFunction(() => !document.querySelector('.login-overlay'), { timeout: 15000 })
    check(true, '用本地演示账号通过真实登录表单进入系统')

    // ── 工作台（回归：已彩色页面未被本次改动破坏） ────────────
    await go('/dashboard', '.wb-page')
    const metricBg = await cs('.wb-metric', 'backgroundColor')
    check(metricBg === 'rgb(206, 234, 223)', `工作台首张指标卡仍是薄荷绿彩色块（实际 ${metricBg}）`)
    await shot('02-workbench-regression')

    // ── 订单列表与详情 ───────────────────────────────────────
    await go('/orders', '.orders-table')
    const orderRows = await page.evaluate(() => document.querySelectorAll('.orders-table tbody tr').length)
    check(orderRows > 0, `订单列表有演示数据（${orderRows} 行）`)
    const listHeadBg = await cs('.orders-table th', 'backgroundColor')
    check(listHeadBg === 'rgb(249, 250, 252)', `订单列表表头为浅灰面（实际 ${listHeadBg}）`)
    await shot('03-orders-list')

    const orderHref = await page.evaluate(() => {
      const anchor = document.querySelector('.orders-table a[href^="/orders/"]')
      return anchor ? anchor.getAttribute('href') : null
    })
    check(Boolean(orderHref), `订单列表能取到详情链接（${orderHref}）`)
    if (orderHref) {
      await go(orderHref, '.order-summary-grid')
      const summaryBg = await cs('.order-summary-grid > div', 'backgroundColor')
      check(summaryBg === 'rgb(212, 233, 223)', `订单详情首格摘要为薄荷绿块（实际 ${summaryBg}）`)
      const actionsBg = await cs('.order-actions', 'backgroundColor')
      check(actionsBg === 'rgb(241, 238, 248)', `订单详情履约/收款栏为浅紫（实际 ${actionsBg}）`)
      const statusRadius = await cs('.order-status', 'borderRadius')
      check(statusRadius === '6px', `订单状态徽标圆角 6px（实际 ${statusRadius}）`)
      await shot('04-order-detail')
    }

    // ── 旧商品管理页 ─────────────────────────────────────────
    await go('/inventory/products', '.product-table-wrap')
    const productFilterRadius = await cs('.product-filters', 'borderRadius')
    check(productFilterRadius === '12px', `商品页筛选条 12px 圆角（实际 ${productFilterRadius}）`)
    const productPrimaryBg = await cs('.product-primary', 'backgroundColor')
    check(productPrimaryBg === 'rgb(36, 41, 57)', `商品页主按钮为新版深色（--wb-ink，实际 ${productPrimaryBg}）`)
    await shot('05-products')

    // ── SN 台账（改动前完全无样式） ──────────────────────────
    await go('/sn', '.sn-table-wrap')
    const snHeadBg = await cs('.sn-table th', 'backgroundColor')
    check(snHeadBg === 'rgb(249, 250, 252)', `SN 台账表头为浅灰面（实际 ${snHeadBg}）`)
    const snWrapRadius = await cs('.sn-table-wrap', 'borderRadius')
    check(snWrapRadius === '20px', `SN 台账表容器 20px 圆角（实际 ${snWrapRadius}）`)
    const snFilterRadius = await cs('.sn-filters', 'borderRadius')
    check(snFilterRadius === '12px', `SN 筛选条 12px 圆角（实际 ${snFilterRadius}）`)
    const strayZero = await page.evaluate(() => {
      const section = document.querySelector('.sn-page')
      if (!section) return null
      return [...section.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim() === '0')
    })
    check(strayZero === false, 'SN 页不渲染游离的「0」（数字短路渲染缺陷已修）')
    await shot('06-sn')

    // ── 系统设置 ─────────────────────────────────────────────
    await go('/settings', '.settings-section')
    const settingsSectionRadius = await cs('.settings-section', 'borderRadius')
    check(settingsSectionRadius === '20px', `设置分区 20px 圆角（实际 ${settingsSectionRadius}）`)
    const settingsSectionBg = await cs('.settings-section', 'backgroundColor')
    check(settingsSectionBg === 'rgb(255, 255, 255)', `设置分区白底（实际 ${settingsSectionBg}）`)
    await shot('07-settings')

    // ── 模块占位页（改动前完全无样式） ───────────────────────
    await go('/after-sales', '.module-placeholder')
    const placeholderRadius = await cs('.module-placeholder', 'borderRadius')
    check(placeholderRadius === '24px', `占位页 24px 圆角白卡（实际 ${placeholderRadius}）`)
    const placeholderAlign = await cs('.module-placeholder', 'textAlign')
    check(placeholderAlign === 'center', `占位页文案居中（实际 ${placeholderAlign}）`)
    const placeholderIndexBg = await cs('.module-placeholder-index', 'backgroundColor')
    check(placeholderIndexBg === 'rgb(36, 41, 57)', `占位页标识块为深色（--wb-ink，实际 ${placeholderIndexBg}）`)
    await shot('08-placeholder')

    // ── 回归：旧报价编辑器与顾客打印不得被污染 ──────────────
    await go('/quotes', '.quote-toolbar')
    const quoteButton = await page.evaluate(() => {
      const el = document.querySelector('.quote-toolbar .btn.primary')
      if (!el) return null
      const s = getComputedStyle(el)
      return { bgImage: s.backgroundImage, bg: s.backgroundColor, radius: s.borderRadius }
    })
    check(quoteButton !== null, '报价工具栏存在主按钮')
    if (quoteButton) {
      check(
        quoteButton.bgImage.includes('gradient'),
        `报价工具栏主按钮仍是原蓝绿渐变（实际 ${quoteButton.bgImage.slice(0, 70)}）`,
      )
      check(
        quoteButton.bg !== 'rgb(41, 46, 54)',
        `报价工具栏主按钮未被换成新版深色（实际 ${quoteButton.bg}）`,
      )
    }
    await shot('09-quote-editor-regression')

    // ── 窄屏 390 ─────────────────────────────────────────────
    await page.setViewport({ width: 390, height: 844 })
    await go('/sn', '.sn-table-wrap')
    await shot('10-sn-mobile')
    await go('/settings', '.settings-section')
    await shot('11-settings-mobile')
    await go('/orders', '.orders-table')
    await shot('12-orders-mobile')
    await go('/after-sales', '.module-placeholder')
    await shot('13-placeholder-mobile')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    check(overflow <= 1, `窄屏 390 整页无横向溢出（实际超出 ${overflow}px）`)

    // ── 汇总 ─────────────────────────────────────────────────
    check(report.errors.length === 0, `页面无运行时错误（${report.errors.length}）`)
    check(report.consoleErrors.length === 0, `控制台无错误（${report.consoleErrors.length}）`)
    check(report.apiFailures.length === 0, `无 4xx/5xx API 响应（${report.apiFailures.length}）`)
  } finally {
    await browser.close()
    backend.child.kill()
    dev.child.kill()
    fs.writeFileSync(path.join(LOG_DIR, 'backend.log'), backend.logs.join(''))
    fs.writeFileSync(path.join(LOG_DIR, 'vite.log'), dev.logs.join(''))
  }

  fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify(report, null, 2))
  console.log(`通过 ${report.checks.length - report.failed.length} / ${report.checks.length}`)
  if (report.failed.length) {
    console.log('失败项：')
    for (const item of report.failed) console.log(`  ✗ ${item}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
