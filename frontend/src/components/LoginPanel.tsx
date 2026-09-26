import { useState } from 'react'
import { acceptInvitation, login, setToken } from '../utils/api'

interface Props {
  onLogin: () => void
}

export function LoginPanel({ onLogin }: Props) {
  const [email, setEmail] = useState('')
  const [inviteToken, setInviteToken] = useState('')
  const [password, setPassword] = useState('')
  const [joiningByInvite, setJoiningByInvite] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = joiningByInvite ? await acceptInvitation(inviteToken, password) : await login(email, password)
      if (res.token) { setToken(res.token); onLogin() }
    } catch (error) {
      setError(error instanceof Error ? error.message : '网络错误，请稍后重试')
    }
    setLoading(false)
  }

  return (
    <div className="login-overlay">
      <div className="login-card">
        <img className="login-brand-mark" src="/assets/xu-wen-erp-avatar.png" alt="" />
        <h2>装一下机 · 门店 ERP</h2>
        <p className="login-sub">{joiningByInvite ? '使用管理员提供的邀请码加入门店' : '登录门店，继续处理报价、库存与客户'}</p>
        <form onSubmit={handleSubmit}>
          {joiningByInvite ? <input className="login-inp" placeholder="邀请码" value={inviteToken}
            onChange={(e) => setInviteToken(e.target.value)} required /> : <input className="login-inp" aria-label="账号或邮箱" autoComplete="username" type="text" placeholder="账号 / 邮箱" value={email}
            onChange={(e) => setEmail(e.target.value)} required />}
          <input className="login-inp" aria-label="密码" autoComplete={joiningByInvite ? "new-password" : "current-password"} type="password" placeholder={joiningByInvite ? '初始密码' : '密码'} value={password}
            onChange={(e) => setPassword(e.target.value)} required minLength={6} />
          {error && <p className="login-err">{error}</p>}
          <button className="login-btn" type="submit" disabled={loading}>
            {loading ? '请稍候…' : joiningByInvite ? '加入门店' : '登录'}
          </button>
        </form>
        <button className="settings-link" type="button" onClick={() => { setJoiningByInvite((value) => !value); setError('') }}>
          {joiningByInvite ? '返回登录' : '凭邀请码加入门店'}
        </button>
      </div>
    </div>
  )
}
