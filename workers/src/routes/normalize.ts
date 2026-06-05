import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../auth'

const app = new Hono()

const normalizeSchema = z.object({
  titles: z.array(z.string()).min(1),
})

// 标准化硬件名称 - 简单清理多余空格和特殊字符
app.post('/', authMiddleware, zValidator('json', normalizeSchema), async (c) => {
  const { titles } = c.req.valid('json')
  const items = titles.map((title) => {
    // 清理多余空格、统一分隔符
    const cleaned = title
      .replace(/\s+/g, ' ')
      .replace(/（/g, '(')
      .replace(/）/g, ')')
      .trim()
    return { original: title, normalized: cleaned }
  })
  return c.json({ ok: true, items })
})

export { app as normalizeRoute }
