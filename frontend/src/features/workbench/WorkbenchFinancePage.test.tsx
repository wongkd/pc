// @vitest-environment jsdom
/**
 * E09 · 账本页渲染与提交测试。
 *
 * 证明「页面按口径显示、按契约提交」，不证明后端行为（后端见
 * backend/tests/e09-cancel-return-refund-http.test.mjs）。重点：
 *   · 无 finance/view 权限时整块不可见；
 *   · 汇总卡、流水表、方向过滤照实渲染；
 *   · 反冲入口只在有 finance/reverse 权限且该分录不是反冲笔时出现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  fetchFinanceOverview: vi.fn(),
  fetchFinanceEntries: vi.fn(),
  reverseFinanceEntry: vi.fn(),
}))

vi.mock('./finance-api', () => ({
  fetchFinanceOverview: mocks.fetchFinanceOverview,
  fetchFinanceEntries: mocks.fetchFinanceEntries,
  reverseFinanceEntry: mocks.reverseFinanceEntry,
}))

import { WorkbenchFinancePage } from './WorkbenchFinancePage'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
})

const OVERVIEW = {
  cash: { inTotalCents: 300000, outTotalCents: 100000, netCents: 200000 },
  receivable: { orderCount: 1, totalCents: 100000, serviceCount: 1, serviceTotalCents: 30000 },
  payable: { purchaseCount: 2, totalCents: 50000 },
}

const ENTRIES = {
  entries: [
    {
      id: 'ce-in-1',
      direction: 'in' as const,
      amountCents: 300000,
      method: 'wechat',
      purpose: 'sale_order',
      counterpartyKind: 'customer',
      saleOrderId: 'o-1',
      occurredAt: '2026-09-21T12:00:00.000Z',
      verificationState: 'verified',
      remark: '定金',
      reversalOf: null,
    },
    {
      id: 'ce-out-1',
      direction: 'out' as const,
      amountCents: 100000,
      method: 'wechat',
      purpose: 'sale_order',
      counterpartyKind: 'customer',
      saleOrderId: 'o-1',
      occurredAt: '2026-09-21T13:00:00.000Z',
      verificationState: 'verified',
      remark: '反冲 ce-in-1',
      reversalOf: 'ce-in-1',
    },
  ],
  totals: { inTotalCents: 300000, outTotalCents: 100000 },
}

function mockReady() {
  mocks.fetchFinanceOverview.mockResolvedValue({ ok: true, data: OVERVIEW })
  mocks.fetchFinanceEntries.mockResolvedValue({ ok: true, data: ENTRIES })
}

describe('WorkbenchFinancePage', () => {
  it('无 finance/view 权限时整块不可见', async () => {
    mockReady()
    render(<WorkbenchFinancePage permissions={[]} />)
    expect(screen.getByText(/没有查看账本的权限/)).toBeTruthy()
    expect(mocks.fetchFinanceOverview).not.toHaveBeenCalled()
  })

  it('有权限时渲染汇总卡与流水表', async () => {
    mockReady()
    render(<WorkbenchFinancePage permissions={['finance/view']} />)
    await waitFor(() => {
      expect(screen.getByText('账本')).toBeTruthy()
    })
    // 汇总卡
    expect(screen.getByText('现金净额')).toBeTruthy()
    expect(screen.getByText('销售待收（1 单）')).toBeTruthy()
    expect(screen.getByText('维修待收（1 单）')).toBeTruthy()
    // 方向过滤按钮 + 表格方向标记（「流入」既是按钮又是表格标记）
    expect(screen.getByRole('button', { name: '流入' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '流出' })).toBeTruthy()
    expect(screen.getAllByText('流入').length).toBeGreaterThan(1)
    // 反冲笔标记（渲染为「 · 反冲笔」，用子串匹配）
    expect(screen.getByText(/反冲笔/)).toBeTruthy()
  })

  it('反冲入口只在有 finance/reverse 权限且非反冲笔时出现', async () => {
    mockReady()
    render(<WorkbenchFinancePage permissions={['finance/view', 'finance/reverse']} />)
    await waitFor(() => {
      expect(screen.getByText('账本')).toBeTruthy()
    })
    // 非反冲笔（ce-in-1）可反冲 → 反冲按钮数量 = 1
    const reverseButtons = screen.getAllByRole('button', { name: '反冲' })
    expect(reverseButtons.length).toBe(1)
  })

  it('无 finance/reverse 权限时不显示反冲按钮', async () => {
    mockReady()
    render(<WorkbenchFinancePage permissions={['finance/view']} />)
    await waitFor(() => {
      expect(screen.getByText('账本')).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: '反冲' })).toBeNull()
  })

  it('反冲提交走 reverseFinanceEntry', async () => {
    mockReady()
    mocks.reverseFinanceEntry.mockResolvedValue({
      ok: true,
      data: { operationId: 'op-1', entityId: 'ce-rev', entityVersion: 1, state: null, effects: {}, summary: '已反冲' },
    })
    render(<WorkbenchFinancePage permissions={['finance/view', 'finance/reverse']} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '反冲' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: '反冲' }))
    fireEvent.change(screen.getByPlaceholderText(/录错了/), { target: { value: '录错了，不是这单的收款' } })
    fireEvent.click(screen.getByRole('button', { name: '确认反冲' }))
    await waitFor(() => {
      expect(mocks.reverseFinanceEntry).toHaveBeenCalledWith('ce-in-1', '录错了，不是这单的收款')
    })
  })
})
