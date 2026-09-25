// @vitest-environment jsdom
/**
 * E08 · 装机检测与交付页（真实接口装配）渲染与提交测试。
 *
 * 证明的是「页面按服务端给的事实显示、按契约提交」，不证明后端行为（后端见
 * backend/tests/e08-fulfillment-http.test.mjs）。重点四条：
 *   · 无权限时明确说明缺什么权限，而不是渲染一个空页；
 *   · 闸门按服务端看板逐条显示，缺货 / 尾款 / 检测各说各的；
 *   · 检测结果按当前各项状态提交，结论不在前端报「通过」；
 *   · 服务端拒绝时保留输入、不报成功。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  fetchSaleOrders: vi.fn(),
  fetchFulfillmentDetail: vi.fn(),
  startAssembly: vi.fn(),
  saveAssemblyChecks: vi.fn(),
  deliverOrder: vi.fn(),
}))

vi.mock('./sales-api', () => ({
  fetchSaleOrders: mocks.fetchSaleOrders,
}))
vi.mock('./fulfillment-api', () => ({
  fetchFulfillmentDetail: mocks.fetchFulfillmentDetail,
  startAssembly: mocks.startAssembly,
  saveAssemblyChecks: mocks.saveAssemblyChecks,
  deliverOrder: mocks.deliverOrder,
}))

import { WorkbenchFulfillmentPage } from './WorkbenchFulfillmentPage'
import type { FulfillmentBoardPayload, FulfillmentDetailPayload } from './fulfillment-api'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState({}, '', '/')
})

const listPayload = {
  orders: [
    {
      id: 'o-1', orderNo: 'SO-20260921-AAAA', customerName: '陈先生', kind: 'assembly',
      tradeState: 'confirmed', fulfillmentState: 'testing', totalCents: 200_000,
      cashNetCents: 200_000, balanceCents: 0, balanceDirection: 'settled', isFullyPaid: true,
      quoteId: null, quoteRevision: null, lineCount: 1, reservedCount: 1, shortageCount: 0,
      dueAt: null, createdAt: '2026-09-21T04:00:00Z', updatedAt: '2026-09-21T04:10:00Z',
    },
  ],
  totals: { all: 1, draft: 0, confirmed: 1, awaitingPayment: 0, receivableCents: 0 },
  settings: { depositPercent: 15 },
}

function board(overrides: Partial<FulfillmentBoardPayload> = {}): FulfillmentBoardPayload {
  return {
    order: {
      id: 'o-1', orderNo: 'SO-20260921-AAAA', kind: 'assembly', tradeState: 'confirmed',
      fulfillmentState: 'testing', configurationVersion: 0, totalCents: 200_000,
      balanceCents: 0, balanceDirection: 'settled', isFullyPaid: true,
      requiredDepositCents: 30_000, version: 3, customerName: '陈先生',
    },
    gaps: [],
    missingSnItems: [],
    checklists: [],
    latestChecklist: null,
    delivery: null,
    ...overrides,
  }
}

function detail(bd: FulfillmentBoardPayload): FulfillmentDetailPayload {
  return {
    order: {
      id: 'o-1', orderNo: 'SO-20260921-AAAA', customerName: '陈先生', customerPhone: '13800001111',
      kind: 'assembly', tradeState: 'confirmed', fulfillmentState: bd.order.fulfillmentState as FulfillmentDetailPayload['order']['fulfillmentState'],
      dueAt: null, totalCents: 200_000, subtotalCents: 200_000, discountCents: 0, adjustmentCents: 0,
      cashNetCents: 200_000, offsetNetCents: 0, returnCreditCents: 0, balanceCents: 0, balanceDirection: 'settled',
      isFullyPaid: true, requiredDepositCents: 30_000, version: 3, note: '',
      createdAt: '2026-09-21T04:00:00Z', updatedAt: '2026-09-21T04:10:00Z',
    },
    quote: null,
    warrantyPolicyLines: null,
    lines: [{
      id: 'l-1', position: 0, source: 'new', nameSnapshot: '整机', specSnapshot: '',
      qty: 1, unitPriceCents: 200_000, discountAllocationCents: 0, netLineCents: 200_000,
      warrantySnapshot: null,
      stockItemId: null, stockItemAvailability: null, stockItemAssetCode: null, customerDeviceRef: null,
    }],
    payments: [],
    reservations: [],
    shortage: [],
    returns: [],
    fulfillment: bd,
  }
}

describe('WorkbenchFulfillmentPage', () => {
  it('从工作台单号深链进入时自动打开该销售单的履约办理页', async () => {
    window.history.replaceState({}, '', '/sales/fulfillment?orderNo=SO-20260921-AAAA')
    mocks.fetchSaleOrders.mockResolvedValue({ ok: true, data: listPayload })
    mocks.fetchFulfillmentDetail.mockResolvedValue({ ok: true, data: detail(board()) })

    render(<WorkbenchFulfillmentPage permissions={['*']} />)
    await waitFor(() => expect(mocks.fetchFulfillmentDetail).toHaveBeenCalledWith('o-1'))
    expect(await screen.findByText('确认交付')).toBeTruthy()
  })

  it('无权限时说明缺少什么权限，不渲染任何可提交的表单', () => {
    // 一个权限都没有（连旧码都没有）：页面必须说清缺什么，而不是渲染空页。
    render(<WorkbenchFulfillmentPage permissions={['library/view']} />)
    expect(screen.getByText(/没有查看销售单的权限/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /确认交付/ })).toBeNull()
  })

  it('列表按履约阶段显示；打开详情后闸门逐条可见', async () => {
    mocks.fetchSaleOrders.mockResolvedValue({ ok: true, data: listPayload })
    const bd = board()
    mocks.fetchFulfillmentDetail.mockResolvedValue({ ok: true, data: detail(bd) })

    render(<WorkbenchFulfillmentPage permissions={['*']} />)
    await waitFor(() => expect(screen.getByText('SO-20260921-AAAA')).toBeTruthy())
    expect(screen.getAllByText('检测中').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByText('SO-20260921-AAAA'))
    await waitFor(() => expect(screen.getByText('确认交付')).toBeTruthy())
    // 六项闸门逐条亮出
    for (const label of ['订单已成交', '已到交付阶段', '店有货已占齐', '内部编号核对', '装机检测已通过', '款项已结清']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('缺货与尾款未结清时对应闸门不亮，交付按钮保持禁用', async () => {
    mocks.fetchSaleOrders.mockResolvedValue({ ok: true, data: listPayload })
    const bd = board({
      order: {
        ...board().order,
        fulfillmentState: 'ready_delivery',
        balanceCents: 50_000,
        balanceDirection: 'client_due',
        isFullyPaid: false,
      },
      gaps: [{ lineId: 'l-1', position: 0, nameSnapshot: '内存条', qty: 2, reservedQty: 1, shortageQty: 1 }],
    })
    mocks.fetchFulfillmentDetail.mockResolvedValue({ ok: true, data: detail(bd) })

    render(<WorkbenchFulfillmentPage permissions={['*']} />)
    fireEvent.click(await waitFor(() => screen.getByText('SO-20260921-AAAA')))
    const deliverButton = (await waitFor(() => screen.getByRole('button', { name: /确认交付/ }))) as HTMLButtonElement
    expect(deliverButton.disabled).toBe(true)
    expect(screen.getByText(/内存条 差 1 件/)).toBeTruthy()
    expect(screen.getByText(/尾款还有 ¥500.00/)).toBeTruthy()
  })

  it('保存检测结果按各项状态提交；服务端拒绝时保留输入、不报成功', async () => {
    mocks.fetchSaleOrders.mockResolvedValue({ ok: true, data: listPayload })
    const bd = board()
    mocks.fetchFulfillmentDetail.mockResolvedValue({ ok: true, data: detail(bd) })
    mocks.saveAssemblyChecks.mockResolvedValue({
      ok: false, message: '还有检查项没有通过，不能记成「通过」',
    })

    render(<WorkbenchFulfillmentPage permissions={['*']} />)
    fireEvent.click(await waitFor(() => screen.getByText('SO-20260921-AAAA')))
    const saveButton = await waitFor(() => screen.getByRole('button', { name: '保存检测结果' }))

    // 把四项都改成「通过」
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[]
    expect(selects.length).toBe(4)
    for (const select of selects) fireEvent.change(select, { target: { value: 'pass' } })

    fireEvent.click(saveButton)
    await waitFor(() => expect(mocks.saveAssemblyChecks).toHaveBeenCalledTimes(1))
    const submitted = mocks.saveAssemblyChecks.mock.calls[0][1] as { state: string }[]
    expect(submitted.every((item) => item.state === 'pass')).toBe(true)

    // 失败后输入还在、没有成功提示
    await waitFor(() => expect(screen.getByText(/还有检查项没有通过/)).toBeTruthy())
    expect(screen.queryByText(/已保存/)).toBeNull()
    expect((screen.getAllByRole('combobox') as HTMLSelectElement[])[0].value).toBe('pass')
  })

  it('交付备注必填：没填时按钮禁用；填了才允许提交', async () => {
    mocks.fetchSaleOrders.mockResolvedValue({ ok: true, data: listPayload })
    const bd = board({ order: { ...board().order, fulfillmentState: 'ready_delivery' } })
    mocks.fetchFulfillmentDetail.mockResolvedValue({ ok: true, data: detail(bd) })
    mocks.deliverOrder.mockResolvedValue({ ok: true, data: { operationId: 'x', summary: '已交付', entityId: 'o-1', entityVersion: 4, state: 'delivered', effects: {} } })

    render(<WorkbenchFulfillmentPage permissions={['*']} />)
    fireEvent.click(await waitFor(() => screen.getByText('SO-20260921-AAAA')))
    const deliverButton = (await waitFor(() => screen.getByRole('button', { name: /确认交付/ }))) as HTMLButtonElement
    expect(deliverButton.disabled).toBe(true)

    fireEvent.change(screen.getByPlaceholderText(/本人到店自提/), { target: { value: '本人到店自提' } })
    expect(deliverButton.disabled).toBe(false)
    fireEvent.click(deliverButton)
    await waitFor(() => expect(mocks.deliverOrder).toHaveBeenCalledTimes(1))
    expect(mocks.deliverOrder.mock.calls[0][1]).toBe('本人到店自提')
  })
})
