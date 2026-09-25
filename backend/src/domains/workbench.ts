/**
 * R02 · 工作台读模型：把在办单据派生为「今天」页的待办列表与统计。
 *
 * 契约依据（contracts/v1）：
 *   actions.json  R02   GET /workbench（无权限门槛，03 §8 权限表首行「待办」老板与店员均可）
 *   objects.json  TaskReadModel（16 字段 + 5 条排序/去重规则）、SaleOrder / ServiceOrder / Recovery
 *   enums.json    TaskCategory / EntityType / AttachmentPurpose / ActionCode / BalanceDirection
 *   fixtures.json datasets.V1 ++ shapeDefinitions.amountSummary / primaryAction（响应形状的首次冻结）
 *   conventions.json reading.noHiddenSecurity、pagination.snapshot（一次快照、分页不改汇总口径）
 *
 * ── 这份读模型不做的事 ──
 *
 * 1. **不自己发明指标**。五项统计与四类待办的口径来自契约 V1.expected 与
 *    02-ui-specification.md §3「首页信息顺序」第 3、5 条（待交机 / 缺货订单 / 维修待办 / 待收款；
 *    筛选 全部 / 交付 / 缺货 / 维修 / 回收）。`collection`（待收款事项）在 V1 样本里为 0 条、
 *    `expected.categoryCounts` 也只有四类，契约未给先例 ⇒ **本卡不生成**，留白已登记。
 *
 * 2. **不另存一份任务状态**（objects.json TaskReadModel.desc）。待办全部由单据现状派生，
 *    没有 task 表、没有「已读 / 已完成」标记 —— 单据状态变了，待办自己跟着变。
 *
 * 3. **不发成本、供应商、SN、他人资料**（03 §8 / conventions.reading.noHiddenSecurity）。
 *    这里只取门店自己单据上的客户可见字段：`TaskReadModel` 本身就没有成本位，不需要额外删字段。
 *    照片（photoKind / photoUrl）本轮一律 null —— 附件读路径归 BK-05，不在此处半接。
 *
 * 4. **不逐个订单去查**。工作台是全店扫描，用批量 SQL 一次读齐三类单据；
 *    缺件 / 缺 SN / 最新检查单都用相关子查询就地算，不按行回调 `queryFulfillmentBoard`
 *    （那是单订单看板，N+1 会把工作台拖垮）。
 *
 * ── 两处与契约样本形态**故意不同**的地方（都记了理由，不是漏改）──
 *
 * ① `taskId` 用**单号**（`sale_order:SO-20260922-001`）而不是数据库主键。
 *    objects.json TaskReadModel.rules 第 1 条写「主键为 entityType + entityId」，
 *    而 entityId 取的是业务单号（`UNIQUE (store_id, order_no)` 保证店内唯一，
 *    也与 fixtures.V1 样本里 entityId = "DEMO-SO-003" 的形态一致）。
 *    两者必须能拼起来，否则前端拿 taskId 做 key、拿 entityId 显示单号时会各说各话。
 *
 * ② `detailTarget` 指向**真实存在**的路由，不照抄样本里的 `/orders/DEMO-SO-003`。
 *    旧的 `/orders/:id` 页里是 `const orderId = Number(id)`（OrdersPages.tsx:15），
 *    而 v2 销售单 id 是字符串（形如 `xxx::sale`）—— 指过去只会得到一个 NaN 的空页。
 *    因此本轮统一指向新版业务工作区（`/sales/orders`、`/after-sales`、`/recovery`），
 *    精确到单的详情深链要等前端补出 `/sales/orders/:id` 之后再改，见卡 README 的未决项。
 */

import type { OperationsDb } from './operations'

/** 门店时区：与 fixtures.demoPolicy 一致（单门店，中国）。 */
export const WORKBENCH_TIMEZONE = 'Asia/Shanghai'

/** TaskCategory（enums.json）。`collection` 本轮不生成，保留取值以便契约对齐。 */
export const TASK_CATEGORIES = ['delivery', 'stock_shortage', 'service', 'recovery', 'collection'] as const
export type TaskCategory = (typeof TASK_CATEGORIES)[number]

/** 工作台支持的扫描范围。`open` = 未结事项（终态不出现在待办里）。 */
export const TASK_SCOPES = ['open'] as const
export type TaskScope = (typeof TASK_SCOPES)[number]

