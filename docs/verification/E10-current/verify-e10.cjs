/**
 * E10 · 售后维修与收款闭环 端到端验收（本地隔离环境，不接触生产）。
 *
 * 与 E06/E07/E08/E09 验收脚本同一套路：后端起 backend/scripts/dev-server.mjs
 * （miniflare + 真实 Worker 入口 + 内存 D1 + 演示数据），走真实登录与真实 HTTP。
 *
 * 覆盖的业务链路（对应前端最小入口 /after-sales）：
 *   1. B20 接修登记（散客，客户财产只落保管、不进自有库存）；
 *   2. B21 诊断 → 方案 → B22 确认（accepted=true 产生应收）→ B23 换件（领用自有备件
 *      available→sold，service_part_consumption）→ B41 收款归零 → B25 复测/归还；
 *   3. B25 归还闸门：费用未结清不能复测通过（BALANCE_EXCEEDED）；
 *   4. B41 边界：方案未确认不能收款、超收 422、结清后再收 422；
 *   5. B23 边界：领用不在可用库存的备件 → STOCK_CONFLICT；
 *   6. B24 外送 / 返回（custody 在 store/external 间流转）；
 *   7. B22 拒绝维修（accepted=false → ready_return、余额 0）；
 *   8. 幂等：同 requestId 重复接修复用原工单；
 *   9. R09 列表 / 状态过滤 / 详情 allowedActions；
 *  10. R12 账本：维修待收并入 receivable（serviceCount / serviceTotalCents）。
 *
 * 断言是软断言：失败记进 report.failed 但不中断，一次运行拿到完整报告。
 *
 * 用法：node docs/verification/E10-current/verify-e10.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../../..')
const BACKEND_PORT = 8821
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
      let json = null
      try { json = await response.json() } catch { json = null }
      if (expectOk && !response.ok) {
        check(`请求成功 ${path}`, false, `${response.status} ${JSON.stringify(json).slice(0, 200)}`)
      }
      return { status: response.status, body: json }
    }

    // 详情读模型：order 的 state / balance / confirmedCharge / allowedActions。
    const detail = async (orderId) => (await call(`/api/v2/service/orders/${encodeURIComponent(orderId)}`)).body?.data?.order

    // 领一件 available 的自有备件（演示数据里的逐件二手件，condition=used 也可换件）。
    const inventory = async () => (await call('/api/v2/inventory')).body?.data
    const pickAvailablePart = async () => {
      const inv = await inventory()
      return inv?.lotItems?.find((row) => row.ownership === 'store' && row.availability === 'available') ?? null
    }
    const part0 = await pickAvailablePart()
    check('演示库存里有可领用的自有备件（逐件、available）', Boolean(part0), JSON.stringify((await inventory())?.lotItems?.map((r) => ({ id: r.id, code: r.assetCode, own: r.ownership, avail: r.availability }))))

    // ─────────────────────────── 链路 1：B20→B21→B22→B23→B41→B25 完整闭环 ───────────────────────────
    const created = await call('/api/v2/service/orders', {
      requestId: 'e10-verify-loop-intake',
      customerName: '陈先生', deviceCode: 'DEV-LOOP', symptom: '开机蓝屏',
    })
    const orderId = created.body?.data?.entityId
    check('B20：接修登记成功，返回工单 id', created.status === 200 && Boolean(orderId), JSON.stringify(created.body))
    const deviceId = created.body?.data?.effects?.deviceId
    check('B20：接修返回设备保管 id（客户财产）', Boolean(deviceId), JSON.stringify(created.body?.data?.effects))

    let d = await detail(orderId)
    check('B20：接修后状态 received', d?.state === 'received', JSON.stringify(d))

    await call(`/api/v2/service/orders/${encodeURIComponent(orderId)}/diagnosis`, {
      requestId: 'e10-verify-loop-diag', diagnosisNote: '内存条接触不良',
    })
    d = await detail(orderId)
    check('B21：诊断后状态 diagnosing', d?.state === 'diagnosing', JSON.stringify(d))

    await call(`/api/v2/service/orders/${encodeURIComponent(orderId)}/proposal`, {
      requestId: 'e10-verify-loop-proposal',
      items: [{ name: '更换内存条', qty: 1, unitPriceCents: 30_000, chargeType: 'charge' }],
      chargeCents: 30_000,
      warrantyDecision: 'out_of_warranty',
    })
    d = await detail(orderId)
    check('B21b：方案后状态 awaiting_approval、版本 1', d?.state === 'awaiting_approval' && d?.proposalVersion === 1, JSON.stringify(d))

    const confirmed = await call(`/api/v2/service/orders/${encodeURIComponent(orderId)}/confirm-proposal`, {
      requestId: 'e10-verify-loop-confirm',
      proposalVersion: 1, confirmationMethod: 'phone', confirmedAt: '2026-09-21T10:00:00Z', accepted: true,
    })
    d = await detail(orderId)
    check('B22：确认后状态 repairing、应收 30000、待收 30000',
      confirmed.status === 200 && d?.state === 'repairing' && d?.confirmedChargeCents === 30_000 && d?.balanceCents === 30_000,
      JSON.stringify(d))

    // 换件：领用自有备件
    const replaced = await call(`/api/v2/service/orders/${encodeURIComponent(orderId)}/replace`, {
      requestId: 'e10-verify-loop-replace',
      approvedProposalVersion: 1,
      components: [{ oldComponentRef: '旧内存条', oldItemDisposition: 'quarantine', newStockItem: part0?.id, qty: 1, chargeType: 'charge' }],
    })
    d = await detail(orderId)
    check('B23：换件后状态 retesting', replaced.status === 200 && d?.state === 'retesting', JSON.stringify(replaced.body))
    const invAfterReplace = await inventory()
    const partAfter = invAfterReplace?.lotItems?.find((row) => row.id === part0?.id)
    check('B23：换件领用的备件 available → sold', partAfter?.availability === 'sold', JSON.stringify(partAfter))

    // 收款前不能复测通过（归还闸门）
    const earlyRetest = await call(`/api/v2/service/orders/${encodeURIComponent(orderId)}/retest`, {
      requestId: 'e10-verify-loop-retest-early', passed: true,
    }, false)
    check('B25 归还闸门：未结清不能复测通过（409 BALANCE_EXCEEDED）',
      earlyRetest.status === 409 && earlyRetest.body?.error?.code === 'BALANCE_EXCEEDED',
      `${earlyRetest.status} ${JSON.stringify(earlyRetest.body?.error)}`)

    // 收款归零
    const paid = await call(`/api/v2/service/orders/${encodeURIComponent(orderId)}/payments`, {
      requestId: 'e10-verify-loop-pay', amountCents: 30_000, method: 'wechat', occurredAt: '2026-09-21T11:00:00Z', remark: '维修费结清',
    })
    check('B41：收款成功，余额归零', paid.status === 200 && paid.body?.data?.effects?.balanceCents === 0, JSON.stringify(paid.body))
    d = await detail(orderId)
    check('B41：收款后 cash_net=30000、balance=0', d?.cashNetCents === 30_000 && d?.balanceCents === 0, JSON.stringify(d))

    const retested = await call(`/api/v2/service/orders/${encodeURIComponent(orderId)}/retest`, {
      requestId: 'e10-verify-loop-retest', passed: true,
    })
    d = await detail(orderId)
    check('B25：结清后复测通过 → ready_return', retested.status === 200 && d?.state === 'ready_return', JSON.stringify(d))

    const returned = await call(`/api/v2/service/orders/${encodeURIComponent(orderId)}/return`, {
      requestId: 'e10-verify-loop-return', returnedTo: '陈先生本人',
    })
    d = await detail(orderId)
    check('B25：归还成功 → returned', returned.status === 200 && d?.state === 'returned', JSON.stringify(d))

    // ─────────────────────────── 链路 2：幂等 ───────────────────────────
    const idemFirst = await call('/api/v2/service/orders', {
      requestId: 'e10-verify-idem', customerName: '王先生', deviceCode: 'DEV-IDEM', symptom: '花屏',
    })
    const idemOrderId = idemFirst.body?.data?.entityId
    const idemAgain = await call('/api/v2/service/orders', {
      requestId: 'e10-verify-idem', customerName: '王先生', deviceCode: 'DEV-IDEM', symptom: '花屏',
    })
    check('幂等：同 requestId 重复接修复用原工单', idemAgain.status === 200 && idemAgain.body?.data?.entityId === idemOrderId,
      `首次 ${idemOrderId} / 再次 ${idemAgain.body?.data?.entityId}`)

    // ─────────────────────────── 链路 3：B41 收款边界 ───────────────────────────
    const payEdge = await call('/api/v2/service/orders', {
      requestId: 'e10-verify-pay-edge', customerName: '赵先生', deviceCode: 'DEV-PAY', symptom: '卡顿',
    })
    const payEdgeId = payEdge.body?.data?.entityId
    const premature = await call(`/api/v2/service/orders/${encodeURIComponent(payEdgeId)}/payments`, {
      requestId: 'e10-verify-pay-early', amountCents: 1_000, method: 'cash', occurredAt: '2026-09-21T09:00:00Z',
    }, false)
    check('B41：方案未确认不能收款（400）', premature.status === 400, `${premature.status} ${JSON.stringify(premature.body?.error)}`)

    await call(`/api/v2/service/orders/${encodeURIComponent(payEdgeId)}/diagnosis`, {
      requestId: 'e10-verify-pay-diag', diagnosisNote: '重装系统',
    })
    await call(`/api/v2/service/orders/${encodeURIComponent(payEdgeId)}/proposal`, {
      requestId: 'e10-verify-pay-proposal',
      items: [{ name: '重装系统', qty: 1, unitPriceCents: 10_000, chargeType: 'charge' }],
      chargeCents: 10_000,
      warrantyDecision: 'out_of_warranty',
    })
    await call(`/api/v2/service/orders/${encodeURIComponent(payEdgeId)}/confirm-proposal`, {
      requestId: 'e10-verify-pay-confirm',
      proposalVersion: 1, confirmationMethod: 'phone', confirmedAt: '2026-09-21T10:00:00Z', accepted: true,
    })
    const over = await call(`/api/v2/service/orders/${encodeURIComponent(payEdgeId)}/payments`, {
      requestId: 'e10-verify-pay-over', amountCents: 10_001, method: 'cash', occurredAt: '2026-09-21T10:10:00Z',
    }, false)
    check('B41：超收拒绝（422 BALANCE_EXCEEDED）', over.status === 422 && over.body?.error?.code === 'BALANCE_EXCEEDED',
      `${over.status} ${JSON.stringify(over.body?.error)}`)
    await call(`/api/v2/service/orders/${encodeURIComponent(payEdgeId)}/payments`, {
      requestId: 'e10-verify-pay-pay', amountCents: 10_000, method: 'cash', occurredAt: '2026-09-21T10:20:00Z',
    })
    const over2 = await call(`/api/v2/service/orders/${encodeURIComponent(payEdgeId)}/payments`, {
      requestId: 'e10-verify-pay-over2', amountCents: 1, method: 'cash', occurredAt: '2026-09-21T10:30:00Z',
    }, false)
    check('B41：结清后再收拒绝（422 BALANCE_EXCEEDED）', over2.status === 422 && over2.body?.error?.code === 'BALANCE_EXCEEDED',
      `${over2.status} ${JSON.stringify(over2.body?.error)}`)

    // ─────────────────────────── 链路 4：B23 备件不存在 ───────────────────────────
    const stockEdge = await call('/api/v2/service/orders', {
      requestId: 'e10-verify-stock', customerName: '钱先生', deviceCode: 'DEV-STOCK', symptom: '异响',
    })
    const stockEdgeId = stockEdge.body?.data?.entityId
    await call(`/api/v2/service/orders/${encodeURIComponent(stockEdgeId)}/diagnosis`, {
      requestId: 'e10-verify-stock-diag', diagnosisNote: '主板坏',
    })
    await call(`/api/v2/service/orders/${encodeURIComponent(stockEdgeId)}/proposal`, {
      requestId: 'e10-verify-stock-proposal',
      items: [{ name: '换主板', qty: 1, unitPriceCents: 50_000, chargeType: 'charge' }],
      chargeCents: 50_000,
      warrantyDecision: 'out_of_warranty',
    })
    await call(`/api/v2/service/orders/${encodeURIComponent(stockEdgeId)}/confirm-proposal`, {
      requestId: 'e10-verify-stock-confirm',
      proposalVersion: 1, confirmationMethod: 'phone', confirmedAt: '2026-09-21T10:00:00Z', accepted: true,
    })
    const stockMiss = await call(`/api/v2/service/orders/${encodeURIComponent(stockEdgeId)}/replace`, {
      requestId: 'e10-verify-stock-replace',
      approvedProposalVersion: 1,
      components: [{ oldComponentRef: '旧主板', oldItemDisposition: 'scrapped', newStockItem: 'si-不存在', qty: 1, chargeType: 'charge' }],
    }, false)
    check('B23：领用不在可用库存的备件 → 409 STOCK_CONFLICT', stockMiss.status === 409 && stockMiss.body?.error?.code === 'STOCK_CONFLICT',
      `${stockMiss.status} ${JSON.stringify(stockMiss.body?.error)}`)

    // ─────────────────────────── 链路 5：B24 外送 / 返回 ───────────────────────────
    const dispatchOrder = await call('/api/v2/service/orders', {
      requestId: 'e10-verify-dispatch', customerName: '孙先生', deviceCode: 'DEV-DISPATCH', symptom: '进水',
    })
    const dispatchId = dispatchOrder.body?.data?.entityId
    await call(`/api/v2/service/orders/${encodeURIComponent(dispatchId)}/diagnosis`, {
      requestId: 'e10-verify-dispatch-diag', diagnosisNote: '主板腐蚀',
    })
    await call(`/api/v2/service/orders/${encodeURIComponent(dispatchId)}/proposal`, {
      requestId: 'e10-verify-dispatch-proposal',
      items: [{ name: '送修主板', qty: 1, unitPriceCents: 20_000, chargeType: 'charge' }],
      chargeCents: 20_000,
      warrantyDecision: 'undetermined',
    })
    const dispatched = await call(`/api/v2/service/orders/${encodeURIComponent(dispatchId)}/dispatch`, {
      requestId: 'e10-verify-dispatch-go', receiver: '厂家售后中心',
    })
    d = await detail(dispatchId)
    check('B24：外送成功 → outsourced', dispatched.status === 200 && d?.state === 'outsourced', JSON.stringify(d))
    const receivedExternal = await call(`/api/v2/service/orders/${encodeURIComponent(dispatchId)}/receive-external`, {
      requestId: 'e10-verify-dispatch-recv', note: '主板已修好',
    })
    d = await detail(dispatchId)
    check('B24：外送返回 → retesting', receivedExternal.status === 200 && d?.state === 'retesting', JSON.stringify(d))

    // ─────────────────────────── 链路 6：B22 拒绝维修 ───────────────────────────
    const rejectOrder = await call('/api/v2/service/orders', {
      requestId: 'e10-verify-reject', customerName: '周先生', deviceCode: 'DEV-REJECT', symptom: '老机器',
    })
    const rejectId = rejectOrder.body?.data?.entityId
    await call(`/api/v2/service/orders/${encodeURIComponent(rejectId)}/diagnosis`, {
      requestId: 'e10-verify-reject-diag', diagnosisNote: '主板坏，换新不划算',
    })
    await call(`/api/v2/service/orders/${encodeURIComponent(rejectId)}/proposal`, {
      requestId: 'e10-verify-reject-proposal',
      items: [{ name: '换主板', qty: 1, unitPriceCents: 80_000, chargeType: 'charge' }],
      chargeCents: 80_000,
      warrantyDecision: 'out_of_warranty',
    })
    const rejected = await call(`/api/v2/service/orders/${encodeURIComponent(rejectId)}/confirm-proposal`, {
      requestId: 'e10-verify-reject-confirm',
      proposalVersion: 1, confirmationMethod: 'phone', confirmedAt: '2026-09-21T10:00:00Z', accepted: false,
    })
    d = await detail(rejectId)
    check('B22：拒绝维修 → ready_return、余额 0', rejected.status === 200 && d?.state === 'ready_return' && d?.balanceCents === 0 && d?.confirmedChargeCents === 0,
      JSON.stringify(d))
    const rejectReturn = await call(`/api/v2/service/orders/${encodeURIComponent(rejectId)}/return`, {
      requestId: 'e10-verify-reject-return', returnedTo: '本人',
    })
    d = await detail(rejectId)
    check('B22：拒绝维修后可直接归还 → returned', rejectReturn.status === 200 && d?.state === 'returned', JSON.stringify(d))

    // ─────────────────────────── 链路 7：R09 列表 / 过滤 / allowedActions ───────────────────────────
    const r09 = await call('/api/v2/service/orders', {
      requestId: 'e10-verify-r09', customerName: '郑先生', deviceCode: 'DEV-R09', symptom: '黑屏',
    })
    const r09Id = r09.body?.data?.entityId
    const list = await call('/api/v2/service/orders')
    check('R09：列表返回 orders 且含刚接修的工单', list.status === 200 && Array.isArray(list.body?.data?.orders) && list.body?.data?.orders.some((o) => o.id === r09Id),
      JSON.stringify(list.body?.data?.orders?.map((o) => o.id)))
    const filtered = await call('/api/v2/service/orders?state=received')
    check('R09：按状态 received 过滤', filtered.status === 200 && Array.isArray(filtered.body?.data?.orders) && filtered.body?.data?.orders.every((o) => o.state === 'received'),
      JSON.stringify(filtered.body?.data?.orders?.map((o) => o.state)))
    const r09Detail = await detail(r09Id)
    check('R09：详情 allowedActions = ["diagnosis"]', Array.isArray(r09Detail?.allowedActions) && r09Detail.allowedActions.length === 1 && r09Detail.allowedActions[0] === 'diagnosis',
      JSON.stringify(r09Detail?.allowedActions))

    // ─────────────────────────── 链路 8：R12 账本并入维修待收 ───────────────────────────
    const overview = await call('/api/v2/finance/overview')
    check('R12：账本汇总 receivable 含 serviceCount / serviceTotalCents',
      overview.status === 200 && typeof overview.body?.data?.receivable?.serviceCount === 'number' && typeof overview.body?.data?.receivable?.serviceTotalCents === 'number',
      JSON.stringify(overview.body?.data?.receivable))
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
