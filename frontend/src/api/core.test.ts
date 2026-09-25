/**
 * T03b · 请求核心测试（网页端）。
 *
 * 最重要的两条（这两条错了会真的丢钱）：
 *   1. 结果未知时**保留**待确认动作，重试**复用同一个 requestId** —— 否则重试就是重复扣款。
 *   2. 超时 / 网关错误是「结果未知」，**不是失败** —— 不能让调用方当失败处理。
 */

import { describe, expect, it, vi } from 'vitest'

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
} from './core'
import type { Transport, TransportRequest } from './core'
import { decideClientHandling, fallbackMessageFor, isRetryableCode } from './error-behavior'
import { createSessionStore } from './session'
import type { KeyValueStorage } from './session'

function createStorage(): KeyValueStorage & { dump: () => Record<string, string> } {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    dump: () => Object.fromEntries(map),
  }
}

function setup(respond: (request: TransportRequest) => Promise<{ status: number; text: string | null }>) {
  const storage = createStorage()
  const session = createSessionStore(storage)
  // 保留 vi.fn 的完整类型（.mock 可访问），仅在接入 client 时收窄成 Transport。
  const transport = vi.fn(respond)
  let counter = 0
  const client = createRequestCore({
    baseUrl: '/api/v2',
    transport: transport as unknown as Transport,
    session,
    behavior: {
      decide: (code, { isWrite }) => decideClientHandling(code, { isWrite }),
      fallbackMessage: fallbackMessageFor,
      isRetryable: isRetryableCode,
    },
    currentTarget: () => '/inventory?tab=used',
    newRequestId: () => `req_test_${String((counter += 1)).padStart(3, '0')}`,
    now: () => 1_760_000_000_000,
  })
  return { storage, session, transport, client }
}

const okBody = (data: unknown) => JSON.stringify({ data, meta: { requestId: 'server-1' } })
const errorBody = (code: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ error: { code, message: `服务端说：${code}`, ...extra }, meta: { requestId: 'server-9' } })

describe('载荷摘要与 requestId 格式', () => {
  it('键顺序不同但内容相同 → 同一个摘要（否则重试会被误判成载荷变了）', () => {
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }))
    expect(payloadHash({ a: 1, b: 2 })).not.toBe(payloadHash({ a: 1, b: 3 }))
  })

  it('数组顺序有语义，不排序', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]))
  })

  it('undefined 字段被忽略，不制造假差异', () => {
    expect(payloadHash({ a: 1, b: undefined })).toBe(payloadHash({ a: 1 }))
  })

  it('requestId 带统一前缀且不重复', () => {
    const ids = new Set([defaultRequestId(), defaultRequestId(), defaultRequestId()])
    expect(ids.size).toBe(3)
    for (const id of ids) expect(id.startsWith(REQUEST_ID_PREFIX)).toBe(true)
  })

  it('网关类状态码被识别为结果未知', () => {
    expect(isGatewayFailure(502)).toBe(true)
    expect(isGatewayFailure(503)).toBe(true)
    expect(isGatewayFailure(504)).toBe(true)
    expect(isGatewayFailure(500)).toBe(false)
  })
})

