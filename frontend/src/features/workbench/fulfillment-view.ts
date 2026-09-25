/**
 * E08 · 装机检测与交付页的纯口径函数。
 *
 * 与 `inventory-view.ts` 同一位置：只做「服务端给的事实 → 界面怎么说话」，
 * 不发请求、不做业务判断。业务判定永远在服务端（B06 / B07 / B10 的守卫），
 * 这里的 blockers 只是「按钮为什么点不动 / 服务端大概会拦什么」的解释，不拦截提交。
 */

import type { CheckItemPayload, CheckResult, CoverageGap, FulfillmentBoardPayload } from './fulfillment-api'

export const FULFILLMENT_LABELS: Record<string, string> = {
  waiting_stock: '待备料',
  preparing: '备料中',
  testing: '检测中',
  ready_delivery: '待交付',
  delivered: '已交付',
}

export const CHECK_RESULT_LABELS: Record<CheckResult, string> = {
  incomplete: '未完成',
  passed: '通过',
  failed: '不通过',
}

export const CHECK_ITEM_STATE_LABELS: Record<string, string> = {
  pending: '未检',
  pass: '通过',
  fail: '不通过',
}

export const CHECK_KIND_LABELS: Record<string, string> = {
  check: '核对项',
  test: '检测项',
}

export const DISPOSITION_LABELS: Record<string, string> = {
  settled_in_full: '已结清',
  credit_approved: '批准欠款',
}

export const SOURCE_LABELS: Record<string, string> = {
  new: '新品',
  used: '二手件',
  customer: '客供件',
  service: '服务费',
}

export const KIND_LABELS: Record<string, string> = {
  assembly: '装机',
  retail: '零售',
}

/** 元输入 → 整数分。空串 / 非法输入返回 null。 */
export function yuanToCents(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}

export interface AssemblyStep {
  /** 按钮文案。null 表示当前阶段没有备料动作可做。 */
  action: string | null
  hint: string
}

/**
 * 备料按钮的口径（enums.json SaleFulfillmentState 的两条 B06 出边）：
 *   waiting_stock → preparing（开始备料）；preparing → testing（备料完成，提交检测）。
 * 零售单不需要装机，但保留同样的推进能力 —— 界面按单类型换文案。
 */
export function assemblyStep(fulfillmentState: string, kind: string): AssemblyStep {
  if (fulfillmentState === 'delivered') return { action: null, hint: '这张单已经交付。' }
  if (fulfillmentState === 'ready_delivery') return { action: null, hint: '已到交付处理阶段，可以直接办理交付。' }
  if (fulfillmentState === 'testing') return { action: null, hint: '检测中：把每项结果记下来，通过后就能交付。' }
  if (fulfillmentState === 'preparing') {
    return {
      action: kind === 'retail' ? '核对完成，进入交付' : '备料完成，提交检测',
      hint: '备料完成后再点一次「开始备料」，单子就进入检测阶段。',
    }
  }
  return {
    action: kind === 'retail' ? '开始核对' : '开始备料',
    hint: '先收款并确认成交，货占住了才能备料。',
  }
}

/**
 * 交付前服务端会逐项核的闸门，界面上逐条亮出来。
 * 这只是解释，不是拦截 —— 真正的判定在 B10 的守卫里。
 */
export interface DeliveryGate {
  key: string
  label: string
  ok: boolean
  hint: string
}

export function deliveryGates(board: FulfillmentBoardPayload): DeliveryGate[] {
  const { order, gaps, missingSnItems, checklists } = board
  const passedChecklist = checklists.find(
    (row) => row.result === 'passed' && row.configurationVersion === order.configurationVersion,
  )
  const shortageQty = gaps.reduce((sum, gap) => sum + gap.shortageQty, 0)
  return [
    {
      key: 'trade',
      label: '订单已成交',
      ok: order.tradeState === 'confirmed',
      hint: order.tradeState === 'confirmed' ? '成交后才谈得上交付。' : '先收款并确认成交。',
    },
    {
      key: 'stage',
      label: '已到交付阶段',
      ok: order.fulfillmentState === 'ready_delivery',
      hint: order.fulfillmentState === 'ready_delivery'
        ? '可以办理交付。'
        : order.fulfillmentState === 'delivered'
          ? '这张单已经交付过。'
          : '备料与检测都完成后才到交付阶段。',
    },
    {
      key: 'stock',
      label: '店有货已占齐',
      ok: shortageQty === 0,
      hint: shortageQty === 0
        ? '每一行需要店有货的都占住了。'
        : `还有 ${shortageQty} 件没占住（${gaps.map((gap) => gap.nameSnapshot).join('、')}）。`,
    },
    {
      key: 'sn',
      label: '内部编号核对',
      ok: missingSnItems.length === 0,
      hint: missingSnItems.length === 0 ? '内部编号齐全。' : `缺少内部编号：${missingSnItems.join('、')}。`,
    },
    {
      key: 'checks',
      label: order.kind === 'retail' ? '核对结果已记录' : '装机检测已通过',
      ok: order.kind === 'retail' ? checklists.length > 0 : Boolean(passedChecklist),
      hint: order.kind === 'retail'
        ? checklists.length > 0
          ? '零售单跳过装机检测，但至少要记一次核对结果。'
          : '先记一次核对结果（零售单不要求全部通过）。'
        : passedChecklist
          ? `第 ${passedChecklist.checklistVersion} 版检测通过。`
          : '还没有「通过」的检测记录。',
    },
    {
      key: 'money',
      label: '款项已结清',
      ok: order.balanceCents <= 0,
      hint: order.balanceCents <= 0
        ? '尾款已结清。'
        : `尾款还有 ¥${(order.balanceCents / 100).toFixed(2)}；欠款交付需要老板批准（B09，尚未实现）。`,
    },
  ]
}

/** 检测项表单的初始项：装机常用四项 + 零售核对两项，可增删。 */
export function defaultChecklistItems(kind: string): CheckItemPayload[] {
  if (kind === 'retail') {
    return [
      { key: 'appearance', label: '外观与配件齐全', kind: 'check', state: 'pending', note: '', stockItemId: null },
      { key: 'sn', label: 'SN / 编号核对', kind: 'check', state: 'pending', note: '', stockItemId: null },
    ]
  }
  return [
    { key: 'appearance', label: '外观无划痕', kind: 'check', state: 'pending', note: '', stockItemId: null },
    { key: 'cable', label: '线材整理与固定', kind: 'check', state: 'pending', note: '', stockItemId: null },
    { key: 'boot', label: '点亮', kind: 'test', state: 'pending', note: '', stockItemId: null },
    { key: 'burn', label: '烤机 30 分钟', kind: 'test', state: 'pending', note: '', stockItemId: null },
  ]
}

/** 缺口的一句话摘要；没有缺口返回 null。 */
export function gapSummary(gaps: readonly CoverageGap[]): string | null {
  if (gaps.length === 0) return null
  const total = gaps.reduce((sum, gap) => sum + gap.shortageQty, 0)
  return `${gaps.map((gap) => `${gap.nameSnapshot} 差 ${gap.shortageQty} 件`).join('、')}，共 ${total} 件`
}
