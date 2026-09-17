/**
 * T02b · 金额的格式化与呈现口径。
 *
 * 依据：
 *  - `contracts/v1/objects.json` BalanceDirection（client_due / settled / store_due）
 *  - `contracts/v1/fixtures.json` shapeDefinitions.amountSummary.rules
 *  - 02 §4「不得把所有详情底部套成 ¥0 办理交付」、02 §6 AmountActionBar
 *    「欠款 / 结清 / 未定价 / 无权限 / 正在核实，不把应付显示成负尾款」
 *
 * 三条硬规则：
 *  1. countsTowardReceivable=false 时，**不得**把 estimateCents 冒充待收；
 *  2. 未定价（totalCents=null 且无预计）必须写「待确认」，**不得**用 ¥0 表示未知；
 *  3. store_due 显示为「应付」，**不得**显示成负尾款。
 *
 * 本模块只依赖类型导入（编译后为空），因此 `node --test` 可以直接加载源码做断言，
 * 不需要先构建 —— 见 `tests/amount-view.test.mjs`。
 */

import type { WorkbenchAmountSummary } from './demo-data'

/**
 * 分 → 显示文案。负数保留负号（退款、冲销场景）。
 *
 * ⚠️ 不使用 `toLocaleString('zh-CN', …)`：小程序的 JSCore（iOS JavaScriptCore /
 * Android V8）对 Intl 支持不完整，同一段代码在不同机型上可能给出不同的千分位结果，
 * 甚至静默去分组。金额显示错误属于业务事故，故用纯字符串运算，任何环境结果一致。
 */
