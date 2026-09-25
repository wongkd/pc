/**
 * F3 · 采购取消（B37）与采购付款（B33）端到端验收（本地隔离环境，不接触生产）。
 *
 * 与 E07 / E12 / F2 验收同一套路：后端起 backend/scripts/dev-server.mjs
 * （miniflare + 真实 Worker 入口 + 内存 D1 + 演示数据），走真实登录与真实 HTTP。
 *
 * 链路（全部走真实接口，不写任何测试后门）：
 *   A 段 · 取消采购：B12 建商品 → B14 建采购 → R08 读应付 → B37 取消未到数量
 *          → B15 到货 → 再取消（超量拒绝）→ B33 付款后取消（付款冲突）
 *   B 段 · 采购付款：R12 读应付/已付/剩余 → B33 部分付款 → 幂等与改载荷
 *          → 超付拒绝 → 付清 → 账本流水可按采购单追溯 → 成本未知不得付款
 *
 * 对应验收重点：
 *   1. 取消只减在途，不改写订购量；采购恒等式 ordered = received + rejected + cancelled + pending；
 *   2. 已到货 / 拒收数量不能再取消（422 PURCHASE_CANCEL_EXCEEDED）；
 *   3. 取消收缩 B33 的应付基数，不能为已取消数量付款；
 *   4. 已有净付款时取消被拒（409 PURCHASE_PAYMENT_CONFLICT），且不落台账；
 *   5. 采购付款可部分、可幂等、可追溯（账本流水挂得住采购单），超付 422。
 *
 * 断言是软断言：失败记进 report.failed 但不中断，一次运行拿到完整报告。
 *
 * 用法：node docs/verification/2026-09-22-F3-purchase-cancel-payment/verify-f3.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../../..')
const BACKEND_PORT = 8830
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

const report = { scope: '本地隔离环境（真实 Worker + 内存 D1 + 真实 HTTP）；不是生产', passed: [], failed: [], at: new Date().toISOString() }
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
  let authHeader = {}
  try {
    await waitForHttp(`${base}/api/customers`)

    const loginResponse = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })
    const loginBody = await loginResponse.json()
    check('登录 owner@local.test（本地隔离环境）', loginResponse.ok && Boolean(loginBody.token))
    authHeader = { 'Content-Type': 'application/json', Authorization: `Bearer ${loginBody.token}` }

    const call = async (apiPath, body, method) => {
      const verb = method ?? (body === undefined ? 'GET' : 'POST')
      const response = await fetch(`${base}${apiPath}`, {
        method: verb,
        headers: authHeader,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let json = null
      try {
        json = await response.json()
      } catch {
        json = null
      }
      return { status: response.status, body: json }
    }
    const reqId = (tag) => `f3v-${tag}-${crypto.randomUUID()}`

    /** B12 建一个数量件商品，返回 entityId。 */
    const makeProduct = async (tag) => {
      const product = await call('/api/v2/inventory/products', {
        requestId: reqId(`product-${tag}`),
        name: `F3 验收件 ${tag}`,
        sku: `F3V-${tag}-${Date.now()}`,
        category: '配件',
        trackingMode: 'quantity',
        requiresSn: false,
        defaultSalePriceCents: 19900,
      })
      check(`B12 建商品（${tag}）`, product.status === 200, `${product.status} ${JSON.stringify(product.body).slice(0, 200)}`)
      return product.body?.data?.entityId ?? null
    }

    /** B14 建采购单，返回 { purchaseId, lineId, detail }。unitCostCents 传 undefined 表示成本未知。 */
    const makePurchase = async (tag, productRef, qtyOrdered, unitCostCents) => {
      const body = {
        requestId: reqId(`po-${tag}`),
        supplierName: 'F3 验收供应商',
        lines: [{ productRef, nameSnapshot: `F3 验收采购件 ${tag}`, qtyOrdered }],
      }
      if (unitCostCents !== undefined) body.lines[0].unitCostCents = unitCostCents
      const created = await call('/api/v2/inventory/purchases', body)
      check(`B14 建采购单（${tag}）`, created.status === 200, `${created.status} ${JSON.stringify(created.body).slice(0, 220)}`)
      const purchaseId = created.body?.data?.entityId ?? null
      const detail = await readPurchase(purchaseId)
      return { purchaseId, lineId: detail?.lines?.[0]?.id ?? null, detail }
    }

    const readPurchase = async (purchaseId) => {
      const response = await call(`/api/v2/inventory/purchases/${encodeURIComponent(purchaseId)}`, undefined, 'GET')
      return response.status === 200 ? response.body.data : null
    }

    const cancel = (purchaseId, requestId, lines, reason = 'supplier_delay', note = '收货延迟') =>
      call(`/api/v2/inventory/purchases/${encodeURIComponent(purchaseId)}/cancel`, { requestId, lines, reason, note })

    const pay = (requestId, sourceDocument, amountCents) =>
      call('/api/v2/finance/payments', { requestId, sourceDocument, amountCents, method: 'bank' })

    // ───────────────────────── A 段 · B37 取消采购 ─────────────────────────

    const productA = await makeProduct('cancel')
    const A = await makePurchase('cancel', productA, 5, 12_000)
    check('R08 建单后应付 = 5 × 12000 = 60000 分', A.detail?.purchase?.payableCents === 60_000, JSON.stringify(A.detail?.purchase))
    check('R08 建单后在途 = 5', A.detail?.purchase?.pendingQty === 5, String(A.detail?.purchase?.pendingQty))

    const cancelId = reqId('cancel')
    const cancelled = await cancel(A.purchaseId, cancelId, [{ purchaseLineId: A.lineId, qty: 2 }], 'supplier_delay', '档口缺货')
    check('B37 取消未到数量 2 件 → 200', cancelled.status === 200, `${cancelled.status} ${JSON.stringify(cancelled.body).slice(0, 220)}`)
    check('B37 结果：本次取消 2、剩余在途 3', cancelled.body?.data?.effects?.cancelledQty === 2 && cancelled.body?.data?.effects?.pendingQty === 3, JSON.stringify(cancelled.body?.data?.effects))

    const afterCancel = await readPurchase(A.purchaseId)
    check('R08 取消后 cancelledQty = 2', afterCancel?.purchase?.cancelledQty === 2, String(afterCancel?.purchase?.cancelledQty))
    check('R08 取消后在途 = 3（恒等式 ordered = received + rejected + cancelled + pending）', afterCancel?.purchase?.pendingQty === 3, String(afterCancel?.purchase?.pendingQty))
    check('R08 取消后进度仍是「尚未到货」', afterCancel?.purchase?.progress === '尚未到货', String(afterCancel?.purchase?.progress))
    check('R08 取消不改写订购量（line.qtyOrdered 仍为 5）', afterCancel?.lines?.[0]?.qtyOrdered === 5, String(afterCancel?.lines?.[0]?.qtyOrdered))
    check('R08 应付基数随取消收缩为 3 × 12000 = 36000 分', afterCancel?.purchase?.payableCents === 36_000, String(afterCancel?.purchase?.payableCents))

    const cancelRetry = await cancel(A.purchaseId, cancelId, [{ purchaseLineId: A.lineId, qty: 2 }], 'supplier_delay', '档口缺货')
    check('B37 同 requestId 同载荷重放 → 200 且复用同一 operationId',
      cancelRetry.status === 200 && cancelRetry.body?.data?.operationId === cancelled.body?.data?.operationId,
      `${cancelRetry.status} ${cancelRetry.body?.data?.operationId} / ${cancelled.body?.data?.operationId}`)
    check('B37 重放后取消总量仍是 2（不重复落台账）',
      (await readPurchase(A.purchaseId))?.purchase?.cancelledQty === 2)

    const cancelMismatch = await cancel(A.purchaseId, cancelId, [{ purchaseLineId: A.lineId, qty: 1 }], 'supplier_delay', '档口缺货')
    check('B37 同 requestId 改载荷 → 409 IDEMPOTENCY_MISMATCH',
      cancelMismatch.status === 409 && cancelMismatch.body?.error?.code === 'IDEMPOTENCY_MISMATCH',
      `${cancelMismatch.status} ${JSON.stringify(cancelMismatch.body).slice(0, 200)}`)

    const badReason = await cancel(A.purchaseId, reqId('bad-reason'), [{ purchaseLineId: A.lineId, qty: 1 }], 'because-i-said-so')
    check('B37 非法取消原因 → 400', badReason.status === 400, `${badReason.status} ${JSON.stringify(badReason.body).slice(0, 200)}`)

    // 到货 2 件 → 已到货部分不能再取消
    const receipt = await call('/api/v2/inventory/receipts', {
      requestId: reqId('receipt'),
      purchaseId: A.purchaseId,
      lines: [{ purchaseLineId: A.lineId, productRef: productA, qtyReceived: 2, disposition: 'available' }],
    })
    check('B15 到货 2 件（数量件直接进可用）', receipt.status === 200, `${receipt.status} ${JSON.stringify(receipt.body).slice(0, 220)}`)

    const afterReceipt = await readPurchase(A.purchaseId)
    check('R08 到货后在途 = 1（5 − 实到 2 − 取消 2）', afterReceipt?.purchase?.pendingQty === 1, String(afterReceipt?.purchase?.pendingQty))

    const overCancel = await cancel(A.purchaseId, reqId('over-cancel'), [{ purchaseLineId: A.lineId, qty: 2 }])
    check('B37 已到货数量不可再取消 → 422 PURCHASE_CANCEL_EXCEEDED',
      overCancel.status === 422 && overCancel.body?.error?.code === 'PURCHASE_CANCEL_EXCEEDED',
      `${overCancel.status} ${JSON.stringify(overCancel.body).slice(0, 200)}`)

    const finalCancel = await cancel(A.purchaseId, reqId('final-cancel'), [{ purchaseLineId: A.lineId, qty: 1 }], 'customer_cancelled')
    check('B37 取消最后 1 件在途 → 200', finalCancel.status === 200, `${finalCancel.status} ${JSON.stringify(finalCancel.body).slice(0, 200)}`)
    const settled = await readPurchase(A.purchaseId)
    check('R08 全部处置后在途 = 0、进度「到货完成」',
      settled?.purchase?.pendingQty === 0 && settled?.purchase?.progress === '到货完成',
      `${settled?.purchase?.pendingQty} / ${settled?.purchase?.progress}`)

    // ───────────────────────── B 段 · B33 采购付款 ─────────────────────────

    const productB = await makeProduct('pay')
    const B = await makePurchase('pay', productB, 4, 5_000)
    const overviewBefore = await call('/api/v2/finance/overview', undefined, 'GET')
    const payableBefore = overviewBefore.body?.data?.payable?.totalCents
    check('R12 账本汇总可读（payable.totalCents 为整数）', Number.isInteger(payableBefore), String(payableBefore))

    // ⚠️ 幂等必须复用同一个 requestId 字符串；reqId() 每次都生成新 uuid，不能拿来验幂等。
    const partReq = reqId('pay-part')
    const partial = await pay(partReq, `purchase:${B.purchaseId}`, 8_000)
    check('B33 部分付款 8000 分 → 200', partial.status === 200, `${partial.status} ${JSON.stringify(partial.body).slice(0, 220)}`)
    check('B33 付款结果：应付 20000 / 已付 8000 / 剩余 12000',
      partial.body?.data?.effects?.payableCents === 20_000 &&
      partial.body?.data?.effects?.paidCents === 8_000 &&
      partial.body?.data?.effects?.remainingPayableCents === 12_000,
      JSON.stringify(partial.body?.data?.effects))

    const partialReplay = await pay(partReq, `purchase:${B.purchaseId}`, 8_000)
    check('B33 同 requestId 同载荷重放 → 复用同一 operationId，已付仍是 8000',
      partialReplay.status === 200 &&
      partialReplay.body?.data?.operationId === partial.body?.data?.operationId &&
      partialReplay.body?.data?.effects?.paidCents === 8_000,
      `${partialReplay.status} ${partialReplay.body?.data?.operationId} / paid=${partialReplay.body?.data?.effects?.paidCents}`)

    const payRetry = await pay(reqId('pay-reuse'), `purchase:${B.purchaseId}`, 8_000)
    check('B33 另起 requestId 同金额再付 → 已付累计 16000（部分付款可多笔）', payRetry.status === 200 && payRetry.body?.data?.effects?.paidCents === 16_000, `${payRetry.status} ${JSON.stringify(payRetry.body?.data?.effects)}`)

    const payMismatch = await pay(partReq, `purchase:${B.purchaseId}`, 1_000)
    check('B33 同 requestId 改金额 → 409 IDEMPOTENCY_MISMATCH', payMismatch.status === 409 && payMismatch.body?.error?.code === 'IDEMPOTENCY_MISMATCH', `${payMismatch.status} ${JSON.stringify(payMismatch.body).slice(0, 200)}`)

    const overPay = await pay(reqId('pay-over'), `purchase:${B.purchaseId}`, 5_000)
    check('B33 超付 → 422 BALANCE_EXCEEDED',
      overPay.status === 422 && overPay.body?.error?.code === 'BALANCE_EXCEEDED',
      `${overPay.status} ${JSON.stringify(overPay.body).slice(0, 200)}`)

    const settle = await pay(reqId('pay-settle'), { kind: 'purchase', id: B.purchaseId }, 4_000)
    check('B33 付清剩余 4000 分（sourceDocument 也接受 {kind,id} 形态）→ 200', settle.status === 200, `${settle.status} ${JSON.stringify(settle.body).slice(0, 220)}`)
    const paidDetail = await readPurchase(B.purchaseId)
    check('R08 付清后 remainingPayableCents = 0', paidDetail?.purchase?.remainingPayableCents === 0, String(paidDetail?.purchase?.remainingPayableCents))

    // 账本流水必须挂得住具体采购单（R12 的 allocation 字段）
    const entries = await call('/api/v2/finance/entries?direction=out&limit=200', undefined, 'GET')
    const purchaseEntries = (entries.body?.data?.entries ?? []).filter((entry) => entry.allocationId === B.purchaseId)
    check('R12 账本流水能按采购单追溯（allocationType=purchase 且 allocationId 命中）',
      purchaseEntries.length === 3 && purchaseEntries.every((entry) => entry.allocationType === 'purchase' && entry.purpose === 'purchase' && entry.direction === 'out'),
      `命中 ${purchaseEntries.length} 条`)
    check('R12 采购付款金额合计 = 20000 分',
      purchaseEntries.reduce((sum, entry) => sum + entry.amountCents, 0) === 20_000,
      String(purchaseEntries.reduce((sum, entry) => sum + entry.amountCents, 0)))

    const overviewAfter = await call('/api/v2/finance/overview', undefined, 'GET')
    check('R12 付清后账本应付净减 20000 分',
      overviewAfter.body?.data?.payable?.totalCents === payableBefore - 20_000,
      `${payableBefore} → ${overviewAfter.body?.data?.payable?.totalCents}`)

    // 已有净付款 → 取消被拒，且不落台账
    const blockedCancel = await cancel(B.purchaseId, reqId('blocked-cancel'), [{ purchaseLineId: B.lineId, qty: 1 }])
    check('B37 已有净付款 → 409 PURCHASE_PAYMENT_CONFLICT',
      blockedCancel.status === 409 && blockedCancel.body?.error?.code === 'PURCHASE_PAYMENT_CONFLICT',
      `${blockedCancel.status} ${JSON.stringify(blockedCancel.body).slice(0, 200)}`)
    check('B37 被拒的取消没有落台账（在途仍为 4）',
      (await readPurchase(B.purchaseId))?.purchase?.pendingQty === 4,
      String((await readPurchase(B.purchaseId))?.purchase?.pendingQty))

    // 成本未知 → 不得登记付款；也不得凭空取消后付款
    const productC = await makeProduct('unknown')
    const C = await makePurchase('unknown', productC, 1, undefined)
    const unknownDetail = await readPurchase(C.purchaseId)
    check('R08 成本未知的采购单 payableCents 计为 0（不把未知写成 0 成本也应付款）', unknownDetail?.purchase?.payableCents === 0, String(unknownDetail?.purchase?.payableCents))
    const unknownPay = await pay(reqId('pay-unknown'), `purchase:${C.purchaseId}`, 1)
    check('B33 成本未知 → 400 VALIDATION_ERROR 且提示「成本未知」',
      unknownPay.status === 400 && unknownPay.body?.error?.code === 'VALIDATION_ERROR' && /成本未知/.test(unknownPay.body?.error?.message ?? ''),
      `${unknownPay.status} ${JSON.stringify(unknownPay.body).slice(0, 220)}`)

    const missingPurchase = await pay(reqId('pay-missing'), 'purchase:f3v-not-exist', 100)
    check('B33 不存在的采购单 → 404', missingPurchase.status === 404, `${missingPurchase.status} ${JSON.stringify(missingPurchase.body).slice(0, 200)}`)

    report.summary = { total: report.passed.length + report.failed.length, passed: report.passed.length, failed: report.failed.length }
  } finally {
    backend.child.kill()
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
    fs.writeFileSync(path.join(OUT, 'backend.log'), backend.logs.join(''))
    console.log('─'.repeat(60))
    console.log(`验收结果：${report.passed.length} 通过 / ${report.failed.length} 失败（报告：report.json）`)
    if (report.failed.length) {
      console.log('未通过项：')
      for (const item of report.failed) console.log(`  ✗ ${item.name} —— ${item.detail}`)
      process.exitCode = 1
    }
  }
}

main().catch((error) => {
  console.error('验收脚本异常：', error)
  process.exitCode = 1
})
