/**
 * T02b · 今天页（原生小程序列表页）。
 *
 * 结构依据 02 §4「今天页」：品牌和开单 → 四项统计 → 待办标题 / 视图
 * → 搜索与扫码 → 事项筛选 → 竖向列表。
 *
 * 本卡只做壳：所有数据来自 `features/demo-data.ts` 的虚构样本，
 * 不连接门店服务、不提交任何业务数据。未接通的入口只说明，不返回假结果。
 *
 * 「返回和跨端状态」（02 §4）：本页刻意**不在 onShow 重置任何状态**。
 * 小程序在 navigateTo 返回与 switchTab 切回时复用同一页面实例，滚动位置由框架保留；
 * 只要不 setData 覆盖筛选与列表，返回后自然回到原位置。见 onShow 注释。
 */
import { AttachmentPurpose } from '../../contracts/generated/enums'
import {
  DEMO_METRICS,
  DEMO_RUNTIME_NOTE,
  DEMO_TASKS,
  TASK_CATEGORY_LABELS,
  isOverdueTask,
  sortTasksForDemo,
} from '../../features/demo-data'
import type { WorkbenchTask } from '../../features/demo-data'
import { describeAction, describeAmount, formatYuan } from '../../features/amount-view'

/** 缩略图缺失或加载失败时的降级文案（02 §6 DeviceSummary：不暴露内部图片）。 */
const PHOTO_KIND_LABELS: Record<AttachmentPurpose, string> = {
  [AttachmentPurpose.PRODUCT_REFERENCE]: '型号示意',
  [AttachmentPurpose.SERVICE_INTAKE]: '接修照片',
  [AttachmentPurpose.RECOVERY_EVIDENCE]: '回收照片',
  [AttachmentPurpose.DELIVERY_EVIDENCE]: '交付照片',
}

interface MetricView {
  key: string
  label: string
  value: string
  /** 为 null 表示该指标在骨架阶段没有可跳转的落点，只解释口径。 */
  filter: string | null
}

interface FilterView {
  key: string
  label: string
}

export interface TaskRowView {
  taskId: string
  entityId: string
  title: string
  customer: string
  device: string
  deadlineText: string
  isOverdue: boolean
  photoLabel: string
  hasPhoto: boolean
  photoUrl: string
  photoBroken: boolean
  blockerSummary: string
  amountPrimary: string
  amountDirection: string
  actionLabel: string
  actionEnabled: boolean
  blockerText: string
}

/** 四项统计。02 §4：窄屏下允许两行两列，不把大金额压到不可读。 */
const METRICS: MetricView[] = [
  { key: 'delivery', label: '待交机', value: String(DEMO_METRICS.pendingDelivery), filter: 'delivery' },
  {
    key: 'stock_shortage',
    label: '缺货订单',
    value: String(DEMO_METRICS.stockShortage),
    filter: 'stock_shortage',
  },
  { key: 'service', label: '维修待办', value: String(DEMO_METRICS.servicePending), filter: 'service' },
  {
    key: 'receivable',
    label: '待收款',
    value: formatYuan(DEMO_METRICS.receivableCents),
    filter: null,
  },
]

/** 事项筛选。02 §3 的列表筛选为「全部 / 交付 / 缺货 / 维修 / 回收」，不含「待收款」。 */
const FILTERS: FilterView[] = [
  { key: 'all', label: '全部' },
  { key: 'delivery', label: TASK_CATEGORY_LABELS.delivery },
  { key: 'stock_shortage', label: TASK_CATEGORY_LABELS.stock_shortage },
  { key: 'service', label: TASK_CATEGORY_LABELS.service },
  { key: 'recovery', label: TASK_CATEGORY_LABELS.recovery },
]

/**
 * 列表分组标题。
 *
 * 设计稿写「今日待处理 · 7」，但那只是「全部」这一种态下的文案；筛选后若仍显示
 * 「今日待处理」就是错的。故按当前筛选给出对应标题，计数始终等于当前结果数。
 */
const GROUP_LABELS: Record<string, string> = {
  all: '今日待处理',
  delivery: '交付事项',
  stock_shortage: '缺货事项',
  service: '维修事项',
  recovery: '回收事项',
}

