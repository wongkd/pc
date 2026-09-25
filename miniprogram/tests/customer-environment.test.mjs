/**
 * MP16 · 顾客端环境与演示开关测试。
 *
 * 这组用例守的是三条真实事故：
 *   1. 正式版连测试库 / 体验版连生产库 → 按微信版本硬校验；
 *   2. 真实模式缺地址时悄悄回落演示样本 → 必须抛错，不许兜底；
 *   3. 顾客与员工在同一台设备上互相覆盖会话 → 键必须物理隔离。
 *
 * 运行：node --test tests/customer-environment.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CUSTOMER_ENVIRONMENT_SPECS,
  CUSTOMER_SESSION_KEYS,
  CUSTOMER_STORAGE_PREFIX,
  STAFF_STORAGE_KEYS,
  createCustomerStorage,
  defaultEnvironmentFor,
  readMiniProgramEnvVersion,
  resolveCustomerEnvironment,
} from '../features/customer/environment.ts'
import { requireCustomerDemoMode } from '../features/customer/fixtures.ts'

/** 临时替换全局 wx，用于模拟不同小程序运行环境。 */
function withWx(value, run) {
  const saved = globalThis.wx
  if (value === undefined) delete globalThis.wx
  else globalThis.wx = value
  try {
    return run()
  } finally {
    if (saved === undefined) delete globalThis.wx
    else globalThis.wx = saved
  }
}

test('三档环境结构固定，已填地址必须是 HTTPS', () => {
  assert.deepEqual(Object.keys(CUSTOMER_ENVIRONMENT_SPECS).sort(), ['demo', 'prod', 'test'])
  assert.equal(CUSTOMER_ENVIRONMENT_SPECS.demo.allowsDemoData, true)
  assert.equal(CUSTOMER_ENVIRONMENT_SPECS.test.allowsDemoData, false)
  assert.equal(CUSTOMER_ENVIRONMENT_SPECS.prod.allowsDemoData, false)
  // 地址可以尚未就绪（null），但一旦填了就只能是 HTTPS。
  for (const [name, spec] of Object.entries(CUSTOMER_ENVIRONMENT_SPECS)) {
    if (spec.apiBaseUrl !== null) {
      assert.match(spec.apiBaseUrl, /^https:\/\//, `${name} 的地址必须是 HTTPS`)
    }
  }
})

test('按微信版本推断默认环境：正式版只认生产', () => {
  assert.equal(defaultEnvironmentFor('release'), 'prod')
  assert.equal(defaultEnvironmentFor('trial'), 'test')
  assert.equal(defaultEnvironmentFor('develop'), 'demo')
  assert.equal(defaultEnvironmentFor('unknown'), 'demo')
})

test('正式版不得解析为演示或测试环境', () => {
  assert.throws(
    () => resolveCustomerEnvironment({ envVersion: 'release', name: 'demo' }),
    /正式版只能连生产环境/,
  )
  assert.throws(
    () =>
      resolveCustomerEnvironment({
        envVersion: 'release',
        name: 'test',
        apiBaseUrl: 'https://example.invalid/api/v2',
      }),
    /正式版只能连生产环境/,
  )
})

test('真实模式缺地址立即失败，不回落演示数据', () => {
  assert.throws(() => resolveCustomerEnvironment({ name: 'test' }), /缺少 HTTPS API 地址/)
  assert.throws(() => resolveCustomerEnvironment({ name: 'prod' }), /缺少 HTTPS API 地址/)
  assert.throws(
    () => resolveCustomerEnvironment({ name: 'prod', apiBaseUrl: null }),
    /缺少 HTTPS API 地址/,
  )
})

test('真实模式地址必须是 HTTPS：本地 Worker 的 http 入口不被接受', () => {
  assert.throws(
    () => resolveCustomerEnvironment({ name: 'test', apiBaseUrl: 'http://127.0.0.1:8787/api/v2' }),
    /必须是 HTTPS/,
  )
})

test('真实模式就绪时保留地址，且固定样本不可载入', () => {
  const environment = resolveCustomerEnvironment({
    name: 'prod',
    apiBaseUrl: 'https://api.huangqidong.cn/api/v2',
  })
  assert.equal(environment.name, 'prod')
  assert.equal(environment.apiBaseUrl, 'https://api.huangqidong.cn/api/v2')
  assert.equal(environment.demoData, false)
  // 真实模式禁用 MP03 的固定样本，防止顾客看到虚构商品与价格。
  assert.throws(() => requireCustomerDemoMode('live'), /仅允许在明确的 demo 模式/)
})

test('演示环境不持有地址，也不会误发真实请求', () => {
  const environment = resolveCustomerEnvironment({
    name: 'demo',
    apiBaseUrl: 'https://api.huangqidong.cn/api/v2',
  })
  assert.equal(environment.apiBaseUrl, null)
  assert.equal(environment.demoData, true)
  requireCustomerDemoMode('demo')
})

test('体验版按测试环境解析，未就绪时明确报错而不是显示演示数据', () => {
  withWx({ getAccountInfoSync: () => ({ miniProgram: { envVersion: 'trial' } }) }, () => {
    assert.equal(readMiniProgramEnvVersion(), 'trial')
    assert.throws(() => resolveCustomerEnvironment(), /缺少 HTTPS API 地址/)
  })
})

test('非小程序运行时按 unknown 处理，默认演示环境', () => {
  withWx(undefined, () => {
    assert.equal(readMiniProgramEnvVersion(), 'unknown')
    const environment = resolveCustomerEnvironment()
    assert.equal(environment.name, 'demo')
    assert.equal(environment.demoData, true)
  })
})

test('顾客存储带独立命名空间，与员工端键不重叠', () => {
  const map = new Map()
  const storage = createCustomerStorage({
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  })

  storage.setItem('token', 'customer-token')
  // 待确认动作的键由请求核心固定写入，前缀层必须一并隔离。
  storage.setItem('pc-quote:v2:pending-actions', '{}')
  assert.deepEqual([...map.keys()].sort(), [
    `${CUSTOMER_STORAGE_PREFIX}pc-quote:v2:pending-actions`,
    `${CUSTOMER_STORAGE_PREFIX}token`,
  ])
  assert.equal(storage.getItem('token'), 'customer-token')

  for (const staffKey of STAFF_STORAGE_KEYS) {
    assert.equal(map.has(staffKey), false, `顾客端不得写入员工键 ${staffKey}`)
  }
  for (const sessionKey of Object.values(CUSTOMER_SESSION_KEYS)) {
    assert.equal(
      STAFF_STORAGE_KEYS.includes(`${CUSTOMER_STORAGE_PREFIX}${sessionKey}`),
      false,
      `顾客会话键 ${sessionKey} 与员工键重名`,
    )
  }
})
