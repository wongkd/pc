/**
 * E08 · 装机、检测与交付端到端验收（本地隔离环境，不接触生产）。
 *
 * 与 E06/E07 验收脚本同一套路：后端起 backend/scripts/dev-server.mjs
 * （miniflare + 真实 Worker 入口 + 内存 D1 + 演示数据），走真实登录与真实 HTTP。
 *
 * ⚠️ 与 E06/E07 的差别：本卡的网页端入口（路由）还没接进 App.tsx（公共接线文件本轮禁改，
 * 见 INTEGRATION.md），所以本脚本**没有浏览器步骤**，只驱动 HTTP 全链路 ——
 * 每个动作都是完整的「HTTP + 契约信封 + 鉴权 + 权限 + SQL + 幂等执行器」。
 * 页面级验收待总集成把路由接上后补跑（见 README 的未验证清单）。
 *
 * 覆盖的业务链路：
 *   1. B04 零售建单（数量件 + 服务费）：建单不写库存；
 *   2. B08 收款 → B05 确认成交（占用成立）→ B07 零售核对 → B10 交付扣库；
 *   3. 交付幂等：同一 requestId 重放不扣第二次；
 *   4. 装机链路：B06 备料 → 提交检测 → B07 不通过（占用释放、库存回到可用桶）→
 *      重新备料检测通过 → B10 交付；
 *   5. 演示数据全部来自 dev:local 的真实播种（B12 / B13），不另造数据。
 *
 * 断言是软断言：失败记进 report.failed 但不中断，一次运行拿到完整报告。
 *
 * 用法：node docs/verification/E08-current/verify-e08.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../../..')
const BACKEND_PORT = 8818
const OUT = __dirname

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

const report = { passed: [], failed: [], at: new Date().toISOString() }
function check(name, condition, detail = '') {
  if (condition) report.passed.push(name)
  else report.failed.push({ name, detail })
  console.log(`${condition ? '✓' : '✗'} ${name}${condition ? '' : ` —— ${detail}`}`)
}

async function main() {
  const backend = startProcess(process.execPath, [path.join(ROOT, 'backend/scripts/dev-server.mjs')], {
    cwd: path.join(ROOT, 'backend'),
    env: { ...process.env, PORT: String(BACKEND_PORT) },
  })
  const base = `http://127.0.0.1:${BACKEND_PORT}`
  try {
    await waitForHttp(`${base}/api/customers`)

    // ── 登录（真实登录路由） ──
    const loginResponse = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })
    const loginBody = await loginResponse.json()
    check('登录 owner@local.test（本地隔离环境）', loginResponse.ok && Boolean(loginBody.token))
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${loginBody.token}` }

    const call = async (path, body, expectOk = true) => {
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: auth,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const json = await response.json()
      if (expectOk && !response.ok) {
        check(`请求成功 ${path}`, false, `${response.status} ${JSON.stringify(json).slice(0, 200)}`)
      }
      return { status: response.status, body: json }
    }

    const inventory = async () => {
      const result = await call('/api/v2/inventory')
      return result.body.data
    }

    // ── 演示数据：dev:local 已通过 B12 / B13 播种 ──
    const stock0 = await inventory()
    // 读模型口径：items = 型号汇总（id 为商品 entityId）；lotItems = 逐件实物（id 为实物 ID）。
    const ram = stock0.items.find((row) => row.sku === 'RAM-DDR5-16G')
    const usedItem = (stock0.lotItems ?? []).find((row) => row.assetCode === 'U-3080-001')
    check('演示库存里有「金百达 DDR5 16GB」（B12/B13 播种）', Boolean(ram), JSON.stringify(stock0.items?.map((row) => row.sku)))
    const ramAvailable0 = ram ? ram.availableQty : 0

    // ── 链路 1：零售（数量件 + 服务费） ──
    const retail = await call('/api/v2/sales/orders', {
      requestId: 'e08-verify-retail',
      kind: 'retail',
      customerSnapshot: { name: '黄小满', phone: '13800005678' },
      lines: [
        { source: 'new', nameSnapshot: '金百达 DDR5 16GB 6000', qty: 2, unitPriceCents: 27_900, productRef: ram?.id },
        { source: 'service', nameSnapshot: '装机服务费', qty: 1, unitPriceCents: 20_000 },
      ],
      discountCents: 0,
    })
    check('B04：零售单建成草稿', retail.status === 200 && retail.body.data.state === 'draft')
    const retailOrderId = retail.body.data?.entityId
    check('B04：建单不写库存（可用量不变）', (await inventory()).items.find((row) => row.sku === 'RAM-DDR5-16G').availableQty === ramAvailable0)

    const pay = await call(`/api/v2/sales/orders/${retailOrderId}/payments`, {
      requestId: 'e08-verify-pay', amountCents: 75_800, method: 'wechat', verificationState: 'verified',
    })
    check('B08：登记零售全款', pay.status === 200)

    const confirm = await call(`/api/v2/sales/orders/${retailOrderId}/confirm`, { requestId: 'e08-verify-confirm' })
    check('B05：确认成交并占用', confirm.status === 200 && confirm.body.data.state === 'confirmed')
    const ramAfterConfirm = (await inventory()).items.find((row) => row.sku === 'RAM-DDR5-16G')
    check('B05：数量件按量占用（可用 −2、预留 +2）', ramAfterConfirm.availableQty === ramAvailable0 - 2 && ramAfterConfirm.reservedQty === 2,
      `可用 ${ramAfterConfirm.availableQty} / 预留 ${ramAfterConfirm.reservedQty}`)

    const retailChecks = await call(`/api/v2/sales/orders/${retailOrderId}/checks`, {
      requestId: 'e08-verify-retail-checks',
      templateVersion: 'asm-v1',
      configurationVersion: 0,
      items: [
        { key: 'appearance', label: '外观与配件齐全', kind: 'check', state: 'pass' },
        { key: 'sn', label: 'SN / 编号核对', kind: 'check', state: 'pass' },
      ],
    })
    check('B07：零售核对一次通过，直达待交付', retailChecks.status === 200 && retailChecks.body.data.effects.toState === 'ready_delivery')

    const deliver = await call(`/api/v2/sales/orders/${retailOrderId}/deliver`, {
      requestId: 'e08-verify-deliver',
      configurationVersion: 0,
      deliveryNote: '本人到店自提，当场开机验机',
    })
    check('B10：交付成立', deliver.status === 200 && deliver.body.data.state === 'delivered')
    const ramAfterDeliver = (await inventory()).items.find((row) => row.sku === 'RAM-DDR5-16G')
    check('B10：交付才扣库（预留归零，可用少 2）', ramAfterDeliver.reservedQty === 0 && ramAfterDeliver.availableQty === ramAvailable0 - 2,
      `可用 ${ramAfterDeliver.availableQty} / 预留 ${ramAfterDeliver.reservedQty}`)
    const retailDetail = await call(`/api/v2/sales/orders/${retailOrderId}`)
    check('R04：详情带交付记录（看板）', Boolean(retailDetail.body.data?.fulfillment?.delivery))
    const deliveredCost = deliver.body.data?.effects?.costSnapshot?.find((row) => row.source === 'new')
    check('B10：成本快照如实记录 —— 数量件无逐件成本，标 costKnown=false 不填 0',
      deliveredCost ? deliveredCost.costKnown === false && deliveredCost.costCents === null : false,
      JSON.stringify(deliveredCost))

    const deliverAgain = await call(`/api/v2/sales/orders/${retailOrderId}/deliver`, {
      requestId: 'e08-verify-deliver',
      configurationVersion: 0,
      deliveryNote: '本人到店自提，当场开机验机',
    })
    check('B10：同一 requestId 重放复用结果，不扣第二次', deliverAgain.status === 200 && deliverAgain.body.data.operationId === deliver.body.data.operationId)

    // ── 链路 2：装机（含检测不通过回退） ──
    const assembly = await call('/api/v2/sales/orders', {
      requestId: 'e08-verify-assembly',
      kind: 'assembly',
      customerSnapshot: { name: '林建国', phone: '13800001234' },
      lines: [
        { source: 'new', nameSnapshot: '影驰 RTX 4060 Ti 金属大师', qty: 1, unitPriceCents: 259_900, productRef: stock0.items.find((row) => row.sku === 'GPU-4060TI-METAL')?.id },
        { source: 'service', nameSnapshot: '装机服务费', qty: 1, unitPriceCents: 20_000 },
      ],
    })
    check('B04：装机单（直接建单）建成草稿', assembly.status === 200)
    const assemblyOrderId = assembly.body.data?.entityId
    await call(`/api/v2/sales/orders/${assemblyOrderId}/payments`, {
      requestId: 'e08-verify-assembly-pay', amountCents: 279_900, method: 'bank', verificationState: 'verified',
    })
    const assemblyConfirm = await call(`/api/v2/sales/orders/${assemblyOrderId}/confirm`, { requestId: 'e08-verify-assembly-confirm' })
    check('B05：装机单确认成交', assemblyConfirm.status === 200)

    const gpuBefore = (await inventory()).items.find((row) => row.sku === 'GPU-4060TI-METAL')
    const step1 = await call(`/api/v2/sales/orders/${assemblyOrderId}/start-assembly`, { requestId: 'e08-verify-assembly-a1', location: 'store' })
    check('B06：开始备料 → preparing', step1.status === 200 && step1.body.data.effects.toState === 'preparing')
    const step2 = await call(`/api/v2/sales/orders/${assemblyOrderId}/start-assembly`, { requestId: 'e08-verify-assembly-a2', location: 'store' })
    check('B06：备料完成 → testing', step2.status === 200 && step2.body.data.effects.toState === 'testing')
    check('B06：备料不改变库存数量', JSON.stringify((await inventory()).items.find((row) => row.sku === 'GPU-4060TI-METAL')) === JSON.stringify(gpuBefore))

    const failed = await call(`/api/v2/sales/orders/${assemblyOrderId}/checks`, {
      requestId: 'e08-verify-assembly-checks-fail',
      templateVersion: 'asm-v1',
      configurationVersion: 0,
      items: [
        { key: 'appearance', label: '外观无划痕', kind: 'check', state: 'pass' },
        { key: 'boot', label: '点亮', kind: 'test', state: 'fail', note: '点不亮，内存槽疑似故障' },
      ],
    })
    check('B07：检测不按「通过」算，回待备料', failed.status === 200 && failed.body.data.effects.toState === 'waiting_stock')
    const gpuAfterFail = (await inventory()).items.find((row) => row.sku === 'GPU-4060TI-METAL')
    check('B07：不通过时占用释放、库存回到可用桶（不漏库存）',
      gpuAfterFail.reservedQty === 0 && gpuAfterFail.availableQty === gpuBefore.availableQty + 1,
      `可用 ${gpuAfterFail.availableQty} / 预留 ${gpuAfterFail.reservedQty}`)

    // 释放后要重新占用（走 B05 补分配，重新锁住数量件），才能再次备料 —— 这是正确的流程，
    // 不是重复收款：钱已经收过，只是把「已经释放的那一件」重新锁回来。
    await call(`/api/v2/sales/orders/${assemblyOrderId}/allocate`, { requestId: 'e08-verify-assembly-realloc' })
    await call(`/api/v2/sales/orders/${assemblyOrderId}/start-assembly`, { requestId: 'e08-verify-assembly-a3', location: 'store' })
    await call(`/api/v2/sales/orders/${assemblyOrderId}/start-assembly`, { requestId: 'e08-verify-assembly-a4', location: 'store' })
    const passed = await call(`/api/v2/sales/orders/${assemblyOrderId}/checks`, {
      requestId: 'e08-verify-assembly-checks-pass',
      templateVersion: 'asm-v1',
      configurationVersion: 0,
      items: [
        { key: 'appearance', label: '外观无划痕', kind: 'check', state: 'pass' },
        { key: 'boot', label: '点亮', kind: 'test', state: 'pass' },
        { key: 'burn', label: '烤机 30 分钟', kind: 'test', state: 'pass' },
      ],
    })
    check('B07：重新检测通过 → 待交付', passed.status === 200 && passed.body.data.effects.toState === 'ready_delivery')

    const finalDeliver = await call(`/api/v2/sales/orders/${assemblyOrderId}/deliver`, {
      requestId: 'e08-verify-assembly-deliver',
      configurationVersion: 0,
      deliveryNote: '客户到店验收，试机 10 分钟',
      receivedByNote: '本人签收',
    })
    check('B10：装机单交付成立', finalDeliver.status === 200 && finalDeliver.body.data.state === 'delivered')
    const gpuFinal = (await inventory()).items.find((row) => row.sku === 'GPU-4060TI-METAL')
    check('B10：逐件扣库一次（预留归零）', gpuFinal.reservedQty === 0, `预留 ${gpuFinal.reservedQty}`)

    if (usedItem) {
      check('客供/二手实物不受零售链路影响（另一件二手仍在库）',
        ((await inventory()).lotItems ?? []).find((row) => row.assetCode === 'U-3080-001')?.availability === 'available')
    }

    // ── 尾款闸门：未结清不能交付 ──
    const partial = await call('/api/v2/sales/orders', {
      requestId: 'e08-verify-partial',
      kind: 'retail',
      customerSnapshot: { name: '吴女士' },
      lines: [{ source: 'new', nameSnapshot: '金百达 DDR5 16GB 6000', qty: 1, unitPriceCents: 27_900, productRef: ram?.id }],
    })
    const partialOrderId = partial.body.data?.entityId
    await call(`/api/v2/sales/orders/${partialOrderId}/payments`, {
      requestId: 'e08-verify-partial-pay', amountCents: 10_000, method: 'cash', verificationState: 'verified',
    })
    await call(`/api/v2/sales/orders/${partialOrderId}/confirm`, { requestId: 'e08-verify-partial-confirm' })
    await call(`/api/v2/sales/orders/${partialOrderId}/checks`, {
      requestId: 'e08-verify-partial-checks', templateVersion: 'asm-v1', configurationVersion: 0,
      items: [{ key: 'appearance', label: '外观与配件齐全', kind: 'check', state: 'pass' }],
    })
    const denied = await call(`/api/v2/sales/orders/${partialOrderId}/deliver`, {
      requestId: 'e08-verify-partial-deliver', configurationVersion: 0, deliveryNote: '想先拿走',
    }, false)
    check('B10：尾款没结清时交付被服务端拒绝', denied.status === 400, `${denied.status} ${JSON.stringify(denied.body.error)}`)
  } finally {
    backend.child.kill()
    fs.writeFileSync(path.join(OUT, 'verify-report.json'), JSON.stringify(report, null, 2))
    fs.writeFileSync(path.join(OUT, 'logs', 'dev-server.log'), backend.logs.join(''))
  }

  console.log(`\n通过 ${report.passed.length} / 失败 ${report.failed.length}`)
  if (report.failed.length > 0) process.exitCode = 1
}

fs.mkdirSync(path.join(OUT, 'logs'), { recursive: true })
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
