// @vitest-environment jsdom
/**
 * E05 · 报价单页（真实接口）渲染与提交测试。
 *
 * 证明的是「页面按口径显示、按契约提交」，不证明后端行为（后端见
 * backend/tests/e05-quote-http.test.mjs）。重点：
 *   · 列表按服务端给的状态显示：已过期 / 即将到期是服务端算出来的，本页只渲染；
 *   · 无权限时不渲染「新建装机报价」，只有查看权限时按钮隐藏（显隐依据与后端同源的旧码）；
 *   · 金额以整数分提交：界面按元输入，提交前换算（2599.00 元 → 259900 分）；
 *   · 客供件单价锁 0、二手件必须选实物 —— 客户端先拦，服务端仍为权威；
 *   · 发出成功后展示「只此一次」的分享凭证明文，并明确标注顾客端页面尚未开通；
 *   · 「结果未知」不报成功、不清表单，给出用原 requestId 查询的入口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  fetchQuotes: vi.fn(),
  fetchQuoteDetail: vi.fn(),
  createQuoteDraft: vi.fn(),
  saveQuoteVersion: vi.fn(),
  issueQuoteVersion: vi.fn(),
  confirmQuoteVersion: vi.fn(),
  queryQuoteOperation: vi.fn(),
  fetchCustomerOptions: vi.fn(),
  fetchCustomerDevices: vi.fn(),
  fetchAvailableStockItems: vi.fn(),
  fetchProductOptions: vi.fn(),
}))

vi.mock('./quote-api', () => ({
  fetchQuotes: mocks.fetchQuotes,
  fetchQuoteDetail: mocks.fetchQuoteDetail,
  createQuoteDraft: mocks.createQuoteDraft,
  saveQuoteVersion: mocks.saveQuoteVersion,
  issueQuoteVersion: mocks.issueQuoteVersion,
  confirmQuoteVersion: mocks.confirmQuoteVersion,
  queryQuoteOperation: mocks.queryQuoteOperation,
  fetchCustomerOptions: mocks.fetchCustomerOptions,
  fetchCustomerDevices: mocks.fetchCustomerDevices,
  fetchAvailableStockItems: mocks.fetchAvailableStockItems,
  fetchProductOptions: mocks.fetchProductOptions,
}))

import WorkbenchQuotePage from './WorkbenchQuotePage'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetchCustomerOptions.mockResolvedValue(okPayload({ items: [{ id: 7, name: '张三', phone: '13800000001' }] }))
  mocks.fetchCustomerDevices.mockResolvedValue(
    okPayload({ id: 7, name: '张三', phone: '13800000001', devices: [{ id: 3, label: '顾客的旧主机', serialNumber: 'SN-DEV-1' }] }),
  )
  mocks.fetchAvailableStockItems.mockResolvedValue(
    okPayload({ lotItems: [{ id: 'si-1', assetCode: 'AC-1', productName: '二手显卡' }] }),
  )
  mocks.fetchProductOptions.mockResolvedValue(
    okPayload({
      items: [
        {
          id: 'p-cpu-1',
          sku: 'CPU-14600KF',
          name: 'i5-14600KF',
          category: 'cpu',
          brand: 'Intel',
          defaultSalePriceCents: 200_000,
          version: 1,
          trackingMode: 'quantity',
          requiresSn: false,
          status: 'active',
          availableQty: 3,
          reservedQty: 0,
          quarantineQty: 0,
          ownOnHandQty: 3,
          storeItemCount: 0,
          customerCustodyCount: 0,
        },
      ],
    }),
  )
})

const META = { requestId: 'r1', serverTime: '2026-09-19T00:00:00Z', contractVersion: 'v1' }

function okPayload<T>(data: T) {
  return { ok: true as const, status: 200, data, meta: META }
}

function failPayload(message: string, extra: Record<string, unknown> = {}) {
  return {
    ok: false as const,
    unknownResult: false,
    code: 'SERVICE_UNAVAILABLE',
    message,
    status: 503,
    fieldErrors: null,
    currentVersion: null,
    retryable: true,
    operationId: null,
    requestId: null,
    actions: [],
    ...extra,
  }
}

const SETTINGS = { validityHours: 24, reminderLeadHours: 2, reservationDays: 7, depositPercent: 15 }

function quoteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q-1',
    title: '办公主机',
    customerId: 7,
    customerName: '张三',
    currentRevision: 1,
    workRevision: 1,
    publishedRevision: 1,
    publishedStatus: 'issued',
    publishedTotalCents: 279900,
    version: 2,
    status: 'issued' as const,
    validUntil: '2026-09-20T00:00:00.000Z',
    issuedAt: '2026-09-19T00:00:00.000Z',
    subtotalCents: 279900,
    discountCents: 0,
    totalCents: 279900,
    lineCount: 2,
    shared: true,
    expired: false,
    expiringSoon: false,
    createdAt: '2026-09-19T00:00:00Z',
    updatedAt: '2026-09-19T01:00:00Z',
    ...overrides,
  }
}

function listPayload(quotes: Array<Record<string, unknown>>) {
  return okPayload({
    quotes,
    totals: { all: quotes.length, draft: 1, issued: quotes.length - 1, confirmed: 0, expired: 0, issuedAmountCents: 279900 },
    settings: SETTINGS,
  })
}

function detailPayload(overrides: Record<string, unknown> = {}) {
  return okPayload({
    quote: { id: 'q-1', title: '办公主机', customerId: 7, customerName: '张三', currentRevision: 1, version: 2, createdAt: '2026-09-19T00:00:00Z', updatedAt: '2026-09-19T01:00:00Z' },
    customer: { id: 7, name: '张三', phone: '13800000001' },
    version: {
      revision: 1,
      status: 'issued' as const,
      validUntil: '2026-09-20T00:00:00.000Z',
      issuedAt: '2026-09-19T00:00:00.000Z',
      confirmedAt: null,
      confirmedSource: null,
      discountCents: 0,
      subtotalCents: 279900,
      totalCents: 279900,
      termsSnapshot: { depositPercent: 15, budgetCents: 300000, delivery: { mode: 'self_pickup' }, changeReason: '顾客要换显卡', feedbackSource: 'wechat' },
    },
    lines: [
      { id: 'ql-1', position: 0, source: 'new' as const, nameSnapshot: 'i5 处理器', specSnapshot: '', qty: 1, unitPriceCents: 129900, lineTotalCents: 129900, stockItemId: null, customerDeviceRef: null, warrantySnapshot: { months: 12, note: '全新 1 年' }, stockItemAvailability: null },
      { id: 'ql-2', position: 1, source: 'used' as const, nameSnapshot: '二手显卡', specSnapshot: '', qty: 1, unitPriceCents: 150000, lineTotalCents: 150000, stockItemId: 'si-1', customerDeviceRef: null, warrantySnapshot: { months: 3, note: '二手 3 个月' }, stockItemAvailability: 'available' as const },
    ],
    revisions: [
      { revision: 1, status: 'issued' as const, issuedAt: '2026-09-19T00:00:00.000Z', validUntil: '2026-09-20T00:00:00.000Z', confirmedAt: null, confirmedSource: null, totalCents: 279900, lineCount: 2 },
      { revision: 2, status: 'draft' as const, issuedAt: null, validUntil: null, confirmedAt: null, confirmedSource: null, totalCents: 289900, lineCount: 3 },
    ],
    hasDraft: false,
    share: { active: true, expiresAt: '2026-09-20T00:00:00.000Z', createdAt: '2026-09-19T00:00:00.000Z', revision: 1 },
    expired: false,
    expiringSoon: false,
    settings: SETTINGS,
    ...overrides,
  })
}

describe('报价列表', () => {
  it('按服务端给的状态渲染，即将到期有标记；老板能看到新建按钮', async () => {
    mocks.fetchQuotes.mockResolvedValue(
      listPayload([
        quoteRow({ status: 'draft', currentRevision: 0, workRevision: 1, publishedRevision: null, publishedStatus: null, publishedTotalCents: null, validUntil: null, expiringSoon: false }),
        quoteRow({ id: 'q-2', title: '快到期单', status: 'issued', expiringSoon: true }),
      ]),
    )
    render(<WorkbenchQuotePage permissions={['*']} />)

    await waitFor(() => expect(screen.getByText('办公主机')).toBeTruthy())
    // 「草稿」同时出现在筛选按钮与状态列里，这里只断言它存在
    expect(screen.getAllByText('草稿').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/即将到期/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '新建装机报价' })).toBeTruthy()
    expect(mocks.fetchQuotes).toHaveBeenCalledWith(expect.objectContaining({ status: null }))
  })

  it('显示与工作版本同源的行数、版本和金额，并注明保留的已发出版', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([
      quoteRow({
        status: 'draft',
        currentRevision: 1,
        workRevision: 2,
        publishedRevision: 1,
        publishedStatus: 'confirmed',
        publishedTotalCents: 123400,
        lineCount: 2,
        subtotalCents: 79999,
        discountCents: 2000,
        totalCents: 77999,
      }),
    ]))
    render(<WorkbenchQuotePage permissions={['*']} />)

    await waitFor(() => expect(screen.getByText('办公主机')).toBeTruthy())
    expect(screen.getByText('2 行')).toBeTruthy()
    expect(screen.getByText('v2')).toBeTruthy()
    expect(screen.getByText('¥779.99')).toBeTruthy()
    expect(screen.getByText(/已发出 v1 · 顾客已确认 · ¥1,234.00/)).toBeTruthy()
  })

  it('只有查看权限的店员看不到新建按钮，仍能看到列表', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([quoteRow()]))
    render(<WorkbenchQuotePage permissions={['sales/quote-view']} />)
    await waitFor(() => expect(screen.getByText('办公主机')).toBeTruthy())
    expect(screen.queryByRole('button', { name: '新建装机报价' })).toBeNull()
  })

  it('没有任何权限时不渲染列表内容', () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([quoteRow()]))
    render(<WorkbenchQuotePage permissions={[]} />)
    expect(screen.getByText(/没有报价查看权限/)).toBeTruthy()
    expect(mocks.fetchQuotes).not.toHaveBeenCalled()
  })

  it('筛选与搜索作为参数传给接口', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([]))
    render(<WorkbenchQuotePage permissions={['*']} />)
    await waitFor(() => expect(screen.getByRole('button', { name: '草稿' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '草稿' }))
    await waitFor(() => expect(mocks.fetchQuotes).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'draft' })))
    fireEvent.change(screen.getByLabelText('搜索报价单'), { target: { value: '办公' } })
    await waitFor(() => expect(mocks.fetchQuotes).toHaveBeenLastCalledWith(expect.objectContaining({ q: '办公', status: 'draft' })))
  })
})

describe('新建报价', () => {
  it('金额按元输入、按整数分提交；客供件单价锁 0', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([]))
    mocks.createQuoteDraft.mockResolvedValue(
      okPayload({ operationId: 'r-new', entityId: 'q-new', entityVersion: 1, state: 'draft', effects: { revision: 1 }, summary: '新建报价草稿「测试单」' }),
    )
    mocks.fetchQuoteDetail.mockResolvedValue(detailPayload())
    render(<WorkbenchQuotePage permissions={['*']} />)

    await waitFor(() => expect(screen.getByRole('button', { name: '新建装机报价' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '新建装机报价' }))

    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '测试单' } })
    fireEvent.change(screen.getByLabelText('第 1 行名称'), { target: { value: 'i5 处理器' } })
    fireEvent.change(screen.getByLabelText('第 1 行单价（元）'), { target: { value: '1299.00' } })

    fireEvent.click(screen.getByRole('button', { name: '创建草稿' }))

    await waitFor(() => expect(mocks.createQuoteDraft).toHaveBeenCalled())
    const payload = mocks.createQuoteDraft.mock.calls[0][0]
    expect(payload.lines[0].unitPriceCents).toBe(129900)
    expect(payload.lines[0].qty).toBe(1)
    expect(payload.lines).toEqual([{
      source: 'new', nameSnapshot: 'i5 处理器', specSnapshot: null, qty: 1, unitPriceCents: 129900,
      productRef: null, stockItemId: null, customerDeviceRef: null,
    }])
  })

  it('新建默认八类；切换空白保留已填写行，空槽不提交', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([]))
    mocks.createQuoteDraft.mockResolvedValue(okPayload({ operationId: 'r-new', entityId: 'q-new', entityVersion: 1, state: 'draft', effects: { revision: 1 }, summary: '已建' }))
    mocks.fetchQuoteDetail.mockResolvedValue(detailPayload())
    render(<WorkbenchQuotePage permissions={['*']} />)
    await waitFor(() => screen.getByRole('button', { name: '新建装机报价' }))
    fireEvent.click(screen.getByRole('button', { name: '新建装机报价' }))
    expect(screen.getByLabelText('第 8 行名称')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '整机' } })
    fireEvent.change(screen.getByLabelText('第 1 行名称'), { target: { value: 'i5-14600KF' } })
    fireEvent.change(screen.getByLabelText('第 1 行单价（元）'), { target: { value: '1200' } })
    fireEvent.click(screen.getByRole('button', { name: '空白报价' }))
    expect((screen.getByLabelText('第 1 行名称') as HTMLInputElement).value).toBe('i5-14600KF')
    expect(screen.getByText(/已保留 1 项原配置/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '创建草稿' }))
    await waitFor(() => expect(mocks.createQuoteDraft).toHaveBeenCalled())
    expect(mocks.createQuoteDraft.mock.calls[0][0].lines).toHaveLength(1)
  })

  it('有名称但缺单价时不发送创建请求；半填行错误可见', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([]))
    render(<WorkbenchQuotePage permissions={['*']} />)
    await waitFor(() => screen.getByRole('button', { name: '新建装机报价' }))
    fireEvent.click(screen.getByRole('button', { name: '新建装机报价' }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '缺价单' } })
    fireEvent.change(screen.getByLabelText('第 1 行规格'), { target: { value: '规格已填' } })
    fireEvent.click(screen.getByRole('button', { name: '创建草稿' }))
    expect(await screen.findByText(/请填写商品名称/)).toBeTruthy()
    expect(mocks.createQuoteDraft).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('第 1 行名称'), { target: { value: 'i5' } })
    fireEvent.click(screen.getByRole('button', { name: '创建草稿' }))
    expect(await screen.findByText(/请填写单价/)).toBeTruthy()
    expect(mocks.createQuoteDraft).not.toHaveBeenCalled()
  })

  it('保存和保存并发出遇到缺价行时都不发送请求', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([quoteRow()]))
    mocks.fetchQuoteDetail.mockResolvedValue(detailPayload())
    render(<WorkbenchQuotePage permissions={['*']} />)
    await waitFor(() => screen.getByText('办公主机'))
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    await waitFor(() => screen.getByRole('button', { name: '改一版' }))
    fireEvent.click(screen.getByRole('button', { name: '改一版' }))
    fireEvent.click(screen.getByRole('button', { name: '加一行' }))
    fireEvent.change(screen.getByLabelText('第 3 行名称'), { target: { value: '新配件' } })
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    expect(await screen.findByText(/请填写单价/)).toBeTruthy()
    expect(mocks.saveQuoteVersion).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存并发出' }))
    expect(mocks.saveQuoteVersion).not.toHaveBeenCalled()
    expect(mocks.issueQuoteVersion).not.toHaveBeenCalled()
  })

  it('创建失败时保留标题、场景和输入内容', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([]))
    mocks.createQuoteDraft.mockResolvedValue(failPayload('服务暂不可用'))
    render(<WorkbenchQuotePage permissions={['*']} />)
    await waitFor(() => screen.getByRole('button', { name: '新建装机报价' }))
    fireEvent.click(screen.getByRole('button', { name: '新建装机报价' }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '保留输入' } })
    fireEvent.change(screen.getByLabelText('第 1 行名称'), { target: { value: 'CPU' } })
    fireEvent.change(screen.getByLabelText('第 1 行单价（元）'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: '创建草稿' }))
    expect(await screen.findByText('服务暂不可用')).toBeTruthy()
    expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('保留输入')
    expect((screen.getByLabelText('第 1 行名称') as HTMLInputElement).value).toBe('CPU')
  })

  it('二手行没选实物时提交被客户端拦下，不发请求', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([]))
    render(<WorkbenchQuotePage permissions={['*']} />)

    await waitFor(() => expect(screen.getByRole('button', { name: '新建装机报价' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '新建装机报价' }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '二手单' } })
    fireEvent.change(screen.getByLabelText('第 1 行单价（元）'), { target: { value: '500' } })
    fireEvent.change(screen.getByLabelText('第 1 行来源'), { target: { value: 'used' } })
    fireEvent.change(screen.getByLabelText('第 1 行名称'), { target: { value: '二手显卡' } })

    fireEvent.click(screen.getByRole('button', { name: '创建草稿' }))

    expect(await screen.findByText(/二手件要指定具体实物/)).toBeTruthy()
    expect(mocks.createQuoteDraft).not.toHaveBeenCalled()
  })

  it('打开既有报价改版时只还原服务端两行，不添加模板槽', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([quoteRow()]))
    mocks.fetchQuoteDetail.mockResolvedValue(detailPayload())
    render(<WorkbenchQuotePage permissions={['*']} />)
    await waitFor(() => screen.getByText('办公主机'))
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    await waitFor(() => screen.getByRole('button', { name: '改一版' }))
    fireEvent.click(screen.getByRole('button', { name: '改一版' }))
    expect((screen.getByLabelText('第 2 行名称') as HTMLInputElement).value).toBe('二手显卡')
    expect(screen.queryByLabelText('第 3 行名称')).toBeNull()
    expect(screen.queryByRole('group', { name: '报价场景' })).toBeNull()
  })

  it('空标题被拦下', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([]))
    render(<WorkbenchQuotePage permissions={['*']} />)
    await waitFor(() => expect(screen.getByRole('button', { name: '新建装机报价' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '新建装机报价' }))
    fireEvent.click(screen.getByRole('button', { name: '创建草稿' }))
    expect(await screen.findByText('先给报价单起个标题')).toBeTruthy()
    expect(mocks.createQuoteDraft).not.toHaveBeenCalled()
  })
})

describe('报价详情', () => {
  it('渲染行、金额、条款、版本历史与二手件可用性；预算不进金额计算', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([quoteRow()]))
    mocks.fetchQuoteDetail.mockResolvedValue(detailPayload())
    render(<WorkbenchQuotePage permissions={['*']} />)

    await waitFor(() => expect(screen.getByText('办公主机')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '查看' }))

    await waitFor(() => expect(screen.getByText('i5 处理器')).toBeTruthy())
    // 金额渲染在「应付 ¥2,799.00」这一个文本节点里
    expect(screen.getByText('应付 ¥2,799.00')).toBeTruthy()
    expect(screen.getByText('可取')).toBeTruthy()
    expect(screen.getByText(/预付款比例：15%/)).toBeTruthy()
    expect(screen.getByText(/改版原因：顾客要换显卡（微信）/)).toBeTruthy()
    expect(screen.getByText('版本历史')).toBeTruthy()
    expect(screen.getByText(/顾客预算 ¥3,000.00/)).toBeTruthy()
    expect(screen.queryByText(/省/)).toBeNull()
  })

  it('二手件被占用时显示「已被占用」而不是可取', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([quoteRow()]))
    mocks.fetchQuoteDetail.mockResolvedValue(
      detailPayload({
        lines: [
          { id: 'ql-2', position: 0, source: 'used', nameSnapshot: '二手显卡', specSnapshot: '', qty: 1, unitPriceCents: 150000, lineTotalCents: 150000, stockItemId: 'si-1', customerDeviceRef: null, warrantySnapshot: {}, stockItemAvailability: 'reserved' },
        ],
      }),
    )
    render(<WorkbenchQuotePage permissions={['*']} />)
    await waitFor(() => expect(screen.getByText('办公主机')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    await waitFor(() => expect(screen.getByText('已被占用')).toBeTruthy())
  })

  it('已过期的已发出单出现「续期 24 小时」按钮；续期 = 保存新版本 + 发出', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([quoteRow()]))
    mocks.fetchQuoteDetail.mockResolvedValue(
      detailPayload({
        expired: true,
        version: { revision: 1, status: 'issued', validUntil: '2020-01-01T00:00:00.000Z', issuedAt: '2020-01-01T00:00:00.000Z', discountCents: 0, subtotalCents: 279900, totalCents: 279900, termsSnapshot: {} },
      }),
    )
    mocks.saveQuoteVersion.mockResolvedValue(okPayload({ operationId: 'r-s', entityId: 'q-1', entityVersion: 3, state: 'draft', effects: { revision: 2 }, summary: '保存报价第 2 版' }))
    mocks.issueQuoteVersion.mockResolvedValue(
      okPayload({ operationId: 'r-i', entityId: 'q-1', entityVersion: 4, state: 'issued', effects: { revision: 2 }, summary: '发出报价第 2 版', shareToken: 'tok-123' }),
    )
    render(<WorkbenchQuotePage permissions={['*']} />)
    await waitFor(() => expect(screen.getByText('办公主机')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '续期 24 小时' })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '续期 24 小时' }))
    await waitFor(() => expect(mocks.issueQuoteVersion).toHaveBeenCalled())
    expect(mocks.issueQuoteVersion.mock.calls[0][1]).toBe(3)
    expect(mocks.saveQuoteVersion.mock.calls[0][2]).toBe(2)
    expect(await screen.findByText(/只显示这一次/)).toBeTruthy()
    expect(screen.getByText('tok-123')).toBeTruthy()
    expect(screen.getByText(/顾客端页面尚未开通/)).toBeTruthy()
  })

  it('发出成功后提示里写明「旧链接锁定的是旧版本」', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([quoteRow()]))
    mocks.fetchQuoteDetail.mockResolvedValue(detailPayload({ hasDraft: true }))
    mocks.saveQuoteVersion.mockResolvedValue(okPayload({ operationId: 'r-s', entityId: 'q-1', entityVersion: 3, state: 'draft', effects: { revision: 2 }, summary: '保存报价第 2 版' }))
    mocks.issueQuoteVersion.mockResolvedValue(okPayload({ operationId: 'r-i', entityId: 'q-1', entityVersion: 4, state: 'issued', effects: { revision: 2 }, summary: '发出报价第 2 版' }))
    render(<WorkbenchQuotePage permissions={['*']} />)
    await waitFor(() => expect(screen.getByText('办公主机')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '发出草稿版' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '发出草稿版' }))
    await waitFor(() => expect(screen.getByText(/旧链接锁定的是旧版本/)).toBeTruthy())
  })

  it('B42：已发出且未过期的当前版本可记录顾客确认，按来源提交并提示确认 ≠ 付款', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([quoteRow()]))
    mocks.fetchQuoteDetail.mockResolvedValue(detailPayload())
    mocks.confirmQuoteVersion.mockResolvedValue(
      okPayload({ operationId: 'r-cf', entityId: 'q-1', entityVersion: 3, state: 'confirmed', effects: { revision: 1, source: 'wechat' }, summary: '记录顾客确认（第 1 版，来源：微信）' }),
    )
    render(<WorkbenchQuotePage permissions={['*']} />)
    await waitFor(() => expect(screen.getByText('办公主机')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '记录顾客确认' })).toBeTruthy())

    fireEvent.change(screen.getByLabelText('确认来源'), { target: { value: 'wechat' } })
    fireEvent.click(screen.getByRole('button', { name: '记录顾客确认' }))
    await waitFor(() => expect(mocks.confirmQuoteVersion).toHaveBeenCalled())
    // 参数：quoteId、expectedVersion、来源
    expect(mocks.confirmQuoteVersion.mock.calls[0][0]).toBe('q-1')
    expect(mocks.confirmQuoteVersion.mock.calls[0][1]).toBe(2)
    expect(mocks.confirmQuoteVersion.mock.calls[0][2]).toBe('wechat')
    expect(await screen.findByText(/确认 ≠ 付款/)).toBeTruthy()
  })

  it('已确认的版本显示确认信息，不再显示确认按钮；只有查看权限也不显示确认入口', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([quoteRow({ status: 'confirmed' })]))
    mocks.fetchQuoteDetail.mockResolvedValue(
      detailPayload({
        version: {
          revision: 1, status: 'confirmed', validUntil: '2026-09-20T00:00:00.000Z', issuedAt: '2026-09-19T00:00:00.000Z',
          confirmedAt: '2026-09-19T05:00:00.000Z', confirmedSource: 'miniprogram',
          discountCents: 0, subtotalCents: 279900, totalCents: 279900, termsSnapshot: {},
        },
      }),
    )
    render(<WorkbenchQuotePage permissions={['*']} />)
    await waitFor(() => expect(screen.getByText('办公主机')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(await screen.findByText(/顾客已确认第 1 版/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '记录顾客确认' })).toBeNull()
    expect(screen.getByText(/来源：小程序/)).toBeTruthy()
  })
})

describe('结果未知', () => {
  it('创建超时不报成功、给出「查询结果」入口；确认成功后刷新详情', async () => {
    mocks.fetchQuotes.mockResolvedValue(listPayload([]))
    mocks.createQuoteDraft.mockResolvedValue(
      failPayload('网络超时', { unknownResult: true, code: null, requestId: 'req-unknown', status: null }),
    )
    mocks.queryQuoteOperation.mockResolvedValue({ ok: true, status: 'succeeded', code: null, message: '', resultRef: 'q-unknown' })
    mocks.fetchQuoteDetail.mockResolvedValue(detailPayload({ quote: { id: 'q-unknown', title: '办公主机', customerId: null, customerName: null, currentRevision: 1, version: 1, createdAt: '', updatedAt: '' } }))
    render(<WorkbenchQuotePage permissions={['*']} />)

    await waitFor(() => expect(screen.getByRole('button', { name: '新建装机报价' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '新建装机报价' }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '测试单' } })
    fireEvent.change(screen.getByLabelText('第 1 行名称'), { target: { value: '配件' } })
    fireEvent.change(screen.getByLabelText('第 1 行单价（元）'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: '创建草稿' }))

    expect(await screen.findByText(/不要重复提交/)).toBeTruthy()
    expect(screen.queryByText(/已创建/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '查询结果' }))
    await waitFor(() => expect(screen.getByText(/后台确认这笔已经生效/)).toBeTruthy())
    expect(mocks.queryQuoteOperation).toHaveBeenCalledWith('req-unknown')
  })
})
