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
