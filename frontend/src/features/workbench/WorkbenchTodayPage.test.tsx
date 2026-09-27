// @vitest-environment jsdom
/**
 * T02a · 网页壳与工作台的渲染测试。
 *
 * 证明的是「页面上真的出现这些内容与状态」，不证明任何后端行为。
 * 尺寸、对比度等视觉验收不在这里，见验证记录的「未运行」清单。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

import { AppShell } from '../../app/AppShell'
import { findNavItemByPath } from '../../app/navigation'
import { WorkbenchTodayPage } from './WorkbenchTodayPage'
import type { Profile } from '../../utils/api'
import type { WorkbenchPayload, WorkbenchTask } from './workbench-api'

const { fetchWorkbenchMock } = vi.hoisted(() => ({ fetchWorkbenchMock: vi.fn() }))

vi.mock('./workbench-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workbench-api')>()
  return { ...actual, fetchWorkbench: fetchWorkbenchMock }
})

afterEach(cleanup)
beforeEach(() => fetchWorkbenchMock.mockReset())

const profile: Profile = {
  user: { id: 1, email: 'demo@example.com' },
  stores: [{ id: 1, name: '演示门店' }],
  currentStoreId: 1,
  memberId: 1,
  roles: ['owner'],
  permissions: ['*'],
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <AppShell
        profile={profile}
        currentStore={{ id: 1, name: '演示门店', status: 'active' }}
        onStoreSelect={() => {}}
        onLogout={() => {}}
        onChangePassword={() => {}}
      >
        <div>页面内容</div>
      </AppShell>
    </MemoryRouter>,
  )
}

describe('AppShell 主导航与常用页面', () => {
  it('将采购、回收与库存收拢到仓库，并提供报价与客户快捷入口', () => {
    renderShell()
    const nav = screen.getByRole('navigation', { name: '主导航' })
    const labels = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent)
    expect(labels).toEqual(['今天', '开单', '仓库', '售后', '商品', '账本', '装机报价', '客户台账'])
  })

  it('当前页所在导航高亮，且只有一项', () => {
    renderShell()
    const active = within(screen.getByRole('navigation', { name: '主导航' }))
      .getAllByRole('link')
      .filter((link) => link.className.includes('is-active'))
    expect(active.map((link) => link.textContent)).toEqual(['今天'])
  })

  it('回收、采购和库存深链归在同一仓库导航下', () => {
    expect(findNavItemByPath('/recovery/RO-1')?.label).toBe('仓库')
    expect(findNavItemByPath('/purchases/PO-1')?.label).toBe('仓库')
    expect(findNavItemByPath('/inventory')?.label).toBe('仓库')
  })

  it('设置不占顶栏，只在账号菜单里', () => {
    renderShell()
    const nav = screen.getByRole('navigation', { name: '主导航' })
    expect(within(nav).queryByText('系统设置')).toBeNull()

    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByRole('menuitem', { name: /系统设置/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '修改密码' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '退出登录' })).toBeTruthy()
  })

  it('Escape 关闭账号菜单', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('无平台权限的店员看不到系统设置入口（沿用旧壳门槛）', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <AppShell
          profile={{ ...profile, roles: ['staff'], permissions: ['sales/edit'] }}
          currentStore={{ id: 1, name: '演示门店', status: 'active' }}
          onStoreSelect={() => {}}
          onLogout={() => {}}
          onChangePassword={() => {}}
        >
          <div>页面内容</div>
        </AppShell>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.queryByRole('menuitem', { name: /系统设置/ })).toBeNull()
    expect(screen.getByRole('menuitem', { name: '修改密码' })).toBeTruthy()
  })

  it('全局搜索未接通时如实说明，不返回假结果', () => {
    renderShell()
    const search = screen.getByLabelText('全局搜索')
    fireEvent.change(search, { target: { value: 'U-017' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(screen.getByRole('status').textContent).toContain('全局搜索尚未接通')
    expect(screen.getByRole('status').textContent).toContain('U-017')
  })
})

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}{location.search}</output>
}

function renderWorkbench() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <>
        <WorkbenchTodayPage />
        <LocationProbe />
      </>
    </MemoryRouter>,
  )
}

function taskList() {
  return screen.getByRole('list', { name: '待办列表' })
}

function makeTask(overrides: Partial<WorkbenchTask> = {}): WorkbenchTask {
  return {
    taskId: 'sale_order:SO-2026-001',
    entityType: 'sale_order',
    entityId: 'SO-2026-001',
    entityVersion: 3,
    category: 'delivery',
    title: '装机交付 · SO-2026-001',
    customerDisplay: '李女士',
    deviceSummary: '白色设计主机',
    photoKind: 'delivery_evidence',
    photoUrl: null,
    dueAt: '2026-09-25T08:00:00Z',
    deadlineText: '今天 16:00 取机',
    blockerSummary: null,
    amountSummary: {
      totalCents: 628000,
      receivedCents: 200000,
      offsetCents: 0,
      balanceCents: 428000,
      balanceDirection: 'client_due',
      estimateCents: null,
      countsTowardReceivable: true,
      note: null,
    },
    primaryAction: { code: 'B06', label: '开始备料与装机', enabled: true, blockers: [] },
    detailTarget: '/sales/orders',
    ...overrides,
  }
}

function metrics(taskTotal = 1): WorkbenchPayload['metrics'] {
  return {
    pendingDelivery: { label: '待交机', value: 1, filterTarget: '/dashboard?category=delivery' },
    stockShortage: { label: '缺货订单', value: 0, filterTarget: '/dashboard?category=stock_shortage' },
    servicePending: { label: '维修待办', value: 0, filterTarget: '/dashboard?category=service' },
    receivable: { label: '待收款', valueCents: 428000, filterTarget: '/finance?view=receivable' },
    taskTotal: { label: '待办总数', value: taskTotal, filterTarget: '/dashboard' },
  }
}

function success(...tasks: WorkbenchTask[]) {
  return {
    ok: true,
    status: 200,
    data: {
      metrics: metrics(tasks.length),
      tasks,
      filters: { scope: 'open', limit: 200 },
      generatedAt: '2026-09-25T08:30:00.000Z',
    },
    meta: { requestId: 'req_workbench_001', serverTime: '2026-09-25T08:30:00.000Z', contractVersion: 'v1' },
  }
}

function failure(message = '工作台接口暂时不可用') {
  return {
    ok: false,
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
  }
}

describe('今天工作台（R02 接口响应）', () => {
  it('渲染 GET /api/v2/workbench 的业务指标与待办，不依赖 DEMO 样本', async () => {
    fetchWorkbenchMock.mockResolvedValue(success(makeTask()))
    renderWorkbench()
    expect(await screen.findByText('SO-2026-001')).toBeTruthy()
    expect(screen.getByRole('button', { name: /待交机/ }).textContent).toContain('1')
    expect(screen.getByRole('button', { name: /缺货订单/ }).textContent).toContain('0')
    expect(screen.getByRole('button', { name: /待收款/ }).textContent).toContain('4,280.00')
    expect(screen.getByText('1 项')).toBeTruthy()
    expect(screen.queryByText(/DEMO-/)).toBeNull()
    expect(fetchWorkbenchMock).toHaveBeenCalledTimes(1)
  })

  it('指标和文本搜索在同一接口结果集中筛选', async () => {
    const delivery = makeTask()
    const service = makeTask({
      taskId: 'service_order:SV-2026-002',
      entityType: 'service_order',
      entityId: 'SV-2026-002',
      category: 'service',
      title: '维修 · 显卡间歇黑屏',
      primaryAction: { code: 'B21', label: '录入检测与维修方案', enabled: true, blockers: [] },
      detailTarget: '/after-sales',
    })
    fetchWorkbenchMock.mockResolvedValue(success(delivery, service))
    renderWorkbench()
    expect(await screen.findByText('SV-2026-002')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /待交机/ }))
    expect(screen.getByText('1 项')).toBeTruthy()
    expect(within(taskList()).getByText('SO-2026-001')).toBeTruthy()
    expect(within(taskList()).queryByText('SV-2026-002')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('搜索单号 / 客户 / 设备'), {
      target: { value: '李女士' },
    })
    expect(screen.getByText('1 项')).toBeTruthy()
    expect(within(taskList()).getByText('SO-2026-001')).toBeTruthy()
  })

  it('空接口结果显示真实空态，金额指标仍按服务端响应显示', async () => {
    fetchWorkbenchMock.mockResolvedValue(success())
    renderWorkbench()
    expect(await screen.findByText('当前筛选没有事项')).toBeTruthy()
    expect(screen.queryByRole('article')).toBeNull()
    expect(screen.getByRole('button', { name: /待收款/ }).textContent).toContain('4,280.00')
  })

  it('保留接口提供的图片 URL；缺少附件时不伪造图片或实拍标注', async () => {
    fetchWorkbenchMock.mockResolvedValue(success(makeTask({ photoUrl: '/api/v2/attachments/att_123/download' })))
    renderWorkbench()
    await screen.findByText('SO-2026-001')
    const images = Array.from(document.querySelectorAll('.wb-device-photo img'))
    expect(images.length).toBeGreaterThan(0)
    expect(images.every((image) => image.getAttribute('src') === '/api/v2/attachments/att_123/download')).toBe(true)
    expect(screen.getByText('实物照片')).toBeTruthy()

    cleanup()
    fetchWorkbenchMock.mockResolvedValue(success(makeTask()))
    renderWorkbench()
    await screen.findByText('SO-2026-001')
    expect(document.querySelector('.wb-photo-placeholder')?.textContent).toContain('暂无图片')
    expect(document.querySelector('.wb-device-photo img')).toBeNull()
    expect(document.querySelector('.wb-device-photo figcaption')?.textContent).toBe('暂无附件')
  })

  it.each(['demo://photos/SO-2026-001.png', '/assets/workbench/tower.jpg'])(
    '接口误返演示素材地址 %s 时拒绝显示，明确标记素材已隔离',
    async (photoUrl) => {
      fetchWorkbenchMock.mockResolvedValue(success(makeTask({ photoUrl })))
      renderWorkbench()
      await screen.findByText('SO-2026-001')
      expect(document.querySelector('.wb-photo-placeholder')?.textContent).toContain('演示图片不可用于真实待办')
      expect(document.querySelector('.wb-device-photo img')).toBeNull()
      expect(document.querySelector('.wb-device-photo figcaption')?.textContent).toBe('演示素材已禁用')
    },
  )

  it('错误响应可重试，重试成功后显示新的接口快照', async () => {
    fetchWorkbenchMock
      .mockResolvedValueOnce(failure())
      .mockResolvedValueOnce(success(makeTask()))
    renderWorkbench()
    expect(await screen.findByText('工作台接口暂时不可用')).toBeTruthy()
    expect(screen.getByText('待办未能加载')).toBeTruthy()
    expect(screen.queryByText('当前筛选没有事项')).toBeNull()
    expect(within(screen.getByRole('button', { name: /待交机/ })).getByText('—')).toBeTruthy()
    expect(screen.queryByText('SO-2026-001')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('SO-2026-001')).toBeTruthy()
    expect(fetchWorkbenchMock).toHaveBeenCalledTimes(2)
  })

  it('网络层意外 reject 后仍退出加载态并可重试', async () => {
    fetchWorkbenchMock
      .mockRejectedValueOnce(new Error('连接被中断'))
      .mockResolvedValueOnce(success(makeTask()))
    renderWorkbench()
    expect(await screen.findByText('连接被中断')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('SO-2026-001')).toBeTruthy()
  })

  it.each([
    [makeTask(), '/sales/fulfillment?orderNo=SO-2026-001'],
    [makeTask({ category: 'stock_shortage', primaryAction: { code: 'B15', label: '登记到货入库', enabled: true, blockers: [] } }), '/inventory/purchases?sourceOrderNo=SO-2026-001'],
    [makeTask({ taskId: 'service_order:SV-2026-002', entityType: 'service_order', entityId: 'SV-2026-002', category: 'service', primaryAction: { code: 'B21', label: '录入检测与维修方案', enabled: true, blockers: [] }, detailTarget: '/after-sales' }), '/after-sales?orderNo=SV-2026-002'],
    [makeTask({ taskId: 'recovery_order:RC-2026-003', entityType: 'recovery_order', entityId: 'RC-2026-003', category: 'recovery', primaryAction: { code: 'B27', label: '验机与估价', enabled: true, blockers: [] }, detailTarget: '/recovery' }), '/recovery?orderNo=RC-2026-003'],
  ] as Array<[WorkbenchTask, string]>)('主动作打开对应业务工作区并带上单号', async (task, target) => {
    fetchWorkbenchMock.mockResolvedValue(success(task))
    renderWorkbench()
    expect(await screen.findByText(task.entityId)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: task.primaryAction.label }))
    expect(screen.getByTestId('location').textContent).toBe(target)
  })

  it('接口标记阻断时主动作禁用并显示服务端原因', async () => {
    const blocked = makeTask({
      primaryAction: {
        code: 'B10',
        label: '办理交付（先核对）',
        enabled: false,
        blockers: [{ code: 'VALIDATION_ERROR', message: '尾款还没结清', targetPage: '账本', targetField: null }],
      },
      blockerSummary: '尾款还没结清',
    })
    fetchWorkbenchMock.mockResolvedValue(success(blocked))
    renderWorkbench()
    expect(await screen.findByText('SO-2026-001')).toBeTruthy()
    const action = screen.getByRole('button', { name: '办理交付（先核对）' }) as HTMLButtonElement
    expect(action.disabled).toBe(true)
    expect(screen.getByText('阻断：尾款还没结清（去账本）')).toBeTruthy()
    expect(screen.getByTestId('location').textContent).toBe('/dashboard')
  })
})
