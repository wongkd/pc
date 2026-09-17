/**
 * T03b · 错误行为表测试（小程序端）。
 *
 * 断言的是规格原文：契约 errors.json 的 16 个 code 不多不少全覆盖、
 * 兜底文案与 meaning 逐字一致、401 两条分支区别对待、未知结果不是失败。
 * 与网页端 `frontend/src/api/error-behavior.test.ts` 同一组断言 ——
 * 两端行为的一致性另由 `node contracts/tools/check-client-parity.mjs` 用同一组输入实测。
 *
 * 运行：node --test tests/error-behavior.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  ERROR_HANDLING,
  UNKNOWN_RESULT_ACTIONS,
  UNKNOWN_RESULT_READ_ACTIONS,
  decideClientHandling,
  fallbackMessageFor,
  isRetryableCode,
} from '../features/error-behavior.ts'

const here = dirname(fileURLToPath(import.meta.url))
const contract = JSON.parse(
  readFileSync(resolve(here, '../../contracts/v1/errors.json'), 'utf8'),
)

test('契约里每个 code 都有行为，且没有多余的自造码', () => {
  const contractCodes = contract.errors.map((e) => e.code).sort()
  const tableCodes = Object.keys(ERROR_HANDLING).sort()
  assert.deepEqual(tableCodes, contractCodes)
})

test('兜底文案与契约 meaning 逐字一致（服务端没给 message 时才用）', () => {
  for (const entry of contract.errors) {
    assert.equal(ERROR_HANDLING[entry.code].fallbackMessage, entry.meaning)
  }
})

test('retryable 与契约一致', () => {
  for (const entry of contract.errors) {
    assert.equal(ERROR_HANDLING[entry.code].retryable, entry.retryable)
  }
})

test('每个 code 都至少有一个客户端行为；不可重试的码必须显式声明不自动重试', () => {
  for (const entry of contract.errors) {
    const actions = ERROR_HANDLING[entry.code].actions
    assert.ok(actions.length > 0, `${entry.code} 应至少有一个行为`)
    if (!entry.retryable) assert.ok(actions.includes('no-auto-retry'), `${entry.code} 应声明不自动重试`)
  }
})

test('AUTH_REQUIRED 只清身份缓存，不丢用户正在填的草稿', () => {
  const actions = ERROR_HANDLING.AUTH_REQUIRED.actions
  assert.ok(actions.includes('clear-session'))
  assert.ok(actions.includes('goto-login'))
  assert.ok(!actions.includes('clear-drafts'))
})

test('SESSION_REVOKED 连草稿一起清 —— 权限已被收回（03 §8 L194）', () => {
  const actions = ERROR_HANDLING.SESSION_REVOKED.actions
  assert.ok(actions.includes('clear-session'))
  assert.ok(actions.includes('clear-drafts'))
  assert.ok(actions.includes('goto-login'))
})

test('两种登录失效都不自动重试', () => {
  assert.ok(ERROR_HANDLING.AUTH_REQUIRED.actions.includes('no-auto-retry'))
  assert.ok(ERROR_HANDLING.SESSION_REVOKED.actions.includes('no-auto-retry'))
})

test('未知 code 一律进「结果未知」：写动作查 operation，读动作可等待重试', () => {
  assert.deepEqual(decideClientHandling(null, { isWrite: true }), [...UNKNOWN_RESULT_ACTIONS])
  assert.deepEqual(decideClientHandling(undefined, { isWrite: false }), [...UNKNOWN_RESULT_READ_ACTIONS])
  assert.deepEqual(decideClientHandling('SOMETHING_NEW', { isWrite: true }), [...UNKNOWN_RESULT_ACTIONS])
})

test('query-operation 只对写动作出现（读动作没有副作用可查）', () => {
  assert.ok(decideClientHandling('SERVICE_UNAVAILABLE', { isWrite: true }).includes('query-operation'))
  assert.ok(!decideClientHandling('SERVICE_UNAVAILABLE', { isWrite: false }).includes('query-operation'))
})

test('IDEMPOTENCY_MISMATCH 保留诊断且绝不自动重试（不能自动换 ID 重复扣款）', () => {
  const actions = decideClientHandling('IDEMPOTENCY_MISMATCH', { isWrite: true })
  assert.ok(actions.includes('keep-diagnostics'))
  assert.ok(actions.includes('no-auto-retry'))
  assert.ok(!actions.includes('wait-and-retry'))
})

test('未知 code 给中性文案，不编造失败原因；也不自动重试', () => {
  assert.equal(fallbackMessageFor('NOT_A_REAL_CODE'), '操作结果待确认')
  assert.equal(fallbackMessageFor(null), '操作结果待确认')
  assert.equal(isRetryableCode('NOT_A_REAL_CODE'), false)
  assert.equal(isRetryableCode(null), false)
})

test('契约标记可重试的三个码如实返回 true', () => {
  assert.equal(isRetryableCode('AUTH_REQUIRED'), true)
  assert.equal(isRetryableCode('RATE_LIMITED'), true)
  assert.equal(isRetryableCode('SERVICE_UNAVAILABLE'), true)
})
