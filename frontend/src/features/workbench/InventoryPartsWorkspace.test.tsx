// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  fetchInventory: vi.fn(),
  fetchInventoryStockItems: vi.fn(),
  fetchStockItem: vi.fn(),
  saveProduct: vi.fn(),
  writeStockBackfill: vi.fn(),
  createStockBackfillReferences: vi.fn(),
  inspectQuarantinedItem: vi.fn(),
  recordInspectionRework: vi.fn(),
  queryOperationResult: vi.fn(),
}))

vi.mock('./inventory-api', () => ({
  fetchInventory: mocks.fetchInventory,
  fetchInventoryStockItems: mocks.fetchInventoryStockItems,
  fetchStockItem: mocks.fetchStockItem,
  saveProduct: mocks.saveProduct,
  writeStockBackfill: mocks.writeStockBackfill,
  createStockBackfillReferences: mocks.createStockBackfillReferences,
  inspectQuarantinedItem: mocks.inspectQuarantinedItem,
  recordInspectionRework: mocks.recordInspectionRework,
  queryOperationResult: mocks.queryOperationResult,
}))

import { WorkbenchInventoryPage } from './WorkbenchInventoryPage'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetchInventoryStockItems.mockResolvedValue({
    ok: true,
    data: {
      items: [],
      quantityProducts: [],
      filters: {},
      totals: { ownOnHandQty: 0, quantityTrackedQty: 0, itemCount: 0, availableQty: 0, reservedQty: 0, quarantineQty: 0 },
      categoryCounts: [],
      availabilityCounts: [],
      inspectionCounts: [],
      nextCursor: null,
      hasMore: false,
      quantityNextCursor: null,
      quantityHasMore: false,
    },
  })
  mocks.fetchInventory.mockResolvedValue({ ok: true, data: { items: [] } })
  mocks.createStockBackfillReferences.mockReturnValue({ batchRef: 'batch-1', lineRefs: ['line-1', 'line-2'] })
  mocks.saveProduct.mockResolvedValue({ ok: true, data: { entityId: 'product-new', summary: '型号资料已保存' } })
  mocks.writeStockBackfill.mockResolvedValue({ ok: true, data: { summary: '已登记' } })
})