describe('写动作 · 幂等键', () => {
  it('body 与 Idempotency-Key 是同一个 requestId（契约要求两处相同）', async () => {
    const { transport, client } = setup(async () => ({ status: 200, text: okBody({ ok: true }) }))
    await client.write('/inventory/openings', {
      action: 'B13',
      payload: { approvedCountRef: 'A-1', lines: [] },
    })
    const sent = transport.mock.calls[0]?.[0] as TransportRequest
    const body = JSON.parse(sent.body ?? '{}') as { requestId?: string }
    expect(body.requestId).toBeTruthy()
    expect(sent.headers[IDEMPOTENCY_HEADER]).toBe(body.requestId)
  })

  it('成功清除待确认动作后，同一动作再次提交是新的一次（不会误复用旧 ID）', async () => {
    // 设计意图：requestId 复用只为「结果未知后的重试」服务。
    // 响应确定成功就清除，用户再点一次是**新的**收款 ——
    // 防重复收款由服务端的余额约束（BALANCE_EXCEEDED）与界面提交锁负责，
    // 不能靠客户端一直复用旧 ID，否则用户真的收第二笔会被当成第一笔。
    const { transport, client } = setup(async () => ({ status: 200, text: okBody({ ok: true }) }))
    await client.write('/inventory/openings', { action: 'B13', entityId: 'p-1', payload: { qty: 2 } })
    await client.write('/inventory/openings', { action: 'B13', entityId: 'p-1', payload: { qty: 2 } })
    const id1 = (JSON.parse((transport.mock.calls[0]?.[0] as TransportRequest).body ?? '{}') as { requestId: string }).requestId
    const id2 = (JSON.parse((transport.mock.calls[1]?.[0] as TransportRequest).body ?? '{}') as { requestId: string }).requestId
    expect(id2).not.toBe(id1)
  })

  it('结果未知后重试 → 仍是同一个 requestId（这一条防的是重复扣款）', async () => {
    let attempt = 0
    const { transport, client } = setup(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('timeout')
      return { status: 200, text: okBody({ ok: true }) }
    })
    const first = await client.write('/sales/orders/o-1/payments', {
      action: 'B08',
      entityId: 'o-1',
      payload: { amountCents: 5000 },
    })
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.unknownResult).toBe(true)
    const idAfterUnknown = client.pendingRequestId('B08', 'o-1')
    expect(idAfterUnknown).toBeTruthy()

    await client.write('/sales/orders/o-1/payments', {
      action: 'B08',
      entityId: 'o-1',
      payload: { amountCents: 5000 },
    })
    const firstSent = transport.mock.calls[0]?.[0] as TransportRequest
    const secondSent = transport.mock.calls[1]?.[0] as TransportRequest
    const id1 = (JSON.parse(firstSent.body ?? '{}') as { requestId: string }).requestId
    const id2 = (JSON.parse(secondSent.body ?? '{}') as { requestId: string }).requestId
    expect(id2).toBe(id1)
  })

  it('查询到终态后只清除对应请求，不影响其他未知动作', async () => {
    const { client } = setup(async () => { throw new Error('timeout') })
    await client.write('/inventory/products', { action: 'B12', entityId: 'p-1', payload: { name: '一号' } })
    await client.write('/inventory/products', { action: 'B12', entityId: 'p-2', payload: { name: '二号' } })
    const first = client.pendingRequestId('B12', 'p-1')
    const second = client.pendingRequestId('B12', 'p-2')
    expect(client.pendingActionCount()).toBe(2)
    expect(first).toBeTruthy()
    expect(second).toBeTruthy()

    client.resolvePendingAction(first as string)

    expect(client.pendingActionCount()).toBe(1)
    expect(client.pendingRequestId('B12', 'p-1')).toBeNull()
    expect(client.pendingRequestId('B12', 'p-2')).toBe(second)
  })

  it('载荷变了 → 换新 requestId（不然服务端会判 IDEMPOTENCY_MISMATCH）', async () => {
    const { transport, client } = setup(async () => ({ status: 503, text: null }))
    await client.write('/sales/orders/o-1/payments', { action: 'B08', entityId: 'o-1', payload: { amountCents: 5000 } })
    await client.write('/sales/orders/o-1/payments', { action: 'B08', entityId: 'o-1', payload: { amountCents: 8000 } })
    const id1 = (JSON.parse((transport.mock.calls[0]?.[0] as TransportRequest).body ?? '{}') as { requestId: string }).requestId
    const id2 = (JSON.parse((transport.mock.calls[1]?.[0] as TransportRequest).body ?? '{}') as { requestId: string }).requestId
    expect(id2).not.toBe(id1)
  })

  it('成功后才清除待确认动作', async () => {
    const { storage, client } = setup(async () => ({ status: 200, text: okBody({ ok: true }) }))
    await client.write('/inventory/products', { action: 'B12', payload: { sku: 'S-1' } })
    expect(storage.getItem(PENDING_STORAGE_KEY)).toBeNull()
    expect(client.pendingActionCount()).toBe(0)
  })

  it('结果未知时保留待确认动作，并带上载荷摘要与创建时间', async () => {
    const { storage, client } = setup(async () => {
      throw new Error('network down')
    })
    await client.write('/inventory/products', { action: 'B12', entityId: 'p-9', payload: { sku: 'S-1' } })
    const raw = storage.getItem(PENDING_STORAGE_KEY)
    expect(raw).toBeTruthy()
    const map = JSON.parse(raw ?? '{}') as Record<string, { requestId: string; hash: string; createdAt: number }>
    const entry = map[pendingKeyOf('B12', 'p-9')]
    expect(entry.requestId).toMatch(/^req_/)
    expect(entry.hash).toBe(payloadHash({ sku: 'S-1' }))
    expect(entry.createdAt).toBe(1_760_000_000_000)
  })

  it('expectedVersion 只在实际给出时进入 body', async () => {
    const { transport, client } = setup(async () => ({ status: 200, text: okBody({ ok: true }) }))
    await client.write('/inventory/products', { action: 'B12', payload: { sku: 'A' } })
    await client.write('/inventory/products', {
      action: 'B12',
      payload: { sku: 'B' },
      expectedVersion: 7,
    })
    const without = JSON.parse((transport.mock.calls[0]?.[0] as TransportRequest).body ?? '{}') as Record<string, unknown>
    const withVersion = JSON.parse((transport.mock.calls[1]?.[0] as TransportRequest).body ?? '{}') as Record<string, unknown>
    expect('expectedVersion' in without).toBe(false)
    expect(withVersion.expectedVersion).toBe(7)
  })

  it('默认超时为 15 秒，且被传到传输层', async () => {
    const { transport, client } = setup(async () => ({ status: 200, text: okBody({ ok: true }) }))
    await client.read('/me')
    expect((transport.mock.calls[0]?.[0] as TransportRequest).timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
  })
})

