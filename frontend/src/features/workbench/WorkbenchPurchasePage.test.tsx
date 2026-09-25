// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchPurchases: vi.fn(),
  fetchPurchaseDetail: vi.fn(),
  createPurchase: vi.fn(),
  cancelPurchase: vi.fn(),
  payPurchase: vi.fn(),
  registerReceipt: vi.fn(),
  returnToSupplier: vi.fn(),
  queryOperation: vi.fn(),
  resolvePendingAction: vi.fn(),
}))

vi.mock('./purchase-api', () => ({
  fetchPurchases: mocks.fetchPurchases,
  fetchPurchaseDetail: mocks.fetchPurchaseDetail,
  createPurchase: mocks.createPurchase,
  cancelPurchase: mocks.cancelPurchase,
  payPurchase: mocks.payPurchase,
  registerReceipt: mocks.registerReceipt,
  returnToSupplier: mocks.returnToSupplier,
  purchaseClient: { client: { queryOperation: mocks.queryOperation, resolvePendingAction: mocks.resolvePendingAction } },
}))

import { WorkbenchPurchasePage } from './WorkbenchPurchasePage'

const emptyPurchases = {
  ok: true,
  status: 200,
  data: { purchases: [], totals: { all: 0, pending: 0, completed: 0, pendingQty: 0 } },
  meta: { requestId: 'list-1', serverTime: '', contractVersion: 'v1' },
}

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetchPurchases.mockResolvedValue(emptyPurchases)
})

describe('采购页 · 未知写入结果恢复', () => {
  it('提供操作查询；确认失败后解除旧请求并保留表单供修正', async () => {
    mocks.createPurchase.mockResolvedValue({
      ok: false, unknownResult: true, requestId: 'purchase-request-1', message: '请求结果未知',
    })
    mocks.queryOperation.mockResolvedValue({
      ok: true, status: 'failed', code: 'VALIDATION_ERROR', message: '采购数量无效', resultRef: null,
    })

    render(<WorkbenchPurchasePage permissions={['inventory/view', 'inventory/purchase-create']} />)
    fireEvent.click(await screen.findByRole('button', { name: '新建采购单' }))
    fireEvent.change(screen.getByLabelText('供应商名称（快捷建档）'), { target: { value: '演示档口' } })
    fireEvent.change(screen.getByLabelText('商品'), { target: { value: 'product-1' } })
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('约定单价（元）'), { target: { value: '120' } })
    fireEvent.click(screen.getByRole('button', { name: '创建采购单' }))

    expect(await screen.findByText(/网络没有给出明确结果/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查询结果' }))

    expect(await screen.findByText(/已确认未成功：采购数量无效/)).toBeTruthy()
    expect(mocks.queryOperation).toHaveBeenCalledWith('purchase-request-1')
    expect(mocks.resolvePendingAction).toHaveBeenCalledWith('purchase-request-1')
    expect((screen.getByLabelText('供应商名称（快捷建档）') as HTMLInputElement).value).toBe('演示档口')
    expect((screen.getByLabelText('商品') as HTMLInputElement).value).toBe('product-1')
    await waitFor(() => expect(screen.queryByRole('button', { name: '查询结果' })).toBeNull())
  })

  it('查询确认采购付款成功后刷新该采购单且不再次提交付款', async () => {
    const purchase = {
      id: 'purchase-1', purchaseNo: 'PO-1', supplierName: '演示档口', supplierRef: null, saleOrderId: null, expectedAt: null,
      orderedQty: 1, receivedQty: 0, rejectedQty: 0, cancelledQty: 0, pendingQty: 1, progress: '尚未到货',
      payableCents: 12000, paidCents: 0, remainingPayableCents: 12000, lineCount: 1, createdAt: '2026-09-25T00:00:00.000Z',
    }
    const detail = {
      purchase: {
        id: purchase.id, purchaseNo: purchase.purchaseNo, version: 1, supplierName: purchase.supplierName, supplierRef: null,
        supplierNote: null, saleOrderId: null, expectedAt: null, note: '', orderedQty: 1, receivedQty: 0, rejectedQty: 0,
        cancelledQty: 0, pendingQty: 1, progress: '尚未到货', payableCents: 12000, paidCents: 0, remainingPayableCents: 12000,
        createdAt: purchase.createdAt,
      },
      lines: [{ id: 'line-1', position: 0, productRef: 'product-1', productId: 101, nameSnapshot: '内存条', qtyOrdered: 1,
        receivedQty: 0, rejectedQty: 0, pendingQty: 1, unitCostCents: 12000, costKnown: true }],
      receipts: [],
    }
    mocks.fetchPurchases.mockResolvedValue({ ...emptyPurchases, data: { purchases: [purchase], totals: { all: 1, pending: 1, completed: 0, pendingQty: 1 } } })
    mocks.fetchPurchaseDetail.mockResolvedValue({ ok: true, status: 200, data: detail, meta: { requestId: 'detail-1', serverTime: '', contractVersion: 'v1' } })
    mocks.payPurchase.mockResolvedValue({ ok: false, unknownResult: true, requestId: 'payment-request-1', message: '请求结果未知' })
    mocks.queryOperation.mockResolvedValue({ ok: true, status: 'succeeded', code: null, message: '', resultRef: purchase.id })

    render(<WorkbenchPurchasePage permissions={['inventory/view', 'finance/payment']} />)
    fireEvent.click(await screen.findByRole('button', { name: 'PO-1' }))
    fireEvent.change(await screen.findByLabelText('本次付款（元）'), { target: { value: '120' } })
    fireEvent.click(screen.getByRole('button', { name: '登记付款' }))
    expect(await screen.findByRole('button', { name: '查询结果' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查询结果' }))

    expect(await screen.findByText(/采购付款.*已由后台确认为成功/)).toBeTruthy()
    expect(mocks.resolvePendingAction).toHaveBeenCalledWith('payment-request-1')
    await waitFor(() => expect(mocks.fetchPurchaseDetail).toHaveBeenCalledTimes(2))
    expect(mocks.payPurchase).toHaveBeenCalledTimes(1)
    expect((screen.getByLabelText('本次付款（元）') as HTMLInputElement).value).toBe('')
  })
})
