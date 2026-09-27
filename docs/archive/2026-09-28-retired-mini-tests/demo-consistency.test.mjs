/**
 * T02b · 端内演示样本 ↔ 契约的一致性。
 *
 * `contracts/v1/fixtures.json` 的 `datasets.V1` 是唯一来源；`features/demo-data.ts`
 * 是端内副本（契约规定 fixtures 不生成端内文件）。本测试逐字段比对两者，
 * 任何一方漂移都会失败 —— 目的是禁止「多处手写、各自演化」。
 *
 * 运行：node --test tests/（或 npm test）
 * 本文件用 Node 内置 test runner，零依赖；`.ts` 由 Node 22 的类型擦除直接加载。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  DEMO_DATE,
  DEMO_METRICS,
  DEMO_TASKS,
  TASK_CATEGORY_LABELS,
  findTaskById,
  isOverdueTask,
  sortTasksForDemo,
} from '../features/demo-data.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

const fixtures = JSON.parse(readFileSync(join(repoRoot, 'contracts', 'v1', 'fixtures.json'), 'utf8'))
const v1 = fixtures.datasets.V1
const contractTasks = v1.tasks
const expected = v1.expected

test('样本条数与契约 V1 一致', () => {
  assert.equal(DEMO_TASKS.length, contractTasks.length)
  assert.equal(DEMO_TASKS.length, expected.taskTotal)
})

test('每条样本与契约逐字段相等（字段顺序不计）', () => {
  for (let i = 0; i < contractTasks.length; i += 1) {
    assert.deepStrictEqual(
      DEMO_TASKS[i],
      contractTasks[i],
      `第 ${i + 1} 条与契约不一致：${contractTasks[i].taskId}`
    )
  }
})

test('演示标识由 ID 前缀承载，且 taskId / entityId 唯一', () => {
  const prefix = fixtures.demoPolicy.idPrefix
  for (const t of DEMO_TASKS) {
    assert.ok(t.taskId.startsWith(prefix), `${t.taskId} 缺少 ${prefix} 前缀`)
    assert.ok(t.entityId.startsWith(prefix), `${t.entityId} 缺少 ${prefix} 前缀`)
  }
  assert.equal(new Set(DEMO_TASKS.map((t) => t.taskId)).size, DEMO_TASKS.length)
  assert.equal(new Set(DEMO_TASKS.map((t) => t.entityId)).size, DEMO_TASKS.length)
})

test('固定演示日期来自契约，不随运行当天漂移', () => {
  assert.equal(DEMO_DATE, fixtures.demoPolicy.demoDate)
  assert.equal(fixtures.demoPolicy.demoTimezone, 'Asia/Shanghai')
})

test('四项指标与契约 metrics 一致', () => {
  assert.equal(DEMO_METRICS.pendingDelivery, v1.metrics.pendingDelivery.value)
  assert.equal(DEMO_METRICS.stockShortage, v1.metrics.stockShortage.value)
  assert.equal(DEMO_METRICS.servicePending, v1.metrics.servicePending.value)
  assert.equal(DEMO_METRICS.receivableCents, v1.metrics.receivable.valueCents)
  assert.equal(DEMO_METRICS.taskTotal, v1.metrics.taskTotal.value)
})

test('类别计数与契约 expected.categoryCounts 一致', () => {
  const counts = {}
  for (const t of DEMO_TASKS) counts[t.category] = (counts[t.category] ?? 0) + 1
  assert.deepStrictEqual(counts, expected.categoryCounts)
})

test('待收 = countsTowardReceivable 的 balanceCents 之和（按契约重算）', () => {
  const sum = DEMO_TASKS.filter((t) => t.amountSummary?.countsTowardReceivable).reduce(
    (acc, t) => acc + (t.amountSummary.balanceCents ?? 0),
    0
  )
  assert.equal(sum, expected.receivableCents)
  assert.equal(sum, DEMO_METRICS.receivableCents)
})

test('初估与未确认费用不得计入待收', () => {
  for (const item of expected.excludedFromReceivable) {
    const task = DEMO_TASKS.find((t) => t.entityId === item.entityId)
    assert.ok(task, `契约列出的排除项在端内样本里不存在：${item.entityId}`)
    assert.equal(task.amountSummary.countsTowardReceivable, false, `${item.entityId} 不应计入待收`)
    assert.notEqual(task.amountSummary.balanceCents, item.estimateCents ?? -1, `${item.entityId} 用初估冒充了确定应收`)
  }
})

test('金额恒等式：balanceCents = totalCents - receivedCents - offsetCents', () => {
  for (const t of DEMO_TASKS) {
    const a = t.amountSummary
    if (a.totalCents === null || a.balanceCents === null) continue
    assert.equal(
      a.balanceCents,
      a.totalCents - (a.receivedCents ?? 0) - (a.offsetCents ?? 0),
      `${t.taskId} 金额恒等式不成立`
    )
  }
})

test('禁用的主动作必须给出可读阻断原因', () => {
  for (const t of DEMO_TASKS) {
    if (t.primaryAction.enabled) continue
    assert.ok(
      t.primaryAction.blockers.length > 0,
      `${t.taskId} 的主动作被禁用却没有 blocker（conventions.reading.allowedActions）`
    )
    for (const b of t.primaryAction.blockers) {
      assert.ok(b.code && b.message, `${t.taskId} 的 blocker 缺少 code 或 message`)
    }
  }
})

test('演示排序可复现，且不修改原集合', () => {
  const snapshot = JSON.stringify(DEMO_TASKS)
  const sorted = sortTasksForDemo(DEMO_TASKS)
  assert.equal(JSON.stringify(DEMO_TASKS), snapshot, '排序不得修改传入数组')
  assert.deepStrictEqual(sortTasksForDemo(DEMO_TASKS).map((t) => t.taskId), sorted.map((t) => t.taskId))
})

test('排序规则：有截止时间的在前，无截止时间的在最后', () => {
  const sorted = sortTasksForDemo(DEMO_TASKS)
  const firstNullIndex = sorted.findIndex((t) => t.dueAt === null)
  if (firstNullIndex !== -1) {
    for (let i = firstNullIndex; i < sorted.length; i += 1) {
      assert.equal(sorted[i].dueAt, null, '无截止时间的事项必须排在最后')
    }
  }
})

test('findTaskById 只按 ID 命中，未知 ID 返回 undefined', () => {
  assert.equal(findTaskById('DEMO-TASK-001')?.entityId, 'DEMO-SO-003')
  assert.equal(findTaskById('NOT-EXIST'), undefined)
  assert.equal(findTaskById(''), undefined)
})

test('逾期判断用固定演示日期比较（V1 无逾期样本，故此处构造用例）', () => {
  const base = DEMO_TASKS[0]
  assert.equal(isOverdueTask(base), false, '演示日期当天不应判为逾期')
  assert.equal(isOverdueTask({ ...base, dueAt: '2026-09-16T08:00:00Z' }), true, '早于演示日期应判为逾期')
  assert.equal(isOverdueTask({ ...base, dueAt: '2026-09-18T08:00:00Z' }), false)
  assert.equal(isOverdueTask({ ...base, dueAt: null }), false, '无截止时间不判逾期')
})

test('分类标签覆盖 TaskCategory 全部取值', () => {
  const categories = new Set(DEMO_TASKS.map((t) => t.category))
  for (const c of categories) {
    assert.ok(TASK_CATEGORY_LABELS[c], `类别 ${c} 没有中文标签`)
  }
  assert.deepStrictEqual(Object.keys(TASK_CATEGORY_LABELS).sort(), [
    'collection',
    'delivery',
    'recovery',
    'service',
    'stock_shortage',
  ])
})
