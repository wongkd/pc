import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../auth'

type Bindings = { DB: D1Database }
type Variables = { userId: number }

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const saveSchema = z.object({
  data: z.any(),
})

// 获取应用状态
app.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId')
  const row = await c.env.DB.prepare(
    'SELECT data, updated_at FROM app_state WHERE user_id = ?'
  ).bind(userId).first<{ data: string; updated_at: string }>()

  if (!row) {
    return c.json({ ok: true, data: null, updated_at: null })
  }

  let parsed: unknown = null
  try { parsed = JSON.parse(row.data) } catch { /* keep null */ }

  return c.json({ ok: true, data: parsed, updated_at: row.updated_at })
})

// 保存应用状态（UPSERT）
app.put('/', authMiddleware, zValidator('json', saveSchema), async (c) => {
  const userId = c.get('userId')
  const { data } = c.req.valid('json')
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data)

  try {
    await c.env.DB.prepare(
      `INSERT INTO app_state (user_id, data, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).bind(userId, dataStr).run()
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ ok: false, error: e.message || '保存失败' }, 500)
  }
})

export { app as stateRoutes }