export const WORKBENCH_DEFAULT_LIMIT = 50
export const WORKBENCH_MAX_LIMIT = 200

type BalanceDirection = 'client_due' | 'settled' | 'store_due'

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

/** blocker.code 必须是 errors.json 里存在的错误码（fixtures.shapeDefinitions.primaryAction.rules 第 2 条）。 */
export interface WorkbenchBlocker {
  code: string
  message: string
  targetPage: string | null
  targetField: string | null
}

export interface WorkbenchPrimaryAction {
  code: string
  label: string
  enabled: boolean
  blockers: WorkbenchBlocker[]
}

export interface WorkbenchTask {
  taskId: string
  entityType: string
  entityId: string
  entityVersion: number
  category: TaskCategory
  title: string
  customerDisplay: string | null
  deviceSummary: string | null
  photoKind: string | null
  photoUrl: string | null
  dueAt: string | null
  deadlineText: string | null
  blockerSummary: string | null
  amountSummary: WorkbenchAmountSummary | null
  primaryAction: WorkbenchPrimaryAction
  detailTarget: string
}

export interface WorkbenchCountMetric {
  label: string
  value: number
  filterTarget: string
}

export interface WorkbenchMoneyMetric {
  label: string
  valueCents: number
  filterTarget: string
}

export interface WorkbenchMetrics {
  pendingDelivery: WorkbenchCountMetric
  stockShortage: WorkbenchCountMetric
  servicePending: WorkbenchCountMetric
  receivable: WorkbenchMoneyMetric
  taskTotal: WorkbenchCountMetric
}

export interface WorkbenchFilters {
  scope: TaskScope
  q: string | null
  category: TaskCategory | null
}

export interface WorkbenchSnapshot {
  generatedAt: string
  filters: WorkbenchFilters
  metrics: WorkbenchMetrics
  tasks: WorkbenchTask[]
}

export interface WorkbenchQuery {
  scope?: string | null
  q?: string | null
  category?: string | null
  limit?: number | null
}

// ─────────────────────────────── 文案与判定表 ───────────────────────────────

/**
 * 主动作映射：从**当前状态出发的唯一下一步**（照各域状态机的实测转换写，不猜）。
 * 依据：service.ts（received→diagnosing→awaiting_approval→repairing/ready_return→retesting→returned）、
 * recovery.ts（received_for_inspection→inspecting→offered→acquired→disassembled→refurbishing→ready_for_sale）。
 */
const SERVICE_ACTION_BY_STATE: Record<string, { code: string; label: string }> = {
  received: { code: 'B21', label: '录入检测与维修方案' },
  diagnosing: { code: 'B21', label: '录入检测与维修方案' },
  awaiting_approval: { code: 'B22', label: '记录客户方案确认' },
  repairing: { code: 'B23', label: '登记换件' },
  outsourced: { code: 'B24', label: '接收外送结果' },
  retesting: { code: 'B25', label: '复测与归还客户' },
  ready_return: { code: 'B25', label: '复测与归还客户' },
}

const RECOVERY_ACTION_BY_STATE: Record<string, { code: string; label: string }> = {
  received_for_inspection: { code: 'B27', label: '验机与估价' },
  inspecting: { code: 'B27', label: '验机与估价' },
  offered: { code: 'B28', label: '确认取得所有权' },
  acquired: { code: 'B44', label: '登记拆件' },
  disassembled: { code: 'B30', label: '整备与上架' },
  refurbishing: { code: 'B30', label: '整备与上架' },
  return_pending: { code: 'B29', label: '归还客户' },
}

/** 回收单状态的中文摘要（title 用，契约样本「回收 · 旧机暂存待验机」的同一形态）。 */
const RECOVERY_STATE_LABELS: Record<string, string> = {
  draft: '登记未完成',
  received_for_inspection: '旧机暂存待验机',
  inspecting: '验机中',
  offered: '已出价待答复',
  acquired: '已取得所有权待拆件',
  disassembled: '拆件完成待整备',
  refurbishing: '整备中',
  ready_for_sale: '已可售待上架',
  return_pending: '待归还客户',
}

// ─────────────────────────────── 文案与判定表 ───────────────────────────────

// ─────────────────────────────── 时间与文案 ───────────────────────────────

