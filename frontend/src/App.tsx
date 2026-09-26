import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { AppShell } from './app/AppShell'
import { LazyRoute } from './app/lazy-route'
import { SALES_WORKSPACE } from './app/workspaces'
import { LoginPanel } from './components/LoginPanel'
import { ModulePlaceholderPage } from './components/ModulePlaceholderPage'
import { clearToken, isLoggedIn, changePassword, fetchCurrentStore, fetchProfile, selectStore } from './utils/api'
import type { Profile, Store } from './utils/api'
import { WorkbenchTodayPage } from './features/workbench/WorkbenchTodayPage'
import './index.css'
import './styles/erp-polish.css'

/**
 * 业务页面按需加载（P01）。
 *
 * 这些加载器**必须写成模块级常量**：写成内联箭头函数的话，每次渲染都是新引用，
 * lazy 会当成新组件重新挂载，页面里的筛选、草稿和滚动位置会被清空。
 *
 * 刻意保留为静态导入的只有：登录页、外壳、今天页（登录后落点）和占位页（未知地址要立刻出结果）。
 * 改为按需加载后，首屏不再包含仓库、报价、销售、售后、回收、账本、设置等页面的代码。
 */
const loadWorkspaceLandingPage = () =>
  import('./app/WorkspaceLandingPage').then((m) => ({ default: m.WorkspaceLandingPage }))
const loadQuotePage = () => import('./features/workbench/WorkbenchQuotePage')
const loadSalesPage = () =>
  import('./features/workbench/WorkbenchSalesPage').then((m) => ({ default: m.WorkbenchSalesPage }))
const loadFulfillmentPage = () =>
  import('./features/workbench/WorkbenchFulfillmentPage').then((m) => ({ default: m.WorkbenchFulfillmentPage }))
const loadPurchasePage = () =>
  import('./features/workbench/WorkbenchPurchasePage').then((m) => ({ default: m.WorkbenchPurchasePage }))
const loadFinancePage = () =>
  import('./features/workbench/WorkbenchFinancePage').then((m) => ({ default: m.WorkbenchFinancePage }))
const loadServicePage = () =>
  import('./features/workbench/WorkbenchServicePage').then((m) => ({ default: m.WorkbenchServicePage }))
const loadRecoveryPage = () =>
  import('./features/workbench/WorkbenchRecoveryPage').then((m) => ({ default: m.WorkbenchRecoveryPage }))
const loadInventoryPage = () =>
  import('./features/workbench/WorkbenchInventoryPage').then((m) => ({ default: m.WorkbenchInventoryPage }))
const loadCustomersPage = () => import('./components/CustomersPage').then((m) => ({ default: m.CustomersPage }))
const loadProductsPage = () =>
  import('./components/ProductManagementPage').then((m) => ({ default: m.ProductManagementPage }))
const loadSerialNumberPage = () =>
  import('./components/SerialNumberPage').then((m) => ({ default: m.SerialNumberPage }))
const loadSettingsPage = () =>
  import('./components/SystemSettingsPage').then((m) => ({ default: m.SystemSettingsPage }))
const loadDataCleanupPage = () =>
  import('./features/admin/TestDataCleanupPage').then((m) => ({ default: m.TestDataCleanupPage }))

const RETIRED_QUOTE_STORAGE_KEYS = ['pc-quote-app', 'pc-quote-app:merchant-templates']

function clearRetiredQuoteStorage() {
  try {
    for (const key of RETIRED_QUOTE_STORAGE_KEYS) window.localStorage.removeItem(key)
  } catch {
    // Storage can be unavailable in restricted browser modes; it must not block the ERP.
  }
}

