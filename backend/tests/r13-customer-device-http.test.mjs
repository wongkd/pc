/** R13 · v2 客户/保管设备读模型：DTO、分域权限与跨店隔离。 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkerEnv, seedOwner, login, createClient, legacyPasswordHash } from './lib/worker.mjs'

const PASSWORD = 'local-preview-pass'
const OWNER = { email: 'r13-owner@local.test', password: PASSWORD, storeId: 1, userId: 1, storeName: '装机门店' }
const OWNER_B = { email: 'r13-owner-b@local.test', password: PASSWORD, storeId: 2, userId: 2, storeName: '别家门店' }
let env; let db; let owner; let otherStore; let salesReader; let nobody
const json = async (response) => ({ status: response.status, body: await response.json() })

async function seedClerk(userId, email, permissions) {
  await db.prepare(`INSERT INTO users (id, email, password_hash, status) VALUES (?, ?, ?, 'active')`)
    .bind(userId, email, await legacyPasswordHash(PASSWORD)).run()
  const member = await db.prepare(`INSERT INTO store_members (store_id, user_id, status, is_owner, created_by, updated_by)
    VALUES (1, ?, 'active', 0, 1, 1)`).bind(userId).run()
  const role = await db.prepare('INSERT INTO roles (store_id, code, name) VALUES (1, ?, ?)').bind(`r13-${userId}`, `R13 ${userId}`).run()
  for (const code of permissions) {
    await db.prepare('INSERT OR IGNORE INTO permissions (code, name) VALUES (?, ?)').bind(code, code).run()
    const permission = await db.prepare('SELECT id FROM permissions WHERE code = ?').bind(code).first()
    await db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)').bind(role.meta.last_row_id, permission.id).run()
  }
  await db.prepare('INSERT INTO member_roles (member_id, role_id) VALUES (?, ?)').bind(member.meta.last_row_id, role.meta.last_row_id).run()
  return createClient(env.call, await login(env.call, { email, password: PASSWORD, storeId: 1 }))
}

before(async () => {
  env = await createWorkerEnv(); db = env.db
  await seedOwner(db, OWNER); await seedOwner(db, OWNER_B)
  owner = createClient(env.call, await login(env.call, OWNER))
  otherStore = createClient(env.call, await login(env.call, OWNER_B))
  salesReader = await seedClerk(20, 'r13-sales@local.test', ['sales/order-view'])
  nobody = await seedClerk(21, 'r13-none@local.test', [])

  await db.prepare(`INSERT INTO customers (id, store_id, name, phone, email, address, remark, created_by, updated_by)
    VALUES (100, 1, '陈先生', '13800138000', 'chen@example.test', '上海', '仅内部备注', 1, 1)`).run()
  await db.prepare(`INSERT INTO customer_device_custody
    (id, store_id, owner_customer_id, device_code, current_configuration_id, custody_location, request_id, created_by)
    VALUES ('device-r13', 1, 100, 'R13-PC', 'cfg-r13', 'store', 'seed-r13', 1)`).run()
  await db.prepare(`INSERT INTO service_orders
    (id, store_id, order_no, customer_id, device_id, symptom, intake_snapshot, request_id, created_by, updated_by)
    VALUES ('service-r13', 1, 'R13-SERVICE', 100, 'device-r13', 'seed', '{}', 'seed-r13-service', 1, 1)`).run()
  await db.prepare(`INSERT INTO device_changes
    (id, store_id, device_id, service_order_id, from_revision, to_revision, components_json, effective_at, change_ref, request_id, created_by)
    VALUES ('change-r13', 1, 'device-r13', 'service-r13', 0, 1, ?, '2026-09-22T10:00:00Z', NULL, 'seed-r13-change', 1)`)
    .bind(JSON.stringify([{ oldComponentRef: 'SN-SECRET', oldItemDisposition: 'returned_to_customer', newStockItem: 'stock-secret', qty: 1, costCents: 45600, chargeType: 'charge' }])).run()
  await db.prepare(`INSERT INTO device_configurations
    (id, store_id, device_id, revision, components_json, effective_at, change_ref, request_id, created_by)
    VALUES ('cfg-r13', 1, 'device-r13', 1, ?, '2026-09-22T10:00:00Z', 'change-r13', 'seed-r13-config', 1)`)
    .bind(JSON.stringify([{ oldComponentRef: 'SN-SECRET', oldItemDisposition: 'returned_to_customer', newStockItem: 'stock-secret', qty: 1, costCents: 45600, chargeType: 'charge' }])).run()
})

after(() => env?.dispose?.())

test('R13 v2 客户和设备路径只读同店 CustomerDevice，并保留安全 DTO', async () => {
  const customer = await json(await owner.get('/api/v2/customers/100'))
  assert.equal(customer.status, 200, JSON.stringify(customer.body))
  assert.equal(customer.body.data.customer.name, '陈先生')
  assert.equal(customer.body.data.customer.remark, undefined)
  assert.equal(customer.body.data.devices[0].id, 'device-r13')

  const device = await json(await owner.get('/api/v2/devices/device-r13'))
  assert.equal(device.status, 200, JSON.stringify(device.body))
  assert.equal(device.body.data.device.deviceCode, 'R13-PC')
  assert.equal(device.body.data.configurationHistory.configurations[0].components[0].replacementRecorded, true)
  assert.equal(device.body.data.configurationHistory.configurations[0].components[0].costCents, undefined)
  assert.equal(JSON.stringify(device.body.data.configurationHistory).includes('SN-SECRET'), false)
  assert.equal(JSON.stringify(device.body.data.configurationHistory).includes('stock-secret'), false)
})

test('R13 销售只读可看归属但不取得维修配置历史；无权与跨店均拒绝', async () => {
  const sales = await json(await salesReader.get('/api/v2/devices/device-r13'))
  assert.equal(sales.status, 200, JSON.stringify(sales.body))
  assert.equal(sales.body.data.configurationHistory, null)
  assert.equal((await json(await nobody.get('/api/v2/devices/device-r13'))).status, 403)
  assert.equal((await json(await otherStore.get('/api/v2/devices/device-r13'))).status, 404)
})
