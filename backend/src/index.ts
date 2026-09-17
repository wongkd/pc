interface Env {
  DB: D1Database
  DEEPSEEK_KEY: string
  JWT_SECRET: string
  PDD_CLIENT_ID: string
  PDD_CLIENT_SECRET: string
  PDD_PID: string
}

// ── JWT (simple HMAC-SHA256, no external libs) ──
async function signJWT(payload: object, secret: string): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 * 7 }))
  const sig = await hmacSha256(`${header}.${body}`, secret)
  return `${header}.${body}.${sig}`
}

async function verifyJWT(token: string, secret: string): Promise<Record<string, any> | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const expectedSig = await hmacSha256(`${parts[0]}.${parts[1]}`, secret)
    if (parts[2] !== expectedSig) return null
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(parts[1]), (c) => c.charCodeAt(0))))
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch { return null }
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmacSha256(data: string, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ── Password hash ──
async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const saltBuffer = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits'])
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBuffer, iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  )
  const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${toHex(saltBuffer)}:${toHex(hash)}`
}

async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  // New format: hexSalt:hexHash
  if (stored.includes(':')) {
    const [saltHex, hashHex] = stored.split(':')
    const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
    const expectedHash = new Uint8Array(hashHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits'])
    const derived = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      key, 256,
    )
    const derivedBytes = new Uint8Array(derived)
    if (derivedBytes.length !== expectedHash.length) return false
    return derivedBytes.every((b, i) => b === expectedHash[i])
  }

  // Old format: base64 SHA-256 with fixed salt (backward compat)
  const oldHash = btoa(String.fromCharCode(...new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw + 'salt-pc'))
  )))
  return stored === oldHash
}

// ── CORS ──
const ALLOWED_ORIGINS = [
  'https://pc.huangqidong.cn',
  /^https:\/\/[a-f0-9]+\.pc-quote\.pages\.dev$/,
]

function allowedOrigin(origin: string): string | null {
  if (!origin || origin === 'null') return null
  if (ALLOWED_ORIGINS.some((p) => typeof p === 'string' ? p === origin : p.test(origin))) return origin
  return null
}

function cors(resp: Response, origin: string): Response {
  const r = new Response(resp.body, resp)
  const ao = allowedOrigin(origin)
  if (ao) r.headers.set('Access-Control-Allow-Origin', ao)
  r.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  r.headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  return r
}

// ── Rate Limiter ──
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(key)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (entry.count >= max) return false
  entry.count++
  return true
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

// ── Auth middleware ──
type AuthContext = { userId: number; storeId: number; memberId: number; roles: string[]; permissions: string[]; isOwner: boolean }

type UserRecord = { id: number; email: string; password_hash: string; status: string; token_version: number }

async function loadAuthContext(env: Env, userId: number, storeId: number, tokenVersion: number): Promise<AuthContext | Response> {
  const user = await env.DB.prepare('SELECT id, status, token_version FROM users WHERE id=?').bind(userId).first<{ id: number; status: string; token_version: number }>()
  if (!user || user.status !== 'active' || user.token_version !== tokenVersion) return json({ error: '账号不可用或登录已失效' }, 401)
  const member = await env.DB.prepare('SELECT id, is_owner FROM store_members WHERE store_id=? AND user_id=? AND status=\'active\'').bind(storeId, userId).first<{ id: number; is_owner: number }>()
  if (!member) return json({ error: '当前门店成员资格不可用' }, 403)
  const rows = await env.DB.prepare(`SELECT r.code AS role, p.code AS permission FROM member_roles mr JOIN roles r ON r.id=mr.role_id LEFT JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN permissions p ON p.id=rp.permission_id WHERE mr.member_id=?`).bind(member.id).all<{ role: string; permission: string | null }>()
  const roles = [...new Set(rows.results.map((row) => row.role))]
  const isOwner = member.is_owner === 1 || roles.includes('owner')
  const permissions = isOwner || roles.includes('admin') ? ['*'] : [...new Set(rows.results.map((row) => row.permission).filter((value): value is string => !!value))]
  return { userId, storeId, memberId: member.id, roles, permissions, isOwner }
}

async function auth(req: Request, env: Env): Promise<AuthContext | Response> {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!token) return json({ error: '请先登录' }, 401)
  const payload = await verifyJWT(token, env.JWT_SECRET)
  if (!payload || !Number.isInteger(payload.uid) || !Number.isInteger(payload.sid) || !Number.isInteger(payload.tv)) return json({ error: '登录已过期' }, 401)
  return loadAuthContext(env, payload.uid as number, payload.sid as number, payload.tv as number)
}

function requirePermission(context: AuthContext, permission: string): Response | null {
  return context.permissions.includes('*') || context.permissions.includes(permission) ? null : json({ error: '无此操作权限' }, 403)
}

function redactFinancialFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFinancialFields)
  if (!value || typeof value !== 'object') return value
  const redacted: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(cost|purchase|margin|gross.?profit|采购|成本|毛利)/i.test(key)) continue
    redacted[key] = redactFinancialFields(child)
  }
  return redacted
}

function restrictFinancialData(context: AuthContext, data: string): string {
  if (context.permissions.includes('*') || context.permissions.includes('cost/view') || context.permissions.includes('margin/view')) return data
  try { return JSON.stringify(redactFinancialFields(JSON.parse(data))) } catch { return data }
}

function auditStatement(env: Env, context: AuthContext, action: string, entityType: string, entityId: string | number | null, details: Record<string, unknown> = {}) {
  return env.DB.prepare('INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(context.storeId, context.userId, action, entityType, entityId == null ? null : String(entityId), JSON.stringify(details))
}

function auditLastInsertStatement(env: Env, context: AuthContext, action: string, entityType: string, details: Record<string, unknown> = {}) {
  return env.DB.prepare('INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, CAST(last_insert_rowid() AS TEXT), ?)')
    .bind(context.storeId, context.userId, action, entityType, JSON.stringify(details))
}

async function audit(env: Env, context: AuthContext, action: string, entityType: string, entityId: string | number | null, details: Record<string, unknown> = {}): Promise<void> {
  await auditStatement(env, context, action, entityType, entityId, details).run()
}

async function issueToken(env: Env, user: Pick<UserRecord, 'id' | 'email' | 'token_version'>, storeId: number): Promise<string> {
  return signJWT({ uid: user.id, email: user.email, sid: storeId, tv: user.token_version }, env.JWT_SECRET)
}

async function auditInviteAcceptance(env: Env, invite: { store_id: number; created_by: number; id: number }, userId: number, memberId: number): Promise<void> {
  await env.DB.prepare('INSERT INTO audit_logs (store_id, actor_user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(invite.store_id, invite.created_by, 'member.invitation_accepted', 'member_invite', String(invite.id), JSON.stringify({ userId, memberId })).run()
}

// ── MD5 (pure JS for Cloudflare Workers) ──
function md5(s: string): string {
  function rotateLeft(n: number, b: number) { return (n << b) | (n >>> (32 - b)) }
  function addUnsigned(x: number, y: number) { return (x + y) & 0xffffffff }
  function F(x: number, y: number, z: number) { return (x & y) | (~x & z) }
  function G(x: number, y: number, z: number) { return (x & z) | (y & ~z) }
  function H(x: number, y: number, z: number) { return x ^ y ^ z }
  function I(x: number, y: number, z: number) { return y ^ (x | ~z) }
  function FF(a: number, b: number, c: number, d: number, x: number, s: number, ac: number) { a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b) }
  function GG(a: number, b: number, c: number, d: number, x: number, s: number, ac: number) { a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b) }
  function HH(a: number, b: number, c: number, d: number, x: number, s: number, ac: number) { a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b) }
  function II(a: number, b: number, c: number, d: number, x: number, s: number, ac: number) { a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b) }

  const bytes: number[] = []
  for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff)

  const origLen = bytes.length
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)

  const bitLen = origLen * 8
  for (let i = 0; i < 4; i++) bytes.push((bitLen >>> (i * 8)) & 0xff)
  for (let i = 4; i < 8; i++) bytes.push(0)

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476
  for (let k = 0; k < bytes.length; k += 64) {
    const X: number[] = []
    for (let i = 0; i < 16; i++) X[i] = bytes[k + i * 4] | (bytes[k + i * 4 + 1] << 8) | (bytes[k + i * 4 + 2] << 16) | (bytes[k + i * 4 + 3] << 24)
    let aa = a, bb = b, cc = c, dd = d
    a = FF(a, b, c, d, X[0], 7, 0xd76aa478); d = FF(d, a, b, c, X[1], 12, 0xe8c7b756); c = FF(c, d, a, b, X[2], 17, 0x242070db); b = FF(b, c, d, a, X[3], 22, 0xc1bdceee)
    a = FF(a, b, c, d, X[4], 7, 0xf57c0faf); d = FF(d, a, b, c, X[5], 12, 0x4787c62a); c = FF(c, d, a, b, X[6], 17, 0xa8304613); b = FF(b, c, d, a, X[7], 22, 0xfd469501)
    a = FF(a, b, c, d, X[8], 7, 0x698098d8); d = FF(d, a, b, c, X[9], 12, 0x8b44f7af); c = FF(c, d, a, b, X[10], 17, 0xffff5bb1); b = FF(b, c, d, a, X[11], 22, 0x895cd7be)
    a = FF(a, b, c, d, X[12], 7, 0x6b901122); d = FF(d, a, b, c, X[13], 12, 0xfd987193); c = FF(c, d, a, b, X[14], 17, 0xa679438e); b = FF(b, c, d, a, X[15], 22, 0x49b40821)
    a = GG(a, b, c, d, X[1], 5, 0xf61e2562); d = GG(d, a, b, c, X[6], 9, 0xc040b340); c = GG(c, d, a, b, X[11], 14, 0x265e5a51); b = GG(b, c, d, a, X[0], 20, 0xe9b6c7aa)
    a = GG(a, b, c, d, X[5], 5, 0xd62f105d); d = GG(d, a, b, c, X[10], 9, 0x02441453); c = GG(c, d, a, b, X[15], 14, 0xd8a1e681); b = GG(b, c, d, a, X[4], 20, 0xe7d3fbc8)
    a = GG(a, b, c, d, X[9], 5, 0x21e1cde6); d = GG(d, a, b, c, X[14], 9, 0xc33707d6); c = GG(c, d, a, b, X[3], 14, 0xf4d50d87); b = GG(b, c, d, a, X[8], 20, 0x455a14ed)
    a = GG(a, b, c, d, X[13], 5, 0xa9e3e905); d = GG(d, a, b, c, X[2], 9, 0xfcefa3f8); c = GG(c, d, a, b, X[7], 14, 0x676f02d9); b = GG(b, c, d, a, X[12], 20, 0x8d2a4c8a)
    a = HH(a, b, c, d, X[5], 4, 0xfffa3942); d = HH(d, a, b, c, X[8], 11, 0x8771f681); c = HH(c, d, a, b, X[11], 16, 0x6d9d6122); b = HH(b, c, d, a, X[14], 23, 0xfde5380c)
    a = HH(a, b, c, d, X[1], 4, 0xa4beea44); d = HH(d, a, b, c, X[4], 11, 0x4bdecfa9); c = HH(c, d, a, b, X[7], 16, 0xf6bb4b60); b = HH(b, c, d, a, X[10], 23, 0xbebfbc70)
    a = HH(a, b, c, d, X[13], 4, 0x289b7ec6); d = HH(d, a, b, c, X[0], 11, 0xeaa127fa); c = HH(c, d, a, b, X[3], 16, 0xd4ef3085); b = HH(b, c, d, a, X[6], 23, 0x04881d05)
    a = HH(a, b, c, d, X[9], 4, 0xd9d4d039); d = HH(d, a, b, c, X[12], 11, 0xe6db99e5); c = HH(c, d, a, b, X[15], 16, 0x1fa27cf8); b = HH(b, c, d, a, X[2], 23, 0xc4ac5665)
    a = II(a, b, c, d, X[0], 6, 0xf4292244); d = II(d, a, b, c, X[7], 10, 0x432aff97); c = II(c, d, a, b, X[14], 15, 0xab9423a7); b = II(b, c, d, a, X[5], 21, 0xfc93a039)
    a = II(a, b, c, d, X[12], 6, 0x655b59c3); d = II(d, a, b, c, X[3], 10, 0x8f0ccc92); c = II(c, d, a, b, X[10], 15, 0xffeff47d); b = II(b, c, d, a, X[1], 21, 0x85845dd1)
    a = II(a, b, c, d, X[8], 6, 0x6fa87e4f); d = II(d, a, b, c, X[15], 10, 0xfe2ce6e0); c = II(c, d, a, b, X[6], 15, 0xa3014314); b = II(b, c, d, a, X[13], 21, 0x4e0811a1)
    a = II(a, b, c, d, X[4], 6, 0xf7537e82); d = II(d, a, b, c, X[11], 10, 0xbd3af235); c = II(c, d, a, b, X[2], 15, 0x2ad7d2bb); b = II(b, c, d, a, X[9], 21, 0xeb86d391)
    a = addUnsigned(a, aa); b = addUnsigned(b, bb); c = addUnsigned(c, cc); d = addUnsigned(d, dd)
  }
  const hex = (x: number) => ('0000000' + (x >>> 0).toString(16)).slice(-8)
  return hex(a) + hex(b) + hex(c) + hex(d)
}

// ── PDD Open Platform API ──
const PDD_GATEWAY = 'https://gw-api.pinduoduo.com/api/router'

function pddSign(params: Record<string, string>, secret: string): string {
  const sorted = Object.keys(params).sort()
  const raw = secret + sorted.map(k => k + params[k]).join('') + secret
  return md5(raw).toUpperCase()
}

async function pddCall(type: string, bizParams: Record<string, any>, clientId: string, clientSecret: string): Promise<any> {
  const params: Record<string, string> = {
    type,
    client_id: clientId,
    timestamp: String(Math.floor(Date.now() / 1000)),
    data_type: 'JSON',
  }
  // Merge biz params, converting all values to string
  for (const [k, v] of Object.entries(bizParams)) {
    if (v !== undefined && v !== null && v !== '') {
      params[k] = typeof v === 'boolean' ? String(v) : String(v)
    }
  }
  params.sign = pddSign(params, clientSecret)

  const url = PDD_GATEWAY + '?' + Object.entries(params).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000) // 5s timeout
  try {
    const r = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'pc-quote/1.0' }, signal: ctrl.signal })
    const data: any = await r.json()
    if (data.error_response) {
      console.error('PDD API Error:', JSON.stringify(data.error_response))
      throw new Error(`PDD: ${data.error_response.error_msg || 'unknown'}`)
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

async function pddSearch(keyword: string, env: Env): Promise<any[]> {
  try {
    const pddParams = {
      keyword,
      page_size: '20',
      sort_type: '1',
      pid: env.PDD_PID,
      custom_parameters: JSON.stringify({ uid: 'pc-quote' }),
    }
    const data = await pddCall('pdd.ddk.goods.search', pddParams, env.PDD_CLIENT_ID, env.PDD_CLIENT_SECRET)

    const list = data?.goods_search_response?.goods_list || []
    return list.map((g: any) => ({
      goodsId: String(g.goods_id || g.goods_sign),
      source: 3,
      title: g.goods_name || '',
      shopName: g.mall_name || '拼多多',
      originalPrice: (Number(g.min_normal_price) || Number(g.min_group_price) || 0) / 100,
      actualPrice: (Number(g.min_group_price) || 0) / 100,
      couponPrice: g.has_coupon ? (Number(g.coupon_discount) || 0) / 100 : 0,
      monthSales: parseSales(g.sales_tip || ''),
      picUrl: g.goods_image_url || g.goods_thumbnail_url || '',
      price: (Number(g.min_group_price) || 0) / 100,
      platform: '拼多多',
      pddGoodsSign: g.goods_sign || '',
    }))
  } catch (e: any) {
    console.error('PDD Search failed:', e.message)
    return []
  }
}

function parseSales(tip: string): number {
  if (!tip) return 0
  const m = tip.match(/([\d.]+)万/)
  if (m) return Math.round(parseFloat(m[1]) * 10000)
  const n = tip.match(/(\d+)/)
  return n ? parseInt(n[1]) : 0
}

// ── PDD Detail (SKU expansion) ──
async function pddGetDetail(goodsSign: string, env: Env): Promise<any> {
  const data = await pddCall('pdd.ddk.goods.detail', {
    goods_sign: goodsSign,
    pid: env.PDD_PID,
  }, env.PDD_CLIENT_ID, env.PDD_CLIENT_SECRET)

  const goods = data?.goods_detail_response?.goods_details?.[0]
  if (!goods) return null

  const skus = (goods.sku_list || []).map((sku: any) => ({
    skuId: String(sku.sku_id || ''),
    spec: sku.spec || sku.sku_name || '',
    groupPrice: (Number(sku.group_price) || 0) / 100,
    thumbUrl: sku.thumb_url || sku.sku_thumb_url || '',
  }))

  return {
    goodsId: String(goods.goods_id),
    title: goods.goods_name || '',
    shopName: goods.mall_name || '拼多多',
    picUrl: goods.goods_image_url || goods.goods_thumbnail_url || '',
    minPrice: (Number(goods.min_group_price) || 0) / 100,
    normalPrice: (Number(goods.min_normal_price) || 0) / 100,
    salesTip: goods.sales_tip || '',
    hasCoupon: !!goods.has_coupon,
    couponDiscount: (Number(goods.coupon_discount) || 0) / 100,
    couponMinOrder: (Number(goods.coupon_min_order_amount) || 0) / 100,
    skus,
  }
}

// ── Search API ──
async function handleSearch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)
  const keyword = url.searchParams.get('q') || ''
  if (!keyword) return json({ error: '缺少关键词' }, 400)

  // Run maishou88 and PDD in parallel
  const [maiResult, pddResult] = await Promise.allSettled([
    (async () => {
      const body = new URLSearchParams({
        isCoupon: '0', keyword, openid: '564bdce0fa408fc9e1d5d42fd022ef0b',
        order: 'desc', page: '1', pddListId: '', sort: '', sourceType: '', user_id: '',
      })
      const r = await fetch('https://appapi.maishou88.com/api/v1/homepage/searchList', {
        method: 'POST',
        headers: { 'User-Agent': 'MaiShouApp/3.7.7 (iPhone; iOS 26.3; Scale/3.00)', 'openid': '564bdce0fa408fc9e1d5d42fd022ef0b', 'version': '3.7.7.2' },
        body,
      })
      const data: any = await r.json()
      return (data?.data || []).map((v: any) => ({
        goodsId: v.goodsId,
        source: Number(v.sourceType) || 0,
        title: v.title,
        shopName: v.shopName,
        originalPrice: Number(v.originalPrice) || 0,
        actualPrice: Number(v.actualPrice) || 0,
        couponPrice: Number(v.couponPrice) || 0,
        monthSales: Number(v.monthSales) || 0,
        picUrl: v.picUrl,
        price: Number(v.actualPrice) || 0,
      }))
    })(),
    pddSearch(keyword, env),
  ])

  const maiItems = maiResult.status === 'fulfilled' ? maiResult.value : []
  const pddItems = pddResult.status === 'fulfilled' ? pddResult.value : []

  // Merge: maishou88 first, then PDD
  const items = [...maiItems, ...pddItems]

  return json({ ok: true, data: items })
}

// ── DeepSeek Normalize ──
async function handleNormalize(req: Request, env: Env): Promise<Response> {
  const { titles }: { titles: string[] } = await req.json()
  if (!titles?.length) return json({ error: '缺少标题' }, 400)

  const prompt = `你是一个电脑硬件 SKU 标准化助手。请将以下电商商品标题转化为标准化的硬件名称、分类、价格和规格。
