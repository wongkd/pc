/**
 * E07/F4 · 采购领域：缺件采购（B14）、分批到货入库（B15）、取消采购（B37）、退供（B38）。
 *
 * 契约依据（contracts/v1）：
 *   actions.json  B14  创建采购与到货计划 /inventory/purchases（inventory/purchase-create）
 *                 B15  登记实际到货与入库 /inventory/receipts（inventory/receipt）
 *                 B37  取消采购 /inventory/purchases/:id/cancel（inventory/purchase-cancel）
 *                 B38  退供 /inventory/supplier-returns（inventory/supplier-return）
 *   objects.json  Purchase（含 notStored：刻意不设 status）/ Receipt / InventoryMovement
 *   enums.json    InspectionDisposition / StockCondition / InventoryMovementSource
 *
 * ── E07 三条放行证据在这份代码里的落点 ──
 *
 * 1.「采购 5 件只到 3 件，在途剩 2」
 *    purchase_lines.qty_ordered = 5 是唯一存下来的订购量；实收 / 拒收写在
 *    purchase_receipt_lines，两者相加就是「已处置」。pendingQty 永远是
 *    orderedQty − receivedQty − cancelledQty 的派生值（对象层明写不存状态），
 *    所以不可能出现「状态说到齐了、行说还差 2 件」这种两个真相打架的情况。
 *
 * 2.「拒收不进可用」
 *    只有 inspection_disposition ∈ {available, quarantine} 才写库存流水；
 *    return_to_supplier / scrapped 的件**根本不建 stock_item、不写任何流水** ——
 *    它们从未进入自有在库。拒收量记在 qty_rejected 上并计入采购恒等式，
 *    因此既不增加可用量，也不留下「还在途」的假象。
 *
 * 3.「现买现入仍有来源和成本」
 *    快速采购（purchase_id 为空）必须带 quick_purchase_note（0014 的 CHECK 强制），
 *    照样要写商品、数量、单件成本与成本是否已知；建出来的 stock_item 上
 *    acquisition_ref 指向这次到货，成本未知时 costKnown=0 且成本为 NULL，不写 0。
 *
 * ⚠️ 本模块不做的事：
 *   · B33 付款由 finance.ts 统一承载；本模块提供采购单的应付、已付、剩余应付读模型；
 *   · 数量件（tracking_mode='quantity'）的到货只写移动流水并更新余额，不逐件编号 ——
 *     逐件商品自动生成内部编号；厂家 SN 单独选填。
 */

import {
  assertRowVersionStatement,
  bumpVersionStatement,
  guardStatement,
  hashPayload,
  queryOperation,
  runIdempotent,
  type OperationContext,
  type OperationPlan,
  type OperationsDb,
  type RunResult,
} from './operations'
import { generateInternalCode, normalizeManufacturerSn } from './serial-codes'

// ─────────────────────────────── 枚举 ───────────────────────────────

export const INSPECTION_DISPOSITIONS = [
  'available',
  'quarantine',
  'return_to_supplier',
  'return_to_customer',
  'scrapped',
] as const
export type InspectionDisposition = (typeof INSPECTION_DISPOSITIONS)[number]

/** 会进入自有在库的去向：只有这两种会写库存副作用。 */
const STOCKED_DISPOSITIONS: readonly InspectionDisposition[] = ['available', 'quarantine']

/** 退供的起点桶（0014 的 CHECK）：只从可取或待处理出发，绝不从 reserved 退供。 */
export const SUPPLIER_RETURN_BUCKETS = ['available', 'quarantine'] as const
export type SupplierReturnBucket = (typeof SUPPLIER_RETURN_BUCKETS)[number]

export const PURCHASE_CANCEL_REASONS = [
  'supplier_unavailable',
  'supplier_delay',
  'customer_cancelled',
  'duplicate_purchase',
  'price_changed',
  'other',
] as const
export type PurchaseCancelReason = (typeof PURCHASE_CANCEL_REASONS)[number]

const MAX_LINES = 100

// ─────────────────────────────── 入参 ───────────────────────────────

export interface PurchaseLineInput {
  productRef: string
  nameSnapshot?: string | null
  specSnapshot?: string | null
  qtyOrdered: number
  unitCostCents?: number | null
  costKnown?: boolean
}

export interface CreatePurchaseInput {
  /** 快捷供应商：直接给名字，不要求先在供应商模块建档。 */
  supplierName?: string | null
  supplierRef?: string | null
  supplierNote?: string | null
  saleOrderId?: string | null
  expectedAt?: string | null
  note?: string | null
  lines: PurchaseLineInput[]
}

export interface ReceiptItemInput {
  assetCode?: string | null
  snRaw?: string | null
  remark?: string | null
}

export interface ReceiptLineInput {
  purchaseLineId?: string | null
  position: number
  productRef: string
  qtyReceived: number
  qtyRejected?: number
  disposition: InspectionDisposition
  unitCostCents?: number | null
  costKnown?: boolean
  /** 逐件商品的每件信息（内部编号 / 厂商 SN）。数量件留空。 */
  items?: ReceiptItemInput[]
  batchRemark?: string | null
}

export interface ReceiptInput {
  purchaseId?: string | null
  quickPurchaseNote?: string | null
  occurredAt?: string | null
  note?: string | null
  lines: ReceiptLineInput[]
}

export interface SupplierReturnInput {
  purchaseId?: string | null
  stockItemId?: string | null
  productRef?: string | null
  qty: number
  fromBucket: SupplierReturnBucket
  reason: string
  supplierName?: string | null
  unitCostCents?: number | null
  costKnown?: boolean
  occurredAt?: string | null
}

export interface PurchaseCancelLineInput {
  purchaseLineId: string
  qty: number
}

export interface CancelPurchaseInput {
  lines: PurchaseCancelLineInput[]
  reason: PurchaseCancelReason
  note?: string | null
  occurredAt?: string | null
}

// ─────────────────────────────── 纯函数 ───────────────────────────────

/** 采购在途（objects.json Purchase.derivedFields.pendingQty）。 */
export function pendingQty(input: { orderedQty: number; receivedQty: number; cancelledQty: number }): number {
  return input.orderedQty - input.receivedQty - input.cancelledQty
}

/** 部分到货判定（objects.json Purchase.derivedFields.receiptProgress）。 */
export function receiptProgress(input: { orderedQty: number; receivedQty: number; cancelledQty: number }): string {
  const pending = pendingQty(input)
  if (pending > 0 && input.receivedQty === 0) return '尚未到货'
  if (pending > 0) return '部分到货'
  if (input.receivedQty === 0 && input.cancelledQty > 0) return '已取消'
  return '到货完成'
}

/** 采购单号 / 退供单号：日期 + requestId 派生后缀，确定性。 */
export function documentNoFor(prefix: string, requestId: string, now: string): string {
  const date = now.slice(0, 10).replace(/-/g, '')
  const suffix = requestId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase() || 'DOC'
  return `${prefix}-${date}-${suffix}`
}

// ─────────────────────────────── 读辅助 ───────────────────────────────

interface ProductRow {
  id: number
  name: string
  tracking_mode: string
  requires_sn: number
  entity_id: string | null
}

async function resolveProducts(
  db: OperationsDb,
  storeId: number,
  refs: readonly string[],
): Promise<Map<string, ProductRow>> {
  const out = new Map<string, ProductRow>()
  const unique = [...new Set(refs.filter(Boolean))]
  if (unique.length === 0) return out
  const placeholders = unique.map(() => '?').join(', ')
  const rows = await db
    .prepare(
      `SELECT id, name, tracking_mode, requires_sn, entity_id
       FROM hardware WHERE store_id = ? AND entity_id IN (${placeholders})`,
    )
    .bind(storeId, ...unique)
    .all<ProductRow>()
  for (const row of rows.results ?? []) if (row.entity_id) out.set(row.entity_id, row)
  return out
}

