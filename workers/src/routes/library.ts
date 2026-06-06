import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware, adminMiddleware } from '../auth'

type Bindings = { DB: D1Database }
type Variables = { userId: number }

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const addItemSchema = z.object({
  items: z.array(z.object({
    category: z.string().min(1),
    name: z.string().min(1),
    price: z.number().min(0),
    image: z.string().optional().default(''),
    platform: z.string().optional().default(''),
  })).min(1),
})

const updateItemSchema = z.object({
  category: z.string().optional(),
  name: z.string().optional(),
  price: z.number().min(0).optional(),
  image: z.string().optional(),
  platform: z.string().optional(),
})

// 获取硬件库列表（限制500条，超出分页）
app.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId')
  const limit = Math.min(Number(c.req.query('limit') || '500'), 500)
  const offset = Math.max(Number(c.req.query('offset') || '0'), 0)
  const items = await c.env.DB.prepare(
    'SELECT id, category, name, price, image, platform, refreshed_at, created_at FROM library WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).bind(userId, limit, offset).all()
  return c.json(items.results)
})

// 批量添加硬件（返回带云端 ID 的记录列表）— 仅管理员
app.post('/', authMiddleware, adminMiddleware, zValidator('json', addItemSchema), async (c) => {
  const userId = c.get('userId')
  const { items } = c.req.valid('json')
  try {
    const results: Array<{ id: number; category: string; name: string; price: number }> = []
    for (const item of items) {
      const row = await c.env.DB.prepare(
        'INSERT INTO library (user_id, category, name, price, image, platform) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, category, name, price'
      ).bind(userId, item.category, item.name, item.price, item.image || '', item.platform || '').first()
      if (row) results.push(row as any)
    }
    return c.json({ ok: true, count: results.length, items: results })
  } catch (e: any) {
    return c.json({ ok: false, error: e.message || '添加失败' }, 500)
  }
})

// 更新硬件 — 仅管理员
app.put('/:id', authMiddleware, adminMiddleware, zValidator('json', updateItemSchema), async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const updates = c.req.valid('json')

  const existing = await c.env.DB.prepare('SELECT id FROM library WHERE id = ? AND user_id = ?').bind(id, userId).first()
  if (!existing) {
    return c.json({ ok: false, error: '硬件不存在' }, 404)
  }

  const fields: string[] = []
  const values: any[] = []
  Object.entries(updates).forEach(([key, value]) => {
    if (value !== undefined) {
      fields.push(`${key} = ?`)
      values.push(value)
    }
  })

  if (fields.length === 0) {
    return c.json({ ok: true, message: '无变更' })
  }

  values.push(id, userId)
  await c.env.DB.prepare(`UPDATE library SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).bind(...values).run()
  return c.json({ ok: true })
})

// 删除硬件 — 仅管理员
app.delete('/:id', authMiddleware, adminMiddleware, async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const existing = await c.env.DB.prepare('SELECT id FROM library WHERE id = ? AND user_id = ?').bind(id, userId).first()
  if (!existing) {
    return c.json({ ok: false, error: '硬件不存在' }, 404)
  }
  await c.env.DB.prepare('DELETE FROM library WHERE id = ? AND user_id = ?').bind(id, userId).run()
  return c.json({ ok: true })
})

export { app as libraryRoutes }
