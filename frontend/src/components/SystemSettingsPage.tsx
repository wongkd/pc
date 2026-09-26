import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Member, Role, Store } from '../utils/api'
import { deleteMember, fetchMembers, fetchRoles, fetchCurrentStore, inviteMember, updateCurrentStore, updateMember } from '../utils/api'

interface Props { permissions: string[]; currentStore: Store | null; onStoreChanged: (store: Store) => void }
export const has = (permissions: string[], permission: string) => permissions.includes('*') || permissions.includes(permission)
const list = (value: string | string[] | null) => Array.isArray(value) ? value : value ? value.split(',').filter(Boolean) : []

export function SystemSettingsPage({ permissions, currentStore, onStoreChanged }: Props) {
  const canManageMembers = has(permissions, 'member/manage')
  const canManageStore = has(permissions, 'store/manage')
  const canViewRoles = has(permissions, 'role/view')
  const [store, setStore] = useState(currentStore)
  const [members, setMembers] = useState<Member[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRoleId, setInviteRoleId] = useState('')
  const [createdInviteToken, setCreatedInviteToken] = useState('')
  const [editing, setEditing] = useState<Member | null>(null)
  const [roleIds, setRoleIds] = useState<number[]>([])

  useEffect(() => { setStore(currentStore) }, [currentStore])
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    const jobs: Promise<unknown>[] = [fetchCurrentStore().then((value) => { if (active) setStore(value) })]
    if (canManageMembers) jobs.push(fetchMembers().then((value) => { if (active) setMembers(value) }))
    if (canViewRoles) jobs.push(fetchRoles().then((value) => { if (active) setRoles(value) }))
    Promise.all(jobs).catch((reason: unknown) => active && setError(reason instanceof Error ? reason.message : '加载设置失败')).finally(() => active && setLoading(false))
    return () => { active = false }
  }, [canManageMembers, canViewRoles])

  const saveStore = async () => {
    if (!store?.name.trim()) return setError('请输入门店名称')
    try { await updateCurrentStore({ name: store.name.trim(), status: store.status }); onStoreChanged(store); setMessage('门店资料已保存') } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败') }
  }
  const sendInvite = async () => {
    try { const invite = await inviteMember({ email: inviteEmail, ...(inviteRoleId ? { roleId: Number(inviteRoleId) } : {}) }); setCreatedInviteToken(invite.token); setInviteEmail(''); setInviteRoleId(''); setInviteOpen(false); setMessage('邀请已创建'); setMembers(await fetchMembers()) } catch (reason) { setError(reason instanceof Error ? reason.message : '邀请失败') }
  }
  const saveMember = async () => {
    if (!editing) return
    try { await updateMember(editing.id, { status: editing.status, roleIds }); setEditing(null); setMembers(await fetchMembers()); setMessage('成员已更新') } catch (reason) { setError(reason instanceof Error ? reason.message : '更新失败') }
  }
  const removeMember = async (member: Member) => {
    if (!window.confirm(`确定移除成员「${member.email}」吗？`)) return
    try { await deleteMember(member.id); setMembers(await fetchMembers()); setMessage('成员已移除') } catch (reason) { setError(reason instanceof Error ? reason.message : '移除失败') }
  }

  if (loading) return <div className="settings-state">正在加载系统设置...</div>
  return <div className="settings-page">
    <div className="settings-heading"><div><p>系统设置</p><h2>门店与成员</h2></div>{message && <span className="settings-notice">{message}</span>}</div>
    {error && <div className="settings-error">{error}</div>}
    <section className="settings-section"><div className="settings-section-head"><div><h3>门店资料</h3><span>当前门店的基础信息</span></div>{canManageStore && <button className="btn primary small" onClick={saveStore}>保存</button>}</div>
      {store ? <div className="settings-form"><label>门店名称<input value={store.name} disabled={!canManageStore} onChange={(event) => setStore({ ...store, name: event.target.value })} /></label><label>门店状态<select value={store.status} disabled={!canManageStore} onChange={(event) => setStore({ ...store, status: event.target.value as Store['status'] })}><option value="active">启用</option><option value="disabled">停用</option></select></label></div> : <div className="settings-empty">暂无当前门店资料。</div>}
    </section>
    {canManageStore && <section className="settings-section"><div className="settings-section-head"><div><h3>清理草稿与空商品</h3><span>只删除未发出的报价草稿和没有业务引用的商品档案</span></div><Link className="btn secondary small" to="/settings/data-cleanup">打开清理工具</Link></div></section>}
    <section className="settings-section"><div className="settings-section-head"><div><h3>成员</h3><span>管理当前门店的账号访问权限</span></div>{canManageMembers && <button className="btn primary small" onClick={() => setInviteOpen((value) => !value)}>{inviteOpen ? '收起邀请' : '邀请成员'}</button>}</div>
      {inviteOpen && <div className="settings-invite"><label>邮箱<input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="member@example.com" /></label>{canViewRoles && <label>初始角色<select value={inviteRoleId} onChange={(event) => setInviteRoleId(event.target.value)}><option value="">暂不指定</option>{roles.map((role) => <option value={role.id} key={role.id}>{role.name}</option>)}</select></label>}<button className="btn secondary small" onClick={sendInvite} disabled={!inviteEmail}>发送邀请</button></div>}
      {createdInviteToken && <div className="settings-notice">邀请码：<code>{createdInviteToken}</code><br />将邀请码和初始密码由管理员线下交给成员</div>}
      {canManageMembers ? members.length ? <div className="settings-table-wrap"><table className="settings-table"><thead><tr><th>账号</th><th>状态</th><th>角色</th><th>操作</th></tr></thead><tbody>{members.map((member) => <tr key={member.id}><td>{member.email}{Boolean(member.isOwner) && <em>店主</em>}</td><td><span className={`settings-status ${member.status}`}>{member.status === 'active' ? '启用' : '停用'}</span></td><td>{list(member.roles).join('、') || '未分配'}</td><td>{!member.isOwner && <><button className="settings-link" onClick={() => { setEditing({ ...member }); setRoleIds(roles.filter((role) => list(member.roles).includes(role.code)).map((role) => role.id)) }}>编辑</button><button className="settings-link danger" onClick={() => removeMember(member)}>移除</button></>}</td></tr>)}</tbody></table></div> : <div className="settings-empty">当前门店还没有可管理成员。</div> : <div className="settings-empty">你没有成员管理权限。</div>}
    </section>
    {canViewRoles && <section className="settings-section"><div className="settings-section-head"><div><h3>角色说明</h3><span>角色与权限仅供查看</span></div></div>{roles.length ? <div className="role-list">{roles.map((role) => <div className="role-row" key={role.id}><strong>{role.name}</strong><span>{role.code}</span><small>{list(role.permissions).join('、') || '暂无权限'}</small></div>)}</div> : <div className="settings-empty">暂无角色配置。</div>}</section>}
    {editing && <div className="settings-overlay" onClick={() => setEditing(null)}><div className="settings-dialog" onClick={(event) => event.stopPropagation()}><h3>编辑成员</h3><label>成员状态<select value={editing.status} onChange={(event) => setEditing({ ...editing, status: event.target.value as Member['status'] })}><option value="active">启用</option><option value="disabled">停用</option></select></label>{canViewRoles && <fieldset><legend>角色</legend>{roles.map((role) => <label className="settings-check" key={role.id}><input type="checkbox" checked={roleIds.includes(role.id)} onChange={() => setRoleIds((current) => current.includes(role.id) ? current.filter((id) => id !== role.id) : [...current, role.id])} />{role.name}</label>)}</fieldset>}<div className="settings-dialog-actions"><button className="btn secondary small" onClick={() => setEditing(null)}>取消</button><button className="btn primary small" onClick={saveMember}>保存</button></div></div></div>}
  </div>
}