interface SupplierReturnStockItem {
  id: string
  product_id: number
  availability: string
  ownership: string
  acquisition_cost_cents: number | null
  cost_known: number
  version: number
}

async function readStockItemForReturn(
  db: OperationsDb,
  storeId: number,
  stockItemId: string,
): Promise<SupplierReturnStockItem | null> {
  const row = await db
    .prepare(
      `SELECT id, product_id, availability, ownership, acquisition_cost_cents, cost_known, version
       FROM stock_items WHERE store_id = ? AND id = ?`,
    )
    .bind(storeId, stockItemId)
    .first<SupplierReturnStockItem>()
  return row ?? null
}

// ─────────────────────────────── B14 创建采购 ───────────────────────────────

export function planCreatePurchase(
  db: OperationsDb,
  ctx: OperationContext,
  input: CreatePurchaseInput,
  products: Map<string, ProductRow>,
  purchaseId: string,
  purchaseNo: string,
): OperationPlan {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO purchase_orders
           (id, store_id, purchase_no, sale_order_id, supplier_ref, supplier_name, supplier_note,
            expected_at, note, version, request_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        purchaseId,
        ctx.storeId,
        purchaseNo,
        input.saleOrderId ?? null,
        input.supplierRef ?? null,
        (input.supplierName ?? '').trim(),
        (input.supplierNote ?? '').trim() || null,
        input.expectedAt ?? null,
        (input.note ?? '').trim(),
        ctx.requestId,
        ctx.actorUserId,
      ),
    guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM purchase_orders WHERE store_id = ? AND id = ?)', ctx.storeId, purchaseId),
  ]

  if (input.saleOrderId) {
    statements.push(
      guardStatement(db, 'ENTITY_NOT_FOUND', 'NOT EXISTS (SELECT 1 FROM sale_orders WHERE store_id = ? AND id = ?)', ctx.storeId, input.saleOrderId),
    )
  }

  for (const [index, line] of input.lines.entries()) {
    const product = products.get(line.productRef)
    statements.push(
      db
        .prepare(
          `INSERT INTO purchase_lines
             (id, store_id, purchase_id, position, product_id, product_ref, name_snapshot, spec_snapshot,
              qty_ordered, unit_cost_cents, cost_known)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `${ctx.requestId}::pl-${index}`,
          ctx.storeId,
          purchaseId,
          index,
          product?.id ?? null,
          line.productRef,
          (line.nameSnapshot ?? product?.name ?? '').trim() || line.productRef,
          line.specSnapshot ?? null,
          line.qtyOrdered,
          line.costKnown === false ? null : line.unitCostCents ?? null,
          line.costKnown === false ? 0 : line.unitCostCents === undefined || line.unitCostCents === null ? 0 : 1,
        ),
    )
  }

  const orderedTotal = input.lines.reduce((sum, line) => sum + line.qtyOrdered, 0)
  statements.push(bumpVersionStatement(db, ctx, 'Purchase', purchaseId, 1))

  return {
    statements,
    outcome: {
      entityType: 'Purchase',
      entityId: purchaseId,
      version: 1,
      summary: `创建采购单 ${purchaseNo}（${input.lines.length} 行 / ${orderedTotal} 件）`,
      effects: {
        purchaseNo,
        lineCount: input.lines.length,
        orderedQty: orderedTotal,
        supplierName: (input.supplierName ?? '').trim() || null,
        saleOrderId: input.saleOrderId ?? null,
      },
    },
    constraintCodes: {
      'purchase_orders.store_id, purchase_orders.purchase_no': 'VALIDATION_ERROR',
      'purchase_lines.purchase_id, purchase_lines.position': 'VALIDATION_ERROR',
    },
  }
}

/** B14 入口。 */
export async function createPurchase(
  db: OperationsDb,
  ctx: OperationContext,
  input: CreatePurchaseInput,
): Promise<RunResult> {
  const action = 'B14'
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '采购单至少要有一行', retryable: false, httpStatus: 400 }
  }
  if (input.lines.length > MAX_LINES) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: `采购单最多 ${MAX_LINES} 行`, retryable: false, httpStatus: 400 }
  }
  const supplierName = (input.supplierName ?? '').trim()
  const supplierRef = (input.supplierRef ?? '').trim()
  if (!supplierName && !supplierRef) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '请填写供应商名称，或选择一个已建档供应商', retryable: false, httpStatus: 400 }
  }
  for (const [index, line] of input.lines.entries()) {
    if (!line.productRef || !line.productRef.trim()) {
      return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: `第 ${index + 1} 行：缺少商品`, retryable: false, httpStatus: 400 }
    }
    if (!Number.isInteger(line.qtyOrdered) || line.qtyOrdered < 1) {
      return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: `第 ${index + 1} 行：订购数量必须是正整数`, retryable: false, httpStatus: 400 }
    }
    if (line.unitCostCents !== undefined && line.unitCostCents !== null) {
      if (!Number.isInteger(line.unitCostCents) || line.unitCostCents < 0) {
        return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: `第 ${index + 1} 行：单件成本必须是非负整数分`, retryable: false, httpStatus: 400 }
      }
    }
  }

  const payloadHash = await hashPayload({ input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const products = await resolveProducts(db, ctx.storeId, input.lines.map((line) => line.productRef))
  const missing = input.lines.filter((line) => !products.has(line.productRef))
  if (missing.length > 0) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'ENTITY_NOT_FOUND',
      message: `这些商品不存在或不属于本店：${missing.map((line) => line.productRef).join('、')}；请先在库存里建档`,
      retryable: false,
      httpStatus: 404,
    }
  }

  const now = new Date().toISOString()
  const purchaseId = `${ctx.requestId}::purchase`
  const purchaseNo = documentNoFor('PO', ctx.requestId, now)
  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) =>
    planCreatePurchase(db, context, input, products, purchaseId, purchaseNo),
  )
}

// ─────────────────────────────── B15 登记到货 ───────────────────────────────

interface PurchaseLineRow {
  id: string
  position: number
  product_id: number
  qty_ordered: number
  unit_cost_cents: number | null
  cost_known: number
}

async function readPurchaseLines(db: OperationsDb, storeId: number, purchaseId: string): Promise<PurchaseLineRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, position, product_id, qty_ordered, unit_cost_cents, cost_known
       FROM purchase_lines WHERE store_id = ? AND purchase_id = ? ORDER BY position ASC`,
    )
    .bind(storeId, purchaseId)
    .all<PurchaseLineRow>()
  return rows.results ?? []
}

export function planRegisterReceipt(
  db: OperationsDb,
  ctx: OperationContext,
  input: ReceiptInput,
  products: Map<string, ProductRow>,
  purchaseLines: readonly PurchaseLineRow[],
  receiptId: string,
  occurredAt: string,
): OperationPlan {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO purchase_receipts
           (id, store_id, purchase_id, quick_purchase_note, note, occurred_at, version, request_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        receiptId,
        ctx.storeId,
        input.purchaseId ?? null,
        input.quickPurchaseNote ? input.quickPurchaseNote.trim() : null,
        (input.note ?? '').trim(),
        occurredAt,
        ctx.requestId,
        ctx.actorUserId,
      ),
    guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM purchase_receipts WHERE store_id = ? AND id = ?)', ctx.storeId, receiptId),
  ]

  for (const [index, line] of input.lines.entries()) {
    const product = products.get(line.productRef)
    const productId = product?.id ?? null
    const qtyReceived = line.qtyReceived ?? 0
    const qtyRejected = line.qtyRejected ?? 0
    const stocked = STOCKED_DISPOSITIONS.includes(line.disposition)
    const perItem = stocked && product !== undefined && product.tracking_mode === 'item'
    // 成本解析优先级：本次到货行上写的 → 采购行约定的 → 未知（NULL，不写 0）。
    // 到货时不必把采购单上已经谈好的价格再抄一遍；抄一遍反而给了两者不一致的机会。
    const contracted = line.purchaseLineId ? purchaseLines.find((row) => row.id === line.purchaseLineId) : undefined
    const explicitCost = line.costKnown === false ? null : line.unitCostCents ?? null
    const fallbackCost = contracted && contracted.cost_known === 1 ? contracted.unit_cost_cents : null
    const unitCost = explicitCost ?? fallbackCost
    const costKnown = unitCost === null ? 0 : 1

    // 不超量：该采购行已处置量 + 本次处置量 不得超过订购量。
    // 超量要先修改确认采购量或另建追加采购，不静默增加（objects.json Purchase.rules 第 2 条）。
    if (line.purchaseLineId) {
      statements.push(
        guardStatement(
          db,
          'VALIDATION_ERROR',
          `EXISTS (SELECT 1 FROM purchase_lines
                   WHERE store_id = ? AND id = ? AND qty_ordered <
                     ? +
                     COALESCE((SELECT SUM(rl.qty_received + rl.qty_rejected)
                               FROM purchase_receipt_lines rl
                               WHERE rl.store_id = purchase_lines.store_id
                                 AND rl.purchase_line_id = purchase_lines.id), 0) +
                     COALESCE((SELECT SUM(pc.qty_cancelled)
                               FROM purchase_cancellations pc
                               WHERE pc.store_id = purchase_lines.store_id
                                 AND pc.purchase_line_id = purchase_lines.id), 0))`,
          ctx.storeId,
          line.purchaseLineId,
          qtyReceived + qtyRejected,
        ),
      )
    }

    // 来源引用（acquisition_ref）：优先指回采购单 —— 供应商、约定价、订购量都在那张单上，
    // 实物要能顺着它回到「这件货是谁给的、谈的多少钱」。快速采购没有采购单，才记到货单。
    const acquisitionRef = input.purchaseId ?? receiptId

    statements.push(
      db
        .prepare(
          `INSERT INTO purchase_receipt_lines
             (id, store_id, receipt_id, purchase_line_id, position, product_id, qty_received, qty_rejected,
              inspection_disposition, unit_cost_cents, cost_known, stock_item_id, asset_code, sn_raw)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
        )
        .bind(
          `${ctx.requestId}::rl-${index}`,
          ctx.storeId,
          receiptId,
          line.purchaseLineId ?? null,
          line.position ?? index,
          productId,
          qtyReceived,
          qtyRejected,
          line.disposition,
          unitCost,
          costKnown,
        ),
    )

    // 拒收 / 报废 / 退还客户：实物从未进入自有在库，因此不建实物、不写流水。
    // 数量记在 qty_rejected 上并计入采购恒等式，所以也不留下「还在途」的假象。
    if (!stocked || productId === null) continue

    if (perItem) {
      const items = line.items ?? []
      let singleItemId: string | null = null
      let singleAssetCode: string | null = null
      let singleSnRaw: string | null = null
      for (let seq = 0; seq < qtyReceived; seq += 1) {
        const item = items[seq]
        const assetCode = (item?.assetCode ?? '').trim() || generateInternalCode('IT', ctx.storeId, occurredAt)
        const snRaw = (item?.snRaw ?? '').trim() || null
        const snNormalized = normalizeManufacturerSn(snRaw)
        const stockItemId = `${ctx.requestId}::si-${index}-${seq}`
        if (seq === 0) {
          singleItemId = stockItemId
          singleAssetCode = assetCode
          singleSnRaw = snRaw
        }
        statements.push(
          db
            .prepare(
              `INSERT INTO stock_items
                 (id, store_id, product_id, asset_code, condition, sn_raw, sn_normalized, remark, ownership, availability,
                  location, acquisition_ref, acquisition_cost_cents, refurbishment_cost_cents, cost_known,
                  inspection_ref, warranty_snapshot, version, created_by)
               VALUES (?, ?, ?, ?, 'new', ?, ?, ?, 'store', ?, 'store', ?, ?, NULL, ?, NULL, NULL, 1, ?)`,
            )
            .bind(
              stockItemId,
              ctx.storeId,
              productId,
              assetCode,
              snRaw,
              snNormalized,
              item?.remark?.trim() ?? '',
              line.disposition,
              acquisitionRef,
              unitCost,
              costKnown,
              ctx.actorUserId,
            ),
          db
            .prepare(
              `INSERT INTO inventory_movements
                 (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
                  source, occurred_at, actor_user_id, request_id)
               VALUES (?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              `${ctx.requestId}::rmv-${index}-${seq}`,
              ctx.storeId,
              productId,
              stockItemId,
              line.disposition,
              unitCost,
              input.purchaseId ? 'purchase_receipt' : 'quick_purchase',
              occurredAt,
              ctx.actorUserId,
              ctx.requestId,
            ),
        )
      }
      // 行级字段只在「这一行就一件」时回填。多件时它只能装下一个编号，
      // 写进去会让人误以为只到了一件；逐件明细在 stock_items 里逐条可查。
      if (qtyReceived === 1 && singleItemId) {
        statements.push(
          db
            .prepare(
              `UPDATE purchase_receipt_lines SET stock_item_id = ?, asset_code = ?, sn_raw = ?
               WHERE store_id = ? AND id = ?`,
            )
            .bind(singleItemId, singleAssetCode, singleSnRaw, ctx.storeId, `${ctx.requestId}::rl-${index}`),
        )
      }
      continue
    }

    // 数量件：流水与批次在同一幂等事务里写入（触发器同步 stock_balances）。
    statements.push(
      db
        .prepare(
          `INSERT INTO inventory_movements
             (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
              source, occurred_at, actor_user_id, request_id)
           VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `${ctx.requestId}::rmv-${index}`,
          ctx.storeId,
          productId,
          qtyReceived,
          line.disposition,
          unitCost,
          input.purchaseId ? 'purchase_receipt' : 'quick_purchase',
          occurredAt,
          ctx.actorUserId,
          ctx.requestId,
        ),
    )
    statements.push(
      db.prepare(`INSERT INTO stock_batches
        (id, store_id, product_id, batch_code, source_ref, source_line_ref, received_qty, occurred_at, remark, actor_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(`${ctx.requestId}::batch::${index}`, ctx.storeId, productId,
          generateInternalCode('BT', ctx.storeId, occurredAt), receiptId, `${ctx.requestId}::rl-${index}`,
          qtyReceived, occurredAt, line.batchRemark?.trim() ?? input.note?.trim() ?? '', ctx.actorUserId),
    )
  }

  statements.push(bumpVersionStatement(db, ctx, 'Receipt', receiptId, 1))

  const stockedQty = input.lines
    .filter((line) => STOCKED_DISPOSITIONS.includes(line.disposition))
    .reduce((sum, line) => sum + (line.qtyReceived ?? 0), 0)
  const rejectedQty = input.lines.reduce((sum, line) => sum + (line.qtyRejected ?? 0), 0)

  return {
    statements,
    outcome: {
      entityType: 'Receipt',
      entityId: receiptId,
      version: 1,
      summary: `登记到货：入库 ${stockedQty} 件${rejectedQty > 0 ? `，拒收 ${rejectedQty} 件` : ''}`,
      effects: {
        purchaseId: input.purchaseId ?? null,
        stockedQty,
        rejectedQty,
        quickPurchase: !input.purchaseId,
      },
    },
    constraintCodes: {
      'purchase_receipt_lines.receipt_id, purchase_receipt_lines.position': 'VALIDATION_ERROR',
      'stock_items.store_id, stock_items.asset_code': 'VALIDATION_ERROR',
      'stock_items.store_id, stock_items.sn_normalized': 'VALIDATION_ERROR',
    },
  }
}

