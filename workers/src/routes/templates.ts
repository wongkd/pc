import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../auth'

type Bindings = { DB: D1Database }
type Variables = { userId: number }

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const saveTemplateSchema = z.object({
  name: z.string().min(1, '模板名称不能为空'),
  data: z.any(),
})

const deleteTemplateSchema = z.object({
  id: z.number(),
})

// 获取模板列表
app.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId')
  const items = await c.env.DB.prepare(
    'SELECT id, name, data, updated_at FROM templates WHERE user_id = ? ORDER BY updated_at DESC'
  ).bind(userId).all()
  return c.json(items.results)
})

// 保存模板
app.post('/', authMiddleware, zValidator('json', saveTemplateSchema), async (c) => {
  const userId = c.get('userId')
  const { name, data } = c.req.valid('json')
  try {
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data)
    await c.env.DB.prepare(
      'INSERT INTO templates (user_id, name, data, updated_at) VALUES (?, ?, ?, datetime(\'now\'))'
    ).bind(userId, name, dataStr).run()
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ ok: false, error: e.message || '保存失败' }, 500)
  }
})

// 删除模板
app.delete('/', authMiddleware, zValidator('json', deleteTemplateSchema), async (c) => {
  const userId = c.get('userId')
  const { id } = c.req.valid('json')
  const existing = await c.env.DB.prepare('SELECT id FROM templates WHERE id = ? AND user_id = ?').bind(id, userId).first()
  if (!existing) {
    return c.json({ ok: false, error: '模板不存在' }, 404)
  }
  await c.env.DB.prepare('DELETE FROM templates WHERE id = ? AND user_id = ?').bind(id, userId).run()
  return c.json({ ok: true })
})

export { app as templatesRoutes }