/** 取门店时区下的「YYYY-MM-DD」与「HH:MM」，不依赖运行机器的本地时区。 */
function zonedParts(at: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WORKBENCH_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at)
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return {
    date: `${pick('year')}-${pick('month')}-${pick('day')}`,
    time: `${pick('hour')}:${pick('minute')}`,
  }
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(y, m - 1, d + days))
  return shifted.toISOString().slice(0, 10)
}

/**
 * 期限文案（02 §3「逾期明确写已逾期，不能只变红」）。
 * 拿不到 dueAt 时返回 null —— 界面显示「未约定」，不编一个时间出来。
 */
export function describeDeadline(dueAt: string | null, now: Date): string | null {
  if (!dueAt) return null
  const due = new Date(dueAt)
  if (Number.isNaN(due.getTime())) return null

  const today = zonedParts(now).date
  const dueDay = zonedParts(due)
  if (dueDay.date < today) return '已逾期'
  if (dueDay.date === today) return `今天 ${dueDay.time}`
  if (dueDay.date === shiftDate(today, 1)) return `明天 ${dueDay.time}`
  const [, month, day] = dueDay.date.split('-')
  return `${Number(month)}月${Number(day)}日 ${dueDay.time}`
}

function yuan(cents: number): string {
  return (cents / 100).toFixed(2)
}

/** JSON 快照里取一个字符串字段（customer_snapshot / intake_snapshot / seller_snapshot 共用）。 */
function nameFromSnapshot(raw: string | null | undefined, key: string): string | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const value = parsed[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  } catch {
    // 快照损坏不该让整个工作台挂掉：当作没有客户名。
  }
  return null
}

// ─────────────────────────────── 排序 ───────────────────────────────

/**
 * objects.json TaskReadModel.rules 的排序口径：
 * 「排序：逾期 → 今天到期 → 当前可执行且等待最久 → 未来事项」「未知交期排在同组已知交期之后」。
 * 同一档内按建单时间升序（等待最久的先处理）。
 */
function sortTasksForWorkbench(tasks: WorkbenchTask[], now: Date): WorkbenchTask[] {
  const today = zonedParts(now).date
  const rank = (task: WorkbenchTask): number[] => {
    if (!task.dueAt) return [3, 0, task.primaryAction.enabled ? 0 : 1]
    const due = new Date(task.dueAt)
    if (Number.isNaN(due.getTime())) return [3, 0, task.primaryAction.enabled ? 0 : 1]
    const date = zonedParts(due).date
    if (date < today) return [0, due.getTime(), 0]
    if (date === today) return [1, due.getTime(), 0]
    return [2, due.getTime(), task.primaryAction.enabled ? 0 : 1]
  }

  return [...tasks].sort((left, right) => {
    const a = rank(left)
    const b = rank(right)
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index]
    }
    return left.entityId.localeCompare(right.entityId)
  })
}

// ─────────────────────────────── 销售单：交付 / 缺货 ───────────────────────────────

interface SaleTaskRow {
  id: string
  order_no: string
  customer_snapshot: string
  kind: string
  fulfillment_state: string
  due_at: string | null
  total_cents: number
  cash_net_cents: number
  offset_net_cents: number
  balance_cents: number
  balance_direction: string
  configuration_version: number
  version: number
  created_at: string
  shortage_count: number
  missing_sn_count: number
  latest_checklist_result: string | null
  latest_checklist_configuration_version: number | null
}

/**
 * 在办销售单一次读齐。缺件口径与 `querySaleOrders` 的 `shortage_count` 完全一致
 * （行数量 − 该行有效数量占用），不另立第二套算法。
 */
