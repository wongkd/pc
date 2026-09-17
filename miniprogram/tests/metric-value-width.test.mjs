/**
 * T02b-rev2 · 统计数值宽度预算的约束测试（修 OPEN-ITEMS R-14）。
 *
 * 为什么单独一个文件：这里断言的**不是业务语义**，而是 02 §103 那条呈现约束 ——
 * 「统计在宽屏四列，320px 或大金额时允许两行两列；不把 ¥128,000.50 缩成极小字号
 * 或省略成无法核账的数」。它跨了三个文件（amount-view.ts 的档位、today/index.wxss
 * 的类与格宽、today/index.wxml 的绑定），所以集中在这里一处钉死。
 *
 * 断言的性质要说清楚：WXML 里量不到文字宽度，故宽度是**估算**。本文件断言的是
 * 「所选档位满足估算预算」「规格点名的金额形态落在哪一档」「档位/格宽/绑定三者对得上」，
 * **不是**「真机上一定不溢出」—— 后者只能在开发者工具或真机上逐档复核（本卡未做）。
 *
 * 运行：npm test（node --test "tests/*.test.mjs"）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  METRIC_VALUE_BUDGET_PX,
  METRIC_VALUE_TIERS,
  estimateMetricValueWidthPx,
  formatYuan,
  metricValueClass,
} from '../features/amount-view.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8')
const todayWxss = read('pages', 'today', 'index.wxss')
const todayWxml = read('pages', 'today', 'index.wxml')
const todayTs = read('pages', 'today', 'index.ts')

/** 下限档位：不再往下缩，宁可小也不裁掉位数。 */
const FLOOR_TIER = METRIC_VALUE_TIERS[METRIC_VALUE_TIERS.length - 1]

/**
 * 四格等分时单格的内容宽度（px）：容器 750rpx − 4 格 × 左右各 4rpx 内边距
 * = 718rpx ÷ 4 = 179.5rpx = 89.75px（375px 设计宽度）。
 */
const EQUAL_CELL_CONTENT_PX = 89.75

test('回归钉：等分四格装不下 ¥12,800.00（T02b §14.2 实测缺陷 1）', () => {
  const text = formatYuan(1280000)
  assert.equal(text, '¥12,800.00', '今天页第四格的实际文案，必须是带分位的 10 字符')

  assert.ok(
    estimateMetricValueWidthPx(text, 20) > EQUAL_CELL_CONTENT_PX,
    '按等分格宽估算应放不下 —— 这正是截图里金额被裁的原因；' +
      '若这里不再超出，说明估算系数被改松了，回归钉失效',
  )
  assert.ok(
    estimateMetricValueWidthPx(text, 20) <= METRIC_VALUE_BUDGET_PX,
    '金额格加宽后，同一文案应落在预算内（这是本卡的修法）',
  )
})

test('02 §103 点名的金额形态不得落到下限档', () => {
  // 常规金额（含本卡实测出问题的那一笔）用基准档
  for (const text of ['2', '07', '¥0.00', '¥4,280.00', '¥12,800.00', '已结清']) {
    assert.equal(metricValueClass(text), '', `「${text}」应使用基准档字号`)
  }

  // ¥128,000.50 是 02 §103 原文举例。它是 11 字符（¥ + 8 位数字 + 逗号 + 小数点），
  // 比常规金额长一档，降一档字号是预期行为；红线是**不得落到下限档**，
  // 因为 02 §103 禁止把它「缩成极小字号」。
  const specSample = metricValueClass('¥128,000.50')
  const specTier = METRIC_VALUE_TIERS.find((t) => t.className === specSample)
  assert.ok(
    specTier.fontSizePx >= 16,
    `规格举例降到 ${specTier.fontSizePx}px 了，低于 02 §1 的正文档位 16px`,
  )
  assert.notEqual(specSample, FLOOR_TIER.className, '规格举例不得落到下限档')
})

