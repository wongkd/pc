import { describe, expect, it } from 'vitest'
import { formatMoney, sanitizeNumber, sumQuoteItems } from './money'

describe('money utils', () => {
  it('formats currency in CNY', () => {
    expect(formatMoney(1234.5)).toContain('1,234.50')
  })

  it('sanitizes invalid numbers', () => {
    expect(sanitizeNumber('12.3')).toBe(12.3)
    expect(sanitizeNumber('bad', 7)).toBe(7)
  })

  it('sums quote items', () => {
    expect(
      sumQuoteItems([
        { quantity: 2, unitPrice: 50 },
        { quantity: 3, unitPrice: 20 },
      ]),
    ).toBe(160)
  })
})
