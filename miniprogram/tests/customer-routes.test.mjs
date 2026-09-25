import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  consumePendingShopCategory,
  CUSTOMER_TABS,
  customerTabIndex,
  navigateCustomerDetail,
  shouldSwitchCustomerTab,
  syncCustomerTabSelection,
  switchCustomerTab,
} from '../features/customer/routes.ts'

test('顾客 Tab 顺序固定，旧员工页不在顾客路由表', () => {
  assert.deepEqual(CUSTOMER_TABS.map((tab) => tab.title), ['首页', '商城', '社区', '我的'])
  assert.equal(customerTabIndex('pages/shop/index'), 1)
  assert.equal(customerTabIndex('pages/inventory/index'), -1)
  assert.equal(shouldSwitchCustomerTab(1, 'shop'), false)
  assert.equal(shouldSwitchCustomerTab(1, 'community'), true)
})

test('页面显示时校正底栏高亮；旧选中态不能拦截返回首页', async () => {
  const tabBar = { data: { selected: 0 }, setData(next) { this.data = { ...this.data, ...next } } }
  syncCustomerTabSelection(tabBar, 'community')
  assert.equal(tabBar.data.selected, 2)
  assert.deepEqual(tabBar.data.list.map((tab) => tab.selected), [false, false, true, false])

  const calls = []
  globalThis.wx = { switchTab: (options) => calls.push(options) }
  switchCustomerTab('home')
  assert.deepEqual(calls, [{ url: '/pages/home/index' }])
})

test('商城分类作为状态保存，再走 switchTab，并且只消费一次', () => {
  const calls = []
  globalThis.wx = { switchTab: (options) => calls.push(options) }
  switchCustomerTab('shop', { shopCategory: '配件' })
  assert.deepEqual(calls, [{ url: '/pages/shop/index' }])
  assert.equal(consumePendingShopCategory(), '配件')
  assert.equal(consumePendingShopCategory(), null)
  switchCustomerTab('home')
  assert.deepEqual(calls[1], { url: '/pages/home/index' })
})

test('顧客详情使用 navigateTo，员工详情目标被拒绝', () => {
  const calls = []
  globalThis.wx = { navigateTo: (options) => calls.push(options) }
  navigateCustomerDetail('/packages/customer/product-detail/index?id=demo')
  assert.deepEqual(calls, [{ url: '/packages/customer/product-detail/index?id=demo' }])
  assert.throws(() => navigateCustomerDetail('/packages/sales/order-detail/index'), /只能进入 packages\/customer/)
})
