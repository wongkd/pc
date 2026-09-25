/**
 * E11 · 回收拆件与抵用收尾 端到端验收（本地隔离环境，不接触生产）。
 *
 * 与 E06/E07/E08/E09/E10 验收脚本同一套路：后端起 backend/scripts/dev-server.mjs
 * （miniflare + 真实 Worker 入口 + 内存 D1 + 演示数据），走真实登录与真实 HTTP。
 *
 * 覆盖的业务链路（对应前端真页面 /recovery）：
 *   1. B26 回收登记（客户暂存，不进自有库存）与幂等；
 *   2. B27 验机 → 估价（offered），以及「报价发出后不能再改价」的契约边界；
 *   3. B28 取得所有权：逐件成本之和必须等于最终价，收购后实物进 quarantine 且带成本；
 *   4. B33 回收付款：超付拒绝、部分付、付清、付清后再付；采购付款由 F3 独立验收；
 *   5. B44 拆件：守恒不成立被拒，守恒成立时源件退役 / 产出件进待检 / 损耗单列报废；
 *   6. B29 归还：offered 可归还，acquired 之后不得归还；
 *   7. R10 列表按状态过滤、详情带明细与实物编号。
 *
 * 断言是软断言：失败记进 report.failed 但不中断，一次运行拿到完整报告。
 *
 * 用法：node docs/verification/E11-current/verify-e11.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../../..')
const BACKEND_PORT = 8823
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

    // R10 详情直接返回回收单对象（不是 { order } 包一层），列表才是 { orders }。
    const detail = async (orderId) => (await call(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}`)).body?.data
    const inventory = async () => (await call('/api/v2/inventory')).body?.data

    // 商品：acquire 与拆件都要引用商品（productRef 用 entity_id）。
    const inv0 = await inventory()
    const products = inv0?.items ?? []
    check('演示库存里至少有两个商品（收购与拆件各用其一）', products.length >= 2,
      JSON.stringify(products.map((p) => ({ id: p.id, name: p.name }))))
    const hostRef = products[0]?.id
    const ramRef = products[1]?.id
    const ssdRef = products[2]?.id ?? products[1]?.id
    console.log('演示商品：', JSON.stringify(products.map((p) => ({ id: p.id, name: p.name, mode: p.trackingMode }))))

    // ───────────────────────── B26 回收登记 ─────────────────────────
    const created = await call('/api/v2/recovery/orders', {
      requestId: 'e11-verify-reg',
      sellerName: '陈师傅',
      sellerPhone: '13800001111',
      items: [
        { description: '联想 ThinkPad T14 整机', condition: 'used', snRaw: 'SN-E11-A', estimatedCents: 80_000 },
      ],
      initialEstimateCents: 80_000,
      note: 'E11 验收：到店回收',
    })
    const orderId = created.body?.data?.entityId
    check('B26：回收登记成功并返回单号', created.status === 200 && Boolean(orderId), JSON.stringify(created.body))

    let d = await detail(orderId)
    check('B26：登记后状态 received_for_inspection，明细一件且估价 800.00',
      d?.state === 'received_for_inspection' && d?.items?.length === 1 && d?.items[0]?.estimatedCents === 80_000,
      JSON.stringify(d))
    check('B26：客户暂存物没有实物编号（不进自有库存）', d?.items?.[0]?.stockItemId === null, JSON.stringify(d?.items))

    const repeated = await call('/api/v2/recovery/orders', {
      requestId: 'e11-verify-reg',
      sellerName: '陈师傅',
      sellerPhone: '13800001111',
      items: [
        { description: '联想 ThinkPad T14 整机', condition: 'used', snRaw: 'SN-E11-A', estimatedCents: 80_000 },
      ],
      initialEstimateCents: 80_000,
      note: 'E11 验收：到店回收',
    })
    check('B26 幂等：同 requestId 复用原单', repeated.status === 200 && repeated.body?.data?.entityId === orderId,
      JSON.stringify(repeated.body))

    const invalid = await call('/api/v2/recovery/orders', { requestId: 'e11-verify-reg-bad', sellerName: '散客', items: [] }, false)
    check('B26：没有实物被拒绝（400 VALIDATION_ERROR）',
      invalid.status === 400 && invalid.body?.error?.code === 'VALIDATION_ERROR', JSON.stringify(invalid.body))

    // ───────────────────────── B27 验机与估价 ─────────────────────────
    await call(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}/inspect`, { requestId: 'e11-verify-inspect', note: '功能正常' })
    d = await detail(orderId)
    check('B27a：验机后状态 inspecting', d?.state === 'inspecting', JSON.stringify(d))

    const offered = await call(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}/offer`, {
      requestId: 'e11-verify-offer',
      itemPrices: [{ recoveryItemId: d.items[0].id, estimatedCents: 120_000 }],
    })
    d = await detail(orderId)
    check('B27b：估价后状态 offered、版本 1、估价 1200.00',
      offered.status === 200 && d?.state === 'offered' && d?.offerVersion === 1 && d?.initialEstimateCents === 120_000,
      JSON.stringify(d))

    const offerAgain = await call(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}/offer`, {
      requestId: 'e11-verify-offer2', itemPrices: [{ recoveryItemId: d.items[0].id, estimatedCents: 150_000 }],
    }, false)
    check('B27 边界：报价发出后不能就地改价（契约无 offered→inspecting，见 OPEN-ITEMS G-27）',
      offerAgain.status === 400 && offerAgain.body?.error?.code === 'VALIDATION_ERROR', JSON.stringify(offerAgain.body))

    // ───────────────────────── B28 取得所有权 ─────────────────────────
    const mismatch = await call(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}/acquire`, {
      requestId: 'e11-verify-acq-bad',
      finalAcquisitionCents: 120_000,
      lines: [{ recoveryItemId: d.items[0].id, productRef: hostRef, assetCode: 'AST-E11-BAD', costCents: 100_000 }],
    }, false)
    check('B28 守卫：逐件成本之和 ≠ 最终价被拒绝（400）',
      mismatch.status === 400 && mismatch.body?.error?.code === 'VALIDATION_ERROR', JSON.stringify(mismatch.body))

    const acquired = await call(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}/acquire`, {
      requestId: 'e11-verify-acq',
      finalAcquisitionCents: 120_000,
      lines: [{ recoveryItemId: d.items[0].id, productRef: hostRef, assetCode: 'AST-E11-HOST', snRaw: 'SN-E11-A', costCents: 120_000 }],
      evidenceRef: '身份证复印件 + 现场照片',
    })
    d = await detail(orderId)
    check('B28：取得所有权后状态 acquired、应付 = 最终价 1200.00',
      acquired.status === 200 && d?.state === 'acquired' && d?.finalAcquisitionCents === 120_000 && d?.payableCents === 120_000,
      JSON.stringify(d))
    check('B28：明细带上实物编号与取得成本', Boolean(d?.items?.[0]?.stockItemId) && d?.items[0]?.acquiredCostCents === 120_000,
      JSON.stringify(d?.items))

    const invAfterAcquire = await inventory()
    const acquiredItem = invAfterAcquire?.lotItems?.find((row) => row.id === d?.items?.[0]?.stockItemId)
    check('B28：实物归门店且进待检（ownership=store、availability=quarantine），不是可卖',
      acquiredItem?.ownership === 'store' && acquiredItem?.availability === 'quarantine', JSON.stringify(acquiredItem))
    check('B28：取得成本落到实物（1200.00）', acquiredItem?.acquisitionCostCents === 120_000, JSON.stringify(acquiredItem))

    // ───────────────────────── B33 付款 ─────────────────────────
    const overPay = await call('/api/v2/finance/payments', {
      requestId: 'e11-verify-pay-over', sourceDocument: `recovery:${orderId}`, amountCents: 120_001, method: 'cash',
    }, false)
    check('B33 守卫：超付被拒绝（BALANCE_EXCEEDED）',
      overPay.body?.error?.code === 'BALANCE_EXCEEDED', `${overPay.status} ${JSON.stringify(overPay.body?.error)}`)

    await call('/api/v2/finance/payments', {
      requestId: 'e11-verify-pay-part', sourceDocument: `recovery:${orderId}`, amountCents: 20_000, method: 'wechat', remark: '先付定金',
    })
    d = await detail(orderId)
    check('B33：部分付款后已付 200.00、应付 1000.00', d?.paidCents === 20_000 && d?.payableCents === 100_000, JSON.stringify(d))

    await call('/api/v2/finance/payments', {
      requestId: 'e11-verify-pay-rest', sourceDocument: { kind: 'recovery', id: orderId }, amountCents: 100_000, method: 'cash',
    })
    d = await detail(orderId)
    check('B33：付清后应付归零', d?.paidCents === 120_000 && d?.payableCents === 0, JSON.stringify(d))

    const payAgain = await call('/api/v2/finance/payments', {
      requestId: 'e11-verify-pay-again', sourceDocument: `recovery:${orderId}`, amountCents: 1, method: 'cash',
    }, false)
    check('B33：已付清再付被拒绝（BALANCE_EXCEEDED）', payAgain.body?.error?.code === 'BALANCE_EXCEEDED', JSON.stringify(payAgain.body))

    const entries = await call('/api/v2/finance/entries?direction=out&limit=50')
    const outEntries = entries.body?.data?.entries ?? []
    check('B33：付款落在资金流出的方向（direction=out，purpose=recovery）',
      outEntries.some((row) => row.purpose === 'recovery' && row.direction === 'out' && row.amountCents === 20_000)
      && outEntries.some((row) => row.purpose === 'recovery' && row.amountCents === 100_000),
      JSON.stringify(outEntries.filter((row) => row.purpose === 'recovery')))

    // ───────────────────────── B44 拆件 ─────────────────────────
    const sourceId = d.items[0].stockItemId
    const broken = await call(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}/teardown`, {
      requestId: 'e11-verify-td-bad',
      sourceStockItemId: sourceId,
      outputs: [{ productRef: ramRef, assetCode: 'AST-E11-BAD', costCents: 70_000 }],
    }, false)
    check('B44 守恒：产出 + 损耗 ≠ 源成本被拒绝（400）',
      broken.status === 400 && broken.body?.error?.code === 'VALIDATION_ERROR', JSON.stringify(broken.body))

    const torn = await call(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}/teardown`, {
      requestId: 'e11-verify-td',
      sourceStockItemId: sourceId,
      outputs: [
        { productRef: ramRef, assetCode: 'AST-E11-RAM', snRaw: 'SN-E11-RAM', costCents: 40_000 },
        { productRef: ssdRef, assetCode: 'AST-E11-SSD', costCents: 50_000 },
      ],
      scrapLines: [{ description: '主板腐蚀报废', costCents: 30_000 }],
      occurredAt: '2026-09-22T02:00:00Z',
    })
    d = await detail(orderId)
    check('B44：拆件后状态 disassembled（产出 2 件 + 损耗 1 行，守恒 1200.00）',
      torn.status === 200 && d?.state === 'disassembled', JSON.stringify(torn.body))

    const invAfterTeardown = await inventory()
    const sourceAfter = invAfterTeardown?.lotItems?.find((row) => row.id === sourceId)
    check('B44：源整机退役（retired）', sourceAfter?.availability === 'retired', JSON.stringify(sourceAfter))
    const outputIds = torn.body?.data?.effects?.outputIds ?? []
    const outputs = outputIds.map((id) => invAfterTeardown?.lotItems?.find((row) => row.id === id))
    check('B44：产出件两件、都进待检（quarantine）',
      outputs.length === 2 && outputs.every((row) => row && row.availability === 'quarantine'),
      JSON.stringify(outputs.map((row) => ({ id: row?.id, avail: row?.availability }))))
    check('B44：产出件成本分别是 400.00 与 500.00（损耗单列报废，不摊进产出件）',
      outputs[0]?.acquisitionCostCents === 40_000 && outputs[1]?.acquisitionCostCents === 50_000,
      JSON.stringify(outputs.map((row) => row?.acquisitionCostCents)))
    check('B44：损耗金额随拆件结果返回（300.00）', torn.body?.data?.effects?.scrapCostCents === 30_000,
      JSON.stringify(torn.body?.data?.effects))

    // ───────────────────────── B29 归还（第二单） ─────────────────────────
    const second = await call('/api/v2/recovery/orders', {
      requestId: 'e11-verify-reg2',
      sellerName: '吴女士',
      items: [{ description: '旧显示器', condition: 'used' }],
    })
    const order2 = second.body?.data?.entityId
    await call(`/api/v2/recovery/orders/${encodeURIComponent(order2)}/inspect`, { requestId: 'e11-verify-inspect2' })
    let d2 = await detail(order2)
    await call(`/api/v2/recovery/orders/${encodeURIComponent(order2)}/offer`, {
      requestId: 'e11-verify-offer2b', itemPrices: [{ recoveryItemId: d2.items[0].id, estimatedCents: 30_000 }],
    })
    d2 = await detail(order2)
    check('B27：第二单走到 offered', d2?.state === 'offered', JSON.stringify(d2))

    const returned = await call(`/api/v2/recovery/orders/${encodeURIComponent(order2)}/return`, {
      requestId: 'e11-verify-return', reason: '客户嫌价低，不卖了',
    })
    d2 = await detail(order2)
    check('B29：估价后可以不卖，归还客户（returned）',
      returned.status === 200 && d2?.state === 'returned', JSON.stringify(d2))

    const returnAfterAcquire = await call(`/api/v2/recovery/orders/${encodeURIComponent(orderId)}/return`, {
      requestId: 'e11-verify-return-deny', reason: '客户反悔',
    }, false)
    check('B29 守卫：所有权已转移后不能归还（400）',
      returnAfterAcquire.status === 400 && returnAfterAcquire.body?.error?.code === 'VALIDATION_ERROR',
      JSON.stringify(returnAfterAcquire.body))

    // ───────────────────────── R10 读 ─────────────────────────
    const list = await call('/api/v2/recovery/orders?limit=50')
    const orders = list.body?.data?.orders ?? []
    check('R10：列表返回本单与第二单', orders.length >= 2, JSON.stringify(orders.map((o) => ({ no: o.orderNo, state: o.state }))))

    const offeredList = await call('/api/v2/recovery/orders?state=offered&limit=50')
    check('R10：按状态过滤只剩 offered',
      (offeredList.body?.data?.orders ?? []).every((o) => o.state === 'offered'),
      JSON.stringify(offeredList.body?.data?.orders))

    const acquiredList = await call('/api/v2/recovery/orders?state=acquired&limit=50')
    check('R10：已收购单不在 acquired 列表（已拆件）',
      !(acquiredList.body?.data?.orders ?? []).some((o) => o.id === orderId),
      JSON.stringify(acquiredList.body?.data?.orders))

    const missing = await call('/api/v2/recovery/orders/not-exist-order', undefined, false)
    check('R10：不存在的单号 404', missing.status === 404, JSON.stringify(missing.body))
  } finally {
    backend.child.kill('SIGTERM')
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(
      path.join(OUT, 'verify-report.json'),
      JSON.stringify({ ...report, total: report.passed.length + report.failed.length }, null, 2),
    )
    console.log(`\n通过 ${report.passed.length} 项，失败 ${report.failed.length} 项`)
    if (report.failed.length) {
      console.log('失败项：')
      for (const item of report.failed) console.log(`  ✗ ${item.name} —— ${item.detail}`)
      process.exitCode = 1
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
