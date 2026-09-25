/**
 * T02a · 今天工作台的演示样本（V1 读模型样本）。
 *
 * 数据来源：`contracts/v1/fixtures.json` 的 `datasets.V1`（06 §2 固定虚构样本）。
 * 契约规定 `fixtures.json` 不生成端内文件，故此处是测试专用副本；`demoData.test.ts`
 * 会逐字段与契约比对，任何一方漂移都会使测试失败 —— 不允许出现「两处手写、各自演化」。
 *
 * 演示约定（`fixtures.demoPolicy`）：
 *   - 标识由 ID 前缀 `DEMO-` 承载，不新增协议字段；
 *   - 固定演示日期 2026-09-17（Asia/Shanghai），不随运行当天变成过期样本；
 *   - 样本只供契约回归测试使用；网页今天页不得导入本文件或回退到样本。
 *   - V1 只证明页面读模型，不构成任何业务前置条件已满足的证据。
 *
 * 金额单位一律为「分」（integer cents），展示时才除以 100。
 */
import type {
  AttachmentPurpose,
  BalanceDirection,
  EntityType,
  TaskCategory,
} from '../../contracts/generated/enums'

/** objects.json 把 TaskReadModel.amountSummary 声明为 JsonObject（结构未固定），
 *  结构由 fixtures.shapeDefinitions.amountSummary 首次冻结；此处按其字段定义端内类型。 */
export interface WorkbenchAmountSummary {
  totalCents: number | null
  receivedCents: number | null
  offsetCents: number | null
  balanceCents: number | null
  balanceDirection: BalanceDirection | null
  estimateCents: number | null
  countsTowardReceivable: boolean
  note: string | null
}

export interface WorkbenchActionBlocker {
  /** 必须是 errors.json 中存在的错误码。 */
  code: string
  message: string
  targetPage: string | null
  targetField: string | null
}

export interface WorkbenchPrimaryAction {
  code: string
  label: string
  enabled: boolean
  blockers: WorkbenchActionBlocker[]
}

export interface WorkbenchTask {
  taskId: string
  entityType: EntityType
  entityId: string
  entityVersion: number
  category: TaskCategory
  title: string
  customerDisplay: string | null
  deviceSummary: string | null
  photoKind: AttachmentPurpose | null
  photoUrl: string | null
  dueAt: string | null
  deadlineText: string | null
  blockerSummary: string | null
  amountSummary: WorkbenchAmountSummary | null
  primaryAction: WorkbenchPrimaryAction
  detailTarget: string
}

/** 固定演示日期与门店时区（fixtures.demoPolicy）。 */
export const DEMO_DATE = '2026-09-17'
export const DEMO_TIMEZONE = 'Asia/Shanghai'

