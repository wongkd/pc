// @vitest-environment jsdom
/**
 * T02a · 网页壳与工作台的渲染测试。
 *
 * 证明的是「页面上真的出现这些内容与状态」，不证明任何后端行为。
 * 尺寸、对比度等视觉验收不在这里，见验证记录的「未运行」清单。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { AppShell } from '../../app/AppShell'
import { WorkbenchTodayPage } from './WorkbenchTodayPage'
import type { Profile } from '../../utils/api'

afterEach(cleanup)

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

describe('AppShell 六导航', () => {
  it('顶栏只有六项，且为 01 §3 指定的名称', () => {
    renderShell()
    const nav = screen.getByRole('navigation', { name: '主导航' })
    const labels = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent)
    expect(labels).toEqual(['今天', '开单', '库存', '售后', '回收置换', '账本'])
  })

  it('当前页所在导航高亮，且只有一项', () => {
    renderShell()
    const active = within(screen.getByRole('navigation', { name: '主导航' }))
      .getAllByRole('link')
      .filter((link) => link.className.includes('is-active'))
    expect(active.map((link) => link.textContent)).toEqual(['今天'])
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

function renderWorkbench() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <WorkbenchTodayPage />
    </MemoryRouter>,
  )
}

function taskList() {
  return screen.getByRole('list', { name: '待办列表' })
}

function selectTask(entityId: string) {
  fireEvent.click(within(taskList()).getByText(entityId))
}

describe('今天工作台', () => {
  it('四项待办指标与待收款金额按样本显示', () => {
    renderWorkbench()
    expect(screen.getByRole('button', { name: /待交机/ }).textContent).toContain('2')
    expect(screen.getByRole('button', { name: /缺货订单/ }).textContent).toContain('2')
    expect(screen.getByRole('button', { name: /维修待办/ }).textContent).toContain('2')
    expect(screen.getByRole('button', { name: /待收款/ }).textContent).toContain('12,800.00')
  })

  it('默认列出全部七条，并在页面上标明是演示样本', () => {
    renderWorkbench()
    expect(screen.getByText('7 项')).toBeTruthy()
    expect(screen.getByText(/ID 前缀 DEMO-/)).toBeTruthy()
    expect(within(taskList()).getByText('DEMO-SO-003')).toBeTruthy()
  })

  it('指标点击即按类别筛选', () => {
    renderWorkbench()
    fireEvent.click(screen.getByRole('button', { name: /待交机/ }))
    expect(screen.getByText('2 项')).toBeTruthy()
    expect(within(taskList()).getByText('DEMO-SO-003')).toBeTruthy()
    expect(within(taskList()).queryByText('DEMO-SO-002')).toBeNull()
  })

  it('详情默认选中首条，禁用主动作显示阻断原因而不是只变灰', () => {
    renderWorkbench()
    const detail = screen.getByRole('article')
    expect(within(detail).getByText(/装机检查 2\/3 项完成；附件未打包/)).toBeTruthy()
    const primary = within(detail).getByRole('button', { name: '办理交付（先核对）' })
    expect((primary as HTMLButtonElement).disabled).toBe(true)
    expect(within(detail).getByText(/阻断：检查项 2\/3 完成/)).toBeTruthy()
  })

  it('未确认费用显示为预计，不当作确定应收', () => {
    renderWorkbench()
    fireEvent.click(screen.getByRole('button', { name: '维修' }))
    selectTask('DEMO-RE-006')
    const detail = screen.getByRole('article')
    expect(within(detail).getByText(/^预计 ¥480\.00$/)).toBeTruthy()
    expect(within(detail).queryByText(/^待收/)).toBeNull()
  })

  it('已结清单据显示已结清，不显示负尾款', () => {
    renderWorkbench()
    selectTask('DEMO-SO-011')
    const detail = screen.getByRole('article')
    expect(within(detail).getByText('已结清')).toBeTruthy()
  })

  it('筛选无结果时清空详情并给出清空入口', () => {
    renderWorkbench()
    fireEvent.change(screen.getByPlaceholderText('搜索单号 / 客户 / 设备'), {
      target: { value: '不存在的单号' },
    })
    expect(screen.getByText('当前筛选没有事项')).toBeTruthy()
    expect(screen.queryByRole('article')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '清空筛选' }))
    expect(screen.getByText('7 项')).toBeTruthy()
  })

  it('列表与设备看板是同一结果集', () => {
    renderWorkbench()
    fireEvent.click(screen.getByRole('tab', { name: '设备看板' }))
    expect(screen.getByText('7 项')).toBeTruthy()
    expect(within(taskList()).getByText('DEMO-TR-001')).toBeTruthy()
  })

  it('未接通的主动作只说明不提交', () => {
    renderWorkbench()
    selectTask('DEMO-SO-002')
    const detail = screen.getByRole('article')
    fireEvent.click(within(detail).getByRole('button', { name: '核对到货' }))
    expect(screen.getByRole('status').textContent).toContain('尚未接通')
    expect(screen.getByRole('status').textContent).toContain('未提交任何数据')
  })

  it('长文本不丢字段，设备名完整可读', () => {
    renderWorkbench()
    expect(screen.getAllByText(/白色设计主机 · 设计用装机/).length).toBeGreaterThan(0)
  })

  it('图片加载失败时保留设备名称与降级占位', () => {
    renderWorkbench()
    const detail = screen.getByRole('article')
    // jsdom 不加载资源，主动触发 error 验证本地图片丢失的降级路径。
    const img = detail.querySelector('.wb-device-photo img') as HTMLImageElement
    expect(img).toBeTruthy()
    fireEvent.error(img)
    expect(within(detail).getByText('未加载图片')).toBeTruthy()
    expect(within(detail).getByText('AI 示意 · 非实拍')).toBeTruthy()
    expect(within(detail).getByText('白色设计主机 · 设计用装机')).toBeTruthy()
    // 两个演示事项可以复用同一资源；切换后也必须重试加载。
    selectTask('DEMO-SO-002')
    expect(detail.querySelector('.wb-device-photo img')).toBeTruthy()
  })

  it('＋开单 只把已存在的入口放行，其余如实说明', () => {
    renderWorkbench()
    fireEvent.click(screen.getByRole('button', { name: '＋ 开单' }))
    expect(screen.getByRole('menuitem', { name: /装机报价/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: /配件零售/ }))
    expect(screen.getByRole('status').textContent).toContain('尚未接通')
  })

  it('详情提供跳转完整单据的入口', () => {
    renderWorkbench()
    expect(screen.getByRole('button', { name: '打开完整单据' })).toBeTruthy()
  })
})
