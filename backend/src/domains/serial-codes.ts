/**
 * 内部识别码与厂家 SN 分开存储。
 * 号码由服务端产生；数据库的门店级唯一约束负责最终防重。
 */
export function generateInternalCode(kind: 'IT' | 'BT' | 'DV', storeId: number, occurredAt?: string | null): string {
  const source = occurredAt ? new Date(occurredAt) : new Date()
  const day = Number.isNaN(source.getTime())
    ? new Date().toISOString().slice(0, 10).replace(/-/g, '')
    : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(source)
        .replace(/-/g, '')
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  return `${kind}-${String(storeId).padStart(4, '0')}-${day}-${suffix}`
}

export function normalizeManufacturerSn(value: string | null | undefined): string | null {
  const raw = value?.trim()
  return raw ? raw.replace(/\s+/g, '').toUpperCase() : null
}
