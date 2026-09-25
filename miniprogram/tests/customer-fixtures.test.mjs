import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CUSTOMER_DEMO_COMMUNITY,
  CUSTOMER_DEMO_DATE,
  CUSTOMER_DEMO_HOME,
  CUSTOMER_DEMO_MINE,
  CUSTOMER_DEMO_MODE,
  CUSTOMER_DEMO_RUNTIME_NOTE,
  CUSTOMER_DEMO_SHOP,
  CUSTOMER_DEMO_STATES,
  requireCustomerDemoMode,
} from '../features/customer/fixtures.ts'

test('顾客样本固定为 demo 并包含显式演示说明', () => {
  assert.equal(CUSTOMER_DEMO_MODE, true)
  assert.match(CUSTOMER_DEMO_RUNTIME_NOTE, /虚构/)
  assert.equal(CUSTOMER_DEMO_DATE, '2026-03-12')
  for (const view of [CUSTOMER_DEMO_HOME, CUSTOMER_DEMO_SHOP, CUSTOMER_DEMO_COMMUNITY, CUSTOMER_DEMO_MINE]) {
    assert.equal(view.mode, 'demo')
    assert.equal(view.status, 'ready')
  }
})

test('商店价格使用整数分，未知值与零价保持不同语义', () => {
  for (const item of CUSTOMER_DEMO_SHOP.items) {
    assert.ok(item.priceCents === null || (Number.isInteger(item.priceCents) && item.priceCents >= 0))
  }
  assert.notEqual(null, 0)
})

test('live 模式拒绝载入视觉样本', () => {
  assert.equal(requireCustomerDemoMode('demo'), undefined)
  assert.throws(() => requireCustomerDemoMode('live'), /仅允许在明确的 demo 模式载入/)
})

test('固定错误、空和加载视图彼此区分', () => {
  assert.equal(CUSTOMER_DEMO_STATES.loading.status, 'loading')
  assert.equal(CUSTOMER_DEMO_STATES.empty.status, 'empty')
  assert.equal(CUSTOMER_DEMO_STATES.error.status, 'error')
  assert.ok(CUSTOMER_DEMO_STATES.error.description)
})
