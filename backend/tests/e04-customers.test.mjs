/**
 * E02/E04 · 客户主数据与设备归属（/api/customers）。
 *
 * 走真实 Worker 入口 + 真实 D1，覆盖三层：
 *   1. 入口层：路由、鉴权、权限（只有走真实 fetch 才照得到）；
 *   2. 约束层：同店手机号唯一、空手机号不参与唯一性（0010 的修复点）；
 *   3. 口径层：手机号为空时不做订单归属，不把别人的单算到散客头上。
 *
 * 本卡不涉及金额动作，因此不在这里验证幂等与并发（见 T04 卡）。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER_A = { email: 'owner-a@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: '门店甲' }
const OWNER_B = { email: 'owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: '门店乙' }

let env
let db
/** 门店甲的老板客户端 */
let a
/** 门店乙的老板客户端 */
let b

async function json(response) {
  return { status: response.status, body: await response.json() }
}

/** 播一条订单，只为验证「客户 → 订单」的归属口径，不需要真实流水。 */
async function seedOrder({ storeId = 1, orderNo, phone, totalCents = 0, receivedCents = 0, actor = 1, status = 'pending_delivery' }) {
  await db.prepare(`INSERT INTO orders (store_id, order_no, quote_snapshot, customer_name, customer_phone,
      project_title, total_amount_cents, received_amount_cents, fulfillment_status, created_by, updated_by)
    VALUES (?, ?, '{}', '样本客户', ?, '样本用途', ?, ?, ?, ?, ?)`)
    .bind(storeId, orderNo, phone, totalCents, receivedCents, status, actor, actor).run()
}

before(async () => {
  env = await createWorkerEnv()
  db = env.db
  await seedOwner(db, OWNER_A)
  await seedOwner(db, OWNER_B)
  // 门店甲里再放一个「没有任何权限」的店员：用来证明入口真的在判权限，而不是只看登录。
  await db.prepare('INSERT INTO users (id, email, password_hash, status) VALUES (3, ?, ?, \'active\')')
    .bind('clerk@local.test', await legacyPasswordHash(PASSWORD)).run()
  await db.prepare(`INSERT INTO store_members (store_id, user_id, status, is_owner, created_by, updated_by)
    VALUES (1, 3, 'active', 0, 1, 1)`).run()

  a = createClient(env.call, await login(env.call, OWNER_A))
  b = createClient(env.call, await login(env.call, OWNER_B))
})

after(async () => {
  await env?.dispose()
})

test('未登录访问客户台账被挡在鉴权之外', async () => {
  const { status } = await json(await env.call('/api/customers'))
  assert.equal(status, 401)
})

test('登录但无权限的店员拿不到客户台账，也写不进客户', async () => {
  const clerk = createClient(env.call, await login(env.call, { email: 'clerk@local.test', password: PASSWORD }))
  assert.equal((await json(await clerk.get('/api/customers'))).status, 403)
  assert.equal((await json(await clerk.post('/api/customers', { name: '越权客户' }))).status, 403)
})

test('不带手机号的散客可以留多条档案', async () => {
  // 0010 原来用表级 UNIQUE(store_id, phone)，第二条空号散客会撞唯一约束 —— 这条是回归。
  const first = await json(await a.post('/api/customers', { name: '散客甲' }))
  const second = await json(await a.post('/api/customers', { name: '散客乙' }))
  assert.equal(first.status, 201, JSON.stringify(first))
  assert.equal(second.status, 201, JSON.stringify(second))
  assert.notEqual(first.body.id, second.body.id)
})

test('客户来源按契约枚举保存并回读，未知来源拒绝', async () => {
  const created = await json(await a.post('/api/customers', { name: '来源字段客户', sourceChannel: 'wechat' }))
  assert.equal(created.status, 201, JSON.stringify(created))

  const detail = await json(await a.get(`/api/customers/${created.body.id}`))
  assert.equal(detail.body.sourceChannel, 'wechat')

  const list = await json(await a.get('/api/customers?q=来源字段客户'))
  assert.equal(list.body.items[0].sourceChannel, 'wechat')

  const invalid = await json(await a.post('/api/customers', { name: '无效来源客户', sourceChannel: 'social_media' }))
  assert.equal(invalid.status, 400, JSON.stringify(invalid))
})

test('同店重复手机号被拒，并给出可照做的提示', async () => {
  const created = await json(await a.post('/api/customers', { name: '张先生', phone: '13800000001' }))
  assert.equal(created.status, 201)
  const duplicate = await json(await a.post('/api/customers', { name: '另一位张先生', phone: '13800000001' }))
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate))
  assert.match(duplicate.body.error, /手机号/)
  // 改客户时撞同一个号，同样要拦
  const other = await json(await a.post('/api/customers', { name: '李先生', phone: '13800000002' }))
  const conflict = await json(await a.put(`/api/customers/${other.body.id}`, { name: '李先生', phone: '13800000001' }))
  assert.equal(conflict.status, 409, JSON.stringify(conflict))
})

