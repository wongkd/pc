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

export interface MerchantTemplate {
  id: string
  name: string
  brand: BrandInfo
  updatedAt: string
}

export interface HardwareLibraryItem {
  id: string
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

export interface TermsData {
  payment: string
  afterSales: string
  warranty: string
  remarks: string
}

export interface QuoteDocument {
  brand: BrandInfo
  meta: QuoteMeta
  notes: TermsData
  hardwareLibrary: HardwareLibraryItem[]
  quoteItems: QuoteItem[]
}

export interface AppStorageData extends QuoteDocument {
  viewSettings: ViewSettings
}
