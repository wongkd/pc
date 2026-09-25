// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AttachmentPanel } from './AttachmentPanel'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AttachmentPanel upload retry', () => {
  it('shows a retry action after a network-unknown result and completes the same upload', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (calls.length === 1) throw new Error('connection reset after intent creation')
      if (url.endsWith('/attachments/upload-intents')) {
        return new Response(JSON.stringify({ data: {
          entityId: 'retry-attachment',
          uploadPath: '/api/v2/attachments/upload-intents/retry-attachment/blob',
          uploadToken: 'upload-token',
        } }), { status: 200 })
      }
      if (url.endsWith('/blob')) return new Response(JSON.stringify({ data: { state: 'uploaded' } }), { status: 200 })
      return new Response(JSON.stringify({ data: { entityId: 'retry-attachment', state: 'attached' } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onUploaded = vi.fn()
    const file = new File(['png'], 'proof.png', { type: 'image/png' })

    const { container } = render(<AttachmentPanel attachments={[]} ownerType="stock_item" ownerId="item-1" canUpload onUploaded={onUploaded} />)
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } })

    const retry = await screen.findByRole('button', { name: '重试当前上传' })
    expect(screen.getByText(/结果未知/)).toBeTruthy()
    fireEvent.click(retry)

    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1))
    expect(onUploaded.mock.calls[0]?.[0]).toMatchObject({ id: 'retry-attachment', uploadState: 'attached' })
    expect(calls.filter((url) => url.endsWith('/attachments/upload-intents'))).toHaveLength(2)
    expect(calls.filter((url) => url.endsWith('/blob'))).toHaveLength(1)
    expect(calls.filter((url) => url.endsWith('/complete'))).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '重试当前上传' })).toBeNull()
  })
})
