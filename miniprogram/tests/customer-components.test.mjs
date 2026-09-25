import { test } from 'node:test'
import assert from 'node:assert/strict'
import { customerImageCrop, customerImageLayout } from '../components/customer-image/view.ts'
import { customerStateView } from '../components/customer-state/view.ts'

test('图片框在加载前固定比例，焦点值安全限制在画面内', () => {
  assert.deepEqual(customerImageLayout(1.5, 30, 70), {
    ratioPadding: '66.6667%',
    objectPosition: '30% 70%',
  })
  assert.deepEqual(customerImageLayout(0, -10, 140), {
    ratioPadding: '100.0000%',
    objectPosition: '0% 100%',
  })
  assert.equal(customerImageLayout(Number.NaN).ratioPadding, '100.0000%')
})

test('空态、网络失败、无权和过期语义分开，只有错误类状态允许请求重试', () => {
  assert.equal(customerStateView('empty').retryable, false)
  assert.equal(customerStateView('offline').retryable, true)
  assert.equal(customerStateView('error').retryable, true)
  assert.equal(customerStateView('forbidden').retryable, false)
  assert.equal(customerStateView('expired').retryable, false)
  assert.equal(customerStateView('empty').title, '这里暂时没有内容')
})

test('宽图填满竖向容器保持原比例，左右焦点不会留下空边', () => {
  assert.equal(customerImageCrop(1, 200, 100, 0, 50), 'width:200.0000%;height:100.0000%;left:0.0000%;top:0.0000%;')
  assert.equal(customerImageCrop(1, 200, 100, 100, 50), 'width:200.0000%;height:100.0000%;left:-100.0000%;top:0.0000%;')
  assert.equal(customerImageCrop(2, 100, 100, 50, 100), 'width:100.0000%;height:200.0000%;left:0.0000%;top:-100.0000%;')
  assert.equal(customerImageCrop(0, 0, 0), 'width:100%;height:100%;left:0;top:0;')
})

test('标题和说明由调用方提供，长说明不被组件逻辑截短', () => {
  const description = '网络请求暂时失败，请确认连接后再次尝试。'.repeat(20)
  assert.equal(customerStateView('error', '暂不可用', description).description, description)
})
