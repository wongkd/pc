import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceptInvitation, createProduct, fetchProductCategories, fetchProducts, fetchProfile, selectStore, updateProductStatus } from './api'
import { has } from '../components/SystemSettingsPage'

const createStorage = () => {
  const store = new Map<string, string>()
  return { getItem: vi.fn((key: string) => store.get(key) ?? null), setItem: vi.fn((key: string, value: string) => store.set(key, value)), removeItem: vi.fn((key: string) => store.delete(key)) }
}
const success = (data: unknown) => ({ ok: true, status: 200, json: async () => data })

describe('api utils', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('throws backend errors for non-2xx responses', async () => {
    vi.stubGlobal('localStorage', createStorage())
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: '无权访问' }) })))
    await expect(fetchProfile()).rejects.toThrow('无权访问')
  })

  it('stores the replacement token after selecting a store', async () => {
    const storage = createStorage()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('fetch', vi.fn(async () => success({ ok: true, token: 'new-store-token', storeId: 2 })))
    await expect(selectStore(2)).resolves.toMatchObject({ storeId: 2 })
    expect(storage.setItem).toHaveBeenCalledWith('pc-auth-token', 'new-store-token')
  })

  it('submits invitation token and initial password', async () => {
    const fetchMock = vi.fn(async () => success({ ok: true, token: 'invite-token' }))
    vi.stubGlobal('localStorage', createStorage())
    vi.stubGlobal('fetch', fetchMock)
    await expect(acceptInvitation('one-time-code', 'initial-password')).resolves.toMatchObject({ token: 'invite-token' })
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/accept-invitation', expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: 'one-time-code', password: 'initial-password' }) }))
  })

  it('treats wildcard permission as full access', () => {
    expect(has(['*'], 'member/manage')).toBe(true)
    expect(has(['quote/view'], 'member/manage')).toBe(false)
  })

  it('uses snake_case query and payload fields for product APIs', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<ReturnType<typeof success>>>(async () => success({ items: [], total: 0, page: 1, page_size: 20 }))
    vi.stubGlobal('localStorage', createStorage())
    vi.stubGlobal('fetch', fetchMock)
    await fetchProducts({ categoryId: 3, pageSize: 20, status: 'active' })
    await createProduct({ sku: 'GPU-01', name: '显卡', categoryId: 3, itemType: 'product', defaultPriceCents: 199900, referencePriceCents: 209900, minPriceCents: 189900, isSerialized: 1, isSalable: 1, isPurchasable: 1, safetyStockQty: 2 })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('categoryId=3')
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('pageSize=20')
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toMatchObject({ categoryId: 3, itemType: 'product', defaultPriceCents: 199900, isSerialized: 1 })
  })

  it('uses product status endpoint and surfaces product API errors', async () => {
    vi.stubGlobal('localStorage', createStorage())
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ error: 'SKU 已存在' }) })))
    await expect(updateProductStatus(5, 'disabled')).rejects.toThrow('SKU 已存在')
    await expect(fetchProductCategories()).rejects.toThrow('SKU 已存在')
  })

})
