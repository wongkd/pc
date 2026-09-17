/**
 * T02b · 事项详情页（分包 packages/sales）。
 *
 * 结构依据 02 §4「详情页」顺序：
 *   单号 / 类别 / 交期 → 客户与事项 → 紧凑设备摘要 → 阶段 → 当前处理内容
 *   → 下一步提示 → 最近事件 / 历史 → 底部固定金额与动作。
 *
 * ⚠️ 本卡范围说明（须与实现一致，不得当成业务已完成）：
 *   - 页面参数只带 `taskId`，进入后重新取数，**不把列表旧对象当可提交依据**（02 §4）；
 *   - 「阶段序列」与「事件记录」在 V1 读模型样本里没有对应字段，页面**不编造进度**，
 *     如实说明归属任务；不画假的进度条；
 *   - 主动作只做「可点 / 不可点 + 阻断原因」的呈现，**不提交任何数据**（05 §T02b「不做」）。
 *
 * 按 02 §2 的页面地图，售后与回收的详情最终归属 packages/service/detail 与
 * packages/recovery/detail（T12 / T13 / T14）。本卡只建一个详情页，三类事项共用，
 * 该偏差登记在 T02b 验证记录中，不由实现自行宣布为最终形态。
 */
import { AttachmentPurpose } from '../../../contracts/generated/enums'
import {
  DEMO_RUNTIME_NOTE,
  TASK_CATEGORY_LABELS,
  findTaskById,
  isOverdueTask,
} from '../../../features/demo-data'
import { describeAction, describeAmount } from '../../../features/amount-view'
import { deviceShortName } from '../../../features/display-text'

const PHOTO_KIND_LABELS: Record<AttachmentPurpose, string> = {
  [AttachmentPurpose.PRODUCT_REFERENCE]: '型号示意',
  [AttachmentPurpose.SERVICE_INTAKE]: '接修照片',
  [AttachmentPurpose.RECOVERY_EVIDENCE]: '回收照片',
  [AttachmentPurpose.DELIVERY_EVIDENCE]: '交付照片',
}

/** 阶段与事件区的承位文案：写明空缺原因与归属，不用推测值填空。 */
const STAGE_NOTE =
  '阶段序列尚未接通。V1 读模型样本没有阶段字段，本页不显示推测的进度；归属 T08 / T12 / T18。'
const EVENT_NOTE =
  '事件记录尚未接通。V1 读模型样本没有事件字段，本页不显示推测的历史；归属 T08 / T12 / T18。'

interface DetailView {
  taskId: string
  entityId: string
  entityVersion: number
  categoryLabel: string
  /** 页面主标题：客户 + 设备简称（见 deviceShortName）。 */
  headline: string
  title: string
  deadlineText: string
  isOverdue: boolean
  customer: string
  device: string
  photoLabel: string
  hasPhoto: boolean
  photoUrl: string
  photoBroken: boolean
  /** 阶段与事件的承位说明：无样本可依，如实写明而不是编造进度。 */
  stageNote: string
  eventNote: string
  blockerSummary: string
  amountPrimary: string
  amountDirection: string
  amountDetail: string
  actionLabel: string
  actionEnabled: boolean
  blockerText: string
}

Page({
  data: {
    runtimeNote: DEMO_RUNTIME_NOTE,
    loaded: false,
    task: null as DetailView | null,
  },

  onLoad(options: Record<string, string | undefined>) {
    const taskId = options.taskId ?? ''
    const source = taskId ? findTaskById(taskId) : undefined

    if (!source) {
      this.setData({ loaded: true, task: null })
      return
    }

    const amount = describeAmount(source.amountSummary)
    const action = describeAction(source.primaryAction)
    const overdue = isOverdueTask(source)
    const deadline = source.deadlineText ?? '未约定时间'
    const customer = source.customerDisplay ?? '未登记客户'
    const deviceShort = deviceShortName(source.deviceSummary)

    this.setData({
      loaded: true,
      task: {
        taskId: source.taskId,
        entityId: source.entityId,
        entityVersion: source.entityVersion,
        categoryLabel: TASK_CATEGORY_LABELS[source.category],
        headline: deviceShort ? `${customer} · ${deviceShort}` : customer,
        title: source.title,
        deadlineText: overdue ? `已逾期 · ${deadline}` : deadline,
        isOverdue: overdue,
        customer,
        device: source.deviceSummary ?? '未登记设备',
        photoLabel: source.photoKind ? PHOTO_KIND_LABELS[source.photoKind] : '无照片',
        hasPhoto: source.photoUrl !== null,
        photoUrl: source.photoUrl ?? '',
        photoBroken: false,
        stageNote: STAGE_NOTE,
        eventNote: EVENT_NOTE,
        blockerSummary: source.blockerSummary ?? '',
        amountPrimary: amount.primary,
        amountDirection: amount.directionLabel,
        amountDetail: amount.detail,
        actionLabel: action.label,
        actionEnabled: action.enabled,
        blockerText: action.blockerText,
      },
    })
  },

  onPhotoError() {
    const task = this.data.task
    if (!task) return
    this.setData({ task: { ...task, photoBroken: true } })
  },

  onPrimaryAction() {
    const task = this.data.task
    if (!task || !task.actionEnabled) return
    // 骨架阶段不执行动作：不假装成功、不返回假结果（05 执行原则）。
    wx.showModal({
      title: '尚未接通',
      content: '本卡只建立页面结构，动作执行归后续业务任务卡。本次未提交任何数据。',
      showCancel: false,
      confirmText: '知道了',
    })
  },

  onBackToday() {
    wx.switchTab({ url: '/pages/today/index' })
  },
})
