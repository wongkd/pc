/**
 * T02b · 设备简称切分。
 *
 * 这个函数决定详情页主标题显示什么。切错了用户会认错单，
 * 所以边界（无分隔符、空值、多分隔符、带空格的型号）都要钉住。
 *
 * 运行：node --test "tests/*.test.mjs"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deviceShortName } from '../features/display-text.ts'
import { DEMO_TASKS } from '../features/demo-data.ts'

test('deviceShortName 取「·」之前那段', () => {
  assert.equal(deviceShortName('白色设计主机 · 设计用装机'), '白色设计主机')
  assert.equal(deviceShortName('游戏主机 · 缺 SSD 1 件'), '游戏主机')
})

test('deviceShortName 没有分隔符时整段返回', () => {
  assert.equal(deviceShortName('白色设计主机'), '白色设计主机')
})

test('deviceShortName 多个分隔符只取第一段', () => {
  assert.equal(deviceShortName('办公套装 · 显示器在途 · 明日到货'), '办公套装')
})

test('deviceShortName 空值返回空串，不返回 "null" 或占位符', () => {
  assert.equal(deviceShortName(null), '')
  assert.equal(deviceShortName(''), '')
})

test('deviceShortName 不进一步截断（含空格的型号必须完整保留）', () => {
  assert.equal(deviceShortName('ThinkPad X1 Carbon · 主板更换'), 'ThinkPad X1 Carbon')
})

test('七条样本都能切出非空且不含状态词的简称', () => {
  for (const task of DEMO_TASKS) {
    const short = deviceShortName(task.deviceSummary)
    assert.ok(short.length > 0, `${task.taskId} 的简称不应为空`)
    assert.ok(!short.includes(' · '), `${task.taskId} 的简称不应再含分隔符`)
    // 主标题 = 客户 · 简称。状态（待 / 已 / 未）归阶段与卡点区表达；
    // 塞进标题会让同一张单在不同时刻显示成不同标题。
    assert.ok(!/[待已未]/.test(short), `${task.taskId} 的简称不应含状态词：${short}`)
  }
})
