/**
 * 本地预览后端（隔离环境，不连远端）。
 *
 * 为什么需要它：
 *   网页端 dev 时若把 /api 指向线上 Worker，就是在**拿生产库当调试库**；
 *   而完全不代理，页面只会拿到 Vite 的 index.html，所有列表都停在失败态，
 *   等于没法评审界面。两者都不是可接受的默认值。
 *
 * 做法：用 miniflare 在本机 workerd 里跑**真实的 Worker 入口**
 *   （`backend/src/index.ts`，与生产同一份源码、同一套 migrations），
 *   内存 D1，播种演示数据，监听 127.0.0.1。
 *
 * 边界（务必遵守）：
 *   · 只监听回环地址，不对外暴露；不 deploy、不应用远端迁移、不读生产数据。
 *   · 数据每次启动重建，改了源码重启即生效。
 *   · 这里的东西是**演示数据**，界面与文档都应标明，不能当营业数据。
 *
 * 用法：
 *   node scripts/dev-server.mjs            # 默认 127.0.0.1:8787
 *   PORT=8899 node scripts/dev-server.mjs
 */

import { createServer } from 'node:http'

import { createWorkerEnv, seedOwner, login } from '../tests/lib/worker.mjs'

const PORT = Number(process.env.PORT || 8787)
const HOST = '127.0.0.1'
const OPENING_MODE = process.env.PREVIEW_INVENTORY_OPENING_MODE || 'preview'
if (OPENING_MODE !== 'preview' && OPENING_MODE !== 'formal') {
  throw new Error('PREVIEW_INVENTORY_OPENING_MODE 仅支持 preview 或 formal')
}

const OWNER = {
  email: process.env.PREVIEW_EMAIL || 'owner@local.test',
  password: process.env.PREVIEW_PASSWORD || 'local-preview-pass',
  storeId: 1,
  userId: 1,
  storeName: '本地预览门店（演示数据）',
}

/** 演示客户：刻意包含「不留电话的散客」和「带机器来店的客户」两类，方便看空值与设备归属。 */
const DEMO_CUSTOMERS = [
  { name: '陈师傅（散客，只留姓）', phone: '', remark: '隔壁铺面老板，常来问价', devices: [] },
  { name: '吴女士（散客，只留姓）', phone: '', remark: '先留个档，回头带配置单来', devices: [] },
  {
    name: '林建国', phone: '13800001234', email: 'lin@example.test', address: '湛江市赤坎区',
    remark: '老客户，2024 年配过一台办公机',
    devices: [{ label: '戴尔 OptiPlex 7080 主机', serialNumber: 'DL7080-88231', remark: '外店机器，开机点不亮，来店检测' }],
  },
  {
    name: '湛江智诚贸易有限公司', phone: '0759-88886666', email: 'hr@zhicheng.example.test', address: '湛江市霞山区人民大道',
    remark: '公司批量采购，走对公转账',
    devices: [
      { label: '联想 ThinkPad T14 Gen4', serialNumber: 'PF4T14G4-0091', remark: '员工离职回收，待检测' },
      { label: '群晖 DS923+ NAS', serialNumber: '', remark: '客户自己的存储，暂存店内两天' },
    ],
  },
  { name: '黄小满', phone: '13800005678', remark: '要一台 2K 游戏主机，预算 8000', devices: [] },
]

/** 演示订单：只用于让客户页的「累计金额 / 订单数」有真实依据，且带一笔无电话的散单验证归属口径。 */
const DEMO_ORDERS = [
  { orderNo: 'PRE-20260919-001', customerName: '林建国', phone: '13800001234', title: '办公主机整机', total: 468000, received: 468000, status: 'delivered' },
  { orderNo: 'PRE-20260919-002', customerName: '湛江智诚贸易有限公司', phone: '0759-88886666', title: '5 台办公整机 + 装机调试', total: 2150000, received: 322500, status: 'pending_purchase' },
  { orderNo: 'PRE-20260919-003', customerName: '黄小满', phone: '13800005678', title: '2K 游戏主机（待确认配置）', total: 786000, received: 0, status: 'pending_purchase' },
  { orderNo: 'PRE-20260919-004', customerName: '门店散单（未留电话）', phone: '', title: '内存条 + 硅脂，现场付款', total: 39800, received: 39800, status: 'delivered' },
]

/**
 * 演示商品与期初库存。
 *
 * 刻意**走真实 HTTP 路由**（B12 / B13）而不是直接写表：这样本地预览看到的库存
 * 与线上同一条链路产生；播种失败会直接报错，不会悄悄留下半截演示数据。
 */
