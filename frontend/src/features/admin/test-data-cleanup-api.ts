import { inventoryClient, type WriteOutcome } from '../workbench/inventory-api'

export interface UnusedProductCandidate {
  id: string
  sku: string | null
  name: string
  category: string
  createdAt: string
}

export function fetchUnusedProducts() {
  return inventoryClient.client.read<{ products: UnusedProductCandidate[] }>('/inventory/products/cleanup-candidates')
}

export function deleteUnusedProduct(productId: string, reason: string) {
  return inventoryClient.client.write<WriteOutcome>(`/inventory/products/${encodeURIComponent(productId)}/delete-unused`, {
    action: 'B46',
    entityId: productId,
    payload: { reason },
  })
}
