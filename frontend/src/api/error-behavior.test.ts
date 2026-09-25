/**
 * T03b · 错误行为表测试（网页端）。
 *
 * 这里断言的是**规格原文**，不是实现细节：
 *   · 契约 errors.json 的 code 必须不多不少全覆盖（契约新增码时这里要跟着改）
 *   · 兜底文案与契约 meaning 逐字一致（避免两端各写一套说法）
 *   · retryable 与契约一致
 *   · 401 的两条分支必须区别对待（AUTH_REQUIRED 不清草稿，SESSION_REVOKED 清）
 *   · 结果未知不是失败：写动作去查 operation，读动作可以等待后重试
 */

import { describe, expect, it } from 'vitest'

import { ERRORS } from '../contracts/generated/errors'
import {
  ERROR_HANDLING,
  UNKNOWN_RESULT_ACTIONS,
  UNKNOWN_RESULT_READ_ACTIONS,
  decideClientHandling,
  fallbackMessageFor,
  isRetryableCode,
} from './error-behavior'

describe('错误行为表 · 与契约的关系', () => {
  it('契约里每个 code 都有行为，且没有多余的自造码', () => {
    const contractCodes = ERRORS.map((e) => e.code).sort()
    const tableCodes = Object.keys(ERROR_HANDLING).sort()
    expect(tableCodes).toEqual(contractCodes)
  })

  it('兜底文案与契约 meaning 逐字一致（服务端没给 message 时才用）', () => {
    for (const entry of ERRORS) {
      expect(ERROR_HANDLING[entry.code].fallbackMessage).toBe(entry.meaning)
    }
  })

  it('retryable 与契约一致', () => {
    for (const entry of ERRORS) {
      expect(ERROR_HANDLING[entry.code].retryable).toBe(entry.retryable)
    }
  })

  it('每个 code 都至少有一个客户端行为，且不可重试的码必须显式声明不自动重试', () => {
    for (const entry of ERRORS) {
      const actions = ERROR_HANDLING[entry.code].actions
      expect(actions.length).toBeGreaterThan(0)
      if (!entry.retryable) expect(actions).toContain('no-auto-retry')
    }
  })
})

describe('错误行为表 · 401 的两条分支', () => {
  it('AUTH_REQUIRED 只清身份缓存，不丢用户正在填的草稿', () => {
    const actions = ERROR_HANDLING.AUTH_REQUIRED.actions
    expect(actions).toContain('clear-session')
    expect(actions).toContain('goto-login')
    expect(actions).not.toContain('clear-drafts')
  })

  it('SESSION_REVOKED 连草稿一起清 —— 权限已被收回，留着草稿会让人误以为还能办', () => {
    const actions = ERROR_HANDLING.SESSION_REVOKED.actions
    expect(actions).toContain('clear-session')
    expect(actions).toContain('clear-drafts')
    expect(actions).toContain('goto-login')
  })

  it('两种登录失效都不自动重试（重试也是 401，白绕一圈）', () => {
    expect(ERROR_HANDLING.AUTH_REQUIRED.actions).toContain('no-auto-retry')
    expect(ERROR_HANDLING.SESSION_REVOKED.actions).toContain('no-auto-retry')
  })
})

describe('决定客户端行为', () => {
  it.each(['PURCHASE_PAYMENT_CONFLICT', 'PURCHASE_CANCEL_EXCEEDED'])('%s 保留取消输入，刷新采购单且不自动重发', (code) => {
    const actions = decideClientHandling(code, { isWrite: true })
    expect(actions).toContain('keep-input')
    expect(actions).toContain('reload-entity')
    expect(actions).toContain('no-auto-retry')
    expect(actions).not.toContain('query-operation')
    expect(actions).not.toContain('wait-and-retry')
  })

  it('未知 code 一律进「结果未知」：写动作去查 operation，读动作可以等待后重试', () => {
    expect(decideClientHandling(null, { isWrite: true })).toEqual(UNKNOWN_RESULT_ACTIONS)
    expect(decideClientHandling(undefined, { isWrite: false })).toEqual(UNKNOWN_RESULT_READ_ACTIONS)
    expect(decideClientHandling('SOMETHING_NEW', { isWrite: true })).toEqual(UNKNOWN_RESULT_ACTIONS)
  })

  it('query-operation 只对写动作出现（读动作没有副作用可查）', () => {
    expect(decideClientHandling('SERVICE_UNAVAILABLE', { isWrite: true })).toContain('query-operation')
    expect(decideClientHandling('SERVICE_UNAVAILABLE', { isWrite: false })).not.toContain(
      'query-operation',
    )
  })

  it('IDEMPOTENCY_MISMATCH 保留诊断且绝不自动重试（不能自动换 ID 重复扣款）', () => {
    const actions = decideClientHandling('IDEMPOTENCY_MISMATCH', { isWrite: true })
    expect(actions).toContain('keep-diagnostics')
    expect(actions).toContain('no-auto-retry')
    expect(actions).not.toContain('wait-and-retry')
  })

  it('VERSION_CONFLICT 要求先拉最新版本，而不是直接重提', () => {
    const actions = decideClientHandling('VERSION_CONFLICT', { isWrite: true })
    expect(actions).toContain('reload-entity')
    expect(actions).toContain('no-auto-retry')
  })
})

describe('兜底文案与可重试判定', () => {
  it('未知 code 给中性文案，不编造失败原因', () => {
    expect(fallbackMessageFor('NOT_A_REAL_CODE')).toBe('操作结果待确认')
    expect(fallbackMessageFor(null)).toBe('操作结果待确认')
  })

  it('未知 code 不自动重试（宁可让用户决定）', () => {
    expect(isRetryableCode('NOT_A_REAL_CODE')).toBe(false)
    expect(isRetryableCode(null)).toBe(false)
  })

  it('契约标记可重试的三个码如实返回 true', () => {
    expect(isRetryableCode('AUTH_REQUIRED')).toBe(true)
    expect(isRetryableCode('RATE_LIMITED')).toBe(true)
    expect(isRetryableCode('SERVICE_UNAVAILABLE')).toBe(true)
  })
})
