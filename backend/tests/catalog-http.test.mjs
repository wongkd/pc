import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'

let env, a, b, token
const png = (width, height) => {
  function crc(bytes) { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let i=0;i<8;i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1 }; return (c ^ 0xffffffff) >>> 0 }
  const chunk = (name, data) => { const type = Buffer.from(name); const n = Buffer.alloc(4), sum = Buffer.alloc(4); n.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([type,data]))); return Buffer.concat([n,type,data,sum]) }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height,4); header[8]=8; header[9]=2
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((width*3+1)*height))),chunk('IEND',Buffer.alloc(0))])
}
const draft = (id) => ({ id, title: '隔离样本商品', category: '配件', description: '顾客可见说明', priceCents: 12999, coverImageId: null, heroImageId: null, status: 'draft', version: 0 })
const put = (client, product, expectedVersion, mutationId) => client.put(`/api/v2/catalog/products/${product.id}`, { product, expectedVersion, mutationId })
const publicList = async () => (await (await env.call('/api/public/catalog/1')).json()).data
before(async () => {
  env = await createWorkerEnv({ withR2: true })
  const owner = await seedOwner(env.db)
  const other = await seedOwner(env.db, { storeId: 2, userId: 2, email: 'other@local.test' })
  token = await login(env.call, owner); a = createClient(env.call, token); b = createClient(env.call, await login(env.call, other))
})
after(async () => env?.dispose())
test('未登录和没有权限的成员不能管理商品', async () => {
  assert.equal((await env.call('/api/v2/catalog/products')).status, 401)
  await env.db.prepare("INSERT INTO users(id,email,password_hash,status) VALUES(3,'clerk@local.test',?,'active')").bind(await legacyPasswordHash('test-pass')).run()
  await env.db.prepare("INSERT INTO store_members(store_id,user_id,status,is_owner,created_by,updated_by) VALUES(1,3,'active',0,1,1)").run()
  const c = createClient(env.call, await login(env.call, { email:'clerk@local.test', password:'test-pass' }))
  assert.equal((await c.get('/api/v2/catalog/products')).status,403)
  assert.equal((await put(c,draft('denied-product'),0,'denied-mutation')).status,403)
})
test('草稿私有、上架白名单、版本冲突、重放及下架图片闭环', async () => {
  const product = draft('catalog-product-1')
  assert.equal((await put(a,product,0,'create-product-1')).status,200)
  assert.equal((await publicList()).items.length,0)
  assert.equal((await put(a,{...product,status:'published'},1,'publish-no-image')).status,400)
  const upload = await env.call('/api/v2/catalog/images',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'image/png'},body:png(710,500)})
  assert.equal(upload.status,201)
  const image = (await upload.json()).data
  assert.equal(image.storagePersistent,true)
  assert.equal((await env.call(`/api/public/catalog/1/images/${image.id}`)).status,404)
  assert.equal((await put(b,{...draft('other-product'),coverImageId:image.id},0,'cross-store-image')).status,400)
  const published = {...product,coverImageId:image.id,status:'published'}
  assert.equal((await put(a,published,1,'publish-product-1')).status,200)
  assert.equal((await put(a,published,1,'publish-product-1')).status,200)
  assert.equal((await put(a,{...published,title:'changed'},1,'publish-product-1')).status,409)
  assert.equal((await put(a,published,1,'stale-write-0001')).status,409)
  const visible = await publicList()
  assert.deepEqual(Object.keys(visible.items[0]).sort(),['id','title','category','description','priceCents','coverUrl','heroUrl'].sort())
  assert.equal((await env.call(visible.items[0].coverUrl)).status,200)
  assert.equal((await put(a,{...published,status:'unpublished'},2,'unpublish-product')).status,200)
  assert.equal((await publicList()).items.length,0)
  assert.equal((await env.call(visible.items[0].coverUrl)).status,404)
  const events = await env.db.prepare('SELECT COUNT(*) AS n FROM catalog_events WHERE product_id=?').bind(product.id).first()
  assert.equal(events.n,3)
  const stock = await env.db.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first()
  assert.equal(stock.n,0)
})
test('图片类型、尺寸和非法价格拒绝，跨店列表隔离', async () => {
  const sendImage = body => env.call('/api/v2/catalog/images',{method:'POST',headers:{Authorization:`Bearer ${token}`},body})
  assert.equal((await sendImage('not an image')).status,400)
  assert.equal((await sendImage(png(20,20))).status,400)
  assert.equal((await put(a,{...draft('bad-price-product'),priceCents:-1},0,'bad-price-mutation')).status,400)
  assert.equal((await put(a,{...draft('bad-price-product'),priceCents:1.5},0,'bad-price-mutation')).status,400)
  const list = await (await b.get('/api/v2/catalog/products')).json()
  assert.equal(list.data.items.length,0)
  assert.equal((await env.call('/api/public/catalog/1?page=-1')).status,400)
})
