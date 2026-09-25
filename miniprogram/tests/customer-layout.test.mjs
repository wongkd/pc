import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getCustomerNavigationLayout, getCustomerPageRightInset } from '../features/customer/layout.ts'

test('胶囊测量有效时按设备边界计算导航高度与右侧避让', () => {
  const layout = getCustomerNavigationLayout(
    { statusBarHeight: 47, windowWidth: 390 },
    { top: 54, bottom: 86, right: 383, width: 87, height: 32 },
    true
  )
  assert.equal(layout.statusBarHeight, 47)
  assert.equal(layout.navigationHeight, 94)
  assert.equal(layout.rightInset, 102)
  assert.equal(getCustomerPageRightInset(layout), 102)
})

test('缺少或冲突的胶囊数据使用稳定回退且不小于触控高度', () => {
  const missing = getCustomerNavigationLayout({}, {})
  assert.equal(missing.statusBarHeight, 20)
  assert.equal(missing.capsuleWidth, 87)
  assert.equal(missing.navigationHeight, 66)
  assert.equal(missing.capsuleRightInset, 10)
  assert.ok(missing.rightInset >= missing.capsuleRightInset + missing.capsuleWidth + 8)

  const conflict = getCustomerNavigationLayout(
    { statusBarHeight: 50, windowWidth: 390 },
    { top: 24, bottom: 56, right: 382, width: 90, height: 32 }
  )
  assert.equal(conflict.capsuleWidth, 87)
  assert.equal(conflict.navigationHeight, 94)

  const safeAreaFallback = getCustomerNavigationLayout({ safeArea: { top: 44 } }, {})
  assert.equal(safeAreaFallback.statusBarHeight, 44)
  assert.equal(safeAreaFallback.navigationHeight, 88)
})

test('长门店名有稳定胶囊预留，右侧辅助动作至少保留44px', () => {
  const layout = getCustomerNavigationLayout(
    { statusBarHeight: 24, windowWidth: 375 },
    { top: 26, bottom: 58, right: 365, width: 87, height: 32 },
    true
  )
  assert.ok(layout.rightInset >= 105)
  assert.ok(layout.navigationHeight - layout.statusBarHeight >= 44)
})
