/**
 * F1 · 附件基础（B35）端到端验收（本地隔离环境，不接触生产）。
 *
 * 与 E12 验收脚本同一套路：后端起 backend/scripts/dev-server.mjs
 * （miniflare + 真实 Worker 入口 + 内存 D1 + 演示数据），走真实登录与真实 HTTP。
 *
 * 覆盖两条 uiRefs 链路，证明 B35 对「接修」与「回收」都可用：
 *   链路 A（实物证据，B19 用途）：owner = 库存实物 → 签发 → 上传 → 关联
 *   链路 B（回收证据）：owner = 新建回收单 → 签发 → 上传 → 关联
 *
 * 以及失败分支：类型不符 / 完整性不符 / 凭证错误 / 未上传就完成 / 改挂别处 /
 * 已关联后覆盖内容 / 跨类型归属 / 超限大小。
 *
 * 断言是软断言：失败记进 report.failed 但不中断，一次运行拿到完整报告。
 * 孤立上传回收不在此脚本覆盖（验收进程无法查库）—— 由
 * backend/tests/f1-attachments.test.mjs 的「孤立上传」用例覆盖。
 *
 * 用法：node docs/verification/F1-current/verify-f1.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')

const ROOT = path.resolve(__dirname, '../../..')
const BACKEND_PORT = 8826
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

const reqId = (tag) => `f1-verify-${tag}-${randomUUID()}`
const sha256 = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex')

/** PNG 文件头 + 填充。系统只按魔数判类型，不做图片解码。 */
function pngBytes(payload = 64) {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const bytes = new Uint8Array(head.length + payload)
  bytes.set(head, 0)
  for (let i = head.length; i < bytes.length; i++) bytes[i] = (i * 13) % 251
  return bytes
}

