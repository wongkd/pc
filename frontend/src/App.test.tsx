// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import App from './App'

const mocks = vi.hoisted(() => ({ authenticated: true, fetchProfile: vi.fn(), fetchCurrentStore: vi.fn() }))
vi.mock('./utils/api', async importOriginal => ({
  ...await importOriginal<typeof import('./utils/api')>(),
  isLoggedIn: () => mocks.authenticated,
  ...Object.fromEntries(Object.entries(mocks).filter(([name]) => name !== 'authenticated')),
}))
vi.mock('./components/LoginPanel', () => ({ LoginPanel: ({ onLogin }: { onLogin: () => void }) => <button onClick={onLogin}>测试登录</button> }))
vi.mock('./features/workbench/WorkbenchTodayPage', () => ({ WorkbenchTodayPage: () => <h1>今天工作台</h1> }))
vi.mock('./features/workbench/WorkbenchFulfillmentPage', () => ({ WorkbenchFulfillmentPage: () => <h1>装机交付页面</h1> }))
vi.mock('./features/workbench/WorkbenchQuotePage', () => ({ default: () => <h1>新版装机报价页面</h1> }))
vi.mock('./features/workbench/WorkbenchSalesPage', () => ({ WorkbenchSalesPage: () => <h1>新版销售订单页面</h1> }))

function Location() { return <output data-testid="location">{useLocation().pathname}</output> }
function open(path: string) { return render(<MemoryRouter initialEntries={[path]}><App /><Location /></MemoryRouter>) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.authenticated = true
  mocks.fetchProfile.mockResolvedValue({ user: { id: 1, email: 'test' }, stores: [{ id: 1, name: '测试门店' }], currentStoreId: 1, memberId: 1, roles: ['owner'], permissions: ['*'] })
  mocks.fetchCurrentStore.mockResolvedValue({ id: 1, name: '测试门店', status: 'active' })
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('ERP 默认入口与旧工具收拢', () => {
  it('首页进入今天页，不注入旧打印规则', async () => {
    open('/')
    await screen.findByRole('heading', { name: '今天工作台' })
    expect(screen.getByTestId('location').textContent).toBe('/dashboard')
    expect(document.getElementById('print-orientation-style')).toBeNull()
  })
  it('登录后进入今天页', async () => {
    mocks.authenticated = false
    open('/')
    fireEvent.click(screen.getByRole('button', { name: '测试登录' }))
    await screen.findByRole('heading', { name: '今天工作台' })
    expect(screen.getByTestId('location').textContent).toBe('/dashboard')
  })
  it('旧装机深链进入已有交付功能', async () => {
    open('/assembly')
    await screen.findByRole('heading', { name: '装机交付页面' })
    expect(screen.getByTestId('location').textContent).toBe('/sales/fulfillment')
  })
  it('开单主页只展示当前业务入口', async () => {
    open('/sales')
    await screen.findByText('创建装机报价，处理销售收款、备料与交付。')
    expect(screen.queryByText(/这几刀还没做/)).toBeNull()
  })
  it('旧报价地址跳转到新版装机报价', async () => {
    open('/quotes')
    await screen.findByRole('heading', { name: '新版装机报价页面' })
    expect(screen.getByTestId('location').textContent).toBe('/sales/quotes')
  })
  it('打开新版 ERP 时删除旧报价的浏览器草稿和模板', async () => {
    localStorage.setItem('pc-quote-app', 'old draft')
    localStorage.setItem('pc-quote-app:merchant-templates', 'old templates')
    open('/')
    await screen.findByRole('heading', { name: '今天工作台' })
    expect(localStorage.getItem('pc-quote-app')).toBeNull()
    expect(localStorage.getItem('pc-quote-app:merchant-templates')).toBeNull()
  })
  it('旧订单地址跳转到新版销售订单', async () => {
    open('/orders')
    await screen.findByRole('heading', { name: '新版销售订单页面' })
    expect(screen.getByTestId('location').textContent).toBe('/sales/orders')
  })
})