/** 任务行视图。WXML 不能调用任意函数，显示值一律在此预算好。 */
export function toRowView(task: WorkbenchTask): TaskRowView {
  const amount = describeAmount(task.amountSummary)
  const action = describeAction(task.primaryAction)
  const overdue = isOverdueTask(task)
  const deadline = task.deadlineText ?? '未约定时间'

  return {
    taskId: task.taskId,
    entityId: task.entityId,
    title: task.title,
    customer: task.customerDisplay ?? '未登记客户',
    device: task.deviceSummary ?? '未登记设备',
    deadlineText: overdue ? `已逾期 · ${deadline}` : deadline,
    isOverdue: overdue,
    photoLabel: task.photoKind ? PHOTO_KIND_LABELS[task.photoKind] : '无照片',
    hasPhoto: task.photoUrl !== null,
    photoUrl: task.photoUrl ?? '',
    photoBroken: false,
    blockerSummary: task.blockerSummary ?? '',
    amountPrimary: amount.primary,
    amountDirection: amount.directionLabel,
    actionLabel: action.label,
    actionEnabled: action.enabled,
    blockerText: action.blockerText,
  }
}

Page({
  data: {
    runtimeNote: DEMO_RUNTIME_NOTE,
    metrics: METRICS,
    filters: FILTERS,
    activeFilter: 'all',
    rows: [] as TaskRowView[],
    resultCount: 0,
    groupLabel: GROUP_LABELS.all,
    emptyText: '',
  },

  onLoad() {
    this.applyFilter('all')
  },

  onShow() {
    // 返回恢复：此处刻意不做任何 setData。
    // navigateTo 返回与 switchTab 切回都复用本页面实例，筛选与滚动位置自然保留。
    // 这行输出便于在开发者工具里确认 onShow 确实被触发且状态未被重置。
    console.info('[T02b] today onShow 保留状态：filter =', this.data.activeFilter, '，结果数 =', this.data.resultCount)
  },

  applyFilter(key: string) {
    const rows = sortTasksForDemo(DEMO_TASKS)
      .filter((t) => key === 'all' || t.category === key)
      .map(toRowView)

    this.setData({
      activeFilter: key,
      rows,
      resultCount: rows.length,
      groupLabel: GROUP_LABELS[key] ?? GROUP_LABELS.all,
      emptyText: rows.length === 0 ? '当前筛选没有待办事项' : '',
    })
  },

  onFilterTap(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key ?? 'all')
    this.applyFilter(key)
  },

  onMetricTap(e: WechatMiniprogram.TouchEvent) {
    const filter = e.currentTarget.dataset.filter
    if (filter) {
      this.applyFilter(String(filter))
      return
    }
    // 待收款在骨架阶段没有落点：账本页归 T09 / T15。只解释口径，不跳空页。
    wx.showModal({
      title: '待收款口径',
      content:
        '待收 = 已确认应收（countsTowardReceivable）的尾款合计，共 ¥12,800.00。维修初估与回收未确认收购不计入。账本明细页归 T09 / T15。',
      showCancel: false,
      confirmText: '知道了',
    })
  },

  onSearchTap() {
    wx.showModal({
      title: '尚未接通',
      content: '搜索与扫码归 P14（搜索 / SN 查询）任务卡。本次未提交任何数据。',
      showCancel: false,
      confirmText: '知道了',
    })
  },

  onCreateTap() {
    // ＋开单 进入开单域。开单是 tabBar 页，必须用 switchTab（navigateTo 不接受 tabBar 路径）。
    wx.switchTab({ url: '/pages/sales/index' })
  },

  onSelectTask(e: WechatMiniprogram.TouchEvent) {
    const taskId = String(e.currentTarget.dataset.taskId ?? '')
    if (!taskId) return
    // 只传 ID：详情页重新取数，不把列表旧对象当可提交依据（02 §4）。
    wx.navigateTo({ url: `/packages/sales/order-detail/index?taskId=${taskId}` })
  },

  onThumbError(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index)
    if (Number.isNaN(index)) return
    this.setData({ [`rows[${index}].photoBroken`]: true })
  },
})
