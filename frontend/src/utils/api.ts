import type { CustomerSourceChannel } from '../contracts/generated/enums'
export type { CustomerSourceChannel } from '../contracts/generated/enums'

const API_BASE = ''

export interface Store { id: number; name: string; status: 'active' | 'disabled'; created_at?: string; updated_at?: string }
export interface Profile { user: { id: number; email: string }; stores: Array<Pick<Store, 'id' | 'name'> & { memberId?: number; isOwner?: number }>; currentStoreId: number; memberId: number; roles: string[]; permissions: string[] }
export interface Member { id: number; userId: number; email: string; status: 'active' | 'disabled'; isOwner: number | boolean; roles: string | string[] | null }
export interface Role { id: number; code: string; name: string; permissions: string | string[] | null }

function token(): string | null { return localStorage.getItem('pc-auth-token') }
export function setToken(value: string) { localStorage.setItem('pc-auth-token', value) }
export function clearToken() { localStorage.removeItem('pc-auth-token') }
export function isLoggedIn() { return !!token() }
function headers(): Record<string, string> { const result: Record<string, string> = { 'Content-Type': 'application/json' }; const value = token(); if (value) result.Authorization = `Bearer ${value}`; return result }
async function request<T>(path: string, init: RequestInit = {}): Promise<T> { const response = await fetch(`${API_BASE}${path}`, { ...init, headers: { ...headers(), ...init.headers } }); const data = await response.json().catch(() => null) as (T & { error?: string }) | null; if (!response.ok) throw new Error(data?.error || `请求失败（${response.status}）`); return data as T }

export function login(email: string, password: string) { return request<{ ok: boolean; token: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }) }
export function acceptInvitation(token: string, password: string) { return request<{ ok: boolean; token: string }>('/api/auth/accept-invitation', { method: 'POST', body: JSON.stringify({ token, password }) }) }
export function changePassword(oldPassword: string, newPassword: string) { return request<{ ok: boolean }>('/api/auth/change-password', { method: 'PUT', body: JSON.stringify({ oldPassword, newPassword }) }) }
export function fetchProfile() { return request<Profile>('/api/auth/me') }
export async function selectStore(storeId: number) { const data = await request<{ ok: boolean; token: string; storeId: number }>('/api/auth/select-store', { method: 'POST', body: JSON.stringify({ storeId }) }); setToken(data.token); return data }
export function fetchCurrentStore() { return request<Store | null>('/api/stores/current') }
export function updateCurrentStore(updates: Pick<Store, 'name'> & Partial<Pick<Store, 'status'>>) { return request<{ ok: boolean }>('/api/stores/current', { method: 'PUT', body: JSON.stringify(updates) }) }
export function fetchMembers() { return request<Member[]>('/api/members') }
export function inviteMember(input: { email: string; roleId?: number; expiresAt?: string }) { return request<{ ok: boolean; token: string; expiresAt: string }>('/api/members/invitations', { method: 'POST', body: JSON.stringify(input) }) }
export function updateMember(id: number, updates: { status?: Member['status']; roleIds?: number[] }) { return request<{ ok: boolean }>(`/api/members/${id}`, { method: 'PUT', body: JSON.stringify(updates) }) }
export function deleteMember(id: number) { return request<{ ok: boolean }>(`/api/members/${id}`, { method: 'DELETE' }) }
export function fetchRoles() { return request<Role[]>('/api/roles') }

export type OrderStatus = 'pending_purchase' | 'preparing' | 'pending_delivery' | 'delivered' | 'cancelled'

