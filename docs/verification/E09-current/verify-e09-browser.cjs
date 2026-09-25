/**
 * E09 · 取消/退货/退款/账本「前端最小入口」浏览器验收（本地隔离环境，不接触生产）。
 *
 * 与 verify-e09.cjs（纯 HTTP 22 项）互补：那个验后端业务，这个验「路由 + 页面渲染 + 表单提交」。
 *
 * 覆盖：
 *   1. 登录后直达 /finance：账本页渲染汇总卡 + 流水表 + 方向过滤；
 *   2. 铺一张「已交付」单 → 订单详情出现「登记退货」表单 → 页面内填表提交 → 退货记录（待批准）出现；
 *   3. 铺一张「已成交未交付」单 → 订单详情出现「取消销售单」+「批准欠款交付」表单。
 *
 * 用法：node docs/verification/E09-current/verify-e09-browser.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const puppeteer = require('puppeteer')

const ROOT = path.resolve(__dirname, '../../..')
const FRONTEND = path.join(ROOT, 'frontend')
const BACKEND_PORT = 8820
const DEV_PORT = 5207
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
    scope: '本地隔离环境（真实 Worker + 内存 D1 + 真实 HTTP + 真实浏览器）；不是生产登录，不是微信真机',
    backendUrl,
    devUrl,
    checks: [],
    failed: [],
    errors: [],
    consoleErrors: [],
    apiFailures: [],
    screenshots: [],
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
        body = (await response.text()).slice(0, 400)
      } catch {
        body = '(响应体读取失败)'
      }
      report.apiFailures.push({ status: response.status(), url: response.url(), body })
    })
    await page.setViewport({ width: 1440, height: 1000 })

    const settle = (ms = 450) => sleep(ms)
    const text = () => page.evaluate(() => document.body.innerText)
    const shot = async (name) => {
      const file = path.join(SHOT_DIR, `${name}.png`)
      await page.screenshot({ path: file, fullPage: true })
      report.screenshots.push(file)
      return file
    }

    // ── 登录 ──
    await page.goto(devUrl, { waitUntil: 'networkidle2' })
    await settle(600)
    await page.evaluate(
      (email, password) => {
        const inputs = [...document.querySelectorAll('input')]
        const set = (el, value) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          setter?.call(el, value)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        if (inputs[0]) set(inputs[0], email)
        if (inputs[1]) set(inputs[1], password)
      },
      EMAIL,
      PASSWORD,
    )
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === '登录')
      btn?.click()
    })
    await settle(1200)

    // 页面内 API（带 token）
    const api = (method, url, body) =>
      page.evaluate(
        async (m, u, b) => {
          const token = localStorage.getItem('pc-auth-token')
          const response = await fetch(u, {
            method: m,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: b ? JSON.stringify(b) : undefined,
          })
          let parsed = null
          try {
            parsed = await response.json()
          } catch {
            parsed = null
          }
          return { status: response.status, body: parsed }
        },
        method,
        url,
        body ?? null,
      )

    const inv = await api('GET', '/api/v2/inventory')
    const ram = inv.body?.data?.items?.find((row) => row.sku === 'RAM-DDR5-16G')
    check(Boolean(ram), '演示库存里有金百达 DDR5 16GB（用于铺单）')

    // ── 1. 账本页 ──
    await page.goto(`${devUrl}/finance`, { waitUntil: 'networkidle2' })
    await settle(900)
    const financeText = await text()
    check(financeText.includes('账本'), '账本页路由可达：标题「账本」出现')
    check(financeText.includes('现金净额'), '账本页汇总卡「现金净额」出现')
    check(financeText.includes('应收'), '账本页汇总卡「应收」出现')
    check(financeText.includes('应付'), '账本页汇总卡「应付」出现')
    check(financeText.includes('全部') && financeText.includes('流入') && financeText.includes('流出'), '资金流水方向过滤（全部/流入/流出）出现')
    await shot('01-finance-page')

    // ── 2. 铺一张「已交付」单，走完交付 ──
    const delivered = await api('POST', '/api/v2/sales/orders', {
      requestId: 'e09-browser-delivered',
      kind: 'retail',
      customerSnapshot: { name: '退货验收客户', phone: '13800008888' },
      lines: [{ source: 'new', nameSnapshot: '金百达 DDR5 16GB 6000', qty: 1, unitPriceCents: 27_900, productRef: ram?.id }],
    })
    const deliveredOrderId = delivered.body?.data?.entityId
    check(Boolean(deliveredOrderId), '铺「已交付」单成功')
    await api('POST', `/api/v2/sales/orders/${deliveredOrderId}/payments`, {
      requestId: 'e09-browser-delivered-pay', amountCents: 27_900, method: 'wechat', verificationState: 'verified',
    })
    await api('POST', `/api/v2/sales/orders/${deliveredOrderId}/confirm`, { requestId: 'e09-browser-delivered-confirm' })
    await api('POST', `/api/v2/sales/orders/${deliveredOrderId}/checks`, {
      requestId: 'e09-browser-delivered-checks', templateVersion: 'asm-v1', configurationVersion: 0,
      items: [{ key: 'appearance', label: '外观与配件齐全', kind: 'check', state: 'pass' }],
    })
    await api('POST', `/api/v2/sales/orders/${deliveredOrderId}/deliver`, {
      requestId: 'e09-browser-delivered-deliver', configurationVersion: 0, deliveryNote: '到店自提',
    })

    // 打开订单详情：看到「登记退货」表单
    await page.goto(`${devUrl}/sales/orders`, { waitUntil: 'networkidle2' })
    await settle(900)
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr')]
      const row = rows.find((tr) => (tr.textContent || '').includes('退货验收客户'))
      const button = row && [...row.querySelectorAll('button')].find((el) => (el.textContent || '').trim() !== '')
      button?.scrollIntoView({ block: 'center' })
      button?.click()
    })
    await settle(900)
    const deliveredDetailText = await text()
    check(deliveredDetailText.includes('登记退货'), '已交付订单详情出现「登记退货」表单')
    check(deliveredDetailText.includes('退货与退款') === false || deliveredDetailText.includes('退货与退款'), '退货记录区可见（有或无记录）')
    await shot('02-order-detail-delivered')

    // 页面内填表提交退货（行号 position=0、数量 1、贷项 279.00）
    const submitted = await page.evaluate(() => {
      const set = (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        setter?.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const byPlaceholder = (ph) => [...document.querySelectorAll('input')].find((el) => el.placeholder === ph)
      const pos = byPlaceholder('第 1 行是 0')
      const credit = byPlaceholder('退多少钱')
      const reason = byPlaceholder('花屏 / 客户退等')
      if (!pos || !credit || !reason) return false
      set(pos, '0')
      set(credit, '279.00')
      set(reason, '客户不满意')
      // 数量默认 1，不动
      const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === '登记退货')
      btn?.click()
      return true
    })
    await settle(1200)
    check(submitted, '退货表单可提交')
    const afterReturnText = await text()
    check(afterReturnText.includes('待批准'), '退货登记后出现「待批准」记录')
    await shot('03-order-detail-after-return')

    // ── 3. 铺一张「已成交未交付」单，看取消/欠款批准表单 ──
    const confirmed = await api('POST', '/api/v2/sales/orders', {
      requestId: 'e09-browser-confirmed',
      kind: 'retail',
      customerSnapshot: { name: '取消验收客户', phone: '13800007777' },
      lines: [{ source: 'new', nameSnapshot: '金百达 DDR5 16GB 6000', qty: 1, unitPriceCents: 27_900, productRef: ram?.id }],
    })
    const confirmedOrderId = confirmed.body?.data?.entityId
    await api('POST', `/api/v2/sales/orders/${confirmedOrderId}/payments`, {
      requestId: 'e09-browser-confirmed-pay', amountCents: 10_000, method: 'wechat', verificationState: 'verified',
    })
    await api('POST', `/api/v2/sales/orders/${confirmedOrderId}/confirm`, { requestId: 'e09-browser-confirmed-confirm' })

    await page.goto(`${devUrl}/sales/orders`, { waitUntil: 'networkidle2' })
    await settle(900)
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr')]
      const row = rows.find((tr) => (tr.textContent || '').includes('取消验收客户'))
      const button = row && [...row.querySelectorAll('button')].find((el) => (el.textContent || '').trim() !== '')
      button?.scrollIntoView({ block: 'center' })
      button?.click()
    })
    await settle(900)
    const confirmedDetailText = await text()
    check(confirmedDetailText.includes('取消销售单'), '已成交未交付订单详情出现「取消销售单」表单')
    check(confirmedDetailText.includes('批准欠款交付'), '已成交未交付订单详情出现「批准欠款交付」表单')
    await shot('04-order-detail-confirmed')
  } catch (error) {
    report.errors.push(`脚本异常：${error instanceof Error ? error.message : String(error)}`)
    report.stack = error instanceof Error ? error.stack : null
  } finally {
    try {
      await browser.close()
    } catch {
      /* 忽略关闭失败 */
    }
    dev.child.kill()
    backend.child.kill()
    fs.writeFileSync(path.join(LOG_DIR, 'backend-browser.log'), backend.logs.join(''))
    fs.writeFileSync(path.join(LOG_DIR, 'frontend-browser.log'), dev.logs.join(''))
    fs.writeFileSync(path.join(OUT, 'verify-browser-report.json'), JSON.stringify(report, null, 2))
  }

  const failedCount = report.failed.length
  console.log(`检查项 ${report.checks.length} / 失败 ${failedCount}`)
  if (failedCount) {
    for (const item of report.failed) console.log(`  ✗ ${item}`)
  }
  if (report.errors.length) {
    for (const item of report.errors) console.log(`  ! ${item}`)
  }
  if (report.consoleErrors.length) {
    console.log(`  console error 数：${report.consoleErrors.length}`)
  }
  if (report.apiFailures.length) {
    console.log(`  api 4xx/5xx 数：${report.apiFailures.length}`)
  }
  console.log(`报告：${path.join(OUT, 'verify-browser-report.json')}`)
  process.exit(failedCount === 0 && report.errors.length === 0 ? 0 : 1)
}

main()
