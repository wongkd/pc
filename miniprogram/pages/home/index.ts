import {
  CUSTOMER_DEMO_HOME,
  CUSTOMER_DEMO_MODE,
  CUSTOMER_DEMO_RUNTIME_NOTE,
  requireCustomerDemoMode,
} from '../../features/customer/fixtures'
import { switchCustomerTab, syncCustomerTabSelection } from '../../features/customer/routes'

type HomeEntryKey = 'build' | 'recycle' | 'repair' | 'store'

const HOME_ENTRIES = [
  { key: 'build' as const, title: '我要装机', icon: '/assets/customer/serviceBuild-muted.png' },
  { key: 'recycle' as const, title: '回收置换', icon: '/assets/customer/serviceRecycle-muted.png' },
  { key: 'repair' as const, title: '预约维修', icon: '/assets/customer/serviceRepair-muted.png' },
  { key: 'store' as const, title: '门店与联系', icon: '/assets/customer/serviceLocation-muted.png' },
]

requireCustomerDemoMode('demo')

Page({
  data: {
    store: CUSTOMER_DEMO_HOME.store,
    slogan: CUSTOMER_DEMO_HOME.slogan,
    featuredTitle: CUSTOMER_DEMO_HOME.featuredTitle,
    featuredDescription: CUSTOMER_DEMO_HOME.featuredDescription,
    heroImage: '/assets/customer/hero-home.jpg',
    bannerImage: '/assets/customer/banner-home.jpg',
    entries: HOME_ENTRIES,
    runtimeNote: CUSTOMER_DEMO_RUNTIME_NOTE,
    demoMode: CUSTOMER_DEMO_MODE,
  },

  onShow() {
    syncCustomerTabSelection(this.getTabBar(), 'home')
  },

  onEntryTap(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key ?? '') as HomeEntryKey
    const entry = HOME_ENTRIES.find((item) => item.key === key)
    if (!entry) return

    if (entry.key === 'store') {
      const store = CUSTOMER_DEMO_HOME.store
      wx.showModal({
        title: `${store.name}（演示资料）`,
        content: `地址：${store.address}\n电话：${store.phone}\n\n以上资料均为虚构；门店联系能力尚未接入。`,
        showCancel: false,
        confirmText: '知道了',
      })
      return
    }

    const hints: Record<Exclude<HomeEntryKey, 'store'>, string> = {
      build: '装机方案需要按预算和用途沟通。在线服务尚未接入，请先到店咨询。',
      recycle: '回收价格需要检查设备成色和配置。在线估价尚未接入，请带设备到店验机。',
      repair: '维修需要先判断故障再报价。预约服务尚未接入，请先联系门店说明情况。',
    }
    wx.showModal({ title: entry.title, content: hints[entry.key], showCancel: false, confirmText: '知道了' })
  },

  onRecommendationTap() {
    switchCustomerTab('shop', { shopCategory: '整机' })
  },
})