返回严格 JSON 数组格式：[{ "name": "品牌 型号 规格", "category": "CPU/主板/内存/显卡/硬盘/散热器/电源/机箱/风扇/显示器/其他/鼠标/键盘/耳机/座椅", "price": 数字价格, "specs": "规格描述" }]

规则（非常重要）：
1. name 格式必须是「品牌 型号 核心规格」，例如：
   - CPU: "Intel i3-12100F 四核八线程" "AMD Ryzen 5 5600 六核十二线程"
   - 显卡: "NVIDIA RTX 4070 SUPER 12GB" "AMD RX 7800 XT 16GB"
   - 内存: "金士顿 Fury Beast DDR5 32GB 6000MHz"
   - 硬盘: "三星 990 PRO 2TB NVMe PCIe 4.0"
   - 主板: "华硕 ROG STRIX Z790-A DDR5 WIFI"
   - 散热器: "九州风神 AK620 双塔风冷"
   - 电源: "海盗船 RM850e 850W 金牌全模组"
   - 机箱: "联力 LANCOOL 216 白色"
   - 显示器: "Dell U2724D 27英寸 2K IPS"
   - 颜色/数量等关键属性要保留
2. specs 字段只写核心规格，如"四核八线程""12GB""白色""粉色""6000MHz"等，不要重复型号号码
3. 过滤掉整机/组装机/套装（标题含"整机""组装""主机""套装""套餐"等词），不返回这些条目
4. 如果标题描述的是单个硬件，提取准确型号
5. 价格取最合理的数值
6. 如果标题混淆不明确，分类为"其他"

商品标题：
${titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}`

  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.DEEPSEEK_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 4000,
    }),
  })
  const d: any = await r.json()
  const text = d?.choices?.[0]?.message?.content || ''

  // Extract JSON array from response (string-aware, tries top-level arrays back-to-front)
  let jsonStr = '[]'

  // Step 1: find all top-level [ positions (string-aware)
  const topLevelStarts: number[] = []
  let inString = false
  let escaping = false
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaping) { escaping = false }
      else if (ch === '\\') { escaping = true }
      else if (ch === '"') { inString = false }
    } else {
      if (ch === '"') { inString = true }
      else if (ch === '[') {
        if (depth === 0) topLevelStarts.push(i)
        depth++
      } else if (ch === ']') {
        depth = Math.max(0, depth - 1)
      }
    }
  }

  // Step 2: try each top-level array from last to first, keep first valid parse
  for (let s = topLevelStarts.length - 1; s >= 0; s--) {
    const start = topLevelStarts[s]
    inString = false
    escaping = false
    depth = 0
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        if (escaping) { escaping = false }
        else if (ch === '\\') { escaping = true }
        else if (ch === '"') { inString = false }
      } else {
        if (ch === '"') { inString = true }
        else if (ch === '[') { depth++ }
        else if (ch === ']') {
          depth--
          if (depth === 0) {
            const candidate = text.slice(start, i + 1)
            try {
              const parsed = JSON.parse(candidate)
              if (Array.isArray(parsed)) { jsonStr = candidate; break }
            } catch { break }
          }
        }
      }
    }
    if (jsonStr !== '[]') break
  }

  try {
    return json({ ok: true, items: JSON.parse(jsonStr) })
  } catch {
    return json({ ok: false, error: 'AI 解析失败', raw: text })
  }
}

type ProductInput = {
  categoryId?: number | null; brandId?: number | null; sku?: string; name?: string; itemType?: string; status?: string
  isSerialized?: boolean | number; isSalable?: boolean | number; isPurchasable?: boolean | number
  referencePriceCents?: number; defaultPriceCents?: number; minPriceCents?: number; purchasePriceCents?: number
  averageCostCents?: number; safetyStockQty?: number; image?: string; platform?: string
}

function hasCostView(context: AuthContext): boolean {
  return context.permissions.includes('*') || context.permissions.includes('cost/view')
}

function asBooleanInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback
  if (value === true || value === 1) return 1
  if (value === false || value === 0) return 0
  throw new Error('布尔字段只能是 true/false 或 1/0')
}

function asNonNegativeInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${field}必须是非负整数`)
  return Number(value)
}

function normalizeSku(value: unknown): string {
  if (typeof value !== 'string') throw new Error('SKU不能为空')
  const sku = value.trim().toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9-]{0,63}$/.test(sku)) throw new Error('SKU仅支持大写字母、数字和短横线，长度1-64位')
  return sku
}

async function requireActiveCategory(env: Env, context: AuthContext, categoryId: number): Promise<{ id: number; name: string }> {
  const category = await env.DB.prepare("SELECT id, name FROM product_categories WHERE id=? AND store_id=? AND status='active'").bind(categoryId, context.storeId).first<{ id: number; name: string }>()
  if (!category) throw new Error('商品分类不存在、已停用或不属于当前门店')
  return category
}

type LegacyCategory = { id: number | null; name: string; isNew: boolean }

