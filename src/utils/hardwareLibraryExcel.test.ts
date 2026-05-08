import { describe, expect, it, vi } from 'vitest'
import { normalizeHardwareLibraryRows } from './hardwareLibraryExcel'

describe('normalizeHardwareLibraryRows', () => {
  it('normalizes valid rows', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'fixed-id' })

    const result = normalizeHardwareLibraryRows([
      ['分类', '型号 / 说明', '价格'],
      ['CPU', 'Intel Core i7-14700K', '3099'],
      ['', '', ''],
      ['GPU', 'RTX 4070 SUPER', '4899'],
    ])

    expect(result.errors).toEqual([])
    expect(result.items).toEqual([
      { id: 'fixed-id', category: 'CPU', description: 'Intel Core i7-14700K', price: 3099 },
      { id: 'fixed-id', category: 'GPU', description: 'RTX 4070 SUPER', price: 4899 },
    ])

    vi.unstubAllGlobals()
  })

  it('returns friendly errors for invalid header', () => {
    const result = normalizeHardwareLibraryRows([
      ['类别', '型号', '单价'],
      ['CPU', 'Intel', '1'],
    ])

    expect(result.errors[0]).toContain('表头必须为')
  })

  it('returns row validation errors', () => {
    const result = normalizeHardwareLibraryRows([
      ['分类', '型号 / 说明', '价格'],
      ['', 'Intel', '100'],
      ['CPU', '', '100'],
      ['CPU', 'Intel', 'abc'],
    ])

    expect(result.errors).toEqual([
      '第 2 行缺少“分类”。',
      '第 3 行缺少“型号 / 说明”。',
      '第 4 行“价格”必须是数字。',
    ])
  })
})
