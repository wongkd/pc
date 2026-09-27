import { resolveStorage, sniffMime, sha256Hex } from '../domains/storage'
import { CATALOG_VERSION, CATALOG_IMAGE_PRESETS, type CatalogProduct } from '../contracts/v2/generated/catalog'

interface Env { DB: D1Database; BUCKET?: R2Bucket; REQUIRE_PERSISTENT_STORAGE?: string }
interface Context { storeId: number; userId: number; permissions: string[] }
const root = '/api/v2/catalog'
const idPattern = /^[a-zA-Z0-9_-]{8,100}$/
const ok = (data: unknown, status = 200) => Response.json({ data, meta: { contractVersion: CATALOG_VERSION } }, { status, headers: { 'Cache-Control': 'no-store' } })
const fail = (message: string, status = 400) => Response.json({ error: { message } }, { status, headers: { 'Cache-Control': 'no-store' } })
const projection = `id, title, category, description, price_cents AS priceCents, cover_image_id AS coverImageId,
  hero_image_id AS heroImageId, status, version`

async function boundedBody(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get('Content-Length')) > max) return null
  const reader = req.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []; let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) { await reader.cancel(); return null }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

async function imageResponse(env: Env, storeId: number, id: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT object_key FROM catalog_images WHERE store_id=? AND id=?').bind(storeId, id).first<{ object_key: string }>()
  if (!row) return fail('图片不存在', 404)
  const file = await resolveStorage(env).get(row.object_key)
  if (!file) return fail('图片暂时不可用，请重新上传', 404)
  return new Response(file.bytes as BodyInit, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}

export async function routePublicCatalog(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url)
  const match = url.pathname.match(/^\/api\/public\/catalog\/([1-9]\d*)(?:\/images\/([a-zA-Z0-9_-]{8,100}))?$/)
  if (!match) return null
  if (req.method !== 'GET') return fail('不支持此操作', 405)
  const storeId = Number(match[1])
  if (!Number.isSafeInteger(storeId)) return fail('门店编号无效')
  if (!await env.DB.prepare("SELECT id FROM stores WHERE id=? AND status='active'").bind(storeId).first()) return fail('门店不存在', 404)
  if (match[2]) {
    const visible = await env.DB.prepare("SELECT id FROM catalog_products WHERE store_id=? AND status='published' AND (cover_image_id=? OR hero_image_id=?) LIMIT 1").bind(storeId, match[2], match[2]).first()
    return visible ? imageResponse(env, storeId, match[2]) : fail('图片未公开', 404)
  }
  const page = Number(url.searchParams.get('page') || 1)
  const category = url.searchParams.get('category') || ''
  if (!Number.isInteger(page) || page < 1 || page > 10000 || !['', '整机', '配件'].includes(category)) return fail('分页或分类无效')
  // 白名单直接投影，禁止复用库存、供应商、成本或内部附件 DTO。
  const rows = await env.DB.prepare(`SELECT id,title,category,description,price_cents AS priceCents,
    cover_image_id AS coverImageId,hero_image_id AS heroImageId FROM catalog_products
    WHERE store_id=? AND status='published' AND (?='' OR category=?) ORDER BY id LIMIT 21 OFFSET ?`)
    .bind(storeId, category, category, (page - 1) * 20).all<Record<string, unknown>>()
  const imageUrl = (id: unknown) => `/api/public/catalog/${storeId}/images/${id}`
  return ok({ items: rows.results.slice(0, 20).map(r => ({ id: r.id, title: r.title, category: r.category, description: r.description, priceCents: r.priceCents,
    coverUrl: imageUrl(r.coverImageId), heroUrl: r.heroImageId ? imageUrl(r.heroImageId) : null })), hasMore: rows.results.length > 20 })
}