describe('U03 配件仓库页面', () => {
  it('默认展示按类别找货的仓库入口，并从新读取接口取数', async () => {
    mocks.fetchInventoryStockItems.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [{
          id: 'item-1', version: 1, productId: 'cpu-1', productName: 'i5-12400F', category: 'CPU', brand: null,
          sku: null, assetCode: 'IT-001', remark: '散片', condition: 'used', availability: 'quarantine',
          inspectionStatus: 'pending', acquisitionCostCents: 43000, costKnown: true,
        }],
        quantityProducts: [],
        filters: {},
        totals: { ownOnHandQty: 1, quantityTrackedQty: 0, itemCount: 1, availableQty: 0, reservedQty: 0, quarantineQty: 1 },
        categoryCounts: [{ category: 'CPU', metrics: { ownOnHandQty: 1, quantityTrackedQty: 0, itemCount: 1, availableQty: 0, reservedQty: 0, quarantineQty: 1 } }],
        availabilityCounts: [],
        inspectionCounts: [{ inspectionStatus: 'pending', itemCount: 1 }],
        nextCursor: null,
        hasMore: false,
        quantityNextCursor: null,
        quantityHasMore: false,
      },
    })

    render(<WorkbenchInventoryPage permissions={['*']} />)

    expect(await screen.findByText('i5-12400F')).toBeTruthy()
    expect(screen.getByText('待检测')).toBeTruthy()
    expect(screen.getByRole('button', { name: '登记配件' })).toBeTruthy()
    expect(mocks.fetchInventoryStockItems).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }))
  })

  it('打开登记后聚焦表单，键盘焦点留在弹窗内，关闭后回到入口', async () => {
    render(<WorkbenchInventoryPage permissions={['*']} />)
    const trigger = await screen.findByRole('button', { name: '登记配件' })
    fireEvent.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: '登记配件' })
    const firstField = dialog.querySelector('select')
    const close = screen.getByRole('button', { name: '关闭' })
    const lastAction = screen.getByRole('button', { name: '稍后再登记' })
    expect(firstField).not.toBeNull()
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(firstField)

    lastAction.focus()
    fireEvent.keyDown(lastAction, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    close.focus()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(lastAction)

    fireEvent.click(close)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '登记配件' })).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it('在同一登记表单中建立型号并按件保留成色、成本和状况', async () => {
    render(<WorkbenchInventoryPage permissions={['*']} />)
    fireEvent.click(await screen.findByRole('button', { name: '登记配件' }))

    fireEvent.change(screen.getByLabelText('型号 / 规格'), { target: { value: 'i7-14700K' } })
    fireEvent.click(screen.getByRole('button', { name: '查找已登记型号' }))
    await screen.findByText('没有找到匹配型号，可直接建立资料。')
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '2' } })

    const costs = screen.getAllByLabelText('单件成本（元）')
    fireEvent.change(costs[0], { target: { value: '430' } })
    fireEvent.change(screen.getAllByLabelText('状况说明')[0], { target: { value: '散片' } })
    fireEvent.change(screen.getAllByLabelText('厂家编号（选填）')[1], { target: { value: 'CPU-002' } })

    fireEvent.click(screen.getByRole('button', { name: '建立型号并登记库存' }))

    await waitFor(() => expect(mocks.writeStockBackfill).toHaveBeenCalledTimes(1))
    expect(mocks.saveProduct).toHaveBeenCalledWith(expect.objectContaining({
      name: 'i7-14700K',
      category: 'CPU',
      brand: null,
      sku: null,
      trackingMode: 'item',
      requiresSn: false,
    }))
    const input = mocks.writeStockBackfill.mock.calls[0][0]
    expect(input.lines).toHaveLength(2)
    expect(input.lines[0]).toEqual(expect.objectContaining({
      productRef: 'product-new',
      qty: 1,
      condition: 'used',
      unitCostCents: 43000,
      costBasis: 'known_actual',
      remark: '散片',
    }))
    expect(input.lines[1]).toEqual(expect.objectContaining({ condition: 'used', snRaw: 'CPU-002', costBasis: 'unknown' }))
    expect(screen.getByText('已登记 2 件 CPU · i7-14700K')).toBeTruthy()
  })

  it('加载下一页时保留已经显示的逐件配件', async () => {
    const row = (id: string, assetCode: string, name: string) => ({
      id, version: 1, productId: 'cpu-1', productName: name, category: 'CPU', brand: null, sku: null,
      assetCode, remark: '', condition: 'used' as const, availability: 'quarantine' as const,
      inspectionStatus: 'pending' as const,
    })
    mocks.fetchInventoryStockItems
      .mockResolvedValueOnce({ ok: true, data: {
        items: [row('item-1', 'IT-001', 'i5-12400F')], quantityProducts: [], filters: {},
        totals: { ownOnHandQty: 2, quantityTrackedQty: 0, itemCount: 2, availableQty: 0, reservedQty: 0, quarantineQty: 2 },
        categoryCounts: [], availabilityCounts: [], inspectionCounts: [], nextCursor: 'item-next', hasMore: true,
        quantityNextCursor: null, quantityHasMore: false,
      } })
      .mockResolvedValueOnce({ ok: true, data: {
        items: [row('item-2', 'IT-002', 'i5-12400F')], quantityProducts: [], filters: {},
        totals: { ownOnHandQty: 2, quantityTrackedQty: 0, itemCount: 2, availableQty: 0, reservedQty: 0, quarantineQty: 2 },
        categoryCounts: [], availabilityCounts: [], inspectionCounts: [], nextCursor: null, hasMore: false,
        quantityNextCursor: null, quantityHasMore: false,
      } })

    render(<WorkbenchInventoryPage permissions={['*']} />)
    expect(await screen.findByRole('button', { name: /IT-001/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '更多逐件配件' }))

    expect(await screen.findByRole('button', { name: /IT-002/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /IT-001/ })).toBeTruthy()
  })

  it('B47 结果未知时按原请求号查询，不重复提交，并在确认后关闭表单', async () => {
    mocks.writeStockBackfill.mockResolvedValueOnce({ ok: false, unknownResult: true, requestId: 'backfill-request-1', message: '结果未知' })
    mocks.queryOperationResult.mockResolvedValueOnce({ status: 'succeeded', code: null, message: '已登记', resultRef: 'batch-1' })
    render(<WorkbenchInventoryPage permissions={['*']} />)
    fireEvent.click(await screen.findByRole('button', { name: '登记配件' }))
    fireEvent.change(screen.getByLabelText('型号 / 规格'), { target: { value: 'RTX 3060 12G' } })
    fireEvent.click(screen.getByRole('button', { name: '建立型号并登记库存' }))
    expect(await screen.findByRole('button', { name: '查询结果' })).toBeTruthy()
    expect((screen.getByLabelText('状况说明') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: '查询结果' }))

    await waitFor(() => expect(mocks.queryOperationResult).toHaveBeenCalledWith('backfill-request-1'))
    expect(mocks.writeStockBackfill).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '登记配件' })).toBeNull())
  })

  it('详情显示补录批次与行引用，已可售的历史未记录检测项仍可进入报价', async () => {
    const item = {
      id: 'used-item-7', version: 3, productId: 'cpu-7', productName: 'i5-12400F', category: 'CPU', brand: null,
      sku: null, assetCode: 'USED-007', remark: '', condition: 'used' as const, availability: 'available' as const,
      inspectionStatus: 'unrecorded' as const, acquisitionCostCents: 43000, costKnown: true,
    }
    mocks.fetchInventoryStockItems.mockResolvedValueOnce({ ok: true, data: {
      items: [item], quantityProducts: [], filters: {},
      totals: { ownOnHandQty: 1, quantityTrackedQty: 0, itemCount: 1, availableQty: 1, reservedQty: 0, quarantineQty: 0 },
      categoryCounts: [], availabilityCounts: [], inspectionCounts: [], nextCursor: null, hasMore: false,
      quantityNextCursor: null, quantityHasMore: false,
    } })
    mocks.fetchStockItem.mockResolvedValueOnce({ ok: true, data: {
      item, attachments: [], inspectionEvents: [],
      backfill: { id: 'backfill-1', batchRef: 'shelf-batch-3', lineRef: 'cpu-row-7', recordedAt: '2026-09-27T00:00:00.000Z' },
      sourceRecord: { kind: 'stock_backfill', recordId: 'backfill-1', displayCode: 'shelf-batch-3', occurredAt: null },
      recoveryState: null, product: { id: 'cpu-7', sku: null, name: 'i5-12400F', trackingMode: 'item' },
      activeReservation: null, acquisition: null, movements: [],
    } })

    render(<WorkbenchInventoryPage permissions={['*']} />)
    fireEvent.click(await screen.findByRole('button', { name: /USED-007/ }))

    expect(await screen.findByText('店里已有配件补录')).toBeTruthy()
    const sourceReferences = screen.getByText('查看来源编号').closest('details') as HTMLDetailsElement
    expect(sourceReferences.open).toBe(false)
    fireEvent.click(screen.getByText('查看来源编号'))
    expect(sourceReferences.open).toBe(true)
    expect(screen.getByText('shelf-batch-3')).toBeTruthy()
    expect(screen.getByText('cpu-row-7')).toBeTruthy()
    expect(screen.getByText('backfill-1')).toBeTruthy()
    expect(screen.getByRole('link', { name: '在报价中使用这件配件' }).getAttribute('href')).toBe('/sales/quotes?stockItemId=used-item-7&stockCode=USED-007')
    expect(screen.queryByText('下一步：完成检测后才能转为可售。')).toBeNull()
  })

  it('保存接口断开时保留型号和实物输入并给出可重试反馈', async () => {
    mocks.saveProduct.mockRejectedValueOnce(new Error('connection lost'))
    render(<WorkbenchInventoryPage permissions={['*']} />)
    fireEvent.click(await screen.findByRole('button', { name: '登记配件' }))
    fireEvent.change(screen.getByLabelText('型号 / 规格'), { target: { value: 'Ryzen 7 5700X' } })
    fireEvent.change(screen.getByLabelText('单件成本（元）'), { target: { value: '650' } })
    fireEvent.change(screen.getByLabelText('状况说明'), { target: { value: '风扇正常' } })
    fireEvent.click(screen.getByRole('button', { name: '建立型号并登记库存' }))

    expect(await screen.findByText('网络暂时不可用，登记内容已保留；如型号资料已保存，可继续登记库存。')).toBeTruthy()
    expect((screen.getByLabelText('型号 / 规格') as HTMLInputElement).value).toBe('Ryzen 7 5700X')
    expect((screen.getByLabelText('单件成本（元）') as HTMLInputElement).value).toBe('650')
    expect((screen.getByLabelText('状况说明') as HTMLInputElement).value).toBe('风扇正常')
    expect(mocks.writeStockBackfill).not.toHaveBeenCalled()
  })
})
