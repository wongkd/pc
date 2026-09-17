const API_BASE = ''

export interface LibraryApiItem {
  id: number
  category: string
  description: string
  price: number
  image: string
  refreshed_at: string
  platform: string
}

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
export async function fetchLibrary(): Promise<LibraryApiItem[]> { const data = await request<unknown>('/api/library'); const rows = (Array.isArray(data) ? data : []) as any[]; return rows.map((item) => ({ id: item.id, category: item.category || '', description: item.name || '', price: Number(item.price) || 0, image: item.image || '', refreshed_at: item.refreshed_at || '', platform: item.platform || '' })) }
export function addLibraryItems(items: Array<{ category: string; description?: string; name?: string; price: number; image?: string; platform?: string }>) { const mapped = items.map((item) => ({ category: item.category, name: item.description || item.name || '', price: item.price, image: item.image || '', platform: item.platform || '' })); return request<{ ok: boolean; count: number }>('/api/library', { method: 'POST', body: JSON.stringify({ items: mapped }) }) }
export function updateLibraryItem(id: number, updates: Record<string, any>) { const mapped = Object.fromEntries(Object.entries(updates).map(([key, value]) => [key === 'description' ? 'name' : key, value])); return request<{ ok: boolean }>(`/api/library/${id}`, { method: 'PUT', body: JSON.stringify(mapped) }) }
export function deleteLibraryItem(id: number) { return request<{ ok: boolean }>(`/api/library/${id}`, { method: 'DELETE' }) }
export async function searchPrice(keyword: string): Promise<any[]> { return (await request<{ data?: any[] }>(`/api/search?q=${encodeURIComponent(keyword)}`)).data || [] }
export async function normalizeTitles(titles: string[]): Promise<any[]> { const data = await request<{ ok: boolean; items: any[]; error?: string }>('/api/normalize', { method: 'POST', body: JSON.stringify({ titles }) }); if (!data.ok) throw new Error(data.error || 'AI 解析失败'); return data.items }
export function changePassword(oldPassword: string, newPassword: string) { return request<{ ok: boolean }>('/api/auth/change-password', { method: 'PUT', body: JSON.stringify({ oldPassword, newPassword }) }) }
export async function fetchTemplates(): Promise<any[]> { const data = await request<unknown>('/api/templates'); return Array.isArray(data) ? data : [] }
export function saveTemplateToCloud(name: string, data: any) { return request<{ ok: boolean; id: number }>('/api/templates', { method: 'POST', body: JSON.stringify({ name, data }) }) }
export function deleteTemplateFromCloud(id: number) { return request<{ ok: boolean }>('/api/templates', { method: 'DELETE', body: JSON.stringify({ id }) }) }
export async function fetchQuote(): Promise<any | null> { const data = await request<any>('/api/quotes'); if (!data) return null; try { return { id: data.id, updatedAt: data.updated_at, ...JSON.parse(data.data) } } catch { return null } }
export async function saveQuote(title: string, data: any): Promise<void> { await request<{ ok: boolean }>('/api/quotes', { method: 'POST', body: JSON.stringify({ title, data }) }) }
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
export type PaymentMethod = 'cash' | 'wechat' | 'alipay' | 'transfer' | 'other'
export interface OrderItemInput { category: string; name: string; details: string; quantity: number; unitPriceCents: number; cloudId?: number }
export interface OrderCreateInput { meta: { customerName: string; contactName?: string; contactPhone?: string; customerAddress?: string; projectTitle?: string }; quoteItems: OrderItemInput[]; remark?: string; notes?: unknown; brand?: unknown }
export interface OrderItem extends OrderItemInput { id: number; lineTotalCents: number; createdAt: string; productId?: number | null; boundSnCount: number }
export interface OrderPayment { id: number; amountCents: number; paymentMethod: string; paidAt: string; remark: string; createdAt: string }
export interface Order { id: number; orderNo: string; customerName: string; customerPhone: string; projectTitle: string; totalCents: number; paidCents: number; paymentStatus: string; status: OrderStatus; remark: string; createdAt: string; updatedAt: string; items?: OrderItem[]; payments?: OrderPayment[] }
export interface DashboardTodos { todayOrders: number; pendingPurchase: number; pendingDelivery: number; receivableCents: number }
type OrderRow = { id: number; order_no: string; customer_name: string; customer_phone: string; project_title: string; total_amount_cents: number; received_amount_cents: number; payment_status: string; fulfillment_status: OrderStatus; remark: string; created_at: string; updated_at: string; items?: Array<{ id: number; category: string; name: string; details: string; quantity: number; unit_price_cents: number; line_total_cents: number; created_at: string; product_id?: number | null; bound_sn_count?: number }> ; payments?: Array<{ id: number; amount_cents: number; payment_method: string; paid_at: string; remark: string; created_at: string }> }
function mapOrder(row: OrderRow): Order { return { id: row.id, orderNo: row.order_no, customerName: row.customer_name, customerPhone: row.customer_phone, projectTitle: row.project_title, totalCents: row.total_amount_cents, paidCents: row.received_amount_cents, paymentStatus: row.payment_status, status: row.fulfillment_status, remark: row.remark, createdAt: row.created_at, updatedAt: row.updated_at, items: row.items?.map((item) => ({ id: item.id, category: item.category, name: item.name, details: item.details, quantity: item.quantity, unitPriceCents: item.unit_price_cents, lineTotalCents: item.line_total_cents, createdAt: item.created_at, productId: item.product_id ?? null, boundSnCount: item.bound_sn_count ?? 0 })), payments: row.payments?.map((payment) => ({ id: payment.id, amountCents: payment.amount_cents, paymentMethod: payment.payment_method, paidAt: payment.paid_at, remark: payment.remark, createdAt: payment.created_at })) } }
export function createOrder(input: OrderCreateInput) { return request<{ ok: true; id: number; orderNo: string }>('/api/orders', { method: 'POST', body: JSON.stringify(input) }) }
export async function fetchOrders() { const data = await request<{ items: OrderRow[] }>('/api/orders'); return data.items.map(mapOrder) }
export async function fetchOrder(id: number) { return mapOrder(await request<OrderRow>(`/api/orders/${id}`)) }
export function addOrderPayment(id: number, input: { amountCents: number; paymentMethod: string; paidAt?: string; remark?: string }) { return request<{ ok: true; receivedAmountCents: number; paymentStatus: string }>(`/api/orders/${id}/payments`, { method: 'POST', body: JSON.stringify(input) }) }
export function updateOrderStatus(id: number, fulfillmentStatus: OrderStatus) { return request<{ ok: true }>(`/api/orders/${id}/status`, { method: 'PUT', body: JSON.stringify({ fulfillmentStatus }) }) }
export async function fetchDashboardTodos(): Promise<DashboardTodos> { const data = await request<{ todayOrderCount: number; pendingPurchaseCount: number; pendingDeliveryCount: number; receivableCents: number }>('/api/dashboard/todos'); return { todayOrders: data.todayOrderCount, pendingPurchase: data.pendingPurchaseCount, pendingDelivery: data.pendingDeliveryCount, receivableCents: data.receivableCents } }

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
