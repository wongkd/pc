#!/usr/bin/env node
/**
 * T03b · 跨端一致性门禁。
 *
 *   node contracts/tools/check-client-parity.mjs
 *
 * 解决的真问题（OPEN-ITEMS T-10 的教训）：
 *   网页端与小程序端的金额口径是两份独立实现且没有任何机器门禁，
 *   结果 `store_due`（应付客户）在网页端被显示成「待收」—— 方向反转，直到人工并排实跑才发现。
 *
 * 本脚本对「错误行为 + 请求核心」做同样的防漂移，强度分三级：
 *   级别 1  两端导出的行为表 / 常量逐项深比较
 *   级别 2  两端行为表与契约 errors.json 对齐（16 码不多不少、retryable、兜底文案与 meaning 逐字一致）
 *   级别 3  两端请求核心用**同一组输入**实跑同一组场景，逐项比对可观察输出
 *
 * 为什么能直接 import 两端的 .ts：被加载的六个模块都只含 import type（类型擦除后消失），
 * Node 22 可以直接执行。装配层（fetch / wx.request）不在此列，也不需要在此列。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

/**
 * Windows 的动态 import 必须是 file:// URL（裸的 C:/ 路径会被 ESM loader 拒绝，
 * ERR_UNSUPPORTED_ESM_URL_SCHEME）。被加载的六个模块只含 import type，Node 22 可直接执行。
 */
function loadTs(relativePath) {
  return import(`file://${resolve(repoRoot, relativePath).replace(/\\/g, '/')}`)
}

const WEB = {
  behavior: await loadTs('frontend/src/api/error-behavior.ts'),
  session: await loadTs('frontend/src/api/session.ts'),
  core: await loadTs('frontend/src/api/core.ts'),
}
const MP = {
  behavior: await loadTs('miniprogram/features/error-behavior.ts'),
  session: await loadTs('miniprogram/features/session.ts'),
  core: await loadTs('miniprogram/features/api-core.ts'),
}
const CONTRACT = JSON.parse(readFileSync(resolve(repoRoot, 'contracts/v1/errors.json'), 'utf8'))

const failures = []
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(name)
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

