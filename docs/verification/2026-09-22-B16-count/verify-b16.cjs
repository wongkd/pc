/**
 * B16 · 盘点录入与差异批准 端到端验收（本地隔离环境，不接触生产）。
 *
 * 与 E05b / E07 / E12 / F2 / F3 验收同一套路：后端起 backend/scripts/dev-server.mjs
 * （miniflare + 真实 Worker 入口 + 内存 D1），走真实登录与真实 HTTP。
 *
 * 链路（全部走真实接口，不写任何测试后门）：
 *   1. B12 建数量件商品 → B13 期初建库存 10 件 → R06 读回 10
 *   2. B16 录入盘点（实盘 7） → **R06 仍读回 10**（保存实盘不直接改库存，02 §5）
 *   3. B16 批准 → R06 读回 7（差异调整生效，source=count_adjustment）
 *   4. 盘盈：新商品无期初（账面 0）→ 盘点实盘 2 → 批准 → 余额 2
 *   5. 幂等：同一 requestId 重放批准 → 同版本、余额不变
 *   6. 重复批准（新 requestId）→ 409 VERSION_CONFLICT
 *   7. 账面已变：录入后余额被另一次盘点批准改过 → 批准时 409，要求重盘
 *   8. 入参校验与不存在单据
 *
 * 断言是软断言：失败记进 report.failed 但不中断，一次运行拿到完整报告。
 *
 * 用法：node docs/verification/2026-09-22-B16-count/verify-b16.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../../..')
const BACKEND_PORT = 8831
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

const report = {
  scope: '本地隔离环境（真实 Worker + 内存 D1 + 真实 HTTP）；不是生产',
  passed: [],
  failed: [],
  at: new Date().toISOString(),
}
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
    // ⚠️ 幂等用例必须复用同一个 requestId 字符串，否则等于没验幂等（F3 踩过）。
    const reqId = (tag) => `b16v-${tag}-${crypto.randomUUID()}`

    /** B12 建一个数量件商品。 */
    const makeProduct = async (tag) => {
      const created = await call('/api/v2/inventory/products', {
        requestId: reqId(`product-${tag}`),
        name: `B16 验收件 ${tag}`,
        sku: `B16V-${tag}-${Date.now()}`,
        category: '配件',
        trackingMode: 'quantity',
        requiresSn: false,
        defaultSalePriceCents: 19900,
      })
      check(`B12 建商品（${tag}）`, created.status === 200, `${created.status} ${JSON.stringify(created.body).slice(0, 200)}`)
      return created.body?.data?.entityId ?? null
    }

    /** B13 期初建库存（数量件）。 */
    const seedOpening = async (tag, productRef, qty) => {
      const created = await call('/api/v2/inventory/openings', {
        requestId: reqId(`opening-${tag}`),
        approvedCountRef: `人工实盘凭据-${tag}`,
        costBasis: { kind: 'unknown' },
        lines: [{ productRef, qty }],
      })
      check(`B13 期初建库存 ${qty} 件（${tag}）`, created.status === 200, `${created.status} ${JSON.stringify(created.body).slice(0, 200)}`)
      return created.body?.data?.entityId ?? null
    }

    /** R06 读某商品的可卖数量。 */
    const readAvailable = async (productRef) => {
      const listed = await call(`/api/v2/inventory?productRef=${encodeURIComponent(productRef)}`)
      const item = (listed.body?.data?.items ?? []).find((entry) => entry.id === productRef)
      return item ? item.availableQty : null
    }

    /** B16 录入盘点。 */
    const recordCount = async (tag, lines, scopeNote) =>
      call('/api/v2/inventory/counts', {
        requestId: reqId(`count-${tag}`),
        scope: scopeNote ? { note: scopeNote } : undefined,
        lines,
      })

    /** B16 批准。requestId 可传入以便验幂等。 */
    const approveCount = async (countId, reason, requestId) =>
      call(
        `/api/v2/inventory/counts/${encodeURIComponent(countId)}/approve`,
        { requestId: requestId ?? reqId('approve'), reason },
      )

    // ── 1. 盘亏主链路：期初 10 → 实盘 7 ──────────────────────────────
    const productA = await makeProduct('loss')
    await seedOpening('loss', productA, 10)
    check('R06 期初后可卖数量为 10', (await readAvailable(productA)) === 10, String(await readAvailable(productA)))

    const recorded = await recordCount('loss', [{ productRef: productA, countedQty: 7, note: '货架第三层' }], '全店盘点')
    check('B16 录入盘点成功', recorded.status === 200, `${recorded.status} ${JSON.stringify(recorded.body).slice(0, 240)}`)
    const countIdA = recorded.body?.data?.entityId ?? null
    check('B16 录入返回 stockTouched=false（明确声明未动库存）', recorded.body?.data?.effects?.stockTouched === false)

    // ★ 本卡最重要的一条：保存实盘不直接改库存（02 §5）
    check('★ 录入后 R06 仍读回 10：保存实盘不直接改库存', (await readAvailable(productA)) === 10, String(await readAvailable(productA)))

    const approved = await approveCount(countIdA, '实盘比账面少 3，已复核确认为丢失')
    check('B16 批准成功', approved.status === 200, `${approved.status} ${JSON.stringify(approved.body).slice(0, 240)}`)
    check('B16 批准后实体版本推进到 2', approved.body?.data?.entityVersion === 2, String(approved.body?.data?.entityVersion))

    // ★ 批准后余额 == 实盘值
    check('★ 批准后 R06 读回 7：差异调整生效（10 → 7）', (await readAvailable(productA)) === 7, String(await readAvailable(productA)))
    check(
      'B16 批准返回逐行调整明细（diff = -3）',
      approved.body?.data?.effects?.adjustments?.[0]?.diffQty === -3,
      JSON.stringify(approved.body?.data?.effects?.adjustments),
    )

    // ── 2. 盘盈：账面 0 → 实盘 2 ──────────────────────────────────────
    const productB = await makeProduct('gain')
    check('R06 新商品可卖数量为 0', (await readAvailable(productB)) === 0, String(await readAvailable(productB)))
    const recordedGain = await recordCount('gain', [{ productRef: productB, countedQty: 2 }])
    check('B16 盘盈录入成功（账面 0 也能盘）', recordedGain.status === 200, `${recordedGain.status}`)
    const countIdGain = recordedGain.body?.data?.entityId ?? null
    const approvedGain = await approveCount(countIdGain, '实盘多出 2 件，确认为漏记入库')
    check('B16 盘盈批准成功', approvedGain.status === 200, `${approvedGain.status} ${JSON.stringify(approvedGain.body).slice(0, 240)}`)
    check('★ 盘盈批准后 R06 读回 2', (await readAvailable(productB)) === 2, String(await readAvailable(productB)))

    // ── 3. 幂等：同一 requestId 重放批准（必须用**未批准过**的盘点单）──────
    // ⚠️ 幂等的正确测法：盘点单**首次批准就用**这个 requestId，再用同一字符串重放。
    //    拿一张已批准的单换新 id 去「重放」，测出来的是「重复批准 409」，不是幂等（首跑踩过）。
    const productIdem = await makeProduct('idem')
    await seedOpening('idem', productIdem, 8)
    const idemRecord = await recordCount('idem', [{ productRef: productIdem, countedQty: 6 }])
    const countIdIdem = idemRecord.body?.data?.entityId ?? null
    check('B16 幂等用例的盘点单已录入（账面 8 / 实盘 6）', idemRecord.status === 200, `${idemRecord.status}`)

    const idemReq = reqId('idem-approve')
    const idemFirst = await approveCount(countIdIdem, '幂等批准', idemReq)
    const idemSecond = await approveCount(countIdIdem, '幂等批准', idemReq)
    check('B16 幂等：首次批准成功（200）', idemFirst.status === 200, `${idemFirst.status} ${JSON.stringify(idemFirst.body).slice(0, 200)}`)
    check(
      'B16 幂等：同 requestId 重放返回 200（原样复用，不报重复批准）',
      idemSecond.status === 200,
      `${idemFirst.status}/${idemSecond.status} ${JSON.stringify(idemSecond.body).slice(0, 200)}`,
    )
    check(
      'B16 幂等：两次返回同一实体版本',
      idemFirst.body?.data?.entityVersion === idemSecond.body?.data?.entityVersion,
      `${idemFirst.body?.data?.entityVersion} vs ${idemSecond.body?.data?.entityVersion}`,
    )
    check('B16 幂等：余额只被调整一次（8 → 6）', (await readAvailable(productIdem)) === 6, String(await readAvailable(productIdem)))

    // ── 4. 重复批准（换 requestId）→ 409 ──────────────────────────────
    const doubleApprove = await approveCount(countIdIdem, '再批一次')
    check(
      'B16 重复批准 → 409 VERSION_CONFLICT',
      doubleApprove.status === 409 && doubleApprove.body?.error?.code === 'VERSION_CONFLICT',
      `${doubleApprove.status} ${JSON.stringify(doubleApprove.body).slice(0, 200)}`,
    )
    check('B16 重复批准没有改变余额', (await readAvailable(productIdem)) === 6, String(await readAvailable(productIdem)))

    // ── 5. 账面已变：录入后余额被别人改过 → 批准 409 ─────────────────
    const productC = await makeProduct('stale')
    await seedOpening('stale', productC, 5)
    const staleRecord = await recordCount('stale', [{ productRef: productC, countedQty: 3 }])
    const countIdC = staleRecord.body?.data?.entityId ?? null
    check('B16 录入待批准盘点（账面 5）', staleRecord.status === 200, `${staleRecord.status}`)

    // 录入之后，另一次盘点把余额改掉（模拟「截止点之后又有出入库」）
    const interleaveRecord = await recordCount('stale-after', [{ productRef: productC, countedQty: 4 }])
    const countIdD = interleaveRecord.body?.data?.entityId ?? null
    const interleaveApprove = await approveCount(countIdD, '先把余额改成 4')
    check('B16 插入的另一次盘点批准成功（余额 5 → 4）', interleaveApprove.status === 200, `${interleaveApprove.status}`)
    check('R06 现在读回 4', (await readAvailable(productC)) === 4, String(await readAvailable(productC)))

    const staleApprove = await approveCount(countIdC, '拿旧账面硬调')
    check(
      '★ 账面已变 → 批准 409 VERSION_CONFLICT（要求重盘，不硬调）',
      staleApprove.status === 409 && staleApprove.body?.error?.code === 'VERSION_CONFLICT',
      `${staleApprove.status} ${JSON.stringify(staleApprove.body).slice(0, 240)}`,
    )
    check('★ 被拒的批准没有生成任何调整（余额仍为 4）', (await readAvailable(productC)) === 4, String(await readAvailable(productC)))

    // ── 6. 入参校验与不存在单据 ───────────────────────────────────────
    const emptyLines = await call('/api/v2/inventory/counts', { requestId: reqId('empty-lines'), lines: [] })
    check(
      'B16 录入空 lines → 400 VALIDATION_ERROR',
      emptyLines.status === 400 && emptyLines.body?.error?.code === 'VALIDATION_ERROR',
      `${emptyLines.status} ${JSON.stringify(emptyLines.body).slice(0, 200)}`,
    )
    const negativeQty = await call('/api/v2/inventory/counts', {
      requestId: reqId('negative'),
      lines: [{ productRef: productA, countedQty: -1 }],
    })
    check('B16 录入负数实盘 → 400', negativeQty.status === 400, String(negativeQty.status))

    const blankReason = await approveCount(countIdA, '   ')
    check(
      'B16 批准空理由 → 400 VALIDATION_ERROR',
      blankReason.status === 400 && blankReason.body?.error?.code === 'VALIDATION_ERROR',
      `${blankReason.status} ${JSON.stringify(blankReason.body).slice(0, 200)}`,
    )

    const missingCount = await approveCount('b16v-no-such-count', '不存在的盘点单')
    check('B16 批准不存在的盘点单 → 404 ENTITY_NOT_FOUND', missingCount.status === 404, String(missingCount.status))

    const getCounts = await call('/api/v2/inventory/counts', undefined, 'GET')
    check('B16 录入路径只接受 POST（GET → 405）', getCounts.status === 405, String(getCounts.status))

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
