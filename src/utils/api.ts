const API_BASE = 'https://pc-backend.563838884.workers.dev'

function token(): string | null {
  return localStorage.getItem('pc-auth-token')
}

export function setToken(t: string) { localStorage.setItem('pc-auth-token', t) }
export function clearToken() { localStorage.removeItem('pc-auth-token') }
export function isLoggedIn() { return !!token() }

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
  return r.json()
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
