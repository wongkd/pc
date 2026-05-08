const currencyFormatter = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 2,
})

export function formatMoney(value: number): string {
  return currencyFormatter.format(Number.isFinite(value) ? value : 0)
}

export function sanitizeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function sumQuoteItems(
  items: Array<{ quantity: number; unitPrice: number }>,
): number {
  return items.reduce((total, item) => total + item.quantity * item.unitPrice, 0)
}
