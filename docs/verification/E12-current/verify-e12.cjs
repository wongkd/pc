/**
 * E12 · 抵用额度（置换折抵）端到端验收（本地隔离环境，不接触生产）。
 *
 * 与 E11 验收脚本同一套路：后端起 backend/scripts/dev-server.mjs
 * （miniflare + 真实 Worker 入口 + 内存 D1 + 演示数据），走真实登录与真实 HTTP。
 *
 * 前端由栋哥另行用 ChatGPT 实现，故本脚本只做纯 HTTP 链路验收，不做浏览器断言。
 *
 * 两套独立链路，断言互不干扰：
 *   链路 A（折抵 + 找零）：销售单 A + 回收单 A
 *     折抵 50_000 → 找零 30_000（剩余应付）→ 超付 BALANCE_EXCEEDED
 *   链路 B（折抵 + 撤销）：销售单 B + 回收单 B
 *     折抵 50_000 → 版本冲突 → 撤销 → 再次撤销 404
 *
 * 断言是软断言：失败记进 report.failed 但不中断，一次运行拿到完整报告。
 *
 * 用法：node docs/verification/E12-current/verify-e12.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../../..')
const BACKEND_PORT = 8825
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

    const call = async (apiPath, body, expectOk = true) => {
      const response = await fetch(`${base}${apiPath}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: auth,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let json = null
      try { json = await response.json() } catch { json = null }
      if (expectOk && !response.ok) {
        check(`请求成功 ${apiPath}`, false, `${response.status} ${JSON.stringify(json).slice(0, 240)}`)
      }
      return { status: response.status, body: json }
    }

    // ───────────────────────── 商品 ─────────────────────────
    const inv = await call('/api/v2/inventory')
    const products = inv.body?.data?.items ?? []
    const qtyProduct = products.find((p) => p.trackingMode === 'quantity') ?? products[0]
    const itemProduct = products.find((p) => p.trackingMode === 'item') ?? products[0]
    check('演示库存里有商品可引用', products.length > 0 && Boolean(qtyProduct?.id), JSON.stringify(products.map((p) => ({ id: p.id, mode: p.trackingMode }))))

    // ───────────────────────── 夹具 helper ─────────────────────────
    async function createCustomer(phone) {
      const r = await call('/api/customers', { name: `折抵客户 ${phone}`, phone })
      return r.body?.id
    }

    async function createConfirmedOrder(customerId, tag) {
      const quote = await call('/api/v2/sales/quotes', {
        requestId: `${tag}-quote`, title: `${tag} 报价`, customerId,
        lines: [{ source: 'new', nameSnapshot: '新品 CPU', qty: 1, unitPriceCents: 100_000, productRef: qtyProduct.id }],
      })
      const quoteId = quote.body?.data?.entityId
      await call(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/issue`, {
        requestId: `${tag}-issue`, expectedVersion: quote.body?.data?.entityVersion,
      })
      const converted = await call(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/convert`, {
        requestId: `${tag}-convert`, quoteVersion: quote.body?.data?.entityVersion, lineProductMap: [{ position: 0, productRef: qtyProduct.id }],
      })
      const orderId = converted.body?.data?.entityId
      await call(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/payments`, {
        requestId: `${tag}-pay`, amountCents: 20_000, method: 'wechat', verificationState: 'verified',
      })
      const confirmed = await call(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/confirm`, { requestId: `${tag}-confirm` })
      return { orderId, saleVersion: confirmed.body?.data?.entityVersion }
    }

    async function toAcquiredRecovery(customerId, tag) {
      const reg = await call('/api/v2/recovery/orders', {
        requestId: `${tag}-reg`, sellerName: `客户 ${tag}`, sellerPhone: '13800009999', sellerCustomerId: customerId,
        items: [{ description: '旧整机', condition: 'used', snRaw: `SN-${tag}`, estimatedCents: 80_000 }],
        initialEstimateCents: 80_000,
      })
      const recoveryId = reg.body?.data?.entityId
      await call(`/api/v2/recovery/orders/${encodeURIComponent(recoveryId)}/inspect`, { requestId: `${tag}-inspect`, note: '' })
      const d = await call(`/api/v2/recovery/orders/${encodeURIComponent(recoveryId)}`)
      const itemId = d.body?.data?.items?.[0]?.id
      await call(`/api/v2/recovery/orders/${encodeURIComponent(recoveryId)}/offer`, {
        requestId: `${tag}-offer`, itemPrices: [{ recoveryItemId: itemId, estimatedCents: 80_000 }],
      })
      const acquired = await call(`/api/v2/recovery/orders/${encodeURIComponent(recoveryId)}/acquire`, {
        requestId: `${tag}-acquire`, finalAcquisitionCents: 80_000,
        lines: [{ recoveryItemId: itemId, productRef: itemProduct.id, assetCode: `AST-${tag}`, snRaw: `SN-${tag}`, costCents: 80_000 }],
      })
      return { recoveryId, recoveryVersion: acquired.body?.data?.entityVersion }
    }

    // ───────────────────────── 链路 A：折抵 + 找零 ─────────────────────────
    const customerA = await createCustomer('13900000001')
    check('链路 A：建客户', Number.isInteger(customerA), String(customerA))
    const saleA = await createConfirmedOrder(customerA, 'e12-a')
    check('链路 A：销售单 confirmed（balance 80_000）', Boolean(saleA.orderId) && Number.isInteger(saleA.saleVersion), JSON.stringify(saleA))
    const recA = await toAcquiredRecovery(customerA, 'e12-a')
    check('链路 A：回收单 acquired（应付 80_000）', Boolean(recA.recoveryId) && Number.isInteger(recA.recoveryVersion), JSON.stringify(recA))

    const tiA = await call('/api/v2/trade-ins', {
      requestId: 'e12-a-ti', saleOrderId: saleA.orderId, recoveryId: recA.recoveryId,
      saleOrderVersion: saleA.saleVersion, recoveryVersion: recA.recoveryVersion,
    })
    const tradeInA = tiA.body?.data?.entityId
    check('链路 A：建置换关联成功', tiA.status === 200 && Boolean(tradeInA), JSON.stringify(tiA.body))

    const offA = await call(`/api/v2/trade-ins/${encodeURIComponent(tradeInA)}/apply-offset`, {
      requestId: 'e12-a-off', amountCents: 50_000,
      saleOrderVersion: saleA.saleVersion, recoveryVersion: recA.recoveryVersion,
    })
    check('链路 A：折抵 50_000 成功', offA.status === 200 && Boolean(offA.body?.data?.entityId), JSON.stringify(offA.body))

    const detailA = await call(`/api/v2/trade-ins/${encodeURIComponent(tradeInA)}`)
    const dA = detailA.body?.data
    check('链路 A：R11 有效折抵 50_000、销售余额 30_000、回收剩余应付 30_000',
      dA?.validOffsetCents === 50_000 && dA?.saleOrder?.balanceCents === 30_000 && dA?.recoveryPayableRemainingCents === 30_000,
      JSON.stringify(dA))

    const recAView = await call(`/api/v2/recovery/orders/${encodeURIComponent(recA.recoveryId)}`)
    check('链路 A：R10 回收详情带 offsetCents = 50_000', recAView.body?.data?.offsetCents === 50_000, JSON.stringify(recAView.body?.data))

    const change = await call('/api/v2/finance/payments', {
      requestId: 'e12-a-cashback', sourceDocument: `recovery:${recA.recoveryId}`, amountCents: 30_000, method: 'cash',
    })
    check('链路 A：找零 30_000（折抵后剩余应付）现金付清', change.status === 200, JSON.stringify(change.body))

    const overPay = await call('/api/v2/finance/payments', {
      requestId: 'e12-a-cashback-over', sourceDocument: `recovery:${recA.recoveryId}`, amountCents: 1, method: 'cash',
    }, false)
    check('链路 A：找零后再付 1 分被拒（BALANCE_EXCEEDED，扣了折抵）',
      overPay.body?.error?.code === 'BALANCE_EXCEEDED', `${overPay.status} ${JSON.stringify(overPay.body?.error)}`)

    // ───────────────────────── 链路 B：折抵 + 撤销 ─────────────────────────
    const customerB = await createCustomer('13900000002')
    const saleB = await createConfirmedOrder(customerB, 'e12-b')
    const recB = await toAcquiredRecovery(customerB, 'e12-b')

    const tiB = await call('/api/v2/trade-ins', {
      requestId: 'e12-b-ti', saleOrderId: saleB.orderId, recoveryId: recB.recoveryId,
      saleOrderVersion: saleB.saleVersion, recoveryVersion: recB.recoveryVersion,
    })
    const tradeInB = tiB.body?.data?.entityId
    check('链路 B：建置换关联成功', tiB.status === 200 && Boolean(tradeInB), JSON.stringify(tiB.body))

    const offB = await call(`/api/v2/trade-ins/${encodeURIComponent(tradeInB)}/apply-offset`, {
      requestId: 'e12-b-off', amountCents: 50_000,
      saleOrderVersion: saleB.saleVersion, recoveryVersion: recB.recoveryVersion,
    })
    const offsetB = offB.body?.data?.entityId
    check('链路 B：折抵 50_000 成功', offB.status === 200 && Boolean(offsetB), JSON.stringify(offB.body))

    // 版本冲突：金额合法（10_000 ≤ 剩余 30_000），但销售版本过期。
    const stale = await call(`/api/v2/trade-ins/${encodeURIComponent(tradeInB)}/apply-offset`, {
      requestId: 'e12-b-stale', amountCents: 10_000,
      saleOrderVersion: 999999, recoveryVersion: recB.recoveryVersion,
    }, false)
    check('链路 B：过期销售版本被拒（VERSION_CONFLICT）', stale.body?.error?.code === 'VERSION_CONFLICT', JSON.stringify(stale.body))

    // 撤销：销售单版本已因折抵 +1，从详情拿当前版本。
    const orderBAfter = await call(`/api/v2/sales/orders/${encodeURIComponent(saleB.orderId)}`)
    const saleVersionB = orderBAfter.body?.data?.order?.version
    const reversed = await call(`/api/v2/trade-ins/${encodeURIComponent(tradeInB)}/reverse-offset`, {
      requestId: 'e12-b-reverse', offsetId: offsetB, reason: '验收撤销',
      saleOrderVersion: saleVersionB, recoveryVersion: recB.recoveryVersion,
    })
    check('链路 B：撤销折抵成功', reversed.status === 200, JSON.stringify(reversed.body))

    const detailB = await call(`/api/v2/trade-ins/${encodeURIComponent(tradeInB)}`)
    const dB = detailB.body?.data
    check('链路 B：撤销后有效折抵归零、回收剩余应付回到 80_000',
      dB?.validOffsetCents === 0 && dB?.recoveryPayableRemainingCents === 80_000 && dB?.offsets?.length === 2,
      JSON.stringify(dB))

    const reversedAgain = await call(`/api/v2/trade-ins/${encodeURIComponent(tradeInB)}/reverse-offset`, {
      requestId: 'e12-b-reverse-again', offsetId: offsetB, reason: '再次撤销',
      saleOrderVersion: saleVersionB, recoveryVersion: recB.recoveryVersion,
    }, false)
    check('链路 B：同一折抵不能撤销两次（404）', reversedAgain.status === 404, JSON.stringify(reversedAgain.body))

    // ───────────────────────── 报告 ─────────────────────────
    const reportPath = path.join(OUT, 'verify-report.json')
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(`\n通过 ${report.passed.length} 项 / 失败 ${report.failed.length} 项`)
    console.log(`报告：${reportPath}`)
    if (report.failed.length > 0) process.exitCode = 1
  } finally {
    backend.child.kill()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
