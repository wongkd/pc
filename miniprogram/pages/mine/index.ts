/** 顾客个人页。登录、档案、统计和菜单都不伪造真实身份或记录。 */
import { CUSTOMER_RUNTIME_NOTE, DEMO_STORE } from '../../features/demo-customer'
import { syncCustomerTabSelection } from '../../features/customer/routes'

export interface MineStat { key: string; label: string; value: string }
export const MINE_STATS: MineStat[] = [
  { key: 'quotes', label: '报价', value: '—' },
  { key: 'orders', label: '订单', value: '—' },
  { key: 'appointments', label: '预约', value: '—' },
  { key: 'recycle', label: '回收', value: '—' },
]

const menuRows = [
  { key: 'quotes', title: '我的报价单', icon: '/assets/customer/menuQuote-active.png', desc: '查看门店为你准备的配置单' },
  { key: 'orders', title: '我的订单', icon: '/assets/customer/menuOrder-active.png', desc: '查看订单进度' },
  { key: 'appointments', title: '服务预约', icon: '/assets/customer/menuAppointment-active.png', desc: '查看装机、维修与检测预约' },
  { key: 'service', title: '售后进度', icon: '/assets/customer/menuAfterSales-active.png', desc: '查看送修与保修进度' },
]

Page({
  data: {
    store: DEMO_STORE,
    menuRows,
    stats: MINE_STATS,
    signedIn: false,
    runtimeNote: CUSTOMER_RUNTIME_NOTE,
    archiveCat: '/assets/customer/cat-archive-folder.png',
    footerCat: '/assets/customer/cat-gold-lounging.png',
    avatar: '/assets/customer/avatar-cat.png',
  },

  onShow() {
    syncCustomerTabSelection(this.getTabBar(), 'mine')
  },

  onLoginTap() {
    wx.showModal({ title: '顾客登录', content: '微信身份登录尚未接入。登录后才能读取你的装机档案与服务记录。', showCancel: false, confirmText: '知道了' })
  },

  onArchiveTap() {
    wx.showModal({ title: '我的装机档案', content: '装机档案需要登录后读取，目前没有可展示的个人记录。', showCancel: false, confirmText: '知道了' })
  },

  onStatTap(e: WechatMiniprogram.TouchEvent) {
    const label = String(e.currentTarget.dataset.label ?? '')
    if (!MINE_STATS.some((item) => item.label === label)) return
    wx.showModal({ title: `我的${label}`, content: '登录及顾客记录接口接通后，这里会展示你的真实记录。', showCancel: false, confirmText: '知道了' })
  },

  onMenuTap(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key ?? '')
    const row = menuRows.find((item) => item.key === key)
    if (!row) return
    wx.showModal({ title: row.title, content: `${row.desc}。顾客登录与记录接口尚未接入。`, showCancel: false, confirmText: '知道了' })
  },

  onStoreTap() {
    wx.showModal({ title: DEMO_STORE.name, content: `地址：${DEMO_STORE.address}\n营业时间：${DEMO_STORE.hours}\n电话：${DEMO_STORE.phone}`, showCancel: false, confirmText: '知道了' })
  },

  onNavAction(e: WechatMiniprogram.CustomEvent<{ action: string }>) {
    const action = e.detail.action
    wx.showModal({ title: action === 'qr' ? '门店二维码' : '设置', content: action === 'qr' ? '门店二维码尚未配置。' : '个人设置将在顾客登录接通后开放。', showCancel: false, confirmText: '知道了' })
  },

  onQrTap() {
    wx.showModal({ title: '门店二维码', content: '门店二维码尚未配置。', showCancel: false, confirmText: '知道了' })
  },

  onSettingsTap() {
    wx.showModal({ title: '设置', content: '个人设置将在顾客登录接通后开放。', showCancel: false, confirmText: '知道了' })
  },

  onImageError(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key ?? '')
    if (['avatar', 'archiveCat', 'footerCat'].includes(key)) this.setData({ [`${key}Failed`]: true })
  },
})