test('同名同号在不同门店各自成立，且互相看不到', async () => {
  const mine = await json(await a.post('/api/customers', { name: '跨店客户', phone: '13900000009' }))
  const theirs = await json(await b.post('/api/customers', { name: '跨店客户', phone: '13900000009' }))
  assert.equal(mine.status, 201)
  assert.equal(theirs.status, 201, '另一家门店用同一个号码不应冲突')

  const theirList = await json(await b.get('/api/customers?q=跨店客户'))
  assert.equal(theirList.body.items.length, 1)
  assert.equal(theirList.body.items[0].id, theirs.body.id)

  // 猜到别家客户的 ID 也读不到、改不动、挂不上设备
  assert.equal((await json(await b.get(`/api/customers/${mine.body.id}`))).status, 404)
  assert.equal((await json(await b.put(`/api/customers/${mine.body.id}`, { name: '越权改名' }))).status, 404)
  assert.equal((await json(await b.post(`/api/customers/${mine.body.id}/devices`, { label: '越权设备' }))).status, 404)
  assert.equal((await json(await b.get(`/api/customers/${mine.body.id}/devices`))).status, 404)

  // 确认越权写入真的没落库，而不是「报了错但已经写进去」
  const untouched = await db.prepare('SELECT name FROM customers WHERE id=?').bind(mine.body.id).first()
  assert.equal(untouched.name, '跨店客户')
  const strays = await db.prepare('SELECT COUNT(*) AS n FROM customer_devices WHERE customer_id=?').bind(mine.body.id).first()
  assert.equal(strays.n, 0)
})

test('客户档案的必填、长度与状态校验在写入前拦住', async () => {
  assert.equal((await json(await a.post('/api/customers', { name: '   ' }))).status, 400)
  assert.equal((await json(await a.post('/api/customers', { name: 'x'.repeat(201) }))).status, 400)
  assert.equal((await json(await a.post('/api/customers', { name: 123 }))).status, 400)

  const created = await json(await a.post('/api/customers', { name: '状态校验客户' }))
  const bad = await json(await a.put(`/api/customers/${created.body.id}`, { name: '状态校验客户', status: 'deleted' }))
  assert.equal(bad.status, 400)
})

test('改不存在的客户返回 404，不是静默成功', async () => {
  const missing = await json(await a.put('/api/customers/999999', { name: '查无此人' }))
  assert.equal(missing.status, 404, '条件 UPDATE 影响 0 行不能当成功')
})

test('设备归属：新增、列出、改名、删除，删完确实没了', async () => {
  const customer = await json(await a.post('/api/customers', { name: '带机客户', phone: '13700000007' }))
  const id = customer.body.id

  assert.equal((await json(await a.post(`/api/customers/${id}/devices`, { serialNumber: 'SN-X' }))).status, 400, '设备名称必填')

  const added = await json(await a.post(`/api/customers/${id}/devices`, { label: '联想拯救者 Y7000P 2024', serialNumber: 'PF3XK9A1', remark: '外店机器，来店清灰' }))
  assert.equal(added.status, 201, JSON.stringify(added))

  const detail = await json(await a.get(`/api/customers/${id}`))
  assert.equal(detail.body.devices.length, 1)
  assert.equal(detail.body.devices[0].label, '联想拯救者 Y7000P 2024')
  assert.equal(detail.body.devices[0].serialNumber, 'PF3XK9A1', '字段应为 camelCase')
  assert.ok(detail.body.devices[0].createdAt)

  const renamed = await json(await a.put(`/api/customers/${id}/devices/${added.body.id}`, { label: '拯救者 Y7000P（客户自述 2023 款）', serialNumber: 'PF3XK9A1' }))
  assert.equal(renamed.status, 200)
  const afterRename = await json(await a.get(`/api/customers/${id}`))
  assert.equal(afterRename.body.devices[0].label, '拯救者 Y7000P（客户自述 2023 款）')

  assert.equal((await json(await a.del(`/api/customers/${id}/devices/${added.body.id}`))).status, 200)
  const afterDelete = await json(await a.get(`/api/customers/${id}`))
  assert.equal(afterDelete.body.devices.length, 0)
  assert.equal((await json(await a.del(`/api/customers/${id}/devices/${added.body.id}`))).status, 404, '删第二次应是 404')

  // 设备不能挂到不存在的客户上
  assert.equal((await json(await a.post('/api/customers/999999/devices', { label: '孤儿设备' }))).status, 404)
})

