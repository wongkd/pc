// @vitest-environment jsdom
/**
 * E02/E04 · 客户台账页。
 *
 * 证明的是「页面上真的出现这些内容与状态」，以及「失败时没有把用户填的东西丢掉」。
 * 服务端口径（同店手机号唯一、空手机号不做订单归属）在 backend/tests/e04-customers.test.mjs，
 * 这里不重复造一遍假的服务端行为。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../utils/api', () => ({
  fetchCustomers: vi.fn(),
  fetchCustomer: vi.fn(),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  addCustomerDevice: vi.fn(),
  updateCustomerDevice: vi.fn(),
  deleteCustomerDevice: vi.fn(),
}))

import * as api from '../utils/api'
import { CustomersPage } from './CustomersPage'

const rows = [
  {
    id: 1, name: '林建国', phone: '13800001234', email: '', address: '湛江市赤坎区', remark: '老客户',
    sourceChannel: null,
    status: 'active' as const, createdAt: '2026-09-01 10:00:00', updatedAt: '2026-09-18 10:00:00',
    orderCount: 2, totalCents: 468000, receivedCents: 300000,
  },
  {
    id: 2, name: '陈师傅（散客，只留姓）', phone: '', email: '', address: '', remark: '隔壁铺面老板',
    sourceChannel: null,
    status: 'active' as const, createdAt: '2026-09-10 10:00:00', updatedAt: '2026-09-10 10:00:00',
    orderCount: 0, totalCents: 0, receivedCents: 0,
  },
]

const detail = {
  ...rows[0],
  devices: [
    { id: 11, label: '戴尔 OptiPlex 7080 主机', serialNumber: 'DL7080-88231', remark: '外店机器', createdAt: '2026-09-12 09:00:00' },
  ],
  orders: [
    { id: 91, orderNo: 'PRE-20260919-001', projectTitle: '办公主机整机', totalCents: 468000, paidCents: 300000, status: 'pending_delivery' as const, updatedAt: '2026-09-18 10:00:00' },
  ],
}

function renderPage() {
  return render(
    <MemoryRouter>
      <CustomersPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.mocked(api.fetchCustomers).mockResolvedValue(rows)
  vi.mocked(api.fetchCustomer).mockResolvedValue(detail)
  vi.mocked(api.createCustomer).mockResolvedValue({ ok: true, id: 3 })
  vi.mocked(api.updateCustomer).mockResolvedValue({ ok: true })
  vi.mocked(api.addCustomerDevice).mockResolvedValue({ ok: true, id: 12 })
  vi.mocked(api.updateCustomerDevice).mockResolvedValue({ ok: true })
  vi.mocked(api.deleteCustomerDevice).mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('客户台账列表', () => {
  it('列出客户、订单数与金额，未留电话的散客明确标注', async () => {
    renderPage()
    expect(await screen.findByText('林建国')).toBeTruthy()
    expect(screen.getByText('¥4,680.00')).toBeTruthy()
    expect(screen.getByText('¥3,000.00')).toBeTruthy()
    expect(screen.getAllByText('未留电话').length).toBeGreaterThan(0)
    expect(screen.getByText('共 2 位客户')).toBeTruthy()
  })

  it('没有客户时给出下一步该做什么，而不是空白', async () => {
    vi.mocked(api.fetchCustomers).mockResolvedValue([])
    renderPage()
    expect(await screen.findByText('还没有客户档案')).toBeTruthy()
    expect(screen.getByText(/点右上角「新增客户」建第一份档案/)).toBeTruthy()
  })

  it('接口失败时显示原因并可重试，重试会重新请求', async () => {
    vi.mocked(api.fetchCustomers).mockRejectedValue(new Error('客户台账加载失败：网络中断'))
    renderPage()
    expect(await screen.findByText(/网络中断/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(api.fetchCustomers).toHaveBeenCalledTimes(2))
  })

  it('搜索把关键词交给服务端，而不是只过滤当前这一页', async () => {
    renderPage()
    await screen.findByText('林建国')
    fireEvent.change(screen.getByLabelText('搜索客户'), { target: { value: '陈师傅' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await waitFor(() => expect(api.fetchCustomers).toHaveBeenLastCalledWith('陈师傅'))
  })
})

describe('客户详情与设备', () => {
  it('点一行读详情，设备与订单都显示出来', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('林建国'))
    await waitFor(() => expect(api.fetchCustomer).toHaveBeenCalledWith(1))
    expect(await screen.findByText('戴尔 OptiPlex 7080 主机')).toBeTruthy()
    expect(screen.getByText('DL7080-88231 · 外店机器')).toBeTruthy()
    expect(screen.getByText('PRE-20260919-001')).toBeTruthy()
  })

  it('详情里的累计金额、订单数与已收都来自服务端，不出现 NaN', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('林建国'))
    await screen.findByText('戴尔 OptiPlex 7080 主机')
    const total = document.querySelector('.customer-total') as HTMLElement
    expect(total.textContent).toContain('¥4,680.00')
    expect(total.textContent).toContain('2 笔订单')
    expect(total.textContent).toContain('已收 ¥3,000.00')
    expect(total.textContent).toContain('待收 ¥1,680.00')
    expect(total.textContent).not.toContain('NaN')
  })

  it('删除设备会调到服务端并刷新详情', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('林建国'))
    await screen.findByText('戴尔 OptiPlex 7080 主机')
    fireEvent.click(screen.getByRole('button', { name: '删' }))
    await waitFor(() => expect(api.deleteCustomerDevice).toHaveBeenCalledWith(1, 11))
    await waitFor(() => expect(api.fetchCustomer).toHaveBeenCalledTimes(2))
  })

  it('详情读取失败时显示原因，重试后恢复详情', async () => {
    vi.mocked(api.fetchCustomer)
      .mockRejectedValueOnce(new Error('客户详情加载失败：网络中断'))
      .mockResolvedValueOnce(detail)
    renderPage()
    fireEvent.click(await screen.findByText('林建国'))
    expect(await screen.findByText(/网络中断/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('戴尔 OptiPlex 7080 主机')).toBeTruthy()
    expect(api.fetchCustomer).toHaveBeenCalledTimes(2)
  })

  it('快速切换客户时忽略较早返回的详情响应', async () => {
    let resolveFirst!: (value: typeof detail) => void
    vi.mocked(api.fetchCustomer).mockImplementation((id) => id === 1
      ? new Promise((resolve) => { resolveFirst = resolve })
      : Promise.resolve({ ...detail, ...rows[1], devices: [], orders: [] }))
    renderPage()
    fireEvent.click(await screen.findByText('林建国'))
    fireEvent.click(screen.getByText('陈师傅（散客，只留姓）'))
    expect(await screen.findByText('陈师傅（散客，只留姓）', { selector: 'h3' })).toBeTruthy()
    resolveFirst(detail)
    await waitFor(() => expect(screen.getByText('陈师傅（散客，只留姓）', { selector: 'h3' })).toBeTruthy())
    expect(screen.queryByText('戴尔 OptiPlex 7080 主机')).toBeNull()
  })

  it('设备删除失败时保留设备并显示错误原因', async () => {
    vi.mocked(api.deleteCustomerDevice).mockRejectedValue(new Error('删除失败：无权限'))
    renderPage()
    fireEvent.click(await screen.findByText('林建国'))
    await screen.findByText('戴尔 OptiPlex 7080 主机')
    fireEvent.click(screen.getByRole('button', { name: '删' }))
    expect(await screen.findByText('删除失败：无权限')).toBeTruthy()
    expect(screen.getByText('戴尔 OptiPlex 7080 主机')).toBeTruthy()
  })

  it('登记设备失败时保留输入并显示服务端原因', async () => {
    vi.mocked(api.addCustomerDevice).mockRejectedValue(new Error('设备名称重复'))
    renderPage()
    fireEvent.click(await screen.findByText('林建国'))
    fireEvent.click(await screen.findByRole('button', { name: '登记设备' }))
    const input = screen.getByPlaceholderText('如 联想拯救者 Y7000P 2024') as HTMLInputElement
    fireEvent.change(input, { target: { value: '联想拯救者 Y7000P 2024' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设备' }))
    expect(await screen.findByText('设备名称重复')).toBeTruthy()
    expect(input.value).toBe('联想拯救者 Y7000P 2024')
  })

  it('登记设备把名称、序列号、备注一起提交', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('林建国'))
    await screen.findByText('客户设备')
    fireEvent.click(screen.getByRole('button', { name: '登记设备' }))
    fireEvent.change(screen.getByPlaceholderText('如 联想拯救者 Y7000P 2024'), { target: { value: '联想拯救者 Y7000P 2024' } })
    fireEvent.change(screen.getByPlaceholderText('如 外店机器，来店清灰'), { target: { value: '来店清灰' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设备' }))
    await waitFor(() => expect(api.addCustomerDevice).toHaveBeenCalledWith(1, { label: '联想拯救者 Y7000P 2024', serialNumber: '', remark: '来店清灰' }))
  })
})

describe('新增与编辑客户', () => {
  it('新建成功后重新拉列表并打开新客户详情', async () => {
    renderPage()
    await screen.findByText('林建国')
    fireEvent.click(screen.getByRole('button', { name: '新增客户' }))
    fireEvent.change(screen.getByPlaceholderText('姓名或公司名'), { target: { value: '黄小满' } })
    fireEvent.change(screen.getByPlaceholderText(/同一门店不可重号/), { target: { value: '13800005678' } })
    fireEvent.click(screen.getByRole('button', { name: '保存客户' }))
    await waitFor(() => expect(api.createCustomer).toHaveBeenCalledWith({ name: '黄小满', phone: '13800005678', email: '', address: '', remark: '', sourceChannel: '' }))
    await waitFor(() => expect(api.fetchCustomer).toHaveBeenCalledWith(3))
    expect(await screen.findByText('已建客户档案「黄小满」')).toBeTruthy()
  })

  it('保存失败时保留已填内容并说明原因', async () => {
    vi.mocked(api.createCustomer).mockRejectedValue(new Error('该手机号已有客户档案，请直接搜索该号码'))
    renderPage()
    await screen.findByText('林建国')
    fireEvent.click(screen.getByRole('button', { name: '新增客户' }))
    fireEvent.change(screen.getByPlaceholderText('姓名或公司名'), { target: { value: '张三' } })
    fireEvent.change(screen.getByPlaceholderText(/同一门店不可重号/), { target: { value: '13800001234' } })
    fireEvent.click(screen.getByRole('button', { name: '保存客户' }))

    expect(await screen.findByText('该手机号已有客户档案，请直接搜索该号码')).toBeTruthy()
    expect((screen.getByPlaceholderText('姓名或公司名') as HTMLInputElement).value).toBe('张三')
    expect((screen.getByPlaceholderText(/同一门店不可重号/) as HTMLInputElement).value).toBe('13800001234')
    expect(screen.getByRole('button', { name: '保存客户' })).toBeTruthy()
  })

  it('编辑客户带上当前值，保存后回读详情', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('林建国'))
    await screen.findByText('戴尔 OptiPlex 7080 主机')
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const nameInput = screen.getByPlaceholderText('姓名或公司名') as HTMLInputElement
    expect(nameInput.value).toBe('林建国')
    fireEvent.change(nameInput, { target: { value: '林建国（老客户）' } })
    fireEvent.click(screen.getByRole('button', { name: '保存客户' }))
    await waitFor(() => expect(api.updateCustomer).toHaveBeenCalledWith(1, expect.objectContaining({ name: '林建国（老客户）', phone: '13800001234' })))
    await waitFor(() => expect(api.fetchCustomer).toHaveBeenCalledTimes(2))
  })
})
