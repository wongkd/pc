import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  addCustomerDevice, createCustomer, deleteCustomerDevice, fetchCustomer, fetchCustomers, updateCustomer, updateCustomerDevice,
} from '../utils/api'
import type { CustomerDetail, CustomerDevice, CustomerInput, CustomerListItem, CustomerSourceChannel } from '../utils/api'
import '../styles/customers.css'

const statusLabels: Record<string, string> = {
  pending_purchase: '待采购', preparing: '备货中', pending_delivery: '待交付', delivered: '已交付', cancelled: '已取消',
}
const money = (cents: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(cents / 100)
const date = (value: string) => (value ? new Date(value).toLocaleDateString('zh-CN') : '—')
const sourceChannelLabels: Record<CustomerSourceChannel, string> = {
  walk_in: '到店', phone: '电话', wechat: '微信', referral: '转介绍', mini_program: '小程序', other: '其他',
}

const EMPTY_CUSTOMER: CustomerInput = { name: '', phone: '', email: '', address: '', remark: '', sourceChannel: '' }
const EMPTY_DEVICE = { label: '', serialNumber: '', remark: '' }

type CustomerFormState = { mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; id: number }
type DeviceFormState = { mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; device: CustomerDevice }

export function CustomersPage() {
  const [list, setList] = useState<CustomerListItem[]>([])
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<CustomerDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const detailRequestId = useRef(0)

  const [customerForm, setCustomerForm] = useState<CustomerFormState>({ mode: 'closed' })
  const [customerDraft, setCustomerDraft] = useState<CustomerInput>(EMPTY_CUSTOMER)
  const [savingCustomer, setSavingCustomer] = useState(false)
  const [customerFormError, setCustomerFormError] = useState('')

  const [deviceForm, setDeviceForm] = useState<DeviceFormState>({ mode: 'closed' })
  const [deviceDraft, setDeviceDraft] = useState(EMPTY_DEVICE)
  const [savingDevice, setSavingDevice] = useState(false)
  const [deletingDeviceId, setDeletingDeviceId] = useState<number | null>(null)
  const [deviceFormError, setDeviceFormError] = useState('')
  const [notice, setNotice] = useState('')

  /**
   * 取列表。
   * 注意：函数体第一件事就是 await —— 不能在 await 之前 setState。
   * 在 effect 里同步 setState 会触发级联渲染（lint 规则 react-hooks/set-state-in-effect），
   * 「正在加载」的状态由发起动作的那一方（effect 之外的事件处理）负责设置。
   */
  const loadList = useCallback(async (keyword: string) => {
    try {
      const rows = await fetchCustomers(keyword)
      setList(rows)
      setError('')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '客户台账加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async (id: number) => {
    const requestId = ++detailRequestId.current
    setDetailLoading(true)
    setDetailError('')
    try {
      const customer = await fetchCustomer(id)
      if (requestId !== detailRequestId.current) return
      setDetail(customer)
    } catch (err: unknown) {
      if (requestId !== detailRequestId.current) return
      setDetail(null)
      setDetailError(err instanceof Error ? err.message : '客户详情加载失败')
    } finally {
      if (requestId === detailRequestId.current) setDetailLoading(false)
    }
  }, [])

  // 首次加载不走 loadList：在 effect 体内同步调用一个会 setState 的函数，会触发
  // react-hooks/set-state-in-effect（级联渲染）。这里让 setState 只发生在 Promise 回调里，
  // 并且用 active 标志挡住卸载/重复调用后的回填。
  useEffect(() => {
    let active = true
    void fetchCustomers('')
      .then((rows) => {
        if (!active) return
        setList(rows)
        setError('')
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (!active) return
        setError(err instanceof Error ? err.message : '客户台账加载失败')
        setLoading(false)
      })
    return () => { active = false }
  }, [])

  /** 详情由点击驱动，不放进 effect：选中哪一行是用户动作，不是外部状态同步。 */
  const openDetail = useCallback((id: number) => {
    setSelectedId(id)
    void loadDetail(id)
  }, [loadDetail])

  const closeDetail = () => {
    detailRequestId.current += 1
    setSelectedId(null)
    setDetail(null)
    setDetailError('')
  }

  const search = (keyword: string) => {
    setLoading(true)
    void loadList(keyword)
  }

  const openCreate = () => {
    setCustomerDraft(EMPTY_CUSTOMER)
    setCustomerFormError('')
    setCustomerForm({ mode: 'create' })
  }

  const openEdit = () => {
    if (!detail) return
    setCustomerDraft({ name: detail.name, phone: detail.phone, email: detail.email, address: detail.address, remark: detail.remark, sourceChannel: detail.sourceChannel ?? '', status: detail.status })
    setCustomerFormError('')
    setCustomerForm({ mode: 'edit', id: detail.id })
  }

  async function submitCustomer(event: FormEvent) {
    event.preventDefault()
    setSavingCustomer(true)
    setCustomerFormError('')
    try {
      if (customerForm.mode === 'create') {
        const created = await createCustomer(customerDraft)
        setCustomerForm({ mode: 'closed' })
        setNotice(`已建客户档案「${customerDraft.name}」`)
        await loadList(appliedQuery)
        openDetail(created.id)
      } else if (customerForm.mode === 'edit') {
        await updateCustomer(customerForm.id, customerDraft)
        setCustomerForm({ mode: 'closed' })
        setNotice('客户资料已保存')
        await loadList(appliedQuery)
        openDetail(customerForm.id)
      }
    } catch (err: unknown) {
      // 失败时保留已填内容：重来一遍最让人恼火的不是报错，是报错后输入没了。
      setCustomerFormError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSavingCustomer(false)
    }
  }

  async function submitDevice(event: FormEvent) {
    event.preventDefault()
    if (selectedId == null) return
    setSavingDevice(true)
    setDeviceFormError('')
    try {
      if (deviceForm.mode === 'create') await addCustomerDevice(selectedId, deviceDraft)
      else if (deviceForm.mode === 'edit') await updateCustomerDevice(selectedId, deviceForm.device.id, deviceDraft)
      setDeviceForm({ mode: 'closed' })
      setDeviceDraft(EMPTY_DEVICE)
      await loadDetail(selectedId)
    } catch (err: unknown) {
      setDeviceFormError(err instanceof Error ? err.message : '设备保存失败')
    } finally {
      setSavingDevice(false)
    }
  }

  async function removeDevice(device: CustomerDevice) {
    if (selectedId == null || deletingDeviceId != null) return
    setDeletingDeviceId(device.id)
    setDeviceFormError('')
    try {
      await deleteCustomerDevice(selectedId, device.id)
      await loadDetail(selectedId)
    } catch (err: unknown) {
      setDeviceFormError(err instanceof Error ? err.message : '设备删除失败')
    } finally {
      setDeletingDeviceId(null)
    }
  }

  return (
    <section className="customers-page">
      <header className="customers-head">
        <div>
          <p className="orders-kicker">客户管理</p>
          <h2>客户台账</h2>
          <p>门店自有的客户档案，含客户带到店里的机器登记。订单按手机号归到客户名下，没留电话的散客只保留档案、不带订单。</p>
        </div>
        <div className="customers-head-actions">
          <button className="btn primary" type="button" onClick={openCreate}>新增客户</button>
        </div>
      </header>

      <form
        className="customers-toolbar"
        onSubmit={(event) => { event.preventDefault(); setAppliedQuery(query.trim()); setNotice(''); search(query.trim()) }}
      >
        <input
          aria-label="搜索客户"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入姓名或手机号后按回车"
        />
        <button className="btn" type="submit">搜索</button>
        {appliedQuery ? (
          <button className="btn" type="button" onClick={() => { setQuery(''); setAppliedQuery(''); search('') }}>清除搜索</button>
        ) : null}
        <span>{appliedQuery ? `「${appliedQuery}」匹配 ${list.length} 位客户` : `共 ${list.length} 位客户`}</span>
      </form>

      {notice ? <p className="customers-notice">{notice}</p> : null}

      <div className="customers-layout">
        <div className="customers-main">
          {loading ? (
            <div className="customers-state">正在加载客户台账…</div>
          ) : error ? (
            <div className="customers-state customers-error">
              <span>{error}</span>
              <button className="btn" type="button" onClick={() => search(appliedQuery)}>重试</button>
            </div>
          ) : list.length === 0 ? (
            <div className="customers-state">
              <strong>{appliedQuery ? '没有匹配的客户' : '还没有客户档案'}</strong>
              <span>{appliedQuery ? '换个姓名或手机号再试，或点「清除搜索」看全部。' : '点右上角「新增客户」建第一份档案；客户留了电话后，订单会自动归到他名下。'}</span>
            </div>
          ) : (
            <div className="customers-table-wrap">
              <table className="customers-table">
                <thead>
                  <tr><th>客户</th><th>来源</th><th>联系方式</th><th>订单</th><th>累计金额</th><th>已收</th><th>最近更新</th></tr>
                </thead>
                <tbody>
                  {list.map((row) => (
                    <tr
                      key={row.id}
                      className={selectedId === row.id ? 'is-selected' : ''}
                      onClick={() => openDetail(row.id)}
                    >
                      <td><strong>{row.name}</strong><small>{row.remark || '未填备注'}</small></td>
                      <td>{row.sourceChannel ? sourceChannelLabels[row.sourceChannel] : <span className="customers-muted">未记录</span>}</td>
                      <td>{row.phone || <span className="customers-muted">未留电话</span>}<small>{row.address || '未填地址'}</small></td>
                      <td>{row.orderCount} 笔</td>
                      <td>{money(row.totalCents)}</td>
                      <td>{money(row.receivedCents)}</td>
                      <td>{date(row.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {customerForm.mode !== 'closed' ? (
          <aside className="customer-detail">
            <div className="customer-detail-head">
              <div>
                <p className="orders-kicker">{customerForm.mode === 'create' ? '新增客户' : '编辑客户'}</p>
                <h3>{customerForm.mode === 'create' ? '建立客户档案' : customerDraft.name}</h3>
              </div>
              <button className="btn" type="button" onClick={() => setCustomerForm({ mode: 'closed' })}>取消</button>
            </div>
            <form className="customer-form" onSubmit={submitCustomer}>
              <label>客户名称<input value={customerDraft.name} onChange={(event) => setCustomerDraft({ ...customerDraft, name: event.target.value })} placeholder="姓名或公司名" /></label>
              <label>手机号<input value={customerDraft.phone ?? ''} onChange={(event) => setCustomerDraft({ ...customerDraft, phone: event.target.value })} placeholder="可不填；同一门店不可重号" /></label>
              <label>邮箱<input value={customerDraft.email ?? ''} onChange={(event) => setCustomerDraft({ ...customerDraft, email: event.target.value })} /></label>
              <label>地址<input value={customerDraft.address ?? ''} onChange={(event) => setCustomerDraft({ ...customerDraft, address: event.target.value })} /></label>
              <label>来源渠道（选填）
                <select value={customerDraft.sourceChannel ?? ''} onChange={(event) => setCustomerDraft({ ...customerDraft, sourceChannel: event.target.value as CustomerInput['sourceChannel'] })}>
                  <option value="">未记录</option>
                  {Object.entries(sourceChannelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label>备注<textarea rows={3} value={customerDraft.remark ?? ''} onChange={(event) => setCustomerDraft({ ...customerDraft, remark: event.target.value })} /></label>
              {customerFormError ? <p className="customers-error-text">{customerFormError}</p> : null}
              <button className="btn primary" type="submit" disabled={savingCustomer}>{savingCustomer ? '正在保存…' : '保存客户'}</button>
            </form>
          </aside>
        ) : selectedId != null ? (
          <aside className="customer-detail">
            {detailLoading ? <div className="customers-state">正在读取客户详情…</div> : detailError ? (
              <div className="customers-state customers-error">
                <span>{detailError}</span>
                <button className="btn" type="button" onClick={() => void loadDetail(selectedId)}>重试</button>
              </div>
            ) : detail ? (
              <>
                <div className="customer-detail-head">
                  <div>
                    <p className="orders-kicker">客户详情</p>
                    <h3>{detail.name}</h3>
                    <span>{detail.phone || '未留电话'}</span>
                  </div>
                  <div className="customer-detail-actions">
                    <button className="btn" type="button" onClick={openEdit}>编辑</button>
                    <button className="btn" type="button" onClick={closeDetail}>关闭</button>
                  </div>
                </div>

                <div className="customer-total">
                  <span>累计订单额</span>
                  <strong>{money(detail.totalCents)}</strong>
                  <small>
                    {detail.orderCount} 笔订单 · 已收 {money(detail.receivedCents)} · 待收 {money(Math.max(0, detail.totalCents - detail.receivedCents))}
                    {detail.phone ? '' : '（未留电话，订单不归到本人名下）'}
                  </small>
                </div>

                <dl className="customer-fields">
                  <div><dt>邮箱</dt><dd>{detail.email || '—'}</dd></div>
                  <div><dt>地址</dt><dd>{detail.address || '—'}</dd></div>
                  <div><dt>来源</dt><dd>{detail.sourceChannel ? sourceChannelLabels[detail.sourceChannel] : '未记录'}</dd></div>
                  <div><dt>备注</dt><dd>{detail.remark || '—'}</dd></div>
                  <div><dt>建档</dt><dd>{date(detail.createdAt)}</dd></div>
                </dl>

                <div className="customer-section-head">
                  <h4>客户设备</h4>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => { setDeviceDraft(EMPTY_DEVICE); setDeviceFormError(''); setDeviceForm({ mode: 'create' }) }}
                  >登记设备</button>
                </div>
                {detail.devices.length === 0 ? (
                  <p className="customers-muted">还没有登记设备。客户带机器来店时在这里留一条，方便下次直接认出是哪台。</p>
                ) : (
                  <ul className="customer-devices">
                    {detail.devices.map((device) => (
                      <li key={device.id}>
                        <div>
                          <strong>{device.label}</strong>
                          <span>{device.serialNumber || '未记序列号'}{device.remark ? ` · ${device.remark}` : ''}</span>
                        </div>
                        <div className="customer-device-actions">
                          <button className="btn" type="button" onClick={() => { setDeviceDraft({ label: device.label, serialNumber: device.serialNumber, remark: device.remark }); setDeviceFormError(''); setDeviceForm({ mode: 'edit', device }) }}>改</button>
                          <button className="btn" type="button" disabled={deletingDeviceId != null} onClick={() => void removeDevice(device)}>{deletingDeviceId === device.id ? '删除中…' : '删'}</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {deviceForm.mode !== 'closed' ? (
                  <form className="customer-form customer-device-form" onSubmit={submitDevice}>
                    <p className="orders-kicker">{deviceForm.mode === 'create' ? '登记设备' : '修改设备'}</p>
                    <label>设备名称<input value={deviceDraft.label} onChange={(event) => setDeviceDraft({ ...deviceDraft, label: event.target.value })} placeholder="如 联想拯救者 Y7000P 2024" /></label>
                    <label>机身序列号<input value={deviceDraft.serialNumber} onChange={(event) => setDeviceDraft({ ...deviceDraft, serialNumber: event.target.value })} /></label>
                    <label>备注<input value={deviceDraft.remark} onChange={(event) => setDeviceDraft({ ...deviceDraft, remark: event.target.value })} placeholder="如 外店机器，来店清灰" /></label>
                    {deviceFormError ? <p className="customers-error-text">{deviceFormError}</p> : null}
                    <div className="customer-device-actions">
                      <button className="btn primary" type="submit" disabled={savingDevice}>{savingDevice ? '正在保存…' : '保存设备'}</button>
                      <button className="btn" type="button" onClick={() => setDeviceForm({ mode: 'closed' })}>取消</button>
                    </div>
                  </form>
                ) : deviceFormError ? <p className="customers-error-text">{deviceFormError}</p> : null}

                <h4>订单记录</h4>
                {detail.orders.length === 0 ? (
                  <p className="customers-muted">暂无关联订单{detail.phone ? '。' : '；该客户没留手机号，订单不会自动归到他名下。'}</p>
                ) : (
                  <ul className="customer-orders">
                    {detail.orders.map((order) => (
                      <li key={order.id}>
                        <Link to={`/sales/orders?orderNo=${encodeURIComponent(order.orderNo)}`}>
                          <strong>{order.orderNo}</strong>
                          <span>{order.projectTitle || '未填写用途'}</span>
                        </Link>
                        <div>
                          <b>{money(order.totalCents)}</b>
                          <small>{statusLabels[order.status] ?? order.status} · 已收 {money(order.paidCents)} · {date(order.updatedAt)}</small>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : null}
          </aside>
        ) : (
          <aside className="customer-detail customers-detail-hint">
            <p className="orders-kicker">客户详情</p>
            <h3>选一位客户</h3>
            <p className="customers-muted">点左侧任意一行，查看联系方式、登记的设备和历史订单。</p>
          </aside>
        )}
      </div>
    </section>
  )
}
