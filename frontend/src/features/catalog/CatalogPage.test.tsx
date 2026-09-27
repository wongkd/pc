// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CatalogPage } from './CatalogPage'
const api = vi.hoisted(() => ({ listCatalog: vi.fn(), saveCatalog: vi.fn(), uploadCatalogImage: vi.fn(), catalogImageUrl: vi.fn() }))
vi.mock('./catalog-api', () => api)
beforeEach(() => { vi.clearAllMocks(); api.listCatalog.mockResolvedValue({items:[],hasMore:false}) })
afterEach(cleanup)
it('保存失败显示原因并保留输入，相同内容重试沿用操作编号', async () => {
  api.saveCatalog.mockRejectedValueOnce(new Error('网络超时')).mockResolvedValueOnce({})
  render(<CatalogPage permissions={['*']} />)
  await screen.findByText(/还没有商城商品/)
  fireEvent.click(screen.getByText('新增商城商品'))
  fireEvent.change(screen.getByLabelText('商品名称'),{target:{value:'样本显卡'}})
  fireEvent.change(screen.getByLabelText('展示售价（元）'),{target:{value:'199.99'}})
  fireEvent.click(screen.getByText('保存草稿'))
  await screen.findByRole('alert')
  expect((screen.getByLabelText('商品名称') as HTMLInputElement).value).toBe('样本显卡')
  fireEvent.click(screen.getByText('保存草稿'))
  await screen.findByText('草稿已保存')
  expect(api.saveCatalog.mock.calls[0][0]).toEqual(api.saveCatalog.mock.calls[1][0])
  expect(api.saveCatalog.mock.calls[0][0].product.priceCents).toBe(19999)
})
it('上架缺图给出提示，图片尺寸说明随上传控件显示', async () => {
  render(<CatalogPage permissions={['*']} />)
  fireEvent.click(screen.getByText('新增商城商品'))
  fireEvent.change(screen.getByLabelText('商品名称'),{target:{value:'样本显卡'}})
  fireEvent.change(screen.getByLabelText('展示售价（元）'),{target:{value:'0'}})
  fireEvent.click(screen.getByText('上架到商城'))
  expect(screen.getByRole('alert').textContent).toContain('先上传商品列表图')
  expect(api.saveCatalog).not.toHaveBeenCalled()
  expect(screen.getByText(/输出 710 × 500px/)).toBeTruthy()
  expect(screen.getByText(/输出 572 × 500px/)).toBeTruthy()
})
it('只读成员无写入入口', async () => {
  render(<CatalogPage permissions={['library/view']} />)
  await screen.findByText(/还没有商城商品/)
  expect(screen.queryByText('新增商城商品')).toBeNull()
})
