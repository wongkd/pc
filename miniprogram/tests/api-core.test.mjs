/**
 * T03b · 请求核心测试（小程序端，与网页端 core.test.ts 同一组用例的关键子集）。
 *
 * 最重要的两条（这两条错了会真的丢钱）：
 *   1. 结果未知时**保留**待确认动作，重试**复用同一个 requestId** —— 否则重试就是重复扣款。
 *   2. 超时 / 网关错误是「结果未知」，**不是失败**。
 *
 * 端内差异（wx.request、wx 存储）属装配层，本文件不测；
 * 两端核心行为的一致性由 `node contracts/tools/check-client-parity.mjs` 用同一组输入实测。
 *
 * 运行：node --test tests/api-core.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_TIMEOUT_MS,
  IDEMPOTENCY_HEADER,
  PENDING_STORAGE_KEY,
  REQUEST_ID_PREFIX,
  createRequestCore,
  defaultRequestId,
  isGatewayFailure,
  payloadHash,
  pendingKeyOf,
  stableStringify,
} from '../features/api-core.ts'
import { decideClientHandling, fallbackMessageFor, isRetryableCode } from '../features/error-behavior.ts'
import { createSessionStore } from '../features/session.ts'

function createStorage() {
  const map = new Map()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    dump: () => Object.fromEntries(map),
  }
}

function setup(respond) {
  const storage = createStorage()
  const session = createSessionStore(storage)
  let counter = 0
  const requests = []
  const transport = async (request) => {
    requests.push(request)
    return respond(request)
  }
  const client = createRequestCore({
    baseUrl: '/api/v2',
    transport,
    session,
    behavior: {
      decide: (code, opts) => decideClientHandling(code, opts),
      fallbackMessage: fallbackMessageFor,
      isRetryable: isRetryableCode,
    },
    currentTarget: () => '/pages/shop/index?category=used',
    newRequestId: () => `req_test_${String((counter += 1)).padStart(3, '0')}`,
    now: () => 1_760_000_000_000,
  })
  return { storage, session, requests, client }
}

const okBody = (data) => JSON.stringify({ data, meta: { requestId: 'server-1' } })
const errorBody = (code, extra = {}) =>
  JSON.stringify({ error: { code, message: `服务端说：${code}`, ...extra }, meta: { requestId: 'server-9' } })

test('载荷摘要：键顺序无关、数组顺序有语义、undefined 被忽略', () => {
  assert.equal(payloadHash({ a: 1, b: 2 }), payloadHash({ b: 2, a: 1 }))
  assert.notEqual(payloadHash({ a: 1, b: 2 }), payloadHash({ a: 1, b: 3 }))
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]))
  assert.equal(payloadHash({ a: 1, b: undefined }), payloadHash({ a: 1 }))
})

test('requestId 带统一前缀且不重复；常量与网页端一致（门禁另行实测）', () => {
  const ids = new Set([defaultRequestId(), defaultRequestId(), defaultRequestId()])
  assert.equal(ids.size, 3)
  for (const id of ids) assert.ok(id.startsWith(REQUEST_ID_PREFIX))
  assert.equal(DEFAULT_TIMEOUT_MS, 15000)
  assert.equal(PENDING_STORAGE_KEY, 'pc-quote:v2:pending-actions')
  assert.equal(IDEMPOTENCY_HEADER, 'Idempotency-Key')
  assert.equal(isGatewayFailure(502), true)
  assert.equal(isGatewayFailure(503), true)
  assert.equal(isGatewayFailure(504), true)
  assert.equal(isGatewayFailure(500), false)
})

test('写动作：body 与 Idempotency-Key 是同一个 requestId', async () => {
  const { requests, client } = setup(async () => ({ status: 200, text: okBody({ ok: true }) }))
  await client.write('/inventory/openings', {
    action: 'B13',
    payload: { approvedCountRef: 'A-1', lines: [] },
  })
  const body = JSON.parse(requests[0].body)
  assert.ok(body.requestId)
  assert.equal(requests[0].headers[IDEMPOTENCY_HEADER], body.requestId)
})

test('结果未知后重试 → 仍是同一个 requestId（这一条防的是重复扣款）', async () => {
  let attempt = 0
  const { requests, client } = setup(async () => {
    attempt += 1
    if (attempt === 1) throw new Error('timeout')
    return { status: 200, text: okBody({ ok: true }) }
  })
  const first = await client.write('/sales/orders/o-1/payments', {
    action: 'B08',
    entityId: 'o-1',
    payload: { amountCents: 5000 },
  })
  assert.equal(first.ok, false)
  assert.equal(first.unknownResult, true)
  assert.ok(client.pendingRequestId('B08', 'o-1'))

  await client.write('/sales/orders/o-1/payments', {
    action: 'B08',
    entityId: 'o-1',
    payload: { amountCents: 5000 },
  })
  const id1 = JSON.parse(requests[0].body).requestId
  const id2 = JSON.parse(requests[1].body).requestId
  assert.equal(id2, id1)
})

test('载荷变了 → 换新 requestId（不然服务端会判 IDEMPOTENCY_MISMATCH）', async () => {
  const { requests, client } = setup(async () => ({ status: 503, text: null }))
  await client.write('/sales/orders/o-1/payments', { action: 'B08', entityId: 'o-1', payload: { amountCents: 5000 } })
  await client.write('/sales/orders/o-1/payments', { action: 'B08', entityId: 'o-1', payload: { amountCents: 8000 } })
  const id1 = JSON.parse(requests[0].body).requestId
  const id2 = JSON.parse(requests[1].body).requestId
  assert.notEqual(id2, id1)
})

test('成功后才清除待确认动作；结果未知时保留（含载荷摘要与创建时间）', async () => {
  const { storage, client } = setup(async () => {
    throw new Error('network down')
  })
  await client.write('/inventory/products', { action: 'B12', entityId: 'p-9', payload: { sku: 'S-1' } })
  const raw = storage.getItem(PENDING_STORAGE_KEY)
  assert.ok(raw)
  const map = JSON.parse(raw)
  const entry = map[pendingKeyOf('B12', 'p-9')]
  assert.ok(entry.requestId.startsWith('req_'))
  assert.equal(entry.hash, payloadHash({ sku: 'S-1' }))
  assert.equal(entry.createdAt, 1_760_000_000_000)

  client.clearPendingActions()
  assert.equal(client.pendingActionCount(), 0)
})

test('expectedVersion 只在实际给出时进入 body', async () => {
  const { requests, client } = setup(async () => ({ status: 200, text: okBody({ ok: true }) }))
  await client.write('/inventory/products', { action: 'B12', payload: { sku: 'A' } })
  await client.write('/inventory/products', { action: 'B12', payload: { sku: 'B' }, expectedVersion: 7 })
  assert.ok(!('expectedVersion' in JSON.parse(requests[0].body)))
  assert.equal(JSON.parse(requests[1].body).expectedVersion, 7)
})

test('传输层超时 → unknownResult 为真、没有 code、写动作去查 operation', async () => {
  const { client } = setup(async () => {
    throw new Error('AbortError')
  })
  const result = await client.write('/sales/orders/o-1/payments', {
    action: 'B08',
    entityId: 'o-1',
    payload: { amountCents: 100 },
  })
  assert.equal(result.ok, false)
  assert.equal(result.unknownResult, true)
  assert.equal(result.code, null)
  assert.ok(result.actions.includes('query-operation'))
  assert.equal(result.message, '操作结果待确认')
})

test('读动作超时 → 可以等待后重试，不去查 operation', async () => {
  const { client } = setup(async () => {
    throw new Error('AbortError')
  })
  const result = await client.read('/inventory')
  assert.equal(result.ok, false)
  assert.equal(result.unknownResult, true)
  assert.ok(result.actions.includes('wait-and-retry'))
  assert.ok(!result.actions.includes('query-operation'))
})

test('5xx 无契约错误体（网关抖）→ 结果未知，且不动本地会话', async () => {
  const storage = createStorage()
  const session = createSessionStore(storage)
  session.setToken('token-abc')
  let counter = 0
  const client = createRequestCore({
    baseUrl: '/api/v2',
    transport: async () => ({ status: 502, text: '<html>Bad Gateway</html>' }),
    session,
    behavior: {
      decide: (code, opts) => decideClientHandling(code, opts),
      fallbackMessage: fallbackMessageFor,
      isRetryable: isRetryableCode,
    },
    currentTarget: () => '/pages/today/index',
    newRequestId: () => `req_test_${(counter += 1)}`,
    now: () => 1_760_000_000_000,
  })
  const result = await client.write('/inventory/openings', { action: 'B13', payload: {} })
  assert.equal(result.ok, false)
  assert.equal(result.unknownResult, true)
  assert.equal(session.getToken(), 'token-abc')
  assert.equal(session.peekTarget(), null)
})

test('4xx 有契约错误码 → 明确失败；服务端 message 优先于契约兜底文案', async () => {
  const { client } = setup(async () => ({
    status: 409,
    text: errorBody('VERSION_CONFLICT', { currentVersion: 12 }),
  }))
  const result = await client.write('/inventory/products', { action: 'B12', payload: {} })
  assert.equal(result.ok, false)
  assert.equal(result.unknownResult, false)
  assert.equal(result.code, 'VERSION_CONFLICT')
  assert.equal(result.message, '服务端说：VERSION_CONFLICT')
  assert.equal(result.currentVersion, 12)
  assert.ok(result.actions.includes('reload-entity'))
})

test('AUTH_REQUIRED：清 token、记住原目标页，但保留草稿', async () => {
  const { storage, session, client } = setup(async () => ({ status: 401, text: errorBody('AUTH_REQUIRED') }))
  session.setToken('token-abc')
  storage.setItem('pc-quote:v2:drafts', 'draft-1')

  const result = await client.read('/me')
  assert.equal(result.ok, false)
  assert.equal(session.getToken(), null)
  assert.equal(storage.getItem('pc-quote:v2:drafts'), 'draft-1')
  assert.equal(session.peekTarget(), '/pages/shop/index?category=used')
})

test('SESSION_REVOKED：撤权后连草稿与待确认动作一起清（03 §8 L194）', async () => {
  let attempts = 0
  const { storage, session, client } = setup(async () => {
    attempts += 1
    if (attempts === 1) throw new Error('timeout') // 先留一个 pending
    return { status: 401, text: errorBody('SESSION_REVOKED') }
  })
  session.setToken('token-abc')
  storage.setItem('pc-quote:v2:drafts', 'draft-1')
  await client.write('/sales/orders/o-1/payments', { action: 'B08', entityId: 'o-1', payload: { amountCents: 100 } })
  assert.equal(client.pendingActionCount(), 1)

  await client.read('/me')
  assert.equal(session.getToken(), null)
  assert.equal(storage.getItem('pc-quote:v2:drafts'), null)
  assert.equal(client.pendingActionCount(), 0)
  assert.equal(session.peekTarget(), '/pages/shop/index?category=used')
})

test('403 不动会话：无权限是用户的事，不是登录失效', async () => {
  const { session, client } = setup(async () => ({ status: 403, text: errorBody('PERMISSION_DENIED') }))
  session.setToken('token-abc')
  await client.write('/inventory/openings', { action: 'B13', payload: {} })
  assert.equal(session.getToken(), 'token-abc')
  assert.equal(session.peekTarget(), null)
})

test('结果查询：以原 requestId 查，读到 succeeded；查询失败如实返回 unknown', async () => {
  const { requests, client } = setup(async () => ({
    status: 200,
    text: okBody({ status: 'succeeded', resultRef: 'op-1' }),
  }))
  const result = await client.queryOperation('req_x_001')
  assert.equal(result.ok, true)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.resultRef, 'op-1')
  assert.equal(requests[0].url, '/api/v2/operations/req_x_001')

  const failing = setup(async () => {
    throw new Error('offline')
  })
  const bad = await failing.client.queryOperation('req_x_002')
  assert.equal(bad.ok, false)
  assert.equal(bad.status, 'unknown')
})

test('读动作拼 query 并跳过空值；成功时直接给出 data', async () => {
  const { requests, client } = setup(async () => ({ status: 200, text: okBody({ items: [{ id: '1' }] }) }))
  await client.read('/inventory', { params: { q: '显卡', cursor: null, limit: 20, empty: '' } })
  assert.equal(requests[0].url, '/api/v2/inventory?q=%E6%98%BE%E5%8D%A1&limit=20')

  const result = await client.read('/inventory')
  assert.equal(result.ok, true)
  assert.equal(result.data.items[0].id, '1')
  assert.equal(result.meta.requestId, 'server-1')
})
