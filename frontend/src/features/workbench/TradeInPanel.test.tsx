// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TradeInPanel } from './TradeInPanel'

const mocks = vi.hoisted(() => ({
  fetchSaleOrders: vi.fn(), fetchSaleOrderDetail: vi.fn(), createTradeIn: vi.fn(),
  fetchTradeIn: vi.fn(), applyTradeInOffset: vi.fn(), reverseTradeInOffset: vi.fn(),
}))

vi.mock('./sales-api', () => ({ fetchSaleOrders: mocks.fetchSaleOrders, fetchSaleOrderDetail: mocks.fetchSaleOrderDetail }))
vi.mock('./tradein-api', () => ({
  createTradeIn: mocks.createTradeIn, fetchTradeIn: mocks.fetchTradeIn,
  applyTradeInOffset: mocks.applyTradeInOffset, reverseTradeInOffset: mocks.reverseTradeInOffset,
}))

const recovery = {
  id: 'recovery-1', orderNo: 'RO-1', seller: { customerId: 8, name: '林先生', phone: '' },
  state: 'acquired' as const, initialEstimateCents: 0, offerVersion: 1, finalAcquisitionCents: 10000,
  payableCents: 10000, paidCents: 0, offsetCents: 0, receivedAt: null, acceptedAt: null,
  note: '', version: 3, createdAt: '', items: [], attachments: [], tradeIns: [],
}

const tradeIn = {
  id: 'tradein-1', state: 'active', version: 1,
  saleOrder: { id: 'sale-1', orderNo: 'SO-1', tradeState: 'draft', balanceCents: 8000, version: 2 },
  recovery: { id: 'recovery-1', orderNo: 'RO-1', state: 'acquired', payableCents: 10000, paidCents: 0, version: 3 },
  offsets: [{ id: 'offset-1', amountCents: 5000, state: 'applied' as const, reversalOf: null, reversedReason: null, createdAt: '2026-09-24' }],
  validOffsetCents: 5000, recoveryPayableRemainingCents: 5000,
}

const ok = <T,>(data: T) => ({ ok: true, status: 200, data, meta: { requestId: null, serverTime: null, contractVersion: null } })

describe('TradeInPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchSaleOrders.mockResolvedValue(ok({ orders: [{ id: 'sale-1', orderNo: 'SO-1', customerName: '林先生', tradeState: 'draft', balanceCents: 8000 }] }))
    mocks.fetchSaleOrderDetail.mockResolvedValue(ok({ order: { version: 2 } }))
    mocks.createTradeIn.mockResolvedValue(ok({ entityId: 'tradein-1', summary: '关联已建立' }))
    mocks.fetchTradeIn.mockResolvedValue(ok(tradeIn))
    mocks.applyTradeInOffset.mockResolvedValue(ok({ summary: '折抵已应用' }))
    mocks.reverseTradeInOffset.mockResolvedValue(ok({ summary: '撤销记录已新增' }))
  })

  it('建立关联、应用折抵并以新增反向记录撤销', async () => {
    render(<TradeInPanel recovery={recovery} permissions={['*']} onChanged={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('选择待收款销售单（草稿或已成交）'), { target: { value: 'sale-1' } })
    fireEvent.click(screen.getByRole('button', { name: '建立置换关联' }))
    expect(await screen.findByText(/关联编号 tradein-1/)).toBeTruthy()
    expect(screen.getByText(/该销售单仍为草稿/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText(/折抵金额/), { target: { value: '50' } })
    fireEvent.click(screen.getByRole('button', { name: '应用折抵' }))
    await waitFor(() => expect(mocks.applyTradeInOffset).toHaveBeenCalledWith('tradein-1', {
      amountCents: 5000, saleOrderVersion: 2, recoveryVersion: 3,
    }))

    fireEvent.change(screen.getByLabelText('撤销原因'), { target: { value: '客户改为现金付款' } })
    fireEvent.click(screen.getByRole('button', { name: '撤销这笔' }))
    await waitFor(() => expect(mocks.reverseTradeInOffset).toHaveBeenCalledWith('tradein-1', {
      offsetId: 'offset-1', reason: '客户改为现金付款', saleOrderVersion: 2, recoveryVersion: 3,
    }))
  })
})