function deepEqual(a, b, path) {
  if (a === b) return null
  if (typeof a !== typeof b || a === null || b === null) return `${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return `${path}: 数组形状不同`
    }
    for (let i = 0; i < a.length; i += 1) {
      const sub = deepEqual(a[i], b[i], `${path}[${i}]`)
      if (sub) return sub
    }
    return null
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    if (JSON.stringify(ka) !== JSON.stringify(kb)) return `${path}: 键集不同`
    for (const k of ka) {
      const sub = deepEqual(a[k], b[k], `${path}.${k}`)
      if (sub) return sub
    }
    return null
  }
  return `${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`
}

// ───────────────────────── 级别 1：导出物逐项比对 ─────────────────────────

console.log('\n[级别 1] 两端导出物逐项比对')
check('行为表 ERROR_HANDLING 逐项一致', deepEqual(WEB.behavior.ERROR_HANDLING, MP.behavior.ERROR_HANDLING, 'ERROR_HANDLING') === null)
check('结果未知行为（写）一致', deepEqual([...WEB.behavior.UNKNOWN_RESULT_ACTIONS], [...MP.behavior.UNKNOWN_RESULT_ACTIONS], 'UNKNOWN_RESULT_ACTIONS') === null)
check('结果未知行为（读）一致', deepEqual([...WEB.behavior.UNKNOWN_RESULT_READ_ACTIONS], [...MP.behavior.UNKNOWN_RESULT_READ_ACTIONS], 'UNKNOWN_RESULT_READ_ACTIONS') === null)
check('decideClientHandling 同输入同输出（16 码 × 读写 + 未知码）', (() => {
  const inputs = [...CONTRACT.errors.map((e) => e.code), null, undefined, 'NOT_A_REAL_CODE']
  for (const code of inputs) {
    for (const isWrite of [true, false]) {
      const a = [...WEB.behavior.decideClientHandling(code, { isWrite })]
      const b = [...MP.behavior.decideClientHandling(code, { isWrite })]
      if (deepEqual(a, b, `decide(${code}, ${isWrite})`)) return false
    }
  }
  return true
})())
check('fallbackMessageFor 同输入同输出', (() => {
  const inputs = [...CONTRACT.errors.map((e) => e.code), null, 'NOT_A_REAL_CODE']
  return inputs.every((code) => WEB.behavior.fallbackMessageFor(code) === MP.behavior.fallbackMessageFor(code))
})())
check('isRetryableCode 同输入同输出', (() => {
  const inputs = [...CONTRACT.errors.map((e) => e.code), null, 'NOT_A_REAL_CODE']
  return inputs.every((code) => WEB.behavior.isRetryableCode(code) === MP.behavior.isRetryableCode(code))
})())

// ───────────────────────── 级别 2：与契约对齐 ─────────────────────────

console.log('\n[级别 2] 两端行为表与契约 errors.json 对齐')
const contractCodes = CONTRACT.errors.map((e) => e.code).sort()
for (const [label, mod] of [['网页端', WEB.behavior], ['小程序端', MP.behavior]]) {
  check(`${label}覆盖契约全部 ${contractCodes.length} 个 code，且无自造码`,
    JSON.stringify(Object.keys(mod.ERROR_HANDLING).sort()) === JSON.stringify(contractCodes))
  let aligned = true
  let detail = ''
  for (const entry of CONTRACT.errors) {
    const handling = mod.ERROR_HANDLING[entry.code]
    if (!handling) { aligned = false; detail = `缺 ${entry.code}`; break }
    if (handling.fallbackMessage !== entry.meaning) {
      aligned = false; detail = `${entry.code} 兜底文案与契约 meaning 不一致`; break
    }
    if (handling.retryable !== entry.retryable) {
      aligned = false; detail = `${entry.code} retryable 与契约不一致`; break
    }
  }
  check(`${label}兜底文案 = 契约 meaning、retryable = 契约`, aligned, detail)
}

// ───────────────────────── 级别 3：两端请求核心同输入实跑 ─────────────────────────

console.log('\n[级别 3] 请求核心同输入实跑比对')

function makeStorage() {
  const map = new Map()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  }
}

/** 两端用各自的常量与函数跑同一组输入，任何一步输出不同即失败。 */
async function exerciseCore(label, mods) {
  const results = {}
  const { core, session, behavior } = mods

  results.constants = [
    core.PENDING_STORAGE_KEY,
    core.DEFAULT_TIMEOUT_MS,
    core.REQUEST_ID_PREFIX,
    core.IDEMPOTENCY_HEADER,
  ]
  results.payloadHash = [
    core.payloadHash({ a: 1, b: 2 }),
    core.payloadHash({ b: 2, a: 1 }),
    core.payloadHash({ a: 1, b: 3 }),
    core.payloadHash({ lines: [{ sku: 'S-1', qty: 2 }], ref: 'A-1' }),
  ]
  results.pendingKeyOf = [core.pendingKeyOf('B13', 'p-1'), core.pendingKeyOf('B13', null)]
  results.isGatewayFailure = [502, 503, 504, 500, 404].map(core.isGatewayFailure)
  results.parseErrorBody = core.parseErrorBody(
    JSON.stringify({
      error: { code: 'VERSION_CONFLICT', message: 'm', currentVersion: 12, retryable: false, operationId: 'op-1', fieldErrors: { dueAt: 'x' } },
      meta: { requestId: 'r-9' },
    }),
  )
  results.parseErrorBodyEmpty = core.parseErrorBody('<html>Bad Gateway</html>')

  // 场景 A：写 → 超时 → 同载荷重试 → 两请求必须同 requestId；会话副作用与 pending 必须一致
  {
    const storage = makeStorage()
    const store = session.createSessionStore(storage)
    store.setToken('token-a')
    storage.setItem('pc-quote:v2:drafts', 'draft-1')
    const requests = []
    let counter = 0
    const client = core.createRequestCore({
      baseUrl: '/api/v2',
      transport: async (request) => {
        requests.push(JSON.parse(JSON.stringify(request)))
        if (requests.length === 1) throw new Error('timeout')
        return { status: 401, text: JSON.stringify({ error: { code: 'AUTH_REQUIRED' }, meta: {} }) }
      },
      session: store,
      behavior,
      currentTarget: () => '/today',
      newRequestId: () => `req_fixed_${String((counter += 1)).padStart(3, '0')}`,
      now: () => 1_760_000_000_000,
    })
    const first = await client.write('/sales/orders/o-1/payments', { action: 'B08', entityId: 'o-1', payload: { amountCents: 5000 } })
    const unknownSnapshot = storage.dump()
    const idAfterUnknown = client.pendingRequestId('B08', 'o-1')
    await client.write('/sales/orders/o-1/payments', { action: 'B08', entityId: 'o-1', payload: { amountCents: 5000 } })
    results.scenarioUnknownRetry = {
      firstOk: first.ok,
      firstUnknown: first.ok ? null : first.unknownResult,
      firstActions: first.ok ? null : [...first.actions],
      pendingDuringUnknown: unknownSnapshot[core.PENDING_STORAGE_KEY],
      idReused: Boolean(idAfterUnknown) && JSON.parse(requests[1].body).requestId === JSON.parse(requests[0].body).requestId,
      headerMatchesBody: requests[0].headers[core.IDEMPOTENCY_HEADER] === JSON.parse(requests[0].body).requestId,
      idempotencyHeaderName: core.IDEMPOTENCY_HEADER,
      // AUTH_REQUIRED 只清身份，保留草稿与待确认动作 —— 重新登录后可以继续刚才的动作。
      pendingKeptAfterAuth: typeof storage.getItem(core.PENDING_STORAGE_KEY) === 'string',
      tokenClearedAfterAuth: store.getToken() === null,
      draftsKeptAfterAuth: storage.getItem('pc-quote:v2:drafts') === 'draft-1',
      targetRecorded: store.peekTarget(),
    }
  }

  // 场景 B：先留下一个待确认动作，再被撤权 → 撤权连待确认动作一起清
  {
    const storage = makeStorage()
    const store = session.createSessionStore(storage)
    store.setToken('token-a')
    storage.setItem('pc-quote:v2:drafts', 'draft-1')
    let attempts = 0
    const client = core.createRequestCore({
      baseUrl: '/api/v2',
      transport: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('timeout')
        return { status: 401, text: JSON.stringify({ error: { code: 'SESSION_REVOKED' }, meta: {} }) }
      },
      session: store,
      behavior,
      currentTarget: () => '/today',
      newRequestId: () => 'req_fixed_b',
      now: () => 1_760_000_000_000,
    })
    await client.write('/sales/orders/o-1/payments', { action: 'B08', entityId: 'o-1', payload: { amountCents: 100 } })
    const pendingBeforeRevoke = typeof storage.getItem(core.PENDING_STORAGE_KEY) === 'string'
    await client.read('/me')
    results.scenarioRevoked = {
      pendingBeforeRevoke,
      tokenCleared: store.getToken() === null,
      draftsCleared: storage.getItem('pc-quote:v2:drafts') === null,
      pendingCleared: storage.getItem(core.PENDING_STORAGE_KEY) === null,
      targetRecorded: store.peekTarget(),
    }
  }

  // 场景 C：网关抖动不清会话
  {
    const storage = makeStorage()
    const store = session.createSessionStore(storage)
    store.setToken('token-a')
    const client = core.createRequestCore({
      baseUrl: '/api/v2',
      transport: async () => ({ status: 502, text: '<html>Bad Gateway</html>' }),
      session: store,
      behavior,
      currentTarget: () => '/today',
      newRequestId: () => 'req_fixed_c',
      now: () => 1_760_000_000_000,
    })
    const result = await client.write('/inventory/openings', { action: 'B13', payload: {} })
    results.scenarioGateway = {
      ok: result.ok,
      unknownResult: result.ok ? null : result.unknownResult,
      code: result.ok ? null : result.code,
      tokenKept: store.getToken() === 'token-a',
    }
  }

  return results
}

const webRun = await exerciseCore('网页端', { core: WEB.core, session: WEB.session, behavior: { decide: (c, o) => WEB.behavior.decideClientHandling(c, o), fallbackMessage: WEB.behavior.fallbackMessageFor, isRetryable: WEB.behavior.isRetryableCode } })
const mpRun = await exerciseCore('小程序端', { core: MP.core, session: MP.session, behavior: { decide: (c, o) => MP.behavior.decideClientHandling(c, o), fallbackMessage: MP.behavior.fallbackMessageFor, isRetryable: MP.behavior.isRetryableCode } })

check('两端常量一致（pending 键 / 超时 / requestId 前缀 / 幂等头）', deepEqual(webRun.constants, mpRun.constants, 'constants') === null)
check('载荷摘要同输入同输出', deepEqual(webRun.payloadHash, mpRun.payloadHash, 'payloadHash') === null)
check('pendingKeyOf 同输入同输出', deepEqual(webRun.pendingKeyOf, mpRun.pendingKeyOf, 'pendingKeyOf') === null)
check('isGatewayFailure 同输入同输出', deepEqual(webRun.isGatewayFailure, mpRun.isGatewayFailure, 'isGatewayFailure') === null)
check('错误体解析同输入同输出', deepEqual(webRun.parseErrorBody, mpRun.parseErrorBody, 'parseErrorBody') === null && deepEqual(webRun.parseErrorBodyEmpty, mpRun.parseErrorBodyEmpty, 'parseErrorBodyEmpty') === null)

console.log('\n[级别 3 · 场景实测断言]（两端各自跑，都须满足）')
for (const [label, run] of [['网页端', webRun], ['小程序端', mpRun]]) {
  const s = run.scenarioUnknownRetry
  check(`${label} · 结果未知后同载荷重试复用同一 requestId`, s.idReused)
  check(`${label} · Idempotency-Key 头与 body 相同`, s.headerMatchesBody)
  check(`${label} · 结果未知时 pending 保留`, Boolean(s.pendingDuringUnknown))
  check(`${label} · AUTH_REQUIRED 清 token、保留草稿与待确认动作、记录目标页`, s.tokenClearedAfterAuth && s.draftsKeptAfterAuth && s.pendingKeptAfterAuth && s.targetRecorded === '/today')
  const r = run.scenarioRevoked
  check(`${label} · SESSION_REVOKED 清 token、草稿与待确认动作、记录目标页`, r.tokenCleared && r.draftsCleared && r.pendingCleared && r.targetRecorded === '/today')
  const g = run.scenarioGateway
  check(`${label} · 网关 502 归入结果未知且不清会话`, g.unknownResult === true && g.code === null && g.tokenKept)
}

console.log('\n[级别 3 · 两端实跑输出互比]')
check('场景 A（未知→重试）两端可观察输出一致', deepEqual(webRun.scenarioUnknownRetry, mpRun.scenarioUnknownRetry, 'scenarioUnknownRetry') === null)
check('场景 B（撤权）两端可观察输出一致', deepEqual(webRun.scenarioRevoked, mpRun.scenarioRevoked, 'scenarioRevoked') === null)
check('场景 C（网关）两端可观察输出一致', deepEqual(webRun.scenarioGateway, mpRun.scenarioGateway, 'scenarioGateway') === null)

// ───────────────────────── 结论 ─────────────────────────

if (failures.length) {
  console.error(`\n✗ 跨端一致性检查未通过：${failures.length} 项\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('\n✓ 跨端一致性检查通过：两端行为表、常量、请求核心实跑输出逐项一致，且与契约 errors.json 对齐。')
