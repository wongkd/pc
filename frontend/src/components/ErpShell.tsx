import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import type { Profile, Store } from '../utils/api'

export interface ErpNavItem { path: string; label: string; description: string }
interface ErpShellProps {
  currentTitle: string
  items: ErpNavItem[]
  profile: Profile
  currentStore: Store | null
  onStoreSelect: (storeId: number) => void
  onLogout: () => void
  onChangePassword: () => void
  children: ReactNode
}

export function ErpShell({ currentTitle, items, profile, currentStore, onStoreSelect, onLogout, onChangePassword, children }: ErpShellProps) {
  return <div className="erp-shell">
    <aside className="erp-sidebar no-print" aria-label="主导航"><div className="erp-brand"><span className="erp-brand-mark">PC</span><div><strong>电脑店 ERP</strong><span>经营工作台</span></div></div>
      <nav className="erp-nav">{items.map((item) => <NavLink className={({ isActive }) => `erp-nav-link${isActive ? ' is-active' : ''}`} key={item.path} to={item.path} title={item.description}><span>{item.label}</span>{item.path !== '/quotes' && item.path !== '/orders' && item.path !== '/dashboard' && item.path !== '/settings' && item.path !== '/inventory' && <small>筹备中</small>}</NavLink>)}</nav>
      <div className="erp-sidebar-footer"><button type="button" onClick={onChangePassword}>修改密码</button><button type="button" onClick={onLogout}>退出登录</button></div>
    </aside>
    <div className="erp-main"><header className="erp-topbar no-print"><div><p>电脑店轻量 ERP</p><h1>{currentTitle}</h1></div><div className="erp-account"><label>当前门店<select value={currentStore?.id ?? profile.currentStoreId} onChange={(event) => onStoreSelect(Number(event.target.value))}>{profile.stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label><span>{profile.user.email}</span></div></header><main className="erp-content">{children}</main></div>
  </div>
}