describe('结果未知 ≠ 失败', () => {
  it('传输层超时 → unknownResult 为真、没有 code、写动作去查 operation', async () => {
    const { client } = setup(async () => {
      throw new Error('AbortError')
    })
    const result = await client.write('/sales/orders/o-1/payments', {
      action: 'B08',
      entityId: 'o-1',
      payload: { amountCents: 100 },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.unknownResult).toBe(true)
    expect(result.code).toBeNull()
    expect(result.actions).toContain('query-operation')
    expect(result.message).toBe('操作结果待确认')
  })

  it('读动作超时 → 可以等待后重试，不去查 operation', async () => {
    const { client } = setup(async () => {
      throw new Error('AbortError')
    })
    const result = await client.read('/inventory')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.unknownResult).toBe(true)
    expect(result.actions).toContain('wait-and-retry')
    expect(result.actions).not.toContain('query-operation')
  })

  it('5xx 无契约错误体（网关抖）→ 结果未知，且**不动本地会话**', async () => {
    const storage = createStorage()
    const session = createSessionStore(storage)
    session.setToken('token-abc')
    const client = createRequestCore({
      baseUrl: '/api/v2',
      transport: async () => ({ status: 502, text: '<html>Bad Gateway</html>' }),
      session,
      behavior: {
        decide: (code, { isWrite }) => decideClientHandling(code, { isWrite }),
        fallbackMessage: fallbackMessageFor,
        isRetryable: isRetryableCode,
      },
      currentTarget: () => '/today',
    })
    const result = await client.write('/inventory/openings', { action: 'B13', payload: {} })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.unknownResult).toBe(true)
    expect(session.getToken()).toBe('token-abc')
    expect(session.peekTarget()).toBeNull()
  })

  it('4xx 有契约错误码 → 是明确失败，不是结果未知', async () => {
    const { client } = setup(async () => ({ status: 400, text: errorBody('VALIDATION_ERROR') }))
    const result = await client.write('/inventory/openings', { action: 'B13', payload: {} })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.unknownResult).toBe(false)
    expect(result.code).toBe('VALIDATION_ERROR')
    expect(result.actions).toContain('keep-input')
  })

  it('服务端 message 优先于契约兜底文案', async () => {
    const { client } = setup(async () => ({
      status: 409,
      text: errorBody('VERSION_CONFLICT', { currentVersion: 12 }),
    }))
    const result = await client.write('/inventory/products', { action: 'B12', payload: {} })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toBe('服务端说：VERSION_CONFLICT')
    expect(result.currentVersion).toBe(12)
    expect(result.actions).toContain('reload-entity')
  })

  it('服务端没给 message 时用契约兜底文案', async () => {
    const { client } = setup(async () => ({
      status: 403,
      text: JSON.stringify({ error: { code: 'PERMISSION_DENIED' } }),
    }))
    const result = await client.write('/inventory/openings', { action: 'B13', payload: {} })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toBe('无该动作权限')
  })
})

