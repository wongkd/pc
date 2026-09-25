import { getCustomerNavigationLayout, getCustomerPageRightInset } from '../../features/customer/layout'
import type { CustomerNavigationLayout } from '../../typings/customer-view'

type SystemInfoWithSafeArea = WechatMiniprogram.WindowInfo

Component({
  options: { styleIsolation: 'apply-shared', multipleSlots: true },
  properties: {
    title: { type: String, value: '' },
    storeLine: { type: String, value: '' },
    showBack: { type: Boolean, value: false },
    backFallback: { type: String, value: '' },
    rightAction: { type: String, value: '' },
    mineActions: { type: Boolean, value: false },
  },
  data: {
    layout: null as CustomerNavigationLayout | null,
    rightContentInset: 0,
    hasPage: false,
  },
  lifetimes: {
    attached() {
      this.measureLayout()
      this.setData({ hasPage: getCurrentPages().length > 1 })
    },
  },
  methods: {
    measureLayout() {
      let system: Partial<SystemInfoWithSafeArea> = {}
      try {
        if (typeof wx.getWindowInfo === 'function') system = wx.getWindowInfo()
        else system = wx.getSystemInfoSync()
      } catch {
        system = {}
      }

      let capsule: ReturnType<typeof wx.getMenuButtonBoundingClientRect> | undefined
      try {
        if (typeof wx.getMenuButtonBoundingClientRect === 'function') {
          capsule = wx.getMenuButtonBoundingClientRect()
        }
      } catch {
        capsule = undefined
      }

      const layout = getCustomerNavigationLayout(system, capsule ?? {}, this.data.mineActions)
      this.setData({ layout, rightContentInset: getCustomerPageRightInset(layout) })
    },
    onBackTap() {
      if (getCurrentPages().length > 1) {
        wx.navigateBack({ delta: 1 })
        return
      }
      const fallback = this.properties.backFallback
      if (fallback) wx.switchTab({ url: fallback })
    },
    onRightActionTap() {
      const action = this.properties.rightAction
      if (!action) return
      this.triggerEvent('action', { action })
    },
    onQrTap() {
      this.triggerEvent('action', { action: 'qr' })
    },
    onSettingsTap() {
      this.triggerEvent('action', { action: 'settings' })
    },
  },
})