test('订单归属：按手机号聚合，且没有手机号的散客不会被算上别人的单', async () => {
  await seedOrder({ orderNo: 'A-1001', phone: '13600000001', totalCents: 650000, receivedCents: 200000 })
  await seedOrder({ orderNo: 'A-1002', phone: '13600000001', totalCents: 120000, receivedCents: 120000, status: 'delivered' })
  // 两笔没有电话的订单：它们不属于任何一个「没留电话的散客」
  await seedOrder({ orderNo: 'A-1003', phone: '', totalCents: 9999900 })
  await seedOrder({ orderNo: 'A-1004', phone: '', totalCents: 8888800 })

  const bound = await json(await a.post('/api/customers', { name: '有单客户', phone: '13600000001' }))
  const boundList = await json(await a.get('/api/customers?q=13600000001'))
  const boundRow = boundList.body.items.find((row) => row.id === bound.body.id)
  assert.equal(boundRow.orderCount, 2)
  assert.equal(boundRow.totalCents, 770000)

  const boundDetail = await json(await a.get(`/api/customers/${bound.body.id}`))
  assert.equal(boundDetail.body.orders.length, 2)
  assert.equal(boundDetail.body.orders[0].orderNo, 'A-1002', '按更新时间倒序')
  // 详情与列表必须同一套口径：详情少了这两个字段，页面只能显示 ¥NaN（浏览器验收发现过）。
  assert.equal(boundDetail.body.orderCount, 2, '详情也要给出订单数')
  assert.equal(boundDetail.body.totalCents, 770000, '详情也要给出累计金额')
  assert.equal(boundDetail.body.receivedCents, 320000, '详情也要给出已收金额')

  const walkIn = await json(await a.post('/api/customers', { name: '无号散客' }))
  const walkInList = await json(await a.get('/api/customers?q=无号散客'))
  const walkInRow = walkInList.body.items.find((row) => row.id === walkIn.body.id)
  assert.equal(walkInRow.orderCount, 0, '空手机号不能匹配到全部无电话订单')
  assert.equal(walkInRow.totalCents, 0)
  const walkInDetail = await json(await a.get(`/api/customers/${walkIn.body.id}`))
  assert.deepEqual(walkInDetail.body.orders, [])
  assert.equal(walkInDetail.body.orderCount, 0)
  assert.equal(walkInDetail.body.totalCents, 0)
  assert.equal(walkInDetail.body.receivedCents, 0)
})

test('归档的客户不再出现在台账列表里', async () => {
  const created = await json(await a.post('/api/customers', { name: '待归档客户', phone: '13500000005' }))
  await a.put(`/api/customers/${created.body.id}`, { name: '待归档客户', phone: '13500000005', status: 'archived' })
  const list = await json(await a.get('/api/customers?q=待归档客户'))
  assert.equal(list.body.items.length, 0)
  // 但档案本身还在，可以直接按 ID 查到（不是删除）
  assert.equal((await json(await a.get(`/api/customers/${created.body.id}`))).status, 200)
})

test('搜索按姓名或手机号命中，空结果返回空数组', async () => {
  const byName = await json(await a.get('/api/customers?q=有单客户'))
  assert.equal(byName.body.items.length, 1)
  const byPhone = await json(await a.get('/api/customers?q=13600000001'))
  assert.equal(byPhone.body.items.length, 1)
  const none = await json(await a.get('/api/customers?q=查无此名'))
  assert.deepEqual(none.body.items, [])
})

test('客户列表游标分页不重不漏，订单汇总走正确的门店手机号口径', async () => {
  const prefix = `游标回归-${Date.now()}`
  const names = [`${prefix}-甲`, `${prefix}-乙`, `${prefix}-丙`]
  for (let i = 0; i < names.length; i += 1) {
    const result = await json(await a.post('/api/customers', {
      name: names[i],
      phone: i === 0 ? '13990000001' : '',
    }))
    assert.equal(result.status, 201)
  }
  await seedOrder({ orderNo: `${prefix}-A`, phone: '13990000001', totalCents: 12500, receivedCents: 5000 })
  await seedOrder({ storeId: 2, orderNo: `${prefix}-B`, phone: '13990000001', totalCents: 999999 })

  const first = await json(await a.get(`/api/customers?q=${encodeURIComponent(prefix)}&limit=2`))
  assert.equal(first.body.items.length, 2)
  assert.ok(first.body.nextCursor)
  const second = await json(await a.get(`/api/customers?q=${encodeURIComponent(prefix)}&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`))
  assert.equal(second.body.items.length, 1)
  assert.equal(second.body.nextCursor, null)
  assert.equal(new Set([...first.body.items, ...second.body.items].map((row) => row.id)).size, 3)

  const orderSummary = await json(await a.get(`/api/customers?q=${encodeURIComponent(names[0])}`))
  assert.equal(orderSummary.body.items[0].orderCount, 1)
  assert.equal(orderSummary.body.items[0].totalCents, 12500)
  assert.equal(orderSummary.body.items[0].receivedCents, 5000)
})

test('写动作留下审计记录，可追溯到操作人与客户', async () => {
  const created = await json(await a.post('/api/customers', { name: '审计客户', phone: '13400000004' }))
  await a.post(`/api/customers/${created.body.id}/devices`, { label: '审计设备' })
  const logs = await db.prepare('SELECT action, entity_id FROM audit_logs WHERE store_id=1 AND entity_type IN (\'customer\',\'customer_device\') ORDER BY id').all()
  const actions = logs.results.map((row) => row.action)
  assert.ok(actions.includes('customer.created'), actions.join(','))
  assert.ok(actions.includes('customer.device_added'), actions.join(','))
})
