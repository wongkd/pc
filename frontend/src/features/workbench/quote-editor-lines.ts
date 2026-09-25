import type { QuoteLinePayload } from './quote-api.ts'
import { hasQuoteLineInput, type QuoteEditorLine } from './quote-presets.ts'

export interface QuoteLineValidationContext { customerId?: string }
export interface QuoteLineError { key: string; message: string }
export type QuoteLineSerialization = { ok: true; lines: QuoteLinePayload[] } | { ok: false; errors: QuoteLineError[] }

export function isQuoteLineEmptySlot(line: QuoteEditorLine): boolean {
  return !hasQuoteLineInput(line)
}

function parseYuan(value: string): number | null {
  const input = value.trim()
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(input)) return null
  const amount = Number(input)
  if (!Number.isFinite(amount) || amount < 0) return null
  const cents = Math.round(amount * 100)
  return Number.isSafeInteger(cents) ? cents : null
}

export function validateQuoteEditorLine(line: QuoteEditorLine, context: QuoteLineValidationContext = {}): string[] {
  if (isQuoteLineEmptySlot(line)) return []
  const errors: string[] = []
  const name = line.name.trim()
  const prefix = name || line.category || '配置'
  if (!name) errors.push(`${prefix}：请填写商品名称`)
  const qty = Number(line.qty)
  if (!/^\d+$/.test(line.qty.trim()) || !Number.isSafeInteger(qty) || qty < 1) errors.push(`${prefix}：数量必须是正整数`)
  if (line.source === 'customer') {
    if (!context.customerId?.trim()) errors.push(`${prefix}：客供件要先选客户`)
    if (!line.customerDeviceRef.trim()) errors.push(`${prefix}：客供件要选来源设备`)
    if (line.priceYuan.trim() && parseYuan(line.priceYuan) !== 0) errors.push(`${prefix}：客供件金额必须为 0`)
  } else {
    if (!line.priceYuan.trim()) errors.push(`${prefix}：请填写单价`)
    else if (parseYuan(line.priceYuan) === null) errors.push(`${prefix}：单价必须是非负且最多两位小数的有效金额`)
  }
  if (line.source === 'used' && !line.stockItemId.trim()) errors.push(`${prefix}：二手件要指定具体实物`)
  return errors
}

export function serializeQuoteEditorLines(lines: readonly QuoteEditorLine[], context: QuoteLineValidationContext = {}): QuoteLineSerialization {
  const errors: QuoteLineError[] = []
  const payload: QuoteLinePayload[] = []
  for (const line of lines) {
    if (isQuoteLineEmptySlot(line)) continue
    const lineErrors = validateQuoteEditorLine(line, context)
    errors.push(...lineErrors.map((message) => ({ key: line.key, message })))
    if (lineErrors.length) continue
    const qty = Number(line.qty)
    const cents = line.source === 'customer' ? 0 : parseYuan(line.priceYuan)
    if (cents === null || !Number.isSafeInteger(cents * qty)) {
      errors.push({ key: line.key, message: `${line.name.trim()}：金额乘数量超出安全范围` })
      continue
    }
    payload.push({
      source: line.source,
      nameSnapshot: line.name.trim(),
      specSnapshot: line.spec.trim() || null,
      ...(line.remark?.trim() ? { warrantySnapshot: { remark: line.remark.trim() } } : {}),
      qty,
      unitPriceCents: cents,
      productRef: line.source === 'new' ? line.productRef.trim() || null : null,
      stockItemId: line.source === 'used' ? line.stockItemId.trim() || null : null,
      customerDeviceRef: line.source === 'customer' ? line.customerDeviceRef.trim() || null : null,
    })
  }
  if (errors.length) return { ok: false, errors }
  if (!payload.length) return { ok: false, errors: [{ key: '', message: '至少填写一行有效配置' }] }
  return { ok: true, lines: payload }
}

export interface QuoteLineSummary { totalCents: number; incompleteCount: number; emptySlotCount: number; errorMessages: string[] }

export function summarizeQuoteEditorLines(lines: readonly QuoteEditorLine[], context: QuoteLineValidationContext = {}): QuoteLineSummary {
  let totalCents = 0
  let incompleteCount = 0
  let emptySlotCount = 0
  const errorMessages: string[] = []
  for (const line of lines) {
    if (isQuoteLineEmptySlot(line)) { emptySlotCount += 1; continue }
    const errors = validateQuoteEditorLine(line, context)
    if (errors.length) { incompleteCount += 1; errorMessages.push(...errors); continue }
    const cents = line.source === 'customer' ? 0 : parseYuan(line.priceYuan)
    const amount = cents === null ? NaN : cents * Number(line.qty)
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(totalCents + amount)) {
      incompleteCount += 1
      errorMessages.push(`${line.name.trim()}：金额合计超出安全范围`)
    } else totalCents += amount
  }
  return { totalCents, incompleteCount, emptySlotCount, errorMessages }
}
