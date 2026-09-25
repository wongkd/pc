/**
 * E09 · 取消 / 退货 / 退款 / 欠款交付 / 账本 端到端验收（本地隔离环境，不接触生产）。
 *
 * 与 E06/E07/E08 验收脚本同一套路：后端起 backend/scripts/dev-server.mjs
 * （miniflare + 真实 Worker 入口 + 内存 D1 + 演示数据），走真实登录与真实 HTTP。
 *
 * 覆盖的业务链路（对应前端最小入口）：
 *   1. B11 取消：释放占用、余额转门店待退、库存回到可用桶；
 *   2. B09 欠款批准 → B10 挂凭证交付：financial_disposition = credit_approved；
 *   3. B17 登记退货（pending）→ R04 详情带 returns 列表 → B43 批准 → B18 退款归零；
 *   4. R12 账本 overview / entries；
 *   5. B34 反冲收款：反向分录 + 防重复反冲。
 *
 * 断言是软断言：失败记进 report.failed 但不中断，一次运行拿到完整报告。
 *
 * 用法：node docs/verification/E09-current/verify-e09.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../../..')
const BACKEND_PORT = 8819
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

    const inventory = async () => (await call('/api/v2/inventory')).body.data
    const ram0 = (await inventory()).items.find((row) => row.sku === 'RAM-DDR5-16G')
    check('演示库存里有「金百达 DDR5 16GB」', Boolean(ram0), JSON.stringify((await inventory()).items?.map((row) => row.sku)))
    const ramAvailable0 = ram0 ? ram0.availableQty : 0

    // ─────────────────────────── 链路 1：B11 取消 ───────────────────────────
    const cancelOrder = await call('/api/v2/sales/orders', {
      requestId: 'e09-verify-cancel-order',
      kind: 'retail',
      customerSnapshot: { name: '张取消', phone: '13800000001' },
      lines: [{ source: 'new', nameSnapshot: '金百达 DDR5 16GB 6000', qty: 1, unitPriceCents: 27_900, productRef: ram0?.id }],
    })
    const cancelOrderId = cancelOrder.body.data?.entityId
    check('B04：取消链路建单成功', cancelOrder.status === 200 && Boolean(cancelOrderId))

    await call(`/api/v2/sales/orders/${cancelOrderId}/payments`, {
      requestId: 'e09-verify-cancel-pay', amountCents: 10_000, method: 'wechat', verificationState: 'verified',
    })
    await call(`/api/v2/sales/orders/${cancelOrderId}/confirm`, { requestId: 'e09-verify-cancel-confirm' })
    const ramAfterConfirm = (await inventory()).items.find((row) => row.sku === 'RAM-DDR5-16G')
    check('B05：确认成交占用 1 件 RAM', ramAfterConfirm.reservedQty === 1, `预留 ${ramAfterConfirm.reservedQty}`)

    const cancelled = await call(`/api/v2/sales/orders/${cancelOrderId}/cancel`, {
      requestId: 'e09-verify-cancel', reason: '客户改主意',
    })
    check('B11：取消成功，状态 cancelled', cancelled.status === 200 && cancelled.body.data.state === 'cancelled')

    const cancelDetail = await call(`/api/v2/sales/orders/${cancelOrderId}`)
    check('B11：取消后余额转门店待退（store_due）', cancelDetail.body.data?.order?.balanceDirection === 'store_due',
      JSON.stringify(cancelDetail.body.data?.order))
    const ramAfterCancel = (await inventory()).items.find((row) => row.sku === 'RAM-DDR5-16G')
    check('B11：取消释放占用、库存回可用桶', ramAfterCancel.reservedQty === 0 && ramAfterCancel.availableQty === ramAvailable0,
      `可用 ${ramAfterCancel.availableQty} / 预留 ${ramAfterCancel.reservedQty}`)

    // ─────────────────────────── 链路 2：B09 欠款批准 → 挂凭证交付 ───────────────────────────
    const creditOrder = await call('/api/v2/sales/orders', {
      requestId: 'e09-verify-credit-order',
      kind: 'retail',
      customerSnapshot: { name: '李欠款', phone: '13800000002' },
      lines: [{ source: 'new', nameSnapshot: '金百达 DDR5 16GB 6000', qty: 1, unitPriceCents: 27_900, productRef: ram0?.id }],
    })
    const creditOrderId = creditOrder.body.data?.entityId
    await call(`/api/v2/sales/orders/${creditOrderId}/payments`, {
      requestId: 'e09-verify-credit-pay', amountCents: 10_000, method: 'wechat', verificationState: 'verified',
    })
    await call(`/api/v2/sales/orders/${creditOrderId}/confirm`, { requestId: 'e09-verify-credit-confirm' })

    const approval = await call(`/api/v2/sales/orders/${creditOrderId}/credit-approval`, {
      requestId: 'e09-verify-credit-approval', dueDate: '2099-01-01', reason: '客户月底结清',
    })
    const creditApprovalId = approval.body.data?.effects?.creditApprovalId
    check('B09：欠款批准返回 creditApprovalId', approval.status === 200 && Boolean(creditApprovalId), JSON.stringify(approval.body))

    await call(`/api/v2/sales/orders/${creditOrderId}/checks`, {
      requestId: 'e09-verify-credit-checks', templateVersion: 'asm-v1', configurationVersion: 0,
      items: [{ key: 'appearance', label: '外观与配件齐全', kind: 'check', state: 'pass' }],
    })
    const creditDeliver = await call(`/api/v2/sales/orders/${creditOrderId}/deliver`, {
      requestId: 'e09-verify-credit-deliver', configurationVersion: 0,
      deliveryNote: '客户月底结清', creditApprovalRef: creditApprovalId,
    })
    check('B09→B10：挂欠款凭证交付成功', creditDeliver.status === 200 && creditDeliver.body.data.state === 'delivered',
      JSON.stringify(creditDeliver.body))
    const creditDetail = await call(`/api/v2/sales/orders/${creditOrderId}`)
    check('B10：交付 financial_disposition = credit_approved',
      creditDetail.body.data?.fulfillment?.delivery?.financialDisposition === 'credit_approved',
      JSON.stringify(creditDetail.body.data?.fulfillment?.delivery))

    // ─────────────────────────── 链路 3：B17 退货 → B43 批准 → B18 退款 ───────────────────────────
    const returnOrder = await call('/api/v2/sales/orders', {
      requestId: 'e09-verify-return-order',
      kind: 'retail',
      customerSnapshot: { name: '王退货', phone: '13800000003' },
      lines: [{ source: 'new', nameSnapshot: '金百达 DDR5 16GB 6000', qty: 1, unitPriceCents: 27_900, productRef: ram0?.id }],
    })
    const returnOrderId = returnOrder.body.data?.entityId
    await call(`/api/v2/sales/orders/${returnOrderId}/payments`, {
      requestId: 'e09-verify-return-pay', amountCents: 27_900, method: 'wechat', verificationState: 'verified',
    })
    await call(`/api/v2/sales/orders/${returnOrderId}/confirm`, { requestId: 'e09-verify-return-confirm' })
    await call(`/api/v2/sales/orders/${returnOrderId}/checks`, {
      requestId: 'e09-verify-return-checks', templateVersion: 'asm-v1', configurationVersion: 0,
      items: [{ key: 'appearance', label: '外观与配件齐全', kind: 'check', state: 'pass' }],
    })
    await call(`/api/v2/sales/orders/${returnOrderId}/deliver`, {
      requestId: 'e09-verify-return-deliver', configurationVersion: 0, deliveryNote: '本人自提',
    })

    const registered = await call('/api/v2/sales/returns', {
      requestId: 'e09-verify-return',
      originalOrderId: returnOrderId,
      lineAllocations: [{ position: 0, qty: 1 }],
      stockItemIds: [],
      reason: '客户不满意',
      acceptedQty: 1,
      creditCents: 27_900,
    })
    const returnId = registered.body.data?.effects?.returnId
    check('B17：登记退货成功，creditState = pending', registered.status === 200 && registered.body.data?.effects?.creditState === 'pending',
      JSON.stringify(registered.body))

    const returnDetail = await call(`/api/v2/sales/orders/${returnOrderId}`)
    check('R04：详情带 returns 列表（E09 前端最小入口依赖）', Array.isArray(returnDetail.body.data?.returns) && returnDetail.body.data.returns.length >= 1,
      JSON.stringify(returnDetail.body.data?.returns))
    check('R04：详情带 order.returnCreditCents 字段', typeof returnDetail.body.data?.order?.returnCreditCents === 'number',
      JSON.stringify(returnDetail.body.data?.order?.returnCreditCents))
    check('B17：pending 未计入应退（returnCreditCents = 0）', returnDetail.body.data?.order?.returnCreditCents === 0,
      `returnCreditCents=${returnDetail.body.data?.order?.returnCreditCents}`)

    const approved = await call(`/api/v2/sales/returns/${returnId}/approve-credit`, {
      requestId: 'e09-verify-return-approve', reason: null,
    })
    check('B43：批准贷项 → approved', approved.status === 200 && approved.body.data?.effects?.creditState === 'approved',
      JSON.stringify(approved.body))

    const approvedDetail = await call(`/api/v2/sales/orders/${returnOrderId}`)
    check('B43：批准后 returnCreditCents = 27900', approvedDetail.body.data?.order?.returnCreditCents === 27_900,
      `returnCreditCents=${approvedDetail.body.data?.order?.returnCreditCents}`)

    const refunded = await call(`/api/v2/sales/orders/${returnOrderId}/refunds`, {
      requestId: 'e09-verify-return-refund', amountCents: 27_900, method: 'wechat', returnRef: returnId, reason: '退全款',
    })
    check('B18：退款成功，余额归零', refunded.status === 200 && refunded.body.data?.effects?.balanceCents === 0,
      JSON.stringify(refunded.body))

    const refundDetail = await call(`/api/v2/sales/orders/${returnOrderId}`)
    check('B18：退款后 cash_net 归零、余额归零',
      refundDetail.body.data?.order?.cashNetCents === 0 && refundDetail.body.data?.order?.balanceCents === 0,
      JSON.stringify(refundDetail.body.data?.order))

    // ─────────────────────────── 链路 4：R12 账本读 + B34 反冲 ───────────────────────────
    const overview = await call('/api/v2/finance/overview')
    check('R12：账本汇总返回 cash / receivable / payable',
      overview.status === 200 && typeof overview.body.data?.cash?.netCents === 'number'
        && typeof overview.body.data?.receivable?.totalCents === 'number'
        && typeof overview.body.data?.payable?.totalCents === 'number',
      JSON.stringify(overview.body.data))

    const entriesIn = await call('/api/v2/finance/entries?direction=in')
    check('R12：资金流水按 in 过滤', entriesIn.status === 200 && Array.isArray(entriesIn.body.data?.entries)
      && entriesIn.body.data.entries.every((row) => row.direction === 'in'),
      JSON.stringify(entriesIn.body.data?.entries?.map((row) => row.direction)))

    // 反冲链路 2 的收款分录（entry id = `${requestId}::cash`）
    const reverseEntryId = 'e09-verify-credit-pay::cash'
    const reversed = await call(`/api/v2/finance/entries/${encodeURIComponent(reverseEntryId)}/reverse`, {
      requestId: 'e09-verify-reverse', reason: '录错了，不是这单的收款',
    })
    check('B34：反冲收款成功，返回反向分录', reversed.status === 200 && reversed.body.data?.effects?.reversedEntryId === reverseEntryId,
      JSON.stringify(reversed.body))

    const dupReverse = await call(`/api/v2/finance/entries/${encodeURIComponent(reverseEntryId)}/reverse`, {
      requestId: 'e09-verify-reverse-dup', reason: '再冲一次',
    }, false)
    check('B34：同一原笔不能重复反冲（400）', dupReverse.status === 400, `${dupReverse.status} ${JSON.stringify(dupReverse.body?.error)}`)
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
