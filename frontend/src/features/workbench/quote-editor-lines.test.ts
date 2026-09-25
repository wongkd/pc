import { describe, expect, it } from 'vitest'
import { serializeQuoteEditorLines, summarizeQuoteEditorLines, validateQuoteEditorLine } from './quote-editor-lines.ts'
import { createPresetLines, type QuoteEditorLine } from './quote-presets.ts'

let seq = 0
const keys = () => `line-${++seq}`
const row = (overrides: Partial<QuoteEditorLine> = {}): QuoteEditorLine => ({
  ...createPresetLines('standard', keys)[0], name: 'CPU', priceYuan: '1299.00', ...overrides,
})

describe('quote editor lines', () => {
  it('does not submit untouched slots and reports rows edited without names', () => {
    const empty = createPresetLines('standard', keys)[0]
    expect(serializeQuoteEditorLines([empty])).toMatchObject({ ok: false })
    expect(validateQuoteEditorLine({ ...empty, spec: 'Ryzen' })).toContain('CPU：请填写商品名称')
    expect(validateQuoteEditorLine({ ...empty, priceYuan: '12' })).toContain('CPU：请填写商品名称')
    expect(validateQuoteEditorLine({ ...empty, productRef: 'p-1' })).toContain('CPU：请填写商品名称')
    expect(validateQuoteEditorLine({ ...empty, qty: '2' })).toContain('CPU：请填写商品名称')
    expect(validateQuoteEditorLine({ ...empty, source: 'used' })).toContain('CPU：请填写商品名称')
  })

  it('requires explicit price and accepts an explicitly entered zero', () => {
    expect(validateQuoteEditorLine(row({ priceYuan: '' }))).toContain('CPU：请填写单价')
    expect(serializeQuoteEditorLines([row({ priceYuan: '0' })])).toMatchObject({ ok: true, lines: [{ unitPriceCents: 0 }] })
  })

  it('converts yuan to integer cents and emits only protocol fields', () => {
    const result = serializeQuoteEditorLines([row({ priceYuan: '1299.00' })])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines[0].unitPriceCents).toBe(129900)
    expect(result.lines[0].qty).toBe(1)
    expect(result.lines[0]).not.toHaveProperty('key')
    expect(result.lines[0]).not.toHaveProperty('category')
    expect(result.lines[0]).not.toHaveProperty('origin')
    expect(result.lines[0]).not.toHaveProperty('scenario')
  })

  it('keeps customer-facing row remarks in the warranty snapshot for the quote view', () => {
    expect(serializeQuoteEditorLines([row({ remark: '成色九成新' })])).toMatchObject({
      ok: true,
      lines: [{ warrantySnapshot: { remark: '成色九成新' } }],
    })
  })

  it('rejects invalid quantities, amounts, and unsafe multiplication', () => {
    for (const qty of ['0', '-1', '1.2', '2x', '9007199254740992']) expect(validateQuoteEditorLine(row({ qty }))).toContain('CPU：数量必须是正整数')
    for (const priceYuan of ['-1', '1.001', 'NaN', 'Infinity', '90071992547410']) expect(validateQuoteEditorLine(row({ priceYuan })).some((message) => message.includes('单价'))).toBe(true)
    expect(serializeQuoteEditorLines([row({ qty: '2', priceYuan: '50000000000000' })])).toMatchObject({ ok: false })
  })

  it('enforces customer and used references, while allowing an unreferenced new item', () => {
    const customer = row({ source: 'customer', customerDeviceRef: '', priceYuan: '' })
    expect(validateQuoteEditorLine(customer)).toEqual(['CPU：客供件要先选客户', 'CPU：客供件要选来源设备'])
    expect(validateQuoteEditorLine({ ...customer, customerDeviceRef: 'device-1' }, { customerId: '7' })).toEqual([])
    expect(serializeQuoteEditorLines([{ ...customer, customerDeviceRef: 'device-1' }], { customerId: '7' })).toMatchObject({ ok: true, lines: [{ unitPriceCents: 0 }] })
    expect(validateQuoteEditorLine(row({ source: 'used', stockItemId: '' }))).toContain('CPU：二手件要指定具体实物')
    expect(serializeQuoteEditorLines([row({ productRef: '' })])).toMatchObject({ ok: true })
  })

  it('counts only valid named rows in the summary and tracks incomplete/empty slots', () => {
    const valid = row({ priceYuan: '100.25', qty: '2' })
    const incomplete = row({ name: '', priceYuan: '20' })
    const empty = createPresetLines('office', keys)[0]
    expect(summarizeQuoteEditorLines([valid, incomplete, empty])).toMatchObject({ totalCents: 20050, incompleteCount: 1, emptySlotCount: 1 })
  })
})
