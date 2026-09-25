import { describe, expect, it } from 'vitest'

import { resolveOfferPriceCents } from './recovery-view'

describe('resolveOfferPriceCents', () => {
  it('未编辑表单时沿用服务端逐件估价，而不是静默提交 0 元', () => {
    expect(resolveOfferPriceCents(undefined, 120_000)).toBe(120_000)
  })

  it('用户编辑后以输入金额为准', () => {
    expect(resolveOfferPriceCents('1250.50', 120_000)).toBe(125_050)
  })
})