describe('登录失效的副作用', () => {
  it('AUTH_REQUIRED：清 token、记住原目标页，但保留草稿', async () => {
    const { storage, session, client } = setup(async () => ({ status: 401, text: errorBody('AUTH_REQUIRED') }))
    session.setToken('token-abc')
    storage.setItem('pc-quote:v2:drafts', 'draft-1')

    const result = await client.read('/me')
    expect(result.ok).toBe(false)
    expect(session.getToken()).toBeNull()
    expect(storage.getItem('pc-quote:v2:drafts')).toBe('draft-1')
    expect(session.peekTarget()).toBe('/inventory?tab=used')
  })

  it('SESSION_REVOKED：撤权后连草稿与待确认动作一起清（03 §8 L194）', async () => {
    let attempts = 0
    const { storage, session, client } = setup(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('timeout') // 先留一个 pending
      return { status: 401, text: errorBody('SESSION_REVOKED') }
    })
    session.setToken('token-abc')
    storage.setItem('pc-quote:v2:drafts', 'draft-1')
    await client.write('/sales/orders/o-1/payments', { action: 'B08', entityId: 'o-1', payload: { amountCents: 100 } })
    expect(client.pendingActionCount()).toBe(1)

    await client.read('/me')
    expect(session.getToken()).toBeNull()
    expect(storage.getItem('pc-quote:v2:drafts')).toBeNull()
    expect(client.pendingActionCount()).toBe(0)
    expect(session.peekTarget()).toBe('/inventory?tab=used')
  })

  it('403 不动会话：无权限是用户的事，不是登录失效', async () => {
    const { session, client } = setup(async () => ({ status: 403, text: errorBody('PERMISSION_DENIED') }))
    session.setToken('token-abc')
    await client.write('/inventory/openings', { action: 'B13', payload: {} })
    expect(session.getToken()).toBe('token-abc')
    expect(session.peekTarget()).toBeNull()
  })
})

describe('结果查询', () => {
  it('以原 requestId 查询，读到 pending / succeeded / failed', async () => {
    const { transport, client } = setup(async () => ({
      status: 200,
      text: okBody({ status: 'succeeded', resultRef: 'op-1' }),
    }))
    const result = await client.queryOperation('req_x_001')
    expect(result.ok).toBe(true)
    expect(result.status).toBe('succeeded')
    expect(result.resultRef).toBe('op-1')
    const url = (transport.mock.calls[0]?.[0] as TransportRequest).url
    expect(url).toBe('/api/v2/operations/req_x_001')
  })

  it('查询本身失败 → status 为 unknown，不假装知道了结果', async () => {
    const { client } = setup(async () => {
      throw new Error('offline')
    })
    const result = await client.queryOperation('req_x_002')
    expect(result.ok).toBe(false)
    expect(result.status).toBe('unknown')
  })

  it('清空待确认动作（登出 / 撤权后调用）', async () => {
    const { client } = setup(async () => {
      throw new Error('offline')
    })
    await client.write('/inventory/products', { action: 'B12', payload: { sku: 'A' } })
    expect(client.pendingActionCount()).toBe(1)
    client.clearPendingActions()
    expect(client.pendingActionCount()).toBe(0)
  })
})

describe('读动作', () => {
  it('拼 query 并跳过空值', async () => {
    const { transport, client } = setup(async () => ({ status: 200, text: okBody({ items: [] }) }))
    await client.read('/inventory', { params: { q: '显卡', cursor: null, limit: 20, empty: '' } })
    expect((transport.mock.calls[0]?.[0] as TransportRequest).url).toBe('/api/v2/inventory?q=%E6%98%BE%E5%8D%A1&limit=20')
  })

  it('成功时直接给出 data，不必再剥一层', async () => {
    const { client } = setup(async () => ({ status: 200, text: okBody({ items: [{ id: '1' }] }) }))
    const result = await client.read<{ items: Array<{ id: string }> }>('/inventory')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.items[0]?.id).toBe('1')
    expect(result.meta.requestId).toBe('server-1')
  })
})