async function prepareLegacyCategories(env: Env, context: AuthContext, values: unknown[]): Promise<Map<string, LegacyCategory>> {
  const categories = new Map<string, LegacyCategory>()
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('分类不能为空')
    const name = value.trim()
    if (categories.has(name)) continue
    const category = await env.DB.prepare('SELECT id, name, status FROM product_categories WHERE store_id=? AND name=?').bind(context.storeId, name).first<{ id: number; name: string; status: string }>()
    if (category?.status === 'disabled') throw new Error('商品分类已停用')
    categories.set(name, { id: category?.id ?? null, name, isNew: !category })
  }
  return categories
}

function createLegacyCategoryStatement(env: Env, context: AuthContext, category: LegacyCategory) {
  return env.DB.prepare("INSERT OR IGNORE INTO product_categories (store_id, code, name, status, created_by, updated_by) VALUES (?, ?, ?, 'active', ?, ?)")
    .bind(context.storeId, `LEGACY-${crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`, category.name, context.userId, context.userId)
}

async function requireActiveBrand(env: Env, context: AuthContext, brandId: number | null): Promise<void> {
  if (brandId == null) return
  const brand = await env.DB.prepare("SELECT id FROM product_brands WHERE id=? AND store_id=? AND status='active'").bind(brandId, context.storeId).first()
  if (!brand) throw new Error('商品品牌不存在、已停用或不属于当前门店')
}

function productResponse(context: AuthContext, row: Record<string, unknown>): Record<string, unknown> {
  const result = { ...row }
  if (!hasCostView(context)) {
    delete result.purchase_price_cents
    delete result.average_cost_cents
    delete result.purchasePriceCents
    delete result.averageCostCents
  }
  return result
}

