// 开发时连接本地 Worker，生产环境走 Pages Functions 代理（避免 workers.dev 被墙）
const API_BASE = import.meta.env.DEV
  ? 'http://localhost:8787'
  : ''

function token(): string | null {
  return localStorage.getItem('pc-auth-token')
}

export function setToken(t: string) { localStorage.setItem('pc-auth-token', t) }
export function clearToken() { localStorage.removeItem('pc-auth-token'); localStorage.removeItem('pc-auth-email') }
export function isLoggedIn() { return !!token() }

export function setUserEmail(email: string) { localStorage.setItem('pc-auth-email', email) }
export function getUserEmail() { return localStorage.getItem('pc-auth-email') || '' }
export function isAdminUser() { return getUserEmail() === '563838884@qq.com' }

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  const t = token()
  if (t) h['Authorization'] = `Bearer ${t}`
  return h
}

export async function login(email: string, password: string) {
  const r = await fetch(`${API_BASE}/api/auth/login`, { method: 'POST', headers: headers(), body: JSON.stringify({ email, password }) })
  return r.json()
}

export async function register(email: string, password: string) {
  const r = await fetch(`${API_BASE}/api/auth/register`, { method: 'POST', headers: headers(), body: JSON.stringify({ email, password }) })
  return r.json()
}

export async function fetchLibrary(): Promise<any[]> {
  const r = await fetch(`${API_BASE}/api/library`, { headers: headers() })
  const data = await r.json()
  return Array.isArray(data) ? data : []
}

export async function addLibraryItems(items: Array<{ category: string; name: string; price: number; image?: string; platform?: string }>) {
  const r = await fetch(`${API_BASE}/api/library`, { method: 'POST', headers: headers(), body: JSON.stringify({ items }) })
  const data = await r.json()
  return { ok: data.ok, items: data.items || [] }
}

export async function updateLibraryItem(id: number, updates: Record<string, any>) {
  const r = await fetch(`${API_BASE}/api/library/${id}`, { method: 'PUT', headers: headers(), body: JSON.stringify(updates) })
  return r.json()
}

export async function deleteLibraryItem(id: number) {
  const r = await fetch(`${API_BASE}/api/library/${id}`, { method: 'DELETE', headers: headers() })
  return r.json()
}

export async function searchPrice(keyword: string): Promise<any[]> {
  const r = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(keyword)}`)
  const d = await r.json()
  return d.data || []
}

export async function normalizeTitles(titles: string[]): Promise<any[]> {
  const r = await fetch(`${API_BASE}/api/normalize`, { method: 'POST', headers: headers(), body: JSON.stringify({ titles }) })
  const d = await r.json()
  return d.ok ? d.items : []
}

export async function changePassword(oldPassword: string, newPassword: string) {
  const r = await fetch(`${API_BASE}/api/auth/change-password`, { method: 'PUT', headers: headers(), body: JSON.stringify({ oldPassword, newPassword }) })
  return r.json()
}

export async function fetchTemplates(): Promise<any[]> {
  const r = await fetch(`${API_BASE}/api/templates`, { headers: headers() })
  const data = await r.json()
  return Array.isArray(data) ? data : []
}

export async function saveTemplateToCloud(name: string, data: any) {
  const r = await fetch(`${API_BASE}/api/templates`, { method: 'POST', headers: headers(), body: JSON.stringify({ name, data }) })
  return r.json()
}

export async function deleteTemplateFromCloud(id: number) {
  const r = await fetch(`${API_BASE}/api/templates`, { method: 'DELETE', headers: headers(), body: JSON.stringify({ id }) })
  return r.json()
}

// 多端同步：获取云端应用状态
export async function fetchState(): Promise<{ ok: boolean; data: any; updated_at: string | null }> {
  const r = await fetch(`${API_BASE}/api/state`, { headers: headers() })
  return r.json()
}

// 多端同步：保存应用状态到云端
export async function saveState(data: any) {
  const r = await fetch(`${API_BASE}/api/state`, { method: 'PUT', headers: headers(), body: JSON.stringify({ data }) })
  return r.json()
}
