// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  fetchRecoveryOrders: vi.fn(),
  fetchRecoveryOrderDetail: vi.fn(),
  fetchInventory: vi.fn(),
  fetchCustomerOptions: vi.fn(),
  registerRecovery: vi.fn(),
  acquireRecovery: vi.fn(),
  inspectRecovery: vi.fn(),
  offerRecovery: vi.fn(),
  payRecovery: vi.fn(),
  returnRecovery: vi.fn(),
  teardownRecovery: vi.fn(),
}))

vi.mock('./recovery-api', () => ({
  fetchRecoveryOrders: mocks.fetchRecoveryOrders,
  fetchRecoveryOrderDetail: mocks.fetchRecoveryOrderDetail,
  registerRecovery: mocks.registerRecovery,
  acquireRecovery: mocks.acquireRecovery,
  inspectRecovery: mocks.inspectRecovery,
  offerRecovery: mocks.offerRecovery,
  payRecovery: mocks.payRecovery,
  returnRecovery: mocks.returnRecovery,
  teardownRecovery: mocks.teardownRecovery,
}))

vi.mock('./inventory-api', () => ({ fetchInventory: mocks.fetchInventory }))
vi.mock('./quote-api', () => ({ fetchCustomerOptions: mocks.fetchCustomerOptions }))
vi.mock('./AttachmentPanel', () => ({ AttachmentPanel: () => null }))
vi.mock('./TradeInPanel', () => ({ TradeInPanel: () => null }))

import { WorkbenchRecoveryPage } from './WorkbenchRecoveryPage'

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data, meta: { requestId: 'test', serverTime: '', contractVersion: 'v1' } })

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState({}, '', '/')
  mocks.fetchRecoveryOrders.mockResolvedValue(ok({ orders: [] }))
  mocks.fetchRecoveryOrderDetail.mockResolvedValue({ ok: false, status: 404, message: 'not found' })
  mocks.fetchInventory.mockResolvedValue(ok({ items: [] }))
  mocks.fetchCustomerOptions.mockResolvedValue(ok({ items: [{ id: 41, name: '验收客户', phone: '' }] }))
  mocks.registerRecovery.mockResolvedValue(ok({ entityId: 'recovery-1', summary: '已登记' }))
})

describe('回收登记的客户主体关联', () => {
  it('从工作台单号深链进入时自动打开对应回收单', async () => {
    window.history.replaceState({}, '', '/recovery?orderNo=TR-2026-001')
    mocks.fetchRecoveryOrders.mockResolvedValue(ok({ orders: [{ id: 'rec-1', orderNo: 'TR-2026-001' }] }))

    render(<WorkbenchRecoveryPage permissions={['*']} />)
    await waitFor(() => expect(mocks.fetchRecoveryOrderDetail).toHaveBeenCalledWith('rec-1'))
  })

  it('选择客户档案后将 customer ID 与卖方快照一并提交', async () => {
    render(<WorkbenchRecoveryPage permissions={['*']} />)
    fireEvent.click(screen.getByRole('button', { name: '回收登记' }))

    const customerSelect = await screen.findByLabelText('关联客户档案')
    await waitFor(() => expect((customerSelect as HTMLSelectElement).disabled).toBe(false))
    fireEvent.change(customerSelect, { target: { value: '41' } })
    fireEvent.change(screen.getByLabelText('实物描述'), { target: { value: '验收测试回收机' } })
    fireEvent.change(screen.getByLabelText('初步估价（元）'), { target: { value: '2000' } })
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }))

    await waitFor(() => expect(mocks.registerRecovery).toHaveBeenCalledWith(expect.objectContaining({
      sellerCustomerId: 41,
      sellerName: '验收客户',
      sellerPhone: null,
      initialEstimateCents: 200000,
    })))
  })
})
