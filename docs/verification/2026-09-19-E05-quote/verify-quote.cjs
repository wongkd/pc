/**
 * E05 · 报价闭环浏览器验收（本地隔离环境，不接触生产）。
 *
 * 与 E04b 验收同一个套路，也就同一条硬边界：
 *   · 后端起 `backend/scripts/dev-server.mjs`（miniflare + 真实 Worker 入口 + 内存 D1 + 演示数据）；
 *   · 前端起真实 vite dev，`/api` 经代理打到那个本地后端；
 *   · 走真实登录表单拿 token，再在真实页面上点、填、提交。
 * 页面上的每一个数字都经过 HTTP + 契约信封 + 鉴权 + 权限 + SQL + 幂等执行器。
 *
 * 唯一一处「不走页面」的动作：造一条已过期的演示单（走同一个真实 API，
 * 带过去的 validUntil）—— UI 不提供「发出即过期」的入口，续期按钮的场景只能这样构造；
 * 构造之后的所有断言仍然全部在真实页面上完成。
 *
 * 断言是软断言：失败记进 report.failed 但不中断，一次运行拿到完整报告。
 *
 * 用法：node docs/verification/2026-09-19-E05-quote/verify-quote.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const puppeteer = require('puppeteer')

const ROOT = path.resolve(__dirname, '../../..')
const FRONTEND = path.join(ROOT, 'frontend')
const BACKEND_PORT = 8814
const DEV_PORT = 5202
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
      if (message.type() !== 'error') return
      const location = message.location()?.url ?? ''
      report.consoleErrors.push(location ? `${message.text()} @ ${location}` : message.text())
    })
    page.on('request', (request) => allRequests.push(request.url()))
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

    /** 在 select 里按选项文案选中（option 的 value 是服务端生成的实体 ID，测试不该猜）。 */
    const selectByText = async (selector, needle) => {
      const value = await page.evaluate((sel, searchText) => {
        const select = document.querySelector(sel)
        if (!select) return null
        const option = [...select.options].find((item) => item.textContent.includes(searchText))
        if (!option) return null
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
        setter.call(select, option.value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
        return option.value
      }, selector, needle)
      await settle()
      return value
    }

    /** 等下拉里的选项出现（客户名单 / 实物清单是进编辑页后异步拉的）。 */
    const waitForOption = async (selector, needle, timeout = 10000) => {
      try {
        await page.waitForFunction(
          (sel, searchText) => {
            const select = document.querySelector(sel)
            return Boolean(select && [...select.options].some((item) => item.textContent.includes(searchText)))
          },
          { timeout },
          selector,
          needle,
        )
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

    /** 点某一行里的「查看」（按该行标题找），从列表进入对应详情。 */
    const openRow = async (needle) => {
      const clicked = await page.evaluate((searchText) => {
        const row = [...document.querySelectorAll('.wb-quote-table tbody tr')].find((node) => node.textContent.includes(searchText))
        if (!row) return false
        const button = [...row.querySelectorAll('button')].find((node) => node.textContent.trim() === '查看')
        if (!button) return false
        button.click()
        return true
      }, needle)
      await settle()
      return clicked
    }

    /** 等待详情页出现某段文本（「等条件成立」，不是「睡一下再读」）。 */
    const waitText = async (needle, timeout = 10000) => {
      try {
        await page.waitForFunction((want) => document.body.innerText.includes(want), { timeout }, needle)
        return true
      } catch {
        return false
      }
    }

    // ── 真实登录 ──────────────────────────────────────────────
    await page.goto(`${devUrl}/`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('input[placeholder="邮箱"]', { timeout: 15000 })
    await page.type('input[placeholder="邮箱"]', EMAIL)
    await page.type('input[placeholder="密码"]', PASSWORD)
    await clickByText('button', '登录')
    await page.waitForFunction(() => !document.querySelector('.login-overlay'), { timeout: 15000 })
    check(true, '用本地演示账号通过真实登录表单进入系统')

    // ── 入口：/sales 工作区的占位项现在可达 ───────────────────
    await page.goto(`${devUrl}/sales`, { waitUntil: 'networkidle0' })
    await settle()
    // 落地页卡片里的按钮文案统一是「进入」，按卡片标题定位
    const enteredQuote = await page.evaluate(() => {
      const card = [...document.querySelectorAll('.wb-landing-card')].find((node) => node.textContent.includes('新建装机报价'))
      if (!card) return false
      const button = [...card.querySelectorAll('button')].find((node) => node.textContent.trim() === '进入')
      if (!button) return false
      button.click()
      return true
    })
    check(enteredQuote, '开单工作区里的「新建装机报价」入口可点击')
    await page.waitForFunction(() => location.pathname === '/sales/quotes', { timeout: 8000 })
    check(true, '入口把人带到 /sales/quotes 报价列表')

    // ── 空列表 ────────────────────────────────────────────────
    await page.waitForSelector('.wb-quote-table, .wb-inv-state', { timeout: 15000 })
    await settle()
    check((await text()).includes('还没有报价单'), `空列表给出可照做的引导（实际「${(await text()).split('\n').find((line) => line.includes('还没有'))}」）`)
    await shot('1440x1000-quote-list-empty')

    // ── 新建报价：选客户、三类来源行 ──────────────────────────
    check(await clickByText('button', '新建装机报价'), '点「新建装机报价」进入编辑视图')
    await page.waitForSelector('#quote-title', { timeout: 8000 })

    await clearAndType('#quote-title', '验收用办公主机')
    check(await waitForOption('#quote-customer', '黄小满'), '客户下拉加载出真实客户台账的选项')
    check((await selectByText('#quote-customer', '黄小满')) !== null, '客户下拉来自真实客户台账（选中演示客户黄小满）')
    await clearAndType('#quote-budget', '8000')
    await clearAndType('#quote-discount', '100')

    // 第 1 行：新品
    await clearAndType('input[aria-label="第 1 行名称"]', 'i5 处理器')
    await clearAndType('input[aria-label="第 1 行单价（元）"]', '1299')
    // 第 2 行：二手（选真实演示实物 U-3080-001）
    check(await clickByText('button', '加一行'), '加出第 2 行')
    await page.select('select[aria-label="第 2 行来源"]', 'used')
    await settle(200)
    await clearAndType('input[aria-label="第 2 行名称"]', '二手显卡 RTX 3080')
    check(await waitForOption('select[aria-label="第 2 行实物"]', 'U-3080-001'), '实物下拉加载出库存逐件实物')
    const stockSelected = await selectByText('select[aria-label="第 2 行实物"]', 'U-3080-001')
    check(stockSelected !== null, '二手行能从库存逐件实物里选择（U-3080-001）')
    await clearAndType('input[aria-label="第 2 行单价（元）"]', '1500')
    // 第 3 行：服务费
    check(await clickByText('button', '加一行'), '加出第 3 行')
    await page.select('select[aria-label="第 3 行来源"]', 'service')
    await settle(200)
    await clearAndType('input[aria-label="第 3 行名称"]', '装机服务费')
    await clearAndType('input[aria-label="第 3 行单价（元）"]', '200')

    const summaryBefore = await page.evaluate(() => document.querySelector('.wb-quote-summary')?.innerText ?? '')
    check(summaryBefore.includes('小计 ¥2,999.00') && summaryBefore.includes('应付 ¥2,899.00'), `合计条实时算出小计 2,999、扣优惠 100 后应付 ¥2,899.00（实际「${summaryBefore.split('\n').join(' / ')}」）`)
    check(!summaryBefore.includes('省'), '预算对照不写「省」字（Q01 规则⑤）')
    await shot('1440x1000-quote-editor')

    await clickByText('button', '创建草稿')
    check(await waitText('配置明细'), '创建草稿成功并进入详情视图')
    await settle()
    await shot('1440x1000-quote-detail-draft')

    const draftDetail = await text()
    check(draftDetail.includes('第 1 版') && draftDetail.includes('草稿'), '详情显示第 1 版、状态草稿')
    check(draftDetail.includes('应付 ¥2,899.00'), `详情应付 = ¥2,899.00（小计 2,999 − 优惠 100；实际含「${draftDetail.split('\n').find((line) => line.includes('应付'))}」）`)
    check(draftDetail.includes('定金比例：15%'), '条款快照带默认定金比例 15%')
    check(!draftDetail.includes('成本') && !draftDetail.includes('供应商') && !draftDetail.includes('SN3080'), '详情不出现成本 / 供应商 / SN（数据源头脱敏）')

    // ── 发出 ──────────────────────────────────────────────────
    check(await clickByText('button', '发出草稿版'), '详情里能发出草稿版')
    check(await waitText('只显示这一次'), '发出成功后给出分享凭证明文（只此一次）')
    check(await waitText('顾客端页面尚未开通'), '凭证提示明确标注顾客端页面尚未开通（不假装链接能用）')
    await settle()
    await shot('1440x1000-quote-issued')

    const issuedDetail = await text()
    check(issuedDetail.includes('已发出'), '详情状态变为已发出')
    check(issuedDetail.includes('有效期至'), '已发出版本带有效期')

    // ── 列表回看 ──────────────────────────────────────────────
    await page.goto(`${devUrl}/sales/quotes`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('.wb-quote-table', { timeout: 15000 })
    await settle()
    const listText = await text()
    check(listText.includes('验收用办公主机') && listText.includes('已发出'), '列表出现刚发出的报价单，状态已发出')
    check(listText.includes('在谈 1'), '汇总条把在谈单数出来')
    await shot('1440x1000-quote-list-issued')

    // ── 改版：旧版本不可覆盖，新版本要重新发出 ────────────────
    check(await openRow('验收用办公主机'), '从列表打开报价单')
    await waitText('配置明细')
    check(await clickByText('button', '改一版'), '点「改一版」进入编辑（以当前版本为底稿）')
    await page.waitForSelector('#quote-title', { timeout: 8000 })
    await clearAndType('input[aria-label="第 1 行单价（元）"]', '1199')
    await clearAndType('#quote-reason', '验收改价：换主板套餐')
    await page.select('#quote-feedback', 'wechat')
    await settle()
    await clickByText('button', '保存并发出')
    check(await waitText('版本历史'), '改版发出后详情出现版本历史')
    await settle()
    await shot('1440x1000-quote-revised')

    const revisedDetail = await text()
    check(revisedDetail.includes('第 2 版'), '详情指向第 2 版（新版本）')
    check(revisedDetail.includes('应付 ¥2,799.00'), `第 2 版按新价格合计 ¥2,799.00（1199+1500+200−100；实际含「${revisedDetail.split('\n').find((line) => line.includes('应付'))}」）`)
    check(revisedDetail.includes('改版原因：验收改价：换主板套餐（微信）'), '改版原因与反馈来源随版本快照展示')
    // 页面有两个 .wb-quote-table（配置明细 + 版本历史），只取最后一个的历史行
    const historyRows = await page.evaluate(() => {
      const tables = [...document.querySelectorAll('.wb-quote-table')]
      const last = tables[tables.length - 1]
      return [...(last?.querySelectorAll('tbody tr') ?? [])].map((node) => node.textContent)
    })
    check(historyRows.length === 2, `版本历史两版（实际 ${historyRows.length}）`)
    check(historyRows.some((row) => row.includes('v1') && row.includes('¥2,899.00')), '旧版本金额原样留在账上（v1 应付仍是 ¥2,899.00）')

    // ── 过期与续期（过期单由同一真实 API 构造，断言全在页面上）──
    const loginResponse = await fetch(`${backendUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })
    const { token } = await loginResponse.json()
    const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': 'verify-expired-create' }
    const created = await fetch(`${backendUrl}/api/v2/sales/quotes`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ requestId: 'verify-expired-create', title: '验收用过期单', lines: [{ source: 'new', nameSnapshot: '过期测试件', qty: 1, unitPriceCents: 10000 }] }),
    })
    const createdBody = await created.json()
    check(created.ok && createdBody.data?.entityId, '（构造）走真实 API 建一条草稿')
    const expiredQuoteId = createdBody.data.entityId
    const issued = await fetch(`${backendUrl}/api/v2/sales/quotes/${encodeURIComponent(expiredQuoteId)}/issue`, {
      method: 'POST',
      headers: { ...authHeaders, 'Idempotency-Key': 'verify-expired-issue' },
      body: JSON.stringify({ requestId: 'verify-expired-issue', expectedVersion: 1, validUntil: '2020-01-01T00:00:00.000Z' }),
    })
    check(issued.ok, '（构造）把它发出为 2020 年就过期的版本')

    await page.goto(`${devUrl}/sales/quotes`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('.wb-quote-table', { timeout: 15000 })
    await settle()
    check(await waitText('已过期'), '列表把过期单标出来（服务端算出的状态）')
    await shot('1440x1000-quote-list-expired')

    check(await openRow('验收用过期单'), '打开过期单详情')
    check(await waitText('续期 24 小时'), '过期单出现「续期 24 小时」按钮')
    await shot('1440x1000-quote-detail-expired')

    await clickByText('button', '续期 24 小时')
    check(await waitText('旧链接锁定的是旧版本'), '续期 = 保存新版本再发出，并提示旧链接已锁旧版本')
    await settle()
    await shot('1440x1000-quote-renewed')

    const renewedDetail = await text()
    check(!renewedDetail.includes('已过期'), '续期后当前版本不再是已过期')
    check(renewedDetail.includes('已发出'), '续期后新版本为已发出')

    // ── 打印脱敏 ──────────────────────────────────────────────
    const popupPromise = new Promise((resolve) => {
      const handler = (target) => {
        browser.off('targetcreated', handler)
        resolve(target)
      }
      browser.on('targetcreated', handler)
    })
    await clickByText('button', '打印配置单')
    let printOk = false
    let printText = ''
    let printDiag = ''
    try {
      const popupTarget = await Promise.race([popupPromise, sleep(10000).then(() => null)])
      const popup = popupTarget ? await popupTarget.page().catch(() => null) : null
      printDiag = popupTarget ? `target=${popupTarget.url()}` : 'target=none'
      if (popup) {
        printDiag += ` page=${popup.url()}`
        await popup.waitForFunction(() => document.readyState === 'complete' || (document.body && document.body.innerText.length > 0), { timeout: 8000 }).catch(() => {})
        printText = await popup.evaluate(() => document.body?.innerText ?? '').catch((error) => `evaluate失败: ${error.message}`)
        await popup.close().catch(() => {})
      }
      // 打印的是当前打开的详情（续期流程后停在「验收用过期单」），按那张单断言
      printOk = printText.includes('验收用过期单') && printText.includes('过期测试件') && printText.includes('应付')
    } catch (error) {
      printDiag += ` exception=${error.message}`
    }
    report.printDiagnostic = { printDiag, printTextHead: String(printText).slice(0, 200) }
    check(printOk, '打印视图带标题、配置行与应付金额')
    check(!printText.includes('成本') && !printText.includes('供应商') && !printText.includes('SN3080'), '打印视图不含成本 / 供应商 / SN')
    check(!printText.includes('预算'), '打印视图不出现「预算」字样（预算是内部参考，Q01 规则①）')

    // ── 多视口：不横向溢出 ────────────────────────────────────
    for (const [width, height] of [[1920, 1080], [1440, 1000], [1280, 800], [390, 844]]) {
      await page.setViewport({ width, height })
      await page.goto(`${devUrl}/sales/quotes`, { waitUntil: 'networkidle0' })
      await page.waitForSelector('.wb-quote-table', { timeout: 15000 })
      await settle()
      const key = `${width}x${height}`
      report.measured[key] = await page.evaluate(() => ({
        documentScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }))
      const m = report.measured[key]
      check(m.documentScrollWidth <= m.innerWidth, `${key}：报价列表无横向溢出`)
      await shot(`${key}-quote-list`)

      // 编辑视图在窄屏也要能用
      if (width === 390) {
        await clickByText('button', '新建装机报价')
        await page.waitForSelector('#quote-title', { timeout: 8000 })
        await settle()
        const editorMeasure = await page.evaluate(() => ({
          documentScrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }))
        check(editorMeasure.documentScrollWidth <= editorMeasure.innerWidth, `${key}：编辑视图无横向溢出`)
        await shot(`${key}-quote-editor`)
      }
    }

    // ── 硬边界：全程不碰生产 ──────────────────────────────────
    report.requestHosts = [...new Set(allRequests.map((url) => { try { return new URL(url).host } catch { return url } }))]
    check(!allRequests.some((url) => url.includes('huangqidong.cn')), '全程没有任何请求发往生产域名 huangqidong.cn')
    check(
      report.apiFailures.length === 0,
      `页面交互没有产生任何 4xx/5xx（实际 ${report.apiFailures.length} 条：${report.apiFailures.map((f) => `${f.status} ${f.url}`).join('; ')}）`,
    )
    check(report.errors.length === 0, `无页面 JS 错误（实际 ${report.errors.length}）`)
    const unexpectedConsoleErrors = report.consoleErrors.filter((message) => !message.includes('favicon'))
    check(
      unexpectedConsoleErrors.length === 0,
      `控制台没有意外错误（实际 ${unexpectedConsoleErrors.length} 条：${unexpectedConsoleErrors.slice(0, 3).join(' | ')}）`,
    )
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
        apiFailures: report.apiFailures,
        requestHosts: report.requestHosts,
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
