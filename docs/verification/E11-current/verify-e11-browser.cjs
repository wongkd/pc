/**
 * E11 · 回收置换页「前端真页面」浏览器验收（本地隔离环境，不接触生产）。
 *
 * 与 verify-e11.cjs（纯 HTTP 34 项）互补：那个验后端业务，这个验「路由 + 页面渲染 + 表单提交」。
 *
 * 覆盖：
 *   1. 登录后直达 /recovery：列表页标题、空态、回收登记按钮；
 *   2. 页面内点「回收登记」→ 填表提交 → 进入详情（状态待验机）；
 *   3. 详情页按状态推进：验机 → 出估价 → 取得所有权（选商品 + 成本）→ 应付出现；
 *   4. 登记付款 → 应付递减；
 *   5. 拆件入库（源实物 + 产出件 + 损耗）→ 状态已拆件；
 *   6. 返回列表能看到这张单。
 *
 * 用法：node docs/verification/E11-current/verify-e11-browser.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const puppeteer = require('puppeteer')

const ROOT = path.resolve(__dirname, '../../..')
const FRONTEND = path.join(ROOT, 'frontend')
const BACKEND_PORT = 8824
const DEV_PORT = 5212
const OUT = __dirname
const SHOT_DIR = path.join(OUT, 'screenshots')
const LOG_DIR = path.join(OUT, 'logs')

const EMAIL = 'owner@local.test'
const PASSWORD = 'local-preview-pass'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForHttp(url, { timeoutMs = 90000 } = {}) {
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
    console.log(`${value ? '✓' : '✗'} ${label}`)
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
      try { body = (await response.text()).slice(0, 400) } catch { body = '(响应体读取失败)' }
      report.apiFailures.push({ status: response.status(), url: response.url(), body })
    })
    await page.setViewport({ width: 1440, height: 1000 })

    const settle = (ms = 600) => sleep(ms)
    const text = () => page.evaluate(() => document.body.innerText)
    const shot = async (name) => {
      const file = path.join(SHOT_DIR, `${name}.png`)
      await page.screenshot({ path: file, fullPage: true })
      report.screenshots.push(file)
      return file
    }

    // 通用：按 placeholder 填 input（React 受控输入必须走原生 setter + input 事件）
    const fill = (placeholderPart, value) =>
      page.evaluate(
        (part, val) => {
          const input = [...document.querySelectorAll('input')].find((el) => (el.getAttribute('placeholder') || '').includes(part))
          if (!input) return false
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          setter?.call(input, val)
          input.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        },
        placeholderPart,
        value,
      )
    const clickButton = (label) =>
      page.evaluate((text) => {
        const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === text)
        if (!btn) return false
        btn.click()
        return true
      }, label)
    // 选第 index 个 select 的第 optionIndex 个 option
    const selectOption = (selectIndex, optionIndex) =>
      page.evaluate(
        (sIdx, oIdx) => {
          const select = [...document.querySelectorAll('select')][sIdx]
          if (!select) return null
          const option = select.options[oIdx]
          if (!option) return null
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
          setter?.call(select, option.value)
          select.dispatchEvent(new Event('change', { bubbles: true }))
          return option.value
        },
        selectIndex,
        optionIndex,
      )

    // ── 登录 ──
    await page.goto(devUrl, { waitUntil: 'networkidle2' })
    await settle(900)
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
    await clickButton('登录')
    await settle(1500)

    // ── 直达回收页 ──
    await page.goto(`${devUrl}/recovery`, { waitUntil: 'networkidle2' })
    await settle(1200)
    let body = await text()
    check(body.includes('回收单'), '1. /recovery 渲染回收置换页（标题「回收单」）')
    check(body.includes('回收登记'), '2. 列表页有「回收登记」入口（recovery/edit 权限可见）')
    check(!body.includes('未接入回收单状态机'), '3. 不再是 T02a 占位页（占位文案消失）')
    await shot('01-recovery-list')

    // ── 登记 ──
    check(await clickButton('回收登记'), '4. 点「回收登记」打开表单')
    await settle(400)
    await fill('陈师傅', '陈师傅（浏览器验收）')
    await fill('联想 ThinkPad T14', '戴尔 OptiPlex 7080 整机')
    await fill('选填，如 800', '800')
    await settle(200)
    await shot('02-intake-form')
    check(await clickButton('确认登记'), '5. 提交回收登记')
    await settle(1600)
    body = await text()
    check(body.includes('待验机'), '6. 登记后进入详情，状态「待验机」')
    await shot('03-detail-received')

    // ── 验机 → 估价 ──
    check(await clickButton('开始验机'), '7. 详情动作区有「开始验机」')
    await settle(1400)
    body = await text()
    check(body.includes('验机中'), '8. 验机后状态「验机中」')

    check(await clickButton('出估价'), '9. 点「出估价」打开逐件估价表单')
    await settle(400)
    await fill('0', '1200')
    await shot('04-offer-form')
    check(await clickButton('发出估价'), '10. 提交估价')
    await settle(1400)
    body = await text()
    check(body.includes('已报价'), '11. 估价后状态「已报价」')
    await shot('05-detail-offered')

    // ── 取得所有权 ──
    check(await clickButton('取得所有权'), '12. 点「取得所有权」打开收购表单')
    await settle(500)
    const productValue = await selectOption(0, 1)
    check(Boolean(productValue), `13. 收购表单能选到商品（${productValue}）`)
    await fill('成本（元）', '1200')
    await fill('照片', '现场照片 + 身份证')
    await settle(200)
    await shot('06-acquire-form')
    check(await clickButton('确认取得所有权'), '14. 提交取得所有权')
    await settle(1600)
    body = await text()
    check(body.includes('已收购'), '15. 收购后状态「已收购」')
    check(body.includes('¥1,200.00') || body.includes('1200.00'), '16. 应付显示 1200.00')
    await shot('07-detail-acquired')

    // ── 付款 ──
    check(await clickButton('登记付款'), '17. 点「登记付款」打开付款表单')
    await settle(400)
    await fill('0', '200')
    await settle(200)
    await shot('08-pay-form')
    check(await clickButton('确认付款'), '18. 提交付款 200 元')
    await settle(1600)
    body = await text()
    check(body.includes('1,000.00') || body.includes('1000.00'), '19. 付款后应付变成 1000.00')
    await shot('09-after-payment')

    // ── 拆件 ──
    check(await clickButton('拆件入库'), '20. 已收购后出现「拆件入库」')
    await settle(500)
    const sourceValue = await selectOption(0, 1)
    check(Boolean(sourceValue), `21. 能选到源实物（${sourceValue}）`)
    const outProduct = await selectOption(1, 1)
    check(Boolean(outProduct), `22. 产出件能选商品（${outProduct}）`)
    await fill('内部编号', 'TS-E11-RAM-01')
    await fill('成本（元）', '400')
    check(await clickButton('加一行损耗'), '23. 能追加损耗行')
    await settle(300)
    await fill('损耗说明', '主板腐蚀报废')
    await fill('损耗金额（元）', '800')
    await settle(200)
    await shot('10-teardown-form')
    check(await clickButton('确认拆件'), '24. 提交拆件（产出 400 + 损耗 800 = 源成本 1200）')
    await settle(1800)
    body = await text()
    check(body.includes('已拆件'), '25. 拆件后状态「已拆件」')
    await shot('11-detail-disassembled')

    // ── 返回列表 ──
    await clickButton('返回列表')
    await settle(1400)
    body = await text()
    check(body.includes('戴尔 OptiPlex 7080 整机') || body.includes('陈师傅'), '26. 返回列表能看到刚才的单')
    await shot('12-list-filled')

    check(report.errors.length === 0, `27. 页面无未捕获异常（${report.errors.join(' | ')}）`)
    const realFailures = report.apiFailures.filter((item) => item.status >= 500)
    check(realFailures.length === 0, `28. 无 5xx 接口失败（${JSON.stringify(realFailures).slice(0, 300)}）`)
  } finally {
    await browser.close()
    backend.child.kill('SIGTERM')
    dev.child.kill('SIGTERM')
    fs.writeFileSync(
      path.join(OUT, 'verify-browser-report.json'),
      JSON.stringify({ ...report, total: report.checks.length, failedCount: report.failed.length }, null, 2),
    )
    console.log(`\n通过 ${report.checks.length - report.failed.length} 项，失败 ${report.failed.length} 项`)
    if (report.failed.length) {
      console.log('失败项：')
      for (const item of report.failed) console.log(`  ✗ ${item}`)
      process.exitCode = 1
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
