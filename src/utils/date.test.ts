import { describe, expect, it } from 'vitest'
import { formatDisplayDate } from './date'

describe('date utils', () => {
  it('returns fallback for empty values', () => {
    expect(formatDisplayDate('')).toBe('未选择日期')
  })

  it('returns original string for invalid dates', () => {
    expect(formatDisplayDate('not-a-date')).toBe('not-a-date')
  })
})
