/**
 * E04b · 商品 / 实物 / 期初库存浏览器验收（本地隔离环境，不接触生产）。
 *
 * 与 E04 客户台账验收同一个套路，也就同一条硬边界：
 *   · 后端起 `backend/scripts/dev-server.mjs`（miniflare + 真实 Worker 入口 + 内存 D1 + 演示数据）；
 *   · 前端起真实 `vite` dev，`/api` 经 vite.config.ts 的代理打到那个本地后端；
 *   · 走真实登录表单拿 token，再在真实页面上点、填、提交。
 * 所以这里出现的每一个数字都经过了 HTTP + /api/v2 契约信封 + 鉴权 + 权限 + SQL + 幂等执行器。
 *
 * 断言是软断言：失败记进 report.failed 但不中断，一次运行拿到完整报告。
 *
 * 用法：node docs/verification/2026-09-19-E04b-inventory/verify-inventory.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const puppeteer = require('puppeteer')

const ROOT = path.resolve(__dirname, '../../..')
const FRONTEND = path.join(ROOT, 'frontend')
const BACKEND_PORT = 8812
const DEV_PORT = 5200
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
      // 带上来源 URL：浏览器对 4xx 也报 console error，不带 URL 就分不清是哪一条请求。
      const location = message.location()?.url ?? ''
      report.consoleErrors.push(location ? `${message.text()} @ ${location}` : message.text())
    })
    page.on('request', (request) => allRequests.push(request.url()))
    // 记下每一条 4xx/5xx 的响应体：失败时报告自己说明原因，不用靠猜（第一轮的 400 就是这样被误读的）。
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

    /** 表头 + 每一行的单元格文本，按渲染顺序取，避免用整页文本误判。 */
    const readTable = () => page.evaluate(() => ({
      headers: [...document.querySelectorAll('.wb-inv-head span')].map((node) => node.textContent.trim()),
      rows: [...document.querySelectorAll('.wb-inv-group')].map((group) => {
        const row = group.querySelector('.wb-inv-row')
        const name = group.querySelector('.wb-inv-name')?.childNodes[0]?.textContent?.trim() ?? ''
        return {
          name,
          cells: [...row.children].map((node) => node.textContent.trim()),
          open: row.getAttribute('aria-expanded') === 'true',
        }
      }),
      totals: document.querySelector('.wb-inv-totals')?.innerText ?? '',
      foot: document.querySelector('.wb-inv-foot')?.innerText ?? '',
    }))

    /**
     * 展开某一行。**先看 aria-expanded，只有收起时才点** —— 写完一次动作后页面会重载，
     * 行可能还是展开的，无条件点击会把它收起来（第一轮就是在这里断掉的）。
     */
    const expandRow = async (nameFragment) => {
      const state = await page.evaluate((needle) => {
        const group = [...document.querySelectorAll('.wb-inv-group')].find((node) => (node.querySelector('.wb-inv-name')?.textContent || '').includes(needle))
        if (!group) return 'missing'
        const row = group.querySelector('.wb-inv-row')
        if (row.getAttribute('aria-expanded') === 'true') return 'already-open'
        row.click()
        return 'clicked'
      }, nameFragment)
      await settle(700)
      return state !== 'missing'
    }

    /** 在 select 里按选项文案选中（option 的 value 是服务端生成的实体 ID，测试不该猜）。 */
    const selectByText = async (selector, needle) => {
      const value = await page.evaluate((sel, text) => {
        const select = document.querySelector(sel)
        if (!select) return null
        const option = [...select.options].find((item) => item.textContent.includes(text))
        if (!option) return null
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
        setter.call(select, option.value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
        return option.value
      }, selector, needle)
      await settle()
      return value
    }

    const openFresh = async () => {
      await page.goto(`${devUrl}/inventory`, { waitUntil: 'networkidle0' })
      await page.waitForSelector('.wb-inv-group', { timeout: 15000 })
      await settle()
    }

    /**
     * 等某个型号行的某一列变成期望值。
     * 写完一次动作后列表会重新拉取；直接读会读到旧快照（第一轮就是这么误判的），
     * 所以这里的断言一律「等条件成立」，而不是「睡一下再读」。
     */
    const waitRowCell = async (needle, index, expected) => {
      try {
        await page.waitForFunction(
          (text, column, want) => {
            const group = [...document.querySelectorAll('.wb-inv-group')].find((node) => (node.querySelector('.wb-inv-name')?.textContent || '').includes(text))
            if (!group) return false
            const cells = [...group.querySelector('.wb-inv-row').children].map((node) => node.textContent.trim())
            return cells[column] === want
          },
          { timeout: 10000 },
          needle,
          index,
          expected,
        )
        return true
      } catch {
        return false
      }
    }

    const waitRowCount = async (expected) => {
      try {
        await page.waitForFunction((want) => document.querySelectorAll('.wb-inv-group').length === want, { timeout: 10000 }, expected)
        return true
      } catch {
        return false
      }
    }

    const waitTotals = async (needle) => {
      try {
        await page.waitForFunction((text) => (document.querySelector('.wb-inv-totals')?.innerText || '').includes(text), { timeout: 10000 }, needle)
        return true
      } catch {
        return false
      }
    }

    /**
     * 关掉上一条回执。
     * 不关的话下一次「等页面出现『期初已建账』」会被上一条回执直接满足 —— 那等于没断言
     * （第一轮就是这么把一次 400 当成成功的）。
     */
    const dismissNotice = async () => {
      await page.evaluate(() => {
        const button = [...document.querySelectorAll('.wb-inv-notice button')].find((node) => node.textContent.trim() === '知道了')
        if (button) button.click()
      })
      await settle(200)
    }

    /** 清空后重输。三击全选在某些输入上不稳，改用 Ctrl+A。 */
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

    // ── 库存页第一次渲染 ──────────────────────────────────────
    await page.goto(`${devUrl}/inventory`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('.wb-inv-group', { timeout: 15000 })
    await settle()
    await shot('1440x1000-inventory-list')

    let table = await readTable()
    check(table.rows.length === 5, `库存页列出 5 个演示商品（实际 ${table.rows.length}）`)
    check(
      JSON.stringify(table.headers) === JSON.stringify(['型号', '管理', '分类 / 品牌', '可卖', '已订', '待处理', '默认售价', '成本']),
      `表头含分类/品牌、管理方式、售价与成本（实际 ${JSON.stringify(table.headers)}）`,
    )

    const findRow = (needle) => table.rows.find((row) => row.name.includes(needle))
    const gpuRow = findRow('RTX 4060 Ti')
    const mbRow = findRow('B760M-PLUS')
    const usedRow = findRow('RTX 3080')

    check(Boolean(gpuRow) && gpuRow.cells[1] === '按数量', '按数量管理的型号标注管理方式')
    check(Boolean(gpuRow) && gpuRow.cells[2] === '显卡影驰', `分类与品牌来自服务端关联（实际「${gpuRow?.cells[2]}」）`)
    check(Boolean(gpuRow) && gpuRow.cells[3] === '2' && gpuRow.cells[6] === '¥2,599.00', '可卖数量与默认售价正确')
    check(Boolean(gpuRow) && gpuRow.cells[7] === '¥5,720.00', `2 × 2860.00 的期初成本合计正确（实际「${gpuRow?.cells[7]}」）`)
    check(Boolean(mbRow) && mbRow.cells[7] === '成本未知', '未知成本显示为「成本未知」，不是 ¥0.00')
    check(Boolean(usedRow) && usedRow.cells[1] === '逐件管理', '逐件管理的型号标注管理方式')
    check(!(await text()).includes('¥0.00'), '页面不出现 ¥0.00（未知成本没有被估成 0）')

    check(table.totals.includes('自有在库 16 件'), `合计条的自有在库 = 16（实际 ${table.totals.split('\n').join(' / ')}）`)
    check(table.totals.includes('可卖 16') && table.totals.includes('已订 0') && table.totals.includes('待处理 0'), '合计条把三桶分开列')
    check(table.totals.includes('客户保管 1 件（他人财产，不计入在库）'), '客户保管件单独一列，明确不计入在库')
    check(table.foot.includes('没有成本权限的账号看不到成本列'), '页脚写明成本列由服务端决定')

    // ── 展开：另列区（在途 / 客户保管）────────────────────────
    check(await expandRow('RTX 4060 Ti'), '点型号行可以展开构成')
    const sideTitles = await page.evaluate(() => [...document.querySelectorAll('.wb-inv-side-title')].map((node) => node.textContent.trim()))
    const sideNotes = await page.evaluate(() => [...document.querySelectorAll('.wb-inv-side-note')].map((node) => node.textContent.trim()))
    check(JSON.stringify(sideTitles) === JSON.stringify(['在途', '客户保管']), `另列区只含在途与客户保管（实际 ${JSON.stringify(sideTitles)}）`)
    check(sideNotes.includes('不计入自有在库量') && sideNotes.includes('他人财产，不计入自有在库量'), '另列区各自写明不计入在库')
    await shot('1440x1000-inventory-expanded-gpu')

    // ── 展开：逐件实物与单件下钻 ──────────────────────────────
    check(await expandRow('RTX 3080'), '展开逐件管理的型号')
    const assetCodes = await page.evaluate(() => [...document.querySelectorAll('.wb-inv-item-code')].map((node) => node.textContent.trim()))
    check(assetCodes.includes('U-3080-001') && assetCodes.includes('U-3080-002'), `逐件实物各自一行（实际 ${JSON.stringify(assetCodes)}）`)

    const openedItem = await page.evaluate(() => {
      const button = [...document.querySelectorAll('.wb-inv-item--button')].find((node) => node.textContent.includes('U-3080-001'))
      if (!button) return false
      button.click()
      return true
    })
    check(openedItem, '点单件实物可以下钻')
    await page.waitForSelector('.wb-inv-item-detail', { timeout: 8000 })
    await settle()
    const itemDetail = await page.evaluate(() => document.querySelector('.wb-inv-item-detail').innerText)
    check(itemDetail.includes('期初建账 演示实盘 2026-09-19'), `单件来源指向期初建账凭据（实际「${itemDetail.split('\n')[0]}」）`)
    check(itemDetail.includes('流水：期初建账 +1'), '单件流水能追到发生源头')
    await shot('1440x1000-inventory-item-detail')

    // ── 搜索 ──────────────────────────────────────────────────
    await page.type('input[aria-label="搜索库存"]', 'NV2')
    await clickByText('button', '搜索')
    await page.waitForFunction(() => document.querySelectorAll('.wb-inv-group').length === 1, { timeout: 8000 })
    table = await readTable()
    check(table.rows[0].name.includes('NV2'), '搜索走服务端并收敛到 1 行')

    await openFresh()

    // ── 商品建档（真实写）────────────────────────────────────
    await dismissNotice()
    await clickByText('button', '新增商品')
    await page.waitForSelector('input[name="product-name"]', { timeout: 8000 })
    await page.type('input[name="product-name"]', '验收用 演示机箱')
    await page.type('input[name="product-sku"]', 'CASE-VERIFY')
    await page.type('input[name="product-category"]', '机箱')
    await page.type('input[name="product-brand"]', '先马')
    await page.type('input[name="product-sale"]', '199')
    await shot('1440x1000-inventory-product-form')
    await clickByText('button', '建立商品')
    await page.waitForFunction(() => (document.body.innerText || '').includes('已建立商品「验收用 演示机箱」'), { timeout: 8000 })
    check(true, '商品建档走真实接口并给出回执')

    check(await waitRowCount(6), '建档后列表变为 6 个商品')
    check(await waitRowCell('验收用 演示机箱', 2, '机箱先马'), '新商品的分类与品牌已链接进商品主数据（不是自由文本摆设）')
    check(await waitRowCell('验收用 演示机箱', 6, '¥199.00'), '整数分换算正确（199 元）')
    table = await readTable()
    check(Boolean(findRow('验收用 演示机箱')), '新商品出现在列表里')

    // ── 编辑商品：改售价并验证版本推进 ────────────────────────
    check(await expandRow('验收用 演示机箱'), '展开新建的商品行')
    await clickByText('button', '编辑商品')
    await page.waitForSelector('input[name="product-name"]', { timeout: 8000 })
    const prefilled = await page.evaluate(() => ({
      name: document.querySelector('input[name="product-name"]').value,
      sale: document.querySelector('input[name="product-sale"]').value,
      hint: [...document.querySelectorAll('.wb-form-hint')].map((n) => n.textContent).join(' '),
    }))
    check(prefilled.name === '验收用 演示机箱' && prefilled.sale === '199', '编辑表单带回当前值')
    check(prefilled.hint.includes('当前版本 1'), `编辑时显示当前版本，供 expectedVersion 使用（实际「${prefilled.hint.trim()}」）`)

    await clearAndType('input[name="product-sale"]', '249')
    await clickByText('button', '保存修改')
    await page.waitForFunction(() => (document.body.innerText || '').includes('已保存'), { timeout: 8000 })
    const priceAfterEdit = (await readTable()).rows.find((r) => r.name.includes('验收用 演示机箱'))?.cells[6]
    check(await waitRowCell('验收用 演示机箱', 6, '¥249.00'), `改售价后列表显示新价格（实际「${priceAfterEdit}」）`)

    check(await expandRow('验收用 演示机箱'), '再次展开改过的商品行')
    await clickByText('button', '编辑商品')
    await page.waitForSelector('input[name="product-name"]', { timeout: 8000 })
    const afterEdit = await page.evaluate(() => ({
      sale: document.querySelector('input[name="product-sale"]').value,
      hint: [...document.querySelectorAll('.wb-form-hint')].map((n) => n.textContent).join(' '),
    }))
    check(afterEdit.sale === '249', `改售价后服务端确已保存（实际「${afterEdit.sale}」）`)
    check(afterEdit.hint.includes('当前版本 2'), `版本推进到 2（实际「${afterEdit.hint.trim()}」）`)
    await clickByText('button', '关闭')

    // ── 期初录入①：数量件 + 成本留空 ──────────────────────────
    await dismissNotice()
    await clickByText('button', '录入期初库存')
    await page.waitForSelector('input[name="opening-ref"]', { timeout: 8000 })
    await page.type('input[name="opening-ref"]', '验收实盘 2026-09-19')
    const pickedQuantity = await selectByText('select[name="opening-product"]', '验收用 演示机箱')
    check(Boolean(pickedQuantity), '期初表单的型号下拉带出了刚建的商品')
    await clearAndType('input[name="opening-qty"]', '2')
    await shot('1440x1000-inventory-opening-form')
    await clickByText('button', '提交期初')
    await page.waitForFunction(() => (document.body.innerText || '').includes('期初已建账'), { timeout: 8000 })
    check(true, '期初录入走真实接口并给出回执')

    check(await waitRowCell('验收用 演示机箱', 3, '2'), '期初后该型号可卖 2')
    check(await waitRowCell('验收用 演示机箱', 7, '成本未知'), '留空的成本落成「成本未知」，没有被写成 ¥0.00')

    // ── 期初录入②：已有库存的型号必须被拒，且界面提前说清楚 ────
    await dismissNotice()
    await clickByText('button', '录入期初库存')
    await page.waitForSelector('input[name="opening-ref"]', { timeout: 8000 })
    await page.type('input[name="opening-ref"]', '验收实盘 2026-09-19 重复期初')
    await selectByText('select[name="opening-product"]', 'RTX 3080')
    const inlineWarn = await page.evaluate(() => (document.querySelector('.wb-opening-warn')?.textContent || ''))
    check(inlineWarn.includes('已经有库存事实'), `已有库存的型号在表单里就写明会被拒绝（实际「${inlineWarn.slice(0, 40)}…」）`)
    await page.type('input[name="opening-asset-code"]', 'U-3080-003')
    await clickByText('button', '提交期初')
    const rejected = await page.evaluate(() => (document.querySelector('.wb-form-error')?.textContent || ''))
    check(rejected.includes('期初没有通过校验') && rejected.includes('期初只能建一次'), `期初不是日常入库的捷径：服务端拒绝并说明原因（实际「${rejected.slice(0, 60)}…」）`)
    await shot('1440x1000-inventory-opening-rejected')
    check((await readTable()).rows.find((r) => r.name.includes('RTX 3080'))?.cells[3] === '2', '被拒的期初没有落库（可卖仍是 2）')

    // ── 期初录入③：新建逐件商品再入期初，先补编号校验 ──────────
    await clickByText('button', '关闭')
    await clickByText('button', '新增商品')
    await page.waitForSelector('input[name="product-name"]', { timeout: 8000 })
    await page.type('input[name="product-name"]', '验收用 二手整机')
    await page.type('input[name="product-sku"]', 'NB-VERIFY')
    await page.type('input[name="product-category"]', '笔记本')
    await page.type('input[name="product-brand"]', '联想')
    await page.type('input[name="product-sale"]', '2999')
    await selectByText('select[name="product-tracking"]', '逐件管理')
    await clickByText('button', '建立商品')
    await page.waitForFunction(() => (document.body.innerText || '').includes('已建立商品「验收用 二手整机」'), { timeout: 8000 })
    await waitRowCell('验收用 二手整机', 1, '逐件管理')

    await dismissNotice()
    await clickByText('button', '录入期初库存')
    await page.waitForSelector('input[name="opening-ref"]', { timeout: 8000 })
    await page.type('input[name="opening-ref"]', '验收实盘 2026-09-19 二手整机')
    await selectByText('select[name="opening-product"]', '验收用 二手整机')
    await clickByText('button', '提交期初')
    const missingCode = await page.evaluate(() => (document.querySelector('.wb-form-error')?.textContent || ''))
    check(missingCode.includes('逐件商品必须填写内部编号'), `逐件件缺编号当场被拦下（实际「${missingCode}」）`)

    await page.type('input[name="opening-asset-code"]', 'U-NB-VERIFY-1')
    await page.type('input[name="opening-cost"]', '1800')
    await clickByText('button', '提交期初')
    await page.waitForFunction(() => (document.body.innerText || '').includes('期初已建账'), { timeout: 8000 })
    check(true, '补齐编号与成本后提交成功')

    check(await waitRowCell('验收用 二手整机', 3, '1'), '逐件件期初后该型号可卖 1')
    check(await waitRowCell('验收用 二手整机', 7, '¥1,800.00'), '逐件件的单件成本按整数分落库')
    check(await waitTotals('自有在库 19 件'), '合计随之更新为 19（16 + 期初 2 + 期初 1）')

    check(await expandRow('验收用 二手整机'), '再次展开逐件件型号')
    const codesAfter = await page.evaluate(() => [...document.querySelectorAll('.wb-inv-item-code')].map((node) => node.textContent.trim()))
    check(codesAfter.includes('U-NB-VERIFY-1'), '新期初的实物出现在逐件列表里')

    // ── 多视口：不横向溢出 ────────────────────────────────────
    for (const [width, height] of [[1920, 1080], [1440, 1000], [1366, 768], [1280, 800], [1024, 768], [390, 844]]) {
      await page.setViewport({ width, height })
      await openFresh()
      const key = `${width}x${height}`
      report.measured[key] = await page.evaluate(() => ({
        documentScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        tableWidth: Math.round(document.querySelector('.wb-inv-table').getBoundingClientRect().width),
        headerCellsVisible: [...document.querySelectorAll('.wb-inv-head span')].filter((node) => node.getBoundingClientRect().width > 0).length,
        rowHeight: Math.round(document.querySelector('.wb-inv-row').getBoundingClientRect().height),
        totalsWidth: Math.round(document.querySelector('.wb-inv-totals').getBoundingClientRect().width),
      }))
      const m = report.measured[key]
      check(m.documentScrollWidth <= m.innerWidth, `${key}：页面无横向溢出`)
      check(m.totalsWidth <= m.innerWidth, `${key}：合计条没有被顶出视口`)
      check(m.headerCellsVisible >= 6, `${key}：表头至少保留 6 列可见（实际 ${m.headerCellsVisible}）`)
      await shot(`${key}-inventory-list`)
    }

    // ── 硬边界：全程不碰生产 ──────────────────────────────────
    report.requestHosts = [...new Set(allRequests.map((url) => { try { return new URL(url).host } catch { return url } }))]
    check(!allRequests.some((url) => url.includes('huangqidong.cn')), '全程没有任何请求发往生产域名 huangqidong.cn')
    const unexpectedApiFailures = report.apiFailures.filter((failure) => !failure.body.includes('期初没有通过校验'))
    check(
      unexpectedApiFailures.length === 0,
      `接口 4xx/5xx 只出现在刻意构造的「重复期初」场景（实际 ${unexpectedApiFailures.length} 条意外：${unexpectedApiFailures.map((f) => `${f.status} ${f.url}`).join('; ')}）`,
    )
    check(report.errors.length === 0, `无页面 JS 错误（实际 ${report.errors.length}）`)
    // 只有刻意构造的期初 400 允许出现在控制台；favicon 已有 public/favicon.svg，不该再有 404。
    const unexpectedConsoleErrors = report.consoleErrors.filter(
      (message) => !message.includes('/api/v2/inventory/openings'),
    )
    check(
      unexpectedConsoleErrors.length === 0,
      `控制台只有刻意构造的期初 400，没有其它错误（实际 ${unexpectedConsoleErrors.length} 条：${unexpectedConsoleErrors.slice(0, 3).join(' | ')}）`,
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
