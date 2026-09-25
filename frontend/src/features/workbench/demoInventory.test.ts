/**
 * T05b · 端内库存样本与契约的一致性测试。
 *
 * 契约规定 `fixtures.json` 不生成端内文件（dtoGeneration.notGenerated），
 * 所以端内样本是副本。本测试把它钉回契约 V5：任何一方漂移都会失败。
 *
 * 只做机械重算与字段比对，不重复实现业务规则。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEMO_BALANCES, DEMO_PRODUCTS, DEMO_STOCK_ITEMS, DEMO_MOVEMENTS } from './demoInventory'
import { ownOnHandQty } from './inventory-view'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const fixtures = JSON.parse(readFileSync(resolve(repoRoot, 'contracts/v1/fixtures.json'), 'utf8')) as {
  datasets: {
    V5: {
      products: Record<string, unknown>[]
      stockItems: Record<string, unknown>[]
      balances: Record<string, unknown>[]
      movements: Record<string, unknown>[]
    }
  }
}

const v5 = fixtures.datasets.V5

describe('V5 演示样本与契约', () => {
  it('商品、实物、余额、流水四条集合逐字段等于契约 V5', () => {
    expect(DEMO_PRODUCTS).toEqual(v5.products)
    expect(DEMO_STOCK_ITEMS).toEqual(v5.stockItems)
    expect(DEMO_BALANCES).toEqual(v5.balances)
    expect(DEMO_MOVEMENTS).toEqual(v5.movements)
  })

  it('演示标识由 DEMO- 前缀承载，不新增协议字段', () => {
    for (const p of DEMO_PRODUCTS) expect(p.productRef.startsWith('DEMO-')).toBe(true)
    for (const i of DEMO_STOCK_ITEMS) {
      expect(i.stockItemId.startsWith('DEMO-')).toBe(true)
      expect(i.productRef.startsWith('DEMO-')).toBe(true)
    }
  })

  it('样本字段不超出契约对象定义的范围（不发明契约外的字段）', () => {
    // StockItem 的契约字段集合（objects.json）：样本不得出现表外字段。
    const allowed = new Set([
      'stockItemId',
      'assetCode',
      'productRef',
      'condition',
      'snRaw',
      'snNormalized',
      'ownership',
      'availability',
      'location',
      'acquisitionRef',
      'acquisitionCostCents',
      'refurbishmentCostCents',
      'costKnown',
    ])
    for (const item of v5.stockItems) {
      for (const key of Object.keys(item)) {
        expect(allowed.has(key), `样本出现契约外字段 ${key}`).toBe(true)
      }
    }
  })

  it('数量守恒：每条余额等于流水净和（to_bucket +qty、from_bucket −qty）', () => {
    const recomputed = new Map<string, { available: number; reserved: number; quarantine: number }>()
    for (const m of v5.movements as Array<Record<string, never>>) {
      const productRef = String(m.productRef)
      const cur = recomputed.get(productRef) ?? { available: 0, reserved: 0, quarantine: 0 }
      const to = m.toBucket as unknown as 'available' | 'reserved' | 'quarantine' | null
      const from = m.fromBucket as unknown as 'available' | 'reserved' | 'quarantine' | null
      if (to) cur[to] += Number(m.qty)
      if (from) cur[from] -= Number(m.qty)
      recomputed.set(productRef, cur)
    }
    for (const b of v5.balances as Array<Record<string, never>>) {
      const c = recomputed.get(String(b.productRef)) ?? { available: 0, reserved: 0, quarantine: 0 }
      expect(c.available).toBe(Number(b.availableQty))
      expect(c.reserved).toBe(Number(b.reservedQty))
      expect(c.quarantine).toBe(Number(b.quarantineQty))
    }
  })

  it('在途与客户保管不落在余额三桶内', () => {
    const side = (v5.stockItems as Array<Record<string, never>>).filter(
      (i) => i.availability === 'in_transit' || i.availability === 'customer_custody',
    )
    expect(side.length).toBeGreaterThan(0)
    const ownTotal = DEMO_BALANCES.reduce((sum, b) => sum + ownOnHandQty(b), 0)
    // GPU 自有在库 2 件（U-017、N-201），在途 1 件与客户保管 1 件都不计入。
    const gpu = DEMO_BALANCES.find((b) => b.productRef === 'DEMO-PRODUCT-GPU')
    expect(ownOnHandQty(gpu!)).toBe(2)
    expect(ownTotal).toBe(2 + 2 + 16 + 2)
  })
})
