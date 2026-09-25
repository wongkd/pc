/**
 * P2 ERP 总集成：在同一个真实 Worker + 内存 D1 中跑完一位客户的本地经营生命周期。
 *
 * 报价确认 → 转销售单 → 缺货 → 采购/到货/付款 → 补占用 → 装机检测/交付
 * → 售后维修/收款/归还 → 回收取得所有权 → 新销售单抵用 → 账本核对。
 *
 * 边界：本测试不连接远端、不部署、不代替浏览器、微信或生产验收。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createWorkerEnv, seedOwner, login, createClient } from './lib/worker.mjs'
import { seedProduct } from './lib/inventory.mjs'

const OWNER = {
  email: 'p2-owner@local.test',
  password: 'local-preview-pass',
  storeId: 1,
  userId: 1,
  storeName: 'P2 总集成门店',
}

const json = async (response) => ({ status: response.status, body: await response.json() })

async function expectOk(promise, label) {
  const result = await promise
  assert.equal(result.status, 200, `${label}: ${JSON.stringify(result.body)}`)
  return result.body.data
}

async function post(client, path, body, label) {
  return expectOk(json(await client.post(path, body)), label)
}

async function get(client, path, label) {
  return expectOk(json(await client.get(path)), label)
}

async function createCustomer(db) {
  const result = await db.prepare(
    `INSERT INTO customers (store_id, name, phone, status, created_by, updated_by)
     VALUES (1, '林女士', '13900002026', 'active', 1, 1)`,
  ).run()
  return result.meta.last_row_id
}

async function seedAvailableItem(db, { id, productId, assetCode }) {
  await db.prepare(
    `INSERT INTO stock_items
       (id, store_id, product_id, asset_code, condition, ownership, availability, location,
        acquisition_cost_cents, cost_known, version)
     VALUES (?, 1, ?, ?, 'new', 'store', 'available', 'store', 12000, 1, 1)`,
  ).bind(id, productId, assetCode).run()
  await db.prepare(
    `INSERT INTO inventory_movements
       (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
        source, occurred_at, actor_user_id, request_id)
     VALUES (?, 1, ?, ?, 1, NULL, 'available', 12000, 'opening_balance', ?, 1, ?)`,
  ).bind(`${id}::seed`, productId, id, new Date().toISOString(), `${id}::seed`).run()
}

async function quoteToSale(client, { tag, customerId, productRef, totalCents, depositCents }) {
  const created = await post(client, '/api/v2/sales/quotes', {
    requestId: `${tag}-quote`,
    title: `${tag} 报价`,
    customerId,
    lines: [{
      source: 'new',
      nameSnapshot: `${tag} 整机`,
      specSnapshot: 'P2 本地总集成配置',
      qty: 1,
      unitPriceCents: totalCents,
      productRef,
    }],
  }, `${tag} 建报价`)
  const quoteId = created.entityId

  const issued = await post(client, `/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/issue`, {
    requestId: `${tag}-issue`,
    expectedVersion: created.entityVersion,
  }, `${tag} 发报价`)
  const revision = issued.effects.revision

  await post(client, `/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/confirm`, {
    requestId: `${tag}-quote-confirm`,
    source: 'offline',
  }, `${tag} 顾客确认报价`)

  const converted = await post(client, `/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/convert`, {
    requestId: `${tag}-convert`,
    quoteVersion: revision,
  }, `${tag} 报价转销售单`)
  const orderId = converted.entityId

  await post(client, `/api/v2/sales/orders/${encodeURIComponent(orderId)}/payments`, {
    requestId: `${tag}-deposit`,
    amountCents: depositCents,
    method: 'wechat',
    verificationState: 'verified',
  }, `${tag} 收定金`)
  await post(client, `/api/v2/sales/orders/${encodeURIComponent(orderId)}/confirm`, {
    requestId: `${tag}-sale-confirm`,
  }, `${tag} 确认成交`)

  return { quoteId, orderId }
}

test('P2：报价到交付、售后、回收抵用与账本在同一真实本地流程闭环', async (t) => {
  const env = await createWorkerEnv()
  t.after(() => env.dispose())
  const db = env.db
  await seedOwner(db, OWNER)
  const client = createClient(env.call, await login(env.call, OWNER))
  const customerId = await createCustomer(db)

  // 1. 报价 → 顾客确认 → 成交；无库存时只形成真实缺口，不伪造预留。
  const buildProduct = await seedProduct(db, {
    entityId: 'p2-build-product', name: 'P2 装机套件', trackingMode: 'quantity',
  })
  const firstSale = await quoteToSale(client, {
    tag: 'p2-main', customerId, productRef: buildProduct.entityId,
    totalCents: 120_000, depositCents: 20_000,
  })
  const shortage = await get(client, `/api/v2/sales/orders/${encodeURIComponent(firstSale.orderId)}`, '读取成交缺口')
  assert.equal(shortage.shortage[0].shortageQty, 1)

  // 2. 采购 → 到货入库 → 采购付款 → 为已成交销售单补占用。
  const purchase = await post(client, '/api/v2/inventory/purchases', {
    requestId: 'p2-purchase',
    supplierName: 'P2 本地供应商',
    lines: [{
      productRef: buildProduct.entityId,
      nameSnapshot: 'P2 装机套件',
      qtyOrdered: 1,
      unitCostCents: 60_000,
    }],
  }, '创建采购单')
  const purchaseDetail = await get(
    client,
    `/api/v2/inventory/purchases/${encodeURIComponent(purchase.entityId)}`,
    '读取采购单',
  )
  const purchaseLineId = purchaseDetail.lines[0].id
  await post(client, '/api/v2/inventory/receipts', {
    requestId: 'p2-receipt',
    purchaseId: purchase.entityId,
    lines: [{
      purchaseLineId,
      productRef: buildProduct.entityId,
      qtyReceived: 1,
      disposition: 'available',
    }],
  }, '采购到货')
  await post(client, '/api/v2/finance/payments', {
    requestId: 'p2-purchase-pay',
    sourceDocument: `purchase:${purchase.entityId}`,
    amountCents: 60_000,
    method: 'bank',
    remark: 'P2 采购款结清',
  }, '登记采购付款')
  const allocated = await post(
    client,
    `/api/v2/sales/orders/${encodeURIComponent(firstSale.orderId)}/allocate`,
    { requestId: 'p2-allocate' },
    '到货后补占用',
  )
  assert.equal(allocated.effects.reservedQty, 1)

  // 3. 尾款 → 备料 → 检测 → 交付；交付才正式扣库存。
  await post(client, `/api/v2/sales/orders/${encodeURIComponent(firstSale.orderId)}/payments`, {
    requestId: 'p2-main-balance',
    amountCents: 100_000,
    method: 'bank',
    verificationState: 'verified',
  }, '销售尾款结清')
  await post(client, `/api/v2/sales/orders/${encodeURIComponent(firstSale.orderId)}/start-assembly`, {
    requestId: 'p2-assembly-start', location: 'store',
  }, '开始备料')
  await post(client, `/api/v2/sales/orders/${encodeURIComponent(firstSale.orderId)}/start-assembly`, {
    requestId: 'p2-assembly-ready', location: 'store',
  }, '提交检测')
  await post(client, `/api/v2/sales/orders/${encodeURIComponent(firstSale.orderId)}/checks`, {
    requestId: 'p2-checks',
    templateVersion: 'p2-v1',
    configurationVersion: 0,
    items: [
      { key: 'appearance', label: '外观', kind: 'check', state: 'pass' },
      { key: 'boot', label: '点亮', kind: 'test', state: 'pass' },
      { key: 'burn', label: '烤机', kind: 'test', state: 'pass' },
    ],
  }, '装机检测通过')
  const delivered = await post(client, `/api/v2/sales/orders/${encodeURIComponent(firstSale.orderId)}/deliver`, {
    requestId: 'p2-deliver',
    configurationVersion: 0,
    deliveryNote: '林女士到店验机自提',
  }, '装机交付')
  assert.equal(delivered.state, 'delivered')

  // 4. 售后：接修、诊断、报价确认、换件、收款、复测、归还。
  const servicePart = await seedProduct(db, {
    entityId: 'p2-service-part', name: 'P2 售后备件', trackingMode: 'item',
  })
  await seedAvailableItem(db, {
    id: 'p2-service-stock', productId: servicePart.hardwareId, assetCode: 'P2-SERVICE-001',
  })
  const service = await post(client, '/api/v2/service/orders', {
    requestId: 'p2-service-intake',
    customerName: '林女士',
    deviceCode: 'P2-PC-2026',
    symptom: '运行中偶发蓝屏',
  }, '售后接修')
  await post(client, `/api/v2/service/orders/${encodeURIComponent(service.entityId)}/diagnosis`, {
    requestId: 'p2-service-diagnosis', diagnosisNote: '内存故障',
  }, '售后诊断')
  await post(client, `/api/v2/service/orders/${encodeURIComponent(service.entityId)}/proposal`, {
    requestId: 'p2-service-proposal',
    items: [{ name: '更换内存', qty: 1, unitPriceCents: 20_000, chargeType: 'charge' }],
    chargeCents: 20_000,
    warrantyDecision: 'out_of_warranty',
  }, '售后方案')
  await post(client, `/api/v2/service/orders/${encodeURIComponent(service.entityId)}/confirm-proposal`, {
    requestId: 'p2-service-confirm',
    proposalVersion: 1,
    confirmationMethod: 'phone',
    confirmedAt: '2026-09-23T02:00:00Z',
    accepted: true,
  }, '确认售后方案')
  await post(client, `/api/v2/service/orders/${encodeURIComponent(service.entityId)}/replace`, {
    requestId: 'p2-service-replace',
    approvedProposalVersion: 1,
    components: [{
      oldComponentRef: '原内存',
      oldItemDisposition: 'quarantine',
      newStockItem: 'p2-service-stock',
      qty: 1,
      chargeType: 'charge',
    }],
  }, '售后换件')
  await post(client, `/api/v2/service/orders/${encodeURIComponent(service.entityId)}/payments`, {
    requestId: 'p2-service-pay',
    amountCents: 20_000,
    method: 'wechat',
    occurredAt: '2026-09-23T03:00:00Z',
    remark: '售后结清',
  }, '售后收款')
  await post(client, `/api/v2/service/orders/${encodeURIComponent(service.entityId)}/retest`, {
    requestId: 'p2-service-retest', passed: true,
  }, '售后复测')
  const returned = await post(client, `/api/v2/service/orders/${encodeURIComponent(service.entityId)}/return`, {
    requestId: 'p2-service-return', returnedTo: '林女士本人',
  }, '售后归还')
  assert.equal(returned.state, 'returned')

  // 5. 同一客户回收旧机，并把部分回收款抵到下一张销售单。
  const upgradeProduct = await seedProduct(db, {
    entityId: 'p2-upgrade-product', name: 'P2 升级整机', trackingMode: 'quantity',
  })
  const secondSale = await quoteToSale(client, {
    tag: 'p2-upgrade', customerId, productRef: upgradeProduct.entityId,
    totalCents: 90_000, depositCents: 15_000,
  })
  const usedHost = await seedProduct(db, {
    entityId: 'p2-used-host', name: 'P2 回收旧机', trackingMode: 'item',
  })
  const recovery = await post(client, '/api/v2/recovery/orders', {
    requestId: 'p2-recovery-register',
    sellerName: '林女士',
    sellerPhone: '13900002026',
    sellerCustomerId: customerId,
    items: [{ description: '旧办公整机', condition: 'used', snRaw: 'P2-OLD-PC-001' }],
    initialEstimateCents: 40_000,
  }, '登记回收')
  await post(client, `/api/v2/recovery/orders/${encodeURIComponent(recovery.entityId)}/inspect`, {
    requestId: 'p2-recovery-inspect', note: '功能正常，外壳轻微磨损',
  }, '回收验机')
  const recoveryDetail = await get(
    client,
    `/api/v2/recovery/orders/${encodeURIComponent(recovery.entityId)}`,
    '读取回收明细',
  )
  const recoveryItemId = recoveryDetail.items[0].id
  await post(client, `/api/v2/recovery/orders/${encodeURIComponent(recovery.entityId)}/offer`, {
    requestId: 'p2-recovery-offer',
    itemPrices: [{ recoveryItemId, estimatedCents: 40_000 }],
    note: '双方确认最终回收价',
  }, '回收报价')
  await post(client, `/api/v2/recovery/orders/${encodeURIComponent(recovery.entityId)}/acquire`, {
    requestId: 'p2-recovery-acquire',
    finalAcquisitionCents: 40_000,
    evidenceRef: 'P2 本地签收凭据',
    lines: [{
      recoveryItemId,
      productRef: usedHost.entityId,
      assetCode: 'P2-RECOVERY-001',
      snRaw: 'P2-OLD-PC-001',
      costCents: 40_000,
    }],
  }, '取得回收所有权')
  const saleVersion = await db.prepare('SELECT version FROM sale_orders WHERE id = ?')
    .bind(secondSale.orderId).first('version')
  const recoveryVersion = await db.prepare('SELECT version FROM recovery_orders WHERE id = ?')
    .bind(recovery.entityId).first('version')
  const tradeIn = await post(client, '/api/v2/trade-ins', {
    requestId: 'p2-tradein-create',
    saleOrderId: secondSale.orderId,
    recoveryId: recovery.entityId,
    saleOrderVersion: saleVersion,
    recoveryVersion,
  }, '建立抵用关联')
  await post(client, `/api/v2/trade-ins/${encodeURIComponent(tradeIn.entityId)}/apply-offset`, {
    requestId: 'p2-tradein-offset',
    amountCents: 35_000,
    saleOrderVersion: saleVersion,
    recoveryVersion,
  }, '应用抵用额度')
  const tradeInDetail = await get(
    client,
    `/api/v2/trade-ins/${encodeURIComponent(tradeIn.entityId)}`,
    '读取抵用结果',
  )
  assert.equal(tradeInDetail.validOffsetCents, 35_000)
  assert.equal(tradeInDetail.saleOrder.balanceCents, 40_000)
  assert.equal(tradeInDetail.recoveryPayableRemainingCents, 5_000)

  // 6. R12 账本同时看见销售/售后现金流、采购支出与销售应收。
  // 当前 payable 契约只汇总采购；回收剩余应付由 R10/R11 明细承载，已在上面核对为 5000。
  const overview = await get(client, '/api/v2/finance/overview', '读取账本汇总')
  assert.ok(overview.cash.inTotalCents >= 150_000)
  assert.ok(overview.cash.outTotalCents >= 60_000)
  assert.ok(overview.receivable.totalCents >= 40_000)
  assert.equal(overview.payable.totalCents, 0, '本流程采购款已结清')
  const entries = await get(client, '/api/v2/finance/entries?limit=100', '读取资金流水')
  assert.ok(entries.entries.some((entry) => entry.purpose === 'purchase' && entry.direction === 'out'))
  assert.ok(entries.entries.some((entry) => entry.purpose === 'sale_order' && entry.direction === 'in'))
  assert.ok(entries.entries.some((entry) => entry.purpose === 'service_order' && entry.direction === 'in'))
})