export default function App() {
  const navigate = useNavigate()
  const [loggedIn, setLoggedIn] = useState(isLoggedIn)
  const [session, setSession] = useState<{ profile: Profile; store: Store | null } | null>(null)
  const [showPwdModal, setShowPwdModal] = useState(false)
  const [pwdOld, setPwdOld] = useState('')
  const [pwdNew, setPwdNew] = useState('')
  const [pwdMsg, setPwdMsg] = useState('')

  useEffect(() => {
    clearRetiredQuoteStorage()
  }, [])

  useEffect(() => {
    if (!loggedIn) return
    let active = true
    Promise.all([fetchProfile(), fetchCurrentStore()]).then(([profile, store]) => {
      if (active) setSession({ profile, store })
    }).catch(() => {
      if (active) { clearToken(); setLoggedIn(false); setSession(null) }
    })
    return () => { active = false }
  }, [loggedIn])

  const handleLogout = () => { clearToken(); setLoggedIn(false); setSession(null) }
  const handleStoreSelect = async (storeId: number) => {
    setSession(null)
    try {
      await selectStore(storeId)
      const [profile, store] = await Promise.all([fetchProfile(), fetchCurrentStore()])
      setSession({ profile, store })
    } catch { handleLogout() }
  }
  const handleChangePwd = async () => {
    setPwdMsg('')
    if (!pwdOld || pwdNew.length < 6) { setPwdMsg('新密码至少6位'); return }
    try {
      await changePassword(pwdOld, pwdNew)
      setShowPwdModal(false); setPwdOld(''); setPwdNew(''); handleLogout()
    } catch (error) { setPwdMsg(error instanceof Error ? error.message : '修改失败') }
  }
  if (!loggedIn) return <LoginPanel onLogin={() => { setLoggedIn(true); navigate('/dashboard', { replace: true }) }} />
  if (!session) return <div className="settings-state">正在验证登录状态...</div>
  const { profile, store: currentStore } = session
  const setCurrentStore = (store: Store) => setSession(current => current ? { ...current, store } : null)

  return (
    <div className="shell">
      <AppShell profile={profile} currentStore={currentStore} onStoreSelect={handleStoreSelect}
        onChangePassword={() => setShowPwdModal(true)} onLogout={handleLogout}>
        {showPwdModal && (
          <div className="pwd-overlay" onClick={() => setShowPwdModal(false)}>
            <div className="pwd-card" onClick={event => event.stopPropagation()}>
              <h3>修改密码</h3>
              <input type="password" placeholder="旧密码" value={pwdOld} onChange={event => setPwdOld(event.target.value)} />
              <input type="password" placeholder="新密码（至少6位）" value={pwdNew} onChange={event => setPwdNew(event.target.value)} />
              {pwdMsg && <p className="pwd-msg">{pwdMsg}</p>}
              <button onClick={handleChangePwd}>确认修改</button>
            </div>
          </div>
        )}
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/quotes" element={<Navigate to="/sales/quotes" replace />} />
          <Route path="/dashboard" element={<WorkbenchTodayPage />} />
          <Route path="/sales" element={<LazyRoute load={loadWorkspaceLandingPage} label="开单" props={{ ...SALES_WORKSPACE }} />} />
          {/* E05：报价单闭环（列表 / 草稿 / 版本 / 发出）。占位项「新建装机报价（T07）」由此落地。 */}
          <Route path="/sales/quotes" element={<LazyRoute load={loadQuotePage} label="装机报价" props={{ permissions: profile.permissions, onConverted: () => navigate('/sales/orders') }} />} />
          {/* E06：销售单与收款（转单 / 收款 / 确认成交与占用 / 缺件）。 */}
          <Route path="/sales/orders" element={<LazyRoute load={loadSalesPage} label="销售订单" props={{ permissions: profile.permissions }} />} />
          {/* E08：装机、检测与交付（B04 建单 / B06 备料 / B07 检测 / B10 交付）。 */}
          <Route path="/sales/fulfillment" element={<LazyRoute load={loadFulfillmentPage} label="装机与交付" props={{ permissions: profile.permissions }} />} />
          {/* E07：缺件采购与到货。契约 R08 的路径在 /inventory 下，旧深链 /purchases 指向同一页。 */}
          <Route path="/inventory/purchases" element={<LazyRoute load={loadPurchasePage} label="采购到货" props={{ permissions: profile.permissions }} />} />
          <Route path="/purchases" element={<LazyRoute load={loadPurchasePage} label="采购到货" props={{ permissions: profile.permissions }} />} />
          {/* E09：账本（现金流 / 应收应付 / 反冲）。 */}
          <Route path="/finance" element={<LazyRoute load={loadFinancePage} label="账本" props={{ permissions: profile.permissions }} />} />
          {/* E10：售后维修（接修 / 检测方案 / 换件 / 收款 / 归还）。 */}
          <Route path="/after-sales" element={<LazyRoute load={loadServicePage} label="售后维修" props={{ permissions: profile.permissions }} />} />
          {/* E11：回收置换（登记 / 验机 / 估价 / 取得所有权 / 付款 / 拆件 / 归还）。 */}
          <Route path="/recovery" element={<LazyRoute load={loadRecoveryPage} label="收旧件" props={{ permissions: profile.permissions }} />} />
          <Route path="/orders" element={<Navigate to="/sales/orders" replace />} />
          <Route path="/orders/:id" element={<Navigate to="/sales/orders" replace />} />
          <Route path="/customers" element={<LazyRoute load={loadCustomersPage} label="客户台账" props={{}} />} />
          <Route path="/settings" element={<LazyRoute load={loadSettingsPage} label="系统设置" props={{ permissions: profile.permissions, currentStore: currentStore, onStoreChanged: setCurrentStore }} />} />
          <Route path="/settings/data-cleanup" element={<LazyRoute load={loadDataCleanupPage} label="测试数据清理" props={{ permissions: profile.permissions }} />} />
          <Route path="/inventory" element={<LazyRoute load={loadInventoryPage} label="仓库" props={{ permissions: profile.permissions }} />} />
          {/* 旧「商品与库存」页不删，改挂子路径：它是已确认功能，不能因为库存页重建而失去入口。 */}
          <Route path="/inventory/products" element={<LazyRoute load={loadProductsPage} label="商品管理" props={{ permissions: profile.permissions }} />} />
          <Route path="/sn" element={<LazyRoute load={loadSerialNumberPage} label="序列号台账" props={{}} />} />

          <Route path="/assembly" element={<Navigate to="/sales/fulfillment" replace />} />
          <Route path="/suppliers" element={<ModulePlaceholderPage title="供应商管理" description="供应商独立管理页面尚未接通。" />} />
          <Route path="*" element={<ModulePlaceholderPage title="页面不存在" description="当前地址未对应 ERP 页面。" />} />
        </Routes>
      </AppShell>
    </div>
  )
}
