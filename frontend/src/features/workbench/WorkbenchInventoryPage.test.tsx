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
  fetchInventoryActivity: vi.fn(),
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
  fetchInventoryActivity: mocks.fetchInventoryActivity,
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
    expect(screen.getByText(/隔离预览只使用演示数据，不会写入正式库存/)).toBeTruthy()
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

  it('分类必须从固定选项中选择，其他分类可填写自定义名称', async () => {
    mocks.saveProduct.mockResolvedValue({
      ok: true, status: 200,
      data: { operationId: 'req-category', entityId: 'p-category', entityVersion: 1, summary: '建立商品' },
      meta: { requestId: 'req-category', serverTime: '', contractVersion: 'v2' },
    })
    renderPage()
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    fireEvent.click(screen.getByRole('button', { name: '新增商品' }))
    fireEvent.change(screen.getByLabelText('商品名称'), { target: { value: 'PCIe 无线网卡' } })
    fireEvent.click(screen.getByRole('button', { name: '建立商品' }))
    expect(await screen.findByText('请选择商品分类')).toBeTruthy()
    expect(mocks.saveProduct).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('分类'), { target: { value: '__custom_category__' } })
    fireEvent.change(screen.getByLabelText('自定义分类'), { target: { value: '扩展卡' } })
    fireEvent.click(screen.getByRole('button', { name: '建立商品' }))
    await waitFor(() => expect(mocks.saveProduct).toHaveBeenCalledTimes(1))
    expect(mocks.saveProduct.mock.calls[0][0].category).toBe('扩展卡')
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
    fireEvent.change(screen.getByLabelText('分类'), { target: { value: '显卡' } })
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
    expect(screen.queryByRole('button', { name: /现有库存/ })).toBeNull()
    expect(screen.getByRole('columnheader', { name: '成本' })).toBeTruthy()
  })
})

