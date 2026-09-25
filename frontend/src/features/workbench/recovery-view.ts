/** 元输入 → 整数分。空串 / 非法输入返回 null。 */
function yuanToCents(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}

function centsToYuan(cents: number | null): string {
  if (cents === null || cents === undefined) return ''
  return String(cents / 100)
}

/**
 * 报价输入尚未被用户编辑时，表单展示的是服务端逐件估价；提交也必须沿用同一个值。
 * 否则受控输入看起来有金额，offerPrices 里却没有键，最终会静默提交 0 元。
 */
export function resolveOfferPriceCents(inputValue: string | undefined, estimatedCents: number | null): number {
  return yuanToCents(inputValue ?? centsToYuan(estimatedCents)) ?? 0
}
