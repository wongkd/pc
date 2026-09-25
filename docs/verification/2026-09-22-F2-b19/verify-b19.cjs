/**
 * F2 · 隔离件判定 B19 端到端验收（本地隔离环境，不接触生产）。
 *
 * 与 E07 / E12 验收同一套路：后端起 backend/scripts/dev-server.mjs
 * （miniflare + 真实 Worker 入口 + 内存 D1 + 演示数据），走真实登录与真实 HTTP。
 *
 * 链路（全部走真实接口，不写任何测试后门）：
 *   B12 建逐件商品 → B15 快速采购到货（disposition=quarantine）→ R06 查回隔离件
 *   → B35 上传并关联验机证据 → B19 判定放行 / 报废
 *
 * 对应验收重点：
 *   1. 隔离件可以放行（quarantine → available）；
 *   2. 报废不会重新进入可卖库存（quarantine → retired，可卖量分毫不动）；
 *   3. 同一个实物不能重复判定；
 *   4. 没有必要附件时不能强行通过（缺证据 / 假证据一律 422）。
 *
 * 断言是软断言：失败记进 report.failed 但不中断，一次运行拿到完整报告。
 *
 * 用法：node docs/verification/2026-09-22-F2-b19/verify-b19.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../../..')
const BACKEND_PORT = 8827
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

const sha256 = (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex')

/** 造一段「文件头是 PNG」的字节。系统只按魔数判类型，不做图片解码。 */
function pngBytes(payload = 48) {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const bytes = new Uint8Array(head.length + payload)
  bytes.set(head, 0)
  for (let i = head.length; i < bytes.length; i++) bytes[i] = (i * 7) % 251
  return bytes
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
    const putRaw = async (apiPath, bytes, extraHeaders = {}) => {
      const response = await fetch(`${base}${apiPath}`, {
        method: 'PUT',
        headers: { ...authHeader, ...extraHeaders },
        body: bytes,
      })
      let json = null
      try {
        json = await response.json()
      } catch {
        json = null
      }
      return { status: response.status, body: json }
    }
    const reqId = (tag) => `f2v-${tag}-${crypto.randomUUID()}`

    // ── 0. 建一个逐件商品（B12）──
    const product = await call('/api/v2/inventory/products', {
      requestId: reqId('product'),
      name: 'B19 验收待检笔记本',
      sku: `F2V-NB-${Date.now()}`,
      category: '笔记本',
      trackingMode: 'item',
      requiresSn: true,
      defaultSalePriceCents: 320000,
    })
    check('B12 建逐件商品', product.status === 200, `${product.status} ${JSON.stringify(product.body).slice(0, 200)}`)
    const productRef = product.body?.data?.entityId

    // ⚠️ 逐件实物在 R06 响应的 lotItems 里，不在 items（items 是商品级汇总行）。
    //   而且 lotItems 不支持 q 关键字搜索，只能按 productRef / availability 过滤后自己按 assetCode 找。
    const listLotItems = async (availability) => {
      const list = await call(
        `/api/v2/inventory?availability=${availability}&productRef=${encodeURIComponent(productRef)}&limit=100`,
        undefined,
        'GET',
      )
      return list.body?.data?.lotItems ?? []
    }
    const quarantineQty = async () => (await listLotItems('quarantine')).length
    const availableQty = async () => (await listLotItems('available')).length

    /** 走 B15 快速采购到货，把一件货直接放进 quarantine（采购待检来源）。返回实物 id。 */
    const makeQuarantineItem = async (tag) => {
      const assetCode = `AC-F2V-${tag}`
      const receipt = await call('/api/v2/inventory/receipts', {
        requestId: reqId(`receipt-${tag}`),
        quickPurchaseNote: `B19 验收快速采购 ${tag}`,
        lines: [
          {
            productRef,
            qtyReceived: 1,
            qtyRejected: 0,
            disposition: 'quarantine',
            unitCostCents: 150000,
            items: [{ assetCode, snRaw: `SN-F2V-${tag}` }],
          },
        ],
      })
      check(`B15 快速采购到货（${tag}）→ 待检`, receipt.status === 200, `${receipt.status} ${JSON.stringify(receipt.body).slice(0, 220)}`)
      const items = await listLotItems('quarantine')
      const item = items.find((row) => row.assetCode === assetCode)
      return item?.id ?? null
    }

    /** 走 B35 上传一张验机照片并关联到该实物，返回附件 id。 */
    const attachEvidence = async (stockItemId, tag) => {
      const bytes = pngBytes()
      const intent = await call('/api/v2/attachments/upload-intents', {
        requestId: reqId(`intent-${tag}`),
        ownerEntityType: 'stock_item',
        ownerEntityId: stockItemId,
        purpose: 'recovery_evidence',
        mime: 'image/png',
        byteSize: bytes.byteLength,
        sha256: sha256(bytes),
      })
      if (intent.status !== 200) {
        check(`B35 签发上传意图（${tag}）`, false, `${intent.status} ${JSON.stringify(intent.body).slice(0, 200)}`)
        return null
      }
      const { entityId, uploadToken } = intent.body.data
      await putRaw(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/blob`, bytes, {
        'X-Upload-Token': uploadToken,
        'Content-Type': 'image/png',
      })
      const complete = await call(`/api/v2/attachments/upload-intents/${encodeURIComponent(entityId)}/complete`, {
        requestId: reqId(`complete-${tag}`),
      })
      check(`B35 上传并关联验机证据（${tag}）`, complete.status === 200, `${complete.status} ${JSON.stringify(complete.body).slice(0, 200)}`)
      return entityId
    }

    const inspect = (itemId, payload) => call(`/api/v2/inventory/items/${encodeURIComponent(itemId)}/inspection`, payload)

    // ── 1. 放行：quarantine → available ──
    const passItem = await makeQuarantineItem('pass')
    check('隔离件进入 quarantine', Boolean(passItem), '未在待检列表里找到刚到的件')
    const passEvidence = await attachEvidence(passItem, 'pass')
    const qBefore = await quarantineQty()
    const aBefore = await availableQty()

    const passResult = await inspect(passItem, {
      requestId: reqId('pass'),
      result: 'pass',
      findings: '点亮正常，屏幕无坏点，键盘背光与电池健康度均达标',
      evidence: [passEvidence],
      disposition: 'available',
      expectedVersion: 1,
    })
    check('B19 放行返回 200', passResult.status === 200, `${passResult.status} ${JSON.stringify(passResult.body).slice(0, 240)}`)
    check('放行去向 = available', passResult.body?.data?.effects?.toBucket === 'available')
    check('放行来自 quarantine', passResult.body?.data?.effects?.fromBucket === 'quarantine')

    const detail = await call(`/api/v2/inventory/items/${encodeURIComponent(passItem)}`, undefined, 'GET')
    check('实物状态已变为可卖', detail.body?.data?.item?.availability === 'available', JSON.stringify(detail.body?.data?.item))
    const movement = (detail.body?.data?.movements ?? []).find((m) => m.source === 'inspection_release')
    check('写了 inspection_release 库存流水', Boolean(movement), JSON.stringify(detail.body?.data?.movements))
    check(
      '流水方向 quarantine → available',
      movement?.fromBucket === 'quarantine' && movement?.toBucket === 'available',
      JSON.stringify(movement),
    )

    const qAfterPass = await quarantineQty()
    const aAfterPass = await availableQty()
    check('放行后待检 -1、可卖 +1', qAfterPass === qBefore - 1 && aAfterPass === aBefore + 1, `待检 ${qBefore}→${qAfterPass}，可卖 ${aBefore}→${aAfterPass}`)
    check('放行不新增在库总量（守恒）', qAfterPass + aAfterPass === qBefore + aBefore, `在库 ${qBefore + aBefore}→${qAfterPass + aAfterPass}`)

    // ── 2. 同一实物不能重复判定 ──
    const repeat = await inspect(passItem, {
      requestId: reqId('repeat'),
      result: 'pass',
      findings: '想再判一次',
      evidence: [passEvidence],
      disposition: 'available',
      expectedVersion: 2,
    })
    check('已放行的件再判 → 422', repeat.status === 422, `${repeat.status} ${JSON.stringify(repeat.body).slice(0, 200)}`)
    check('重复判定错误码 = INSPECTION_REQUIRED', repeat.body?.error?.code === 'INSPECTION_REQUIRED', JSON.stringify(repeat.body?.error))
    const afterRepeat = await availableQty()
    check('重复判定未改变库存', afterRepeat === aAfterPass, `可卖 ${aAfterPass}→${afterRepeat}`)

    // ── 3. 报废：不重新进入可卖库存 ──
    const scrapItem = await makeQuarantineItem('scrap')
    const aBeforeScrap = await availableQty()
    const qBeforeScrap = await quarantineQty()
    const scrapResult = await inspect(scrapItem, {
      requestId: reqId('scrap'),
      result: 'fail',
      findings: '主板进水腐蚀，无维修价值，直接报废',
      evidence: [],
      disposition: 'retired',
      expectedVersion: 1,
    })
    check('B19 报废返回 200', scrapResult.status === 200, `${scrapResult.status} ${JSON.stringify(scrapResult.body).slice(0, 240)}`)
    check('报废去向 = retired', scrapResult.body?.data?.effects?.toBucket === 'retired')
    const scrapDetail = await call(`/api/v2/inventory/items/${encodeURIComponent(scrapItem)}`, undefined, 'GET')
    check('实物状态已变为 retired', scrapDetail.body?.data?.item?.availability === 'retired', JSON.stringify(scrapDetail.body?.data?.item))
    const aAfterScrap = await availableQty()
    const qAfterScrap = await quarantineQty()
    check('报废后待检 -1', qAfterScrap === qBeforeScrap - 1, `待检 ${qBeforeScrap}→${qAfterScrap}`)
    check('报废不增加可卖库存（不重新进入可卖）', aAfterScrap === aBeforeScrap, `可卖 ${aBeforeScrap}→${aAfterScrap}`)

    // ── 4. 没有必要附件不能强行通过 ──
    const noEvidenceItem = await makeQuarantineItem('noev')
    const noEvidence = await inspect(noEvidenceItem, {
      requestId: reqId('noev'),
      result: 'pass',
      findings: '看着没问题，但没上传任何照片',
      evidence: [],
      disposition: 'available',
      expectedVersion: 1,
    })
    check('无附件放行 → 422', noEvidence.status === 422, `${noEvidence.status} ${JSON.stringify(noEvidence.body).slice(0, 240)}`)
    check('无附件错误码 = INSPECTION_REQUIRED', noEvidence.body?.error?.code === 'INSPECTION_REQUIRED', JSON.stringify(noEvidence.body?.error))
    const noEvidenceDetail = await call(`/api/v2/inventory/items/${encodeURIComponent(noEvidenceItem)}`, undefined, 'GET')
    check('无附件被判定的件仍未放行（留在待检）', noEvidenceDetail.body?.data?.item?.availability === 'quarantine', JSON.stringify(noEvidenceDetail.body?.data?.item))

    // 假证据：引用一个不存在的附件 id
    const fakeEvidence = await inspect(noEvidenceItem, {
      requestId: reqId('fakeev'),
      result: 'pass',
      findings: '引用不存在的证据',
      evidence: ['att-does-not-exist'],
      disposition: 'available',
      expectedVersion: 1,
    })
    check('引用不存在的附件 → 422', fakeEvidence.status === 422, `${fakeEvidence.status} ${JSON.stringify(fakeEvidence.body).slice(0, 240)}`)

    // ── 5. 版本冲突 / 非法处置 / 不存在 ──
    const versionItem = await makeQuarantineItem('version')
    const versionEvidence = await attachEvidence(versionItem, 'version')
    const conflict = await inspect(versionItem, {
      requestId: reqId('version'),
      result: 'pass',
      findings: '拿了一个过期的版本号',
      evidence: [versionEvidence],
      disposition: 'available',
      expectedVersion: 9,
    })
    check('版本冲突 → 409', conflict.status === 409, `${conflict.status} ${JSON.stringify(conflict.body).slice(0, 200)}`)
    check('版本冲突错误码 = VERSION_CONFLICT', conflict.body?.error?.code === 'VERSION_CONFLICT', JSON.stringify(conflict.body?.error))

    const badDisposition = await inspect(versionItem, {
      requestId: reqId('baddisp'),
      result: 'pass',
      findings: '想直接卖出去，绕开状态机',
      evidence: [versionEvidence],
      disposition: 'sold',
      expectedVersion: 1,
    })
    check('处置去向不是 available / retired → 400', badDisposition.status === 400, `${badDisposition.status} ${JSON.stringify(badDisposition.body).slice(0, 200)}`)

    const missing = await inspect('f2v-does-not-exist', {
      requestId: reqId('missing'),
      result: 'pass',
      findings: '不存在的实物',
      evidence: [],
      disposition: 'retired',
      expectedVersion: 1,
    })
    check('不存在的实物 → 404', missing.status === 404, `${missing.status} ${JSON.stringify(missing.body).slice(0, 200)}`)

    // ── 6. 幂等：同 requestId 重放 ──
    const idemItem = await makeQuarantineItem('idem')
    const idemEvidence = await attachEvidence(idemItem, 'idem')
    const idemPayload = {
      requestId: reqId('idem'),
      result: 'pass',
      findings: '幂等放行',
      evidence: [idemEvidence],
      disposition: 'available',
      expectedVersion: 1,
    }
    const first = await inspect(idemItem, idemPayload)
    const second = await inspect(idemItem, idemPayload)
    check('幂等重放两次都返回 200', first.status === 200 && second.status === 200, `${first.status} / ${second.status}`)
    check('幂等重放版本一致', first.body?.data?.entityVersion === second.body?.data?.entityVersion, `${first.body?.data?.entityVersion} / ${second.body?.data?.entityVersion}`)

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