async function readSaleTasks(db: OperationsDb, storeId: number): Promise<WorkbenchTask[]> {
  const result = await db
    .prepare(
      `SELECT o.id, o.order_no, o.customer_snapshot, o.kind, o.fulfillment_state, o.due_at,
              o.total_cents, o.cash_net_cents, o.offset_net_cents, o.balance_cents,
              o.balance_direction, o.configuration_version, o.version, o.created_at,
              (SELECT COUNT(*) FROM sale_lines l
                WHERE l.sale_order_id = o.id AND l.source = 'new' AND l.stock_item_id IS NULL
                  AND l.qty > COALESCE((SELECT SUM(r.qty) FROM stock_reservations r
                                        WHERE r.store_id = o.store_id AND r.line_ref = l.id
                                          AND r.status = 'active'
                                          AND r.quantity_bucket_ref IS NOT NULL), 0)) AS shortage_count,
              (SELECT COUNT(*) FROM sale_lines l
                 JOIN stock_items si ON si.id = l.stock_item_id
                 JOIN hardware h ON h.id = si.product_id
                WHERE l.sale_order_id = o.id AND h.tracking_mode = 'item'
                  AND (si.asset_code IS NULL OR TRIM(si.asset_code) = '')) AS missing_sn_count,
              (SELECT c.result FROM sale_checklists c
                WHERE c.store_id = o.store_id AND c.sale_order_id = o.id
                ORDER BY c.checklist_version DESC LIMIT 1) AS latest_checklist_result,
              (SELECT c.configuration_version FROM sale_checklists c
                WHERE c.store_id = o.store_id AND c.sale_order_id = o.id
                ORDER BY c.checklist_version DESC LIMIT 1) AS latest_checklist_configuration_version
       FROM sale_orders o
       WHERE o.store_id = ? AND o.trade_state = 'confirmed' AND o.fulfillment_state <> 'delivered'
       ORDER BY o.created_at ASC
       LIMIT ?`,
    )
    .bind(storeId, WORKBENCH_MAX_LIMIT)
    .all<SaleTaskRow>()

  return (result.results ?? []).map((row) => applyDeliveryGates(saleTaskFrom(row), row))
}

/**
 * 交付链路的主动作按**履约阶段**分档。
 *
 * 为什么不一律给 B10：`deliverSaleOrder` 的第一道闸门是
 * `fulfillment_state !== 'ready_delivery'` 直接 400「没到交付阶段」——
 * 备料中或检测中的单给一个 B10 按钮，点了必然失败。主动作要给的是**当前能成的那一步**。
 * 契约 V1 样本把 testing 阶段的单也标成 B10，那是读模型样本的形态演示，
 * 与本后端闸门的实际顺序不一致；此处以后端闸门为准，并在卡 README 记明差异。
 */
function saleActionFor(row: SaleTaskRow): { code: string; label: string } {
  switch (row.fulfillment_state) {
    case 'waiting_stock':
      return { code: 'B06', label: '开始备料与装机' }
    case 'preparing':
    case 'testing':
      return { code: 'B07', label: '保存装机检测结果' }
    case 'ready_delivery':
      return { code: 'B10', label: '办理交付（先核对）' }
    default:
      // 认不出的阶段退回交付动作：至少不冒充某个具体动作能做到。
      return { code: 'B10', label: '办理交付（先核对）' }
  }
}

function saleTaskFrom(row: SaleTaskRow): WorkbenchTask {
  const customerName = nameFromSnapshot(row.customer_snapshot, 'name')
  const hasShortage = row.shortage_count > 0
  const amountSummary: WorkbenchAmountSummary = {
    totalCents: row.total_cents,
    receivedCents: row.cash_net_cents,
    offsetCents: row.offset_net_cents,
    balanceCents: row.balance_cents,
    balanceDirection: row.balance_direction as BalanceDirection,
    estimateCents: null,
    // 销售单成交额是确定的：进了工作台就计入应收（fixtures.V1.expected.receivableFormula）。
    countsTowardReceivable: true,
    note: null,
  }

  if (hasShortage) {
    // 卡点优先于后续动作：缺件的单归「缺货」，不同时作为「可交付」重复出现
    // （objects.json TaskReadModel.rules 第 2 条）。
    const blockers = row.shortage_count > 0
      ? [{
          code: 'VALIDATION_ERROR',
          message: `${row.shortage_count} 行货还没占住，先到货入库`,
          targetPage: '库存',
          targetField: null,
        }]
      : []
    return {
      taskId: `sale_order:${row.order_no}`,
      entityType: 'sale_order',
      entityId: row.order_no,
      entityVersion: row.version,
      category: 'stock_shortage',
      title: `${row.kind === 'assembly' ? '装机缺件' : '零售缺件'} · ${row.order_no}`,
      customerDisplay: customerName,
      deviceSummary: row.kind === 'assembly' ? '装机单' : '零售单',
      photoKind: null,
      photoUrl: null,
      dueAt: row.due_at,
      deadlineText: null,
      blockerSummary: `${row.shortage_count} 行缺货待补齐`,
      amountSummary,
      primaryAction: { code: 'B15', label: '登记到货入库', enabled: true, blockers },
      detailTarget: '/sales/orders',
    }
  }

  const action = saleActionFor(row)
  const atDeliveryStage = row.fulfillment_state === 'ready_delivery'
  return {
    taskId: `sale_order:${row.order_no}`,
    entityType: 'sale_order',
    entityId: row.order_no,
    entityVersion: row.version,
    category: 'delivery',
    title: `${row.kind === 'assembly' ? '装机交付' : '零售交付'} · ${row.order_no}`,
    customerDisplay: customerName,
    deviceSummary: row.kind === 'assembly' ? '装机单' : '零售单',
    photoKind: null,
    photoUrl: null,
    dueAt: row.due_at,
    deadlineText: null,
    // 描述性卡点（不阻断动作）：还没到交付阶段的单，卡在哪里要说出来。
    blockerSummary: atDeliveryStage ? null : action.label.replace(/^保存|^开始/, ''),
    amountSummary,
    primaryAction: { code: action.code, label: action.label, enabled: true, blockers: [] },
    detailTarget: '/sales/orders',
  }
}

