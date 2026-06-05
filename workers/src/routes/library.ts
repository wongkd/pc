import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../auth'

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

// 获取硬件库列表
app.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId')
  const items = await c.env.DB.prepare(
    'SELECT id, category, name, price, image, platform, refreshed_at, created_at FROM library WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all()
  return c.json(items.results)
})

// 批量添加硬件
app.post('/', authMiddleware, zValidator('json', addItemSchema), async (c) => {
  const userId = c.get('userId')
  const { items } = c.req.valid('json')
  try {
    const stmt = c.env.DB.prepare(
      'INSERT INTO library (user_id, category, name, price, image, platform) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const batch = items.map(item =>
      stmt.bind(userId, item.category, item.name, item.price, item.image || '', item.platform || '')
    )
    await c.env.DB.batch(batch)
    return c.json({ ok: true, count: items.length })
  } catch (e: any) {
    return c.json({ ok: false, error: e.message || '添加失败' }, 500)
  }
})

// 更新硬件
app.put('/:id', authMiddleware, zValidator('json', updateItemSchema), async (c) => {
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

// 删除硬件
app.delete('/:id', authMiddleware, async (c) => {
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
