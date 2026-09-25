// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  confirmProposal: vi.fn(),
  createServiceOrder: vi.fn(),
  dispatchExternal: vi.fn(),
  fetchServiceOrderDetail: vi.fn(),
  fetchServiceOrders: vi.fn(),
  receiveExternal: vi.fn(),
  registerServicePayment: vi.fn(),
  replacePart: vi.fn(),
  retestDevice: vi.fn(),
  returnDevice: vi.fn(),
  saveDiagnosis: vi.fn(),
  saveProposal: vi.fn(),
}))

vi.mock('./service-api', () => mocks)
vi.mock('./AttachmentPanel', () => ({ AttachmentPanel: () => null }))

import { WorkbenchServicePage } from './WorkbenchServicePage'

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data, meta: { requestId: 'test', serverTime: '', contractVersion: 'v1' } })

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState({}, '', '/')
  mocks.fetchServiceOrders.mockResolvedValue(ok({ orders: [] }))
  mocks.fetchServiceOrderDetail.mockResolvedValue({ ok: false, status: 404, message: '工单已不存在' })
})

describe('WorkbenchServicePage 工作台深链', () => {
  it('按待办单号加载同一维修工单详情', async () => {
    window.history.replaceState({}, '', '/after-sales?orderNo=SV-2026-001')
    mocks.fetchServiceOrders.mockResolvedValue(ok({
      orders: [{
        id: 'service-1', orderNo: 'SV-2026-001', customerName: '验收客户', deviceCode: 'DEV-001',
        manufacturerSn: null, symptom: '无法开机', state: 'received', confirmedChargeCents: null,
        balanceCents: 0, version: 1, createdAt: '2026-09-25T08:00:00.000Z',
      }],
    }))

    render(<WorkbenchServicePage permissions={['*']} />)
    await waitFor(() => expect(mocks.fetchServiceOrderDetail).toHaveBeenCalledWith('service-1'))
  })
})
