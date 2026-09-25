/**
 * R13 · 客户与保管设备读模型。
 *
 * 旧 `/api/customers/*` 是 E04 的兼容主数据接口，仍原样保留；这里仅认领契约的
 * `/api/v2/customers/:id` 与 `/api/v2/devices/:id`。设备来自 CustomerDevice 的
 * `customer_device_custody`，绝不能误用旧 `customer_devices` 轻量登记表。
 *
 * DTO 边界：sales/order-view 可读取联系信息、销售单索引和设备保管事实；配置版本与
 * 换件时间线还须 service/view。无论权限为何，均不返回维修成本、库存件/SN、内部诊断、
 * 附件 object key 或 components_json 原文。
 */

import { CUSTOMER_PERMISSIONS, SERVICE_PERMISSIONS, grants, type PermissionHolder } from '../domains/access'

export interface CustomerDeviceRouteEnv { DB: D1Database }
export interface CustomerDeviceRouteContext extends PermissionHolder { storeId: number }

const PREFIX = '/api/v2'
const CUSTOMER_PATH = /^\/api\/v2\/customers\/(\d+)$/
const DEVICE_PATH = /^\/api\/v2\/devices\/([^/]+)$/

function meta() {
  return { requestId: null, serverTime: new Date().toISOString(), contractVersion: 'v1' }
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ data, meta: meta() }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function fail(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message, retryable: false }, meta: meta() }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function safeComponents(raw: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => {
      const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      return {
        qty: typeof value.qty === 'number' && Number.isInteger(value.qty) ? value.qty : 0,
        chargeType: value.chargeType === 'warranty' ? 'warranty' : 'charge',
        oldItemDisposition: typeof value.oldItemDisposition === 'string' ? value.oldItemDisposition : null,
        replacementRecorded: Boolean(value.newStockItem),
      }
    })
  } catch {
    return []
  }
}

async function readConfigurations(db: D1Database, storeId: number, deviceId: string) {
  const configurations = await db.prepare(
    `SELECT revision, components_json, effective_at AS effectiveAt, change_ref AS changeRef
       FROM device_configurations
      WHERE store_id = ? AND device_id = ?
      ORDER BY revision ASC`,
  ).bind(storeId, deviceId).all<{ revision: number; components_json: string; effectiveAt: string; changeRef: string | null }>()
  const changes = await db.prepare(
    `SELECT from_revision AS fromRevision, to_revision AS toRevision, effective_at AS effectiveAt, change_ref AS changeRef
       FROM device_changes
      WHERE store_id = ? AND device_id = ?
      ORDER BY effective_at ASC, id ASC`,
  ).bind(storeId, deviceId).all<{ fromRevision: number; toRevision: number; effectiveAt: string; changeRef: string | null }>()

  return {
    configurations: (configurations.results ?? []).map((row) => ({
      revision: row.revision,
      components: safeComponents(row.components_json),
      effectiveAt: row.effectiveAt,
      changeRef: row.changeRef,
    })),
    changes: changes.results ?? [],
  }
}

async function handleCustomer(env: CustomerDeviceRouteEnv, context: CustomerDeviceRouteContext, id: number): Promise<Response> {
  const customer = await env.DB.prepare(
    `SELECT id, name, phone, email, address, status
       FROM customers WHERE id = ? AND store_id = ?`,
  ).bind(id, context.storeId).first<Record<string, unknown>>()
  if (!customer) return fail('ENTITY_NOT_FOUND', '客户不存在或不属于当前门店', 404)

  const devices = await env.DB.prepare(
    `SELECT id, device_code AS deviceCode, original_order_id AS originalOrderId,
            current_configuration_id AS currentConfigurationId, custody_location AS custodyLocation
       FROM customer_device_custody
      WHERE store_id = ? AND owner_customer_id = ? ORDER BY created_at DESC, id DESC`,
  ).bind(context.storeId, id).all()
  const orders = await env.DB.prepare(
    `SELECT id, order_no AS orderNo, trade_state AS tradeState, fulfillment_state AS fulfillmentState, created_at AS createdAt
       FROM sale_orders WHERE store_id = ? AND customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`,
  ).bind(context.storeId, id).all()

  return ok({ customer, devices: devices.results ?? [], salesOrders: orders.results ?? [] })
}

async function handleDevice(env: CustomerDeviceRouteEnv, context: CustomerDeviceRouteContext, rawId: string): Promise<Response> {
  let id: string
  try { id = decodeURIComponent(rawId) } catch { return fail('VALIDATION_ERROR', '设备编号无法解析', 400) }
  if (!id) return fail('VALIDATION_ERROR', '设备编号不能为空', 400)

  const device = await env.DB.prepare(
    `SELECT d.id, d.owner_customer_id AS ownerCustomerId, d.device_code AS deviceCode,
            d.original_order_id AS originalOrderId, d.current_configuration_id AS currentConfigurationId,
            d.custody_location AS custodyLocation, c.name AS ownerName
       FROM customer_device_custody d
       LEFT JOIN customers c ON c.id = d.owner_customer_id AND c.store_id = d.store_id
      WHERE d.store_id = ? AND d.id = ?`,
  ).bind(context.storeId, id).first<Record<string, unknown>>()
  if (!device) return fail('ENTITY_NOT_FOUND', '设备不存在或不属于当前门店', 404)

  // 配置历史是维修域资料：销售只读角色仍可看设备归属，却不能获取维修过程。
  const serviceReadable = grants(context, SERVICE_PERMISSIONS.view)
  const history = serviceReadable ? await readConfigurations(env.DB, context.storeId, id) : null
  return ok({ device, configurationHistory: history })
}

/** 返回 null 表示路径不属于 R13。 */
export async function routeCustomerDeviceV2(
  req: Request,
  env: CustomerDeviceRouteEnv,
  context: CustomerDeviceRouteContext,
): Promise<Response | null> {
  const path = new URL(req.url).pathname
  const customerMatch = CUSTOMER_PATH.exec(path)
  const deviceMatch = DEVICE_PATH.exec(path)
  if (!customerMatch && !deviceMatch) return null
  if (req.method !== 'GET') return fail('VALIDATION_ERROR', '该方法不支持', 405)
  if (!grants(context, CUSTOMER_PERMISSIONS.view)) return fail('PERMISSION_DENIED', '无该动作权限', 403)
  if (customerMatch) return handleCustomer(env, context, Number(customerMatch[1]))
  return handleDevice(env, context, deviceMatch![1])
}
