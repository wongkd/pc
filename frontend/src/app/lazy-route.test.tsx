// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { LazyRoute } from './lazy-route'

/**
 * P01：业务页面按需加载后的失败行为。
 *
 * 这里刻意不经过 App，直接测 LazyRoute —— 分包失败是它自己的职责，
 * 而且用真实会失败的加载器比 mock 整个页面模块更贴近线上现象。
 */
const chunk = vi.hoisted(() => ({ attempts: 0, failing: true }))

/** 必须写成模块级常量：LazyRoute 依赖加载器的引用稳定。 */
const loadPage = () => {
  chunk.attempts += 1
  return chunk.failing
    ? Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/page-abc.js'))
    : Promise.resolve({ default: () => <h1>业务页面</h1> })
}

/** 页面自身渲染报错的加载器：没有网络失败的特征文案。 */
const loadBrokenPage = () => Promise.reject(new Error('结算行缺少数量'))

const reload = vi.fn()

beforeEach(() => {
  chunk.attempts = 0
  chunk.failing = true
  reload.mockClear()
})

afterEach(cleanup)

describe('业务分包加载失败', () => {
  it('给出可读原因，并且只给真正有效的恢复入口（整页重载），不自动重试', async () => {
    render(<LazyRoute load={loadPage} label="仓库" props={{}} onReload={reload} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('这个页面没能打开')
    expect(alert.textContent).toContain('没有下载成功')
    expect(alert.textContent).toContain('Failed to fetch dynamically imported module')
    expect(screen.getByRole('button', { name: '重新载入页面' })).toBeTruthy()

    // 实测过：同一个文档里再 import 一次也不会重新下载，所以这里不该出现「重试」按钮。
    expect(screen.queryByRole('button', { name: '重试这个页面' })).toBeNull()

    // 等一段时间：实现里如果藏着自动重试/自动刷新，这里的次数会自己涨上去。
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(chunk.attempts).toBe(1)
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('点「重新载入页面」走整页重载，不再空点一次加载', async () => {
    render(<LazyRoute load={loadPage} label="仓库" props={{}} onReload={reload} />)
    await screen.findByRole('alert')

    fireEvent.click(screen.getByRole('button', { name: '重新载入页面' }))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(chunk.attempts).toBe(1)
  })

  it('页面自身渲染报错时不冒充网络问题，给出「渲染报错」说明', async () => {
    render(<LazyRoute load={loadBrokenPage} label="账本" props={{}} onReload={reload} />)

    const broken = await screen.findByRole('alert')
    expect(broken.textContent).toContain('渲染时报错')
    expect(broken.textContent).toContain('结算行缺少数量')
    expect(broken.textContent).not.toContain('没有下载成功')
    expect(screen.getByRole('button', { name: '重试这个页面' })).toBeTruthy()
  })

  it('渲染报错点重试会重新挂载页面并能恢复', async () => {
    let failNext = true
    const loadRecovering = () =>
      failNext ? Promise.reject(new Error('首次渲染就报错')) : Promise.resolve({ default: () => <h1>业务页面</h1> })
    render(<LazyRoute load={loadRecovering} label="账本" props={{}} onReload={reload} />)
    await screen.findByRole('alert')

    failNext = false
    fireEvent.click(screen.getByRole('button', { name: '重试这个页面' }))
    await screen.findByRole('heading', { name: '业务页面' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('加载中显示页面名，弱网下知道在等哪一页', () => {
    // 永不落地的加载器：这里要验的就是挂起期间的那句提示。
    const stillLoading = () => new Promise<never>(() => {})
    render(<LazyRoute load={stillLoading} label="采购到货" props={{}} onReload={reload} />)
    expect(screen.getByText('正在加载采购到货…')).toBeTruthy()
  })
})

/**
 * 换页与错误状态。
 *
 * 修复前的现象：`App.tsx` 里所有路由都写成同一位置、同一类型的 `<LazyRoute>`，
 * React 会**复用边界实例**、只替换 props —— `state.error` 就跟着留下来了。
 * 从一个加载失败的页面点导航去正常页面，新页面上顶着的仍是上一页的错误卡片，
 * 与提示里那句「也可以先从左边的导航去别的页面继续」直接矛盾。
 *
 * 这里走**真实路由**复现整条路径（而不是手改 props），因为「复用实例」正是
 * React Router 在同一位置渲染不同类型路由元素时的行为，直接改 props 测不出来。
 */
describe('换页清掉上一页的错误', () => {
  /** 模块级常量：LazyRoute 依赖加载器引用稳定。 */
  const loadFailing = () =>
    Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/inventory-abc.js'))
  const loadWorking = () => Promise.resolve({ default: () => <h1>正常页面</h1> })

  function Harness() {
    const navigate = useNavigate()
    return (
      <>
        <button type="button" onClick={() => navigate('/working')}>去正常页面</button>
        <button type="button" onClick={() => navigate('/broken')}>回仓库</button>
        <Routes>
          <Route path="/broken" element={<LazyRoute load={loadFailing} label="仓库" props={{}} onReload={reload} />} />
          <Route path="/working" element={<LazyRoute load={loadWorking} label="账本" props={{}} onReload={reload} />} />
        </Routes>
      </>
    )
  }

  it('失败的页面切走后，新页面正常渲染，不残留上一页的错误', async () => {
    render(
      <MemoryRouter initialEntries={['/broken']}>
        <Harness />
      </MemoryRouter>,
    )
    // 先确认真的是「带着错误过去」：否则这个用例会因为本来就没报过错而假通过。
    expect((await screen.findByRole('alert')).textContent).toContain('没有下载成功')

    fireEvent.click(screen.getByRole('button', { name: '去正常页面' }))

    await screen.findByRole('heading', { name: '正常页面' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('切回失败页会重新报错，清错误不等于把错误吞掉', async () => {
    render(
      <MemoryRouter initialEntries={['/broken']}>
        <Harness />
      </MemoryRouter>,
    )
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: '去正常页面' }))
    await screen.findByRole('heading', { name: '正常页面' })

    // 清掉的是「属于上一个页面的错误」，不是把报错能力关掉。
    fireEvent.click(screen.getByRole('button', { name: '回仓库' }))
    expect((await screen.findByRole('alert')).textContent).toContain('没有下载成功')
    expect(screen.queryByRole('heading', { name: '正常页面' })).toBeNull()
  })
})