export async function routeCatalog(req: Request, env: Env, context: Context): Promise<Response | null> {
  const url = new URL(req.url); const path = url.pathname
  if (!path.startsWith(`${root}/`)) return null
  const write = req.method !== 'GET'
  if (!context.permissions.some(p => p === '*' || p === 'library/edit' || (!write && p === 'library/view'))) return fail('没有商品管理权限', 403)
  try {
    if (path === `${root}/images` && req.method === 'POST') {
      const bytes = await boundedBody(req, 2 * 1024 * 1024)
      if (!bytes || bytes.length < 33 || sniffMime(bytes) !== 'image/png') return fail('请上传裁切后的 PNG 图片，大小不超过 2MB')
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return fail('PNG 图片头无效')
      const width = view.getUint32(16), height = view.getUint32(20)
      if (!Object.values(CATALOG_IMAGE_PRESETS).some(p => p.width === width && p.height === height)) return fail('图片尺寸不符合要求，请先裁切')
      const id = await sha256Hex(bytes); const key = `catalog/${context.storeId}/${id}.png`
      const storage = resolveStorage(env)
      await storage.put(key, bytes, 'image/png')
      await env.DB.prepare('INSERT OR IGNORE INTO catalog_images(id,store_id,object_key,width,height,created_by) VALUES(?,?,?,?,?,?)')
        .bind(id, context.storeId, key, width, height, context.userId).run()
      return ok({ id, storagePersistent: storage.persistent }, 201)
    }
    const image = path.match(/^\/api\/v2\/catalog\/images\/([a-zA-Z0-9_-]{8,100})$/)
    if (image && req.method === 'GET') return imageResponse(env, context.storeId, image[1])
    if (path === `${root}/products` && req.method === 'GET') {
      const page = Number(url.searchParams.get('page') || 1)
      if (!Number.isInteger(page) || page < 1 || page > 10000) return fail('分页无效')
      const rows = await env.DB.prepare(`SELECT ${projection} FROM catalog_products WHERE store_id=? ORDER BY updated_at DESC, id LIMIT 21 OFFSET ?`)
        .bind(context.storeId, (page - 1) * 20).all<CatalogProduct>()
      return ok({ items: rows.results.slice(0, 20), hasMore: rows.results.length > 20 })
    }
    const product = path.match(/^\/api\/v2\/catalog\/products\/([a-zA-Z0-9_-]{8,100})$/)
    if (!product || req.method !== 'PUT') return fail('商品接口不存在或方法不支持', 404)
    const bytes = await boundedBody(req, 24000)
    if (!bytes) return fail('商品内容过大')
    let body: any
    try { body = JSON.parse(new TextDecoder().decode(bytes)) } catch { return fail('商品内容格式错误') }
    const p = body?.product
    if (!p || p.id !== product[1] || !idPattern.test(body.mutationId || '') || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) return fail('商品版本或操作编号无效')
    if (typeof p.title !== 'string' || !p.title.trim() || p.title.trim().length > 100 || typeof p.description !== 'string' || p.description.length > 5000) return fail('名称必填且不超过100字，说明不超过5000字')
    if (!['整机', '配件'].includes(p.category) || !['draft', 'published', 'unpublished'].includes(p.status)) return fail('商品分类或状态无效')
    if (!Number.isSafeInteger(p.priceCents) || p.priceCents < 0 || p.priceCents > 100000000) return fail('售价必须为0至100万元，最多两位小数')
    if (p.status === 'published' && !p.coverImageId) return fail('请上传商品列表图后再上架')
    for (const [field, preset] of [['coverImageId', 'cover'], ['heroImageId', 'hero']] as const) {
      if (p[field] === null) continue
      if (typeof p[field] !== 'string' || !idPattern.test(p[field])) return fail('图片编号无效')
      const size = CATALOG_IMAGE_PRESETS[preset]
      const found = await env.DB.prepare('SELECT id FROM catalog_images WHERE store_id=? AND id=? AND width=? AND height=?').bind(context.storeId, p[field], size.width, size.height).first()
      if (!found) return fail('图片不存在、尺寸不符或不属于本门店')
      const stored = await env.DB.prepare('SELECT object_key FROM catalog_images WHERE store_id=? AND id=?').bind(context.storeId, p[field]).first<{ object_key: string }>()
      if (!stored || !await resolveStorage(env).head(stored.object_key)) return fail('图片文件已失效，请重新上传')
    }
    const payload = JSON.stringify({ title: p.title.trim(), category: p.category, description: p.description, priceCents: p.priceCents,
      coverImageId: p.coverImageId, heroImageId: p.heroImageId, status: p.status })
    const previous = await env.DB.prepare('SELECT mutation_id, payload FROM catalog_products WHERE store_id=? AND id=?').bind(context.storeId, p.id).first<{ mutation_id: string; payload: string }>()
    if (previous?.mutation_id === body.mutationId && previous.payload !== payload) return fail('操作编号已用于其他内容', 409)
    if (previous?.mutation_id !== body.mutationId) {
      const values = [p.title.trim(), p.category, p.description, p.priceCents, p.coverImageId, p.heroImageId, p.status, body.mutationId, payload, context.userId]
      let result: D1Result
      if (body.expectedVersion === 0) {
        result = await env.DB.prepare(`INSERT OR IGNORE INTO catalog_products(id,store_id,title,category,description,price_cents,cover_image_id,hero_image_id,status,mutation_id,payload,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(p.id, context.storeId, ...values).run()
      } else {
        result = await env.DB.prepare(`UPDATE catalog_products SET title=?,category=?,description=?,price_cents=?,cover_image_id=?,hero_image_id=?,status=?,mutation_id=?,payload=?,updated_by=?,version=version+1,updated_at=datetime('now') WHERE store_id=? AND id=? AND version=?`)
          .bind(...values, context.storeId, p.id, body.expectedVersion).run()
      }
      if (!result.meta.changes) return fail('商品已被其他操作更新，请关闭编辑并刷新列表后核对；当前输入仍保留', 409)
    }
    return ok(await env.DB.prepare(`SELECT ${projection} FROM catalog_products WHERE store_id=? AND id=?`).bind(context.storeId, p.id).first())
  } catch {
    return fail('商品服务暂时不可用，请保留输入后重试；请核实迁移及图片存储配置', 503)
  }
}
