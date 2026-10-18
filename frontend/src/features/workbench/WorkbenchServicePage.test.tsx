// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

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
  it('手工接修不依赖客户档案、小程序订单或厂家 SN，失败保留输入', async () => {
    window.history.replaceState({}, '', '/after-sales?action=intake')
    mocks.createServiceOrder.mockResolvedValue({ ok: false, status: 503, message: '暂时无法登记，请重试' })
    render(<WorkbenchServicePage permissions={['*']} />)
    expect(screen.getByText(/无需小程序下单/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('客户称呼'), { target: { value: '到店客户' } })
    fireEvent.change(screen.getByLabelText('故障描述'), { target: { value: '无法开机' } })
    fireEvent.click(screen.getByRole('button', { name: '确认接修' }))
    await waitFor(() => expect(mocks.createServiceOrder).toHaveBeenCalledWith({
      customerName: '到店客户', manufacturerSn: '', symptom: '无法开机', accessories: null, appearance: null,
    }))
    expect(await screen.findByText('暂时无法登记，请重试')).toBeTruthy()
    expect((screen.getByLabelText('客户称呼') as HTMLInputElement).value).toBe('到店客户')
    expect((screen.getByLabelText('故障描述') as HTMLInputElement).value).toBe('无法开机')
  })

  it('只读员工不能通过手工接修深链打开写入表单', async () => {
    window.history.replaceState({}, '', '/after-sales?action=intake')
    render(<WorkbenchServicePage permissions={['service/view']} />)
    await waitFor(() => expect(mocks.fetchServiceOrders).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: '确认接修' })).toBeNull()
    expect(mocks.createServiceOrder).not.toHaveBeenCalled()
  })

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
