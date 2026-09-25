/**
 * 网页端导航定义与旧深链映射。
 *
 * V2 将库存、采购到货、回收收件和 SN 台账归为一个「实物流转」工作区；
 * 业务深链保留，员工从配件结果回到同一组实物入口。
 *
 * 页面路径依据同目录 `02-ui-specification.md` §2 页面地图。
 * 本文件只描述导航与映射，不含业务权限判定（权限由服务端返回的 profile 决定）。
 */

export interface AppNavItem {
  /** 顶栏点击后的落点。 */
  path: string
  label: string
  /** 当前地址命中这些前缀时，本项高亮。 */
  matchPrefixes: string[]
  /** 该导航覆盖的页面 ID（02 §2），供核对用。 */
  pageIds: string[]
}

export const APP_NAV_ITEMS: AppNavItem[] = [
  { path: '/dashboard', label: '今天', matchPrefixes: ['/dashboard'], pageIds: ['P01'] },
  {
    path: '/sales',
    label: '开单',
    matchPrefixes: ['/sales'],
    pageIds: ['P03', 'P04', 'P05'],
  },
  {
    path: '/inventory',
    label: '实物流转',
    matchPrefixes: ['/inventory', '/sn', '/purchases', '/suppliers', '/recovery'],
    pageIds: ['P06', 'P07', 'P08', 'P11'],
  },
  { path: '/after-sales', label: '售后', matchPrefixes: ['/after-sales'], pageIds: ['P09', 'P10'] },
  { path: '/finance', label: '账本', matchPrefixes: ['/finance'], pageIds: ['P12'] },
]

/** 高频页面入口放在主导航下方；实物收发入口集中在配件台账页。 */
export const APP_QUICK_LINKS = [
  { path: '/sales/quotes', label: '装机报价' },
  { path: '/customers', label: '客户台账' },
] as const

/** 头像菜单里的入口（01 §3：设置不占顶栏）。 */
export const ACCOUNT_MENU_ITEMS = [
  { path: '/settings', label: '系统设置', description: '门店资料、成员与权限' },
] as const

export function findNavItemByPath(pathname: string): AppNavItem | undefined {
  return APP_NAV_ITEMS.find((item) =>
    item.matchPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)),
  )
}

/**
 * 旧深链映射 —— T02a 要求「保留旧深链映射说明」，这里是唯一出处。
 *
 * 处置含义：
 *   kept        路径与行为不变
 *   placeholder 仍是「后续阶段模块」占位页，等对应任务卡替换
 *   redirect    旧地址跳转已实现的正式页面
 *   account     入口从顶栏移入头像菜单，路径不变
 */
export type LegacyHandling = 'kept' | 'kept-editor' | 'placeholder' | 'account' | 'redirect'

export interface LegacyLink {
  legacy: string
  handling: LegacyHandling
  /** 收拢后的顶栏归属；空表示不占顶栏。 */
  nav: string
  /** 新方案里的目标页面 ID。 */
  pageIds: string[]
  note: string
}

export const LEGACY_DEEP_LINK_MAP: LegacyLink[] = [
  {
    legacy: '/dashboard',
    handling: 'kept',
    nav: '今天',
    pageIds: ['P01'],
    note: '旧「经营概览」即今天的落点，02 §2 已把 P01 定为 /dashboard。',
  },
  {
    legacy: '/quotes',
    handling: 'redirect',
    nav: '开单',
    pageIds: ['P04'],
    note: '旧报价工具已下线，旧地址跳转到新版 /sales/quotes。',
  },
  {
    legacy: '/orders',
    handling: 'redirect',
    nav: '开单',
    pageIds: ['P03'],
    note: '旧订单列表已收拢到新版 /sales/orders。',
  },
  {
    legacy: '/orders/:id',
    handling: 'redirect',
    nav: '开单',
    pageIds: ['P02'],
    note: '旧订单详情已收拢到新版 /sales/orders。',
  },
  {
    legacy: '/inventory',
    handling: 'kept',
    nav: '实物流转',
    pageIds: ['P06'],
    note: '型号与实物列表，按配件台账展示库存及来源流水。',
  },
  {
    legacy: '/sn',
    handling: 'kept',
    nav: '实物流转',
    pageIds: ['P07', 'P14'],
    note: 'SN 台账仍保留独立深链，在导航上归入实物流转。',
  },
  {
    legacy: '/purchases',
    handling: 'kept',
    nav: '实物流转',
    pageIds: ['P08'],
    note: '采购、到货、付款与取消保留来源单据，深链归入实物流转。',
  },
  {
    legacy: '/suppliers',
    handling: 'placeholder',
    nav: '实物流转',
    pageIds: [],
    note: '规格没有供应商独立页面 ID，暂留占位。',
  },
  {
    legacy: '/customers',
    handling: 'kept',
    nav: '常用页面',
    pageIds: ['P13'],
    note: '客户台账已有真实页面，通过主导航下方的常用页面入口访问。',
  },
  {
    legacy: '/assembly',
    handling: 'redirect',
    nav: '',
    pageIds: ['P02', 'P10'],
    note: '旧地址跳转 /sales/fulfillment，进入现有备料、检测与交付工作区。',
  },
  {
    legacy: '/after-sales',
    handling: 'kept',
    nav: '售后',
    pageIds: ['P09', 'P10'],
    note: 'T12 落地接修、检测、方案与归还。',
  },
  {
    legacy: '/finance',
    handling: 'kept',
    nav: '账本',
    pageIds: ['P12'],
    note: 'T15 落地收支、应收应付与冲销。',
  },
  {
    legacy: '/settings',
    handling: 'account',
    nav: '',
    pageIds: ['P15'],
    note: '按 01 §3 从顶栏移入头像菜单，路径与页面不变。',
  },
]
