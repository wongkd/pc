/**
 * E10 · 售后维修页「前端最小入口」浏览器验收（本地隔离环境，不接触生产）。
 *
 * 与 verify-e10.cjs（纯 HTTP 28 项）互补：那个验后端业务，这个验「路由 + 页面渲染 + 表单提交」。
 *
 * 覆盖：
 *   1. 登录后直达 /after-sales：列表页标题、空态、接修登记按钮；
 *   2. 页面内点「接修登记」→ 填表提交 → 列表出现新工单；
 *   3. 打开详情，按状态推进（诊断→方案→确认→换件→复测），核对动作区按钮随 allowedActions 显隐；
 *   4. 页面内点「登记收款」→ 填金额提交 → 成功提示（收款闭环前端入口）。
 *
 * 用法：node docs/verification/E10-current/verify-e10-browser.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const puppeteer = require('puppeteer')

const ROOT = path.resolve(__dirname, '../../..')
const FRONTEND = path.join(ROOT, 'frontend')
const BACKEND_PORT = 8822
const DEV_PORT = 5210
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

    // 领一件 available 的自有备件，供换件用。
    const inv = await api('GET', '/api/v2/inventory')
    const part = inv.body?.data?.lotItems?.find((row) => row.ownership === 'store' && row.availability === 'available') ?? null
    check(Boolean(part), '演示库存里有可领用的自有备件（用于换件）')

    // ── 1. 列表页（空态） ──
    await page.goto(`${devUrl}/after-sales`, { waitUntil: 'networkidle2' })
    await settle(900)
    const listText = await text()
    check(listText.includes('维修工单'), '售后维修页路由可达：标题「维修工单」出现')
    check(listText.includes('售后维修'), '售后维修页 kicker「售后维修」出现')
    check(listText.includes('接修登记'), '「接修登记」按钮出现')
    await shot('01-service-list-empty')

    // ── 2. 页面内接修登记 ──
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === '接修登记')
      btn?.click()
    })
    await settle(600)
    const intakeFormText = await text()
    check(intakeFormText.includes('接修登记') && intakeFormText.includes('客户称呼'), '点「接修登记」展开接修表单')
    await shot('02-service-intake-form')

    // 页面内填表提交接修
    const submittedIntake = await page.evaluate(() => {
      const set = (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        setter?.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const byPlaceholder = (ph) => [...document.querySelectorAll('input')].find((el) => el.placeholder === ph)
      const name = byPlaceholder('散客必填，如 陈先生')
      const device = byPlaceholder('型号 / 序列号，如 ThinkPad X1')
      const symptom = byPlaceholder('客户描述的故障现象')
      if (!name || !device || !symptom) return false
      set(name, '浏览器验收客户')
      set(device, 'THINKPAD-BRW')
      set(symptom, '开机卡在 logo')
      const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === '确认接修')
      btn?.click()
      return true
    })
    await settle(1200)
    check(submittedIntake, '接修表单可提交')
    const afterIntakeText = await text()
    check(afterIntakeText.includes('浏览器验收客户'), '接修后列表出现新工单（客户称呼可见）')
    await shot('03-service-list-after-intake')

    // 进入详情（点列表行）
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr')]
      const row = rows.find((tr) => (tr.textContent || '').includes('浏览器验收客户'))
      row?.scrollIntoView({ block: 'center' })
      row?.click()
    })
    await settle(900)
    const receivedDetailText = await text()
    check(receivedDetailText.includes('已接修'), '详情页状态显示「已接修」')
    check(receivedDetailText.includes('录入诊断'), 'received 状态出现「录入诊断」动作按钮')
    await shot('04-service-detail-received')

    // ── 3. 用 API 推进状态，核对动作区随 allowedActions 显隐 ──
    // 先拿工单 id（从列表接口）
    const listResp = await api('GET', '/api/v2/service/orders')
    const orderId = listResp.body?.data?.orders?.find((o) => o.customerName === '浏览器验收客户')?.id
    check(Boolean(orderId), '能取到浏览器验收工单的 id')

    // 诊断 → diagnosing
    await api('POST', `/api/v2/service/orders/${encodeURIComponent(orderId)}/diagnosis`, {
      requestId: 'e10-browser-diag', diagnosisNote: 'BIOS 电池失效',
    })
    await page.reload({ waitUntil: 'networkidle2' })
    await settle(900)
    // reload 回到列表态，需重新进详情
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr')]
      const row = rows.find((tr) => (tr.textContent || '').includes('浏览器验收客户'))
      row?.scrollIntoView({ block: 'center' })
      row?.click()
    })
    await settle(900)
    const diagnosingText = await text()
    check(diagnosingText.includes('检测中') && diagnosingText.includes('录入方案'), 'diagnosing 状态出现「录入方案」')

    // 方案 → awaiting_approval
    await api('POST', `/api/v2/service/orders/${encodeURIComponent(orderId)}/proposal`, {
      requestId: 'e10-browser-proposal',
      items: [{ name: '更换内存条', qty: 1, unitPriceCents: 30_000, chargeType: 'charge' }],
      chargeCents: 30_000,
      warrantyDecision: 'out_of_warranty',
    })
    await page.reload({ waitUntil: 'networkidle2' })
    await settle(900)
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr')]
      const row = rows.find((tr) => (tr.textContent || '').includes('浏览器验收客户'))
      row?.scrollIntoView({ block: 'center' })
      row?.click()
    })
    await settle(900)
    const awaitingText = await text()
    check(awaitingText.includes('待确认') && awaitingText.includes('方案确认') && awaitingText.includes('外送 / 返厂'),
      'awaiting_approval 状态出现「方案确认」+「外送 / 返厂」')

    // 确认 accepted → repairing
    await api('POST', `/api/v2/service/orders/${encodeURIComponent(orderId)}/confirm-proposal`, {
      requestId: 'e10-browser-confirm',
      proposalVersion: 1, confirmationMethod: 'phone', confirmedAt: '2026-09-21T10:00:00Z', accepted: true,
    })
    await page.reload({ waitUntil: 'networkidle2' })
    await settle(900)
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr')]
      const row = rows.find((tr) => (tr.textContent || '').includes('浏览器验收客户'))
      row?.scrollIntoView({ block: 'center' })
      row?.click()
    })
    await settle(900)
    const repairingText = await text()
    check(repairingText.includes('维修中') && repairingText.includes('换件'), 'repairing 状态出现「换件」')

    // 换件 → retesting
    await api('POST', `/api/v2/service/orders/${encodeURIComponent(orderId)}/replace`, {
      requestId: 'e10-browser-replace',
      approvedProposalVersion: 1,
      components: [{ oldComponentRef: '旧内存条', oldItemDisposition: 'quarantine', newStockItem: part?.id, qty: 1, chargeType: 'charge' }],
    })
    await page.reload({ waitUntil: 'networkidle2' })
    await settle(900)
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr')]
      const row = rows.find((tr) => (tr.textContent || '').includes('浏览器验收客户'))
      row?.scrollIntoView({ block: 'center' })
      row?.click()
    })
    await settle(900)
    const retestingText = await text()
    check(retestingText.includes('复测中') && retestingText.includes('复测通过') && retestingText.includes('登记收款'),
      'retesting 状态出现「复测通过」+「登记收款」')
    await shot('05-service-detail-retesting')

    // ── 4. 页面内点「登记收款」提交 ──
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === '登记收款')
      btn?.click()
    })
    await settle(600)
    const payFormText = await text()
    check(payFormText.includes('剩余待收'), '点「登记收款」展开收款表单（含「剩余待收」）')
    await shot('06-service-payment-form')

    const submittedPay = await page.evaluate(() => {
      const set = (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        setter?.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const byPlaceholder = (ph) => [...document.querySelectorAll('input')].find((el) => el.placeholder === ph)
      const amount = byPlaceholder('如 300.00')
      if (!amount) return false
      set(amount, '300.00')
      const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === '确认收款')
      btn?.click()
      return true
    })
    await settle(1200)
    check(submittedPay, '收款表单可提交')
    const afterPayText = await text()
    check(afterPayText.includes('收款已登记'), '收款提交后出现成功提示「收款已登记」')
    await shot('07-service-after-payment')

    // ── 5. 复测通过 → 归还 → returned ──
    await api('POST', `/api/v2/service/orders/${encodeURIComponent(orderId)}/retest`, {
      requestId: 'e10-browser-retest', passed: true,
    })
    await page.reload({ waitUntil: 'networkidle2' })
    await settle(900)
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr')]
      const row = rows.find((tr) => (tr.textContent || '').includes('浏览器验收客户'))
      row?.scrollIntoView({ block: 'center' })
      row?.click()
    })
    await settle(900)
    const readyReturnText = await text()
    check(readyReturnText.includes('待归还') && readyReturnText.includes('归还客户'), 'ready_return 状态出现「归还客户」')

    await api('POST', `/api/v2/service/orders/${encodeURIComponent(orderId)}/return`, {
      requestId: 'e10-browser-return', returnedTo: '本人',
    })
    await page.reload({ waitUntil: 'networkidle2' })
    await settle(900)
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr')]
      const row = rows.find((tr) => (tr.textContent || '').includes('浏览器验收客户'))
      row?.scrollIntoView({ block: 'center' })
      row?.click()
    })
    await settle(900)
    const returnedText = await text()
    check(returnedText.includes('已归还'), 'returned 状态显示「已归还」')
    await shot('08-service-detail-returned')
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