async function handleProducts(req: Request, env: Env, context: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const idMatch = path.match(/^\/api\/products\/(\d+)(?:\/status)?$/)
  const productId = idMatch ? Number(idMatch[1]) : null
  const isStatusRoute = /\/status$/.test(path)
  const denied = requirePermission(context, req.method === 'GET' ? 'library/view' : 'library/edit')
  if (denied) return denied

  if (req.method === 'GET' && !productId) {
    const page = Math.max(1, Number(url.searchParams.get('page') || 1))
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') || 20)))
    const where = ['h.store_id=?']; const params: unknown[] = [context.storeId]
    const filters: Array<[string, string, string]> = [['categoryId', 'h.category_id', 'integer'], ['brandId', 'h.brand_id', 'integer'], ['status', 'h.status', 'text']]
    for (const [key, column, type] of filters) {
      const value = url.searchParams.get(key)
      if (value) { if (type === 'integer' && !/^\d+$/.test(value)) return json({ error: `${key}无效` }, 400); where.push(`${column}=?`); params.push(type === 'integer' ? Number(value) : value) }
    }
    for (const [key, column] of [['isSalable', 'h.is_salable'], ['isPurchasable', 'h.is_purchasable'], ['isSerialized', 'h.is_serialized']] as const) {
      const value = url.searchParams.get(key)
      if (value != null) { if (!['0', '1'].includes(value)) return json({ error: `${key}只能是0或1` }, 400); where.push(`${column}=?`); params.push(Number(value)) }
    }
    const search = url.searchParams.get('search')?.trim()
    if (search) { where.push('(h.sku LIKE ? OR h.name LIKE ? OR pc.name LIKE ? OR pb.name LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`) }
    const condition = where.join(' AND ')
    const fields = 'h.*, pc.name AS category_name, pb.name AS brand_name'
    const result = await env.DB.prepare(`SELECT ${fields} FROM hardware h LEFT JOIN product_categories pc ON pc.id=h.category_id AND pc.store_id=h.store_id LEFT JOIN product_brands pb ON pb.id=h.brand_id AND pb.store_id=h.store_id WHERE ${condition} ORDER BY h.updated_at DESC, h.id DESC LIMIT ? OFFSET ?`).bind(...params, pageSize, (page - 1) * pageSize).all<Record<string, unknown>>()
    const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM hardware h LEFT JOIN product_categories pc ON pc.id=h.category_id AND pc.store_id=h.store_id LEFT JOIN product_brands pb ON pb.id=h.brand_id AND pb.store_id=h.store_id WHERE ${condition}`).bind(...params).first<{ total: number }>()
    return json({ items: result.results.map((row) => productResponse(context, row)), page, pageSize, total: count?.total || 0 })
  }

  if (req.method === 'GET' && productId) {
    const row = await env.DB.prepare('SELECT h.*, pc.name AS category_name, pb.name AS brand_name FROM hardware h LEFT JOIN product_categories pc ON pc.id=h.category_id AND pc.store_id=h.store_id LEFT JOIN product_brands pb ON pb.id=h.brand_id AND pb.store_id=h.store_id WHERE h.id=? AND h.store_id=?').bind(productId, context.storeId).first<Record<string, unknown>>()
    return row ? json(productResponse(context, row)) : json({ error: '商品不存在' }, 404)
  }

  const body = await req.json<ProductInput>()
  try {
    if (req.method === 'POST' && !productId) {
      const categoryId = asNonNegativeInteger(body.categoryId, 'categoryId', 0)
      if (!categoryId || !body.name?.trim()) return json({ error: '分类、名称和SKU不能为空' }, 400)
      const category = await requireActiveCategory(env, context, categoryId)
      const sku = normalizeSku(body.sku)
      const brandId = body.brandId == null ? null : asNonNegativeInteger(body.brandId, 'brandId', 0)
      await requireActiveBrand(env, context, brandId)
      const itemType = body.itemType || 'product'; if (!['product', 'service'].includes(itemType)) return json({ error: '商品类型无效' }, 400)
      const status = body.status || 'active'; if (!['active', 'disabled'].includes(status)) return json({ error: '状态无效' }, 400)
      const serialized = itemType === 'service' ? 0 : asBooleanInt(body.isSerialized, 0)
      const salable = asBooleanInt(body.isSalable, 1); const purchasable = itemType === 'service' ? 0 : asBooleanInt(body.isPurchasable, 1)
      const reference = asNonNegativeInteger(body.referencePriceCents, 'referencePriceCents', 0); const defaultPrice = asNonNegativeInteger(body.defaultPriceCents, 'defaultPriceCents', 0)
      const min = asNonNegativeInteger(body.minPriceCents, 'minPriceCents', 0); const purchase = asNonNegativeInteger(body.purchasePriceCents, 'purchasePriceCents', 0); const average = asNonNegativeInteger(body.averageCostCents, 'averageCostCents', 0)
      if (!hasCostView(context) && (body.purchasePriceCents !== undefined || body.averageCostCents !== undefined)) return json({ error: '无查看或维护成本权限' }, 403)
      const safety = itemType === 'service' ? 0 : asNonNegativeInteger(body.safetyStockQty, 'safetyStockQty', 0)
      const warrantyMonths = itemType === 'service' ? 36 : Math.max(1, asNonNegativeInteger(body.warrantyMonths, 'warrantyMonths', 36))
      const created = await env.DB.prepare('INSERT INTO hardware (user_id, store_id, created_by, updated_by, category, category_id, brand_id, sku, name, item_type, status, is_serialized, is_salable, is_purchasable, reference_price_cents, default_price_cents, min_price_cents, purchase_price_cents, average_cost_cents, safety_stock_qty, warranty_months, price, image, platform, refreshed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))').bind(context.userId, context.storeId, context.userId, context.userId, category.name, categoryId, brandId, sku, body.name.trim(), itemType, status, serialized, salable, purchasable, reference, defaultPrice, min, purchase, average, safety, warrantyMonths, defaultPrice / 100, body.image || '', body.platform || '', new Date().toISOString())
      const details = { sku, name: body.name.trim(), category: category.name, categoryId, brandId, itemType, status, isSerialized: serialized, isSalable: salable, isPurchasable: purchasable, referencePriceCents: reference, defaultPriceCents: defaultPrice, minPriceCents: min, safetyStockQty: safety, purchasePriceCents: hasCostView(context) ? purchase : undefined, averageCostCents: hasCostView(context) ? average : undefined }
      const batchResult = await env.DB.batch([created, auditLastInsertStatement(env, context, 'product.created', 'hardware', details)])
      return json({ ok: true, id: batchResult[0].meta.last_row_id }, 201)
    }

    if (req.method === 'PUT' && productId) {
      const current = await env.DB.prepare('SELECT * FROM hardware WHERE id=? AND store_id=?').bind(productId, context.storeId).first<Record<string, any>>()
      if (!current) return json({ error: '商品不存在' }, 404)
      if (isStatusRoute) {
        if (!['active', 'disabled'].includes(body.status || '')) return json({ error: '状态只能是active或disabled' }, 400)
        await env.DB.batch([
          env.DB.prepare("UPDATE hardware SET status=?, updated_by=?, updated_at=datetime('now') WHERE id=? AND store_id=?").bind(body.status, context.userId, productId, context.storeId),
          auditStatement(env, context, 'product.status_updated', 'hardware', productId, { status: { before: current.status, after: body.status } }),
        ])
        return json({ ok: true })
      }
      const categoryId = body.categoryId === undefined ? current.category_id : asNonNegativeInteger(body.categoryId, 'categoryId', 0)
      const category = await requireActiveCategory(env, context, categoryId)
      const brandId = body.brandId === undefined ? current.brand_id : (body.brandId == null ? null : asNonNegativeInteger(body.brandId, 'brandId', 0)); await requireActiveBrand(env, context, brandId)
      const itemType = body.itemType || current.item_type; if (!['product', 'service'].includes(itemType)) return json({ error: '商品类型无效' }, 400)
      const sku = body.sku === undefined ? current.sku : normalizeSku(body.sku)
      const status = body.status || current.status; if (!['active', 'disabled'].includes(status)) return json({ error: '状态无效' }, 400)
      if (body.purchasePriceCents !== undefined || body.averageCostCents !== undefined) { if (!hasCostView(context)) return json({ error: '无查看或维护成本权限' }, 403) }
      const serialized = itemType === 'service' ? 0 : asBooleanInt(body.isSerialized, current.is_serialized); const salable = asBooleanInt(body.isSalable, current.is_salable); const purchasable = itemType === 'service' ? 0 : asBooleanInt(body.isPurchasable, current.is_purchasable)
      const reference = asNonNegativeInteger(body.referencePriceCents, 'referencePriceCents', current.reference_price_cents); const defaultPrice = asNonNegativeInteger(body.defaultPriceCents, 'defaultPriceCents', current.default_price_cents); const min = asNonNegativeInteger(body.minPriceCents, 'minPriceCents', current.min_price_cents); const purchase = asNonNegativeInteger(body.purchasePriceCents, 'purchasePriceCents', current.purchase_price_cents); const average = asNonNegativeInteger(body.averageCostCents, 'averageCostCents', current.average_cost_cents);       const safety = itemType === 'service' ? 0 : asNonNegativeInteger(body.safetyStockQty, 'safetyStockQty', current.safety_stock_qty)
      const warrantyMonths = itemType === 'service' ? 36 : Math.max(1, asNonNegativeInteger(body.warrantyMonths, 'warrantyMonths', current.warranty_months ?? 36))
      const nextName = body.name?.trim() || current.name
      const changed = {
        category: categoryId !== current.category_id || category.name !== current.category ? { before: { id: current.category_id, name: current.category }, after: { id: categoryId, name: category.name } } : undefined,
        brandId: brandId !== current.brand_id ? { before: current.brand_id, after: brandId } : undefined,
        name: nextName !== current.name ? { before: current.name, after: nextName } : undefined,
        sku: sku !== current.sku ? { before: current.sku, after: sku } : undefined,
        itemType: itemType !== current.item_type ? { before: current.item_type, after: itemType } : undefined,
        status: status !== current.status ? { before: current.status, after: status } : undefined,
        isSerialized: serialized !== current.is_serialized ? { before: current.is_serialized, after: serialized } : undefined,
        isSalable: salable !== current.is_salable ? { before: current.is_salable, after: salable } : undefined,
        isPurchasable: purchasable !== current.is_purchasable ? { before: current.is_purchasable, after: purchasable } : undefined,
        referencePriceCents: reference !== current.reference_price_cents ? { before: current.reference_price_cents, after: reference } : undefined,
        defaultPriceCents: defaultPrice !== current.default_price_cents ? { before: current.default_price_cents, after: defaultPrice } : undefined,
        minPriceCents: min !== current.min_price_cents ? { before: current.min_price_cents, after: min } : undefined,
        safetyStockQty: safety !== current.safety_stock_qty ? { before: current.safety_stock_qty, after: safety } : undefined,
        warrantyMonths: warrantyMonths !== (current.warranty_months ?? 36) ? { before: current.warranty_months ?? 36, after: warrantyMonths } : undefined,
        purchasePriceCents: hasCostView(context) && purchase !== current.purchase_price_cents ? { before: current.purchase_price_cents, after: purchase } : undefined,
        averageCostCents: hasCostView(context) && average !== current.average_cost_cents ? { before: current.average_cost_cents, after: average } : undefined,
      }
      const update = env.DB.prepare("UPDATE hardware SET category=?, category_id=?, brand_id=?, sku=?, name=?, item_type=?, status=?, is_serialized=?, is_salable=?, is_purchasable=?, reference_price_cents=?, default_price_cents=?, min_price_cents=?, purchase_price_cents=?, average_cost_cents=?, safety_stock_qty=?, warranty_months=?, price=?, image=?, platform=?, updated_by=?, refreshed_at=?, updated_at=datetime('now') WHERE id=? AND store_id=?").bind(category.name, categoryId, brandId, sku, nextName, itemType, status, serialized, salable, purchasable, reference, defaultPrice, min, purchase, average, safety, warrantyMonths, defaultPrice / 100, body.image ?? current.image, body.platform ?? current.platform, context.userId, new Date().toISOString(), productId, context.storeId)
      const statements = [update]
      if (Object.values(changed).some(Boolean)) statements.push(auditStatement(env, context, 'product.updated', 'hardware', productId, changed))
      await env.DB.batch(statements)
      return json({ ok: true })
    }
  } catch (error: any) {
    const message = error.message || '商品数据无效'
    if (/UNIQUE constraint failed: hardware\.store_id, hardware\.sku/i.test(message)) return json({ error: '当前门店的SKU已存在' }, 409)
    return json({ error: message }, 400)
  }
  return json({ error: 'Not found' }, 404)
}

async function handleProductReference(req: Request, env: Env, context: AuthContext, type: 'categories' | 'brands'): Promise<Response> {
  const denied = requirePermission(context, req.method === 'GET' ? 'library/view' : 'library/edit')
  if (denied) return denied
  const table = type === 'categories' ? 'product_categories' : 'product_brands'
  const path = new URL(req.url).pathname; const idMatch = path.match(/\/(\d+)$/); const id = idMatch ? Number(idMatch[1]) : null
  if (req.method === 'GET') {
    const includeDisabled = new URL(req.url).searchParams.get('includeDisabled') === '1'
    const result = await env.DB.prepare(`SELECT * FROM ${table} WHERE store_id=?${includeDisabled ? '' : " AND status='active'"} ORDER BY ${type === 'categories' ? 'sort_order, name' : 'name'}`).bind(context.storeId).all()
    return json(result.results)
  }
  const body = await req.json<{ code?: string; name?: string; normalizedName?: string; sortOrder?: number; status?: string }>()
  try {
    if (req.method === 'POST' && !id) {
      const name = body.name?.trim(); if (!name) return json({ error: '名称不能为空' }, 400)
      const status = body.status || 'active'; if (!['active', 'disabled'].includes(status)) return json({ error: '状态无效' }, 400)
      const result = type === 'categories'
        ? await env.DB.prepare('INSERT INTO product_categories (store_id, code, name, sort_order, status, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(context.storeId, normalizeSku(body.code || name), name, asNonNegativeInteger(body.sortOrder, 'sortOrder', 0), status, context.userId, context.userId).run()
        : await env.DB.prepare('INSERT INTO product_brands (store_id, name, normalized_name, status, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)').bind(context.storeId, name, (body.normalizedName || name).trim().toLowerCase(), status, context.userId, context.userId).run()
      await audit(env, context, `product_${type.slice(0, -1)}.created`, table, result.meta.last_row_id, { name, status })
      return json({ ok: true, id: result.meta.last_row_id }, 201)
    }
    if (req.method === 'PUT' && id) {
      const current = await env.DB.prepare(`SELECT * FROM ${table} WHERE id=? AND store_id=?`).bind(id, context.storeId).first<Record<string, unknown>>()
      if (!current) return json({ error: '记录不存在' }, 404)
      const status = body.status || String(current.status); if (!['active', 'disabled'].includes(status)) return json({ error: '状态无效' }, 400)
      if (type === 'categories') await env.DB.prepare("UPDATE product_categories SET code=?, name=?, sort_order=?, status=?, updated_by=?, updated_at=datetime('now') WHERE id=? AND store_id=?").bind(body.code === undefined ? current.code : normalizeSku(body.code), body.name?.trim() || current.name, asNonNegativeInteger(body.sortOrder, 'sortOrder', Number(current.sort_order)), status, context.userId, id, context.storeId).run()
      else await env.DB.prepare("UPDATE product_brands SET name=?, normalized_name=?, status=?, updated_by=?, updated_at=datetime('now') WHERE id=? AND store_id=?").bind(body.name?.trim() || current.name, (body.normalizedName || body.name || current.normalized_name as string).trim().toLowerCase(), status, context.userId, id, context.storeId).run()
      await audit(env, context, `product_${type.slice(0, -1)}.updated`, table, id, { status })
      return json({ ok: true })
    }
  } catch (error: any) { return json({ error: error.message || '数据无效' }, 400) }
  return json({ error: 'Not found' }, 404)
}

// ── Hardware CRUD ──
async function handleLibrary(req: Request, env: Env, context: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const id = parts.length > 3 ? parts[3] : ''
  const method = req.method
  const needed = method === 'GET' ? 'library/view' : 'library/edit'
  const denied = requirePermission(context, needed)
  if (denied) return denied

  if (method === 'GET' && !id) {
    const category = url.searchParams.get('category') || ''
    const search = url.searchParams.get('search') || ''
    const includeDisabled = url.searchParams.get('includeDisabled') === '1'
    let sql = 'SELECT * FROM hardware WHERE (store_id=? OR (store_id IS NULL AND user_id=?))'
    const params: any[] = [context.storeId, context.userId]
    if (!includeDisabled) sql += " AND COALESCE(status, 'active')='active'"
    if (category) { sql += ' AND category = ?'; params.push(category) }
    if (search) { sql += ' AND name LIKE ?'; params.push(`%${search}%`) }
    const r = await env.DB.prepare(`${sql} ORDER BY category, name`).bind(...params).all()
    return json(r.results.map((row) => productResponse(context, row as Record<string, unknown>)))
  }
  if (method === 'POST' && !id) {
    const { items }: { items: Array<{ category: string; name: string; price: number; image?: string; platform?: string }> } = await req.json()
    if (!Array.isArray(items) || !items.length) return json({ error: '缺少硬件数据' }, 400)
    const categories = await prepareLegacyCategories(env, context, items.map((item) => item.category))
    const stmt = env.DB.prepare('INSERT INTO hardware (user_id, store_id, created_by, updated_by, category, category_id, name, price, default_price_cents, reference_price_cents, sku, image, platform, refreshed_at, updated_at) VALUES (?, ?, ?, ?, ?, (SELECT id FROM product_categories WHERE store_id=? AND name=? AND status=\'active\'), ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))')
    const batch = []
    for (const category of categories.values()) {
      if (!category.isNew) continue
      batch.push(createLegacyCategoryStatement(env, context, category))
    }
    const createdDetails: Array<Record<string, unknown>> = []
    for (const item of items) {
      if (!item.name?.trim()) return json({ error: '硬件名称不能为空' }, 400)
      const category = categories.get(item.category.trim())!
      const price = Number(item.price || 0)
      if (!Number.isFinite(price) || price < 0) return json({ error: '价格必须是非负数字' }, 400)
      const cents = Math.round(price * 100)
      batch.push(stmt.bind(context.userId, context.storeId, context.userId, context.userId, category.name, context.storeId, category.name, item.name.trim(), price, cents, cents, `LEGACY-${crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`, item.image || '', item.platform || '', new Date().toISOString()))
      createdDetails.push({ name: item.name.trim(), category: category.name, ...(category.id == null ? {} : { categoryId: category.id }), defaultPriceCents: cents })
    }
    batch.push(auditStatement(env, context, 'library.legacy_created', 'hardware', null, { count: items.length, items: createdDetails }))
    await env.DB.batch(batch)
    return json({ ok: true, count: items.length })
  }
  if (method === 'PUT' && id) {
    const body: Record<string, unknown> = await req.json()
    const current = await env.DB.prepare('SELECT * FROM hardware WHERE (store_id=? OR (store_id IS NULL AND user_id=?)) AND id=?').bind(context.storeId, context.userId, id).first<Record<string, any>>()
    if (!current) return json({ error: '硬件不存在' }, 404)
    const sets: string[] = []; const values: unknown[] = []
    const changed: Record<string, unknown> = {}
    let resolvedCategory: LegacyCategory | null = null
    if (body.category !== undefined) {
      resolvedCategory = (await prepareLegacyCategories(env, context, [body.category])).values().next().value!
      sets.push('category=?', "category_id=(SELECT id FROM product_categories WHERE store_id=? AND name=? AND status='active')"); values.push(resolvedCategory.name, context.storeId, resolvedCategory.name)
      if (current.category !== resolvedCategory.name || (resolvedCategory.id != null && current.category_id !== resolvedCategory.id)) changed.category = { before: { name: current.category, id: current.category_id }, after: { name: resolvedCategory.name, ...(resolvedCategory.id == null ? {} : { id: resolvedCategory.id }) } }
    }
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) return json({ error: '硬件名称不能为空' }, 400)
      sets.push('name=?'); values.push(body.name.trim())
      if (body.name.trim() !== current.name) changed.name = { before: current.name, after: body.name.trim() }
    }
    if (body.price !== undefined) {
      const price = Number(body.price)
      if (!Number.isFinite(price) || price < 0) return json({ error: '价格必须是非负数字' }, 400)
      const cents = Math.round(price * 100)
      sets.push('price=?', 'default_price_cents=?'); values.push(price, cents)
      if (Number(current.price) !== price) changed.defaultPriceCents = { before: current.default_price_cents, after: cents }
    }
    for (const key of ['image', 'platform', 'refreshed_at']) if (body[key] !== undefined) { sets.push(`${key}=?`); values.push(body[key]) }
    if (!sets.length) return json({ error: '无更新字段' }, 400)
    sets.push('updated_by=?', 'refreshed_at=?', "updated_at=datetime('now')"); values.push(context.userId, new Date().toISOString(), context.storeId, context.userId, id)
    const update = env.DB.prepare(`UPDATE hardware SET ${sets.join(',')} WHERE (store_id=? OR (store_id IS NULL AND user_id=?)) AND id=?`).bind(...values)
    const statements = []
    if (resolvedCategory?.isNew) statements.push(createLegacyCategoryStatement(env, context, resolvedCategory))
    statements.push(update)
    if (Object.keys(changed).length) statements.push(auditStatement(env, context, 'library.legacy_updated', 'hardware', id, changed))
    await env.DB.batch(statements)
    return json({ ok: true })
  }
  if (method === 'DELETE' && id) {
    const current = await env.DB.prepare('SELECT status FROM hardware WHERE (store_id=? OR (store_id IS NULL AND user_id=?)) AND id=?').bind(context.storeId, context.userId, id).first<{ status: string }>()
    if (!current) return json({ error: '硬件不存在' }, 404)
    await env.DB.batch([
      env.DB.prepare("UPDATE hardware SET status='disabled', updated_by=?, updated_at=datetime('now') WHERE (store_id=? OR (store_id IS NULL AND user_id=?)) AND id=?").bind(context.userId, context.storeId, context.userId, id),
      auditStatement(env, context, 'library.legacy_disabled', 'hardware', id, { status: { before: current.status || 'active', after: 'disabled' } }),
    ])
    return json({ ok: true })
  }
  return json({ error: 'Not found' }, 404)
}

// ── Auth routes ──
async function activeStores(env: Env, userId: number) {
  return env.DB.prepare(`SELECT s.id, s.name, m.id AS memberId, m.is_owner AS isOwner FROM store_members m JOIN stores s ON s.id=m.store_id WHERE m.user_id=? AND m.status='active' AND s.status='active' ORDER BY s.id`).bind(userId).all<{ id: number; name: string; memberId: number; isOwner: number }>()
}

async function handleAuth(req: Request, env: Env): Promise<Response> {
  const path = new URL(req.url).pathname.replace('/api/auth', '')
  if (path === '/register' && req.method === 'POST') return json({ error: '请联系门店管理员邀请加入' }, 403)

  if (path === '/login' && req.method === 'POST') {
    const { email, password }: { email?: string; password?: string } = await req.json()
    const user = await env.DB.prepare('SELECT id, email, password_hash, status, token_version FROM users WHERE email=?').bind(email || '').first<UserRecord>()
    if (!user || !(await verifyPassword(password || '', user.password_hash))) return json({ error: '邮箱或密码错误' }, 401)
    if (user.status !== 'active') return json({ error: '账号已停用' }, 403)
    if (!user.password_hash.includes(':')) await env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(await hashPassword(password || ''), user.id).run()
    const stores = await activeStores(env, user.id)
    const current = stores.results[0]
    if (!current) return json({ error: '没有可用门店，请联系门店管理员' }, 403)
    return json({ ok: true, token: await issueToken(env, user, current.id), email: user.email, stores: stores.results, currentStoreId: current.id })
  }

  if (path === '/accept-invitation' && req.method === 'POST') {
    const { token, password }: { token?: string; password?: string } = await req.json()
    if (!token || !password || password.length < 6) return json({ error: '邀请码和至少6位密码不能为空' }, 400)

    const invite = await env.DB.prepare(`SELECT id, store_id, email, role_id, status, expires_at, created_by
      FROM member_invites WHERE token=?`).bind(token.trim()).first<{ id: number; store_id: number; email: string; role_id: number | null; status: string; expires_at: string; created_by: number }>()
    if (!invite) return json({ error: '邀请码无效' }, 404)
    if (invite.status !== 'pending') return json({ error: invite.status === 'accepted' ? '该邀请码已被使用' : '该邀请码不可用' }, 409)
    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      await env.DB.prepare("UPDATE member_invites SET status='expired' WHERE id=? AND status='pending'").bind(invite.id).run()
      return json({ error: '邀请码已过期，请联系管理员重新创建' }, 410)
    }

    const store = await env.DB.prepare("SELECT id FROM stores WHERE id=? AND status='active'").bind(invite.store_id).first<{ id: number }>()
    if (!store) return json({ error: '邀请所在门店已不可用，请联系管理员' }, 403)

    let user = await env.DB.prepare('SELECT id, email, password_hash, status, token_version FROM users WHERE email=?').bind(invite.email).first<UserRecord>()
    if (user) {
      if (user.status !== 'active') return json({ error: '该账号已停用，请联系管理员' }, 403)
      if (!(await verifyPassword(password, user.password_hash))) return json({ error: '该邮箱已有账号，请输入该账号的正确密码' }, 401)
      if (!user.password_hash.includes(':')) {
        const passwordHash = await hashPassword(password)
        await env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(passwordHash, user.id).run()
        user = { ...user, password_hash: passwordHash }
      }
    } else {
      const created = await env.DB.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').bind(invite.email, await hashPassword(password)).run()
      user = await env.DB.prepare('SELECT id, email, password_hash, status, token_version FROM users WHERE id=?').bind(created.meta.last_row_id).first<UserRecord>()!
    }
    const acceptedUser = user!

    const existingMember = await env.DB.prepare('SELECT id FROM store_members WHERE store_id=? AND user_id=?').bind(invite.store_id, acceptedUser.id).first<{ id: number }>()
    if (existingMember) return json({ error: '该账号已是当前门店成员，请直接登录或切换门店' }, 409)

    const role = invite.role_id
      ? await env.DB.prepare('SELECT id FROM roles WHERE id=? AND store_id=?').bind(invite.role_id, invite.store_id).first<{ id: number }>()
      : await env.DB.prepare("SELECT id FROM roles WHERE store_id=? AND code='sales'").bind(invite.store_id).first<{ id: number }>()
    if (!role) return json({ error: '邀请角色不可用，请联系管理员重新创建邀请' }, 409)

    const memberResult = await env.DB.prepare("INSERT INTO store_members (store_id, user_id, status, created_by, updated_by) VALUES (?, ?, 'active', ?, ?)")
      .bind(invite.store_id, acceptedUser.id, invite.created_by, invite.created_by).run()
    const memberId = Number(memberResult.meta.last_row_id)
    await env.DB.batch([
      env.DB.prepare('INSERT INTO member_roles (member_id, role_id) VALUES (?, ?)').bind(memberId, role.id),
      env.DB.prepare("UPDATE member_invites SET status='accepted', accepted_at=datetime('now') WHERE id=? AND status='pending'").bind(invite.id),
    ])
    await auditInviteAcceptance(env, invite, acceptedUser.id, memberId)
    return json({ ok: true, token: await issueToken(env, acceptedUser, invite.store_id), email: acceptedUser.email, currentStoreId: invite.store_id })
  }

  const context = await auth(req, env)
  if (context instanceof Response) return context
  if (path === '/me' && req.method === 'GET') {
    const user = await env.DB.prepare('SELECT id, email FROM users WHERE id=?').bind(context.userId).first<{ id: number; email: string }>()
    const stores = await activeStores(env, context.userId)
    return json({ user, stores: stores.results, currentStoreId: context.storeId, memberId: context.memberId, roles: context.roles, permissions: context.permissions })
  }
  if (path === '/select-store' && req.method === 'POST') {
    const { storeId }: { storeId?: number } = await req.json()
    if (!Number.isInteger(storeId)) return json({ error: '缺少门店ID' }, 400)
    const user = await env.DB.prepare('SELECT id, email, token_version FROM users WHERE id=?').bind(context.userId).first<Pick<UserRecord, 'id' | 'email' | 'token_version'>>()
    const next = await loadAuthContext(env, context.userId, storeId!, user!.token_version)
    if (next instanceof Response) return next
    return json({ ok: true, token: await issueToken(env, user!, storeId!), storeId: next.storeId })
  }
  if (path === '/change-password' && req.method === 'PUT') {
    const { oldPassword, newPassword }: { oldPassword?: string; newPassword?: string } = await req.json()
    if (!oldPassword || !newPassword || newPassword.length < 6) return json({ error: '新密码至少6位' }, 400)
    const user = await env.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(context.userId).first<{ password_hash: string }>()
    if (!user || !(await verifyPassword(oldPassword, user.password_hash))) return json({ error: '旧密码错误' }, 401)
    await env.DB.prepare('UPDATE users SET password_hash=?, token_version=token_version+1 WHERE id=?').bind(await hashPassword(newPassword), context.userId).run()
    return json({ ok: true })
  }
  return json({ error: 'Not found' }, 404)
}

// ── Templates CRUD ──
async function handleTemplates(req: Request, env: Env, context: AuthContext): Promise<Response> {
  const denied = requirePermission(context, req.method === 'GET' ? 'template/view' : 'template/edit')
  if (denied) return denied
  if (req.method === 'GET') {
    const result = await env.DB.prepare('SELECT id, name, data, updated_at FROM templates WHERE (store_id=? OR (store_id IS NULL AND user_id=?)) ORDER BY updated_at DESC').bind(context.storeId, context.userId).all()
    return json(result.results)
  }
  const body: { id?: number; name?: string; data?: unknown } = await req.json()
  if (req.method === 'POST') {
    if (!body.name) return json({ error: '模板名称不能为空' }, 400)
    const result = await env.DB.prepare('INSERT INTO templates (user_id, store_id, created_by, updated_by, name, data) VALUES (?, ?, ?, ?, ?, ?)').bind(context.userId, context.storeId, context.userId, context.userId, body.name, JSON.stringify(body.data)).run()
    return json({ ok: true, id: result.meta.last_row_id })
  }
  if (!body.id) return json({ error: '缺少模板ID' }, 400)
  if (req.method === 'PUT') {
    await env.DB.prepare('UPDATE templates SET name=?, data=?, updated_by=?, updated_at=datetime(\'now\') WHERE (store_id=? OR (store_id IS NULL AND user_id=?)) AND id=?').bind(body.name, JSON.stringify(body.data), context.userId, context.storeId, context.userId, body.id).run()
    return json({ ok: true })
  }
  if (req.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM templates WHERE (store_id=? OR (store_id IS NULL AND user_id=?)) AND id=?').bind(context.storeId, context.userId, body.id).run()
    return json({ ok: true })
  }
  return json({ error: 'Not found' }, 404)
}

// ── Quotes CRUD ──
async function handleQuotes(req: Request, env: Env, context: AuthContext): Promise<Response> {
  const denied = requirePermission(context, req.method === 'GET' ? 'quote/view' : 'quote/edit')
  if (denied) return denied
  if (req.method === 'GET') {
    const row = await env.DB.prepare('SELECT id, title, data, updated_at FROM quotes WHERE (store_id=? OR (store_id IS NULL AND user_id=?)) ORDER BY updated_at DESC LIMIT 1').bind(context.storeId, context.userId).first<{ id: number; title: string; data: string; updated_at: string }>()
    return json(row ? { ...row, data: restrictFinancialData(context, row.data) } : null)
  }
  if (req.method === 'POST') {
    const { title, data }: { title?: string; data?: unknown } = await req.json()
    if (data == null) return json({ error: '缺少配置数据' }, 400)
    const existing = await env.DB.prepare('SELECT id FROM quotes WHERE store_id=? OR (store_id IS NULL AND user_id=?) ORDER BY updated_at DESC LIMIT 1').bind(context.storeId, context.userId).first<{ id: number }>()
    if (existing) await env.DB.prepare('UPDATE quotes SET title=?, data=?, store_id=?, updated_by=?, updated_at=datetime(\'now\') WHERE id=?').bind(title || '未命名方案', JSON.stringify(data), context.storeId, context.userId, existing.id).run()
    else await env.DB.prepare('INSERT INTO quotes (user_id, store_id, created_by, updated_by, title, data) VALUES (?, ?, ?, ?, ?, ?)').bind(context.userId, context.storeId, context.userId, context.userId, title || '未命名方案', JSON.stringify(data)).run()
    return json({ ok: true })
  }
  return json({ error: 'Not found' }, 404)
}

async function handleStores(req: Request, env: Env, context: AuthContext): Promise<Response> {
  if (req.method === 'GET') {
    const store = await env.DB.prepare('SELECT id, name, status, created_at, updated_at FROM stores WHERE id=?').bind(context.storeId).first()
    return json(store || null)
  }
  const denied = requirePermission(context, 'store/manage')
  if (denied) return denied
  if (req.method === 'PUT') {
    const { name, status }: { name?: string; status?: string } = await req.json()
    if (!name && !status) return json({ error: '无更新字段' }, 400)
    if (status && !['active', 'disabled'].includes(status)) return json({ error: '无效门店状态' }, 400)
    await env.DB.prepare('UPDATE stores SET name=COALESCE(?, name), status=COALESCE(?, status), updated_by=?, updated_at=datetime(\'now\') WHERE id=?').bind(name || null, status || null, context.userId, context.storeId).run()
    await audit(env, context, 'store.updated', 'store', context.storeId, { name, status })
    return json({ ok: true })
  }
  return json({ error: 'Not found' }, 404)
}

async function handleMembers(req: Request, env: Env, context: AuthContext): Promise<Response> {
  const path = new URL(req.url).pathname
  if (req.method === 'GET' && path === '/api/members') {
    const denied = requirePermission(context, 'member/manage')
    if (denied) return denied
    const result = await env.DB.prepare(`SELECT m.id, m.user_id AS userId, u.email, m.status, m.is_owner AS isOwner, GROUP_CONCAT(r.code) AS roles FROM store_members m JOIN users u ON u.id=m.user_id LEFT JOIN member_roles mr ON mr.member_id=m.id LEFT JOIN roles r ON r.id=mr.role_id WHERE m.store_id=? GROUP BY m.id ORDER BY m.is_owner DESC, u.email`).bind(context.storeId).all()
    return json(result.results)
  }
  const denied = requirePermission(context, 'member/manage')
  if (denied) return denied
  if (req.method === 'POST' && path === '/api/members/invitations') {
    const { email, roleId, expiresAt }: { email?: string; roleId?: number; expiresAt?: string } = await req.json()
    if (!email) return json({ error: '缺少邀请邮箱' }, 400)
    if (roleId) {
      const role = await env.DB.prepare('SELECT id FROM roles WHERE id=? AND store_id=?').bind(roleId, context.storeId).first()
      if (!role) return json({ error: '角色不属于当前门店' }, 400)
    }
    const token = crypto.randomUUID().replace(/-/g, '')
    const expires = expiresAt || new Date(Date.now() + 7 * 86400000).toISOString()
    await env.DB.prepare('INSERT INTO member_invites (store_id, email, role_id, token, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?)').bind(context.storeId, email, roleId || null, token, expires, context.userId).run()
    await audit(env, context, 'member.invited', 'member_invite', token, { email, roleId: roleId || null })
    return json({ ok: true, token, expiresAt: expires })
  }
  const targetId = Number(path.split('/').pop())
  if (!Number.isInteger(targetId)) return json({ error: '成员ID无效' }, 400)
  const target = await env.DB.prepare('SELECT id, is_owner FROM store_members WHERE id=? AND store_id=?').bind(targetId, context.storeId).first<{ id: number; is_owner: number }>()
  if (!target) return json({ error: '成员不存在' }, 404)
  if (target.is_owner === 1) return json({ error: '店主不可被停用、移除或降权' }, 403)
  if (req.method === 'PUT') {
    const { status, roleIds }: { status?: string; roleIds?: number[] } = await req.json()
    if (status && !['active', 'disabled'].includes(status)) return json({ error: '无效成员状态' }, 400)
    if (status) await env.DB.prepare('UPDATE store_members SET status=?, updated_by=?, updated_at=datetime(\'now\') WHERE id=?').bind(status, context.userId, targetId).run()
    if (roleIds) {
      const valid = await env.DB.prepare(`SELECT id FROM roles WHERE store_id=? AND id IN (${roleIds.map(() => '?').join(',') || 'NULL'})`).bind(context.storeId, ...roleIds).all<{ id: number }>()
      if (valid.results.length !== roleIds.length) return json({ error: '角色不属于当前门店' }, 400)
      await env.DB.prepare('DELETE FROM member_roles WHERE member_id=?').bind(targetId).run()
      if (roleIds.length) await env.DB.batch(roleIds.map((roleId) => env.DB.prepare('INSERT INTO member_roles (member_id, role_id) VALUES (?, ?)').bind(targetId, roleId)))
    }
    await audit(env, context, 'member.updated', 'store_member', targetId, { status, roleIds })
    return json({ ok: true })
  }
  if (req.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM member_roles WHERE member_id=?').bind(targetId).run()
    await env.DB.prepare('DELETE FROM store_members WHERE id=? AND store_id=?').bind(targetId, context.storeId).run()
    await audit(env, context, 'member.removed', 'store_member', targetId)
    return json({ ok: true })
  }
  return json({ error: 'Not found' }, 404)
}

async function handleRoles(env: Env, context: AuthContext): Promise<Response> {
  const denied = requirePermission(context, 'role/view')
  if (denied) return denied
  const result = await env.DB.prepare(`SELECT r.id, r.code, r.name, GROUP_CONCAT(p.code) AS permissions FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN permissions p ON p.id=rp.permission_id WHERE r.store_id=? GROUP BY r.id ORDER BY r.id`).bind(context.storeId).all()
  return json(result.results)
}

// ── Orders and collections ──
type OrderQuoteItemInput = {
  id?: string | number; cloudId?: number; libraryItemId?: string | number; sourceItemId?: number
  category?: string; name?: string; details?: string; quantity?: number; unitPrice?: number; unitPriceCents?: number
}
type OrderInput = {
  meta?: { customerName?: string; contactName?: string; contactPhone?: string; customerAddress?: string; projectTitle?: string }
  quoteItems?: OrderQuoteItemInput[]; notes?: unknown; brand?: unknown; remark?: string
}

const FULFILLMENT_STATUSES = ['pending_purchase', 'preparing', 'pending_delivery', 'delivered', 'cancelled']

function orderNumber(): string {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).replace(/-/g, '')
  return `SO-${date}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
}

function orderString(value: unknown, field: string, maxLength = 500): string {
  if (value == null) return ''
  if (typeof value !== 'string') throw new Error(`${field}必须是文本`)
  const result = value.trim()
  if (result.length > maxLength) throw new Error(`${field}长度不能超过${maxLength}字符`)
  return result
}

function parseOrderItems(items: unknown): Array<{ category: string; name: string; details: string; quantity: number; unitPriceCents: number; lineTotalCents: number; sourceItemId: number | null }> {
  if (!Array.isArray(items) || !items.length) throw new Error('至少需要一条报价明细')
  if (items.length > 200) throw new Error('报价明细不能超过200条')
  return items.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`第${index + 1}条明细无效`)
    const item = raw as OrderQuoteItemInput
    const name = orderString(item.name, `第${index + 1}条明细名称`, 200)
    if (!name) throw new Error(`第${index + 1}条明细名称不能为空`)
    const quantity = item.quantity
    if (!Number.isInteger(quantity) || quantity! <= 0 || quantity! > 100000) throw new Error(`第${index + 1}条明细数量必须是1至100000的整数`)
    const cents = item.unitPriceCents === undefined
      ? (typeof item.unitPrice === 'number' && Number.isFinite(item.unitPrice) ? Math.round(item.unitPrice * 100) : NaN)
      : item.unitPriceCents
    if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`第${index + 1}条明细单价必须为非负整数分`)
    const lineTotalCents = cents * quantity
    if (!Number.isSafeInteger(lineTotalCents)) throw new Error(`第${index + 1}条明细金额过大`)
    const candidateId = item.sourceItemId ?? item.cloudId
    const sourceItemId = Number.isInteger(candidateId) && Number(candidateId) > 0 ? Number(candidateId) : null
    return { category: orderString(item.category, `第${index + 1}条明细分类`, 100), name, details: orderString(item.details, `第${index + 1}条明细详情`, 1000), quantity, unitPriceCents: cents, lineTotalCents, sourceItemId }
  })
}

