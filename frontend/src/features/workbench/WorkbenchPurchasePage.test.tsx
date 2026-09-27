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

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetchPurchases.mockResolvedValue(emptyPurchases)
})

describe('采购页 · 未知写入结果恢复', () => {
  it('从配件登记转入时带入型号、数量、成色、SN 和说明', async () => {
    mocks.createPurchase.mockResolvedValue({
      ok: true, status: 200, data: { entityId: 'purchase-1', summary: '采购单已建立' },
      meta: { requestId: 'create-1', serverTime: '', contractVersion: 'v1' },
    })
    mocks.fetchPurchaseDetail.mockResolvedValue({
      ok: true, status: 200, data: {
        purchase: {
          id: 'purchase-1', purchaseNo: 'PO-1', version: 1, supplierName: '档口', supplierRef: null,
          supplierNote: null, saleOrderId: null, expectedAt: null, note: '', orderedQty: 2, receivedQty: 0,
          rejectedQty: 0, cancelledQty: 0, pendingQty: 2, progress: '尚未到货', payableCents: 0,
          paidCents: 0, remainingPayableCents: 0, createdAt: '2026-09-27T00:00:00Z',
        },
        lines: [{ id: 'line-1', position: 0, productRef: 'product-1', productId: 1, nameSnapshot: 'RTX 3060', qtyOrdered: 2,
          receivedQty: 0, rejectedQty: 0, pendingQty: 2, unitCostCents: null, costKnown: false }],
        receipts: [],
      }, meta: { requestId: 'detail-1', serverTime: '', contractVersion: 'v1' },
    })
    window.history.replaceState(null, '', '/purchases?new=1&productRef=product-1&productLabel=CPU%20%C2%B7%20RTX%203060&qty=2&receiptCondition=used&receiptSerials=%5B%22SN-1%22%2C%22SN-2%22%5D&receiptItemRemark=散片&receiptBatchRemark=已验货')

    render(<WorkbenchPurchasePage permissions={['*']} />)
    expect(await screen.findByText('CPU · RTX 3060')).toBeTruthy()
    expect(document.querySelector('input[type="hidden"]')?.getAttribute('value')).toBe('product-1')
    expect((screen.getByLabelText('数量') as HTMLInputElement).value).toBe('2')
    fireEvent.change(screen.getByLabelText('供应商名称（快捷建档）'), { target: { value: '档口' } })
    fireEvent.click(screen.getByRole('button', { name: '创建采购单' }))

    await waitFor(() => expect(mocks.createPurchase).toHaveBeenCalled())
    expect(mocks.createPurchase.mock.calls[0][0].lines[0].productRef).toBe('product-1')
    expect((await screen.findByLabelText('本次实到成色') as HTMLSelectElement).value).toBe('used')
    expect((screen.getByLabelText('厂家 SN（可选，每行一件，可扫码或留空）') as HTMLTextAreaElement).value).toBe('SN-1\nSN-2')
    expect((screen.getByLabelText('本次逐件实物备注') as HTMLInputElement).value).toBe('散片')
    expect((screen.getByLabelText('本次批次备注（数量管理商品）') as HTMLInputElement).value).toBe('已验货')
  })

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
