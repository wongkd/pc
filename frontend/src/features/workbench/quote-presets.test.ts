import { describe, expect, it } from 'vitest'
import { applyQuoteScenario, createPresetLines, type QuoteEditorLine, type QuoteScenario } from './quote-presets.ts'

let seq = 0
const keys = () => `test-${++seq}`
const make = (scenario: QuoteScenario) => createPresetLines(scenario, keys)

describe('quote presets', () => {
  it('creates the required category counts and blank values', () => {
    expect(make('standard')).toHaveLength(8)
    expect(make('office')).toHaveLength(7)
    expect(make('upgrade')).toHaveLength(5)
    expect(make('blank')).toHaveLength(1)
    for (const row of [...make('standard'), ...make('office'), ...make('upgrade'), ...make('blank')]) {
      expect(row.qty).toBe('1')
      expect(row.name).toBe('')
      expect(row.spec).toBe('')
      expect(row.priceYuan).toBe('')
      expect(row.productRef).toBe('')
    }
    expect(make('upgrade').at(-1)?.source).toBe('service')
    expect(make('standard').every((row) => row.source === 'new')).toBe(true)
  })

  it('creates distinct row objects and keys', () => {
    const a = make('standard')
    const b = make('standard')
    expect(new Set([...a, ...b].map((row) => row.key)).size).toBe(16)
    expect(a[0]).not.toBe(b[0])
  })

  it('preserves matching category values and removes only untouched excluded slots', () => {
    const rows = make('standard')
    rows[0] = { ...rows[0], name: 'Ryzen 7', priceYuan: '1299.00' }
    const office = applyQuoteScenario(rows, 'standard', 'office', keys)
    expect(office.find((row) => row.category === 'CPU')).toMatchObject({ key: rows[0].key, name: 'Ryzen 7', priceYuan: '1299.00' })
    expect(office.some((row) => row.category === '显卡')).toBe(false)
  })

  it('keeps partially filled excluded rows and does not duplicate them on switch back', () => {
    const rows = make('standard')
    const gpu = { ...rows.find((row) => row.category === '显卡')!, priceYuan: '3000' }
    const office = applyQuoteScenario([...rows.filter((row) => row !== rows[4]), gpu], 'standard', 'office', keys)
    expect(office).toContainEqual(gpu)
    const back = applyQuoteScenario(office, 'office', 'standard', keys)
    expect(back.filter((row) => row.category === '显卡')).toHaveLength(1)
    expect(back.find((row) => row.category === '显卡')).toMatchObject({ priceYuan: '3000', name: '' })
  })

  it('retains manual/existing and duplicate rows, while avoiding a manual same-category empty slot', () => {
    const cpu: QuoteEditorLine = { ...make('standard')[0], key: 'manual-cpu', category: 'CPU', origin: 'manual', name: 'Custom CPU' }
    const manual: QuoteEditorLine = { ...make('standard')[0], key: 'manual', category: undefined, origin: 'manual', name: 'Cable' }
    const existing: QuoteEditorLine = { ...manual, key: 'old', origin: 'existing', name: 'Old item' }
    const duplicate: QuoteEditorLine = { ...cpu, key: 'manual-cpu-2' }
    const changed = applyQuoteScenario([cpu, duplicate, manual, existing], 'office', 'upgrade', keys)
    expect(changed.filter((row) => row.category === 'CPU')).toHaveLength(2)
    expect(changed).toContainEqual(manual)
    expect(changed).toContainEqual(existing)
    expect(changed.filter((row) => row.category === 'CPU' && row.origin === 'preset')).toHaveLength(0)
  })

  it('blank scenario preserves entered rows and only creates a placeholder when no rows remain', () => {
    const populated: QuoteEditorLine = { ...make('standard')[0], name: 'CPU' }
    expect(applyQuoteScenario([populated], 'standard', 'blank', keys)).toEqual([populated])
    const blank = applyQuoteScenario(make('standard'), 'standard', 'blank', keys)
    expect(blank).toHaveLength(1)
    expect(blank[0].category).toBeUndefined()
    expect(blank[0].origin).toBe('preset')
  })

  it('same scenario does not add or remove rows', () => {
    const rows = make('standard')
    expect(applyQuoteScenario(rows, 'standard', 'standard', keys)).toHaveLength(8)
  })
})