export const DEMO_TASKS: WorkbenchTask[] = [
  {
    taskId: 'DEMO-TASK-001',
    entityType: 'sale_order',
    entityId: 'DEMO-SO-003',
    entityVersion: 3,
    category: 'delivery',
    title: '装机交付 · 白色设计主机',
    customerDisplay: '陈先生',
    deviceSummary: '白色设计主机 · 设计用装机',
    photoKind: 'delivery_evidence',
    photoUrl: 'demo://photos/DEMO-SO-003.png',
    dueAt: '2026-09-17T08:00:00Z',
    deadlineText: '今天 16:00 取机',
    blockerSummary: '装机检查 2/3 项完成；附件未打包',
    amountSummary: {
      totalCents: 628000,
      receivedCents: 200000,
      offsetCents: 0,
      balanceCents: 428000,
      balanceDirection: 'client_due',
      estimateCents: null,
      countsTowardReceivable: true,
      note: null,
    },
    primaryAction: {
      code: 'B10',
      label: '办理交付（先核对）',
      enabled: false,
      blockers: [
        {
          code: 'CHECKLIST_INCOMPLETE',
          message: '检查项 2/3 完成，附件未打包',
          targetPage: '装机检测',
          targetField: null,
        },
      ],
    },
    detailTarget: '/orders/DEMO-SO-003',
  },
  {
    taskId: 'DEMO-TASK-002',
    entityType: 'sale_order',
    entityId: 'DEMO-SO-002',
    entityVersion: 4,
    category: 'stock_shortage',
    title: '装机缺件 · 缺 SSD 1 件',
    customerDisplay: '林女士',
    deviceSummary: '游戏主机 · 缺 SSD 1 件',
    photoKind: 'product_reference',
    photoUrl: 'demo://photos/DEMO-SO-002.png',
    dueAt: '2026-09-17T09:30:00Z',
    deadlineText: '预计 17:30 到货（尚未实到）',
    blockerSummary: '缺 SSD 1 件，预计 17:30，尚未实到',
    amountSummary: {
      totalCents: 828000,
      receivedCents: 200000,
      offsetCents: 0,
      balanceCents: 628000,
      balanceDirection: 'client_due',
      estimateCents: null,
      countsTowardReceivable: true,
      note: null,
    },
    primaryAction: { code: 'B15', label: '核对到货', enabled: true, blockers: [] },
    detailTarget: '/orders/DEMO-SO-002',
  },
  {
    taskId: 'DEMO-TASK-003',
    entityType: 'service_order',
    entityId: 'DEMO-RE-008',
    entityVersion: 2,
    category: 'service',
    title: '维修 · 显卡间歇黑屏',
    customerDisplay: '周先生',
    deviceSummary: '客户显卡 · 间歇黑屏',
    photoKind: 'service_intake',
    photoUrl: 'demo://photos/DEMO-RE-008.png',
    dueAt: null,
    deadlineText: '待安排',
    blockerSummary: '已接收待检测，未定收费',
    amountSummary: {
      totalCents: null,
      receivedCents: null,
      offsetCents: null,
      balanceCents: null,
      balanceDirection: null,
      estimateCents: null,
      countsTowardReceivable: false,
      note: '费用待确认',
    },
    primaryAction: { code: 'B21', label: '开始检测', enabled: true, blockers: [] },
    detailTarget: '/after-sales/DEMO-RE-008',
  },
  {
    taskId: 'DEMO-TASK-004',
    entityType: 'sale_order',
    entityId: 'DEMO-SO-011',
    entityVersion: 2,
    category: 'delivery',
    title: '零售交付 · 办公主机',
    customerDisplay: '赵先生',
    deviceSummary: '办公主机 · 零售整机',
    photoKind: 'delivery_evidence',
    photoUrl: 'demo://photos/DEMO-SO-011.png',
    dueAt: '2026-09-17T10:00:00Z',
    deadlineText: '今天 18:00',
    blockerSummary: null,
    amountSummary: {
      totalCents: 368000,
      receivedCents: 368000,
      offsetCents: 0,
      balanceCents: 0,
      balanceDirection: 'settled',
      estimateCents: null,
      countsTowardReceivable: true,
      note: '尾款为 0，仍须确认实物交出',
    },
    primaryAction: { code: 'B10', label: '办理交付', enabled: true, blockers: [] },
    detailTarget: '/orders/DEMO-SO-011',
  },
  {
    taskId: 'DEMO-TASK-005',
    entityType: 'service_order',
    entityId: 'DEMO-RE-006',
    entityVersion: 3,
    category: 'service',
    title: '维修 · 主板更换建议',
    customerDisplay: '刘女士',
    deviceSummary: '笔记本 · 主板更换建议 480 元',
    photoKind: 'service_intake',
    photoUrl: 'demo://photos/DEMO-RE-006.png',
    dueAt: null,
    deadlineText: '待客户确认',
    blockerSummary: '主板更换建议 480 元，未获客户确认',
    amountSummary: {
      totalCents: null,
      receivedCents: null,
      offsetCents: null,
      balanceCents: null,
      balanceDirection: null,
      estimateCents: 48000,
      countsTowardReceivable: false,
      note: '预计费用，不计确定应收',
    },
    primaryAction: { code: 'B22', label: '查看方案', enabled: true, blockers: [] },
    detailTarget: '/after-sales/DEMO-RE-006',
  },
  {
    taskId: 'DEMO-TASK-006',
    entityType: 'sale_order',
    entityId: 'DEMO-SO-009',
    entityVersion: 2,
    category: 'stock_shortage',
    title: '零售缺件 · 显示器 1 台在途',
    customerDisplay: '吴先生',
    deviceSummary: '办公套装 · 显示器 1 台在途',
    photoKind: 'product_reference',
    photoUrl: 'demo://photos/DEMO-SO-009.png',
    dueAt: '2026-09-18T02:00:00Z',
    deadlineText: '预计明天到货',
    blockerSummary: '显示器 1 台在途，预计明天',
    amountSummary: {
      totalCents: 424000,
      receivedCents: 200000,
      offsetCents: 0,
      balanceCents: 224000,
      balanceDirection: 'client_due',
      estimateCents: null,
      countsTowardReceivable: true,
      note: null,
    },
    primaryAction: { code: 'B15', label: '查看缺件', enabled: true, blockers: [] },
    detailTarget: '/orders/DEMO-SO-009',
  },
  {
    taskId: 'DEMO-TASK-007',
    entityType: 'recovery_order',
    entityId: 'DEMO-TR-001',
    entityVersion: 1,
    category: 'recovery',
    title: '回收 · 旧机暂存待验机',
    customerDisplay: '刘先生',
    deviceSummary: '旧主机 · 暂存待验机',
    photoKind: 'recovery_evidence',
    photoUrl: 'demo://photos/DEMO-TR-001.png',
    dueAt: null,
    deadlineText: '待安排',
    blockerSummary: '旧机暂存待验机，预计 1,500 元，未确认收购',
    amountSummary: {
      totalCents: null,
      receivedCents: null,
      offsetCents: null,
      balanceCents: null,
      balanceDirection: null,
      estimateCents: 150000,
      countsTowardReceivable: false,
      note: '客户所有，不计库存 / 折抵',
    },
    primaryAction: { code: 'B27', label: '开始验机', enabled: true, blockers: [] },
    detailTarget: '/recovery/DEMO-TR-001',
  },
]