/** B15 入口。 */
export async function registerReceipt(
  db: OperationsDb,
  ctx: OperationContext,
  input: ReceiptInput,
): Promise<RunResult> {
  const action = 'B15'
  const purchaseId = (input.purchaseId ?? '').trim()
  const quickNote = (input.quickPurchaseNote ?? '').trim()
  if (!purchaseId && !quickNote) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '到货必须挂在采购单上，或填写快速采购说明', retryable: false, httpStatus: 400 }
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '到货至少要有一行', retryable: false, httpStatus: 400 }
  }
  if (input.lines.length > MAX_LINES) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: `到货明细最多 ${MAX_LINES} 行`, retryable: false, httpStatus: 400 }
  }
  for (const [index, line] of input.lines.entries()) {
    const at = `第 ${index + 1} 行`
    if (!line.productRef || !line.productRef.trim()) {
      return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: `${at}：缺少商品`, retryable: false, httpStatus: 400 }
    }
    if (!(INSPECTION_DISPOSITIONS as readonly string[]).includes(line.disposition)) {
      return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: `${at}：处置去向不合法`, retryable: false, httpStatus: 400 }
    }
    const received = line.qtyReceived ?? 0
    const rejected = line.qtyRejected ?? 0
    if (!Number.isInteger(received) || received < 0 || !Number.isInteger(rejected) || rejected < 0) {
      return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: `${at}：实收与拒收数量必须是非负整数`, retryable: false, httpStatus: 400 }
    }
    if (received + rejected === 0) {
      return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: `${at}：这一行既没有实收也没有拒收，无法登记`, retryable: false, httpStatus: 400 }
    }
    // 只有「进库」的去向才允许有实收量；拒收去向的件必须记在 qtyRejected 上。
    if (!STOCKED_DISPOSITIONS.includes(line.disposition) && received > 0) {
      return {
        ok: false,
        requestId: ctx.requestId,
        code: 'VALIDATION_ERROR',
        message: `${at}：处置去向是「${line.disposition}」，这些货不进店有库存，请把数量填在拒收里`,
        retryable: false,
        httpStatus: 400,
      }
    }
  }

  const payloadHash = await hashPayload({ input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  let purchaseLines: PurchaseLineRow[] = []
  if (purchaseId) {
    const purchase = await db
      .prepare(`SELECT id FROM purchase_orders WHERE store_id = ? AND id = ?`)
      .bind(ctx.storeId, purchaseId)
      .first<{ id: string }>()
    if (!purchase) {
      return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '采购单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
    }
    purchaseLines = await readPurchaseLines(db, ctx.storeId, purchaseId)
  }

  const products = await resolveProducts(db, ctx.storeId, input.lines.map((line) => line.productRef))
  const missing = input.lines.filter((line) => !products.has(line.productRef))
  if (missing.length > 0) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'ENTITY_NOT_FOUND',
      message: `这些商品不存在或不属于本店：${missing.map((line) => line.productRef).join('、')}`,
      retryable: false,
      httpStatus: 404,
    }
  }

  const now = input.occurredAt && !Number.isNaN(new Date(input.occurredAt).getTime())
    ? new Date(input.occurredAt).toISOString()
    : new Date().toISOString()
  const receiptId = `${ctx.requestId}::receipt`

  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) =>
    planRegisterReceipt(db, context, input, products, purchaseLines, receiptId, now),
  )
}

