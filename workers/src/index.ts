import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authRoutes } from './routes/auth'
import { libraryRoutes } from './routes/library'
import { searchRoute } from './routes/search'
import { normalizeRoute } from './routes/normalize'
import { templatesRoutes } from './routes/templates'
import { stateRoutes } from './routes/state'

type Bindings = {
  DB: D1Database
  JWT_SECRET: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}))

app.route('/api/auth', authRoutes)
app.route('/api/library', libraryRoutes)
app.route('/api/search', searchRoute)
app.route('/api/normalize', normalizeRoute)
app.route('/api/templates', templatesRoutes)
app.route('/api/state', stateRoutes)

// Health check
app.get('/api/health', (c) => c.json({ ok: true, time: new Date().toISOString() }))

export default app
