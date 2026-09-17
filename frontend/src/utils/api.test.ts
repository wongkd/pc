import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceptInvitation, addLibraryItems, createProduct, fetchLibrary, fetchProductCategories, fetchProducts, fetchProfile, normalizeTitles, selectStore, updateLibraryItem, updateProductStatus } from './api'
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

  it('throws normalize error instead of returning empty results silently', async () => {
    vi.stubGlobal('localStorage', createStorage())
    vi.stubGlobal('fetch', vi.fn(async () => success({ ok: false, error: '缺少标题' })))
    await expect(normalizeTitles([])).rejects.toThrow('缺少标题')
  })

  it('maps backend library name field to frontend description', async () => {
    vi.stubGlobal('localStorage', createStorage())
    vi.stubGlobal('fetch', vi.fn(async () => success([{ id: 1, category: 'GPU', name: 'RTX 4070 SUPER', price: '4899', image: 'gpu.jpg', refreshed_at: '2026-07-01', platform: 'mai88' }])))
    await expect(fetchLibrary()).resolves.toEqual([{ id: 1, category: 'GPU', description: 'RTX 4070 SUPER', price: 4899, image: 'gpu.jpg', refreshed_at: '2026-07-01', platform: 'mai88' }])
  })

  it('uses snake_case query and payload fields for product APIs', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => success({ items: [], total: 0, page: 1, page_size: 20 }))
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

  it('sends description as backend name when adding and updating library items', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => success({ ok: true }))
    vi.stubGlobal('localStorage', createStorage())
    vi.stubGlobal('fetch', fetchMock)
    await addLibraryItems([{ category: 'CPU', description: 'Intel i7', price: 2999, image: 'cpu.jpg' }])
    await updateLibraryItem(12, { description: 'Intel i9', price: 3999 })
    const addRequest = fetchMock.mock.calls[0]?.[1] as RequestInit
    const updateRequest = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect(JSON.parse(String(addRequest.body))).toEqual({ items: [{ category: 'CPU', name: 'Intel i7', price: 2999, image: 'cpu.jpg', platform: '' }] })
    expect(JSON.parse(String(updateRequest.body))).toEqual({ name: 'Intel i9', price: 3999 })
  })
})