// ─────────────────────────────── B38 退供 ───────────────────────────────

export function planReturnToSupplier(
  db: OperationsDb,
  ctx: OperationContext,
  input: SupplierReturnInput,
  productId: number,
  returnId: string,
  returnNo: string,
  occurredAt: string,
  resolvedCost: { unitCostCents: number | null; costKnown: number },
): OperationPlan {
  const statements: D1PreparedStatement[] = []

  if (input.stockItemId) {
    // 逐件退供：条件更新只命中当前还在目标桶里的行。
    statements.push(
      db
        .prepare(
          `UPDATE stock_items SET availability = 'retired', version = version + 1, updated_at = datetime('now')
           WHERE store_id = ? AND id = ? AND availability = ?`,
        )
        .bind(ctx.storeId, input.stockItemId, input.fromBucket),
      guardStatement(
        db,
        'STOCK_CONFLICT',
        `NOT EXISTS (SELECT 1 FROM stock_items WHERE store_id = ? AND id = ? AND availability = 'retired')`,
        ctx.storeId,
        input.stockItemId,
      ),
    )
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO supplier_returns
           (id, store_id, return_no, purchase_id, supplier_name, product_id, stock_item_id, qty,
            from_bucket, reason, unit_cost_cents, cost_known, occurred_at, version, request_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        returnId,
        ctx.storeId,
        returnNo,
        input.purchaseId ?? null,
        (input.supplierName ?? '').trim(),
        productId,
        input.stockItemId ?? null,
        input.qty,
        input.fromBucket,
        input.reason.trim(),
        resolvedCost.unitCostCents,
        resolvedCost.costKnown,
        occurredAt,
        ctx.requestId,
        ctx.actorUserId,
      ),
    guardStatement(db, 'VALIDATION_ERROR', 'NOT EXISTS (SELECT 1 FROM supplier_returns WHERE store_id = ? AND id = ?)', ctx.storeId, returnId),
    // 自有在库减少：from_bucket → retired。触发器会同步 stock_balances；
    // 数量超过余额时 CHECK (>= 0) 会让整批回滚，而不是静默截断。
    db
      .prepare(
        `INSERT INTO inventory_movements
           (id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
            source, occurred_at, actor_user_id, request_id)
         VALUES (?, ?, ?, ?, ?, ?, 'retired', ?, 'supplier_return', ?, ?, ?)`,
      )
      .bind(
        `${ctx.requestId}::smv`,
        ctx.storeId,
        productId,
        input.stockItemId ?? null,
        input.qty,
        input.fromBucket,
        resolvedCost.unitCostCents,
        occurredAt,
        ctx.actorUserId,
        ctx.requestId,
      ),
    bumpVersionStatement(db, ctx, 'Purchase', returnId, 1),
  )

  return {
    statements,
    outcome: {
      entityType: 'StockItem',
      entityId: input.stockItemId ?? returnId,
      version: 1,
      summary: `退供 ${input.qty} 件（${input.fromBucket === 'available' ? '可取件' : '待处理件'}）`,
      effects: {
        returnNo,
        supplierReturnId: returnId,
        qty: input.qty,
        fromBucket: input.fromBucket,
        reason: input.reason.trim(),
      },
    },
    constraintCodes: {
      'supplier_returns.store_id, supplier_returns.return_no': 'VALIDATION_ERROR',
      'stock_balances.available_qty': 'VALIDATION_ERROR',
      'stock_balances.quarantine_qty': 'VALIDATION_ERROR',
    },
  }
}

