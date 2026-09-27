import type { PublicCatalogProduct } from '../../contracts/v2/generated/catalog'
import { resolveCustomerEnvironment } from '../../features/customer/environment'

// 与环境域名一起在接入真实门店时配置；不猜测门店，也不回退演示商品。
export const CUSTOMER_CATALOG_STORE_ID: number | null = null
export function fetchPublicCatalog(category: '整机' | '配件', page: number): Promise<{ items: PublicCatalogProduct[]; hasMore: boolean }> {
  const environment = resolveCustomerEnvironment()
  if (!environment.apiBaseUrl || !CUSTOMER_CATALOG_STORE_ID) throw new Error('商城尚未配置门店与服务地址，请联系门店')
  const origin = environment.apiBaseUrl.replace(/\/api\/v2\/?$/, '').replace(/\/$/, '')
  return new Promise((resolve, reject) => wx.request({
    url: `${origin}/api/public/catalog/${CUSTOMER_CATALOG_STORE_ID}?category=${encodeURIComponent(category)}&page=${page}`,
    method: 'GET', timeout: 15000,
    success(response) {
      const payload = response.data as { data?: { items: PublicCatalogProduct[]; hasMore: boolean }; error?: { message?: string } }
      if (response.statusCode !== 200 || !payload.data) { reject(new Error(payload.error?.message || '商城读取失败，请稍后重试')); return }
      resolve({ ...payload.data, items: payload.data.items.map(item => ({ ...item, coverUrl: `${origin}${item.coverUrl}`, heroUrl: item.heroUrl ? `${origin}${item.heroUrl}` : null })) })
    },
    fail() { reject(new Error('网络连接失败，请稍后重试')) },
  }))
}
