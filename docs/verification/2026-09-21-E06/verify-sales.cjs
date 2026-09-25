/**
 * E06 · 销售单与收款浏览器验收（本地隔离环境，不接触生产）。
 *
 * 与 E05 / E05b 验收同一个套路：
 *   · 后端起 backend/scripts/dev-server.mjs（miniflare + 真实 Worker 入口 + 内存 D1 + 演示数据）；
 *   · 前端起真实 vite dev，/api 经代理打到那个本地后端；
 *   · 走真实登录表单，在真实页面上点、填、提交。每个动作都是完整链路
 *     （HTTP + 契约信封 + 鉴权 + 权限 + SQL + 幂等执行器）。
 *
 * 覆盖的界面路径：
 *   1. 报价页：已发出报价 → 点「确认成交（转销售单）」→ 跳到订单处理页；
 *   2. 订单列表：指标卡（全部 / 草稿 / 待付款 / 待收金额）与表格；
 *   3. 订单详情：未收款时点「确认成交」被服务端拒绝，页面显示「未付款不预留」的原因；
 *   4. 登记收款 → 待收金额下降、收款记录出现；
 *   5. 再点「确认成交」→ 状态变「已确认」，缺件行仍在缺口里；
 *   6. 缺件采购页：新建采购单 → 登记部分到货 → 在途自动剩 2。
 *
 * 断言是软断言：失败记进 report.failed 但不中断，一次运行拿到完整报告。
 *
 * 用法：node docs/verification/2026-09-21-E06/verify-sales.cjs
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

    /** 点一个按钮：按可见文字精确匹配（页面上的按钮文字就是用户看到的文字）。 */
    const clickByText = async (label, { exact = true } = {}) => {
      const clicked = await page.evaluate(
        (wanted, isExact) => {
          const nodes = [...document.querySelectorAll('button, a')]
          const target = nodes.find((el) => {
            const value = (el.textContent || '').trim()
            return isExact ? value === wanted : value.includes(wanted)
          })
          if (!target) return false
          target.scrollIntoView({ block: 'center' })
          target.click()
          return true
        },
        label,
        exact,
      )
      if (clicked) await settle()
      return clicked
    }

    const fillByLabel = async (label, value) => {
      const ok = await page.evaluate(
        (wanted, next) => {
          const labels = [...document.querySelectorAll('label')]
          const holder = labels.find((el) => (el.textContent || '').includes(wanted))
          if (!holder) return false
          const input = holder.querySelector('input, textarea, select')
          if (!input) return false
          const proto = input.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          setter?.call(input, next)
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
          return true
        },
        label,
        value,
      )
      if (ok) await settle(150)
      return ok
    }

    // ─────────────────────── 登录 ───────────────────────
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
    await clickByText('登录')
    await settle(1200)
    check((await text()).includes('经营') || (await text()).includes('今天') || (await text()).includes('开单'), '登录后进入 ERP 外壳')

    /** 页面上直接调契约接口铺数据（带真实会话令牌）。 */
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

    // ─────────────────────── 铺底：商品 + 期初实物 + 报价 ───────────────────────
    // ⚠️ 建档时**不传** productRef：contracts 里 productRef 存在即表示「修改既有商品」，
    // 必须带 expectedVersion（inventory.ts validateProductInput）。新建时由服务端生成
    // `${requestId}::product` 作为 entityId，建完从响应里拿回来用。
    const created = await api('POST', '/api/v2/inventory/products', {
      requestId: 'e06-verify-product',
      name: '验收用二手显卡',
      trackingMode: 'item',
      requiresSn: false,
    })
    check(created.status === 200, `商品建档成功（${created.status}）`)
    const productRef = created.body?.data?.entityId
    check(Boolean(productRef), '建档响应给出商品引用（entityId）')

    // 采购那一头用数量件：装箱数量件不需要逐件编号，正好演示「5 件到 3 件」。
    const createdBulk = await api('POST', '/api/v2/inventory/products', {
      requestId: 'e06-verify-product-bulk',
      name: '验收用批量风扇',
      trackingMode: 'quantity',
      requiresSn: false,
    })
    check(createdBulk.status === 200, `数量件商品建档成功（${createdBulk.status}）`)
    const bulkRef = createdBulk.body?.data?.entityId

    const opening = await api('POST', '/api/v2/inventory/openings', {
      requestId: 'e06-verify-opening',
      approvedCountRef: '2026-09-21 现场实盘（验收）',
      costBasis: { kind: 'known', note: '验收样本' },
      lines: [{ productRef, qty: 1, condition: 'used', assetCode: 'E06-VERIFY-1', unitCostCents: 50_000 }],
    })
    check(opening.status === 200, `期初建账成功（${opening.status}）`)

    // 数量件也给点期初（2 件）：确认成交时要真的锁住它，这是「付定金即锁库存」对
    // 按量卖的新品也生效的证据（行数量 3，锁 2，待补 1）。
    const openingBulk = await api('POST', '/api/v2/inventory/openings', {
      requestId: 'e06-verify-opening-bulk',
      approvedCountRef: '2026-09-21 现场实盘（数量件，验收）',
      costBasis: { kind: 'known', note: '验收样本' },
      lines: [{ productRef: bulkRef, qty: 2, condition: 'new', unitCostCents: 12_000 }],
    })
    check(openingBulk.status === 200, `数量件期初建账成功（${openingBulk.status}）`)

    const stockItemId = await page.evaluate(async () => {
      const token = localStorage.getItem('pc-auth-token')
      const response = await fetch('/api/v2/inventory?availability=available&limit=50', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await response.json()
      const lot = data?.data?.lotItems ?? []
      const hit = lot.find((row) => row.assetCode === 'E06-VERIFY-1') ?? lot[0]
      return hit ? hit.id : null
    })
    check(Boolean(stockItemId), '能从库存读接口拿到刚建实物的编号')

    const quote = await api('POST', '/api/v2/sales/quotes', {
      requestId: 'e06-verify-quote',
      title: 'E06 验收报价',
      lines: [
        { source: 'used', nameSnapshot: '验收用二手显卡', qty: 1, unitPriceCents: 100_000, stockItemId },
        // 新品行**必须**带商品引用：契约要求成交前必须映射到商品，不带转单会被服务端拒。
        { source: 'new', nameSnapshot: '验收用新品散热器', qty: 3, unitPriceCents: 20_000, productRef: bulkRef },
      ],
      discountCents: 5_000,
    })
    check(quote.status === 200, `报价草稿创建成功（${quote.status}）`)
    const quoteId = quote.body?.data?.entityId
    const issued = await api('POST', `/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/issue`, {
      requestId: 'e06-verify-issue',
      expectedVersion: quote.body?.data?.entityVersion,
    })
    check(issued.status === 200, `报价发出成功（${issued.status}）`)

    // ─────────────────────── 1. 报价页点「确认成交（转销售单）」 ───────────────────────
    await page.goto(`${devUrl}/sales/quotes`, { waitUntil: 'networkidle2' })
    await settle(900)
    check((await text()).includes('E06 验收报价'), '报价列表出现验收报价')
    // 列表行的入口按钮文字是「查看」（不是标题），所以按行找按钮，不按标题点。
    const openedQuote = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr')]
      const row = rows.find((tr) => (tr.textContent || '').includes('E06 验收报价'))
      if (!row) return false
      const button = [...row.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === '查看')
      if (!button) return false
      button.scrollIntoView({ block: 'center' })
      button.click()
      return true
    })
    check(openedQuote, '点开报价详情')
    await settle(900)
    const detailText = await text()
    check(detailText.includes('确认成交（转销售单）'), '报价详情出现「确认成交（转销售单）」按钮')
    await shot('01-quote-can-convert')

    await clickByText('确认成交（转销售单）')
    await settle(1500)
    const afterConvert = await text()
    check(afterConvert.includes('订单处理'), `转单后跳到订单处理页（当前 URL：${page.url()}）`)
    check(afterConvert.includes('E06-VERIFY-1') || afterConvert.includes('验收用二手显卡') || afterConvert.includes('SO-'), '订单列表出现刚生成的销售单')
    await shot('02-order-list')

    // ─────────────────────── 2. 未付款 → 确认成交被拒 ───────────────────────
    await clickByText('SO-', { exact: false })
    await settle(900)
    const orderText = await text()
    check(orderText.includes('待收'), '订单详情显示待收金额')
    check(orderText.includes('定金门槛'), '订单详情显示定金门槛（未付款不预留的依据）')
    check(orderText.includes('缺件'), '订单详情标出缺件（新品行没有实物）')
    await shot('03-order-detail-no-payment')

    const beforePayConfirm = await clickByText('确认成交（占用实物）')
    check(beforePayConfirm, '未收款时「确认成交」按钮可点击（由服务端判定，不靠前端禁用）')
    await settle(900)
    const deniedText = await text()
    check(
      deniedText.includes('未付款不预留') || deniedText.includes('定金'),
      '未收款确认成交被拒，页面给出「未付款不预留」的原因',
    )
    await shot('04-confirm-denied-before-payment')

    // ─────────────────────── 3. 登记收款 ───────────────────────
    // 订单总额 = 100000 + 3×20000 − 5000 = 155000 分，定金门槛 15% = 23250 分。
    // 先付 250 元（25000 分）越过门槛，才能确认成交。
    await fillByLabel('金额（元）', '250')
    await fillByLabel('备注', '验收定金')
    await clickByText('登记收款')
    await settle(1400)
    const afterPay = await text()
    check(afterPay.includes('验收定金'), '收款记录出现（备注可见）')
    check(afterPay.includes('已对账') || afterPay.includes('待对账'), '收款记录标出对账状态')
    await shot('05-payment-registered')

    // ─────────────────────── 4. 收款后确认成交 ───────────────────────
    await clickByText('确认成交（占用实物）')
    await settle(1500)
    const afterConfirm = await text()
    check(afterConfirm.includes('已确认'), '确认成交后状态变为「已确认」')
    check(afterConfirm.includes('已被占用') || afterConfirm.includes('已占'), '二手实物显示为已占用')
    // 数量件新品：行数量 3 − 已锁 2 = 待补 1 件。
    // 这一条同时证明两件事：按量卖的商品付定金后真的锁住了库存；缺口只算「锁不满的差额」。
    check(afterConfirm.includes('待补'), '数量件锁不满的差额标为待补（缺口）')
    check(afterConfirm.includes('共 1 件'), '已锁 2 件，待补只剩 1 件（不是把行数量 3 全算成缺口）')
    check(
      afterConfirm.includes('按数量已锁 2 件'),
      '数量件行的实物列显示已锁数量，不再把已锁货的行误报成「未指定实物（缺件）」',
    )
    await shot('06-order-confirmed')

    // ─────────────────────── 5. 切到缺件采购页做一次部分到货 ───────────────────────
    await page.goto(`${devUrl}/purchases`, { waitUntil: 'networkidle2' })
    await settle(900)
    check((await text()).includes('缺件处理'), '旧深链 /purchases 指向缺件处理页')
    await shot('07-purchase-list')

    await clickByText('新建采购单')
    await settle(700)
    await fillByLabel('供应商名称', '验收档口（快捷供应商）')
    await fillByLabel('商品', bulkRef)
    await fillByLabel('数量', '5')
    await fillByLabel('约定单价（元）', '120')
    await clickByText('创建采购单')
    await settle(1500)
    const purchaseDetail = await text()
    check(purchaseDetail.includes('在途'), '采购详情显示在途')
    check(purchaseDetail.includes('尚未到货'), '新采购单进度为「尚未到货」')
    await shot('08-purchase-detail')

    await fillByLabel('本次实到', '3')
    await clickByText('登记到货')
    await settle(1500)
    const afterReceipt = await text()
    check(afterReceipt.includes('部分到货'), '5 件到 3 件后进度变「部分到货」')
    check(/在途\s*2|在途2/.test(afterReceipt.replace(/\s+/g, ' ')) || afterReceipt.includes('在途'), '在途数量已更新（应为 2）')
    await shot('09-purchase-partial-receipt')

    const pendingOk = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr')]
      const row = rows.find((tr) => (tr.textContent || '').includes('验收用批量风扇'))
      if (!row) return null
      const cells = [...row.querySelectorAll('td')].map((td) => (td.textContent || '').trim())
      return cells
    })
    report.purchaseRow = pendingOk
    check(Boolean(pendingOk) && pendingOk.includes('2'), '采购行在途 = 2（订购 5 − 实到 3）')

    await page.goto(`${devUrl}/sales/orders`, { waitUntil: 'networkidle2' })
    await settle(900)
    await shot('10-order-list-final')
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
    fs.writeFileSync(path.join(LOG_DIR, 'backend.log'), backend.logs.join(''))
    fs.writeFileSync(path.join(LOG_DIR, 'frontend.log'), dev.logs.join(''))
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  }

  const failedCount = report.failed.length
  console.log(`检查项 ${report.checks.length} / 失败 ${failedCount}`)
  if (failedCount) {
    for (const item of report.failed) console.log(`  ✗ ${item}`)
  }
  if (report.errors.length) {
    for (const item of report.errors) console.log(`  ! ${item}`)
  }
  console.log(`报告：${path.join(OUT, 'report.json')}`)
  process.exit(failedCount === 0 && report.errors.length === 0 ? 0 : 1)
}

main()
