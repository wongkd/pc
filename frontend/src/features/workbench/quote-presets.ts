import type { QuoteLineSource } from './quote-api.ts'

export type QuotePresetCategory =
  | 'CPU' | '散热器' | '主板' | '内存' | '显卡' | '固态硬盘' | '电源' | '机箱'
  | '装机服务' | '显示器' | '键鼠套装' | '机箱风扇' | '机械硬盘'
export type QuoteScenario = 'standard' | 'office' | 'upgrade' | 'blank'
export type QuoteLineOrigin = 'preset' | 'manual' | 'existing'

export interface QuoteEditorLine {
  key: string
  source: QuoteLineSource
  name: string
  spec: string
  remark?: string
  qty: string
  priceYuan: string
  productRef: string
  stockItemId: string
  customerDeviceRef: string
  category?: QuotePresetCategory
  origin?: QuoteLineOrigin
  initialSource?: QuoteLineSource
}

export const quoteScenarios: ReadonlyArray<{ id: QuoteScenario; label: string; categories: readonly QuotePresetCategory[] }> = [
  { id: 'standard', label: '标准独显主机', categories: ['CPU', '散热器', '主板', '内存', '显卡', '固态硬盘', '电源', '机箱'] },
  { id: 'office', label: '核显办公', categories: ['CPU', '散热器', '主板', '内存', '固态硬盘', '电源', '机箱'] },
  { id: 'upgrade', label: '旧机升级', categories: ['CPU', '主板', '内存', '固态硬盘', '装机服务'] },
  { id: 'blank', label: '空白报价', categories: [] },
]

export type KeyGenerator = () => string

export function createPresetLines(scenario: QuoteScenario, keygen: KeyGenerator): QuoteEditorLine[] {
  const categories = quoteScenarios.find((item) => item.id === scenario)?.categories ?? []
  if (scenario === 'blank') return [makeLine(undefined, 'new', keygen, 'preset')]
  return categories.map((category) => makeLine(category, category === '装机服务' ? 'service' : 'new', keygen, 'preset'))
}

function makeLine(category: QuotePresetCategory | undefined, source: QuoteLineSource, keygen: KeyGenerator, origin: QuoteLineOrigin): QuoteEditorLine {
  return { key: keygen(), source, name: '', spec: '', remark: '', qty: '1', priceYuan: '', productRef: '', stockItemId: '', customerDeviceRef: '', category, origin, initialSource: source }
}

export function hasQuoteLineInput(line: QuoteEditorLine): boolean {
  return Boolean(line.name.trim() || line.spec.trim() || line.remark?.trim() || line.priceYuan.trim() || line.productRef.trim() || line.stockItemId || line.customerDeviceRef || line.qty !== '1' || line.source !== (line.initialSource ?? line.source))
}

export function applyQuoteScenario(lines: readonly QuoteEditorLine[], from: QuoteScenario, to: QuoteScenario, keygen: KeyGenerator): QuoteEditorLine[] {
  if (from === to) return lines.map((line) => ({ ...line }))
  const working = lines.map((line) => ({ ...line }))
  const blankOnly = working.length === 1 && working[0].origin === 'preset' && !working[0].category && !hasQuoteLineInput(working[0])
  const retained = working.filter((line) => line.origin !== 'preset' || hasQuoteLineInput(line))
  const targetCategories = quoteScenarios.find((item) => item.id === to)?.categories ?? []
  if (to === 'blank') {
    const kept = retained
    return kept.length ? kept : [makeLine(undefined, 'new', keygen, 'preset')]
  }
  const sourceLines = blankOnly ? [] : retained
  const target: QuoteEditorLine[] = []
  for (const category of targetCategories) {
    const sameCategory = sourceLines.filter((line) => line.category === category)
    if (sameCategory.length) {
      target.push(...sameCategory)
      continue
    }
    if (sourceLines.some((line) => line.origin === 'manual' && line.category === category)) continue
    target.push(makeLine(category, category === '装机服务' ? 'service' : 'new', keygen, 'preset'))
  }
  const placed = new Set(target.map((line) => line.key))
  target.push(...sourceLines.filter((line) => !placed.has(line.key)))
  return target
}