async function handleOrders(req: Request, env: Env, context: AuthContext): Promise<Response> {
  const path = new URL(req.url).pathname
  const match = path.match(/^\/api\/orders\/(\d+)(?:\/(payments|status))?$/)
  const orderId = match ? Number(match[1]) : null
  const operation = match?.[2] || null
  const denied = requirePermission(context, req.method === 'GET' ? 'quote/view' : 'quote/edit')
  if (denied) return denied

  if (req.method === 'GET' && !orderId) {
    const result = await env.DB.prepare(`SELECT id, order_no, customer_name, customer_phone, project_title, total_amount_cents, received_amount_cents, payment_status, fulfillment_status, remark, created_at, updated_at
      FROM orders WHERE store_id=? ORDER BY created_at DESC, id DESC`).bind(context.storeId).all()
    return json({ items: result.results })
  }
  if (req.method === 'GET' && orderId && !operation) {
    const order = await env.DB.prepare('SELECT * FROM orders WHERE id=? AND store_id=?').bind(orderId, context.storeId).first<Record<string, unknown>>()
    if (!order) return json({ error: '订单不存在' }, 404)
    const [items, payments] = await Promise.all([
      env.DB.prepare('SELECT id, category, name, details, quantity, unit_price_cents, line_total_cents, source_item_id, created_at FROM order_items WHERE order_id=? ORDER BY id').bind(orderId).all(),
      env.DB.prepare('SELECT id, amount_cents, payment_method, paid_at, remark, created_by, created_at FROM order_payments WHERE order_id=? AND store_id=? ORDER BY paid_at DESC, id DESC').bind(orderId, context.storeId).all(),
    ])
    return json({ ...order, items: items.results, payments: payments.results })
  }

  if (req.method === 'POST' && !orderId) {
    try {
      const body = await req.json<OrderInput>()
      const items = parseOrderItems(body.quoteItems)
      const totalAmountCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0)
      if (!Number.isSafeInteger(totalAmountCents)) return json({ error: '订单总金额过大' }, 400)
      const meta = body.meta || {}
      const customerName = orderString(meta.customerName || meta.contactName, '客户名称', 200)
      if (!customerName) return json({ error: '客户名称不能为空' }, 400)
      const customerPhone = orderString(meta.contactPhone, '客户电话', 100)
      const customerAddress = orderString(meta.customerAddress, '客户地址', 500)
      const projectTitle = orderString(meta.projectTitle, '项目名称', 200)
      const remark = orderString(body.remark, '备注', 2000)
      const snapshot = JSON.stringify({ meta, quoteItems: body.quoteItems, notes: body.notes, brand: body.brand, remark })
      if (snapshot.length > 500000) return json({ error: '报价快照过大' }, 400)
      const sourceItemIds = [...new Set(items.flatMap((item) => item.sourceItemId === null ? [] : [item.sourceItemId]))]
      if (sourceItemIds.length) {
        const placeholders = sourceItemIds.map(() => '?').join(', ')
        const validSources = await env.DB.prepare(`SELECT id FROM hardware WHERE store_id=? AND id IN (${placeholders})`).bind(context.storeId, ...sourceItemIds).all<{ id: number }>()
        const validSourceIds = new Set(validSources.results.map((source) => source.id))
        for (const item of items) {
          if (item.sourceItemId !== null && !validSourceIds.has(item.sourceItemId)) item.sourceItemId = null
        }
      }
      const no = orderNumber()
      const statements: D1PreparedStatement[] = [
        env.DB.prepare(`INSERT INTO orders (store_id, order_no, quote_snapshot, customer_name, customer_phone, customer_address, project_title, total_amount_cents, remark, created_by, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(context.storeId, no, snapshot, customerName, customerPhone, customerAddress, projectTitle, totalAmountCents, remark, context.userId, context.userId),
      ]
      for (const item of items) statements.push(env.DB.prepare(`INSERT INTO order_items (order_id, category, name, details, quantity, unit_price_cents, line_total_cents, source_item_id)
        VALUES ((SELECT id FROM orders WHERE store_id=? AND order_no=?), ?, ?, ?, ?, ?, ?, ?)`)
        .bind(context.storeId, no, item.category, item.name, item.details, item.quantity, item.unitPriceCents, item.lineTotalCents, item.sourceItemId))
      statements.push(auditStatement(env, context, 'order.created', 'order', no, { orderNo: no, totalAmountCents, itemCount: items.length }))
      const result = await env.DB.batch(statements)
      return json({ ok: true, id: result[0].meta.last_row_id, orderNo: no }, 201)
    } catch (error: any) { return json({ error: error.message || '订单数据无效' }, 400) }
  }

  if (req.method === 'POST' && orderId && operation === 'payments') {
    try {
      const body = await req.json<{ amountCents?: number; paymentMethod?: string; paidAt?: string; remark?: string }>()
      if (!Number.isSafeInteger(body.amountCents) || body.amountCents! <= 0) return json({ error: '收款金额必须为正整数分' }, 400)
      const paymentMethod = orderString(body.paymentMethod, '收款方式', 50)
      if (!paymentMethod) return json({ error: '收款方式不能为空' }, 400)
      const paidAt = body.paidAt ? new Date(body.paidAt) : new Date()
      if (Number.isNaN(paidAt.getTime())) return json({ error: '收款时间无效' }, 400)
      const order = await env.DB.prepare('SELECT id FROM orders WHERE id=? AND store_id=?').bind(orderId, context.storeId).first<{ id: number }>()
      if (!order) return json({ error: '订单不存在' }, 404)
      const remark = orderString(body.remark, '收款备注', 1000)
      await env.DB.batch([
        env.DB.prepare('INSERT INTO order_payments (store_id, order_id, amount_cents, payment_method, paid_at, remark, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(context.storeId, orderId, body.amountCents, paymentMethod, paidAt.toISOString(), remark, context.userId),
        auditStatement(env, context, 'order.payment_recorded', 'order', orderId, { amountCents: body.amountCents, paymentMethod, paidAt: paidAt.toISOString() }),
      ])
      const updated = await env.DB.prepare('SELECT received_amount_cents, payment_status FROM orders WHERE id=? AND store_id=?').bind(orderId, context.storeId).first<{ received_amount_cents: number; payment_status: string }>()
      return json({ ok: true, receivedAmountCents: updated!.received_amount_cents, paymentStatus: updated!.payment_status })
    } catch (error: any) {
      const message = error.message || '收款数据无效'
      return json({ error: message.includes('payment exceeds') ? '收款金额不能超过订单应收金额，或订单已取消' : message }, 400)
    }
  }

  if (req.method === 'PUT' && orderId && operation === 'status') {
    try {
      const body = await req.json<{ fulfillmentStatus?: string }>()
      if (!FULFILLMENT_STATUSES.includes(body.fulfillmentStatus || '')) return json({ error: '订单状态无效' }, 400)
      const current = await env.DB.prepare('SELECT fulfillment_status FROM orders WHERE id=? AND store_id=?').bind(orderId, context.storeId).first<{ fulfillment_status: string }>()
      if (!current) return json({ error: '订单不存在' }, 404)
      if (current.fulfillment_status === 'cancelled') return json({ error: '已取消订单不可恢复状态' }, 409)
      if (current.fulfillment_status === 'delivered' && ['pending_purchase', 'preparing'].includes(body.fulfillmentStatus!)) {
        return json({ error: '已交付订单不能回退至采购或备货状态' }, 409)
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE orders SET fulfillment_status=?, updated_by=?, updated_at=datetime('now') WHERE id=? AND store_id=?").bind(body.fulfillmentStatus, context.userId, orderId, context.storeId),
        auditStatement(env, context, 'order.fulfillment_status_updated', 'order', orderId, { fulfillmentStatus: { before: current.fulfillment_status, after: body.fulfillmentStatus } }),
      ])
      return json({ ok: true })
    } catch (error: any) { return json({ error: error.message || '订单状态数据无效' }, 400) }
  }
  return json({ error: 'Not found' }, 404)
}

// ── SN management ──
type SNRegisterInput = { productId: unknown; snCodes: unknown; purchaseRef?: unknown; purchaseCostCents?: unknown; inboundAt?: unknown; warrantyMonths?: unknown }
type SNManualEntryInput = { productId: unknown; snCode: unknown; customerName: unknown; customerPhone: unknown; deliveredAt: unknown; warrantyMonths?: unknown; remark?: unknown }
type SNBindInput = { orderItemId: unknown; snIds: unknown }

function normalizeSNCode(value: unknown): string {
  if (typeof value !== 'string') throw new Error('SN码必须是文本')
  const code = value.trim().toUpperCase().replace(/\s+/g, '')
  if (!/^[A-Z0-9][A-Z0-9._:/-]{0,127}$/.test(code)) throw new Error('SN码仅支持字母、数字及 . _ : / -，长度1-128位')
  return code
}

function asSNDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field}必须是YYYY-MM-DD日期`)
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${field}不是有效日期`)
  return value
}

function asSNText(value: unknown, field: string, maxLength: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field}不能为空`)
    return ''
  }
  if (typeof value !== 'string') throw new Error(`${field}必须是文本`)
  const text = value.trim()
  if ((required && !text) || text.length > maxLength) throw new Error(`${field}${required ? '不能为空且' : ''}长度不能超过${maxLength}位`)
  return text
}

