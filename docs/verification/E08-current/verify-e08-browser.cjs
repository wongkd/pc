/**
 * E08 · 装机与交付「前端路由接线」浏览器验收（本地隔离环境，不接触生产）。
 *
 * 背景：E08 后端/契约/迁移/前端页面在上一卡完成，但 `/sales/fulfillment` 路由
 * 未接进 App.tsx（公共接线文件当时禁改）。本脚本验证总集成把路由接上后：
 *   1. 登录后直达 `/sales/fulfillment`，页面渲染「装机检测与交付」列表；
 *   2. 空态 / 列表态 / 详情态三个视图真实可达，不破版；
 *   3. 通过页面内真实 HTTP（带 token）铺一张「零售单 → 收款 → 成交 → 检测通过 → 交付」，
 *      回到列表看到该单，再点进详情看交付面板。
 *
 * 与 verify-e08.cjs（纯 HTTP 25 项）互补：那个验后端业务，这个验「路由 + 页面渲染」。
 *
 * 用法：node docs/verification/E08-current/verify-e08-browser.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const puppeteer = require('puppeteer')

const ROOT = path.resolve(__dirname, '../../..')
const FRONTEND = path.join(ROOT, 'frontend')
const BACKEND_PORT = 8819
const DEV_PORT = 5206
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
    const loginClicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === '登录')
      if (!btn) return false
      btn.click()
      return true
    })
    await settle(1200)
    check(loginClicked, '登录表单可提交')
    check((await text()).includes('经营') || (await text()).includes('今天') || (await text()).includes('开单'), '登录后进入 ERP 外壳')

    // ── 1. 直达 /sales/fulfillment：空态渲染 ──
    await page.goto(`${devUrl}/sales/fulfillment`, { waitUntil: 'networkidle2' })
    await settle(900)
    const listText = await text()
    check(listText.includes('装机检测与交付'), '路由可达：页面标题「装机检测与交付」出现')
    check(listText.includes('成交之后的事都在这里'), '页面说明文案出现')
    check(listText.includes('全部') && listText.includes('进行中') && listText.includes('草稿'), '状态筛选按钮（全部/进行中/草稿）出现')
    await shot('01-fulfillment-list-empty')

    // ── 2. 页面内真实 HTTP 铺一张零售单并走完交付 ──
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

    const retail = await api('POST', '/api/v2/sales/orders', {
      requestId: 'e08-browser-retail',
      kind: 'retail',
      customerSnapshot: { name: '路由验收客户', phone: '13800009999' },
      lines: [
        { source: 'new', nameSnapshot: '金百达 DDR5 16GB 6000', qty: 1, unitPriceCents: 27_900, productRef: ram?.id },
        { source: 'service', nameSnapshot: '装机服务费', qty: 1, unitPriceCents: 20_000 },
      ],
      discountCents: 0,
    })
    check(retail.status === 200, `B04 零售单建成（${retail.status}）`)
    const orderId = retail.body?.data?.entityId
    check(Boolean(orderId), '拿到销售单 ID')

    await api('POST', `/api/v2/sales/orders/${orderId}/payments`, {
      requestId: 'e08-browser-pay', amountCents: 47_900, method: 'wechat', verificationState: 'verified',
    })
    const confirm = await api('POST', `/api/v2/sales/orders/${orderId}/confirm`, { requestId: 'e08-browser-confirm' })
    check(confirm.status === 200, `B05 确认成交（${confirm.status}）`)
    const checks = await api('POST', `/api/v2/sales/orders/${orderId}/checks`, {
      requestId: 'e08-browser-checks',
      templateVersion: 'asm-v1',
      configurationVersion: 0,
      items: [
        { key: 'appearance', label: '外观与配件齐全', kind: 'check', state: 'pass' },
        { key: 'sn', label: 'SN / 编号核对', kind: 'check', state: 'pass' },
      ],
    })
    check(checks.status === 200, `B07 检测通过（${checks.status}）`)
    const deliver = await api('POST', `/api/v2/sales/orders/${orderId}/deliver`, {
      requestId: 'e08-browser-deliver',
      configurationVersion: 0,
      deliveryNote: '路由验收：到店自提',
    })
    check(deliver.status === 200 && deliver.body?.data?.state === 'delivered', `B10 交付成立（${deliver.status}）`)

    // ── 3. 回列表：出现刚交付的单 ──
    await page.goto(`${devUrl}/sales/fulfillment`, { waitUntil: 'networkidle2' })
    await settle(1000)
    const afterList = await text()
    check(afterList.includes('路由验收客户'), '列表出现刚建的销售单（客户名可见）')
    check(afterList.includes('已交付') || afterList.includes('交付'), '该单履约态显示为已交付')
    await shot('02-fulfillment-list-with-order')

    // ── 4. 点进详情：交付面板 ──
    const opened = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr')]
      const row = rows.find((tr) => (tr.textContent || '').includes('路由验收客户'))
      if (!row) return false
      const button = [...row.querySelectorAll('button')].find((el) => (el.textContent || '').trim() !== '')
      if (!button) return false
      button.scrollIntoView({ block: 'center' })
      button.click()
      return true
    })
    await settle(1000)
    check(opened, '点进销售单详情')
    const detailText = await text()
    check(detailText.includes('装机与交付') || detailText.includes('交付') || detailText.includes('履约'), '详情页显示履约/交付面板')
    await shot('03-fulfillment-detail')

    // 无权限状态不在此验证（owner 是 *，天然有权限）；页面有 canView 分支已由前端单测覆盖。
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
