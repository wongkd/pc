/**
 * T02b · 金额呈现规则与格式化。
 *
 * 这里断言的是 02 §4 / §6 与 `fixtures.shapeDefinitions.amountSummary.rules` 里
 * 明确写死的**禁止项**：不得用初估冒充待收、不得用 ¥0 冒充未定价、不得把应付
 * 显示成负尾款、禁用动作不得只置灰而不给原因。
 *
 * 运行：node --test tests/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { describeAction, describeAmount, formatCents, formatYuan } from '../features/amount-view.ts'

test('formatCents 千分位与两位小数（与电脑端显示格式一致）', () => {
  assert.equal(formatCents(0), '0.00')
  assert.equal(formatCents(1), '0.01')
  assert.equal(formatCents(100), '1.00')
  assert.equal(formatCents(428000), '4,280.00')
  assert.equal(formatCents(1280000), '12,800.00')
  assert.equal(formatCents(128000000), '1,280,000.00')
})

test('formatCents 保留负号（退款 / 冲销）', () => {
  assert.equal(formatCents(-1), '-0.01')
  assert.equal(formatCents(-428000), '-4,280.00')
})

test('formatCents 不吞掉「分」', () => {
  assert.equal(formatCents(1000001), '10,000.01')
  assert.equal(formatCents(999999999), '9,999,999.99')
})

test('formatYuan 带 ¥ 前缀', () => {
  assert.equal(formatYuan(1280000), '¥12,800.00')
})

test('待收：显示尾款与方向，并给出总额 / 已收明细', () => {
  const view = describeAmount({
    totalCents: 628000,
    receivedCents: 200000,
    offsetCents: 0,
    balanceCents: 428000,
    balanceDirection: 'client_due',
    estimateCents: null,
    countsTowardReceivable: true,
    note: null,
  })
  assert.equal(view.primary, '¥4,280.00')
  assert.equal(view.directionLabel, '待收')
  assert.equal(view.confirmed, true)
  assert.match(view.detail, /总额 ¥6,280\.00/)
  assert.match(view.detail, /已收 ¥2,000\.00/)
  assert.doesNotMatch(view.detail, /折抵/, '折抵为 0 时不显示折抵')
})

test('结清：显示「已结清」并提醒仍需确认实物交出', () => {
  const view = describeAmount({
    totalCents: 368000,
    receivedCents: 368000,
    offsetCents: 0,
    balanceCents: 0,
    balanceDirection: 'settled',
    estimateCents: null,
    countsTowardReceivable: true,
    note: '尾款为 0，仍须确认实物交出',
  })
  assert.equal(view.primary, '已结清')
  assert.equal(view.directionLabel, '已结清')
  assert.match(view.detail, /仍须确认实物交出/)
})

test('应付：显示为「应付客户」，不得变成负尾款', () => {
  const view = describeAmount({
    totalCents: 100000,
    receivedCents: 120000,
    offsetCents: 0,
    balanceCents: 20000,
    balanceDirection: 'store_due',
    estimateCents: null,
    countsTowardReceivable: true,
    note: null,
  })
  assert.equal(view.primary, '¥200.00')
  assert.equal(view.directionLabel, '应付客户')
  assert.doesNotMatch(view.primary, /^-/, '应付不得显示成负尾款（02 §6）')
})

test('预计：初估要标明「预计」且不计确定应收', () => {
  const view = describeAmount({
    totalCents: null,
    receivedCents: null,
    offsetCents: null,
    balanceCents: null,
    balanceDirection: null,
    estimateCents: 48000,
    countsTowardReceivable: false,
    note: '预计费用，不计确定应收',
  })
  assert.equal(view.primary, '¥480.00')
  assert.equal(view.directionLabel, '预计')
  assert.equal(view.confirmed, false, '初估不得标记为已确认应收')
})

test('未定价：写「待确认」，不得用 ¥0 冒充', () => {
  const view = describeAmount({
    totalCents: null,
    receivedCents: null,
    offsetCents: null,
    balanceCents: null,
    balanceDirection: null,
    estimateCents: null,
    countsTowardReceivable: false,
    note: '费用待确认',
  })
  assert.equal(view.primary, '', '未定价时不得给出任何数字')
  assert.equal(view.directionLabel, '待确认')
  assert.equal(view.confirmed, false)
})

test('无金额记录时不虚构金额', () => {
  const view = describeAmount(null)
  assert.equal(view.primary, '')
  assert.equal(view.confirmed, false)
})

test('主动作：禁用时必须给出可读原因', () => {
  const blocked = describeAction({
    label: '办理交付（先核对）',
    enabled: false,
    blockers: [{ message: '检查项 2/3 完成，附件未打包' }],
  })
  assert.equal(blocked.enabled, false)
  assert.match(blocked.blockerText, /检查项 2\/3/)

  const ok = describeAction({ label: '办理交付', enabled: true, blockers: [] })
  assert.equal(ok.enabled, true)
  assert.equal(ok.blockerText, '')
})
