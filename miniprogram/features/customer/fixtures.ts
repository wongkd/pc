/**
 * 顾客端固定视觉样本（MP03）。全部内容仅供离线视觉演示，禁止真实模式回退到此处。
 * 价格以分保存；null 表示未知/面议，0 表示明确的零价。
 */
import type {
  CustomerCommunityPostView,
  CustomerHomeView,
  CustomerMineView,
  CustomerShopView,
} from '../../typings/customer-view'

export const CUSTOMER_DEMO_MODE = true as const
export const CUSTOMER_DEMO_DATE = '2026-03-12'
export const CUSTOMER_DEMO_RUNTIME_NOTE = '固定演示样本 · 门店、商品、价格与记录均为虚构 · 未接通在线服务'

export const CUSTOMER_DEMO_HOME: CustomerHomeView = {
  mode: 'demo',
  status: 'ready',
  store: { name: '广州天河旗舰店', address: '演示地址', phone: '演示号码' },
  brand: '装一下机',
  slogan: '不挣钱，交个朋友',
  featuredTitle: '极简白 · 高性能',
  featuredDescription: '一台让居家办公更舒服的主机',
  entries: ['我要装机', '回收置换', '预约维修', '门店与联系'],
  recommendation: '热门推荐',
}

export const CUSTOMER_DEMO_SHOP: CustomerShopView = {
  mode: 'demo',
  status: 'ready',
  activeCategory: '整机',
  categories: ['整机', '配件', '我的报价'],
  featuredTitle: '纯粹性能\n为热爱而生',
  items: [
    { id: 'demo-product-black', title: '高性能游戏主机', spec: 'i7 / RTX 4070 / 32G', priceCents: 799900, image: '/assets/customer/product-black-tower.jpg' },
    { id: 'demo-product-white', title: '全能工作主机', spec: 'R7 / 32G / 1T SSD', priceCents: 529900, image: '/assets/customer/product-white-tower.jpg' },
    { id: 'demo-product-gpu', title: '高端显卡', spec: 'RTX 4070 12G', priceCents: 479900, image: '/assets/customer/product-gpu.jpg' },
    { id: 'demo-product-monitor', title: '27 英寸 2K 显示器', spec: 'IPS / 180Hz', priceCents: 169900, image: '/assets/customer/product-monitor.jpg' },
  ],
}

export const CUSTOMER_DEMO_COMMUNITY: CustomerCommunityPostView = {
  mode: 'demo',
  status: 'ready',
  categories: ['装机案例', '电脑知识', '门店公告'],
  posts: [
    { id: 'demo-post-cream', title: '奶油风桌面装机分享', summary: '简约但不简单，属于自己的舒适角落。', date: '2026.03.12', image: '/assets/customer/post-cream-desk.jpg' },
    { id: 'demo-post-dark', title: '从入门到进阶：我的第一台游戏主机', summary: '一次装机，一份热爱。', date: '2026.03.08', image: '/assets/customer/post-dark-desk.jpg' },
    { id: 'demo-post-cooling', title: '电脑散热怎么选？', summary: '风冷还是水冷，按需选择就好。', date: '2026.03.01', image: '/assets/customer/post-cooling.jpg' },
  ],
}

export const CUSTOMER_DEMO_MINE: CustomerMineView = {
  mode: 'demo',
  status: 'ready',
  nickname: '装一下机用户',
  profileDescription: '装机生活更有趣',
  archiveTitle: '我的装机档案',
  counts: { quotes: 0, orders: 3, appointments: 1, recycling: 0 },
  entries: ['我的报价单', '我的订单', '服务预约', '售后进度'],
  storeEntry: '联系门店',
}

export function requireCustomerDemoMode(mode: string): void {
  if (mode !== 'demo') {
    throw new Error('顾客视觉样本仅允许在明确的 demo 模式载入；live 模式必须使用服务端 ViewModel。')
  }
}

/** 三种非成功态固定样本，避免页面把空数据与加载/错误混为一谈。 */
export const CUSTOMER_DEMO_STATES = {
  loading: { mode: 'demo', status: 'loading', title: '正在准备演示内容' },
  empty: { mode: 'demo', status: 'empty', title: '这里暂时没有内容' },
  error: { mode: 'demo', status: 'error', title: '演示内容暂时不可用', description: '请稍后重试' },
} as const
