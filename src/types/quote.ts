export type Orientation = 'portrait' | 'landscape'
export type PreviewMode = 'document' | 'customer'

export interface BrandInfo {
  companyName: string
  slogan: string
  logoDataUrl: string
  contactPerson: string
  contactPhone: string
  contactWechat: string
  contactAddress: string
}

export interface QuoteMeta {
  quoteNo: string
  quoteDate: string
  customerName: string
  contactName: string
  contactPhone: string
  projectTitle: string
}

export interface ViewSettings {
  previewMode: PreviewMode
  orientation: Orientation
}

export interface QuoteNotes {
  payment: string
  afterSales: string
  warranty: string
  remarks: string
}

export const DEFAULT_QUOTE_NOTES: QuoteNotes = {
  payment: '支持对公转账、微信转账或现款结算，具体以下单确认为准。',
  afterSales: '整机安装调试后交付，提供硬件质保支持，故障问题可协助远程排查。',
  warranty: '以收货日为准计算质保时长，整机一年质保，续保费用为整机费用 5% 每年。',
  remarks: '',
}

export function isQuoteNotes(value: unknown): value is QuoteNotes {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as QuoteNotes).payment === 'string' &&
    typeof (value as QuoteNotes).afterSales === 'string' &&
    typeof (value as QuoteNotes).warranty === 'string' &&
    typeof (value as QuoteNotes).remarks === 'string'
  )
}

export function migrateNotes(raw: unknown): QuoteNotes {
  if (isQuoteNotes(raw)) {
    return { ...DEFAULT_QUOTE_NOTES, ...raw }
  }
  if (typeof raw === 'string') {
    return { ...DEFAULT_QUOTE_NOTES, remarks: raw }
  }
  return { ...DEFAULT_QUOTE_NOTES }
}

export interface MerchantTemplate {
  id: string
  name: string
  brand: BrandInfo
  quoteItems: QuoteItem[]
  notes: QuoteNotes
  updatedAt: string
}

export interface HardwareLibraryItem {
  id: string
  cloudId?: number
  category: string
  description: string
  price: number
  image?: string
  lastRefreshed?: string
  sourcePlatform?: string
}

export interface QuoteItem {
  id: string
  category: string
  name: string
  details: string
  quantity: number
  unitPrice: number
  image?: string
  libraryItemId?: string
}

export interface QuoteDocument {
  brand: BrandInfo
  meta: QuoteMeta
  notes: QuoteNotes
  hardwareLibrary: HardwareLibraryItem[]
  quoteItems: QuoteItem[]
  categoryOrder?: string[]
}

export interface AppStorageData extends QuoteDocument {
  viewSettings: ViewSettings
}
