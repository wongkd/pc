/**
 * 顾客端（小程序）演示样本。
 *
 * 为什么单独一个文件：旧店员工作台样本已移除；当前顾客端样本单独维护
 * （待办、订单、库存 SN），字段与视角都是门店内部口径，顾客端用不上，
 * 混在一起会让两边互相牵连。顾客端只看「公开信息」，故独立成文件。
 *
 * ⚠️ 与契约的关系（务必看清，别踩坑）：
 * `contracts/v1` 目前**没有顾客端对象**（商城商品、案例、门店资料都未进契约）。
 * 本文件的类型是**界面展示用的视图类型**，不是契约对象，
 * **不得**把它当成契约字段的来源，也不得反向往契约里塞这些字段。
 * 契约里一旦出现顾客端对象，本文件应改为从生成物取数并删掉这里的定义。
 *
 * ⚠️ 数据真实性：全部为虚构样本，价格、案例、门店信息都不对应真实门店。
 * 照片是 `assets/workbench` 下的示意图，**不能充当具体实物或成色证据**
 * （AGENTS.md「资源说明」），故每条都带 `photoNote` 如实标注。
 *
 * ⚠️ 未接通的入口只说明、不返回假结果（02 与 AGENTS.md 的一贯要求）：
 * `onlineReady = false` 的入口一律引导电话 / 到店，不得做出「已提交」的假象。
 */

/** 顾客端运行状态说明。每页底部展示，如实说明数据来源与未接通范围。 */
export const CUSTOMER_RUNTIME_NOTE =
  '演示样本 · 门店资料与价格均为虚构 · 尚未接通在线下单与提交'

/** 门店资料（虚构）。真实资料将来由服务端下发，本文件只提供展示结构。 */
export const DEMO_STORE = {
  name: '装一下机',
  slogan: '装机、回收、维修，一台电脑的事都在这里办',
  address: '演示地址（待替换为真实门店地址）',
  phone: '演示号码（未接通）',
  hours: '10:00 - 20:00（演示营业时间）',
  notice: '到店前建议先联系，避免配件缺货白跑一趟。',
}

/** 首页模块。第四格经栋哥确认为「门店介绍 / 联系方式」。 */
export interface HomeEntry {
  key: string
  title: string
  desc: string
  /** 入口图标。复用现有 assets/ui 资源，未新增图标。 */
  icon: string
  /**
   * 该服务能否在线上自助完成。
   * false 表示必须当面沟通细节（如自带件装机要验件、委托装机要确认代买清单），
   * 线上只做引导，**不伪造提交成功**。
   */
  onlineReady: boolean
  /** 点击后的说明文案。onlineReady 为 false 时用作弹窗内容。 */
  hint: string
}

export const DEMO_HOME_ENTRIES: HomeEntry[] = [
  {
    key: 'build',
    title: '我要装机',
    desc: '新机、二手整机，按预算出配置单',
    icon: '/assets/ui/build-default.png',
    onlineReady: false,
    hint: '配置单要按你的预算和用途当场定，在线表单说不清。请先联系门店，到店或电话确认后再出单。',
  },
  {
    key: 'recycle',
    title: '回收置换',
    desc: '旧机、闲置配件估价回收或抵价',
    icon: '/assets/ui/recycle-default.png',
    onlineReady: false,
    hint: '回收价要看实机成色和配置，照片估不准。请带机器到店当面验机后报价。',
  },
  {
    key: 'repair',
    title: '预约维修',
    desc: '上门维修、送修检测、配件更换',
    icon: '/assets/ui/repair-default.png',
    onlineReady: false,
    hint: '维修要先判断故障再报价，线上直接下单容易误判。请先联系门店说明故障现象，约时间后再处理。',
  },
  {
    key: 'store',
    title: '门店与联系',
    desc: '地址、营业时间、一键拨号',
    icon: '/assets/ui/more-default.png',
    onlineReady: true,
    hint: '',
  },
]

/** 商城商品分类。与首页模块区分：商城只做「看得见价格就能问」的陈列。 */
export type ShopCategory = '整机' | '配件'

export interface ShopItem {
  id: string
  title: string
  category: ShopCategory
  /** 规格摘要。不写内部成本、供应商、SN 等任何非公开信息。 */
  spec: string
  /** 新品 / 二手。二手必须标出，不得与新品混在一个价位口径里。 */
  condition: '新品' | '二手'
  /** 分为单位。null 表示面议 —— 不得用 0 冒充「未知」。 */
  priceCents: number | null
  /** 库存展示口径。顾客只见「有没有」，不见具体数量与成本。 */
  stockText: string
  photoUrl: string
  /** 图片性质说明。示意图必须如实标注，不得让顾客以为是实拍。 */
  photoNote: string
}

