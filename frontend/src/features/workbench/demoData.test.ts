/**
 * T02a · 端内演示样本与契约的一致性测试。
 *
 * 契约规定 `fixtures.json` 不生成端内文件（dtoGeneration.notGenerated），
 * 所以端内样本是副本。本测试把它钉回契约：任何一方漂移都会失败。
 *
 * 只做机械重算与字段比对，不重复实现业务规则。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEMO_DATE, DEMO_METRICS, DEMO_TASKS, sortTasksForDemo } from './demoData'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const fixtures = JSON.parse(
  readFileSync(resolve(repoRoot, 'contracts/v1/fixtures.json'), 'utf8'),
) as {
  datasets: { V1: { tasks: Record<string, unknown>[]; metrics: Record<string, unknown>; expected: Record<string, unknown> } }
  shapeDefinitions: { amountSummary: { fields: Record<string, unknown> }; primaryAction: { fields: Record<string, unknown> } }
  demoPolicy: { idPrefix: string; demoDate: string }
}

const contractTasks = fixtures.datasets.V1.tasks
const contractMetrics = fixtures.datasets.V1.metrics
const contractExpected = fixtures.datasets.V1.expected

describe('V1 演示样本与契约', () => {
  it('样本条数与 taskId 集合一致', () => {
    expect(DEMO_TASKS).toHaveLength(contractTasks.length)
    expect(DEMO_TASKS.map((t) => t.taskId).sort()).toEqual(
      contractTasks.map((t) => String(t.taskId)).sort(),
    )
  })

  it('每条样本逐字段等于契约里的 V1', () => {
    for (const contractTask of contractTasks) {
      const local = DEMO_TASKS.find((t) => t.taskId === contractTask.taskId)
      expect(local, `端内缺少 ${String(contractTask.taskId)}`).toBeDefined()
      expect(local).toEqual(contractTask)
    }
  })

  it('演示标识由 DEMO- 前缀承载', () => {
    const prefix = fixtures.demoPolicy.idPrefix
    expect(DEMO_DATE).toBe(fixtures.demoPolicy.demoDate)
    for (const task of DEMO_TASKS) {
      expect(task.taskId.startsWith(prefix)).toBe(true)
      expect(task.entityId.startsWith(prefix)).toBe(true)
    }
  })

  it('端内 amountSummary 字段集与契约 shapeDefinitions 一致', () => {
    const declared = Object.keys(fixtures.shapeDefinitions.amountSummary.fields).sort()
    for (const task of DEMO_TASKS) {
      if (!task.amountSummary) continue
      expect(Object.keys(task.amountSummary).sort()).toEqual(declared)
    }
  })

  it('端内 primaryAction 字段集与契约 shapeDefinitions 一致', () => {
    const declared = Object.keys(fixtures.shapeDefinitions.primaryAction.fields).sort()
    for (const task of DEMO_TASKS) {
      expect(Object.keys(task.primaryAction).sort()).toEqual(declared)
    }
  })
})

describe('V1 指标可机械重算', () => {
  it('待收 = countsTowardReceivable 为真的 balanceCents 之和', () => {
    const recomputed = DEMO_TASKS.filter((t) => t.amountSummary?.countsTowardReceivable).reduce(
      (sum, t) => sum + (t.amountSummary?.balanceCents ?? 0),
      0,
    )
    expect(recomputed).toBe(contractExpected.receivableCents)
    expect(recomputed).toBe(DEMO_METRICS.receivableCents)
  })

  it('不把初估与预计费用计入待收', () => {
    const excluded = (contractExpected.excludedFromReceivable as { entityId: string; estimateCents: number | null }[])
    for (const item of excluded) {
      const task = DEMO_TASKS.find((t) => t.entityId === item.entityId)
      expect(task, `契约声明的排除项 ${item.entityId} 不在端内样本中`).toBeDefined()
      expect(task?.amountSummary?.countsTowardReceivable).toBe(false)
      expect(task?.amountSummary?.balanceCents).toBeNull()
      expect(task?.amountSummary?.estimateCents).toBe(item.estimateCents)
    }
  })

  it('四类待办计数与契约一致', () => {
    const counts = (contractExpected.categoryCounts as Record<string, number>) ?? {}
    for (const [category, value] of Object.entries(counts)) {
      expect(DEMO_TASKS.filter((t) => t.category === category)).toHaveLength(value)
    }
    expect(DEMO_TASKS).toHaveLength(contractExpected.taskTotal as number)
    expect(DEMO_METRICS.taskTotal).toBe(contractExpected.taskTotal)
    expect(DEMO_METRICS.pendingDelivery).toBe(counts.delivery)
    expect(DEMO_METRICS.stockShortage).toBe(counts.stock_shortage)
    expect(DEMO_METRICS.servicePending).toBe(counts.service)
  })

  it('契约 metrics 的 label 与端内指标口径一致', () => {
    const metric = contractMetrics.receivable as { valueCents: number; label: string }
    expect(metric.valueCents).toBe(DEMO_METRICS.receivableCents)
    expect((contractMetrics.pendingDelivery as { value: number }).value).toBe(
      DEMO_METRICS.pendingDelivery,
    )
  })
})

describe('金额恒等式与空值口径', () => {
  it('确定应收行满足 余额 = 总额 − 已收 − 折抵', () => {
    for (const task of DEMO_TASKS) {
      const a = task.amountSummary
      if (!a?.countsTowardReceivable) continue
      expect(a.balanceCents).toBe((a.totalCents ?? 0) - (a.receivedCents ?? 0) - (a.offsetCents ?? 0))
    }
  })

  it('非确定应收行不得用初估冒充余额，且必须给出原因', () => {
    for (const task of DEMO_TASKS) {
      const a = task.amountSummary
      if (!a || a.countsTowardReceivable) continue
      expect(a.balanceCents).toBeNull()
      expect(a.balanceDirection).toBeNull()
      expect(a.note).toBeTruthy()
    }
  })

  it('禁用主动作必须至少给一个阻断原因', () => {
    for (const task of DEMO_TASKS) {
      if (task.primaryAction.enabled) continue
      expect(task.primaryAction.blockers.length).toBeGreaterThan(0)
    }
  })
})

describe('演示排序只是可复现顺序', () => {
  it('截止时间升序，无截止时间排在最后', () => {
    const sorted = sortTasksForDemo(DEMO_TASKS)
    const withDue = sorted.filter((t) => t.dueAt !== null)
    const withoutDue = sorted.filter((t) => t.dueAt === null)
    expect(sorted.slice(0, withDue.length)).toEqual(withDue)
    expect(sorted.slice(withDue.length)).toEqual(withoutDue)
    const times = withDue.map((t) => t.dueAt as string)
    expect(times).toEqual([...times].sort())
  })

  it('排序不改变样本集合', () => {
    expect(sortTasksForDemo(DEMO_TASKS).map((t) => t.taskId).sort()).toEqual(
      DEMO_TASKS.map((t) => t.taskId).sort(),
    )
  })
})
