import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { sign, hashPassword, verifyPassword, authMiddleware } from '../auth'

type Bindings = { DB: D1Database; JWT_SECRET: string }
type Variables = { userId: number }

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const loginSchema = z.object({
  email: z.string().email('邮箱格式不正确'),
  password: z.string().min(1, '密码不能为空'),
})

const registerSchema = z.object({
  email: z.string().email('邮箱格式不正确'),
  password: z.string().min(6, '密码至少6位'),
})

const changePwdSchema = z.object({
  oldPassword: z.string().min(1, '旧密码不能为空'),
  newPassword: z.string().min(6, '新密码至少6位'),
})

// 注册
app.post('/register', zValidator('json', registerSchema), async (c) => {
  const { email, password } = c.req.valid('json')
  try {
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
    if (existing) {
      return c.json({ ok: false, error: '该邮箱已注册' }, 409)
    }
    const passwordHash = await hashPassword(password)
    const result = await c.env.DB.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').bind(email, passwordHash).run()
    const userId = result.meta.last_row_id
    const token = await sign({ sub: userId, email }, c.env.JWT_SECRET || 'pc-quote-secret-key-2025')
    return c.json({ ok: true, token, user: { id: userId, email } })
  } catch (e: any) {
    return c.json({ ok: false, error: e.message || '注册失败' }, 500)
  }
})

// 登录
app.post('/login', zValidator('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json')
  try {
    const user = await c.env.DB.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').bind(email).first()
    if (!user) {
      return c.json({ ok: false, error: '邮箱或密码错误' }, 401)
    }
    const valid = await verifyPassword(password, user.password_hash as string)
    if (!valid) {
      return c.json({ ok: false, error: '邮箱或密码错误' }, 401)
    }
    const token = await sign({ sub: user.id, email: user.email }, c.env.JWT_SECRET || 'pc-quote-secret-key-2025')
    return c.json({ ok: true, token, user: { id: user.id, email: user.email } })
  } catch (e: any) {
    return c.json({ ok: false, error: e.message || '登录失败' }, 500)
  }
})

// 修改密码
app.put('/change-password', authMiddleware, zValidator('json', changePwdSchema), async (c) => {
  const userId = c.get('userId')
  const { oldPassword, newPassword } = c.req.valid('json')
  try {
    const user = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(userId).first()
    if (!user) {
      return c.json({ ok: false, error: '用户不存在' }, 404)
    }
    const valid = await verifyPassword(oldPassword, user.password_hash as string)
    if (!valid) {
      return c.json({ ok: false, error: '旧密码不正确' }, 400)
    }
    const newHash = await hashPassword(newPassword)
    await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(newHash, userId).run()
    return c.json({ ok: true, message: '密码修改成功' })
  } catch (e: any) {
    return c.json({ ok: false, error: e.message || '修改失败' }, 500)
  }
})

export { app as authRoutes }