describe('库存页 · 期初录入', () => {
  async function openOpening(permissions: string[] = ['*']) {
    renderPage(permissions)
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    fireEvent.click(screen.getByRole('button', { name: /现有库存/ }))
    await waitFor(() => expect(mocks.fetchInventory).toHaveBeenCalledWith({ limit: 100 }))
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
    fireEvent.click(screen.getByRole('button', { name: '保存库存' }))

    await waitFor(() => expect(mocks.recordOpening).toHaveBeenCalledTimes(1))
    const payload = mocks.recordOpening.mock.calls[0][0]
    expect(payload.approvedCountRef).toMatch(/^existing-stock-/)
    expect(payload.costBasis).toEqual({ kind: 'unknown' })
    expect(payload.lines).toEqual([{ productRef: 'p-1', qty: 4 }])
    expect('unitCostCents' in payload.lines[0]).toBe(false)
    expect(await screen.findByText(/现有库存已登记/)).toBeTruthy()
  })

  it('逐件商品固定为一件，内部编号自动生成且不要求厂家 SN', async () => {
    // 这里直接铺一个逐件商品，不走 openOpening()：后者会重置 fetchInventory 的实现。
    const itemRow = row({ trackingMode: 'item', requiresSn: true, totalCostCents: null, costKnown: false })
    mocks.fetchInventory.mockResolvedValue(listPayload([itemRow]))
    render(<WorkbenchInventoryPage permissions={['*']} />)
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    fireEvent.click(screen.getByRole('button', { name: /现有库存/ }))
    await waitFor(() => expect(mocks.fetchInventory).toHaveBeenCalledWith({ limit: 100 }))
    fireEvent.change(screen.getByLabelText('型号'), { target: { value: 'p-1' } })

    expect(screen.getByDisplayValue('提交后自动生成')).toBeTruthy()
    expect((screen.getByLabelText('厂家 SN（可选，可扫码）') as HTMLInputElement).disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('单件成本（元，可留空）'), { target: { value: '2850' } })
    mocks.recordOpening.mockResolvedValue({
      ok: true, status: 200,
      data: { operationId: 'req-op2', entityId: 'op-2', entityVersion: 1, summary: '期初建账 1 行 / 1 件' },
      meta: { requestId: 'req-op2', serverTime: '', contractVersion: 'v2' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存库存' }))

    await waitFor(() => expect(mocks.recordOpening).toHaveBeenCalledTimes(1))
    const payload = mocks.recordOpening.mock.calls[0][0]
    expect(payload.lines[0]).toEqual({ productRef: 'p-1', qty: 1, condition: 'new', unitCostCents: 285000 })
    expect('assetCode' in payload.lines[0]).toBe(false)
    expect('snRaw' in payload.lines[0]).toBe(false)
    // 全部行都填了金额 → 声明成本已知；这与服务端「声明已知却缺金额就拒」同向
    expect(payload.costBasis).toEqual({ kind: 'known' })
  })

  it('正式登记不需要开启窗口，编号和估值日期由系统补齐', async () => {
    const windowState = () => ({
      mode: 'formal' as const, status: 'not_started' as const, openedAt: null,
      closesAt: null, closedAt: null, closeReason: null,
    })
    mocks.fetchInventory.mockImplementation(async () => listPayload(WITH_COST, [], false, windowState()))
    mocks.recordOpening.mockResolvedValue({
      ok: true, status: 200,
      data: { operationId: 'req-formal-opening', entityId: 'open-1', entityVersion: 1, summary: '登记现有库存 2 件' },
      meta: { requestId: 'req-formal-opening', serverTime: '', contractVersion: 'v2' },
    })

    render(<WorkbenchInventoryPage permissions={['*']} />)
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    fireEvent.click(screen.getByRole('button', { name: '登记现有库存' }))
    await waitFor(() => expect(mocks.fetchInventory).toHaveBeenCalledWith({ limit: 100 }))
    fireEvent.change(screen.getByLabelText('型号'), { target: { value: 'p-1' } })
    fireEvent.change(screen.getByLabelText('单件成本（元，可留空）'), { target: { value: '1800' } })
    fireEvent.change(screen.getByLabelText('成本类型'), { target: { value: 'assessed_estimate' } })
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存库存' }))

    await waitFor(() => expect(mocks.recordOpening).toHaveBeenCalledTimes(1))
    const payload = mocks.recordOpening.mock.calls[0][0]
    expect(payload).not.toHaveProperty('costBasis')
    expect(payload.approvedCountRef).toMatch(/^existing-stock-/)
    expect(payload.lines[0]).toMatchObject({
      productRef: 'p-1', qty: 2, costBasis: 'assessed_estimate', unitCostCents: 180000,
    })
    expect(payload.lines[0].approvedCountLineRef).toMatch(/^line-/)
    expect(payload.lines[0].costAssessedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(mocks.openInventoryOpeningWindow).not.toHaveBeenCalled()
  })

  it('无需手工填写实盘编号，系统自动生成登记编号', async () => {
    mocks.recordOpening.mockResolvedValue({
      ok: true, status: 200,
      data: { operationId: 'req-auto-ref', entityId: 'open-auto', entityVersion: 1, summary: '登记现有库存 1 件' },
      meta: { requestId: 'req-auto-ref', serverTime: '', contractVersion: 'v2' },
    })
    renderPage()
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    fireEvent.click(screen.getByRole('button', { name: /现有库存/ }))
    await screen.findByLabelText('型号')
    fireEvent.change(screen.getByLabelText('型号'), { target: { value: 'p-1' } })
    fireEvent.click(screen.getByRole('button', { name: '保存库存' }))
    await waitFor(() => expect(mocks.recordOpening).toHaveBeenCalledTimes(1))
    expect(mocks.recordOpening.mock.calls[0][0].approvedCountRef).toMatch(/^existing-stock-/)
  })
})

describe('仓库操作日志', () => {
  it('默认折叠，库存可见成员点击后才能读取日志', async () => {
    mocks.fetchInventoryActivity.mockResolvedValue({
      ok: true, status: 200,
      data: {
        items: [{
          id: 'operation:7', kind: 'operation', occurredAt: '2026-09-26T01:02:00.000Z',
          actorUserId: 7, actorRole: 'member', action: 'B13', entityType: 'StockItem',
          entityId: 'item-7', productName: '影驰 RTX 4060 Ti 金属大师', qty: null,
          fromBucket: null, toBucket: null,
        }],
      },
      meta: { requestId: null, serverTime: '', contractVersion: 'v2' },
    })
    renderPage(['inventory/view'])
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    expect(mocks.fetchInventoryActivity).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /操作日志/ }).getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: /操作日志/ }))
    expect(await screen.findByText('现有库存登记')).toBeTruthy()
    expect(screen.getByText('员工账号 #7')).toBeTruthy()
    expect(mocks.fetchInventoryActivity).toHaveBeenCalledTimes(1)
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
    fireEvent.click(screen.getByRole('button', { name: '记录实盘数量' }))
    fireEvent.change(screen.getByLabelText('现场实盘数量'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('备注 / 批准原因'), { target: { value: '主板库存复核' } })
    fireEvent.click(screen.getByRole('button', { name: '保存实盘记录' }))

    expect(await screen.findByText(/实盘内容已保留/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查询结果' }))
    await screen.findByText(/后台查不到这个请求编号，可以重新提交/)
    fireEvent.click(screen.getByRole('button', { name: '保存实盘记录' }))

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

/** 可控挂起的读取：用来让响应「晚到」，验证过期响应不会覆盖新结果。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function lotItem(id: string, assetCode: string, productId: string, productName: string) {
  return {
    id, productId, productName, assetCode, remark: '', condition: 'used' as const,
    snRaw: null, snNormalized: null, ownership: 'store' as const,
    availability: 'available' as const, location: 'store' as const, activeReservationRef: null,
  }
}

describe('库存页 · 只读请求不重复、过期响应不覆盖', () => {
  it('连点已经生效的筛选项不再重复读取', async () => {
    renderPage()
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    expect(mocks.fetchInventory).toHaveBeenCalledTimes(1)

    // 默认「全部 / 全部成色」已经生效，再点它们没有改变任何状态，不该再读一次
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    fireEvent.click(screen.getByRole('button', { name: '全部成色' }))
    expect(mocks.fetchInventory).toHaveBeenCalledTimes(1)

    // 真正换了值才读；同一个值再点两次仍然不读
    fireEvent.click(screen.getByRole('button', { name: '可卖' }))
    await waitFor(() => expect(mocks.fetchInventory).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: '可卖' }))
    fireEvent.click(screen.getByRole('button', { name: '可卖' }))
    expect(mocks.fetchInventory).toHaveBeenCalledTimes(2)
    expect(mocks.fetchInventory).toHaveBeenLastCalledWith({
      q: undefined, availability: 'available', condition: undefined, limit: 50,
    })
  })

  it('首屏读取晚到时不能盖掉用户已经切好的筛选结果', async () => {
    const slowMount = deferred<ReturnType<typeof listPayload>>()
    const filtered = deferred<ReturnType<typeof listPayload>>()
    mocks.fetchInventory.mockImplementationOnce(() => slowMount.promise)
    render(<WorkbenchInventoryPage permissions={['*']} />)

    // 首屏还在读，用户已经切到「可卖」
    mocks.fetchInventory.mockImplementationOnce(() => filtered.promise)
    fireEvent.click(screen.getByRole('button', { name: '可卖' }))
    filtered.resolve(listPayload([row({ id: 'p-filtered', name: '筛选后的型号' })]))
    expect(await screen.findByText('筛选后的型号')).toBeTruthy()

    // 首屏那次现在才回来，且带着全量数据 —— 不能覆盖筛选结果，也不能把视图改成错误态
    slowMount.resolve(listPayload([row({ id: 'p-all', name: '未筛选的型号' })]))
    await waitFor(() => expect(mocks.fetchInventory).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('未筛选的型号')).toBeNull()
    expect(screen.getByText('筛选后的型号')).toBeTruthy()
    expect(screen.queryByText('库存没能加载出来')).toBeNull()
  })

  it('快速换行展开时，晚到的旧明细不能写到新展开的型号下面', async () => {
    const itemA = row({ id: 'p-a', name: '型号甲', trackingMode: 'item', requiresSn: true })
    const itemB = row({ id: 'p-b', name: '型号乙', trackingMode: 'item', requiresSn: true })
    mocks.fetchInventory.mockResolvedValue(listPayload([itemA, itemB]))
    render(<WorkbenchInventoryPage permissions={['*']} />)
    await screen.findByText('型号甲')

    const breakdownA = deferred<ReturnType<typeof listPayload>>()
    const breakdownB = deferred<ReturnType<typeof listPayload>>()
    mocks.fetchInventory.mockImplementation((filters: { productRef?: string } = {}) => {
      if (filters.productRef === 'p-a') return breakdownA.promise
      if (filters.productRef === 'p-b') return breakdownB.promise
      return Promise.resolve(listPayload([itemA, itemB]))
    })

    fireEvent.click(screen.getByRole('button', { name: /型号甲/ }))
    fireEvent.click(screen.getByRole('button', { name: /型号乙/ }))
    breakdownB.resolve(listPayload([itemB], [lotItem('si-b', 'U-B', 'p-b', '型号乙')]))
    expect(await screen.findByText('U-B')).toBeTruthy()

    // 旧明细（型号甲）现在才回来：展开的是型号乙，它不能把甲的数据写到乙下面
    breakdownA.resolve(listPayload([itemA], [lotItem('si-a', 'U-A', 'p-a', '型号甲')]))
    // 一共三次：首屏 1 次 + 两个型号各 1 次；旧响应回来不会再补发请求
    await waitFor(() => expect(mocks.fetchInventory).toHaveBeenCalledTimes(3))
    expect(screen.queryByText('U-A')).toBeNull()
    expect(screen.getByText('U-B')).toBeTruthy()
  })

  it('同一型号的明细还在路上时再展开，复用同一次读取而不是再发一条', async () => {
    const itemA = row({ id: 'p-a', name: '型号甲', trackingMode: 'item', requiresSn: true })
    mocks.fetchInventory.mockResolvedValue(listPayload([itemA]))
    render(<WorkbenchInventoryPage permissions={['*']} />)
    await screen.findByText('型号甲')
    expect(mocks.fetchInventory).toHaveBeenCalledTimes(1)

    const breakdown = deferred<ReturnType<typeof listPayload>>()
    mocks.fetchInventory.mockImplementation(() => breakdown.promise)
    // 展开 → 收起 → 再展开，全程不等明细回来（连点三次）
    fireEvent.click(screen.getByRole('button', { name: /型号甲/ }))
    fireEvent.click(screen.getByRole('button', { name: /型号甲/ }))
    fireEvent.click(screen.getByRole('button', { name: /型号甲/ }))
    expect(mocks.fetchInventory).toHaveBeenCalledTimes(2) // 首屏 1 次 + 明细 1 次（复用）

    breakdown.resolve(listPayload([itemA], [lotItem('si-a', 'U-A', 'p-a', '型号甲')]))
    expect(await screen.findByText('U-A')).toBeTruthy()
    // 明细回来之后条目已清掉：再次展开是全新读取，不会复用已经结束的请求
    fireEvent.click(screen.getByRole('button', { name: /型号甲/ }))
    fireEvent.click(screen.getByRole('button', { name: /型号甲/ }))
    await waitFor(() => expect(mocks.fetchInventory).toHaveBeenCalledTimes(3))
  })

  it('明细读取失败不会被当成缓存，再展开会重新请求', async () => {
    const itemA = row({ id: 'p-a', name: '型号甲', trackingMode: 'item', requiresSn: true })
    mocks.fetchInventory.mockResolvedValue(listPayload([itemA]))
    render(<WorkbenchInventoryPage permissions={['*']} />)
    await screen.findByText('型号甲')

    mocks.fetchInventory.mockResolvedValueOnce(failPayload('明细读取失败'))
    fireEvent.click(screen.getByRole('button', { name: /型号甲/ }))
    expect(await screen.findByText(/逐件实物没读出来/)).toBeTruthy()

    // 失败后条目必须已清除：再展开是一次新的请求，且能拿到数据
    mocks.fetchInventory.mockResolvedValue(listPayload([itemA], [lotItem('si-a', 'U-A', 'p-a', '型号甲')]))
    fireEvent.click(screen.getByRole('button', { name: /型号甲/ })) // 收起
    fireEvent.click(screen.getByRole('button', { name: /型号甲/ })) // 再展开
    expect(await screen.findByText('U-A')).toBeTruthy()
    expect(mocks.fetchInventory).toHaveBeenCalledTimes(3)
  })

  it('筛选读取失败进入错误态，重试带着当前筛选恢复', async () => {
    renderPage()
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    mocks.fetchInventory.mockResolvedValueOnce(failPayload('库存读取失败'))
    fireEvent.click(screen.getByRole('button', { name: '可卖' }))
    expect(await screen.findByText('库存没能加载出来')).toBeTruthy()

    mocks.fetchInventory.mockResolvedValue(listPayload(WITH_COST))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('影驰 RTX 4060 Ti 金属大师')).toBeTruthy()
    // 重试不能退回全量：筛选条件要跟着走
    expect(mocks.fetchInventory).toHaveBeenLastCalledWith({
      q: undefined, availability: 'available', condition: undefined, limit: 50,
    })
  })

  it('写入成功后按当前筛选重新读取列表，不把视图退回全量', async () => {
    mocks.saveProduct.mockResolvedValue({
      ok: true, status: 200,
      data: { operationId: 'req-new', entityId: 'p-new', entityVersion: 1, summary: '建立商品' },
      meta: { requestId: 'req-new', serverTime: '', contractVersion: 'v2' },
    })
    renderPage()
    await screen.findByText('影驰 RTX 4060 Ti 金属大师')
    fireEvent.click(screen.getByRole('button', { name: '可卖' }))
    await waitFor(() => expect(mocks.fetchInventory).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByRole('button', { name: '新增商品' }))
    fireEvent.change(screen.getByLabelText('商品名称'), { target: { value: '写入后刷新测试' } })
    fireEvent.change(screen.getByLabelText('分类'), { target: { value: '显卡' } })
    fireEvent.click(screen.getByRole('button', { name: '建立商品' }))

    await waitFor(() => expect(mocks.fetchInventory).toHaveBeenCalledTimes(3))
    expect(mocks.fetchInventory).toHaveBeenLastCalledWith({
      q: undefined, availability: 'available', condition: undefined, limit: 50,
    })
    expect(await screen.findByText(/已建立商品「写入后刷新测试」/)).toBeTruthy()
  })
})

/**
 * P06：写入之后的刷新与用户操作抢跑。
 *
 * 修复前的两个缺口：
 *   ① `reload()` 的闭包里存着「调用它时」展开的那一行；`await readList()` 期间用户换了行，
 *      它会拿**旧行**去刷新明细 —— 而 `loadBreakdown` 一进函数就推进代次，
 *      把用户**当前**那一行的在途响应一并作废：新行永远停在加载中，旧行的批次却写到它下面。
 *   ② 写入后的刷新会命中 `breakdownInflightRef` 里**写入之前**发出的那条明细请求，
 *      复用它等于拿回写入前的快照，刷新等于没做。
 *
 * 三条用例都让旧请求「延迟返回」，把抢跑窗口摆出来，而不是只断言最终画面。
 */
describe('库存页 · 写入期间换行 / 换筛选（P06）', () => {
  const itemA = row({ id: 'p-a', name: '型号甲', trackingMode: 'item', requiresSn: true })
  const itemB = row({ id: 'p-b', name: '型号乙', trackingMode: 'item', requiresSn: true })

  const SAVE_OK = {
    ok: true as const,
    status: 200,
    data: { operationId: 'req-new', entityId: 'p-new', entityVersion: 1, summary: '建立商品' },
    meta: { requestId: 'req-new', serverTime: '', contractVersion: 'v2' },
  }

  /** 走真实的建档表单提交，触发「写入成功 → reload()」这条路径。 */
  function submitNewProduct() {
    fireEvent.click(screen.getByRole('button', { name: '新增商品' }))
    fireEvent.change(screen.getByLabelText('商品名称'), { target: { value: '写入后刷新测试' } })
    fireEvent.change(screen.getByLabelText('分类'), { target: { value: '显卡' } })
    fireEvent.click(screen.getByRole('button', { name: '建立商品' }))
  }

  it('写入等待期间换行展开：旧行的刷新不能作废新行的明细，也不能写到新行下面', async () => {
    const breakdownA = deferred<ReturnType<typeof listPayload>>()
    const breakdownB = deferred<ReturnType<typeof listPayload>>()
    const afterWrite = deferred<ReturnType<typeof listPayload>>()
    let listCalls = 0

    mocks.saveProduct.mockResolvedValue(SAVE_OK)
    mocks.fetchInventory.mockImplementation((filters: { productRef?: string } = {}) => {
      if (filters.productRef === 'p-a') return breakdownA.promise
      if (filters.productRef === 'p-b') return breakdownB.promise
      listCalls += 1
      return listCalls === 1 ? Promise.resolve(listPayload([itemA, itemB])) : afterWrite.promise
    })

    render(<WorkbenchInventoryPage permissions={['*']} />)
    await screen.findByText('型号甲')

    // 先展开甲，明细读到就绪
    fireEvent.click(screen.getByRole('button', { name: /型号甲/ }))
    breakdownA.resolve(listPayload([itemA], [lotItem('si-a', 'U-A', 'p-a', '型号甲')]))
    expect(await screen.findByText('U-A')).toBeTruthy()

    // 写入：刷新列表的请求停在路上（首屏 1 + 甲明细 1 + 这次列表 1）
    submitNewProduct()
    await waitFor(() => expect(mocks.fetchInventory).toHaveBeenCalledTimes(3))

    // 刷新还没回来，用户换了行展开乙
    fireEvent.click(screen.getByRole('button', { name: /型号乙/ }))
    breakdownB.resolve(listPayload([itemB], [lotItem('si-b', 'U-B', 'p-b', '型号乙')]))
    expect(await screen.findByText('U-B')).toBeTruthy()

    // 写入后的列表刷新这时才回来：甲是「开始刷新时」展开的行，现在已经不是了
    const callsBefore = mocks.fetchInventory.mock.calls.length
    afterWrite.resolve(listPayload([itemA, itemB]))
    await new Promise((resolve) => setTimeout(resolve, 20))

    // 不该再补一次甲的明细：那会把用户正看着的乙顶成过期响应
    expect(mocks.fetchInventory.mock.calls.length).toBe(callsBefore)
    expect(screen.queryByText('U-A')).toBeNull()
    expect(screen.getByText('U-B')).toBeTruthy()
  })

  it('写入等待期间换筛选：这次刷新整条作废，明细不该再被刷一次', async () => {
    const breakdownA = deferred<ReturnType<typeof listPayload>>()
    const afterWrite = deferred<ReturnType<typeof listPayload>>()
    const filtered = deferred<ReturnType<typeof listPayload>>()
    let listCalls = 0

    mocks.saveProduct.mockResolvedValue(SAVE_OK)
    mocks.fetchInventory.mockImplementation(
      (filters: { productRef?: string; availability?: string } = {}) => {
        if (filters.productRef === 'p-a') return breakdownA.promise
        listCalls += 1
        if (listCalls === 1) return Promise.resolve(listPayload([itemA, itemB]))
        return filters.availability === 'available' ? filtered.promise : afterWrite.promise
      },
    )

    render(<WorkbenchInventoryPage permissions={['*']} />)
    await screen.findByText('型号甲')
    fireEvent.click(screen.getByRole('button', { name: /型号甲/ }))
    breakdownA.resolve(listPayload([itemA], [lotItem('si-a', 'U-A', 'p-a', '型号甲')]))
    expect(await screen.findByText('U-A')).toBeTruthy()

    // 写入后列表刷新在路上，用户又点了筛选：那之后这次的刷新结果已经不算数了
    submitNewProduct()
    await waitFor(() => expect(mocks.fetchInventory).toHaveBeenCalledTimes(3))
    fireEvent.click(screen.getByRole('button', { name: '可卖' }))

    afterWrite.resolve(listPayload([itemA, itemB]))
    filtered.resolve(listPayload([itemA, itemB]))
    await waitFor(() => expect(mocks.fetchInventory).toHaveBeenCalledTimes(4))

    // 第 4 次是用户那次筛选；作废的刷新不该再连带刷一次明细
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mocks.fetchInventory).toHaveBeenCalledTimes(4)
    expect(screen.getByText('U-A')).toBeTruthy()
  })

  it('写入后的刷新不复用写入前发出的明细请求，否则拿回的是写入前的快照', async () => {
    const stale = deferred<ReturnType<typeof listPayload>>()
    const fresh = deferred<ReturnType<typeof listPayload>>()
    let breakdownCalls = 0

    mocks.saveProduct.mockResolvedValue(SAVE_OK)
    mocks.fetchInventory.mockImplementation((filters: { productRef?: string } = {}) => {
      if (filters.productRef === 'p-a') {
        breakdownCalls += 1
        return breakdownCalls === 1 ? stale.promise : fresh.promise
      }
      return Promise.resolve(listPayload([itemA, itemB]))
    })

    render(<WorkbenchInventoryPage permissions={['*']} />)
    await screen.findByText('型号甲')

    // 展开甲：明细请求发出去，但一直不回来
    fireEvent.click(screen.getByRole('button', { name: /型号甲/ }))
    await waitFor(() => expect(breakdownCalls).toBe(1))

    // 明细还在路上就写入：刷新完成时必须**重新**读一次明细，而不是复用这条在途请求
    submitNewProduct()
    await waitFor(() => expect(breakdownCalls).toBe(2))

    // 写入前那条现在才回来：它是旧快照，不能显示
    stale.resolve(listPayload([itemA], [lotItem('si-stale', 'U-STALE', 'p-a', '型号甲')]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByText('U-STALE')).toBeNull()

    fresh.resolve(listPayload([itemA], [lotItem('si-fresh', 'U-FRESH', 'p-a', '型号甲')]))
    expect(await screen.findByText('U-FRESH')).toBeTruthy()
  })
})