const DEMO_PRODUCTS = [
  { key: 'gpu', name: '影驰 RTX 4060 Ti 金属大师', sku: 'GPU-4060TI-METAL', category: '显卡', brand: '影驰', specs: '8G / GDDR6', trackingMode: 'quantity', requiresSn: false, defaultSalePriceCents: 259900 },
  { key: 'mb', name: '华硕 TUF B760M-PLUS', sku: 'MB-B760M-PLUS', category: '主板', brand: '华硕', specs: 'DDR5 / mATX', trackingMode: 'quantity', requiresSn: false, defaultSalePriceCents: 89900 },
  { key: 'ssd', name: '金士顿 NV2 1TB', sku: 'SSD-NV2-1T', category: '硬盘', brand: '金士顿', specs: 'NVMe PCIe4', trackingMode: 'quantity', requiresSn: false, defaultSalePriceCents: 39900 },
  { key: 'ram', name: '金百达 DDR5 16GB 6000', sku: 'RAM-DDR5-16G', category: '内存', brand: '金百达', specs: '6000MHz', trackingMode: 'quantity', requiresSn: false, defaultSalePriceCents: 27900 },
  { key: 'used', name: '二手 华硕 TUF RTX 3080', sku: 'GPU-USED-3080', category: '显卡', brand: '华硕', specs: '10G / 拆机件', trackingMode: 'item', requiresSn: true, defaultSalePriceCents: 169900 },
]

/**
 * 本地预览专用销售角色种子。权限表没有全局种子迁移，所以隔离内存库必须显式准备
 * `sales` 角色，否则“不指定角色”的邀请无法接受。这里仅给销售与客户读写权限，
 * 不授予库存写入、财务、售后、回收、成员管理或老板专属动作；不代表远端角色政策。
 */
const DEMO_SALES_PERMISSIONS = [
  'sales/quote-view',
  'sales/quote-edit',
  'sales/quote-convert',
  'sales/order-view',
  'sales/order-edit',
  'inventory/view',
]

async function seedSalesRole(db, storeId = OWNER.storeId) {
  const role = await db.prepare('INSERT INTO roles (store_id, code, name) VALUES (?, ?, ?)')
    .bind(storeId, 'sales', '销售（本地演示）').run()

  for (const code of DEMO_SALES_PERMISSIONS) {
    await db.prepare('INSERT INTO permissions (code, name) VALUES (?, ?)').bind(code, code).run()
    const permission = await db.prepare('SELECT id FROM permissions WHERE code = ?').bind(code).first()
    await db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)')
      .bind(role.meta.last_row_id, permission.id).run()
  }
}

async function seedInventory(call, owner) {
  const token = await login(call, owner)
  const post = async (path, body) => {
    const response = await call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`演示库存播种失败（${path} ${response.status}）：${text}`)
    return JSON.parse(text).data
  }

  const refs = {}
  for (const product of DEMO_PRODUCTS) {
    const created = await post('/api/v2/inventory/products', { ...product, key: undefined, requestId: `demo-product-${product.key}` })
    refs[product.key] = created.entityId
  }

  // 正式模式只播种商品，不造旧格式库存；由本地浏览器从开启窗口开始验正式流程。
  if (OPENING_MODE === 'formal') return refs

  // 期初：成本口径刻意分两种，页面上要能同时看到「金额」和「成本未知」两种呈现。
  await post('/api/v2/inventory/openings', {
    approvedCountRef: '演示实盘 2026-09-19',
    costBasis: { kind: 'known', note: '按最后一批进货单' },
    note: '本地预览用演示期初',
    lines: [
      { productRef: refs.gpu, qty: 2, unitCostCents: 286000 },
      { productRef: refs.ssd, qty: 5, unitCostCents: 26000 },
      { productRef: refs.ram, qty: 4, unitCostCents: 19000 },
    ],
    requestId: 'demo-opening-known',
  })
  await post('/api/v2/inventory/openings', {
    approvedCountRef: '演示实盘 2026-09-19',
    costBasis: { kind: 'unknown', note: '早批进货单已丢，成本说不清' },
    lines: [{ productRef: refs.mb, qty: 3 }],
    requestId: 'demo-opening-unknown',
  })
  await post('/api/v2/inventory/openings', {
    approvedCountRef: '演示实盘 2026-09-19',
    costBasis: { kind: 'known' },
    lines: [
      { productRef: refs.used, qty: 1, condition: 'used', assetCode: 'U-3080-001', snRaw: 'SN3080-001', unitCostCents: 112000 },
      { productRef: refs.used, qty: 1, condition: 'used', assetCode: 'U-3080-002', snRaw: 'SN3080-002', unitCostCents: 118000 },
    ],
    requestId: 'demo-opening-used',
  })
}