function asWarrantyMonths(value: unknown, fallback: number): number {
  const months = asNonNegativeInteger(value, 'warrantyMonths', fallback)
  if (months < 1 || months > 120) throw new Error('warrantyMonths必须是1-120之间的整数')
  return months
}

function warrantyExpiresOn(deliveredAt: string, months: number): string {
  const [year, month, day] = deliveredAt.split('-').map(Number)
  const targetMonth = month - 1 + months
  const targetYear = year + Math.floor(targetMonth / 12)
  const normalizedMonth = ((targetMonth % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate()
  return new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay))).toISOString().slice(0, 10)
}

async function handleSN(req: Request, env: Env, context: AuthContext): Promise<Response> {
  const denied = requirePermission(context, req.method === 'GET' ? 'library/view' : 'library/edit')
  if (denied) return denied

  const url = new URL(req.url)
  const path = url.pathname
  const segments = path.replace('/api/sn', '').split('/').filter(Boolean)
  const operation = segments[0] || ''
  const id = /^\d+$/.test(operation) ? Number(operation) : null

  // GET /api/sn/warranty-check?q=SN_OR_PHONE
  if (req.method === 'GET' && operation === 'warranty-check') {
    const q = (url.searchParams.get('q') || '').trim().toUpperCase()
    if (!q) return json({ error: '请输入SN码或客户手机号' }, 400)
    const results = await env.DB.prepare(
      `SELECT sn_code, product_id, status, current_customer_name, current_customer_phone, delivered_at, warranty_months, warranty_expires_on, remark
       FROM serial_numbers WHERE store_id=? AND (sn_code=? OR current_customer_phone=?)
       ORDER BY delivered_at DESC LIMIT 50`
    ).bind(context.storeId, q, q).all<{ sn_code: string; product_id: number; status: string; current_customer_name: string; current_customer_phone: string; delivered_at: string | null; warranty_months: number; warranty_expires_on: string | null; remark: string }>()
    const rows = results.results.map((row) => {
      let warrantyStatus: 'in_warranty' | 'expiring_soon' | 'expired' | 'not_sold' = 'not_sold'
      if (row.warranty_expires_on) {
        const expires = new Date(row.warranty_expires_on + 'T23:59:59Z')
        const now = new Date()
        const daysLeft = Math.ceil((expires.getTime() - now.getTime()) / 86400000)
        if (daysLeft <= 0) warrantyStatus = 'expired'
        else if (daysLeft <= 30) warrantyStatus = 'expiring_soon'
        else warrantyStatus = 'in_warranty'
      }
      return { snCode: row.sn_code, productId: row.product_id, status: row.status, customerName: row.current_customer_name, customerPhone: row.current_customer_phone, deliveredAt: row.delivered_at, warrantyMonths: row.warranty_months, warrantyExpiresOn: row.warranty_expires_on, warrantyStatus, remark: row.remark }
    })
    return json({ items: rows })
  }

  // GET /api/sn/:id — single SN with event timeline
  if (req.method === 'GET' && id) {
    const sn = await env.DB.prepare('SELECT * FROM serial_numbers WHERE id=? AND store_id=?').bind(id, context.storeId).first<Record<string, unknown>>()
    if (!sn) return json({ error: 'SN不存在' }, 404)
    const events = await env.DB.prepare('SELECT event_type, source_type, source_id, customer_name, occurred_at, remark FROM sn_events WHERE sn_id=? ORDER BY occurred_at DESC').bind(id).all()
    return json({ ...sn, events: events.results })
  }

  // GET /api/sn — list with search/filter
  if (req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim()
    const statusFilter = url.searchParams.get('status') || ''
    const warrantyFilter = url.searchParams.get('warranty') || ''
    const productId = Number(url.searchParams.get('productId')) || 0
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 20))
    const offset = (page - 1) * pageSize

    const conditions: string[] = ['sn.store_id=?']
    const params: (string | number)[] = [context.storeId]
    if (q) {
      conditions.push('(sn.sn_code LIKE ? OR sn.current_customer_phone LIKE ? OR sn.current_customer_name LIKE ?)')
      const like = `%${q}%`
      params.push(like, like, like)
    }
    if (statusFilter) { conditions.push('sn.status=?'); params.push(statusFilter) }
    if (warrantyFilter === 'in_warranty') conditions.push("sn.warranty_expires_on > date('now', '+30 days')")
    else if (warrantyFilter === 'expiring_soon') conditions.push("sn.warranty_expires_on >= date('now') AND sn.warranty_expires_on <= date('now', '+30 days')")
    else if (warrantyFilter === 'expired') conditions.push("sn.warranty_expires_on < date('now') AND sn.status='delivered'")
    else if (warrantyFilter === 'not_sold') conditions.push("sn.warranty_expires_on IS NULL")
    if (productId) { conditions.push('sn.product_id=?'); params.push(productId) }

    const where = conditions.join(' AND ')
    const [countRow, rows] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS total FROM serial_numbers sn WHERE ${where}`).bind(...params).first<{ total: number }>(),
      env.DB.prepare(`SELECT sn.*, h.name AS product_name FROM serial_numbers sn LEFT JOIN hardware h ON h.id=sn.product_id WHERE ${where} ORDER BY sn.updated_at DESC LIMIT ? OFFSET ?`).bind(...params, pageSize, offset).all<Record<string, unknown>>(),
    ])
    const total = countRow?.total || 0
    return json({ items: rows.results, total, page, pageSize })
  }

  // POST /api/sn/register/precheck — validate batch registration without writing data
  if (req.method === 'POST' && path === '/api/sn/register/precheck') {
    try {
      const body = await req.json<SNRegisterInput>()
      const productId = asNonNegativeInteger(body.productId, 'productId', 0)
      if (!productId || !Array.isArray(body.snCodes)) return json({ error: '缺少商品ID或SN列表' }, 400)
      const product = await env.DB.prepare('SELECT id, is_serialized FROM hardware WHERE id=? AND store_id=?').bind(productId, context.storeId).first<{ id: number; is_serialized: number }>()
      if (!product) return json({ error: '商品不存在' }, 404)
      if (!product.is_serialized) return json({ error: '该商品未启用SN管理' }, 400)

      const normalizedCodes = body.snCodes.map(normalizeSNCode)
      const inputDuplicates = normalizedCodes.filter((code, index) => normalizedCodes.indexOf(code) !== index)
      const uniqueCodes = [...new Set(normalizedCodes)]
      const overLimitCodes = uniqueCodes.slice(500)
      const checkCodes = uniqueCodes.slice(0, 500)
      const existingCodes = checkCodes.length === 0 ? [] : (await env.DB.prepare(
        `SELECT sn_code FROM serial_numbers WHERE store_id=? AND sn_code IN (${checkCodes.map(() => '?').join(', ')})`
      ).bind(context.storeId, ...checkCodes).all<{ sn_code: string }>()).results.map((row) => row.sn_code)
      const existingSet = new Set(existingCodes)
      const inputDuplicateSet = new Set(inputDuplicates)
      return json({
        total: normalizedCodes.length,
        validCodes: checkCodes.filter((code) => !inputDuplicateSet.has(code) && !existingSet.has(code)),
        inputDuplicates: [...inputDuplicateSet],
        existingCodes,
        overLimitCodes,
      })
    } catch (error: unknown) {
      return json({ error: error instanceof Error ? error.message : 'SN预检失败' }, 400)
    }
  }

  // POST /api/sn/register — batch inbound registration
  if (req.method === 'POST' && path === '/api/sn/register') {
    try {
      const body = await req.json<SNRegisterInput>()
      const productId = asNonNegativeInteger(body.productId, 'productId', 0)
      if (!productId || !Array.isArray(body.snCodes) || body.snCodes.length === 0) return json({ error: '缺少商品ID或SN列表' }, 400)
      if (body.snCodes.length > 500) return json({ error: '单次最多录入500条' }, 400)
      const codes = body.snCodes.map(normalizeSNCode)
      const uniqueCodes = [...new Set(codes)]
      const batchDuplicates = codes.filter((code, index) => codes.indexOf(code) !== index)
      if (batchDuplicates.length) return json({ error: 'SN列表含重复值', duplicates: [...new Set(batchDuplicates)] }, 400)

      const product = await env.DB.prepare('SELECT id, name, is_serialized, warranty_months FROM hardware WHERE id=? AND store_id=?').bind(productId, context.storeId).first<{ id: number; name: string; is_serialized: number; warranty_months: number }>()
      if (!product) return json({ error: '商品不存在' }, 404)
      if (!product.is_serialized) return json({ error: '该商品未启用SN管理' }, 400)

      // Check for existing duplicates
      const placeholders = codes.map(() => '?').join(', ')
      const existing = await env.DB.prepare(`SELECT sn_code FROM serial_numbers WHERE store_id=? AND sn_code IN (${placeholders})`).bind(context.storeId, ...codes).all<{ sn_code: string }>()
      const duplicateSet = new Set(existing.results.map((row) => row.sn_code))
      const duplicates = codes.filter((code) => duplicateSet.has(code))

      const warrantyMonths = asWarrantyMonths(body.warrantyMonths, product.warranty_months ?? 36)
      const purchaseRef = asSNText(body.purchaseRef, 'purchaseRef', 128)
      const costCents = asNonNegativeInteger(body.purchaseCostCents, 'purchaseCostCents', 0)
      const inboundAt = body.inboundAt === undefined || body.inboundAt === null ? new Date().toISOString().slice(0, 10) : asSNDate(body.inboundAt, 'inboundAt')

      const statements: D1PreparedStatement[] = []
      const insertedCodes: string[] = []
      for (const code of uniqueCodes) {
        if (duplicateSet.has(code)) continue
        statements.push(env.DB.prepare(
          `INSERT INTO serial_numbers (store_id, sn_code, product_id, status, purchase_ref, purchase_cost_cents, inbound_at, warranty_months, remark)
           VALUES (?, ?, ?, 'in_stock', ?, ?, ?, ?, '')`
        ).bind(context.storeId, code, productId, purchaseRef, costCents, inboundAt, warrantyMonths))
        insertedCodes.push(code)
      }

      if (statements.length > 0) {
        await env.DB.batch(statements)
        const insertedPlaceholders = insertedCodes.map(() => '?').join(', ')
        const newlyInserted = await env.DB.prepare(`SELECT id FROM serial_numbers WHERE store_id=? AND sn_code IN (${insertedPlaceholders})`).bind(context.storeId, ...insertedCodes).all<{ id: number }>()
        const eventStatements = newlyInserted.results.map((sn) =>
          env.DB.prepare('INSERT INTO sn_events (sn_id, event_type, source_type, operator_id, remark) VALUES (?, ?, ?, ?, ?)').bind(sn.id, 'inbound', '', context.userId, purchaseRef ? `采购单: ${purchaseRef}` : '')
        )
        if (eventStatements.length) await env.DB.batch(eventStatements)
      }

      return json({ ok: true, inserted: insertedCodes.length, duplicates, total: uniqueCodes.length })
    } catch (error: any) { return json({ error: error.message || 'SN录入失败' }, 400) }
  }

  // POST /api/sn/manual-entry — 补录模式 for existing customer devices
  if (req.method === 'POST' && operation === 'manual-entry') {
    try {
      const body = await req.json<SNManualEntryInput>()
      const productId = asNonNegativeInteger(body.productId, 'productId', 0)
      const snCode = normalizeSNCode(body.snCode)
      const customerName = asSNText(body.customerName, 'customerName', 100, true)
      const customerPhone = asSNText(body.customerPhone, 'customerPhone', 32, true)
      const deliveredAt = asSNDate(body.deliveredAt, 'deliveredAt')
      const remark = asSNText(body.remark, 'remark', 1000)
      if (!productId) return json({ error: '缺少商品ID' }, 400)

      const product = await env.DB.prepare('SELECT id, is_serialized, warranty_months FROM hardware WHERE id=? AND store_id=?').bind(productId, context.storeId).first<{ id: number; is_serialized: number; warranty_months: number }>()
      if (!product) return json({ error: '商品不存在' }, 404)
      if (!product.is_serialized) return json({ error: '该商品未启用SN管理' }, 400)

      const existing = await env.DB.prepare('SELECT id FROM serial_numbers WHERE store_id=? AND sn_code=?').bind(context.storeId, snCode).first()
      if (existing) return json({ error: '该SN码已存在' }, 409)

      const warrantyMonths = asWarrantyMonths(body.warrantyMonths, product.warranty_months ?? 36)
      const warrantyExpiresOn = warrantyExpiresOn(deliveredAt, warrantyMonths)

      const result = await env.DB.prepare(
        `INSERT INTO serial_numbers (store_id, sn_code, product_id, status, current_customer_name, current_customer_phone, delivered_at, warranty_months, warranty_expires_on, remark)
         VALUES (?, ?, ?, 'delivered', ?, ?, ?, ?, ?, ?)`
      ).bind(context.storeId, snCode, productId, customerName, customerPhone, deliveredAt, warrantyMonths, warrantyExpiresOn, remark).run()

      await env.DB.prepare('INSERT INTO sn_events (sn_id, event_type, customer_name, operator_id, occurred_at, remark) VALUES (?, ?, ?, ?, ?, ?)').bind(Number(result.meta.last_row_id), 'manual_entry', customerName, context.userId, deliveredAt, '人工补录').run()

      return json({ ok: true, id: result.meta.last_row_id, snCode, warrantyExpiresOn })
    } catch (error: any) { return json({ error: error.message || '补录失败' }, 400) }
  }

  // POST /api/sn/bind — bind SNs to an order item
  if (req.method === 'POST' && operation === 'bind') {
    try {
      const body = await req.json<SNBindInput>()
      const orderItemId = asNonNegativeInteger(body.orderItemId, 'orderItemId', 0)
      if (!orderItemId || !Array.isArray(body.snIds) || body.snIds.length === 0) return json({ error: '缺少订单行ID或SN列表' }, 400)
      if (body.snIds.length > 100) return json({ error: '单次最多绑定100条SN' }, 400)
      const snIds = body.snIds.map((snId) => asNonNegativeInteger(snId, 'snIds', 0))
      if (snIds.some((snId) => snId === 0) || new Set(snIds).size !== snIds.length) return json({ error: 'SN列表必须是唯一的正整数ID' }, 400)

      const item = await env.DB.prepare(
        `SELECT oi.id, oi.order_id, oi.quantity, oi.source_item_id, o.store_id, o.fulfillment_status FROM order_items oi
         JOIN orders o ON o.id=oi.order_id WHERE oi.id=? AND o.store_id=?`
      ).bind(orderItemId, context.storeId).first<{ id: number; order_id: number; quantity: number; source_item_id: number | null; store_id: number; fulfillment_status: string }>()
      if (!item) return json({ error: '订单行不存在' }, 404)
      if (item.fulfillment_status === 'cancelled') return json({ error: '订单已取消' }, 400)
      if (item.source_item_id === null) return json({ error: '订单行未关联商品，不能绑定SN' }, 409)

      const placeholders = snIds.map(() => '?').join(', ')
      const sns = await env.DB.prepare(`SELECT id, sn_code, status, product_id FROM serial_numbers WHERE id IN (${placeholders}) AND store_id=?`).bind(...snIds, context.storeId).all<{ id: number; sn_code: string; status: string; product_id: number }>()
      if (sns.results.length !== snIds.length) return json({ error: '部分SN不存在或不属于本门店' }, 400)
      for (const sn of sns.results) {
        if (sn.product_id !== item.source_item_id) return json({ error: `SN ${sn.sn_code} 与订单商品不一致` }, 409)
        if (!['in_stock', 'reserved'].includes(sn.status)) return json({ error: `SN ${sn.sn_code} 当前状态不可绑定` }, 409)
      }

      const existingBindings = await env.DB.prepare(
        `SELECT ois.sn_id FROM order_item_sn ois
         JOIN order_items oi ON oi.id=ois.order_item_id
         JOIN orders o ON o.id=oi.order_id
         WHERE ois.unbound_at IS NULL AND o.store_id=? AND (ois.order_item_id=? OR ois.sn_id IN (${placeholders}))`
      ).bind(context.storeId, orderItemId, ...snIds).all<{ sn_id: number }>()
      const alreadyBoundSnIds = new Set(existingBindings.results.map((binding) => binding.sn_id))
      if (alreadyBoundSnIds.size > 0) return json({ error: '订单行或SN已有有效绑定' }, 409)
      const boundCount = await env.DB.prepare('SELECT COUNT(*) AS total FROM order_item_sn WHERE order_item_id=? AND unbound_at IS NULL').bind(orderItemId).first<{ total: number }>()
      if ((boundCount?.total ?? 0) + snIds.length > item.quantity) return json({ error: '绑定SN数量超过订单行数量' }, 409)

      const statements: D1PreparedStatement[] = []
      for (const snId of snIds) {
        statements.push(env.DB.prepare('INSERT INTO order_item_sn (order_item_id, sn_id) VALUES (?, ?)').bind(orderItemId, snId))
        statements.push(env.DB.prepare("UPDATE serial_numbers SET status='reserved', current_order_id=?, updated_at=datetime('now') WHERE id=? AND store_id=?").bind(item.order_id, snId, context.storeId))
        statements.push(env.DB.prepare('INSERT INTO sn_events (sn_id, event_type, source_type, source_id, operator_id) VALUES (?, ?, ?, ?, ?)').bind(snId, 'reserved', 'order', orderItemId, context.userId))
      }
      await env.DB.batch(statements)
      return json({ ok: true, bound: snIds.length })
    } catch (error: any) { return json({ error: error.message || 'SN绑定失败' }, 400) }
  }

  return json({ error: 'Not found' }, 404)
}

async function handleDashboardTodos(env: Env, context: AuthContext): Promise<Response> {
  const denied = requirePermission(context, 'quote/view')
  if (denied) return denied
  const row = await env.DB.prepare(`SELECT
    SUM(CASE WHEN date(created_at, 'localtime') = date('now', 'localtime') THEN 1 ELSE 0 END) AS todayOrderCount,
    SUM(CASE WHEN fulfillment_status = 'pending_purchase' THEN 1 ELSE 0 END) AS pendingPurchaseCount,
    SUM(CASE WHEN fulfillment_status = 'pending_delivery' THEN 1 ELSE 0 END) AS pendingDeliveryCount,
    SUM(CASE WHEN fulfillment_status <> 'cancelled' THEN total_amount_cents - received_amount_cents ELSE 0 END) AS receivableCents
    FROM orders WHERE store_id=?`).bind(context.storeId).first<{ todayOrderCount: number | null; pendingPurchaseCount: number | null; pendingDeliveryCount: number | null; receivableCents: number | null }>()
  return json({ todayOrderCount: row?.todayOrderCount || 0, pendingPurchaseCount: row?.pendingPurchaseCount || 0, pendingDeliveryCount: row?.pendingDeliveryCount || 0, receivableCents: row?.receivableCents || 0 })
}

// ── Main router ──
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get('Origin') || '*'

    if (req.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }), origin)
    }

    const url = new URL(req.url)
    const path = url.pathname

    try {
      // Auth (no middleware needed)
      if (path.startsWith('/api/auth')) return cors(await handleAuth(req, env), origin)

      // Rate-limited public routes
      const clientIp = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown'

      // Search (public, 60/min per IP)
      if (path === '/api/search') {
        if (!rateLimit(`search:${clientIp}`, 60, 60000)) return cors(json({ error: '请求太频繁，请稍后重试' }, 429), origin)
        return cors(await handleSearch(req, env), origin)
      }

      // PDD detail (public, 30/min per IP)
      if (path === '/api/pdd/detail') {
        if (!rateLimit(`pdd-detail:${clientIp}`, 30, 60000)) return cors(json({ error: '请求太频繁，请稍后重试' }, 429), origin)
        const goodsSign = new URL(req.url).searchParams.get('sign') || ''
        if (!goodsSign) return cors(json({ error: '缺少goods_sign' }, 400), origin)
        try {
          const detail = await pddGetDetail(goodsSign, env)
          return cors(json({ ok: true, data: detail }), origin)
        } catch (e: any) {
          return cors(json({ ok: false, error: e.message }), origin)
        }
      }

      // All other routes need auth
      const authResult = await auth(req, env)
      if (authResult instanceof Response) return cors(authResult, origin)

      // Normalize (DeepSeek expensive, 20/min per user)
      if (path === '/api/normalize') {
        if (!rateLimit(`normalize:${authResult.userId}`, 20, 60000)) return cors(json({ error: 'AI 请求太频繁，请稍后重试' }, 429), origin)
        return cors(await handleNormalize(req, env), origin)
      }

      // 门店与权限管理
      if (path === '/api/stores/current') return cors(await handleStores(req, env, authResult), origin)
      if (path === '/api/members' || path === '/api/members/invitations' || /^\/api\/members\/\d+$/.test(path)) return cors(await handleMembers(req, env, authResult), origin)
      if (path === '/api/roles' && req.method === 'GET') return cors(await handleRoles(env, authResult), origin)

      // Product master data and legacy hardware library compatibility
      if (path === '/api/products' || /^\/api\/products\/\d+(?:\/status)?$/.test(path)) return cors(await handleProducts(req, env, authResult), origin)
      if (path === '/api/product-categories' || /^\/api\/product-categories\/\d+$/.test(path)) return cors(await handleProductReference(req, env, authResult, 'categories'), origin)
      if (path === '/api/product-brands' || /^\/api\/product-brands\/\d+$/.test(path)) return cors(await handleProductReference(req, env, authResult, 'brands'), origin)
      if (path.startsWith('/api/library')) return cors(await handleLibrary(req, env, authResult), origin)
      if (path.startsWith('/api/templates')) return cors(await handleTemplates(req, env, authResult), origin)
      if (path.startsWith('/api/quotes')) return cors(await handleQuotes(req, env, authResult), origin)
      if (path === '/api/orders' || /^\/api\/orders\/\d+(?:\/(payments|status))?$/.test(path)) return cors(await handleOrders(req, env, authResult), origin)
      if (path.startsWith('/api/sn')) return cors(await handleSN(req, env, authResult), origin)
      if (path === '/api/dashboard/todos' && req.method === 'GET') return cors(await handleDashboardTodos(env, authResult), origin)

      return cors(json({ error: 'Not found' }, 404), origin)
    } catch (e: any) {
      return cors(json({ error: e.message }, 500), origin)
    }
  },
}
