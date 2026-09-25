/**
 * E05b · B42「记录顾客确认」浏览器验收（本地隔离环境，不接触生产）。
 *
 * 与 E05 验收同一个套路：
 *   · 后端起 `backend/scripts/dev-server.mjs`（miniflare + 真实 Worker 入口 + 内存 D1 + 演示数据）；
 *   · 前端起真实 vite dev，`/api` 经代理打到那个本地后端；
 *   · 走真实登录表单，在真实页面上点、填、提交。确认动作走完整链路
 *     （HTTP + 契约信封 + 鉴权 + 权限 + SQL + 幂等执行器）。
 *
 * 流程：新建报价（1 行新品）→ 创建草稿 → 发出草稿版 → 选确认来源「微信」→ 记录顾客确认
 *   → 断言详情与列表的确认展示 → 回编辑视图证明「改一版」仍可出新版本。
 *
 * 断言是软断言：失败记进 report.failed 但不中断，一次运行拿到完整报告。
 *
 * 用法：node docs/verification/2026-09-19-E05b-confirm/verify-confirm.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const puppeteer = require('puppeteer')

const ROOT = path.resolve(__dirname, '../../..')
const FRONTEND = path.join(ROOT, 'frontend')
const BACKEND_PORT = 8815
const DEV_PORT = 5203
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

  const dev = startProcess(process.execPath, [path.join(FRONTEND, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(DEV_PORT), '--strictPort'], {
    cwd: FRONTEND,
    env: { ...process.env, VITE_API_TARGET: backendUrl },
  })
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
        body = (await response.text()).slice(0, 400)
      } catch {
        body = '(响应体读取失败)'
      }
      report.apiFailures.push({ status: response.status(), url: response.url(), body })
    })
    await page.setViewport({ width: 1440, height: 1000 })

    const settle = (ms = 450) => sleep(ms)
    const text = () => page.evaluate(() => document.body.innerText)
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
    const shot = (name) => page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
    const waitText = async (needle, timeout = 12000) => {
      try {
        await page.waitForFunction((want) => document.body.innerText.includes(want), { timeout }, needle)
        return true
      } catch {
        return false
      }
    }
    const waitGone = async (needle, timeout = 12000) => {
      try {
        await page.waitForFunction((want) => !document.body.innerText.includes(want), { timeout }, needle)
        return true
      } catch {
        return false
      }
    }
    const clearAndType = async (selector, value) => {
      await page.click(selector)
      await page.keyboard.down('Control')
      await page.keyboard.press('KeyA')
      await page.keyboard.up('Control')
      await page.keyboard.press('Backspace')
      await page.type(selector, value)
    }

    // ── 真实登录 ──────────────────────────────────────────────
    await page.goto(`${devUrl}/`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('input[placeholder="邮箱"]', { timeout: 15000 })
    await page.type('input[placeholder="邮箱"]', EMAIL)
    await page.type('input[placeholder="密码"]', PASSWORD)
    await clickByText('button', '登录')
    await page.waitForFunction(() => !document.querySelector('.login-overlay'), { timeout: 15000 })
    check(true, '用本地演示账号通过真实登录表单进入系统')

    // ── 进入报价页并新建 ─────────────────────────────────────
    await page.goto(`${devUrl}/sales/quotes`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('.wb-quote-table, .wb-inv-state', { timeout: 15000 })
    await settle()
    check(await clickByText('button', '新建装机报价'), '进入 /sales/quotes 并点「新建装机报价」')
    await page.waitForSelector('#quote-title', { timeout: 8000 })

    await clearAndType('#quote-title', '确认验收用主机')
    await clearAndType('input[aria-label="第 1 行名称"]', 'i5 处理器')
    await clearAndType('input[aria-label="第 1 行单价（元）"]', '1299')
    await shot('01-new-quote-editor')
    check(await clickByText('button', '创建草稿'), '提交创建草稿')
    check(await waitText('配置明细'), '创建后回到详情视图')

    // ── 发出草稿版 ───────────────────────────────────────────
    check(await clickByText('button', '发出草稿版'), '详情里点「发出草稿版」')
    check(await waitText('分享凭证明文'), '发出成功：出现只显示一次的分享凭证明文')
    check(await waitText('记录顾客确认'), '发出后详情出现「记录顾客确认」入口')
    await shot('02-issued-with-confirm')

    // ── B42 记录顾客确认 ─────────────────────────────────────
    await page.select('select[aria-label="确认来源"]', 'wechat')
    await settle(200)
    check(await clickByText('button', '记录顾客确认'), '选确认来源「微信」并点「记录顾客确认」')
    check(await waitText('顾客已确认第 1 版'), '详情显示「顾客已确认第 1 版」及来源')
    check(await waitText('确认 ≠ 付款'), '提示写明「确认 ≠ 付款，付定金后才会锁库存」')
    await settle(300)
    const confirmButtonGone = await page.evaluate(
      () => ![...document.querySelectorAll('button')].some((node) => node.textContent.trim() === '记录顾客确认'),
    )
    check(confirmButtonGone, '已确认版本不再显示确认按钮（不能重复确认）')
    check((await text()).includes('顾客已确认'), '状态标签变为「顾客已确认」')
    await shot('03-confirmed-detail')

    // ── 列表口径 ─────────────────────────────────────────────
    check(await clickByText('button', '返回列表'), '回列表')
    await page.waitForSelector('.wb-quote-table', { timeout: 10000 })
    await settle()
    const listText = await text()
    check(listText.includes('已确认 1'), `列表汇总计入「已确认 1」（实际：「${listText.split('\n').find((line) => line.includes('已确认')) ?? '未找到'}」）`)
    check(listText.includes('顾客已确认'), '列表行状态显示「顾客已确认」')
    await shot('04-list-with-confirmed')

    // ── 确认后仍可改一版（出新版本，不是原地改） ─────────────
    const reopened = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.wb-quote-table tbody tr')].find((node) => node.textContent.includes('确认验收用主机'))
      if (!row) return false
      const button = [...row.querySelectorAll('button')].find((node) => node.textContent.trim() === '查看')
      if (!button) return false
      button.click()
      return true
    })
    check(reopened, '重新打开已确认的报价')
    await waitText('顾客已确认第 1 版')
    check(await clickByText('button', '改一版'), '「改一版」入口仍在（要改必须出新版本）')
    await page.waitForSelector('#quote-title', { timeout: 8000 })
    check((await text()).includes('将生成新版本'), '编辑视图标题写明「将生成新版本」')
    await shot('05-revise-after-confirm')

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