/**
 * 另列区的两件演示实物：在途一件、客户保管一件。
 *
 * 只能直接写表 —— 采购到货（B15）与接修（B20）分别属别的卡，本卡没有能产生这两种状态的接口。
 * 它们只影响页面上「在途 / 客户保管」两个另列区，**不进库存余额**（stock_balances 里没有这两列）。
 */
async function seedSideBuckets(db, storeId, actorUserId, productId) {
  await db.prepare(`INSERT INTO stock_items
      (id, store_id, product_id, asset_code, condition, sn_raw, sn_normalized,
       ownership, availability, location, acquisition_ref, acquisition_cost_cents, cost_known, created_by)
    VALUES ('demo-in-transit-1', ?, ?, 'T-IT-001', 'new', NULL, NULL,
       'store', 'in_transit', 'supplier', 'demo-purchase', 259900, 1, ?)`)
    .bind(storeId, productId, actorUserId).run()
  await db.prepare(`INSERT INTO stock_items
      (id, store_id, product_id, asset_code, condition, sn_raw, sn_normalized,
       ownership, availability, location, acquisition_ref, acquisition_cost_cents, cost_known, created_by)
    VALUES ('demo-custody-1', ?, ?, 'C-CU-001', 'used', 'SN-CU-001', 'SN-CU-001',
       'customer', 'customer_custody', 'customer', NULL, NULL, 0, ?)`)
    .bind(storeId, productId, actorUserId).run()
}

async function seedDemo(db) {
  await seedOwner(db, OWNER)
  await seedSalesRole(db)

  for (const customer of DEMO_CUSTOMERS) {
    const created = await db.prepare(`INSERT INTO customers (store_id, name, phone, email, address, remark, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(OWNER.storeId, customer.name, customer.phone, customer.email ?? '', customer.address ?? '', customer.remark ?? '', OWNER.userId, OWNER.userId)
      .run()
    for (const device of customer.devices) {
      await db.prepare('INSERT INTO customer_devices (store_id, customer_id, label, serial_number, remark) VALUES (?, ?, ?, ?, ?)')
        .bind(OWNER.storeId, created.meta.last_row_id, device.label, device.serialNumber ?? '', device.remark ?? '').run()
    }
  }

  for (const order of DEMO_ORDERS) {
    await db.prepare(`INSERT INTO orders (store_id, order_no, quote_snapshot, customer_name, customer_phone,
        project_title, total_amount_cents, received_amount_cents, payment_status, fulfillment_status, created_by, updated_by)
      VALUES (?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        OWNER.storeId, order.orderNo, order.customerName, order.phone, order.title,
        order.total, order.received, order.received >= order.total ? 'paid' : order.received > 0 ? 'partial' : 'unpaid',
        order.status, OWNER.userId, OWNER.userId,
      ).run()
  }

  await seedInventory((path, init) => env.call(path, init), OWNER)
  const gpu = await db.prepare(`SELECT id FROM hardware WHERE store_id = ? AND sku = 'GPU-4060TI-METAL'`).bind(OWNER.storeId).first()
  if (gpu && OPENING_MODE === 'preview') await seedSideBuckets(db, OWNER.storeId, OWNER.userId, gpu.id)
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length ? Buffer.concat(chunks) : undefined
}

const env = await createWorkerEnv({ bindings: { INVENTORY_OPENING_MODE: OPENING_MODE } })
await seedDemo(env.db)

const server = createServer(async (req, res) => {
  try {
    const body = await readBody(req)
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value
    }
    const response = await env.call(req.url, {
      method: req.method,
      headers,
      body,
    })
    res.statusCode = response.status
    response.headers.forEach((value, key) => res.setHeader(key, value))
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch (error) {
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: `本地预览后端异常：${error?.message ?? error}` }))
  }
})

server.listen(PORT, HOST, () => {
  const line = '─'.repeat(64)
  console.log(line)
  console.log('  本地预览后端已启动（隔离环境，内存 D1，不连远端）')
  console.log(`  地址：http://${HOST}:${PORT}`)
  console.log(`  期初模式：${OPENING_MODE}（formal 模式不播种库存，可从开启窗口开始验收）`)
  console.log(`  账号：${OWNER.email} / ${OWNER.password}`)
  console.log(`  数据：${DEMO_CUSTOMERS.length} 位客户、${DEMO_ORDERS.length} 笔订单、${DEMO_PRODUCTS.length} 个商品，全部为演示数据`)
  console.log(line)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('\n正在关闭本地预览后端…')
    server.close()
    await env.dispose()
    process.exit(0)
  })
}
