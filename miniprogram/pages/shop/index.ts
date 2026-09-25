import { formatYuan } from '../../features/amount-view'
import {
  CUSTOMER_DEMO_MODE,
  CUSTOMER_DEMO_RUNTIME_NOTE,
  CUSTOMER_DEMO_SHOP,
  requireCustomerDemoMode,
} from '../../features/customer/fixtures'
import { consumePendingShopCategory, syncCustomerTabSelection } from '../../features/customer/routes'

type ShopCategory = '整机' | '配件' | '我的报价'
interface ShopProductView {
  id: string
  title: string
  spec: string
  priceText: string
  image: string
  actionLabel: string
  available: boolean
}

function priceLabel(cents: number | null): string {
  if (cents === null) return '面议'
  const formatted = formatYuan(cents)
  return formatted.endsWith('.00') ? formatted.slice(0, -3) : formatted
}

const CATEGORIES: { key: ShopCategory; label: string }[] = [
  { key: '整机', label: '整机' },
  { key: '配件', label: '配件' },
  { key: '我的报价', label: '我的报价' },
]
const PRODUCTS: ShopProductView[] = CUSTOMER_DEMO_SHOP.items.map((item) => ({
  id: item.id,
  title: item.title,
  spec: item.spec,
  priceText: priceLabel(item.priceCents),
  image: item.image,
  actionLabel: item.id.includes('gpu') || item.id.includes('monitor') ? '查看详情' : '选配置',
  available: true,
}))
const ACCESSORY_IDS = new Set(['demo-product-gpu', 'demo-product-monitor'])

requireCustomerDemoMode('demo')

function validCategory(value: string | null): value is ShopCategory {
  return CATEGORIES.some((item) => item.key === value)
}

function productsFor(category: ShopCategory): ShopProductView[] {
  if (category === '配件') return PRODUCTS.filter((item) => ACCESSORY_IDS.has(item.id))
  // 首页效果图中的热门推荐固定混合整机、显卡和显示器。
  return PRODUCTS
}

Page({
  data: {
    categories: CATEGORIES,
    activeCategory: '整机' as ShopCategory,
    items: productsFor('整机'),
    heroImage: '/assets/customer/hero-shop.jpg',
    featuredTitle: CUSTOMER_DEMO_SHOP.featuredTitle,
    demoMode: CUSTOMER_DEMO_MODE,
    runtimeNote: CUSTOMER_DEMO_RUNTIME_NOTE,
  },

  onLoad() {
    const pending = consumePendingShopCategory()
    if (validCategory(pending)) this.selectCategory(pending)
  },

  onShow() {
    syncCustomerTabSelection(this.getTabBar(), 'shop')
    const pending = consumePendingShopCategory()
    if (validCategory(pending)) this.selectCategory(pending)
  },

  selectCategory(category: ShopCategory) {
    this.setData({ activeCategory: category, items: productsFor(category) })
  },

  onCategoryTap(e: WechatMiniprogram.TouchEvent) {
    const category = String(e.currentTarget.dataset.key ?? '')
    if (validCategory(category)) this.selectCategory(category)
  },

  onChooseConfig() {
    wx.showModal({
      title: '配置服务尚未接入',
      content: '当前页面是视觉演示样本，在线选配与提交功能尚未开通。请联系门店沟通预算和用途。',
      showCancel: false,
      confirmText: '知道了',
    })
  },

  onItemTap(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id ?? '')
    const item = PRODUCTS.find((product) => product.id === id)
    if (!item) return
    if (!item.available) {
      wx.showModal({ title: '商品暂停售卖', content: '该商品当前不可购买，请联系门店了解后续安排。', showCancel: false, confirmText: '知道了' })
      return
    }
    wx.showModal({
      title: item.title,
      content: `公开商品编号：${item.id}\n${item.spec}\n${item.priceText}\n\n商品详情服务尚未接入，图像和价格均为虚构演示。`,
      showCancel: false,
      confirmText: '知道了',
    })
  },

  onProductAction(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id ?? '')
    const item = PRODUCTS.find((product) => product.id === id)
    if (!item) return
    if (!item.available) return
    if (ACCESSORY_IDS.has(item.id)) {
      wx.showModal({
        title: '商品详情尚未接入',
        content: '当前无法在线查看实物详情，请联系门店确认型号与状态。',
        showCancel: false,
        confirmText: '知道了',
      })
      return
    }
    this.onChooseConfig()
  },
})
