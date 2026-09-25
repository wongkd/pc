/**
 * E07 · 缺件采购（拒收与退供）浏览器验收（本地隔离环境，不接触生产）。
 *
 * 与 E06 验收同一套路：后端起 dev-server（真实 Worker + 内存 D1），前端起真实 vite dev，
 * 走真实登录表单，在真实页面上点、填、提交。
 *
 * 这一份专测 E07 里 E06 脚本没覆盖的两条：
 *   1. 到货时**当场拒收**：4 件里收 3 件、拒 1 件 → 可用量只增 3，在途归零、进度「到货完成」
 *      （拒收件从未进入自有在库，所以既不增可用量，也不留在途）；
 *   2. **退供**：从可取件退 1 件 → 实物离店、可用量下降；超量退供被服务端拒绝。
 *
 * 用法：node docs/verification/2026-09-21-E07/verify-purchase.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const puppeteer = require('puppeteer')

const ROOT = path.resolve(__dirname, '../../..')
const FRONTEND = path.join(ROOT, 'frontend')
const BACKEND_PORT = 8817
const DEV_PORT = 5205
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
    scope: '本地隔离环境（真实 Worker + 内存 D1 + 真实 HTTP）；不是生产登录',
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
          // ⚠️ textarea 必须用 HTMLTextAreaElement.prototype 的 setter ——
          // 用 input 的 setter 会抛 Illegal invocation（原生 setter 对类型敏感）。
          const proto =
            input.tagName === 'SELECT'
              ? window.HTMLSelectElement.prototype
              : input.tagName === 'TEXTAREA'
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype
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
    /** 按内容匹配表格行，返回该行每个单元格的文字（用于核对派生量）。 */
    const readRowByText = (needle) =>
      page.evaluate((wanted) => {
        const rows = [...document.querySelectorAll('table tbody tr')]
        const row = rows.find((tr) => (tr.textContent || '').includes(wanted))
        if (!row) return null
        return [...row.querySelectorAll('td')].map((td) => (td.textContent || '').trim())
      }, needle)
    /** 读库存读接口里某个商品的可用量（服务端算出来的，不是页面文字）。 */
    const availableOf = (name) =>
      page.evaluate(async (wanted) => {
        const token = localStorage.getItem('pc-auth-token')
        const response = await fetch('/api/v2/inventory?limit=100', { headers: { Authorization: `Bearer ${token}` } })
        const data = await response.json()
        const row = (data?.data?.items ?? []).find((item) => item.name === wanted)
        return row ? row.availableQty : null
      }, name)

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
    await clickByText('登录')
    await settle(1200)

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

    // ── 铺底：一个逐件商品（不要求 SN，便于演示拒收与退供） ──
    const created = await api('POST', '/api/v2/inventory/products', {
      requestId: 'e07-verify-product',
      name: '验收用批量风扇',
      trackingMode: 'item',
      requiresSn: false,
    })
    check(created.status === 200, `商品建档成功（${created.status}）`)
    const productRef = created.body?.data?.entityId
    check(Boolean(productRef), '建档响应给出商品引用（entityId）')

    // ── 页面上建采购单：4 件 ──
    await page.goto(`${devUrl}/inventory/purchases`, { waitUntil: 'networkidle2' })
    await settle(900)
    check((await text()).includes('缺件处理'), '契约路径 /inventory/purchases 打开缺件处理页')
    await shot('01-purchase-empty')

    await clickByText('新建采购单')
    await settle(700)
    await fillByLabel('供应商名称', '验收返修档口')
    await fillByLabel('商品', productRef)
    await fillByLabel('数量', '4')
    await fillByLabel('约定单价（元）', '88')
    await clickByText('创建采购单')
    await settle(1500)
    check((await text()).includes('尚未到货'), '新建采购单进度为「尚未到货」')
    await shot('02-purchase-created')

    // ── 到货：收 3 拒 1 ──
    // ⚠️ 逐件管理的商品必须给每件一个内部编号，否则服务端按 SERIAL/编号不足拒绝
    // （这是 E07 的正式规则，不是脚本障碍 —— 缺编号的货事后无法核对）。
    await fillByLabel('本次实到', '3')
    await fillByLabel('本次拒收', '1')
    await fillByLabel('逐件编号', 'E07-A-001\nE07-A-002\nE07-A-003')
    await clickByText('登记到货')
    await settle(1600)
    const afterReceipt = await text()
    check(afterReceipt.includes('到货完成'), '收 3 拒 1 后进度为「到货完成」（拒收也计入已处置，不留虚在途）')
    check(afterReceipt.includes('拒收 1 件'), '到货记录标出拒收 1 件')
    await shot('03-receipt-with-rejection')

    const purchaseRow = await readRowByText('验收用批量风扇')
    report.purchaseRow = purchaseRow
    // 详情页明细表列序：# / 商品 / 订购 / 实到 / 拒收 / 在途 / 约定成本
    check(purchaseRow?.[2] === '4', `订购量显示 4（实际 ${purchaseRow?.[2]}）`)
    check(purchaseRow?.[3] === '3', `实到显示 3（实际 ${purchaseRow?.[3]}）`)
    check(purchaseRow?.[4] === '1', `拒收显示 1（实际 ${purchaseRow?.[4]}）`)
    check(purchaseRow?.[5] === '0', `在途显示 0（实际 ${purchaseRow?.[5]}）`)

    const balance = await availableOf('验收用批量风扇')
    report.availableAfterReceipt = balance
    check(balance === 3, `可用量 = 3（拒收不进可用，实际 ${balance}）`)

    // ── 退供：从可取件退 1 件 ──
    await fillByLabel('退供数量', '1')
    await fillByLabel('原因', '风叶有异响，退回档口换新')
    await clickByText('登记退供')
    await settle(1600)
    const afterReturn = await text()
    check(afterReturn.includes('退回档口换新') || afterReturn.includes('退供 1 件'), '退供登记有回执')
    await shot('04-supplier-return')

    const afterReturnBalance = await availableOf('验收用批量风扇')
    report.availableAfterReturn = afterReturnBalance
    check(afterReturnBalance === 2, `退供后可用量 = 2（退 1 件离店，实际 ${afterReturnBalance}）`)

    // ── 超量退供必须被拒（可退只剩 2 件） ──
    await fillByLabel('退供数量', '9')
    await clickByText('登记退供')
    await settle(1400)
    const overflowText = await text()
    check(
      overflowText.includes('退供') && (overflowText.includes('不足') || overflowText.includes('超过')),
      '超量退供被服务端拒绝并给出人话原因',
    )
    await shot('05-supplier-return-rejected')

    await page.goto(`${devUrl}/purchases`, { waitUntil: 'networkidle2' })
    await settle(900)
    await shot('06-purchase-list-final')
  } catch (error) {
    report.errors.push(`脚本异常：${error instanceof Error ? error.message : String(error)}`)
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
  for (const item of report.failed) console.log(`  ✗ ${item}`)
  for (const item of report.errors) console.log(`  ! ${item}`)
  console.log(`报告：${path.join(OUT, 'report.json')}`)
  process.exit(failedCount === 0 && report.errors.length === 0 ? 0 : 1)
}

main()