test('金额越长档位只降不升，且永不越过下限', () => {
  const amounts = [
    formatYuan(0),
    formatYuan(428000),
    formatYuan(1280000),
    formatYuan(12800000),
    formatYuan(128000000),
    formatYuan(1280000000),
    formatYuan(12800000000),
    formatYuan(100000000000),
  ]
  const sizes = amounts.map((text) => {
    const cls = metricValueClass(text)
    const tier = METRIC_VALUE_TIERS.find((t) => t.className === cls)
    assert.ok(tier, `「${text}」返回了未声明的档位：${cls}`)
    return tier.fontSizePx
  })

  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i] <= sizes[i - 1], `${amounts[i]} 的字号大于前一个更短的金额`)
  }
  assert.ok(sizes[sizes.length - 1] >= FLOOR_TIER.fontSizePx, '不得小于下限档位')
})

test('预算外只降到下限，不返回空档位也不省略数字', () => {
  const huge = formatYuan(999999999999999) // 远超所有档位：属于已知边界
  assert.equal(metricValueClass(huge), FLOOR_TIER.className)
  assert.equal(metricValueClass(''), '', '空文案按基准档处理')
  // 函数只给字号档位，绝不返回改过的文案 —— 金额少一位就是核不了账
  assert.equal(typeof metricValueClass(huge), 'string')
})

test('所选档位满足宽度预算（下限档除外）', () => {
  const samples = [
    '',
    '2',
    '07',
    '已结清',
    formatYuan(0),
    formatYuan(428000),
    formatYuan(1280000),
    formatYuan(128000000),
    formatYuan(1280000000),
  ]
  for (const text of samples) {
    const tier = METRIC_VALUE_TIERS.find((t) => t.className === metricValueClass(text))
    const width = estimateMetricValueWidthPx(text, tier.fontSizePx)
    if (tier !== FLOOR_TIER) {
      assert.ok(
        width <= METRIC_VALUE_BUDGET_PX,
        `「${text}」选了 ${tier.fontSizePx}px，估算 ${width.toFixed(1)}px 超出预算 ${METRIC_VALUE_BUDGET_PX}px`,
      )
    }
  }
})

test('档位类名、字号与格宽必须在今天页样式里真实存在（rpx = px × 2）', () => {
  // 档位是拼进 class 的，check-classes 检不出来（它只认 wxml 里的字面量），故在这里兜
  for (const tier of METRIC_VALUE_TIERS) {
    const selector = tier.className || 'metric-value'
    assert.match(
      todayWxss,
      new RegExp(`\\.${selector}\\s*\\{[^}]*font-size:\\s*${tier.fontSizePx * 2}rpx`),
      `.${selector} 的字号与 METRIC_VALUE_TIERS 的 ${tier.fontSizePx}px 对不上`,
    )
  }

  // 格宽与预算是一对：改一个不改另一个，档位算出来的字宽就不作数
  assert.match(todayWxss, /\.metric-money\s*\{[^}]*min-width:\s*260rpx/)
  assert.match(todayWxss, /@media \(max-width: 360px\)[\s\S]*\.metric-money\s*\{[^}]*min-width:\s*0/)
  // 金额不许换行：断成两行会被读成两个数
  assert.match(todayWxss, /\.metric-value\s*\{[^}]*white-space:\s*nowrap/)
})

test('模板与页面真的把这套档位接上了（防样式写了没人用）', () => {
  assert.match(todayWxml, /\{\{item\.isMoney \? 'metric-money' : ''\}\}/, '金额格未绑定加宽类')
  assert.match(todayWxml, /class="metric-value mp-tabular \{\{item\.valueClass\}\}"/, '数值未绑定档位类')

  // 档位必须由 metricValueClass 现算。这条是结构检查（页面里有 Page() 全局，node --test
  // 加载不了 index.ts）；T02c 把视图模型提成纯模块后，应换成真正的单元测试。
  assert.match(todayTs, /valueClass:\s*metricValueClass\(value\)/, '档位不是由 metricValueClass 算的')
})