/** 指标（06 §2 期望，fixtures.datasets.V1.metrics）。 */
export const DEMO_METRICS = {
  pendingDelivery: 2,
  stockShortage: 2,
  servicePending: 2,
  taskTotal: 7,
  /** 待收 = countsTowardReceivable=true 的 balanceCents 之和 = 4,280 + 6,280 + 2,240 元。 */
  receivableCents: 1280000,
} as const

/** 列表类别筛选。`全部` 之外与 TaskCategory 取值一致。 */
export const TASK_CATEGORY_LABELS: Record<TaskCategory, string> = {
  delivery: '交付',
  stock_shortage: '缺货',
  service: '维修',
  recovery: '回收',
  collection: '待收款',
}

/**
 * 演示排序：截止时间升序，无截止时间的排在最后。
 *
 * ⚠️ 这不是最终排序。契约里 V1 声明 `order: "unspecified"`（F05，归 T18），
 * 规格只保证 06 §2 表格顺序是「类别展示顺序」。此处仅为让演示可复现。
 */
export function sortTasksForDemo(tasks: WorkbenchTask[]): WorkbenchTask[] {
  return [...tasks].sort((a, b) => {
    if (a.dueAt === b.dueAt) return a.taskId.localeCompare(b.taskId)
    if (a.dueAt === null) return 1
    if (b.dueAt === null) return -1
    return a.dueAt < b.dueAt ? -1 : 1
  })
}

/** 分转显示文案。保留两位小数，不吞掉「分」。 */
export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

const MONTH_LABELS = [
  '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月',
]
const WEEKDAY_LABELS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

/**
 * 把固定演示日期拆成页头要用的三块文案（日 / 月 / 星期）。
 *
 * 页头按 v3 设计稿显示「17 ／ 九月 ／ 星期四」。**不从运行当天推导**：
 * 演示日期是固定的 2026-09-17（`fixtures.demoPolicy`），随当天算会让样本在第二天
 * 自己变成过期数据。用 `Date.UTC` 构造再取 UTC 分量，避免本地时区把日期挪到前一天。
 */
export function describeDemoDate(isoDate: string): { day: string; month: string; weekday: string } {
  const [year, month, day] = isoDate.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return {
    day: String(day),
    month: MONTH_LABELS[month - 1],
    weekday: WEEKDAY_LABELS[date.getUTCDay()],
  }
}
