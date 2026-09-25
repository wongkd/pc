/** 顾客社区：商家发布的只读公开内容，不提供顾客发帖、评论或点赞。 */
import { CUSTOMER_DEMO_COMMUNITY, CUSTOMER_DEMO_RUNTIME_NOTE, requireCustomerDemoMode } from '../../features/customer/fixtures'
import type { CustomerCommunityPostItemView } from '../../typings/customer-view'
import { syncCustomerTabSelection } from '../../features/customer/routes'

export type CommunityCategory = '装机案例' | '电脑知识' | '门店公告'
export interface CommunityItemView extends CustomerCommunityPostItemView {
  category: CommunityCategory
  layout: 'large' | 'compact' | 'horizontal'
  aspectRatio: number
}

const categoryList: CommunityCategory[] = ['装机案例', '电脑知识', '门店公告']
requireCustomerDemoMode('demo')
export const COMMUNITY_ITEMS: CommunityItemView[] = [
  { ...CUSTOMER_DEMO_COMMUNITY.posts[0], category: '装机案例', layout: 'large', aspectRatio: 1.407 },
  { ...CUSTOMER_DEMO_COMMUNITY.posts[1], category: '装机案例', layout: 'compact', aspectRatio: 2.39 },
  { ...CUSTOMER_DEMO_COMMUNITY.posts[2], category: '电脑知识', layout: 'horizontal', aspectRatio: 1.39 },
]

export function filterCommunityItems(items: CommunityItemView[], category: CommunityCategory): CommunityItemView[] {
  // 基准默认页展示两个案例及一条相关知识；知识/公告入口提供独立筛选。
  if (category === '装机案例') return items
  return items.filter((item) => item.category === category)
}

Page({
  data: {
    categories: categoryList,
    selectedCategory: '装机案例' as CommunityCategory,
    horizontalLayout: 'horizontal',
    posts: filterCommunityItems(COMMUNITY_ITEMS, '装机案例'),
    runtimeNote: CUSTOMER_DEMO_RUNTIME_NOTE,
  },

  onShow() {
    syncCustomerTabSelection(this.getTabBar(), 'community')
  },

  onCategoryTap(e: WechatMiniprogram.TouchEvent) {
    const category = String(e.currentTarget.dataset.category ?? '') as CommunityCategory
    if (!categoryList.includes(category)) return
    this.setData({ selectedCategory: category, posts: filterCommunityItems(COMMUNITY_ITEMS, category) })
  },

  onPostTap(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id ?? '')
    const post = COMMUNITY_ITEMS.find((item) => item.id === id)
    if (!post) return
    wx.showModal({ title: post.title, content: `${post.summary}\n\n内容详情暂未接入。`, showCancel: false, confirmText: '知道了' })
  },

})