export interface Product { id: number; sku: string; name: string; category_id: number; category_name?: string; brand_id: number | null; brand_name?: string; item_type: 'product' | 'service'; status: 'active' | 'disabled'; is_serialized: number; is_salable: number; is_purchasable: number; reference_price_cents: number; default_price_cents: number; min_price_cents: number; purchase_price_cents?: number; average_cost_cents?: number; safety_stock_qty: number; warranty_months?: number }
export interface ProductInput { categoryId: number; brandId?: number | null; sku: string; name: string; itemType: 'product' | 'service'; status?: Product['status']; isSerialized: number; isSalable: number; isPurchasable: number; referencePriceCents: number; defaultPriceCents: number; minPriceCents: number; purchasePriceCents?: number; averageCostCents?: number; safetyStockQty: number; warrantyMonths?: number }
export interface ProductCategory { id: number; code: string; name: string; status: 'active' | 'disabled'; sort_order?: number }
export interface ProductBrand { id: number; name: string; normalized_name?: string; status: 'active' | 'disabled' }
export interface ProductsResponse { items: Product[]; total: number; page: number; pageSize: number }
export function fetchProducts(params: { search?: string; categoryId?: number; brandId?: number; status?: string; isSalable?: 0 | 1; isPurchasable?: 0 | 1; isSerialized?: 0 | 1; page?: number; pageSize?: number } = {}) { const query = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== '') query.set(key, String(value)) }); return request<ProductsResponse>(`/api/products${query.size ? `?${query}` : ''}`) }
export function fetchProduct(id: number) { return request<Product>(`/api/products/${id}`) }
export function createProduct(input: ProductInput) { return request<{ ok: boolean; id: number }>('/api/products', { method: 'POST', body: JSON.stringify(input) }) }
export function updateProduct(id: number, input: ProductInput) { return request<{ ok: boolean }>(`/api/products/${id}`, { method: 'PUT', body: JSON.stringify(input) }) }
export function updateProductStatus(id: number, status: Product['status']) { return request<{ ok: boolean }>(`/api/products/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }) }
export function fetchProductCategories(includeDisabled = false) { return request<ProductCategory[]>(`/api/product-categories${includeDisabled ? '?includeDisabled=1' : ''}`) }
export function createProductCategory(input: { code: string; name: string; sortOrder?: number; status?: ProductCategory['status'] }) { return request<{ ok: boolean; id: number }>('/api/product-categories', { method: 'POST', body: JSON.stringify(input) }) }
export function updateProductCategory(id: number, input: { code?: string; name?: string; sortOrder?: number; status?: ProductCategory['status'] }) { return request<{ ok: boolean }>(`/api/product-categories/${id}`, { method: 'PUT', body: JSON.stringify(input) }) }
export function fetchProductBrands(includeDisabled = false) { return request<ProductBrand[]>(`/api/product-brands${includeDisabled ? '?includeDisabled=1' : ''}`) }
export function createProductBrand(input: { name: string; normalizedName?: string; status?: ProductBrand['status'] }) { return request<{ ok: boolean; id: number }>('/api/product-brands', { method: 'POST', body: JSON.stringify(input) }) }
export function updateProductBrand(id: number, input: { name?: string; normalizedName?: string; status?: ProductBrand['status'] }) { return request<{ ok: boolean }>(`/api/product-brands/${id}`, { method: 'PUT', body: JSON.stringify(input) }) }

export type SNStatus = 'in_stock' | 'reserved' | 'picked' | 'delivered' | 'in_service' | 'returned_to_supplier' | 'scrapped'
export type WarrantyStatus = 'in_warranty' | 'expiring_soon' | 'expired' | 'not_sold'
export interface SerialNumber { id: number; sn_code: string; product_id: number; product_name?: string; status: SNStatus; purchase_ref: string; purchase_cost_cents: number; inbound_at: string | null; current_customer_name: string; current_customer_phone: string; current_order_id: number | null; delivered_at: string | null; warranty_months: number; warranty_expires_on: string | null; remark: string; created_at: string; updated_at: string; events?: SNEvent[] }
export interface SNEvent { event_type: string; source_type: string; source_id: number | null; customer_name: string; occurred_at: string; remark: string }
export interface SNRegisterInput { productId: number; snCodes: string[]; purchaseRef?: string; purchaseCostCents?: number; inboundAt?: string; warrantyMonths?: number }
export interface SNBatchPrecheck { total: number; validCodes: string[]; inputDuplicates: string[]; existingCodes: string[]; overLimitCodes: string[] }
export interface SNManualEntryInput { productId: number; snCode: string; customerName: string; customerPhone: string; deliveredAt: string; warrantyMonths?: number; remark?: string }
export interface SNBindInput { orderItemId: number; snIds: number[] }
export interface SNListResponse { items: SerialNumber[]; total: number; page: number; pageSize: number }
export interface SNWarrantyCheckItem { snCode: string; productId: number; status: string; customerName: string; customerPhone: string; deliveredAt: string | null; warrantyMonths: number; warrantyExpiresOn: string | null; warrantyStatus: WarrantyStatus; remark: string }
export function fetchSNList(params: { q?: string; status?: string; warranty?: string; productId?: number; page?: number; pageSize?: number } = {}) { const query = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== '') query.set(key, String(value)) }); return request<SNListResponse>(`/api/sn${query.size ? `?${query}` : ''}`) }
export function fetchSNDetail(id: number) { return request<SerialNumber>(`/api/sn/${id}`) }
export function precheckSNRegistration(input: Pick<SNRegisterInput, 'productId' | 'snCodes'>) { return request<SNBatchPrecheck>('/api/sn/register/precheck', { method: 'POST', body: JSON.stringify(input) }) }
export function registerSNs(input: SNRegisterInput) { return request<{ ok: boolean; inserted: number; duplicates: string[]; total: number }>('/api/sn/register', { method: 'POST', body: JSON.stringify(input) }) }
export function manualEntrySN(input: SNManualEntryInput) { return request<{ ok: boolean; id: number; snCode: string; warrantyExpiresOn: string }>('/api/sn/manual-entry', { method: 'POST', body: JSON.stringify(input) }) }
export function bindSNs(input: SNBindInput) { return request<{ ok: boolean; bound: number }>('/api/sn/bind', { method: 'POST', body: JSON.stringify(input) }) }
export function warrantyCheck(q: string) { return request<{ items: SNWarrantyCheckItem[] }>(`/api/sn/warranty-check?q=${encodeURIComponent(q)}`) }

// ── 客户主数据（E02/E04）──
//
// 与订单的关系：订单靠手机号归属到客户，所以**没有手机号的客户订单数为 0**，
// 这是服务端口径，不是前端漏算 —— 空手机号匹配全部无电话订单会算错。

export interface CustomerDevice { id: number; label: string; serialNumber: string; remark: string; createdAt: string }
export interface CustomerListItem {
  id: number
  name: string
  phone: string
  email: string
  address: string
  remark: string
  sourceChannel: CustomerSourceChannel | null
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
  orderCount: number
  totalCents: number
  receivedCents: number
}
export interface CustomerOrderSummary { id: number; orderNo: string; projectTitle: string; totalCents: number; paidCents: number; status: OrderStatus; updatedAt: string }
export interface CustomerDetail extends CustomerListItem { devices: CustomerDevice[]; orders: CustomerOrderSummary[] }
export interface CustomerInput { name: string; phone?: string; email?: string; address?: string; remark?: string; sourceChannel?: CustomerSourceChannel | ''; status?: CustomerListItem['status'] }
export interface CustomerDeviceInput { label: string; serialNumber?: string; remark?: string }

export interface CustomerListPage { items: CustomerListItem[]; nextCursor: string | null }

export async function fetchCustomers(query = '', cursor?: string): Promise<CustomerListPage> {
  const params = new URLSearchParams({ limit: '50' })
  const keyword = query.trim()
  if (keyword) params.set('q', keyword)
  if (cursor) params.set('cursor', cursor)
  return request<CustomerListPage>(`/api/customers?${params.toString()}`)
}
export function fetchCustomer(id: number) { return request<CustomerDetail>(`/api/customers/${id}`) }
export function createCustomer(input: CustomerInput) { return request<{ ok: true; id: number }>('/api/customers', { method: 'POST', body: JSON.stringify(input) }) }
export function updateCustomer(id: number, input: CustomerInput) { return request<{ ok: true }>(`/api/customers/${id}`, { method: 'PUT', body: JSON.stringify(input) }) }
export function addCustomerDevice(customerId: number, input: CustomerDeviceInput) { return request<{ ok: true; id: number }>(`/api/customers/${customerId}/devices`, { method: 'POST', body: JSON.stringify(input) }) }
export function updateCustomerDevice(customerId: number, deviceId: number, input: CustomerDeviceInput) { return request<{ ok: true }>(`/api/customers/${customerId}/devices/${deviceId}`, { method: 'PUT', body: JSON.stringify(input) }) }
export function deleteCustomerDevice(customerId: number, deviceId: number) { return request<{ ok: true }>(`/api/customers/${customerId}/devices/${deviceId}`, { method: 'DELETE' }) }