/** B38 入口。 */
export async function returnToSupplier(
  db: OperationsDb,
  ctx: OperationContext,
  input: SupplierReturnInput,
): Promise<RunResult> {
  const action = 'B38'
  const reason = (input.reason ?? '').trim()
  if (!reason) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '退供必须填写原因', retryable: false, httpStatus: 400 }
  }
  if (!Number.isInteger(input.qty) || input.qty < 1) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '退供数量必须是正整数', retryable: false, httpStatus: 400 }
  }
  if (!(SUPPLIER_RETURN_BUCKETS as readonly string[]).includes(input.fromBucket)) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '退供只能从可取或待处理库存出发，不能从已占用件退供', retryable: false, httpStatus: 400 }
  }
  if (input.stockItemId && input.qty !== 1) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '逐件实物一次只能退 1 件', retryable: false, httpStatus: 400 }
  }
  if (!input.stockItemId && !input.productRef) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '退供必须指定具体实物，或指定商品与数量', retryable: false, httpStatus: 400 }
  }

  const payloadHash = await hashPayload({ input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  let productId: number | null = null
  let resolvedCost: { unitCostCents: number | null; costKnown: number } = { unitCostCents: null, costKnown: 0 }

  if (input.stockItemId) {
    const item = await readStockItemForReturn(db, ctx.storeId, input.stockItemId)
    if (!item) {
      return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '这件实物不存在或不属于当前门店', retryable: false, httpStatus: 404 }
    }
    if (item.ownership !== 'store') {
      return { ok: false, requestId: ctx.requestId, code: 'OWNERSHIP_INVALID', message: '这不是本店自有实物，不能退给供应商', retryable: false, httpStatus: 422 }
    }
    if (item.availability !== input.fromBucket) {
      return {
        ok: false,
        requestId: ctx.requestId,
        code: 'STOCK_CONFLICT',
        message: `这件实物当前状态是「${item.availability}」，不是你要退供的「${input.fromBucket}」`,
        retryable: false,
        httpStatus: 409,
      }
    }
    productId = item.product_id
    resolvedCost = { unitCostCents: item.acquisition_cost_cents, costKnown: item.cost_known }
  } else {
    const products = await resolveProducts(db, ctx.storeId, [input.productRef as string])
    const product = products.get(input.productRef as string)
    if (!product) {
      return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '商品不存在或不属于本店', retryable: false, httpStatus: 404 }
    }
    productId = product.id
    // 数量件的成本沿用移动加权平均的结果，这里只记录本次退供时点的账面成本口径。
    const balance = await db
      .prepare(
        `SELECT total_cost_cents, cost_known, available_qty, quarantine_qty
         FROM stock_balances WHERE store_id = ? AND product_id = ? AND location_id = 'store'`,
      )
      .bind(ctx.storeId, product.id)
      .first<{ total_cost_cents: number | null; cost_known: number; available_qty: number; quarantine_qty: number }>()
    const onHand = (balance?.available_qty ?? 0) + (balance?.quarantine_qty ?? 0)
    if (onHand < input.qty) {
      return {
        ok: false,
        requestId: ctx.requestId,
        code: 'STOCK_CONFLICT',
        message: `本店该商品自有在库只有 ${onHand} 件，不足以退供 ${input.qty} 件`,
        retryable: false,
        httpStatus: 409,
      }
    }
    resolvedCost = {
      unitCostCents: balance?.total_cost_cents === null || balance?.total_cost_cents === undefined || onHand === 0
        ? null
        : Math.round(balance.total_cost_cents / onHand),
      costKnown: balance?.cost_known ?? 0,
    }
  }

  if (input.costKnown === true && input.unitCostCents !== undefined && input.unitCostCents !== null) {
    resolvedCost = { unitCostCents: input.unitCostCents, costKnown: 1 }
  }

  const now = input.occurredAt && !Number.isNaN(new Date(input.occurredAt).getTime())
    ? new Date(input.occurredAt).toISOString()
    : new Date().toISOString()
  const returnId = `${ctx.requestId}::sreturn`
  const returnNo = documentNoFor('RT', ctx.requestId, now)

  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) =>
    planReturnToSupplier(db, context, input, productId as number, returnId, returnNo, now, resolvedCost),
  )
}

// ─────────────────────────────── B37 取消采购 ───────────────────────────────

interface PurchaseCancelTarget {
  id: string
  purchase_no: string
  version: number
  ordered_qty: number
  received_qty: number
  rejected_qty: number
  cancelled_qty: number
  paid_cents: number
}

interface PurchaseCancelLineTarget {
  id: string
  qty_ordered: number
  received_qty: number
  rejected_qty: number
  cancelled_qty: number
}

async function readPurchaseCancelTarget(
  db: OperationsDb,
  storeId: number,
  purchaseId: string,
): Promise<PurchaseCancelTarget | null> {
  return db
    .prepare(
      `SELECT p.id, p.purchase_no, p.version,
              COALESCE((SELECT SUM(l.qty_ordered)
                        FROM purchase_lines l
                        WHERE l.store_id = p.store_id AND l.purchase_id = p.id), 0) AS ordered_qty,
              COALESCE((SELECT SUM(rl.qty_received)
                        FROM purchase_receipt_lines rl
                        JOIN purchase_lines l ON l.store_id = rl.store_id AND l.id = rl.purchase_line_id
                        WHERE rl.store_id = p.store_id AND l.purchase_id = p.id), 0) AS received_qty,
              COALESCE((SELECT SUM(rl.qty_rejected)
                        FROM purchase_receipt_lines rl
                        JOIN purchase_lines l ON l.store_id = rl.store_id AND l.id = rl.purchase_line_id
                        WHERE rl.store_id = p.store_id AND l.purchase_id = p.id), 0) AS rejected_qty,
              COALESCE((SELECT SUM(pc.qty_cancelled)
                        FROM purchase_cancellations pc
                        WHERE pc.store_id = p.store_id AND pc.purchase_id = p.id), 0) AS cancelled_qty,
              COALESCE((SELECT SUM(CASE WHEN e.direction = 'out' THEN e.amount_cents ELSE -e.amount_cents END)
                        FROM cash_entries e
                        WHERE e.store_id = p.store_id AND e.purpose = 'purchase'
                          AND e.allocation_type = 'purchase' AND e.allocation_id = p.id), 0) AS paid_cents
       FROM purchase_orders p
       WHERE p.store_id = ? AND p.id = ?`,
    )
    .bind(storeId, purchaseId)
    .first<PurchaseCancelTarget>()
}

async function readPurchaseCancelLines(
  db: OperationsDb,
  storeId: number,
  purchaseId: string,
): Promise<PurchaseCancelLineTarget[]> {
  const rows = await db
    .prepare(
      `SELECT l.id, l.qty_ordered,
              COALESCE((SELECT SUM(rl.qty_received)
                        FROM purchase_receipt_lines rl
                        WHERE rl.store_id = l.store_id AND rl.purchase_line_id = l.id), 0) AS received_qty,
              COALESCE((SELECT SUM(rl.qty_rejected)
                        FROM purchase_receipt_lines rl
                        WHERE rl.store_id = l.store_id AND rl.purchase_line_id = l.id), 0) AS rejected_qty,
              COALESCE((SELECT SUM(pc.qty_cancelled)
                        FROM purchase_cancellations pc
                        WHERE pc.store_id = l.store_id AND pc.purchase_line_id = l.id), 0) AS cancelled_qty
       FROM purchase_lines l
       WHERE l.store_id = ? AND l.purchase_id = ?
       ORDER BY l.position ASC`,
    )
    .bind(storeId, purchaseId)
    .all<PurchaseCancelLineTarget>()
  return rows.results ?? []
}

