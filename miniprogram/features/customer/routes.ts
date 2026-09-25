/** 顾客端可达路由；员工页保持注册但禁止从顾客路由助手进入。 */
export const CUSTOMER_TABS = [
  { id: 'home', title: '首页', pagePath: 'pages/home/index', icon: 'tabHome' },
  { id: 'shop', title: '商城', pagePath: 'pages/shop/index', icon: 'tabShop' },
  { id: 'community', title: '社区', pagePath: 'pages/community/index', icon: 'tabCommunity' },
  { id: 'mine', title: '我的', pagePath: 'pages/mine/index', icon: 'tabMine' },
] as const

export type CustomerTabId = (typeof CUSTOMER_TABS)[number]['id']
export type CustomerTabPath = (typeof CUSTOMER_TABS)[number]['pagePath']

let pendingShopCategory: string | null = null

export function customerTabIndex(pagePath: string): number {
  return CUSTOMER_TABS.findIndex((tab) => tab.pagePath === pagePath.replace(/^\//, ''))
}

export function shouldSwitchCustomerTab(currentIndex: number, targetId: CustomerTabId): boolean {
  const targetIndex = CUSTOMER_TABS.findIndex((tab) => tab.id === targetId)
  return targetIndex >= 0 && targetIndex !== currentIndex
}

/** 页面 onShow 显式同步底栏，避免组件 show 回调读取到切换前的页面栈。 */
export function syncCustomerTabSelection(tabBar: Pick<WechatMiniprogram.Component.TrivialInstance, 'setData'> | undefined, id: CustomerTabId): void {
  if (!tabBar) return
  const selected = CUSTOMER_TABS.findIndex((tab) => tab.id === id)
  if (selected < 0) return
  tabBar.setData({ selected, list: CUSTOMER_TABS.map((tab, index) => ({ ...tab, selected: index === selected })) })
}

/** 保存 tab 页面状态，再使用 switchTab。小程序 tab 路由不承载详情页 query。 */
export function switchCustomerTab(tab: CustomerTabId, state?: { shopCategory?: string }): void {
  const target = CUSTOMER_TABS.find((item) => item.id === tab)
  if (!target) throw new Error('未知的顾客 Tab')
  pendingShopCategory = tab === 'shop' ? state?.shopCategory ?? null : null
  wx.switchTab({ url: `/${target.pagePath}` })
}

/** 只开放顾客分包详情；拒绝把旧员工页作为顾客导航目标。 */
export function navigateCustomerDetail(path: string): void {
  const normalized = path.replace(/^\//, '').split('?')[0]
  if (!normalized.startsWith('packages/customer/') || normalized.includes('..')) {
    throw new Error('顾客详情只能进入 packages/customer 下的页面')
  }
  wx.navigateTo({ url: path.startsWith('/') ? path : `/${path}` })
}

export function consumePendingShopCategory(): string | null {
  const category = pendingShopCategory
  pendingShopCategory = null
  return category
}
