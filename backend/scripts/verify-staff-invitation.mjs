/**
 * 在本地隔离 Worker 上复验员工邀请默认角色、接受、登录与逐域权限。
 * 只允许请求回环地址；配合 `dev-server.mjs` 的内存 D1 使用，不碰远端数据。
 *
 * 用法：
 *   node backend/scripts/verify-staff-invitation.mjs
 *   STAFF_VERIFY_API_BASE=http://127.0.0.1:8878 node backend/scripts/verify-staff-invitation.mjs
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const baseUrl = new URL(process.env.STAFF_VERIFY_API_BASE || 'http://127.0.0.1:8878')
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
if (baseUrl.protocol !== 'http:' || !loopbackHosts.has(baseUrl.hostname)) {
  throw new Error('只允许对本机 http 回环地址运行员工权限验收。')
}

const ownerEmail = process.env.STAFF_VERIFY_OWNER_EMAIL || 'owner@local.test'
const ownerPassword = process.env.STAFF_VERIFY_OWNER_PASSWORD || 'local-preview-pass'
const staffEmail = `staff-permissions-${randomUUID()}@local.test`
const staffPassword = `local-${randomUUID()}-pass`
const results = []

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // status assertions below still report a useful failure for non-JSON responses
  }
  return { status: response.status, json }
}

function expectStatus(name, result, expected) {
  results.push({ name, status: result.status, expected })
  assert.equal(result.status, expected, `${name}: 期望 ${expected}，实际 ${result.status}`)
}

const ownerLogin = await request('/api/auth/login', {
  method: 'POST',
  body: { email: ownerEmail, password: ownerPassword },
})
expectStatus('店主登录', ownerLogin, 200)
const ownerToken = ownerLogin.json?.token
assert.ok(ownerToken, '店主登录响应缺少 token')

const rolesResponse = await request('/api/roles', { token: ownerToken })
expectStatus('读取门店角色', rolesResponse, 200)
const salesRole = rolesResponse.json.find((role) => role.code === 'sales')
assert.ok(salesRole, '本地门店缺少 sales 角色种子')
const rolePermissions = new Set(String(salesRole.permissions ?? '').split(',').filter(Boolean))
for (const code of [
  'sales/quote-view',
  'sales/quote-edit',
  'sales/quote-convert',
  'sales/order-view',
  'sales/order-edit',
  'inventory/view',
]) {
  assert.ok(rolePermissions.has(code), `sales 角色缺少预期权限 ${code}`)
}

// 故意不传 roleId：复验接受邀请从门店默认 sales 角色回退取值。
const invitation = await request('/api/members/invitations', {
  method: 'POST',
  token: ownerToken,
  body: { email: staffEmail },
})
expectStatus('创建未指定角色的员工邀请', invitation, 200)
assert.ok(invitation.json?.token, '邀请响应缺少 token')

const accepted = await request('/api/auth/accept-invitation', {
  method: 'POST',
  body: { token: invitation.json.token, password: staffPassword },
})
expectStatus('接受邀请并取得会话', accepted, 200)
assert.equal(accepted.json.email, staffEmail)

const acceptedProfile = await request('/api/auth/me', { token: accepted.json.token })
expectStatus('邀请会话读取 /me', acceptedProfile, 200)
assert.ok(acceptedProfile.json.roles.includes('sales'))
assert.deepEqual(new Set(acceptedProfile.json.permissions), rolePermissions)

const staffLogin = await request('/api/auth/login', {
  method: 'POST',
  body: { email: staffEmail, password: staffPassword },
})
expectStatus('员工单独登录', staffLogin, 200)
const staffToken = staffLogin.json?.token
assert.ok(staffToken, '员工登录响应缺少 token')

const staffProfile = await request('/api/auth/me', { token: staffToken })
expectStatus('员工登录后读取 /me', staffProfile, 200)
assert.ok(staffProfile.json.roles.includes('sales'))
assert.deepEqual(new Set(staffProfile.json.permissions), rolePermissions)

const readChecks = [
  ['/api/v2/sales/quotes', 200],
  ['/api/v2/sales/orders', 200],
  ['/api/customers', 200],
  ['/api/v2/inventory', 200],
  ['/api/v2/inventory/purchases', 200],
  ['/api/v2/service/orders', 403],
  ['/api/v2/recovery/orders', 403],
  ['/api/v2/finance/overview', 403],
  ['/api/members', 403],
  ['/api/roles', 403],
]
for (const [path, expected] of readChecks) {
  const result = await request(path, { token: staffToken })
  expectStatus(`GET ${path}`, result, expected)
  if (path === '/api/v2/inventory' && expected === 200) {
    const responseText = JSON.stringify(result.json)
    assert.ok(!responseText.includes('totalCostCents'), '销售角色不应读取库存成本')
    assert.ok(!responseText.includes('acquisitionCostCents'), '销售角色不应读取逐件成本')
  }
}

const deniedWrites = [
  '/api/v2/inventory/products',
  '/api/v2/inventory/openings',
  '/api/v2/inventory/purchases',
  '/api/v2/service/orders',
  '/api/v2/recovery/orders',
  '/api/v2/trade-ins',
  '/api/v2/finance/payments',
  '/api/v2/sales/orders/not-a-real-id/payments',
]
for (const path of deniedWrites) {
  const result = await request(path, { method: 'POST', token: staffToken, body: {} })
  expectStatus(`无权写入 ${path}`, result, 403)
}

// 空载荷只验证鉴权是否通过并到达业务校验（400），不会建立报价、订单或客户。
for (const path of ['/api/v2/sales/quotes', '/api/v2/sales/orders', '/api/customers']) {
  const result = await request(path, { method: 'POST', token: staffToken, body: {} })
  expectStatus(`有权写入并到达校验 ${path}`, result, 400)
}

const ownerMembers = await request('/api/members', { token: ownerToken })
expectStatus('店主读取成员列表', ownerMembers, 200)
const staffMember = ownerMembers.json.find((member) => member.email === staffEmail)
assert.ok(staffMember, '邀请接受后成员列表找不到员工')
assert.equal(staffMember.roles, 'sales')

// 当前契约没有置换列表 GET；确认 405 仅代表方法不支持，不归类为权限通过/拒绝。
const unsupportedTradeinList = await request('/api/v2/trade-ins', { token: staffToken })
expectStatus('置换列表 GET 当前不支持', unsupportedTradeinList, 405)

console.log(JSON.stringify({
  result: 'PASS',
  environment: baseUrl.origin,
  staffEmail,
  invitationRoleIdSupplied: false,
  assignedRole: salesRole.code,
  rolePermissions: [...rolePermissions],
  checks: results.length,
  allowedOrDeniedDomainReads: readChecks.length,
  deniedWrites: deniedWrites.length,
  authorizedWritesReachedValidation: 3,
  unsupportedTradeinListMethod: 405,
  statuses: results,
}, null, 2))