/**
 * B10 交付闸门（assembly.ts deliverSaleOrder 的实测顺序）。
 * 这里只做**预读提示**，不是承诺：真正的拒绝在 POST 时按最新状态重判
 * （conventions.reading.readIsNotAPromise）。
 */
function applyDeliveryGates(task: WorkbenchTask, row: SaleTaskRow): WorkbenchTask {
  // 闸门只对「已经在交付阶段」的单有意义：还没到 ready_delivery 时，
  // blocker 是「没到交付阶段」本身，逐条列检查单 / SN / 尾款只会误导。
  if (row.fulfillment_state !== 'ready_delivery') return task

  const blockers: WorkbenchBlocker[] = []

  if (
    row.kind === 'assembly'
    && (row.latest_checklist_result !== 'passed'
      || row.latest_checklist_configuration_version !== row.configuration_version)
  ) {
    blockers.push({
      code: 'CHECKLIST_INCOMPLETE',
      message: '还没有「通过」的装机检测记录；先检测通过再交付',
      targetPage: '装机检测',
      targetField: null,
    })
  }

  if (row.missing_sn_count > 0) {
    blockers.push({
      code: 'SERIAL_MISMATCH',
      message: `${row.missing_sn_count} 件实物还没有内部编号`,
      targetPage: '库存',
      targetField: null,
    })
  }

  if (row.balance_cents > 0) {
    blockers.push({
      code: 'VALIDATION_ERROR',
      message: `尾款还没结清（待收 ${yuan(row.balance_cents)} 元），先收款再交付`,
      targetPage: '账本',
      targetField: null,
    })
  }

  if (blockers.length === 0) return task
  return {
    ...task,
    blockerSummary: blockers[0].message,
    primaryAction: { ...task.primaryAction, enabled: false, blockers },
  }
}

// ─────────────────────────────── 工单：维修待办 ───────────────────────────────

interface ServiceTaskRow {
  id: string
  order_no: string
  symptom: string
  state: string
  confirmed_charge_cents: number | null
  balance_cents: number
  balance_direction: string
  due_at: string | null
  version: number
  created_at: string
  intake_snapshot: string
  device_code: string
}

