// 自动生成：node contracts/tools/generate-catalog-contract.mjs；禁止手改。
export const CATALOG_VERSION = "v2.catalog.1" as const
export const CATALOG_IMAGE_PRESETS = {
  "cover": {
    "label": "商品列表图",
    "width": 710,
    "height": 500
  },
  "hero": {
    "label": "商城主推图",
    "width": 572,
    "height": 500
  }
} as const
export interface CatalogProduct {
  id: string
  title: string
  category: '整机' | '配件'
  description: string
  priceCents: number
  coverImageId: string | null
  heroImageId: string | null
  status: 'draft' | 'published' | 'unpublished'
  version: number
}
export interface CatalogWrite {
  product: CatalogProduct
  expectedVersion: number
  mutationId: string
}
export interface PublicCatalogProduct {
  id: string
  title: string
  category: '整机' | '配件'
  description: string
  priceCents: number
  coverUrl: string
  heroUrl: string | null
}
export interface CatalogImage {
  id: string
  storagePersistent: boolean
}
