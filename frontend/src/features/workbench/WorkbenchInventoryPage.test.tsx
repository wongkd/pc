// @vitest-environment jsdom
/**
 * E04b · 库存页（真实接口）渲染与提交测试。
 *
 * 证明的是「页面按口径显示、按契约提交」，不证明任何后端行为（后端见
 * backend/tests/e04b-inventory-http.test.mjs）。重点四条：
 *   · 成本列只在服务端返回该字段时出现（04 §3 L57），前端不自己判权限；
 *   · 未知成本写「成本未知」，页面不出现 ¥0.00（03 §1 R01）；
 *   · 金额以整数分提交、空成本不写成 0；
 *   · 写入「结果未知」时不清表单、不报成功，并给出用原 requestId 查询的入口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  fetchInventory: vi.fn(),
  fetchStockItem: vi.fn(),
  saveProduct: vi.fn(),
  openInventoryOpeningWindow: vi.fn(),
  recordOpening: vi.fn(),
  queryOperationResult: vi.fn(),
  createInventoryCount: vi.fn(),
  approveInventoryCount: vi.fn(),
  inspectQuarantinedItem: vi.fn(),
  recordRefurbishment: vi.fn(),
}))

vi.mock('./inventory-api', () => ({
  fetchInventory: mocks.fetchInventory,
  fetchStockItem: mocks.fetchStockItem,
  saveProduct: mocks.saveProduct,
  openInventoryOpeningWindow: mocks.openInventoryOpeningWindow,
  recordOpening: mocks.recordOpening,
  queryOperationResult: mocks.queryOperationResult,
  createInventoryCount: mocks.createInventoryCount,
  approveInventoryCount: mocks.approveInventoryCount,
  inspectQuarantinedItem: mocks.inspectQuarantinedItem,
  recordRefurbishment: mocks.recordRefurbishment,
}))

import { WorkbenchInventoryPage } from './WorkbenchInventoryPage'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
})

interface RowOverrides {
  [key: string]: unknown
}

function row(overrides: RowOverrides = {}) {
  return {
    id: 'p-1',
    sku: 'GPU-4060TI',
    name: '影驰 RTX 4060 Ti 金属大师',
    category: '显卡',
    brand: '影驰',
    defaultSalePriceCents: 259900,
    version: 1,
    trackingMode: 'quantity' as const,
    requiresSn: false,
    status: 'active' as const,
    availableQty: 2,
    reservedQty: 1,
    quarantineQty: 0,
    ownOnHandQty: 3,
    storeItemCount: 0,
    customerCustodyCount: 0,
    ...overrides,
  }
}

const TOTALS = {
  ownOnHandQty: 3, availableQty: 2, reservedQty: 1, quarantineQty: 0,
  customerCustodyCount: 0, inTransitQty: 0,
}

function listPayload(
  items: Array<Record<string, unknown>>,
  lotItems: Array<Record<string, unknown>> = [],
  hasMore = false,
  openingWindow: { mode: string; status: string; openedAt: string | null; closesAt: string | null; closedAt: string | null; closeReason: string | null } = { mode: 'preview', status: 'preview', openedAt: null, closesAt: null, closedAt: null, closeReason: null },
) {
  return {
    ok: true as const,
    status: 200,
    data: { items, lotItems, totals: TOTALS, filters: {}, nextCursor: null, hasMore, openingWindow },
    meta: { requestId: 'r1', serverTime: '2026-09-19T00:00:00Z', contractVersion: 'v2' },
  }
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

const WITH_COST = [
  row({ totalCostCents: 286000, costKnown: true }),
  row({ id: 'p-2', sku: 'MB-B760', name: '华硕 TUF B760M-PLUS', category: '主板', brand: '华硕', availableQty: 0, reservedQty: 0, ownOnHandQty: 0, totalCostCents: null, costKnown: false }),
]
const WITHOUT_COST = [
  row(),
  row({ id: 'p-2', sku: 'MB-B760', name: '华硕 TUF B760M-PLUS', category: '主板', brand: '华硕' }),
]

function renderPage(permissions: string[] = ['*']) {
  mocks.fetchInventory.mockImplementation(async () => listPayload(WITH_COST))
  return render(<WorkbenchInventoryPage permissions={permissions} />)
}

describe('库存页 · 读取与显示', () => {
  it('把实物收货和交付入口放在配件台账首屏', async () => {
    renderPage()
    expect((await screen.findByRole('link', { name: '采购到货' })).getAttribute('href')).toBe('/purchases')
    expect(screen.getByRole('link', { name: '收旧件' }).getAttribute('href')).toBe('/recovery')
    expect(screen.getByRole('link', { name: '备料与交付' }).getAttribute('href')).toBe('/sales/fulfillment')
  })

  it('列出真实接口返回的型号与三桶数量', async () => {
    renderPage()
    expect(await screen.findByText('影驰 RTX 4060 Ti 金属大师')).toBeTruthy()
    expect(screen.getByText('华硕 TUF B760M-PLUS')).toBeTruthy()
    expect(mocks.fetchInventory).toHaveBeenCalledWith({ limit: 50 })
  })

  it('服务端返回成本字段时才渲染成本列', async () => {
    renderPage()
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    expect(screen.getByRole('columnheader', { name: '成本' })).toBeTruthy()
    expect(screen.getByText('¥2,860.00')).toBeTruthy()
  })

  it('无成本字段时整列不渲染，也不显示 ¥0.00', async () => {
    mocks.fetchInventory.mockResolvedValue(listPayload(WITHOUT_COST))
    render(<WorkbenchInventoryPage permissions={['*']} />)
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    expect(screen.queryByRole('columnheader', { name: '成本' })).toBeNull()
    expect(screen.queryByText('¥0.00')).toBeNull()
  })

  it('型号汇总成本不把未完全确认的成本伪装成未知或零', async () => {
    renderPage()
    await screen.findByText('华硕 TUF B760M-PLUS')
    expect(screen.getByText('成本未完全按实际口径确认，查看入库明细')).toBeTruthy()
    expect(screen.queryByText('¥0.00')).toBeNull()
  })

  it('加载失败给出错误与重试，重试真的再请求一次', async () => {
    mocks.fetchInventory.mockResolvedValueOnce(failPayload('服务暂不可用'))
    render(<WorkbenchInventoryPage permissions={['*']} />)
    expect(await screen.findByText('库存没能加载出来')).toBeTruthy()
    mocks.fetchInventory.mockResolvedValue(listPayload(WITH_COST))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('影驰 RTX 4060 Ti 金属大师')).toBeTruthy()
  })

  it('没有型号时给空态，指向新增商品与期初录入', async () => {
    mocks.fetchInventory.mockResolvedValue(listPayload([]))
    render(<WorkbenchInventoryPage permissions={['*']} />)
    expect(await screen.findByText('还没有商品档案')).toBeTruthy()
    expect(screen.getByText(/隔离预览仅保留旧格式试录，不会建立正式期初窗口/)).toBeTruthy()
  })

  it('展开型号按 productRef 单独拉逐件实物', async () => {
    mocks.fetchInventory.mockImplementation(async (filters: { productRef?: string } = {}) => {
      const itemRow = row({ trackingMode: 'item', requiresSn: true, totalCostCents: 285000, costKnown: true })
      if (filters?.productRef) {
        return listPayload(
          [itemRow],
          [{ id: 'si-1', productId: 'p-1', productName: '影驰 RTX 4060 Ti 金属大师', assetCode: 'U-017', condition: 'used', snRaw: 'SN-017', snNormalized: 'SN-017', ownership: 'store', availability: 'available', location: 'store', activeReservationRef: null, acquisitionCostCents: 285000, costKnown: true }],
        )
      }
      return listPayload([itemRow])
    })
    render(<WorkbenchInventoryPage permissions={['*']} />)
    fireEvent.click(await screen.findByRole('button', { name: /影驰 RTX 4060 Ti 金属大师/ }))
    expect(await screen.findByText('U-017')).toBeTruthy()
    expect(mocks.fetchInventory).toHaveBeenCalledWith({ productRef: 'p-1', limit: 100 })
    expect(screen.getByText(/数量构成 · 自有在库/)).toBeTruthy()
  })
})

describe('库存页 · 商品建档', () => {
  it('提交的是整数分，且逐件管理自动要求 SN', async () => {
    mocks.saveProduct.mockResolvedValue({
      ok: true, status: 200,
      data: { operationId: 'req-1', entityId: 'p-9', entityVersion: 1, summary: '建立商品' },
      meta: { requestId: 'req-1', serverTime: '', contractVersion: 'v2' },
    })
    render(<WorkbenchInventoryPage permissions={['*']} />)
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')

    fireEvent.click(screen.getByRole('button', { name: '新增商品' }))
    fireEvent.change(screen.getByLabelText('商品名称'), { target: { value: '二手 3080 显卡' } })
    fireEvent.change(screen.getByLabelText('分类'), { target: { value: '显卡' } })
    fireEvent.change(screen.getByLabelText('品牌'), { target: { value: '影驰' } })
    fireEvent.change(screen.getByLabelText('新建商品参考售价（元）'), { target: { value: '1299.5' } })
    fireEvent.change(screen.getByLabelText('管理方式'), { target: { value: 'item' } })
    fireEvent.click(screen.getByRole('button', { name: '建立商品' }))

    await waitFor(() => expect(mocks.saveProduct).toHaveBeenCalledTimes(1))
    const [payload, version] = mocks.saveProduct.mock.calls[0]
    expect(payload.defaultSalePriceCents).toBe(129950)
    expect(payload.trackingMode).toBe('item')
    expect(payload.requiresSn).toBe(true)
    expect(payload.productRef).toBeNull()
    expect(version).toBeNull()
    expect(await screen.findByText('已建立商品「二手 3080 显卡」')).toBeTruthy()
  })

  it('改商品带 expectedVersion；版本冲突给出可照做的提示', async () => {
    mocks.saveProduct.mockResolvedValue(failPayload('对象已被更新', { code: 'VERSION_CONFLICT', status: 409 }))
    renderPage()
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    fireEvent.click(screen.getByRole('button', { name: /影驰 RTX 4060 Ti 金属大师/ }))
    fireEvent.click(await screen.findByRole('button', { name: '编辑商品' }))
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(mocks.saveProduct).toHaveBeenCalledTimes(1))
    expect(mocks.saveProduct.mock.calls[0][1]).toBe(1)
    expect(await screen.findByText(/已被别人改过/)).toBeTruthy()
  })

  it('结果未知时不清表单、不报成功，并给出查询入口', async () => {
    mocks.saveProduct.mockResolvedValue({
      ...failPayload('请求结果未知'),
      unknownResult: true,
      code: null,
      status: null,
      requestId: 'req-unknown-1',
    })
    mocks.queryOperationResult.mockResolvedValue({ ok: true, status: 'succeeded', code: null, message: '', resultRef: 'p-9' })
    renderPage()
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    fireEvent.click(screen.getByRole('button', { name: '新增商品' }))
    fireEvent.change(screen.getByLabelText('商品名称'), { target: { value: '可能已保存的商品' } })
    fireEvent.click(screen.getByRole('button', { name: '建立商品' }))

    expect(await screen.findByText(/请求结果未知：可能已经保存成功/)).toBeTruthy()
    // 表单还在，输入没有被清掉
    expect((screen.getByLabelText('商品名称') as HTMLInputElement).value).toBe('可能已保存的商品')

    fireEvent.click(screen.getByRole('button', { name: '查询结果' }))
    await waitFor(() => expect(mocks.queryOperationResult).toHaveBeenCalledWith('req-unknown-1'))
    expect(await screen.findByText(/后台确认这笔已经记账/)).toBeTruthy()
  })

  it('无建档权限时不显示新增入口，但读与成本列照旧', async () => {
    renderPage([])
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    expect(screen.queryByRole('button', { name: '新增商品' })).toBeNull()
    expect(screen.queryByRole('button', { name: /录入期初库存/ })).toBeNull()
    expect(screen.getByRole('columnheader', { name: '成本' })).toBeTruthy()
  })
})

describe('库存页 · 期初录入', () => {
  async function openOpening(permissions: string[] = ['*']) {
    renderPage(permissions)
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    fireEvent.click(screen.getByRole('button', { name: /录入期初库存/ }))
    await waitFor(() => expect(mocks.fetchInventory).toHaveBeenCalledWith({ limit: 100 }))
    fireEvent.change(screen.getByLabelText('人工实盘凭据'), { target: { value: '实盘 2026-09-19 全场' } })
  }

  it('数量件：数量照填，空成本不写成 0', async () => {
    mocks.recordOpening.mockResolvedValue({
      ok: true, status: 200,
      data: { operationId: 'req-op', entityId: 'op-1', entityVersion: 1, summary: '期初建账 1 行 / 4 件' },
      meta: { requestId: 'req-op', serverTime: '', contractVersion: 'v2' },
    })
    await openOpening()
    fireEvent.change(screen.getByLabelText('型号'), { target: { value: 'p-1' } })
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: '提交期初' }))

    await waitFor(() => expect(mocks.recordOpening).toHaveBeenCalledTimes(1))
    const payload = mocks.recordOpening.mock.calls[0][0]
    expect(payload.approvedCountRef).toBe('实盘 2026-09-19 全场')
    expect(payload.costBasis).toEqual({ kind: 'unknown' })
    expect(payload.lines).toEqual([{ productRef: 'p-1', qty: 4 }])
    expect('unitCostCents' in payload.lines[0]).toBe(false)
    expect(await screen.findByText(/期初已建账/)).toBeTruthy()
  })

  it('逐件商品固定为一件，内部编号自动生成且不要求厂家 SN', async () => {
    // 这里直接铺一个逐件商品，不走 openOpening()：后者会重置 fetchInventory 的实现。
    const itemRow = row({ trackingMode: 'item', requiresSn: true, totalCostCents: null, costKnown: false })
    mocks.fetchInventory.mockResolvedValue(listPayload([itemRow]))
    render(<WorkbenchInventoryPage permissions={['*']} />)
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    fireEvent.click(screen.getByRole('button', { name: /录入期初库存/ }))
    await waitFor(() => expect(mocks.fetchInventory).toHaveBeenCalledWith({ limit: 100 }))
    fireEvent.change(screen.getByLabelText('人工实盘凭据'), { target: { value: '实盘 2026-09-19 全场' } })
    fireEvent.change(screen.getByLabelText('型号'), { target: { value: 'p-1' } })

    expect(screen.getByDisplayValue('提交后自动生成')).toBeTruthy()
    expect((screen.getByLabelText('厂家 SN（可选，可扫码）') as HTMLInputElement).disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('旧格式单件成本（元，留空 = 未知）'), { target: { value: '2850' } })
    mocks.recordOpening.mockResolvedValue({
      ok: true, status: 200,
      data: { operationId: 'req-op2', entityId: 'op-2', entityVersion: 1, summary: '期初建账 1 行 / 1 件' },
      meta: { requestId: 'req-op2', serverTime: '', contractVersion: 'v2' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提交期初' }))

    await waitFor(() => expect(mocks.recordOpening).toHaveBeenCalledTimes(1))
    const payload = mocks.recordOpening.mock.calls[0][0]
    expect(payload.lines[0]).toEqual({ productRef: 'p-1', qty: 1, condition: 'new', unitCostCents: 285000 })
    expect('assetCode' in payload.lines[0]).toBe(false)
    expect('snRaw' in payload.lines[0]).toBe(false)
    // 全部行都填了金额 → 声明成本已知；这与服务端「声明已知却缺金额就拒」同向
    expect(payload.costBasis).toEqual({ kind: 'known' })
  })

  it('正式期初先开启一次窗口，再逐行保存估值依据和日期', async () => {
    let status: 'not_started' | 'open' = 'not_started'
    const windowState = () => ({
      mode: 'formal' as const, status, openedAt: '2026-09-25T00:00:00.000Z',
      closesAt: '2026-10-02T00:00:00.000Z', closedAt: null, closeReason: null,
    })
    mocks.fetchInventory.mockImplementation(async () => listPayload(WITH_COST, [], false, windowState()))
    mocks.openInventoryOpeningWindow.mockImplementation(async (days: number) => {
      status = 'open'
      expect(days).toBe(7)
      return {
        ok: true, status: 200,
        data: { operationId: 'req-window', entityId: 'opening-window:1', entityVersion: 1, summary: '已开启正式期初窗口' },
        meta: { requestId: 'req-window', serverTime: '', contractVersion: 'v2' },
      }
    })
    mocks.recordOpening.mockResolvedValue({
      ok: true, status: 200,
      data: { operationId: 'req-formal-opening', entityId: 'open-1', entityVersion: 1, summary: '期初建账 1 行 / 2 件' },
      meta: { requestId: 'req-formal-opening', serverTime: '', contractVersion: 'v2' },
    })

    render(<WorkbenchInventoryPage permissions={['*']} />)
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    fireEvent.click(screen.getByRole('button', { name: '开启正式期初窗口' }))
    await screen.findByRole('button', { name: '录入正式期初库存' })
    expect(mocks.openInventoryOpeningWindow).toHaveBeenCalledWith(7)

    fireEvent.click(screen.getByRole('button', { name: '录入正式期初库存' }))
    await waitFor(() => expect(mocks.fetchInventory).toHaveBeenCalledWith({ limit: 100 }))
    fireEvent.change(screen.getByLabelText('人工实盘凭据'), { target: { value: '盘点单 OPEN-2026-01' } })
    fireEvent.change(screen.getByLabelText('盘点明细行引用'), { target: { value: 'A-01' } })
    fireEvent.change(screen.getByLabelText('型号'), { target: { value: 'p-1' } })
    fireEvent.change(screen.getByLabelText('成本口径'), { target: { value: 'assessed_estimate' } })
    fireEvent.change(screen.getByLabelText('单件成本（元）'), { target: { value: '1800' } })
    fireEvent.change(screen.getByLabelText('估值依据'), { target: { value: '同型号近月成交价' } })
    fireEvent.change(screen.getByLabelText('估值日期'), { target: { value: '2026-09-24' } })
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '提交期初' }))

    await waitFor(() => expect(mocks.recordOpening).toHaveBeenCalledTimes(1))
    const payload = mocks.recordOpening.mock.calls[0][0]
    expect(payload).not.toHaveProperty('costBasis')
    expect(payload.lines[0]).toMatchObject({
      approvedCountLineRef: 'A-01', productRef: 'p-1', qty: 2, costBasis: 'assessed_estimate', unitCostCents: 180000,
      costEvidenceRef: '同型号近月成交价', costAssessedAt: '2026-09-24',
    })
  })

  it('没填实盘凭据就提交会被拦下', async () => {
    renderPage()
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    fireEvent.click(screen.getByRole('button', { name: /录入期初库存/ }))
    fireEvent.click(screen.getByRole('button', { name: '提交期初' }))
    expect(await screen.findByText(/请填写人工实盘凭据/)).toBeTruthy()
    expect(mocks.recordOpening).not.toHaveBeenCalled()
  })
})

describe('库存页 · 整备财务凭据', () => {
  it('展示服务端返回的整备支出并把付款流水、票据引用一起提交', async () => {
    const product = row({ trackingMode: 'item', requiresSn: true, totalCostCents: 50000, costKnown: true })
    const stockItem = {
      id: 'si-recovered', version: 2, productId: 'p-1', productName: product.name, assetCode: 'REC-017', remark: '',
      condition: 'used' as const, snRaw: null, snNormalized: null, ownership: 'store' as const, availability: 'available' as const,
      location: 'store' as const, activeReservationRef: null, acquisitionCostCents: 50000, costKnown: true,
    }
    mocks.fetchInventory.mockImplementation(async (filters: { productRef?: string } = {}) => listPayload(
      [product],
      filters.productRef ? [stockItem] : [],
    ))
    const detail = {
      item: stockItem, attachments: [], recoveryState: 'refurbishing', product: { id: 'p-1', sku: 'GPU-4060TI', name: product.name, trackingMode: 'item' },
      activeReservation: null, acquisition: null,
      movements: [
        { id: 'move-acquired', qty: 1, fromBucket: null, toBucket: 'available', source: 'recovery_acquisition', occurredAt: '2026-09-25T00:00:00.000Z' },
        { id: 'move-inspected', qty: 0, fromBucket: 'quarantine', toBucket: 'available', source: 'inspection_release', occurredAt: '2026-09-25T00:01:00.000Z' },
      ],
      refurbishmentCosts: [{ id: 'cost-1', category: '换电池', amountCents: 5000, capitalizable: true, paymentEntryRef: 'cash-1', evidenceRef: 'invoice-1', occurredAt: '2026-09-25T00:02:00.000Z' }],
    }
    mocks.fetchStockItem.mockResolvedValue({ ok: true, status: 200, data: detail, meta: { requestId: 'detail-1', serverTime: '', contractVersion: 'v2' } })
    mocks.recordRefurbishment.mockResolvedValue({
      ok: true, status: 200,
      data: { operationId: 'refurb-1', entityId: 'si-recovered', entityVersion: 3, summary: '已记录整备并计入件成本' },
      meta: { requestId: 'refurb-1', serverTime: '', contractVersion: 'v2' },
    })

    render(<WorkbenchInventoryPage permissions={['inventory/refurbish']} />)
    fireEvent.click(await screen.findByRole('button', { name: /影驰 RTX 4060 Ti 金属大师/ }))
    fireEvent.click(await screen.findByRole('button', { name: /REC-017/ }))
    expect(await screen.findByText('已登记整备支出')).toBeTruthy()
    expect(screen.getByText('付款流水：cash-1')).toBeTruthy()
    expect(screen.getByText('凭据引用：invoice-1')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('整备项目'), { target: { value: '更换风扇' } })
    fireEvent.change(screen.getByLabelText('整备金额（元）'), { target: { value: '35.50' } })
    fireEvent.change(screen.getByLabelText('实际付款流水编号（可选）'), { target: { value: 'cash-2' } })
    fireEvent.change(screen.getByLabelText('票据 / 附件引用（可选）'), { target: { value: 'invoice-2' } })
    fireEvent.click(screen.getByRole('button', { name: '登记整备支出' }))

    await waitFor(() => expect(mocks.recordRefurbishment).toHaveBeenCalledTimes(1))
    expect(mocks.recordRefurbishment).toHaveBeenCalledWith('si-recovered', {
      category: '更换风扇', amountCents: 3550, capitalizable: true,
      paymentEntryRef: 'cash-2', evidenceRef: 'invoice-2',
    })
  })
})

describe('库存页 · 盘点失败重试与权限', () => {
  it('结果未知后保留盘点快照时间；无批准权限账号不能批准差异', async () => {
    mocks.createInventoryCount
      .mockResolvedValueOnce({ ...failPayload('请求结果未知'), unknownResult: true, status: null, requestId: 'count-request-1' })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        data: { operationId: 'count-request-1', entityId: 'count-1', entityVersion: 1, summary: '已保存实盘' },
        meta: { requestId: 'count-request-1', serverTime: '', contractVersion: 'v2' },
      })
    mocks.queryOperationResult.mockResolvedValue({ ok: true, status: 'unknown', code: null, message: '', resultRef: null })
    renderPage(['inventory/count'])
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    fireEvent.click(screen.getByRole('button', { name: '录入盘点' }))
    fireEvent.change(screen.getByLabelText('实盘数量'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('备注 / 批准原因'), { target: { value: '主板库存复核' } })
    fireEvent.click(screen.getByRole('button', { name: '保存实盘' }))

    expect(await screen.findByText(/实盘内容已保留/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查询结果' }))
    await screen.findByText(/后台查不到这个请求编号，可以重新提交/)
    fireEvent.click(screen.getByRole('button', { name: '保存实盘' }))

    await waitFor(() => expect(mocks.createInventoryCount).toHaveBeenCalledTimes(2))
    expect(mocks.createInventoryCount.mock.calls[1]?.[0]).toEqual(mocks.createInventoryCount.mock.calls[0]?.[0])
    expect(mocks.createInventoryCount.mock.calls[0]?.[0]).toMatchObject({
      note: '主板库存复核', lines: [{ productRef: 'p-1', countedQty: 2 }],
    })
    expect(mocks.createInventoryCount.mock.calls[0]?.[0].asOf).toBeTruthy()
    expect(await screen.findByText('实盘已保存，当前账号没有批准差异权限。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '批准差异入账' })).toBeNull()
  })
})

describe('库存页 · B19 退役', () => {
  it('有检测发现但没有附件时仍可提交报废退役，且提交逐件当前版本', async () => {
    const product = row({ trackingMode: 'item', requiresSn: true, quarantineQty: 1, totalCostCents: 50000, costKnown: true })
    const stockItem = {
      id: 'si-retire', version: 4, productId: 'p-1', productName: product.name, assetCode: 'REC-018', remark: '',
      condition: 'used' as const, snRaw: null, snNormalized: null, ownership: 'store' as const, availability: 'quarantine' as const,
      location: 'store' as const, activeReservationRef: null, acquisitionCostCents: 50000, costKnown: true,
    }
    mocks.fetchInventory.mockImplementation(async (filters: { productRef?: string } = {}) => listPayload(
      [product], filters.productRef ? [stockItem] : [],
    ))
    mocks.fetchStockItem.mockResolvedValue({
      ok: true, status: 200,
      data: { item: stockItem, attachments: [], recoveryState: null, product: { id: 'p-1', sku: 'GPU-4060TI', name: product.name, trackingMode: 'item' }, activeReservation: null, acquisition: null, movements: [] },
      meta: { requestId: 'retire-detail', serverTime: '', contractVersion: 'v2' },
    })
    mocks.inspectQuarantinedItem.mockResolvedValue({
      ok: true, status: 200,
      data: { operationId: 'retire-operation', entityId: 'si-retire', entityVersion: 5, summary: '已退役' },
      meta: { requestId: 'retire-operation', serverTime: '', contractVersion: 'v2' },
    })

    render(<WorkbenchInventoryPage permissions={['inventory/inspection']} />)
    fireEvent.click(await screen.findByRole('button', { name: /影驰 RTX 4060 Ti 金属大师/ }))
    fireEvent.click(await screen.findByRole('button', { name: /REC-018/ }))
    fireEvent.change(await screen.findByLabelText('检测发现'), { target: { value: '进水腐蚀，无法维修' } })
    fireEvent.click(screen.getByRole('button', { name: '判定报废 / 退役' }))

    await waitFor(() => expect(mocks.inspectQuarantinedItem).toHaveBeenCalledTimes(1))
    expect(mocks.inspectQuarantinedItem).toHaveBeenCalledWith({
      itemId: 'si-retire', expectedVersion: 4, result: 'fail', findings: '进水腐蚀，无法维修', evidence: [], disposition: 'retired',
    })
  })
})
