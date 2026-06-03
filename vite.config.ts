import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// ── 比价 API 代理插件 ──
function priceComparePlugin() {
  const API_BASE = 'https://appapi.maishou88.com'
  const HEADERS = {
    'User-Agent': 'MaiShouApp/3.7.7 (iPhone; iOS 26.3; Scale/3.00)',
    'openid': '564bdce0fa408fc9e1d5d42fd022ef0b',
    'version': '3.7.7.2',
    'referer': 'https://hnbc018.kuaizhan.com/',
    'accept': 'application/json',
  }

  return {
    name: 'price-compare-api',
    configureServer(server: any) {
      server.middlewares.use('/api/search', async (req: any, res: any) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        let body = ''
        req.on('data', (chunk: any) => body += chunk)
        req.on('end', async () => {
          try {
            const { keyword, source = '0' } = JSON.parse(body)
            const form = new URLSearchParams({
              isCoupon: '0', keyword: String(keyword),
              openid: '564bdce0fa408fc9e1d5d42fd022ef0b',
              order: 'desc', page: '1', pddListId: '',
              sort: '', sourceType: String(source), user_id: '',
            })
            const r = await fetch(`${API_BASE}/api/v1/homepage/searchList`, {
              method: 'POST', headers: { ...HEADERS, 'content-type': 'application/x-www-form-urlencoded' }, body: form,
            })
            const data: any = await r.json()
            const rows = (data?.data || []).map((v: any) => ({
              goodsId: v.goodsId,
              source: v.sourceType,
              title: v.title,
              shopName: v.shopName,
              originalPrice: v.originalPrice,
              actualPrice: v.actualPrice,
              couponPrice: v.couponPrice,
              monthSales: v.monthSales,
              picUrl: v.picUrl,
            }))
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, data: rows }))
          } catch (e: any) {
            res.statusCode = 500
            res.end(JSON.stringify({ ok: false, error: e.message }))
          }
        })
      })
    },
  }
}

export default defineConfig({
  base: '/pc/',
  plugins: [react(), priceComparePlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  }
})
