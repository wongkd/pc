import type { Context, Next } from 'hono'

// Simple crypto-based JWT implementation for Cloudflare Workers
// Uses Web Crypto API (available in Workers)

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function base64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/')
  while (str.length % 4) str += '='
  const binary = atob(str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function sign(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' }
  const headerB64 = base64url(encoder.encode(JSON.stringify(header)))
  const payloadB64 = base64url(encoder.encode(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days
  })))
  const signingInput = `${headerB64}.${payloadB64}`

  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput)))
  return `${signingInput}.${base64url(signature)}`
}

export async function verify(token: string, secret: string): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null

    const signingInput = `${parts[0]}.${parts[1]}`
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    )
    const signature = base64urlDecode(parts[2])
    const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(signingInput))
    if (!valid) return null

    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])))
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(password),
    'PBKDF2', false, ['deriveBits']
  )
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key, 256
  )
  const hashArray = new Uint8Array(hash)
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('')
  const hashHex = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('')
  return `${saltHex}:${hashHex}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':')
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(b => parseInt(b, 16)))
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(password),
    'PBKDF2', false, ['deriveBits']
  )
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key, 256
  )
  const computedHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
  return computedHex === hashHex
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ ok: false, error: '未登录或令牌无效' }, 401)
  }
  const token = authHeader.slice(7)
  const payload = await verify(token, c.env.JWT_SECRET || 'pc-quote-secret-key-2025')
  if (!payload) {
    return c.json({ ok: false, error: '令牌已过期，请重新登录' }, 401)
  }
  c.set('userId', payload.sub as number)
  c.set('userEmail', (payload.email as string) || '')
  await next()
}

const ADMIN_EMAIL = '563838884@qq.com'

export function isAdmin(c: Context): boolean {
  return c.get('userEmail') === ADMIN_EMAIL
}

/** 管理员权限中间件：仅管理员可写 */
export async function adminMiddleware(c: Context, next: Next) {
  if (!isAdmin(c)) {
    return c.json({ ok: false, error: '仅管理员可修改硬件库' }, 403)
  }
  await next()
}
