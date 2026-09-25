/** R02 工作台读模型。页面只消费服务端已脱敏的待办，不回退到演示数据。 */
import { createWebApiClient } from '../../api/client.ts'
import type { ApiResult } from '../../api/core.ts'
import type { AttachmentPurpose, BalanceDirection, EntityType, TaskCategory } from '../../contracts/generated/enums'

const workbenchClient = createWebApiClient()

export interface WorkbenchAmountSummary {
  totalCents: number | null; receivedCents: number | null; offsetCents: number | null; balanceCents: number | null
  balanceDirection: BalanceDirection | null; estimateCents: number | null; countsTowardReceivable: boolean; note: string | null
}
export interface WorkbenchTask {
  taskId: string; entityType: EntityType; entityId: string; entityVersion: number; category: TaskCategory; title: string
  customerDisplay: string | null; deviceSummary: string | null; photoKind: AttachmentPurpose | null; photoUrl: string | null
  dueAt: string | null; deadlineText: string | null; blockerSummary: string | null; amountSummary: WorkbenchAmountSummary | null
  primaryAction: { code: string; label: string; enabled: boolean; blockers: Array<{ code: string; message: string; targetPage: string | null; targetField: string | null }> }
  detailTarget: string
}
export const WORKBENCH_CATEGORY_LABELS: Record<TaskCategory, string> = { delivery: '交付', stock_shortage: '缺货', service: '维修', recovery: '回收', collection: '待收款' }
export function formatWorkbenchCents(cents: number): string { return (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }

export interface WorkbenchMetrics {
  pendingDelivery: { label: string; value: number; filterTarget: string }
  stockShortage: { label: string; value: number; filterTarget: string }
  servicePending: { label: string; value: number; filterTarget: string }
  receivable: { label: string; valueCents: number; filterTarget: string }
  taskTotal: { label: string; value: number; filterTarget: string }
}

export interface WorkbenchPayload {
  metrics: WorkbenchMetrics
  tasks: WorkbenchTask[]
  filters: Record<string, unknown>
  generatedAt: string
}

export function fetchWorkbench(): Promise<ApiResult<WorkbenchPayload>> {
  return workbenchClient.client.read<WorkbenchPayload>('/workbench', { params: { scope: 'open', limit: 200 } })
}
