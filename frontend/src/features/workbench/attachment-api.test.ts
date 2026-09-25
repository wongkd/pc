import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAttachmentUploadSession, uploadBusinessAttachment } from './attachment-api'

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
const testFile = { size: 8, type: 'image/png' } as File

afterEach(() => vi.unstubAllGlobals())

describe('attachment upload retry', () => {
  it('intent response lost: retries with the same requestId and reuses the created intent', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (calls.length === 1) throw new Error('connection reset after server accepted request')
      if (url.endsWith('/upload-intents')) return ok({ entityId: 'attachment-1', uploadPath: '/blob/1', uploadToken: 'token-1' })
      if (url === '/blob/1') return ok({ state: 'uploaded' })
      return ok({ entityId: 'attachment-1', uploadState: 'attached' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const session = createAttachmentUploadSession(testFile, 'stock_item', 'item-1')
    await expect(uploadBusinessAttachment(session)).rejects.toThrow('结果未知')
    const attachment = await uploadBusinessAttachment(session)

    const firstIntent = JSON.parse(String(calls[0]?.init?.body)) as { requestId: string }
    const retriedIntent = JSON.parse(String(calls[1]?.init?.body)) as { requestId: string }
    expect(retriedIntent.requestId).toBe(firstIntent.requestId)
    expect(attachment.id).toBe('attachment-1')
    expect(calls.filter((call) => call.url.endsWith('/upload-intents'))).toHaveLength(2)
    expect(calls.filter((call) => call.url === '/blob/1')).toHaveLength(1)
  })

  it('completion response lost: retries the same completion and does not rewrite attached bytes', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/upload-intents')) return ok({ entityId: 'attachment-2', uploadPath: '/blob/2', uploadToken: 'token-2' })
      if (url === '/blob/2') return ok({ state: 'uploaded' })
      if (calls.filter((call) => call.url.endsWith('/complete')).length === 1) {
        throw new Error('connection reset after attachment was linked')
      }
      return ok({ entityId: 'attachment-2', uploadState: 'attached' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const session = createAttachmentUploadSession(testFile, 'stock_item', 'item-2')
    await expect(uploadBusinessAttachment(session)).rejects.toThrow('结果未知')
    const attachment = await uploadBusinessAttachment(session)

    const completions = calls.filter((call) => call.url.endsWith('/complete'))
    const first = JSON.parse(String(completions[0]?.init?.body)) as { requestId: string }
    const retry = JSON.parse(String(completions[1]?.init?.body)) as { requestId: string }
    expect(retry.requestId).toBe(first.requestId)
    expect(attachment.id).toBe('attachment-2')
    expect(calls.filter((call) => call.url === '/blob/2')).toHaveLength(1)
  })
})
