import { CUSTOMER_TABS, switchCustomerTab, syncCustomerTabSelection, type CustomerTabId } from '../features/customer/routes'

Component({
  data: {
    list: CUSTOMER_TABS.map((tab) => ({ ...tab, selected: false })),
    safeBottom: 0,
    selected: 0,
  },
  lifetimes: {
    attached() {
      let safeBottom = 0
      try {
        const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync()
        if (info.safeArea && Number.isFinite(info.safeArea.bottom) && Number.isFinite(info.screenHeight)) {
          safeBottom = Math.max(0, info.screenHeight - info.safeArea.bottom)
        }
      } catch {
        safeBottom = 0
      }
      this.setData({ safeBottom })
    },
  },
  methods: {
    onTabTap(event: WechatMiniprogram.TouchEvent) {
      const id = String(event.currentTarget.dataset.id ?? '') as CustomerTabId
      if (!CUSTOMER_TABS.some((tab) => tab.id === id)) return
      syncCustomerTabSelection(this, id)
      switchCustomerTab(id)
    },
  },
})
