/**
 * R02 · 工作台读模型（GET /api/v2/workbench）端到端验收（本地隔离环境，不接触生产）。
 *
 * 与 E07 / E12 / F2 / F3 验收同一套路：后端起 backend/scripts/dev-server.mjs
 * （miniflare + 真实 Worker 入口 + 内存 D1 + 演示数据），走真实登录与真实 HTTP。
 *
 * 链路（全部走真实接口，不写测试后门）：
 *   A 段 · 入口层：匿名 401、方法 405、非法筛选值 400、category=all 等价不传
 *   B 段 · 造四类待办：
 *         缺货单   B12 建数量件 → 报价 → 发出 → 转单 → 付清 → 确认成交（无可用量 → 缺口）
 *         待交机   B12 建逐件品 → B13 期初入库 → 报价（二手件）→ 转单 → 付清 → 确认成交
 *         维修待办 B20 接修登记
 *         回收待办 B26 回收登记
 *   C 段 · 读模型口径：四类各就各位、主动作码正确、metrics 与 tasks 同快照、
 *         receivable 只算 countsTowardReceivable、筛选与 limit 不改汇总口径、
 *         排序（无交期在最后）、16 字段齐全、无成本/供应商字段
 *
 * 分工说明（不重复覆盖）：`ready_delivery` 阶段给 B10 与三条交付卡点（检测 / SN / 尾款）
 * 由后端测试 backend/tests/r02-workbench.test.mjs 覆盖（那里用夹具把履约阶段推到 ready_delivery）；
 * 本脚本走的是真实 HTTP，不伪造履约阶段。
 *
 * 断言是软断言：失败记进 report.failed 但不中断，一次运行拿到完整报告。
 *
 * 用法：node docs/verification/2026-09-22-R02-workbench/verify-r02.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../../..')
const BACKEND_PORT = 8831
const OUT = __dirname

const EMAIL = 'owner@local.test'
const PASSWORD = 'local-preview-pass'

/** errors.json 里的码，用于校验 blocker.code 不是自造的。 */
const KNOWN_ERROR_CODES = new Set([
  'VALIDATION_ERROR', 'AUTH_REQUIRED', 'SESSION_REVOKED', 'PERMISSION_DENIED', 'ENTITY_NOT_FOUND',
  'VERSION_CONFLICT', 'STOCK_CONFLICT', 'PURCHASE_PAYMENT_CONFLICT', 'IDEMPOTENCY_MISMATCH',
  'CHECKLIST_INCOMPLETE', 'SERIAL_MISMATCH', 'BALANCE_EXCEEDED', 'PURCHASE_CANCEL_EXCEEDED',
  'OFFSET_EXCEEDED', 'OWNERSHIP_INVALID', 'INSPECTION_REQUIRED', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE',
])

const TASK_FIELDS = [
  'taskId', 'entityType', 'entityId', 'entityVersion', 'category', 'title',
  'customerDisplay', 'deviceSummary', 'photoKind', 'photoUrl', 'dueAt', 'deadlineText',
  'blockerSummary', 'amountSummary', 'primaryAction', 'detailTarget',
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForHttp(url, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.status > 0) return true
    } catch {
      // 还没起来
    }
    await sleep(300)
  }
  throw new Error(`等待服务超时：${url}`)
}

function startProcess(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  const logs = []
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()))
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()))
  return { child, logs }
}

const report = {
  scope: '本地隔离环境（真实 Worker + 内存 D1 + 真实 HTTP）；不是生产',
  passed: [],
  failed: [],
  notes: [],
  at: new Date().toISOString(),
}

function check(name, condition, detail = '') {
  if (condition) report.passed.push(name)
  else report.failed.push({ name, detail })
  console.log(`${condition ? '✓' : '✗'} ${name}${condition ? '' : ` —— ${detail}`}`)
}

function note(text) {
  report.notes.push(text)
  console.log(`· ${text}`)
}

