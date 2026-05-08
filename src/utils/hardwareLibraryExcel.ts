import type { HardwareLibraryItem } from '../types/quote'
import { sanitizeNumber } from './money'

export const HARDWARE_LIBRARY_COLUMNS = ['分类', '型号 / 说明', '价格', '图片地址'] as const
const LEGACY_COLUMNS = ['分类', '型号 / 说明', '价格'] as const

export interface HardwareLibraryValidationResult {
  items: HardwareLibraryItem[]
  errors: string[]
}

function normalizeHeaderCell(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
}

function isRowEmpty(row: unknown[]): boolean {
  return row.every((cell) => String(cell ?? '').trim() === '')
}

export function normalizeHardwareLibraryRows(rows: unknown[][]): HardwareLibraryValidationResult {
  const errors: string[] = []
  const nonEmptyRows = rows.filter((row) => !isRowEmpty(row))

  if (nonEmptyRows.length === 0) {
    return {
      items: [],
      errors: ['导入失败：文件中没有可用数据。'],
    }
  }

  const header = nonEmptyRows[0].map(normalizeHeaderCell)
  const hasExpectedHeader =
    HARDWARE_LIBRARY_COLUMNS.every((column, index) => header[index] === column) ||
    LEGACY_COLUMNS.every((column, index) => header[index] === column)

  if (!hasExpectedHeader) {
    return {
      items: [],
      errors: ['导入失败：表头必须为“分类”“型号 / 说明”“价格”，可选第 4 列“图片地址”。'],
    }
  }

  const items: HardwareLibraryItem[] = []

  nonEmptyRows.slice(1).forEach((row, index) => {
    const excelRowNumber = index + 2
    const category = String(row[0] ?? '').trim()
    const description = String(row[1] ?? '').trim()
    const priceRaw = String(row[2] ?? '').trim()
    const image = String(row[3] ?? '').trim()

    if (!category && !description && !priceRaw && !image) {
      return
    }

    if (!category) {
      errors.push(`第 ${excelRowNumber} 行缺少“分类”。`)
      return
    }

    if (!description) {
      errors.push(`第 ${excelRowNumber} 行缺少“型号 / 说明”。`)
      return
    }

    if (priceRaw === '' || Number.isNaN(Number(priceRaw))) {
      errors.push(`第 ${excelRowNumber} 行“价格”必须是数字。`)
      return
    }

    items.push({
      id: crypto.randomUUID(),
      category,
      description,
      price: sanitizeNumber(priceRaw),
      ...(image ? { image } : {}),
    })
  })

  return { items, errors }
}
