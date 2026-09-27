import { inventoryClient } from '../workbench/inventory-api'
import type { CatalogImage, CatalogProduct, CatalogWrite } from '../../contracts/v2/generated/catalog'
export type { CatalogProduct, CatalogWrite }
async function send<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const token = inventoryClient.session.getToken()
    const response = await fetch(`/api/v2/catalog${path}`, { ...init, signal: controller.signal,
      headers: { Authorization: `Bearer ${token || ''}`, ...init.headers } })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload?.error?.message || '商品操作失败')
    return payload.data as T
  } catch (error) {
    if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) throw new Error('网络中断或超时，结果可能尚未返回。输入已保留，请用相同内容重试。')
    throw error
  } finally { clearTimeout(timer) }
}
export const listCatalog = (page: number) => send<{ items: CatalogProduct[]; hasMore: boolean }>(`/products?page=${page}`)
export const saveCatalog = (body: CatalogWrite) => send<CatalogProduct>(`/products/${body.product.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
export const uploadCatalogImage = (file: File) => send<CatalogImage>('/images', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: file })
export async function catalogImageUrl(id: string) {
  const token = inventoryClient.session.getToken()
  const response = await fetch(`/api/v2/catalog/images/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token || ''}` } })
  if (!response.ok) throw new Error('图片读取失败')
  return URL.createObjectURL(await response.blob())
}