export const DEMO_SHOP_ITEMS: ShopItem[] = [
  {
    id: 'shop-1',
    title: '家用办公整机',
    category: '整机',
    spec: '六核处理器 · 16G 内存 · 512G 固态',
    condition: '新品',
    priceCents: 328000,
    stockText: '有货',
    photoUrl: '/assets/workbench/tower.jpg',
    photoNote: '型号示意 · 非实物',
  },
  {
    id: 'shop-2',
    title: '游戏整机（二手）',
    category: '整机',
    spec: '八核处理器 · 32G 内存 · 独显 · 1T 固态',
    condition: '二手',
    priceCents: 468000,
    stockText: '仅 1 台',
    photoUrl: '/assets/workbench/tower.jpg',
    photoNote: '型号示意 · 非实物',
  },
  {
    id: 'shop-3',
    title: '轻薄笔记本（二手）',
    category: '整机',
    spec: '14 寸 · 16G 内存 · 512G 固态',
    condition: '二手',
    priceCents: null,
    stockText: '需当面验机',
    photoUrl: '/assets/workbench/laptop.jpg',
    photoNote: '型号示意 · 非实物',
  },
  {
    id: 'shop-4',
    title: '独立显卡',
    category: '配件',
    spec: '8G 显存 · 双风扇',
    condition: '新品',
    priceCents: 189000,
    stockText: '有货',
    photoUrl: '/assets/workbench/gpu.jpg',
    photoNote: '型号示意 · 非实物',
  },
  {
    id: 'shop-5',
    title: '27 寸显示器',
    category: '配件',
    spec: '2K · 高刷',
    condition: '新品',
    priceCents: 89000,
    stockText: '有货',
    photoUrl: '/assets/workbench/monitor.jpg',
    photoNote: '型号示意 · 非实物',
  },
  {
    id: 'shop-6',
    title: '内存条 16G',
    category: '配件',
    spec: '台式机 · 单条',
    condition: '二手',
    priceCents: 12000,
    stockText: '有货',
    photoUrl: '/assets/workbench/gpu.jpg',
    photoNote: '型号示意 · 非实物',
  },
]

/** 商城分类筛选。顺序固定：整机在前、配件在后。 */
export const DEMO_SHOP_CATEGORIES: ShopCategory[] = ['整机', '配件']

/**
 * 社区案例。
 *
 * ⚠️ 形态经栋哥 2026-09-19 确认为「**商家发、顾客只看**」：
 * 不提供发帖与评论入口，不落「社交-社区/论坛」类目，也不做 UGC 内容审核。
 * 将来若开放顾客发帖，必须先补类目资质与内容安全检测，那是另一张卡的事。
 */
export interface CommunityPost {
  id: string
  title: string
  summary: string
  coverUrl: string
  coverNote: string
  /** 展示用的发布日期文案。固定样本日期，不随当前时间漂移。 */
  publishedAt: string
  tag: string
}

export const DEMO_COMMUNITY_POSTS: CommunityPost[] = [
  {
    id: 'case-1',
    title: '三千出头的家用机，够用三年',
    summary: '客户预算 3500，主要给孩子上网课、自己办公。把钱压在内存和固态上，显卡用核显。',
    coverUrl: '/assets/workbench/tower.jpg',
    coverNote: '案例示意 · 非实拍',
    publishedAt: '2026-09-12',
    tag: '装机案例',
  },
  {
    id: 'case-2',
    title: '旧笔记本抵价换新，实付省了一半',
    summary: '客户拿一台五年前的旧本抵价，验机后按成色折抵，剩下的换了台新整机。',
    coverUrl: '/assets/workbench/laptop.jpg',
    coverNote: '案例示意 · 非实拍',
    publishedAt: '2026-09-08',
    tag: '回收置换',
  },
  {
    id: 'case-3',
    title: '上门修好一台不亮屏的主机',
    summary: '客户机器不通电，上门检测是电源故障，当场换件点亮，数据没动过。',
    coverUrl: '/assets/workbench/monitor.jpg',
    coverNote: '案例示意 · 非实拍',
    publishedAt: '2026-09-03',
    tag: '维修记录',
  },
]

/**
 * 「我的」页入口。
 *
 * 全部为**未接通**占位：真实订单 / 预约 / 售后进度要等后端接口（依赖 0006、0007
 * 迁移与顾客端接口），现在点开只说明状态，不显示伪造的订单数据。
 */
export interface MineEntry {
  key: string
  title: string
  desc: string
}

export const DEMO_MINE_ENTRIES: MineEntry[] = [
  { key: 'appointments', title: '我的预约', desc: '装机、维修、检测的预约记录' },
  { key: 'orders', title: '我的订单', desc: '已下单的整机与配件' },
  { key: 'recycle', title: '我的回收', desc: '回收估价与置换记录' },
  { key: 'service', title: '售后进度', desc: '送修与保修的处理进度' },
]

/**
 * 在线沟通入口。
 *
 * 经栋哥确认为「顾客 ↔ 门店」，走微信**客服消息**能力，不是用户之间的即时通信。
 * 客服消息无需额外类目，也不需要内容审核；若将来改成顾客之间互聊，
 * 那是即时通信，个体户主体基本拿不到，属另一条（且不建议走）的路。
 */
export const DEMO_CONTACT_ENTRY = {
  messageTitle: '消息',
  messageDesc: '有问题直接问门店',
  replyTitle: '回复',
  replyDesc: '查看门店给你的回复',
  hint: '客服消息尚未配置，配置后可直接在这里对话。当前阶段请先电话联系门店。',
}