async function readServiceTasks(db: OperationsDb, storeId: number): Promise<WorkbenchTask[]> {
  const result = await db
    .prepare(
      `SELECT so.id, so.order_no, so.symptom, so.state, so.confirmed_charge_cents,
              so.balance_cents, so.balance_direction, so.due_at, so.version, so.created_at,
              so.intake_snapshot, d.device_code
       FROM service_orders so
         JOIN customer_device_custody d ON d.id = so.device_id
       -- 终态不进待办：returned / closed 的工单没有下一步动作可给。
       WHERE so.store_id = ? AND so.state NOT IN ('returned', 'closed')
       ORDER BY so.created_at ASC
       LIMIT ?`,
    )
    .bind(storeId, WORKBENCH_MAX_LIMIT)
    .all<ServiceTaskRow>()

  const tasks: WorkbenchTask[] = []
  for (const row of result.results ?? []) {
    const action = SERVICE_ACTION_BY_STATE[row.state]
    // 认不出的状态宁可不显示，也不给一个指向错误动作的按钮。
    if (!action) continue

    const chargeConfirmed = row.confirmed_charge_cents !== null
    const amountSummary: WorkbenchAmountSummary = {
      totalCents: row.confirmed_charge_cents,
      receivedCents: chargeConfirmed ? (row.confirmed_charge_cents as number) - row.balance_cents : null,
      offsetCents: null,
      balanceCents: chargeConfirmed ? row.balance_cents : null,
      balanceDirection: chargeConfirmed ? (row.balance_direction as BalanceDirection) : null,
      // 只有「未确认收费」才用 estimate 位；契约禁止用 0 冒充未定价（V1.expected.excludedFromReceivable）。
      estimateCents: null,
      countsTowardReceivable: chargeConfirmed,
      note: chargeConfirmed ? null : '维修费用未确认，不计确定应收',
    }

    const blockers: WorkbenchBlocker[] = []
    // 归还闸门 = 费用结清（E10 实测）。ready_return 还欠钱就先把话说清楚。
    if (row.state === 'ready_return' && chargeConfirmed && row.balance_cents > 0) {
      blockers.push({
        code: 'VALIDATION_ERROR',
        message: `费用未结清（待收 ${yuan(row.balance_cents)} 元），先登记收款再归还`,
        targetPage: '账本',
        targetField: null,
      })
    }

    tasks.push({
      taskId: `service_order:${row.order_no}`,
      entityType: 'service_order',
      entityId: row.order_no,
      entityVersion: row.version,
      category: 'service',
      title: `维修 · ${row.symptom}`,
      customerDisplay: nameFromSnapshot(row.intake_snapshot, 'customerName'),
      deviceSummary: row.device_code,
      photoKind: null,
      photoUrl: null,
      dueAt: row.due_at,
      deadlineText: null,
      blockerSummary: blockers.length > 0 ? blockers[0].message : null,
      amountSummary,
      primaryAction: {
        code: action.code,
        label: action.label,
        enabled: blockers.length === 0,
        blockers,
      },
      detailTarget: '/after-sales',
    })
  }
  return tasks
}

// ─────────────────────────────── 回收单：回收待办 ───────────────────────────────

interface RecoveryTaskRow {
  id: string
  order_no: string
  seller_snapshot: string
  state: string
  initial_estimate_cents: number | null
  final_acquisition_cents: number | null
  payable_cents: number
  paid_cents: number
  version: number
  created_at: string
  item_count: number
}

async function readRecoveryTasks(db: OperationsDb, storeId: number): Promise<WorkbenchTask[]> {
  const result = await db
    .prepare(
      `SELECT r.id, r.order_no, r.seller_snapshot, r.state, r.initial_estimate_cents,
              r.final_acquisition_cents, r.payable_cents, r.paid_cents, r.version, r.created_at,
              (SELECT COUNT(*) FROM recovery_items i WHERE i.recovery_order_id = r.id) AS item_count
       FROM recovery_orders r
       -- 终态不进待办：returned 已离店；ready_for_sale 的下一步是销售而非库存动作，
       -- 属回收/销售交界，本卡不给它编一个主动作。
       WHERE r.store_id = ? AND r.state NOT IN ('returned', 'ready_for_sale')
       ORDER BY r.created_at ASC
       LIMIT ?`,
    )
    .bind(storeId, WORKBENCH_MAX_LIMIT)
    .all<RecoveryTaskRow>()

  const tasks: WorkbenchTask[] = []
  for (const row of result.results ?? []) {
    const action = RECOVERY_ACTION_BY_STATE[row.state]
    if (!action) continue

    const acquired = row.final_acquisition_cents !== null
    const amountSummary: WorkbenchAmountSummary = {
      // 取得所有权前，机器还是客户的：不得计入库存 / 折抵 / 应收
      // （fixtures.V1.expected.excludedFromReceivable 里 DEMO-TR-001 的原文理由）。
      totalCents: acquired ? row.final_acquisition_cents : null,
      receivedCents: acquired ? row.paid_cents : null,
      offsetCents: null,
      balanceCents: acquired ? row.payable_cents : null,
      balanceDirection: acquired
        ? (row.payable_cents > 0 ? 'store_due' : 'settled')
        : null,
      estimateCents: acquired ? null : row.initial_estimate_cents,
      countsTowardReceivable: false,
      note: acquired ? '门店应付（收购款）' : '未确认收购，属客户所有，不计库存 / 应收',
    }

    tasks.push({
      taskId: `recovery_order:${row.order_no}`,
      entityType: 'recovery_order',
      entityId: row.order_no,
      entityVersion: row.version,
      category: 'recovery',
      title: `回收 · ${RECOVERY_STATE_LABELS[row.state] ?? '待处理'}`,
      customerDisplay: nameFromSnapshot(row.seller_snapshot, 'name'),
      deviceSummary: row.item_count > 0 ? `${row.item_count} 件旧设备` : null,
      photoKind: null,
      photoUrl: null,
      dueAt: null,
      deadlineText: null,
      blockerSummary: null,
      amountSummary,
      primaryAction: { code: action.code, label: action.label, enabled: true, blockers: [] },
      detailTarget: '/recovery',
    })
  }
  return tasks
}