export function formatCents(cents: number): string {
  const rounded = Math.round(cents)
  const negative = rounded < 0
  const abs = Math.abs(rounded)
  const yuan = Math.floor(abs / 100)
  const fen = abs % 100
  const grouped = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}${grouped}.${String(fen).padStart(2, '0')}`
}

/** 分 → 带 ¥ 前缀的显示文案。 */
export function formatYuan(cents: number): string {
  return `¥${formatCents(cents)}`
}

/* ── 统计数值的宽度预算与字号分档（T02b-rev2，修 OPEN-ITEMS R-14）──────────────
 *
 * 要解决的是实测缺陷：今天页统计第四格「待收款 ¥12,800.00」在 375px 下超出格宽被裁
 * （docs/verification/2026-09-17-T02b/README.md §14.2 缺陷 1）。02 §103 对这条写了
 * 两条**必须同时成立**的要求：
 *   「统计在宽屏四列，320px 或大金额时允许两行两列」
 *   「不把 ¥128,000.50 缩成极小字号或省略成无法核账的数」
 * 即要放得下，又不能靠裁切或省略糊过去 —— 金额少一位就是核不了账。
 *
 * 为什么不能只定一个字号：小额度浪费宽度、大额度直接溢出。故按渲染文案的**字符类别**
 * 估算宽度，从大到小挑第一个放得下的档位。宽度预算由页面上格子的宽度决定，见
 * `METRIC_VALUE_BUDGET_PX`；格宽在 `pages/today/index.wxss` 的 `.metric-money`。
 *
 * ⚠️ 这是**估算，不是实测**：WXML 里量不到文字宽度，字宽系数取自系统字体
 * （PingFang SC / Roboto）的常见量级并留了余量。估算偏保守只是字号小一档，偏乐观则是
 * 金额被裁 —— 故宁可保守。真机上仍需在开发者工具里逐档复核（本卡未验，见验证记录）。
 *
 * 永不省略：本模块只给出字号档位，**不返回截断后的文案**；预算外只降到下限为止。
 */

/**
 * 金额格可用的内容宽度（px）。
 *
 * 来源：4 列布局适用的最窄宽度 361px 下，`.metric-money` 的 `min-width: 260rpx`
 * ≈ 125px，减去左右各 4rpx 内边距 ≈ 121px，取 120px 作为预算。
 * **改这里必须同步改 `pages/today/index.wxss` 的 `.metric-money`，否则档位算出的字宽不作数。**
 */
export const METRIC_VALUE_BUDGET_PX = 120

/**
 * 字号档位，从大到小。`className` 为空表示基准档（`.metric-value` 自身的字号）。
 * 类名与 `pages/today/index.wxss` 的定义一一对应，由 `tests/metric-value-width.test.mjs`
 * 反向核对 —— 类名写错时 check-classes 检不出来（档位是拼进 class 的），故在这里兜。
 */
export const METRIC_VALUE_TIERS = [
  { className: '', fontSizePx: 20 }, // 40rpx —— 计数与常规金额
  { className: 'metric-value-md', fontSizePx: 18 }, // 36rpx
  { className: 'metric-value-sm', fontSizePx: 16 }, // 32rpx —— 02 §1 的正文档位
  { className: 'metric-value-xs', fontSizePx: 14 }, // 28rpx —— 下限，宁可小也不裁掉位数
] as const

/** 单字宽度系数（em）。取系统字体里该字符 advance 的常见量级再放大一点。 */
const GLYPH_EM = {
  /** 数字。等宽数字（.mp-tabular）保证同类字号下 advance 一致。 */
  digit: 0.6,
  /** 千分位与小数点。 */
  separator: 0.33,
  /** 负号（退款、冲销）。 */
  minus: 0.4,
  /** ¥ 与中文字（如「已结清」）——按 1em 算，宁可高估。 */
  wide: 1,
}

/** 估算一段文案在给定字号下占的宽度（px）。 */
export function estimateMetricValueWidthPx(text: string, fontSizePx: number): number {
  let em = 0
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') em += GLYPH_EM.digit
    else if (ch === ',' || ch === '.') em += GLYPH_EM.separator
    else if (ch === '-') em += GLYPH_EM.minus
    else em += GLYPH_EM.wide
  }
  return em * fontSizePx
}

/**
 * 统计数值该用哪个字号档位。返回附加类名，空串表示基准档。
 *
 * 超出所有档位的预算时返回**下限档位**而不是进一步缩小：放不下是格子宽度的问题，
 * 不该拿可读性去换；此时数字仍完整显示（这是已知边界，见验证记录）。
 */
export function metricValueClass(text: string): string {
  for (const tier of METRIC_VALUE_TIERS) {
    if (estimateMetricValueWidthPx(text, tier.fontSizePx) <= METRIC_VALUE_BUDGET_PX) {
      return tier.className
    }
  }
  return METRIC_VALUE_TIERS[METRIC_VALUE_TIERS.length - 1].className
}

export interface AmountView {
  /** 主金额文案，如 `¥4,280.00` / `已结清`；未定价时为 ''。 */
  primary: string
  /** 方向标签：待收 / 应付客户 / 已结清 / 预计 / 待确认。 */
  directionLabel: string
  /** 明细说明：总额 / 已收 / 折抵，或未定价原因。 */
  detail: string
  /** 是否属于「已确认应收」。false 时不得计入待收汇总。 */
  confirmed: boolean
}

export function describeAmount(amount: WorkbenchAmountSummary | null): AmountView {
  if (!amount) {
    return { primary: '', directionLabel: '', detail: '无金额记录', confirmed: false }
  }

  if (!amount.countsTowardReceivable) {
    if (amount.estimateCents !== null) {
      return {
        primary: formatYuan(amount.estimateCents),
        directionLabel: '预计',
        detail: amount.note ?? '预计金额，不计确定应收',
        confirmed: false,
      }
    }
    return {
      primary: '',
      directionLabel: '待确认',
      detail: amount.note ?? '金额待确认，不得用 0 冒充',
      confirmed: false,
    }
  }

  const parts: string[] = []
  if (amount.totalCents !== null) parts.push(`总额 ${formatYuan(amount.totalCents)}`)
  if (amount.receivedCents !== null) parts.push(`已收 ${formatYuan(amount.receivedCents)}`)
  if (amount.offsetCents !== null && amount.offsetCents > 0) {
    parts.push(`折抵 ${formatYuan(amount.offsetCents)}`)
  }
  const detail = parts.join(' · ')

  if (amount.balanceDirection === 'settled') {
    return {
      primary: '已结清',
      directionLabel: '已结清',
      detail: [detail, amount.note ?? '尾款为 0，仍须确认实物交出'].filter(Boolean).join(' · '),
      confirmed: true,
    }
  }

  if (amount.balanceCents === null) {
    return { primary: '', directionLabel: '待确认', detail: detail || '尾款待确认', confirmed: true }
  }

  return {
    primary: formatYuan(amount.balanceCents),
    directionLabel: amount.balanceDirection === 'store_due' ? '应付客户' : '待收',
    detail,
    confirmed: true,
  }
}

/** 主动作在界面上的呈现：禁用时必须给出可读原因，不得只置灰。 */
export function describeAction(action: {
  label: string
  enabled: boolean
  blockers: { message: string }[]
}): { label: string; enabled: boolean; blockerText: string } {
  const blockerText = action.enabled ? '' : action.blockers.map((b) => b.message).join('；')
  return { label: action.label, enabled: action.enabled, blockerText }
}