async function main() {
  const backend = startProcess(process.execPath, [path.join(ROOT, 'backend/scripts/dev-server.mjs')], {
    cwd: path.join(ROOT, 'backend'),
    env: { ...process.env, PORT: String(BACKEND_PORT) },
  })
  const base = `http://127.0.0.1:${BACKEND_PORT}`
  let authHeader = {}

  try {
    await waitForHttp(`${base}/api/customers`)

    // ────────────────────────── A 段 · 入口层 ──────────────────────────

    const anonymous = await fetch(`${base}/api/v2/workbench`)
    check('A1 未登录访问工作台 → 401', anonymous.status === 401, `实际 ${anonymous.status}`)

    const loginResponse = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })
    const loginBody = await loginResponse.json()
    check('A2 登录 owner@local.test（本地隔离环境）', loginResponse.ok && Boolean(loginBody.token))
    authHeader = { 'Content-Type': 'application/json', Authorization: `Bearer ${loginBody.token}` }

    const call = async (apiPath, body, method) => {
      const verb = method ?? (body === undefined ? 'GET' : 'POST')
      const response = await fetch(`${base}${apiPath}`, {
        method: verb,
        headers: authHeader,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let json = null
      try {
        json = await response.json()
      } catch {
        json = null
      }
      return { status: response.status, body: json }
    }

    const reqId = (tag) => `r02v-${tag}-${crypto.randomUUID()}`
    const workbench = (query = '') => call(`/api/v2/workbench${query}`)

    const first = await workbench()
    check('A3 GET /api/v2/workbench → 200', first.status === 200, JSON.stringify(first.body))
    check('A4 契约信封含 meta.contractVersion=v1', first.body?.meta?.contractVersion === 'v1')
    check('A5 响应含 metrics / tasks / filters / generatedAt',
      first.body?.data
      && typeof first.body.data.metrics === 'object'
      && Array.isArray(first.body.data.tasks)
      && typeof first.body.data.filters === 'object'
      && typeof first.body.data.generatedAt === 'string')
    check('A6 generatedAt 是可解析时间戳', !Number.isNaN(Date.parse(first.body?.data?.generatedAt ?? '')))
    check('A7 默认 filters 为 open / q=null / category=null',
      first.body?.data?.filters?.scope === 'open'
      && first.body.data.filters.q === null
      && first.body.data.filters.category === null)

    const post = await call('/api/v2/workbench', { requestId: 'x' }, 'POST')
    check('A8 非 GET 方法 → 405', post.status === 405, `实际 ${post.status}`)

    const badCategory = await workbench('?category=not-a-category')
    check('A9 非法 category → 400 VALIDATION_ERROR（不静默忽略）',
      badCategory.status === 400 && badCategory.body?.error?.code === 'VALIDATION_ERROR',
      JSON.stringify(badCategory.body))

    const badScope = await workbench('?scope=everything')
    check('A10 非法 scope → 400', badScope.status === 400, `实际 ${badScope.status}`)

    const badLimit = await workbench('?limit=abc')
    check('A11 limit 非数字 → 400', badLimit.status === 400, `实际 ${badLimit.status}`)

    const allCategory = await workbench('?category=all')
    check('A12 category=all 等价于不传（前端「全部」按钮不该 400）',
      allCategory.status === 200 && allCategory.body?.data?.filters?.category === null,
      JSON.stringify(allCategory.body))

    // ────────────────────────── B 段 · 造四类待办 ──────────────────────────

    // 缺货单：数量件商品，店里没有可用量
    const shortProduct = await call('/api/v2/inventory/products', {
      requestId: reqId('product-short'),
      name: 'R02 验收数量件',
      sku: `R02V-SHORT-${Date.now()}`,
      category: '配件',
      trackingMode: 'quantity',
      requiresSn: false,
    })
    check('B1 B12 建数量件商品 → 200', shortProduct.status === 200, JSON.stringify(shortProduct.body))

    const makeOrder = async (tag, lines) => {
      const quote = await call('/api/v2/sales/quotes', {
        requestId: reqId(`quote-${tag}`),
        title: `R02 验收 ${tag}`,
        lines,
      })
      if (quote.status !== 200) return { error: `建报价失败 ${JSON.stringify(quote.body)}` }
      const quoteId = quote.body.data.entityId
      const issue = await call(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/issue`, {
        requestId: reqId(`issue-${tag}`),
        expectedVersion: quote.body.data.entityVersion,
      })
      if (issue.status !== 200) return { error: `发出报价失败 ${JSON.stringify(issue.body)}` }
      const converted = await call(`/api/v2/sales/quotes/${encodeURIComponent(quoteId)}/convert`, {
        requestId: reqId(`convert-${tag}`),
        quoteVersion: issue.body.data.effects.revision,
      })
      if (converted.status !== 200) return { error: `转单失败 ${JSON.stringify(converted.body)}` }
      const orderId = converted.body.data.entityId
      const detail = await call(`/api/v2/sales/orders/${encodeURIComponent(orderId)}`)
      const total = detail.body?.data?.order?.totalCents
      if (typeof total !== 'number' || total <= 0) {
        return { error: `读不到销售单总额：${JSON.stringify(detail.body)}` }
      }
      const paid = await call(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/payments`, {
        requestId: reqId(`pay-${tag}`),
        amountCents: total,
        method: 'wechat',
        verificationState: 'verified',
      })
      if (paid.status !== 200) return { error: `收款失败 total=${total} ${JSON.stringify(paid.body)}` }
      const confirm = await call(`/api/v2/sales/orders/${encodeURIComponent(orderId)}/confirm`, {
        requestId: reqId(`confirm-${tag}`),
      })
      if (confirm.status !== 200) return { error: `确认成交失败 ${JSON.stringify(confirm.body)}` }
      return { orderId, orderNo: detail.body?.data?.order?.orderNo ?? null }
    }

    const shortOrder = await makeOrder('short', [{
      source: 'new',
      nameSnapshot: 'R02 验收新品',
      specSnapshot: '',
      qty: 1,
      unitPriceCents: 300000,
      productRef: shortProduct.body?.data?.entityId,
    }])
    check('B2 缺货链路走通（报价→发出→转单→付清→确认成交）', !shortOrder.error, shortOrder.error ?? '')

    // 待交机：逐件商品 + 期初入库，然后用二手件报价
    const usedProduct = await call('/api/v2/inventory/products', {
      requestId: reqId('product-used'),
      name: 'R02 验收实物件',
      sku: `R02V-USED-${Date.now()}`,
      category: '显卡',
      trackingMode: 'item',
      requiresSn: true,
    })
    check('B3 B12 建逐件商品 → 200', usedProduct.status === 200, JSON.stringify(usedProduct.body))

    const opening = await call('/api/v2/inventory/openings', {
      requestId: reqId('opening'),
      approvedCountRef: 'R02 验收实盘单',
      costBasis: { kind: 'known' },
      lines: [{
        productRef: usedProduct.body?.data?.entityId,
        qty: 1,
        condition: 'used',
        assetCode: `R02V-AC-${Date.now()}`,
        snRaw: `R02V-SN-${Date.now()}`,
        unitCostCents: 50000,
      }],
    })
    check('B4 B13 期初入库 → 200', opening.status === 200, JSON.stringify(opening.body))

    // 期初入库的实物 id 就在 effects.itemIds 里（planOpening 的 outcome：
    // { openingId, itemIds, movementIds }）。拿不到时兜底去库存读路径按商品找那一件 ——
    // GET /api/v2/inventory?productRef= 正是界面「展开某行看逐件」用的同一个入口。
    let usedItemId = opening.body?.data?.effects?.itemIds?.[0] ?? null
    if (!usedItemId) {
      const usedProductRef = usedProduct.body?.data?.entityId
      const inventory = await call(`/api/v2/inventory?productRef=${encodeURIComponent(usedProductRef ?? '')}`)
      const matchedItem = (inventory.body?.data?.items ?? [])
        .find((item) => item.productId === usedProductRef)
      usedItemId = matchedItem?.id ?? null
      note(`B13 响应里没有 effects.itemIds，兜底走库存读路径；B13 data=${JSON.stringify(opening.body?.data)}`)
    }

    if (usedItemId) {
      const usedOrder = await makeOrder('used', [{
        source: 'used',
        nameSnapshot: 'R02 验收二手显卡',
        specSnapshot: '拆机件',
        qty: 1,
        unitPriceCents: 400000,
        stockItemId: usedItemId,
      }])
      check('B5 待交机链路走通（实物件成交）', !usedOrder.error, usedOrder.error ?? '')
      if (!usedOrder.error) report.usedOrderId = usedOrder.orderId
    } else {
      check('B5 待交机链路走通（实物件成交）', false, '期初入库后拿不到实物 id')
    }

    const service = await call('/api/v2/service/orders', {
      requestId: reqId('service'),
      customerName: '验收客户甲',
      deviceCode: `R02V-DEV-${Date.now()}`,
      symptom: '开机蓝屏',
    })
    check('B6 B20 接修登记 → 200', service.status === 200, JSON.stringify(service.body))

    const recovery = await call('/api/v2/recovery/orders', {
      requestId: reqId('recovery'),
      sellerName: '验收卖家乙',
      sellerPhone: '13800002222',
      items: [{ description: '联想 ThinkPad T14 整机', condition: 'used', snRaw: `R02V-RSN-${Date.now()}` }],
      initialEstimateCents: 150000,
      note: 'R02 验收回收',
    })
    check('B7 B26 回收登记 → 200', recovery.status === 200, JSON.stringify(recovery.body))

    // ────────────────────────── C 段 · 读模型口径 ──────────────────────────

    const snapshot = await workbench()
    const tasks = snapshot.body?.data?.tasks ?? []
    const metrics = snapshot.body?.data?.metrics ?? {}

    check('C1 工作台返回结构化 tasks', Array.isArray(tasks) && tasks.length > 0, `tasks=${tasks.length}`)

    const byCategory = (category) => tasks.filter((task) => task.category === category)
    const shortOrderNo = shortOrder.orderNo

    const shortTask = byCategory('stock_shortage')
      .find((task) => task.entityId === shortOrderNo || task.title.includes('缺件'))
    check('C2 缺货单归入 stock_shortage', Boolean(shortTask), `缺货类 ${byCategory('stock_shortage').length} 条`)
    check('C3 缺货主动作是 B15（到货入库）', shortTask?.primaryAction?.code === 'B15', shortTask?.primaryAction?.code)
    check('C4 缺货单同时带可读卡点', Boolean(shortTask?.blockerSummary), String(shortTask?.blockerSummary))
    check('C5 缺货单不出现在待交机里（卡点优先，不重复出现）',
      !byCategory('delivery').some((task) => task.entityId === shortOrderNo))

    const deliveryTask = byCategory('delivery')[0]
    check('C6 已成交实物单归入 delivery（待交机）', Boolean(deliveryTask), `待交机 ${byCategory('delivery').length} 条`)
    check('C7 还没备料的单给 B06 而不是 B10（点了必然 400 的动作不能给）',
      deliveryTask?.primaryAction?.code === 'B06', deliveryTask?.primaryAction?.code)

    const serviceTask = byCategory('service')[0]
    check('C8 接修工单归入 service', Boolean(serviceTask))
    check('C9 刚接修的工单主动作是 B21', serviceTask?.primaryAction?.code === 'B21', serviceTask?.primaryAction?.code)
    check('C10 工单标题用「维修 · 症状」形态', /^维修 · /.test(serviceTask?.title ?? ''), serviceTask?.title)
    check('C11 未出方案的工单不计确定应收',
      serviceTask?.amountSummary?.countsTowardReceivable === false)

    const recoveryTask = byCategory('recovery')[0]
    check('C12 回收单归入 recovery', Boolean(recoveryTask))
    check('C13 刚登记的回收单主动作是 B27', recoveryTask?.primaryAction?.code === 'B27', recoveryTask?.primaryAction?.code)
    check('C14 未确认收购的回收单不计应收',
      recoveryTask?.amountSummary?.countsTowardReceivable === false)
    check('C15 回收初估只落 estimateCents，不冒充确定应收',
      recoveryTask?.amountSummary?.estimateCents === 150000
      && recoveryTask?.amountSummary?.balanceCents === null,
      JSON.stringify(recoveryTask?.amountSummary))

    check('C16 metrics.taskTotal === tasks.length',
      metrics.taskTotal?.value === tasks.length, `${metrics.taskTotal?.value} vs ${tasks.length}`)
    check('C17 metrics.pendingDelivery === delivery 条数',
      metrics.pendingDelivery?.value === byCategory('delivery').length,
      `${metrics.pendingDelivery?.value} vs ${byCategory('delivery').length}`)
    check('C18 metrics.stockShortage === stock_shortage 条数',
      metrics.stockShortage?.value === byCategory('stock_shortage').length,
      `${metrics.stockShortage?.value} vs ${byCategory('stock_shortage').length}`)
    check('C19 metrics.servicePending === service 条数',
      metrics.servicePending?.value === byCategory('service').length,
      `${metrics.servicePending?.value} vs ${byCategory('service').length}`)

    const expectedReceivable = tasks.reduce((sum, task) => {
      if (!task.amountSummary?.countsTowardReceivable) return sum
      return sum + Math.max(task.amountSummary.balanceCents ?? 0, 0)
    }, 0)
    check('C20 receivable === countsTowardReceivable 的 balanceCents 之和（契约口径）',
      metrics.receivable?.valueCents === expectedReceivable,
      `${metrics.receivable?.valueCents} vs ${expectedReceivable}`)
    check('C21 有五项统计中文标签', ['pendingDelivery', 'stockShortage', 'servicePending', 'receivable', 'taskTotal']
      .every((key) => typeof metrics[key]?.label === 'string' && metrics[key].label.length > 0))
    check('C22 统计带 filterTarget 可点开来源',
      Object.values(metrics).every((metric) => typeof metric.filterTarget === 'string' && metric.filterTarget.startsWith('/')))

    check('C23 每条任务 16 个契约字段齐全',
      tasks.every((task) => TASK_FIELDS.every((field) => field in task)))
    check('C24 任务不得多出契约外字段',
      tasks.every((task) => Object.keys(task).length === TASK_FIELDS.length))
    check('C25 taskId 主键 = entityType + entityId',
      tasks.every((task) => task.taskId === `${task.entityType}:${task.entityId}`))
    check('C26 detailTarget 指向真实存在的业务工作区',
      tasks.every((task) => ['/sales/orders', '/after-sales', '/recovery'].includes(task.detailTarget)),
      tasks.map((task) => task.detailTarget).join(', '))
    check('C27 blocker.code 全部来自 errors.json',
      tasks.every((task) => task.primaryAction.blockers.every((item) => KNOWN_ERROR_CODES.has(item.code))))
    check('C28 禁用的主动作必须给出至少一条可读原因',
      tasks.every((task) => task.primaryAction.enabled || task.primaryAction.blockers.length > 0))
    check('C29 有卡点的任务必须给出 blockerSummary',
      tasks.every((task) => task.primaryAction.enabled ? true : Boolean(task.blockerSummary)))

    const filteredDelivery = await workbench('?category=delivery')
    check('C30 category=delivery 只返回 delivery 类',
      filteredDelivery.body?.data?.tasks?.every((task) => task.category === 'delivery'))
    check('C31 筛选不改汇总口径（metrics 与全量一致）',
      JSON.stringify(filteredDelivery.body?.data?.metrics) === JSON.stringify(metrics))

    const limited = await workbench('?limit=1')
    check('C32 limit=1 只返回一条', limited.body?.data?.tasks?.length === 1)
    check('C33 limit 不改汇总口径',
      JSON.stringify(limited.body?.data?.metrics) === JSON.stringify(metrics))

    const hit = await workbench(`?q=${encodeURIComponent(shortOrderNo ?? '')}`)
    check('C34 q 能按单号命中', (hit.body?.data?.tasks?.length ?? 0) >= 1,
      `q=${shortOrderNo} → ${hit.body?.data?.tasks?.length}`)

    const miss = await workbench('?q=绝不存在的关键词zzz')
    check('C35 命中不到就是空数组（不伪造）', miss.body?.data?.tasks?.length === 0)
    check('C36 命中不到时统计口径不变（界面才能区分「没待办」与「筛掉了」）',
      JSON.stringify(miss.body?.data?.metrics) === JSON.stringify(metrics))

    const noDue = tasks.filter((task) => task.dueAt === null)
    if (noDue.length > 0) {
      const lastTask = tasks[tasks.length - 1]
      check('C37 无交期事项排在已知交期之后', lastTask.dueAt === null, `最后一条 dueAt=${lastTask.dueAt}`)
      check('C38 无交期事项的 deadlineText 为 null（界面显示「未约定」）',
        noDue.every((task) => task.deadlineText === null))
    } else {
      note('本轮种子数据里没有无交期事项，C37/C38 未覆盖')
    }

    const raw = JSON.stringify(snapshot.body)
    check('C39 响应里没有成本 / 供应商 / 毛利字段（服务端就没取）',
      !['cost', 'Cost', 'supplier', 'Supplier', 'margin', 'Margin', '供应商', '毛利'].some((word) => raw.includes(word)))
    check('C40 照片字段本轮为 null（附件读路径归 BK-05，不半接）',
      tasks.every((task) => task.photoKind === null && task.photoUrl === null))

    note(`本次工作台共 ${tasks.length} 条待办：` + ['delivery', 'stock_shortage', 'service', 'recovery', 'collection']
      .map((category) => `${category}=${tasks.filter((task) => task.category === category).length}`)
      .join('，'))
  } finally {
    backend.child.kill()
    fs.writeFileSync(
      path.join(OUT, 'report.json'),
      `${JSON.stringify({ ...report, backendLogTail: backend.logs.slice(-20) }, null, 2)}\n`,
      'utf8',
    )
    console.log(`\n报告：${report.passed.length} 通过 / ${report.failed.length} 失败 → report.json`)
  }

  if (report.failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