export function planCancelPurchase(
  db: OperationsDb,
  ctx: OperationContext,
  purchase: PurchaseCancelTarget,
  input: CancelPurchaseInput,
  occurredAt: string,
): OperationPlan {
  const nextVersion = purchase.version + 1
  const totalCancelled = input.lines.reduce((sum, line) => sum + line.qty, 0)
  const nextCancelled = purchase.cancelled_qty + totalCancelled
  const nextPending = purchase.ordered_qty - purchase.received_qty - purchase.rejected_qty - nextCancelled
  const statements: D1PreparedStatement[] = [
    guardStatement(
      db,
      'ENTITY_NOT_FOUND',
      'NOT EXISTS (SELECT 1 FROM purchase_orders WHERE store_id = ? AND id = ?)',
      ctx.storeId,
      purchase.id,
    ),
    guardStatement(
      db,
      'VERSION_CONFLICT',
      'NOT EXISTS (SELECT 1 FROM purchase_orders WHERE store_id = ? AND id = ? AND version = ?)',
      ctx.storeId,
      purchase.id,
      purchase.version,
    ),
    // 付款没有对应的取消退款动作；已有净付款时不能把采购数量取消掉。
    guardStatement(
      db,
      'PURCHASE_PAYMENT_CONFLICT',
      `EXISTS (
         SELECT 1 FROM cash_entries e
         WHERE e.store_id = ? AND e.purpose = 'purchase'
           AND e.allocation_type = 'purchase' AND e.allocation_id = ?
         GROUP BY e.allocation_id
         HAVING SUM(CASE WHEN e.direction = 'out' THEN e.amount_cents ELSE -e.amount_cents END) > 0
       )`,
      ctx.storeId,
      purchase.id,
    ),
  ]

  for (const [index, line] of input.lines.entries()) {
    // 先守卫所属关系，再守卫「到货 / 拒收 / 既有取消 + 本次取消」不超过订购量。
    statements.push(
      guardStatement(
        db,
        'ENTITY_NOT_FOUND',
        'NOT EXISTS (SELECT 1 FROM purchase_lines WHERE store_id = ? AND id = ? AND purchase_id = ?)',
        ctx.storeId,
        line.purchaseLineId,
        purchase.id,
      ),
      guardStatement(
        db,
        'PURCHASE_CANCEL_EXCEEDED',
        `EXISTS (SELECT 1 FROM purchase_lines
                WHERE store_id = ? AND id = ? AND purchase_id = ?
                  AND qty_ordered <
                    ? +
                    COALESCE((SELECT SUM(rl.qty_received + rl.qty_rejected)
                              FROM purchase_receipt_lines rl
                              WHERE rl.store_id = purchase_lines.store_id
                                AND rl.purchase_line_id = purchase_lines.id), 0) +
                    COALESCE((SELECT SUM(pc.qty_cancelled)
                              FROM purchase_cancellations pc
                              WHERE pc.store_id = purchase_lines.store_id
                                AND pc.purchase_line_id = purchase_lines.id), 0))`,
        ctx.storeId,
        line.purchaseLineId,
        purchase.id,
        line.qty,
      ),
      db
        .prepare(
          `INSERT INTO purchase_cancellations
             (id, store_id, purchase_id, purchase_line_id, qty_cancelled, reason, note,
              occurred_at, request_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `${ctx.requestId}::pc-${index}`,
          ctx.storeId,
          purchase.id,
          line.purchaseLineId,
          line.qty,
          input.reason,
          (input.note ?? '').trim(),
          occurredAt,
          ctx.requestId,
          ctx.actorUserId,
        ),
    )
  }

  statements.push(
    db
      .prepare(
        `UPDATE purchase_orders
         SET version = ?, updated_at = ?
         WHERE store_id = ? AND id = ? AND version = ?`,
      )
      .bind(nextVersion, occurredAt, ctx.storeId, purchase.id, purchase.version),
    assertRowVersionStatement(db, 'VERSION_CONFLICT', 'purchase_orders', 'id', purchase.id, nextVersion),
    bumpVersionStatement(db, ctx, 'Purchase', purchase.id, nextVersion),
  )

  return {
    statements,
    outcome: {
      entityType: 'Purchase',
      entityId: purchase.id,
      version: nextVersion,
      summary: `取消采购 ${totalCancelled} 件，剩余在途 ${Math.max(nextPending, 0)} 件`,
      effects: {
        purchaseNo: purchase.purchase_no,
        cancelledQty: totalCancelled,
        cancelledTotalQty: nextCancelled,
        pendingQty: Math.max(nextPending, 0),
        reason: input.reason,
      },
    },
    constraintCodes: {
      'purchase_cancellations.store_id, purchase_cancellations.request_id, purchase_line_id': 'VALIDATION_ERROR',
    },
  }
}

/** B37 入口。只取消尚未到货 / 拒收 / 取消的采购数量。 */
export async function cancelPurchase(
  db: OperationsDb,
  ctx: OperationContext,
  purchaseId: string,
  input: CancelPurchaseInput,
): Promise<RunResult> {
  const action = 'B37'
  if (!purchaseId.trim()) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '采购单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > MAX_LINES) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: `取消明细必须是 1-${MAX_LINES} 行`, retryable: false, httpStatus: 400 }
  }
  if (!(PURCHASE_CANCEL_REASONS as readonly string[]).includes(input.reason)) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '取消原因不合法', retryable: false, httpStatus: 400 }
  }
  const seen = new Set<string>()
  for (const [index, line] of input.lines.entries()) {
    if (!line.purchaseLineId?.trim() || seen.has(line.purchaseLineId)) {
      return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: `第 ${index + 1} 行：采购行无效或重复`, retryable: false, httpStatus: 400 }
    }
    if (!Number.isInteger(line.qty) || line.qty < 1) {
      return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: `第 ${index + 1} 行：取消数量必须是正整数`, retryable: false, httpStatus: 400 }
    }
    seen.add(line.purchaseLineId)
  }

  const payloadHash = await hashPayload({ purchaseId, input })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  const purchase = await readPurchaseCancelTarget(db, ctx.storeId, purchaseId)
  if (!purchase) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '采购单不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }
  if (purchase.paid_cents > 0) {
    return { ok: false, requestId: ctx.requestId, code: 'PURCHASE_PAYMENT_CONFLICT', message: '采购单已有净付款，先处理付款冲销后才能取消未到数量', retryable: false, httpStatus: 409 }
  }

  const lines = await readPurchaseCancelLines(db, ctx.storeId, purchaseId)
  const byId = new Map(lines.map((line) => [line.id, line]))
  for (const [index, inputLine] of input.lines.entries()) {
    const line = byId.get(inputLine.purchaseLineId)
    if (!line) {
      return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: `第 ${index + 1} 行采购行不存在或不属于当前采购单`, retryable: false, httpStatus: 404 }
    }
    const availableToCancel = line.qty_ordered - line.received_qty - line.rejected_qty - line.cancelled_qty
    if (inputLine.qty > availableToCancel) {
      return {
        ok: false,
        requestId: ctx.requestId,
        code: 'PURCHASE_CANCEL_EXCEEDED',
        message: `第 ${index + 1} 行最多只能取消 ${Math.max(availableToCancel, 0)} 件；已到货 / 拒收 / 已取消数量不能再次取消`,
        retryable: false,
        httpStatus: 422,
      }
    }
  }

  const now = input.occurredAt && !Number.isNaN(new Date(input.occurredAt).getTime())
    ? new Date(input.occurredAt).toISOString()
    : new Date().toISOString()
  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) => planCancelPurchase(db, context, purchase, input, now))
}

// ─────────────────────────────── 读模型 ───────────────────────────────

export interface PurchaseListRow {
  id: string
  purchaseNo: string
  supplierName: string
  supplierRef: string | null
  saleOrderId: string | null
  expectedAt: string | null
  orderedQty: number
  receivedQty: number
  rejectedQty: number
  cancelledQty: number
  pendingQty: number
  progress: string
  lineCount: number
  /** 成本已知的采购行总额，可作为 B33 采购付款的应付基数。 */
  payableCents: number
  /** 采购资金流水净额（out - in）。 */
  paidCents: number
  remainingPayableCents: number
  createdAt: string
}

export interface PurchaseListResult {
  purchases: PurchaseListRow[]
  totals: { all: number; pending: number; completed: number; pendingQty: number }
}

export interface PurchaseListFilter {
  /** 'open' 只看还有在途的；'done' 只看已到齐的；其余为全部。 */
  scope?: string | null
  q?: string | null
  saleOrderId?: string | null
  limit?: number | null
}

interface PurchaseListRaw {
  id: string
  purchase_no: string
  supplier_name: string
  supplier_ref: string | null
  sale_order_id: string | null
  expected_at: string | null
  line_count: number
  ordered_qty: number | null
  received_qty: number | null
  rejected_qty: number | null
  cancelled_qty: number | null
  payable_cents: number | null
  paid_cents: number | null
  created_at: string
}

export async function queryPurchases(
  db: OperationsDb,
  storeId: number,
  filter: PurchaseListFilter = {},
): Promise<PurchaseListResult> {
  const limit = Number.isInteger(filter.limit) && (filter.limit as number) > 0 ? Math.min(filter.limit as number, 200) : 50
  const conditions: string[] = ['p.store_id = ?']
  const params: (string | number)[] = [storeId]
  if (filter.saleOrderId) {
    conditions.push('p.sale_order_id = ?')
    params.push(filter.saleOrderId)
  }
  const q = filter.q?.trim()
  if (q) {
    conditions.push('(p.purchase_no LIKE ? OR p.supplier_name LIKE ?)')
    params.push(`%${q}%`, `%${q}%`)
  }

  const result = await db
    .prepare(
      `SELECT p.id, p.purchase_no, p.supplier_name, p.supplier_ref, p.sale_order_id, p.expected_at,
              p.created_at,
              (SELECT COUNT(*) FROM purchase_lines l WHERE l.purchase_id = p.id) AS line_count,
              (SELECT COALESCE(SUM(qty_ordered), 0) FROM purchase_lines l WHERE l.purchase_id = p.id) AS ordered_qty,
              (SELECT COALESCE(SUM(qty_received), 0) FROM purchase_receipt_lines rl
                 WHERE rl.purchase_line_id IN (SELECT id FROM purchase_lines l WHERE l.purchase_id = p.id)) AS received_qty,
              (SELECT COALESCE(SUM(qty_rejected), 0) FROM purchase_receipt_lines rl
                 WHERE rl.purchase_line_id IN (SELECT id FROM purchase_lines l WHERE l.purchase_id = p.id)) AS rejected_qty,
              (SELECT COALESCE(SUM(pc.qty_cancelled), 0) FROM purchase_cancellations pc
                 WHERE pc.store_id = p.store_id AND pc.purchase_id = p.id) AS cancelled_qty,
              (SELECT COALESCE(SUM(CASE WHEN l.cost_known = 1 AND l.unit_cost_cents IS NOT NULL
                                        THEN (l.qty_ordered - COALESCE((SELECT SUM(pc.qty_cancelled)
                                                                       FROM purchase_cancellations pc
                                                                       WHERE pc.store_id = l.store_id AND pc.purchase_line_id = l.id), 0)) * l.unit_cost_cents
                                        ELSE 0 END), 0)
                 FROM purchase_lines l
                WHERE l.store_id = p.store_id AND l.purchase_id = p.id) AS payable_cents,
              (SELECT COALESCE(SUM(CASE WHEN e.direction = 'out' THEN e.amount_cents ELSE -e.amount_cents END), 0)
                 FROM cash_entries e
                WHERE e.store_id = p.store_id
                  AND e.purpose = 'purchase'
                  AND e.allocation_type = 'purchase'
                  AND e.allocation_id = p.id) AS paid_cents
       FROM purchase_orders p
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.created_at DESC
       LIMIT ?`,
    )
    .bind(...params, limit)
    .all<PurchaseListRaw>()

  const all: PurchaseListRow[] = (result.results ?? []).map((row) => {
    const orderedQty = Number(row.ordered_qty ?? 0)
    const receivedQty = Number(row.received_qty ?? 0)
    const rejectedQty = Number(row.rejected_qty ?? 0)
    const cancelledQty = Number(row.cancelled_qty ?? 0)
    const payableCents = Number(row.payable_cents ?? 0)
    const paidCents = Number(row.paid_cents ?? 0)
    const derived = { orderedQty, receivedQty: receivedQty + rejectedQty, cancelledQty }
    return {
      id: row.id,
      purchaseNo: row.purchase_no,
      supplierName: row.supplier_name,
      supplierRef: row.supplier_ref,
      saleOrderId: row.sale_order_id,
      expectedAt: row.expected_at,
      orderedQty,
      receivedQty,
      rejectedQty,
      cancelledQty,
      pendingQty: pendingQty(derived),
      progress: receiptProgress(derived),
      lineCount: row.line_count,
      payableCents,
      paidCents,
      remainingPayableCents: Math.max(payableCents - paidCents, 0),
      createdAt: row.created_at,
    }
  })

  const scope = filter.scope ?? null
  const purchases = scope === 'open'
    ? all.filter((row) => row.pendingQty > 0)
    : scope === 'done'
      ? all.filter((row) => row.pendingQty === 0)
      : all

  return {
    purchases,
    totals: {
      all: all.length,
      pending: all.filter((row) => row.pendingQty > 0).length,
      completed: all.filter((row) => row.pendingQty === 0).length,
      pendingQty: all.reduce((sum, row) => sum + Math.max(row.pendingQty, 0), 0),
    },
  }
}

export interface PurchaseDetailLine {
  id: string
  position: number
  productRef: string | null
  productId: number
  nameSnapshot: string
  qtyOrdered: number
  receivedQty: number
  rejectedQty: number
  cancelledQty: number
  pendingQty: number
  unitCostCents: number | null
  costKnown: boolean
}

export interface PurchaseReceiptView {
  id: string
  occurredAt: string
  note: string
  lines: {
    id: string
    position: number
    nameSnapshot: string
    qtyReceived: number
    qtyRejected: number
    disposition: string
    unitCostCents: number | null
    costKnown: boolean
    stockItemId: string | null
    assetCode: string | null
  }[]
}

export interface PurchaseDetail {
  purchase: {
    id: string
    purchaseNo: string
    version: number
    supplierName: string
    supplierRef: string | null
    supplierNote: string | null
    saleOrderId: string | null
    expectedAt: string | null
    note: string
    orderedQty: number
    receivedQty: number
    rejectedQty: number
    cancelledQty: number
    pendingQty: number
    progress: string
    /** 采购行成本总额；成本未知的行不计入该金额。 */
    payableCents: number
    /** 采购付款流水净额（out - in），反冲会抵回。 */
    paidCents: number
    /** payableCents - paidCents，最小为 0。 */
    remainingPayableCents: number
    createdAt: string
  }
  lines: PurchaseDetailLine[]
  receipts: PurchaseReceiptView[]
  cancellations: {
    id: string
    purchaseLineId: string
    qty: number
    reason: string
    note: string
    occurredAt: string
  }[]
}

export async function queryPurchaseDetail(
  db: OperationsDb,
  storeId: number,
  purchaseId: string,
): Promise<PurchaseDetail | null> {
  const head = await db
    .prepare(
      `SELECT id, purchase_no, supplier_name, supplier_ref, supplier_note, sale_order_id, expected_at, note, version, created_at
       FROM purchase_orders WHERE store_id = ? AND id = ?`,
    )
    .bind(storeId, purchaseId)
    .first<{
      id: string
      purchase_no: string
      supplier_name: string
      supplier_ref: string | null
      supplier_note: string | null
      sale_order_id: string | null
      expected_at: string | null
      note: string
      version: number
      created_at: string
    }>()
  if (!head) return null

  const lineRows = await db
    .prepare(
      `SELECT l.id, l.position, l.product_ref, l.product_id, l.name_snapshot, l.qty_ordered,
              l.unit_cost_cents, l.cost_known,
              COALESCE((SELECT SUM(rl.qty_received) FROM purchase_receipt_lines rl WHERE rl.purchase_line_id = l.id), 0) AS received_qty,
              COALESCE((SELECT SUM(rl.qty_rejected) FROM purchase_receipt_lines rl WHERE rl.purchase_line_id = l.id), 0) AS rejected_qty,
              COALESCE((SELECT SUM(pc.qty_cancelled) FROM purchase_cancellations pc WHERE pc.store_id = l.store_id AND pc.purchase_line_id = l.id), 0) AS cancelled_qty
       FROM purchase_lines l WHERE l.store_id = ? AND l.purchase_id = ? ORDER BY l.position ASC`,
    )
    .bind(storeId, purchaseId)
    .all<{
      id: string
      position: number
      product_ref: string | null
      product_id: number
      name_snapshot: string
      qty_ordered: number
      unit_cost_cents: number | null
      cost_known: number
      received_qty: number
      rejected_qty: number
      cancelled_qty: number
    }>()

  const lines: PurchaseDetailLine[] = (lineRows.results ?? []).map((row) => ({
    id: row.id,
    position: row.position,
    productRef: row.product_ref,
    productId: row.product_id,
    nameSnapshot: row.name_snapshot,
    qtyOrdered: row.qty_ordered,
    receivedQty: Number(row.received_qty ?? 0),
    rejectedQty: Number(row.rejected_qty ?? 0),
    cancelledQty: Number(row.cancelled_qty ?? 0),
    pendingQty: row.qty_ordered - Number(row.received_qty ?? 0) - Number(row.rejected_qty ?? 0) - Number(row.cancelled_qty ?? 0),
    unitCostCents: row.unit_cost_cents,
    costKnown: row.cost_known === 1,
  }))

  const receiptRows = await db
    .prepare(
      `SELECT id, occurred_at, note FROM purchase_receipts
       WHERE store_id = ? AND purchase_id = ? ORDER BY occurred_at DESC`,
    )
    .bind(storeId, purchaseId)
    .all<{ id: string; occurred_at: string; note: string }>()

  const lineNameById = new Map(lines.map((line) => [line.id, line.nameSnapshot]))
  const receipts: PurchaseReceiptView[] = []
  for (const receipt of receiptRows.results ?? []) {
    const detail = await db
      .prepare(
        // ⚠️ 到货明细不存名称快照：名称属于采购行，明细只记「这个采购行这次到了多少」。
        // 名称从本采购单的行里查（到货单可能含快速采购行，那时名称由调用方传入的 productRef 决定，
        // 这类行 purchase_line_id 为空，名称落在 product 上，见下方 fallback）。
        `SELECT id, position, qty_received, qty_rejected, inspection_disposition,
                unit_cost_cents, cost_known, stock_item_id, asset_code, purchase_line_id
         FROM purchase_receipt_lines WHERE store_id = ? AND receipt_id = ? ORDER BY position ASC`,
      )
      .bind(storeId, receipt.id)
      .all<{
        id: string
        position: number
        qty_received: number
        qty_rejected: number
        inspection_disposition: string
        unit_cost_cents: number | null
        cost_known: number
        stock_item_id: string | null
        asset_code: string | null
        purchase_line_id: string | null
      }>()
    receipts.push({
      id: receipt.id,
      occurredAt: receipt.occurred_at,
      note: receipt.note,
      lines: (detail.results ?? []).map((row) => ({
        id: row.id,
        position: row.position,
        nameSnapshot: row.purchase_line_id ? lineNameById.get(row.purchase_line_id) ?? '' : '',
        qtyReceived: row.qty_received,
        qtyRejected: row.qty_rejected,
        disposition: row.inspection_disposition,
        unitCostCents: row.unit_cost_cents,
        costKnown: row.cost_known === 1,
        stockItemId: row.stock_item_id,
        assetCode: row.asset_code,
      })),
    })
  }

  const orderedQty = lines.reduce((sum, line) => sum + line.qtyOrdered, 0)
  const receivedQty = lines.reduce((sum, line) => sum + line.receivedQty, 0)
  const rejectedQty = lines.reduce((sum, line) => sum + line.rejectedQty, 0)
  const cancelledQty = lines.reduce((sum, line) => sum + line.cancelledQty, 0)
  const derived = { orderedQty, receivedQty: receivedQty + rejectedQty, cancelledQty }

  const cancellationRows = await db
    .prepare(
      `SELECT id, purchase_line_id, qty_cancelled, reason, note, occurred_at
       FROM purchase_cancellations
       WHERE store_id = ? AND purchase_id = ?
       ORDER BY occurred_at DESC, id DESC`,
    )
    .bind(storeId, purchaseId)
    .all<{
      id: string
      purchase_line_id: string
      qty_cancelled: number
      reason: string
      note: string
      occurred_at: string
    }>()

  const payment = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE
           WHEN cost_known = 1 AND unit_cost_cents IS NOT NULL
           THEN (qty_ordered - COALESCE((SELECT SUM(pc.qty_cancelled)
                                        FROM purchase_cancellations pc
                                        WHERE pc.store_id = purchase_lines.store_id
                                          AND pc.purchase_line_id = purchase_lines.id), 0)) * unit_cost_cents
           ELSE 0 END), 0) AS payable_cents,
         COALESCE((SELECT SUM(CASE WHEN e.direction = 'out' THEN e.amount_cents ELSE -e.amount_cents END)
                   FROM cash_entries e
                   WHERE e.store_id = ? AND e.purpose = 'purchase'
                     AND e.allocation_type = 'purchase' AND e.allocation_id = ?), 0) AS paid_cents
       FROM purchase_lines
       WHERE store_id = ? AND purchase_id = ?`,
    )
    .bind(storeId, purchaseId, storeId, purchaseId)
    .first<{ payable_cents: number | null; paid_cents: number | null }>()
  const payableCents = Number(payment?.payable_cents ?? 0)
  const paidCents = Number(payment?.paid_cents ?? 0)

  return {
    purchase: {
      id: head.id,
      purchaseNo: head.purchase_no,
      version: head.version,
      supplierName: head.supplier_name,
      supplierRef: head.supplier_ref,
      supplierNote: head.supplier_note,
      saleOrderId: head.sale_order_id,
      expectedAt: head.expected_at,
      note: head.note,
      orderedQty,
      receivedQty,
      rejectedQty,
      cancelledQty,
      pendingQty: pendingQty(derived),
      progress: receiptProgress(derived),
      payableCents,
      paidCents,
      remainingPayableCents: Math.max(payableCents - paidCents, 0),
      createdAt: head.created_at,
    },
    lines,
    receipts,
    cancellations: (cancellationRows.results ?? []).map((row) => ({
      id: row.id,
      purchaseLineId: row.purchase_line_id,
      qty: row.qty_cancelled,
      reason: row.reason,
      note: row.note,
      occurredAt: row.occurred_at,
    })),
  }
}
