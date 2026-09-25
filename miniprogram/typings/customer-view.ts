/** 顾客端展示模型，不是 API 契约；真实服务接入时必须显式映射并校验。 */
export type CustomerViewStatus = 'loading' | 'ready' | 'empty' | 'error'
export type CustomerDataMode = 'demo' | 'live'

export interface CustomerViewBase {
  mode: CustomerDataMode
  status: CustomerViewStatus
  errorMessage?: string
}

export interface CustomerStoreSummary {
  name: string
  address: string
  phone: string
}

export interface CustomerHomeView extends CustomerViewBase {
  store: CustomerStoreSummary
  brand: string
  slogan: string
  featuredTitle: string
  featuredDescription: string
  entries: string[]
  recommendation: string
}

export interface CustomerShopItemView {
  id: string
  title: string
  spec: string
  /** 分；null 是未知/面议，0 是明确的零价。 */
  priceCents: number | null
  image: string
}

export interface CustomerShopView extends CustomerViewBase {
  activeCategory: string
  categories: string[]
  featuredTitle: string
  items: CustomerShopItemView[]
}

export interface CustomerCommunityPostItemView {
  id: string
  title: string
  summary: string
  date: string
  image: string
}

export interface CustomerCommunityPostView extends CustomerViewBase {
  categories: string[]
  posts: CustomerCommunityPostItemView[]
}

export interface CustomerMineView extends CustomerViewBase {
  nickname: string
  profileDescription: string
  archiveTitle: string
  counts: { quotes: number; orders: number; appointments: number; recycling: number }
  entries: string[]
  storeEntry: string
}

export type CustomerNavigationAction = 'back' | 'store' | 'qr' | 'settings'

export interface CustomerNavigationLayout {
  statusBarHeight: number
  navigationHeight: number
  capsuleTop: number
  capsuleBottom: number
  capsuleRightInset: number
  capsuleWidth: number
  capsuleHeight: number
  leftInset: number
  rightInset: number
  contentHeight: number
}
