/**
 * 网页端导航定义与旧深链映射。
 *
 * 六项顶栏的依据：`docs/plans/2026-09-17-web-wechat-plan/01-scope-and-architecture.md`
 * 第 41 行「电脑六项顶栏：今天、开单、库存、售后、回收置换、账本；设置置于头像菜单」。
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
    matchPrefixes: ['/sales', '/quotes', '/orders'],
    pageIds: ['P03', 'P04', 'P05'],
  },
  {
    path: '/inventory',
    label: '库存',
    matchPrefixes: ['/inventory', '/sn', '/purchases', '/suppliers'],
    pageIds: ['P06', 'P07', 'P08'],
  },
  { path: '/after-sales', label: '售后', matchPrefixes: ['/after-sales'], pageIds: ['P09', 'P10'] },
  { path: '/recovery', label: '回收置换', matchPrefixes: ['/recovery'], pageIds: ['P11'] },
  { path: '/finance', label: '账本', matchPrefixes: ['/finance'], pageIds: ['P12'] },
]

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
 *   kept-editor 路径不变，且必须继续渲染报价编辑器本体（已确认功能，不得改成重定向）
 *   placeholder 仍是「后续阶段模块」占位页，等对应任务卡替换
 *   account     入口从顶栏移入头像菜单，路径不变
 */
export type LegacyHandling = 'kept' | 'kept-editor' | 'placeholder' | 'account'

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
    handling: 'kept-editor',
    nav: '开单',
    pageIds: ['P04'],
    note: '当前是报价编辑器本体，必须在改造中继续可用；P04 的单据编辑路径 /quotes/:id/edit 归 T07。',
  },
  {
    legacy: '/orders',
    handling: 'kept',
    nav: '开单',
    pageIds: ['P03'],
    note: '02 §2 明确「旧 /orders、/quotes 保留兼容」，作为销售工作区入口。',
  },
  {
    legacy: '/orders/:id',
    handling: 'kept',
    nav: '开单',
    pageIds: ['P02'],
    note: '销售详情 / 处理页，T08c 替换其处理区。',
  },
  {
    legacy: '/inventory',
    handling: 'kept',
    nav: '库存',
    pageIds: ['P06'],
    note: '型号与实物列表，T05b 重建为库存表格 / 逐件视图。',
  },
  {
    legacy: '/sn',
    handling: 'kept',
    nav: '库存',
    pageIds: ['P07', 'P14'],
    note: 'SN 台账；规格未把 SN 单列为导航项，暂归库存，T05 收口是否并入实物详情。',
  },
  {
    legacy: '/purchases',
    handling: 'placeholder',
    nav: '库存',
    pageIds: ['P08'],
    note: 'P08 的采购 / 到货 / 盘点在 /inventory/receipts、/inventory/counts 下，T06 落地；本卡不做重定向，避免让占位入口凭空消失。',
  },
  {
    legacy: '/suppliers',
    handling: 'placeholder',
    nav: '库存',
    pageIds: [],
    note: '规格没有供应商独立页面 ID，暂留占位，归属待定。',
  },
  {
    legacy: '/customers',
    handling: 'placeholder',
    nav: '',
    pageIds: ['P13'],
    note: '客户与设备历史属 G2，T12 之后。',
  },
  {
    legacy: '/assembly',
    handling: 'placeholder',
    nav: '',
    pageIds: ['P02', 'P10'],
    note: '装机与交付并入销售详情处理区与交付动作，不再单独占导航。',
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
