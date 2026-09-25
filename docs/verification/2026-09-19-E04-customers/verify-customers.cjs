/**
 * E04 · 客户台账浏览器验收（本地隔离环境，不接触生产）。
 *
 * 与 V01/V02 的区别：那两张卡把组件挂在 harness 里、喂演示样本；
 * 本卡要证明的是**前后端真的接上了**，所以：
 *   · 后端起 `backend/scripts/dev-server.mjs`（miniflare + 真实 Worker 入口 + 内存 D1）；
 *   · 前端起真实 `vite` dev，`/api` 经 vite.config.ts 的代理打到那个本地后端；
 *   · 走真实登录表单拿 token，再操作真实页面。
 * 因此这里出现的每一条数据都经过了 HTTP + 鉴权 + 权限 + SQL。
 *
 * 一条必须成立的硬边界：**全程没有任何请求发往 huangqidong.cn**（生产）。
 * 这条靠 page.on('request') 收集实际 URL 来判，不靠「配置看着像」。
 *
 * 断言是软断言：失败记进 report.failed 但不中断，一次运行拿到完整报告。
 *
 * 用法：node docs/verification/2026-09-19-E04-customers/verify-customers.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const puppeteer = require('puppeteer')

const ROOT = path.resolve(__dirname, '../../..')
const FRONTEND = path.join(ROOT, 'frontend')
const BACKEND_PORT = 8811
const DEV_PORT = 5199
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
    requestHosts: [],
    measured: {},
  }
  const check = (value, label) => {
    report.checks.push(label)
    if (!value) report.failed.push(label)
  }

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  })

  const allRequests = []
  try {
    const page = await browser.newPage()
    page.on('pageerror', (error) => report.errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') report.consoleErrors.push(message.text())
    })
    page.on('request', (request) => allRequests.push(request.url()))
    await page.setViewport({ width: 1440, height: 1000 })

    const settle = () => sleep(450)
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
    const shot = (name, options) => page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), ...options })

    // ── 真实登录 ──────────────────────────────────────────────
    await page.goto(`${devUrl}/`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('input[placeholder="邮箱"]', { timeout: 15000 })
    await page.type('input[placeholder="邮箱"]', EMAIL)
    await page.type('input[placeholder="密码"]', PASSWORD)
    await clickByText('button', '登录')
    await page.waitForFunction(() => !document.querySelector('.login-overlay'), { timeout: 15000 })
    check(true, '用本地演示账号通过真实登录表单进入系统')

    // ── 打开客户台账 ──────────────────────────────────────────
    await page.goto(`${devUrl}/customers`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('.customers-table tbody tr', { timeout: 15000 })
    await settle()
    await shot('1440x1000-customers-list')

    const rowCount = await page.evaluate(() => document.querySelectorAll('.customers-table tbody tr').length)
    check(rowCount === 5, `客户台账列出 5 位演示客户（实际 ${rowCount}）`)

    const bodyText = await text()
    check(bodyText.includes('未留电话'), '未留电话的散客在列表里明确标注')
    check(bodyText.includes('陈师傅（散客，只留姓）'), '散客只留姓也能建档并列出')

    // 口径证据：空手机号不做订单归属 —— 散客行必须是 0 笔 / ¥0.00
    const walkInRow = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.customers-table tbody tr')].find((tr) => (tr.textContent || '').includes('陈师傅'))
      return row ? [...row.querySelectorAll('td')].map((td) => td.textContent.trim()) : null
    })
    check(Boolean(walkInRow) && walkInRow.some((cell) => cell.startsWith('0 笔')), '无手机号散客的订单数为 0（不吞别人的无电话订单）')
    check(Boolean(walkInRow) && walkInRow.filter((cell) => cell === '¥0.00').length === 2, '无手机号散客累计金额与已收均为 ¥0.00')

    const boundRow = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.customers-table tbody tr')].find((tr) => (tr.textContent || '').includes('湛江智诚贸易有限公司'))
      return row ? [...row.querySelectorAll('td')].map((td) => td.textContent.trim()) : null
    })
    check(Boolean(boundRow) && boundRow.some((cell) => cell.includes('¥21,500.00')), '有手机号客户按手机号聚合出累计金额')

    // ── 详情：设备与订单 ──────────────────────────────────────
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.customers-table tbody tr')].find((tr) => (tr.textContent || '').includes('湛江智诚贸易有限公司'))
      row.click()
    })
    await page.waitForFunction(() => (document.querySelector('.customer-detail')?.textContent || '').includes('客户设备'), { timeout: 8000 })
    await settle()
    const detailText = await page.evaluate(() => document.querySelector('.customer-detail').innerText)
    check(detailText.includes('联想 ThinkPad T14 Gen4'), '详情显示登记的设备')
    check(detailText.includes('群晖 DS923+ NAS'), '详情显示第二台设备')
    check(detailText.includes('PRE-20260919-002'), '详情显示该客户的订单记录')
    // 累计口径单独查：订单行里也有 ¥21,500.00，只看整页文本会误判通过（第一轮就是这么漏掉的）。
    const totalText = await page.evaluate(() => (document.querySelector('.customer-total')?.innerText || ''))
    check(totalText.includes('¥21,500.00') && totalText.includes('1 笔订单'), '详情累计订单额与订单数来自服务端口径')
    check(totalText.includes('已收 ¥3,225.00'), '详情显示已收金额')
    check(!totalText.includes('NaN'), '详情不出现 NaN（累计字段缺失时的典型表现）')
    await shot('1440x1000-customers-detail')

    // ── 重复手机号：报错且保留已填内容 ────────────────────────
    await clickByText('button', '新增客户')
    await page.waitForSelector('input[placeholder="姓名或公司名"]')
    await page.type('input[placeholder="姓名或公司名"]', '重复号测试')
    await page.type('input[placeholder^="可不填"]', '13800001234')
    await clickByText('button', '保存客户')
    const duplicateText = await page.evaluate(() => document.querySelector('.customer-detail').innerText)
    check(duplicateText.includes('该手机号已有客户档案'), '同店重复手机号被服务端拒绝并给出可照做的提示')
    const keptName = await page.evaluate(() => document.querySelector('input[placeholder="姓名或公司名"]')?.value)
    check(keptName === '重复号测试', '保存失败后已填内容仍在（没有被清空）')
    await shot('1440x1000-customers-duplicate')

    // ── 新增客户成功 ──────────────────────────────────────────
    // 三击全选再输入：比直接改 value + 派发 input 更接近真人操作，也不依赖 React 的 value tracker。
    await page.click('input[placeholder^="可不填"]', { clickCount: 3 })
    await page.keyboard.press('Backspace')
    await page.type('input[placeholder^="可不填"]', '13800009999')
    await clickByText('button', '保存客户')
    await page.waitForFunction(() => (document.body.innerText || '').includes('已建客户档案「重复号测试」'), { timeout: 8000 })
    check(true, '新增客户成功并给出回执')
    const listAfterCreate = await page.evaluate(() => document.querySelectorAll('.customers-table tbody tr').length)
    check(listAfterCreate === 6, `新建后列表变为 6 位客户（实际 ${listAfterCreate}）`)

    // ── 登记设备 → 删除设备 ───────────────────────────────────
    await clickByText('button', '登记设备')
    await page.waitForSelector('input[placeholder="如 联想拯救者 Y7000P 2024"]')
    await page.type('input[placeholder="如 联想拯救者 Y7000P 2024"]', '客户自带来店检测的笔记本')
    await page.type('input[placeholder="如 外店机器，来店清灰"]', '外店机器')
    await clickByText('button', '保存设备')
    await page.waitForFunction(() => (document.querySelector('.customer-devices')?.textContent || '').includes('客户自带来店检测的笔记本'), { timeout: 8000 })
    check(true, '登记设备后出现在该客户名下')
    await shot('1440x1000-customers-device-added')

    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.customer-devices button')].find((b) => (b.textContent || '').trim() === '删')
      button.click()
    })
    await page.waitForFunction(() => !(document.querySelector('.customer-devices')?.textContent || '').includes('客户自带来店检测的笔记本'), { timeout: 8000 })
    check(true, '删除设备后从客户名下移除')

    // ── 搜索 ──────────────────────────────────────────────────
    await page.type('input[aria-label="搜索客户"]', '智诚')
    await clickByText('button', '搜索')
    await page.waitForFunction(() => document.querySelectorAll('.customers-table tbody tr').length === 1, { timeout: 8000 })
    check(true, '搜索走服务端并收敛到 1 行')

    await page.click('input[aria-label="搜索客户"]', { clickCount: 3 })
    await page.type('input[aria-label="搜索客户"]', '查无此客户')
    await clickByText('button', '搜索')
    await page.waitForFunction(() => (document.body.innerText || '').includes('没有匹配的客户'), { timeout: 8000 })
    check(true, '搜索无结果时给出空态而不是空白表格')
    await shot('1440x1000-customers-empty')

    // ── 多视口：不横向溢出 ────────────────────────────────────
    for (const [width, height] of [[1920, 1080], [1440, 1000], [1366, 768], [1280, 800], [1024, 768], [390, 844]]) {
      await page.setViewport({ width, height })
      await page.goto(`${devUrl}/customers`, { waitUntil: 'networkidle0' })
      await page.waitForSelector('.customers-table tbody tr', { timeout: 15000 })
      await settle()
      const key = `${width}x${height}`
      report.measured[key] = await page.evaluate(() => {
        const wrap = document.querySelector('.customers-table-wrap')
        const detail = document.querySelector('.customer-detail')
        return {
          documentScrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          tableWrapOverflowX: wrap ? wrap.scrollWidth - wrap.clientWidth : null,
          tableWrapWidth: wrap ? Math.round(wrap.getBoundingClientRect().width) : null,
          detailWidth: detail ? Math.round(detail.getBoundingClientRect().width) : null,
          rowHeight: Math.round(document.querySelector('.customers-table tbody tr').getBoundingClientRect().height),
        }
      })
      const m = report.measured[key]
      check(m.documentScrollWidth <= m.innerWidth, `${key}：页面无横向溢出`)
      // 表格容器自身允许横向滚动（列多），但页脚/工具栏不能被顶出去
      check(m.tableWrapOverflowX !== null, `${key}：表格在独立容器内滚动`)
      await shot(`${key}-customers-list`)
    }

    // ── 硬边界：全程不碰生产 ──────────────────────────────────
    report.requestHosts = [...new Set(allRequests.map((url) => { try { return new URL(url).host } catch { return url } }))]
    check(!allRequests.some((url) => url.includes('huangqidong.cn')), '全程没有任何请求发往生产域名 huangqidong.cn')
    check(report.errors.length === 0, `无页面 JS 错误（实际 ${report.errors.length}）`)
  } finally {
    fs.writeFileSync(path.join(LOG_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    fs.writeFileSync(path.join(LOG_DIR, 'backend.log'), backend.logs.join(''))
    fs.writeFileSync(path.join(LOG_DIR, 'vite.log'), dev.logs.join(''))
    await browser.close()
    dev.child.kill()
    backend.child.kill()
  }

  console.log(
    JSON.stringify(
      {
        checks: report.checks.length,
        failed: report.failed,
        errors: report.errors,
        consoleErrors: report.consoleErrors.slice(0, 5),
        requestHosts: report.requestHosts,
        measured: report.measured,
      },
      null,
      2,
    ),
  )
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
