/**
 * E08 · 装机检测与交付页的纯口径函数测试。
 *
 * 证明的是「界面按服务端给的事实说话」，不做业务判断：
 *   · 检测结论 / 闸门判定 / 按钮口径都从看板数据推导，服务端没给的字段不猜；
 *   · 金额按整数分换算（元输入 → 分），非法输入不给 0。
 */
import { describe, expect, it } from 'vitest'

import {
  assemblyStep,
  defaultChecklistItems,
  deliveryGates,
  gapSummary,
  yuanToCents,
} from './fulfillment-view'
import type { FulfillmentBoardPayload } from './fulfillment-api'

function board(overrides: Partial<FulfillmentBoardPayload> = {}): FulfillmentBoardPayload {
  return {
    order: {
      id: 'o-1',
      orderNo: 'SO-20260921-00000001',
      kind: 'assembly',
      tradeState: 'confirmed',
      fulfillmentState: 'testing',
      configurationVersion: 0,
      totalCents: 200_000,
      balanceCents: 0,
      balanceDirection: 'settled',
      isFullyPaid: true,
      requiredDepositCents: 30_000,
      version: 3,
      customerName: '陈先生',
    },
    gaps: [],
    missingSnItems: [],
    checklists: [],
    latestChecklist: null,
    delivery: null,
    ...overrides,
  }
}

describe('assemblyStep', () => {
  it('装机单：待备料 → 开始备料；备料中 → 提交检测', () => {
    expect(assemblyStep('waiting_stock', 'assembly').action).toBe('开始备料')
    expect(assemblyStep('preparing', 'assembly').action).toBe('备料完成，提交检测')
  })

  it('零售单：不提「装机」，只提核对', () => {
    expect(assemblyStep('waiting_stock', 'retail').action).toBe('开始核对')
    expect(assemblyStep('preparing', 'retail').action).toBe('核对完成，进入交付')
  })

  it('到交付阶段之后不再提供备料动作', () => {
    expect(assemblyStep('ready_delivery', 'assembly').action).toBeNull()
    expect(assemblyStep('delivered', 'assembly').action).toBeNull()
  })
})

describe('deliveryGates', () => {
  it('全部满足时六项闸门都是 ok', () => {
    const gates = deliveryGates(board({
      order: { ...board().order, fulfillmentState: 'ready_delivery' },
      checklists: [{
        id: 'c-1', checklistVersion: 1, templateVersion: 'asm-v1', configurationVersion: 0,
        result: 'passed', itemCount: 4, failCount: 0, performedAt: '', performedByName: '',
      }],
    }))
    expect(gates.every((gate) => gate.ok)).toBe(true)
  })

  it('装机单没有通过的检测记录时，检测闸门不亮；零售单只要记过一次即可', () => {
    const assembly = deliveryGates(board())
    expect(assembly.find((gate) => gate.key === 'checks')?.ok).toBe(false)

    const retail = deliveryGates(board({
      order: { ...board().order, kind: 'retail' },
      checklists: [{
        id: 'c-2', checklistVersion: 1, templateVersion: 'asm-v1', configurationVersion: 0,
        result: 'failed', itemCount: 2, failCount: 1, performedAt: '', performedByName: '',
      }],
    }))
    expect(retail.find((gate) => gate.key === 'checks')?.ok).toBe(true)
  })

  it('尾款、缺口、缺 SN 各自只影响自己的闸门', () => {
    const gates = deliveryGates(board({
      order: { ...board().order, balanceCents: 50_000, balanceDirection: 'client_due', isFullyPaid: false },
      gaps: [{ lineId: 'l-1', position: 0, nameSnapshot: '内存条', qty: 2, reservedQty: 1, shortageQty: 1 }],
      missingSnItems: ['si-1'],
    }))
    expect(gates.find((gate) => gate.key === 'money')?.ok).toBe(false)
    expect(gates.find((gate) => gate.key === 'stock')?.ok).toBe(false)
    expect(gates.find((gate) => gate.key === 'sn')?.ok).toBe(false)
    expect(gates.find((gate) => gate.key === 'trade')?.ok).toBe(true)
    expect(gapSummary([{
      lineId: 'l-1', position: 0, nameSnapshot: '内存条', qty: 2, reservedQty: 1, shortageQty: 1,
    }])).toBe('内存条 差 1 件，共 1 件')
  })
})

describe('defaultChecklistItems', () => {
  it('装机单给四项（核对 + 检测），零售单给两项核对', () => {
    expect(defaultChecklistItems('assembly')).toHaveLength(4)
    expect(defaultChecklistItems('assembly').every((item) => item.state === 'pending')).toBe(true)
    expect(defaultChecklistItems('retail').every((item) => item.kind === 'check')).toBe(true)
  })
})

describe('yuanToCents', () => {
  it('按整数分换算，四舍五入到分；非法输入返回 null 而不是 0', () => {
    expect(yuanToCents('12.3')).toBe(1230)
    expect(yuanToCents('0.005')).toBe(1)
    expect(yuanToCents('')).toBeNull()
    expect(yuanToCents('abc')).toBeNull()
    expect(yuanToCents('-1')).toBeNull()
  })
})
