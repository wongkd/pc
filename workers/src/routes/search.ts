import { Hono } from 'hono'

const app = new Hono()

// 比价搜索 - 代理到第三方 API
app.get('/', async (c) => {
  const keyword = c.req.query('q')
  if (!keyword) {
    return c.json({ ok: false, error: '请提供搜索关键词', data: [] })
  }

  try {
    const form = new URLSearchParams({
      isCoupon: '0',
      keyword: keyword,
      openid: '564bdce0fa408fc9e1d5d42fd022ef0b',
      order: 'desc',
      page: '1',
      pddListId: '',
      sort: '',
      sourceType: '0',
      user_id: '',
    })

    const r = await fetch('https://appapi.maishou88.com/api/v1/homepage/searchList', {
      method: 'POST',
      headers: {
        'User-Agent': 'MaiShouApp/3.7.7 (iPhone; iOS 26.3; Scale/3.00)',
        'openid': '564bdce0fa408fc9e1d5d42fd022ef0b',
        'version': '3.7.7.2',
        'referer': 'https://hnbc018.kuaizhan.com/',
        'accept': 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
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

    return c.json({ ok: true, data: rows })
  } catch (e: any) {
    return c.json({ ok: false, error: e.message || '搜索失败', data: [] }, 500)
  }
})

export { app as searchRoute }
