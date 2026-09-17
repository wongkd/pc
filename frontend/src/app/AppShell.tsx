import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import type { Profile, Store } from '../utils/api'
import { ACCOUNT_MENU_ITEMS, APP_NAV_ITEMS, findNavItemByPath } from './navigation'
import '../styles/theme.css'
import '../styles/appShell.css'

interface AppShellProps {
  profile: Profile
  currentStore: Store | null
  onStoreSelect: (storeId: number) => void
  onLogout: () => void
  onChangePassword: () => void
  children: ReactNode
}

/** 订阅浏览器的在线状态，避免在 effect 里同步 setState。 */
function subscribeOnline(onChange: () => void) {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

export function AppShell({
  profile,
  currentStore,
  onStoreSelect,
  onLogout,
  onChangePassword,
  children,
}: AppShellProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const accountRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  )

  const activeNav = findNavItemByPath(location.pathname)

  // 沿用旧壳对「系统设置」的可见性判断，不在换壳时放宽既有门槛。
  // 这层只是界面提示，真正的边界在后端（02 §7：不依赖前端隐藏保护权限）。
  const canSeeSettings = profile.permissions.some((code) =>
    ['*', 'store/manage', 'member/manage', 'role/view'].includes(code),
  )

  // 壳接管页面底色；卸载时还原，避免影响其他入口
  useEffect(() => {
    document.body.classList.add('wb-shell-body')
    return () => document.body.classList.remove('wb-shell-body')
  }, [])

  // Ctrl / Cmd + K 聚焦全局搜索（02 §7 键盘可达要求）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 头像菜单：Escape 关闭、点击外部关闭
  useEffect(() => {
    if (!menuOpen) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mousedown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mousedown', onPointerDown)
    }
  }, [menuOpen])

  const submitSearch = () => {
    const keyword = searchRef.current?.value.trim() ?? ''
    if (!keyword) return
    // T18 之前没有全局搜索服务：如实说明，不返回假结果。
    setNotice(`全局搜索尚未接通（T18 实现）；本次关键词「${keyword}」未提交到任何服务。`)
  }

  return (
    <div className="app-shell">
      {!online && (
        <div className="wb-offline-bar" role="status">
          未连接到网络 —— 库存与资金操作已停用，本地草稿仍可编辑。
        </div>
      )}
      <header className="wb-topbar">
        <div className="wb-brand">
          <span className="wb-brand-mark" aria-hidden="true">
            PC
          </span>
          <span className="wb-brand-copy">
            <strong>装机店经营工作台</strong>
            <small>{currentStore?.name ?? '未选择门店'}</small>
          </span>
        </div>

        <nav className="wb-nav" aria-label="主导航">
          {APP_NAV_ITEMS.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={() =>
                `wb-nav-link${activeNav?.path === item.path ? ' is-active' : ''}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="wb-topbar-side">
          <div className="wb-search">
            <input
              ref={searchRef}
              type="search"
              aria-label="全局搜索"
              placeholder="搜索单号 / 设备 / 客户"
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitSearch()
              }}
            />
            <kbd>Ctrl K</kbd>
          </div>

          <div className="wb-account" ref={accountRef}>
            <button
              type="button"
              className="wb-account-trigger"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span className="wb-account-mail">{profile.user.email}</span>
              <span className="wb-account-caret" aria-hidden="true">
                ▾
              </span>
            </button>
            {menuOpen && (
              <div className="wb-account-menu" role="menu">
                <label className="wb-account-field">
                  <span>当前门店</span>
                  <select
                    value={currentStore?.id ?? profile.currentStoreId}
                    onChange={(event) => onStoreSelect(Number(event.target.value))}
                  >
                    {profile.stores.map((store) => (
                      <option key={store.id} value={store.id}>
                        {store.name}
                      </option>
                    ))}
                  </select>
                </label>
                {canSeeSettings &&
                  ACCOUNT_MENU_ITEMS.map((item) => (
                    <button
                      key={item.path}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        navigate(item.path)
                      }}
                    >
                      {item.label}
                      <small>{item.description}</small>
                    </button>
                  ))}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onChangePassword()
                  }}
                >
                  修改密码
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onLogout()
                  }}
                >
                  退出登录
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {notice && (
        <p className="wb-notice" role="status">
          {notice}
          <button type="button" onClick={() => setNotice('')}>
            知道了
          </button>
        </p>
      )}

      <main className="wb-content">{children}</main>
    </div>
  )
}