function jpegBytes(payload = 32) {
  const head = [0xff, 0xd8, 0xff, 0xe0]
  const bytes = new Uint8Array(head.length + payload)
  bytes.set(head, 0)
  for (let i = head.length; i < bytes.length; i++) bytes[i] = (i * 17) % 241
  return bytes
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
    const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${loginBody.token}` }

    const call = async (apiPath, body, expectOk = true) => {
      const response = await fetch(`${base}${apiPath}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: authHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let json = null
      try { json = await response.json() } catch { json = null }
      if (expectOk && !response.ok) {
        check(`请求成功 ${apiPath}`, false, `${response.status} ${JSON.stringify(json).slice(0, 240)}`)
      }
      return { status: response.status, body: json }
    }

    const putBlob = async (attachmentId, bytes, headers) => {
      const response = await fetch(`${base}/api/v2/attachments/upload-intents/${encodeURIComponent(attachmentId)}/blob`, {
        method: 'PUT',
        headers: { ...headers, Authorization: `Bearer ${loginBody.token}` },
        body: bytes,
      })
      let json = null
      try { json = await response.json() } catch { json = null }
      return { status: response.status, body: json }
    }

    const issueIntent = async (payload, expectOk = true) =>
      call('/api/v2/attachments/upload-intents', { requestId: payload.requestId, ...payload }, expectOk)

    // ───────────────────────── 归属对象 ─────────────────────────
    const inv = await call('/api/v2/inventory')
    const lotItems = inv.body?.data?.lotItems ?? []
    const reused = lotItems.find((row) => row.ownership === 'store' && row.availability === 'available') ?? lotItems[0]
    check('演示库存里有实物可作附件归属对象', Boolean(reused?.id), JSON.stringify(lotItems.slice(0, 3)))

    const recovery = await call('/api/v2/recovery/orders', {
      requestId: reqId('recovery-reg'),
      sellerName: '附件验收客户',
      sellerPhone: '13800001234',
      items: [{ description: '旧整机', condition: 'used', snRaw: 'SN-F1-VERIFY', estimatedCents: 80_000 }],
      initialEstimateCents: 80_000,
    })
    const recoveryId = recovery.body?.data?.entityId
    check('新建回收单可作附件归属对象', Boolean(recoveryId), JSON.stringify(recovery.body).slice(0, 200))

    // ───────────────────────── 链路 A：实物证据（接修 / B19 用途）─────────────────────────
    {
      const bytes = pngBytes()
      const intent = await issueIntent({
        requestId: reqId('a-intent'),
        ownerEntityType: 'stock_item',
        ownerEntityId: reused.id,
        purpose: 'service_intake',
        mime: 'image/png',
        byteSize: bytes.byteLength,
        sha256: sha256(bytes),
      })
      const data = intent.body?.data
      check('A1 签发上传意图成功（pending）', intent.status === 200 && data?.state === 'pending', JSON.stringify(intent.body).slice(0, 240))
      check('A2 返回一次性上传凭证', typeof data?.uploadToken === 'string' && data.uploadToken.length > 20)
      check('A3 返回保留期与对象键', Boolean(data?.expiresAt) && String(data?.objectKey).startsWith('attachments/store-'), String(data?.objectKey))
      check('A4 如实标注存储实现（无 R2 绑定时为内存替身）', data?.storageKind === 'memory' && data?.storagePersistent === false, JSON.stringify({ kind: data?.storageKind, persistent: data?.storagePersistent }))
      check('A5 顾客端对外读取标注为未就绪（域名未备案）', data?.customerShareable === false)

      const put = await putBlob(data.entityId, bytes, { 'X-Upload-Token': data.uploadToken, 'Content-Type': 'image/png' })
      check('A6 写入字节成功，服务端实算 sha256 与真实类型', put.status === 200 && put.body?.data?.state === 'uploaded' && put.body?.data?.sha256 === sha256(bytes), JSON.stringify(put.body).slice(0, 240))

      const complete = await call(`/api/v2/attachments/upload-intents/${encodeURIComponent(data.entityId)}/complete`, { requestId: reqId('a-complete') })
      check('A7 完成确认成功（attached）', complete.status === 200 && complete.body?.data?.state === 'attached', JSON.stringify(complete.body).slice(0, 240))
      check('A8 关联到正确的归属对象', complete.body?.data?.effects?.ownerEntityId === reused.id, JSON.stringify(complete.body?.data?.effects))
    }

    // ───────────────────────── 链路 B：回收证据 ─────────────────────────
    let bEntityId = null
    {
      const bytes = pngBytes(96)
      const intent = await issueIntent({
        requestId: reqId('b-intent'),
        ownerEntityType: 'recovery_order',
        ownerEntityId: recoveryId,
        purpose: 'recovery_evidence',
        mime: 'image/png',
        byteSize: bytes.byteLength,
      })
      const data = intent.body?.data
      bEntityId = data?.entityId
      check('B1 回收单可签发上传意图', intent.status === 200 && Boolean(bEntityId), JSON.stringify(intent.body).slice(0, 240))

      const put = await putBlob(data.entityId, bytes, { 'X-Upload-Token': data.uploadToken, 'Content-Type': 'image/png' })
      check('B2 回收证据写入字节成功', put.status === 200 && put.body?.data?.state === 'uploaded', JSON.stringify(put.body).slice(0, 200))

      const complete = await call(`/api/v2/attachments/upload-intents/${encodeURIComponent(data.entityId)}/complete`, {
        requestId: reqId('b-complete'),
        width: 1920,
        height: 1080,
      })
      check('B3 回收证据完成关联（可带宽高）', complete.status === 200 && complete.body?.data?.state === 'attached', JSON.stringify(complete.body).slice(0, 240))
    }

    // ───────────────────────── 幂等与重复完成保护 ─────────────────────────
    {
      const bytes = pngBytes(80)
      const requestId = reqId('replay')
      const payload = {
        requestId,
        ownerEntityType: 'stock_item',
        ownerEntityId: reused.id,
        purpose: 'delivery_evidence',
        mime: 'image/png',
        byteSize: bytes.byteLength,
      }
      const first = await issueIntent(payload)
      const second = await issueIntent(payload)
      check('C1 同 requestId 重放签发复用同一附件', second.body?.data?.entityId === first.body?.data?.entityId && second.body?.data?.reused === true, JSON.stringify(second.body?.data).slice(0, 200))

      const firstEntity = first.body?.data?.entityId
      await putBlob(firstEntity, bytes, { 'X-Upload-Token': first.body?.data?.uploadToken, 'Content-Type': 'image/png' })
      const completeRequestId = reqId('replay-complete')
      const c1 = await call(`/api/v2/attachments/upload-intents/${encodeURIComponent(firstEntity)}/complete`, { requestId: completeRequestId })
      const c2 = await call(`/api/v2/attachments/upload-intents/${encodeURIComponent(firstEntity)}/complete`, { requestId: completeRequestId })
      check('C2 同 requestId 重复完成命中幂等记录', c1.body?.data?.state === 'attached' && c2.body?.data?.reused === true, JSON.stringify(c2.body?.data).slice(0, 200))

      const c3 = await call(`/api/v2/attachments/upload-intents/${encodeURIComponent(firstEntity)}/complete`, { requestId: reqId('replay-complete-2') })
      check('C3 换 requestId 但归属一致时按幂等返回', c3.status === 200 && c3.body?.data?.reused === true, JSON.stringify(c3.body).slice(0, 200))

      const remap = await call(`/api/v2/attachments/upload-intents/${encodeURIComponent(firstEntity)}/complete`, {
        requestId: reqId('remap'),
        ownerEntityType: 'recovery_order',
        ownerEntityId: recoveryId,
      }, false)
      check('C4 已关联后改挂到别的对象被拒绝（409）', remap.status === 409, `${remap.status} ${JSON.stringify(remap.body).slice(0, 200)}`)
    }

    // ───────────────────────── 失败分支 ─────────────────────────
    {
      // 未上传就完成
      const pending = await issueIntent({
        requestId: reqId('pending'),
        ownerEntityType: 'stock_item',
        ownerEntityId: reused.id,
        purpose: 'service_intake',
        mime: 'image/png',
        byteSize: 128,
      })
      const early = await call(`/api/v2/attachments/upload-intents/${encodeURIComponent(pending.body?.data?.entityId)}/complete`, { requestId: reqId('pending-complete') }, false)
      check('D1 未写入字节直接完成被拒绝（400）', early.status === 400, `${early.status} ${JSON.stringify(early.body).slice(0, 200)}`)

      // 声明 PNG 实际 JPEG
      const jpeg = jpegBytes()
      const sniff = await issueIntent({
        requestId: reqId('sniff'),
        ownerEntityType: 'stock_item',
        ownerEntityId: reused.id,
        purpose: 'service_intake',
        mime: 'image/png',
        byteSize: jpeg.byteLength,
        sha256: sha256(jpeg),
      })
      const sniffPut = await putBlob(sniff.body?.data?.entityId, jpeg, {
        'X-Upload-Token': sniff.body?.data?.uploadToken,
        'Content-Type': 'image/png',
      })
      check('D2 文件真实类型与声明不符被拒绝（改扩展名无效）', sniffPut.status === 400, `${sniffPut.status} ${JSON.stringify(sniffPut.body).slice(0, 200)}`)

      // 完整性不符
      const bytes = pngBytes(40)
      const hash = await issueIntent({
        requestId: reqId('hash'),
        ownerEntityType: 'stock_item',
        ownerEntityId: reused.id,
        purpose: 'service_intake',
        mime: 'image/png',
        byteSize: bytes.byteLength,
        sha256: sha256(pngBytes(41)),
      })
      const hashPut = await putBlob(hash.body?.data?.entityId, bytes, {
        'X-Upload-Token': hash.body?.data?.uploadToken,
        'Content-Type': 'image/png',
      })
      check('D3 完整性校验不通过被拒绝', hashPut.status === 400, `${hashPut.status} ${JSON.stringify(hashPut.body).slice(0, 200)}`)

      // 凭证错误
      const tokenIssue = await issueIntent({
        requestId: reqId('token'),
        ownerEntityType: 'stock_item',
        ownerEntityId: reused.id,
        purpose: 'service_intake',
        mime: 'image/png',
        byteSize: bytes.byteLength,
      })
      const badToken = await putBlob(tokenIssue.body?.data?.entityId, bytes, { 'X-Upload-Token': 'wrong-token', 'Content-Type': 'image/png' }, false)
      check('D4 上传凭证错误被拒绝（403）', badToken.status === 403, `${badToken.status} ${JSON.stringify(badToken.body).slice(0, 200)}`)

      // 超限大小
      const tooBig = await issueIntent({
        requestId: reqId('too-big'),
        ownerEntityType: 'stock_item',
        ownerEntityId: reused.id,
        purpose: 'service_intake',
        mime: 'image/png',
        byteSize: 21 * 1024 * 1024,
      }, false)
      check('D5 超过硬上限的大小在签发时被拒绝（400）', tooBig.status === 400, `${tooBig.status} ${JSON.stringify(tooBig.body).slice(0, 200)}`)

      // 归属对象不存在 / 跨店 / 类型非法
      const noOwner = await issueIntent({
        requestId: reqId('no-owner'),
        ownerEntityType: 'stock_item',
        ownerEntityId: 'not-an-item',
        purpose: 'service_intake',
        mime: 'image/png',
        byteSize: 64,
      }, false)
      check('D6 归属对象不存在被拒绝（400）', noOwner.status === 400, `${noOwner.status}`)

      const badType = await issueIntent({
        requestId: reqId('bad-type'),
        ownerEntityType: 'customer',
        ownerEntityId: '1',
        purpose: 'service_intake',
        mime: 'image/png',
        byteSize: 64,
      }, false)
      check('D7 归属对象类型非法被拒绝（400）', badType.status === 400, `${badType.status}`)

      const badPurpose = await issueIntent({
        requestId: reqId('bad-purpose'),
        ownerEntityType: 'stock_item',
        ownerEntityId: reused.id,
        purpose: 'avatar',
        mime: 'image/png',
        byteSize: 64,
      }, false)
      check('D8 非法用途被拒绝（400）', badPurpose.status === 400, `${badPurpose.status}`)

      const badMime = await issueIntent({
        requestId: reqId('bad-mime'),
        ownerEntityType: 'stock_item',
        ownerEntityId: reused.id,
        purpose: 'service_intake',
        mime: 'application/zip',
        byteSize: 64,
      }, false)
      check('D9 非白名单类型在签发时被拒绝（400）', badMime.status === 400, `${badMime.status}`)
    }

    // ───────────────────────── 已关联后内容冻结 ─────────────────────────
    {
      const bytes = pngBytes(72)
      const intent = await issueIntent({
        requestId: reqId('frozen'),
        ownerEntityType: 'stock_item',
        ownerEntityId: reused.id,
        purpose: 'product_reference',
        mime: 'image/png',
        byteSize: bytes.byteLength,
      })
      const data = intent.body?.data
      await putBlob(data.entityId, bytes, { 'X-Upload-Token': data.uploadToken, 'Content-Type': 'image/png' })
      await call(`/api/v2/attachments/upload-intents/${encodeURIComponent(data.entityId)}/complete`, { requestId: reqId('frozen-complete') })
      const overwrite = await putBlob(data.entityId, bytes, { 'X-Upload-Token': data.uploadToken, 'Content-Type': 'image/png' }, false)
      check('E1 已关联的附件不能再覆盖内容（409）', overwrite.status === 409, `${overwrite.status} ${JSON.stringify(overwrite.body).slice(0, 200)}`)
    }

    // ───────────────────────── 部署前置提醒（不阻断）─────────────────────────
    console.log('')
    console.log('ℹ️  上线前置（本脚本无法验证，见 README「未验证范围」）：')
    console.log('   1. wrangler.toml 已声明 R2 绑定 pc-attachments，但**远端桶尚未创建**；')
    console.log('      未创建前生产环境会回落到内存实现（storagePersistent=false）。')
    console.log('   2. 本脚本跑在内存存储上，验证的是「协议与规则」，不是 R2 真实读写。')

    const result = {
      ...report,
      total: report.passed.length + report.failed.length,
      passedCount: report.passed.length,
      failedCount: report.failed.length,
    }
    fs.writeFileSync(path.join(OUT, 'verify-report.json'), JSON.stringify(result, null, 2))
    console.log('')
    console.log(`总计 ${result.total} 项 / 通过 ${result.passedCount} / 失败 ${result.failedCount}`)
  } finally {
    backend.child.kill()
    setTimeout(() => backend.child.kill('SIGKILL'), 1500)
    if (report.failed.length) {
      console.log('')
      console.log('后端日志尾部：')
      console.log(backend.logs.join('').split('\n').slice(-20).join('\n'))
    }
  }
}

main().catch((error) => {
  console.error('验收脚本异常：', error)
  process.exitCode = 1
})
