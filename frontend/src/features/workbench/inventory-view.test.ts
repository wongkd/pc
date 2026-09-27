/**
 * T05b · 库存显示口径测试（网页端）。
 *
 * 这里测的是**口径**，不是排版：三桶怎么算、未知成本怎么显示、无权限时字段存不存在。
 * 这些一旦写错不会报错，只会让人看错账 —— 所以必须有机器验证。
 * 小程序侧有同名文件由 `check-client-parity.mjs` 与本文件对应的常量逐项比对。
 */
import { describe, expect, it } from 'vitest'

import {
  BUCKET_LABELS,
  CONDITION_LABELS,
  LOCATION_LABELS,
  MOVEMENT_SOURCE_LABELS,
  OWNERSHIP_LABELS,
  OWN_ON_HAND_BUCKETS,
  STATUS_LABELS,
  TRACKING_LABELS,
  bucketGroups,
  buildInventoryRows,
  costCellText,
  costText,
  filterProductRows,
  formatCents,
  formatYuan,
  isOwnOnHand,
  itemCostCents,
  ownOnHandQty,
  productMatches,
} from './inventory-view'
import { DEMO_BALANCES, DEMO_PRODUCTS, DEMO_STOCK_ITEMS } from './demoInventory'

const ROWS = buildInventoryRows(DEMO_PRODUCTS, DEMO_BALANCES, DEMO_STOCK_ITEMS)

describe('金额格式化', () => {
  it('分转元并保留两位，不用 toLocaleString（小程序 JSCore 的 Intl 不完整）', () => {
    expect(formatCents(0)).toBe('0.00')
    expect(formatCents(88000)).toBe('880.00')
    expect(formatCents(128000050)).toBe('1,280,000.50')
    expect(formatYuan(286000)).toBe('¥2,860.00')
  })

  it('负数保留负号（退款与冲销场景）', () => {
    expect(formatCents(-10000)).toBe('-100.00')
  })
})

describe('三桶口径（03 §4 L84）', () => {
  it('只有可卖 / 已订 / 待处理计入自有在库量', () => {
    expect(OWN_ON_HAND_BUCKETS).toEqual(['available', 'reserved', 'quarantine'])
    expect(isOwnOnHand('available')).toBe(true)
    expect(isOwnOnHand('in_transit')).toBe(false)
    expect(isOwnOnHand('customer_custody')).toBe(false)
  })

  it('自有在库量 = 三桶之和', () => {
    const ssd = DEMO_BALANCES.find((b) => b.productRef === 'DEMO-PRODUCT-SSD')!
    expect(ownOnHandQty(ssd)).toBe(16)
  })

  it('三桶分组顺序固定为可卖 → 已订 → 待处理', () => {
    const gpu = DEMO_BALANCES.find((b) => b.productRef === 'DEMO-PRODUCT-GPU')!
    expect(bucketGroups(gpu).map((g) => g.label)).toEqual(['可卖', '已订', '待处理'])
    expect(bucketGroups(gpu).map((g) => g.qty)).toEqual([2, 0, 0])
  })
})

describe('成本口径（03 §1 R01、04 §3 L57）', () => {
  it('未知成本写「成本未知」，不得写成 0', () => {
    expect(costText(null, false)).toBe('成本未知')
    expect(costText(0, false)).toBe('成本未知')
    expect(costText(null, true)).toBe('成本未知')
    expect(costText(88000, true)).toBe('¥880.00')
  })

  it('无成本权限时成本单元格返回 null —— 整列不渲染，不是置空', () => {
    expect(costCellText(88000, true, false)).toBeNull()
    expect(costCellText(88000, true, true)).toBe('¥880.00')
    expect(costCellText(null, false, true)).toBe('成本未知')
  })

  it('单件成本 = 取得成本 + 整备成本，未知为 null', () => {
    const u017 = DEMO_STOCK_ITEMS.find((i) => i.assetCode === 'U-017')!
    expect(itemCostCents(u017)).toBe(88000)
    const u032 = DEMO_STOCK_ITEMS.find((i) => i.assetCode === 'U-032')!
    expect(itemCostCents(u032)).toBeNull()
  })
})

describe('搜索与筛选', () => {
  it('型号名、品牌、规格、SKU 都参与匹配', () => {
    const gpu = DEMO_PRODUCTS.find((p) => p.productRef === 'DEMO-PRODUCT-GPU')!
    expect(productMatches(gpu, '影驰')).toBe(true)
    expect(productMatches(gpu, '4060')).toBe(true)
    expect(productMatches(gpu, '金士顿')).toBe(false)
  })

  it('按编号或 SN 能搜到对应型号', () => {
    const found = filterProductRows(ROWS, DEMO_STOCK_ITEMS, { q: 'U-017', condition: 'all', availability: 'all' })
    expect(found.map((r) => r.product.productRef)).toEqual(['DEMO-PRODUCT-GPU'])
  })

  it('按可用性筛选：在途型号能被筛出来，但它不在三桶里', () => {
    const found = filterProductRows(ROWS, DEMO_STOCK_ITEMS, { q: '', condition: 'all', availability: 'in_transit' })
    expect(found.map((r) => r.product.productRef)).toEqual(['DEMO-PRODUCT-GPU'])
    expect(found[0].balance.availableQty).toBe(2)
  })

  it('按成色筛选二手，只有含二手实物的型号留下', () => {
    const found = filterProductRows(ROWS, DEMO_STOCK_ITEMS, { q: '', condition: 'used', availability: 'all' })
    expect(found.map((r) => r.product.productRef).sort()).toEqual(['DEMO-PRODUCT-GPU', 'DEMO-PRODUCT-MB'])
  })

  it('空关键词不做过滤', () => {
    expect(filterProductRows(ROWS, DEMO_STOCK_ITEMS, { q: '', condition: 'all', availability: 'all' })).toHaveLength(4)
  })
})

describe('标签表（两端必须一致，由跨端门禁比对）', () => {
  it('枚举标签覆盖全部取值', () => {
    expect(BUCKET_LABELS.in_transit).toBe('在途')
    expect(BUCKET_LABELS.customer_custody).toBe('客户保管')
    expect(CONDITION_LABELS).toEqual({ new: '新品', used: '二手' })
    expect(OWNERSHIP_LABELS).toEqual({ store: '门店所有', customer: '客户所有', vendor: '供应商所有' })
    expect(LOCATION_LABELS).toEqual({ store: '店内', customer: '客户处', external: '外部', supplier: '供应商处' })
    expect(TRACKING_LABELS).toEqual({ item: '逐件管理', quantity: '按数量' })
    expect(STATUS_LABELS).toEqual({ active: '启用', disabled: '已停用' })
    expect(Object.keys(MOVEMENT_SOURCE_LABELS)).toHaveLength(17)
  })
})