// ─────────────────────────────── 对外查询 ───────────────────────────────

/** 契约读模型的固定文案与跳转目标（照 fixtures.V1.metrics 的形态）。 */
function buildMetrics(tasks: readonly WorkbenchTask[]): WorkbenchMetrics {
  const countOf = (category: TaskCategory) => tasks.filter((task) => task.category === category).length
  // 应收 = countsTowardReceivable=true 的 balanceCents 之和（V1.expected.receivableFormula）
  const receivableCents = tasks.reduce((sum, task) => {
    const amount = task.amountSummary
    if (!amount || !amount.countsTowardReceivable) return sum
    return sum + Math.max(amount.balanceCents ?? 0, 0)
  }, 0)

  return {
    pendingDelivery: {
      label: '待交机',
      value: countOf('delivery'),
      filterTarget: '/dashboard?category=delivery',
    },
    stockShortage: {
      label: '缺货订单',
      value: countOf('stock_shortage'),
      filterTarget: '/dashboard?category=stock_shortage',
    },
    servicePending: {
      label: '维修待办',
      value: countOf('service'),
      filterTarget: '/dashboard?category=service',
    },
    receivable: {
      label: '待收款',
      valueCents: receivableCents,
      filterTarget: '/finance?view=receivable',
    },
    taskTotal: {
      label: '待办总数',
      value: tasks.length,
      filterTarget: '/dashboard?scope=open',
    },
  }
}

function matchesQuery(task: WorkbenchTask, q: string | null, category: TaskCategory | null): boolean {
  if (category && task.category !== category) return false
  if (!q) return true
  const needle = q.toLowerCase()
  return [task.entityId, task.taskId, task.title, task.customerDisplay, task.deviceSummary]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(needle))
}

/**
 * 工作台读模型。一次快照读齐三类单据 → 派生待办 → 同口径汇总。
 * `metrics` 基于**未筛选**的完整在办集合（conventions.pagination.snapshot：
 * 「分页不得改变汇总口径」），`tasks` 才受 q / category / limit 影响。
 */
export async function queryWorkbench(
  db: OperationsDb,
  storeId: number,
  query: WorkbenchQuery = {},
  now: Date = new Date(),
): Promise<WorkbenchSnapshot> {
  const generatedAt = now.toISOString()
  const scope: TaskScope = 'open'
  const q = query.q?.trim() ? query.q.trim() : null
  const category = (query.category ?? null) as TaskCategory | null
  const limit =
    Number.isInteger(query.limit) && (query.limit as number) > 0
      ? Math.min(query.limit as number, WORKBENCH_MAX_LIMIT)
      : WORKBENCH_DEFAULT_LIMIT

  // 顺序读三类单据：D1 每次查询都是独立往返，串行读 + 一个 generatedAt
  // 是这套环境里能做到的「同一读取快照」（conventions.pagination.snapshot）。
  const saleTasks = await readSaleTasks(db, storeId)
  const serviceTasks = await readServiceTasks(db, storeId)
  const recoveryTasks = await readRecoveryTasks(db, storeId)

  const all = [...saleTasks, ...serviceTasks, ...recoveryTasks].map((task) => ({
    ...task,
    deadlineText: describeDeadline(task.dueAt, now),
  }))

  const metrics = buildMetrics(all)
  const tasks = sortTasksForWorkbench(
    all.filter((task) => matchesQuery(task, q, category)),
    now,
  ).slice(0, limit)

  return {
    generatedAt,
    filters: { scope, q, category },
    metrics,
    tasks,
  }
}
