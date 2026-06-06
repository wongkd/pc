import { useState } from 'react'
import { login, register, setToken, setUserEmail } from '../utils/api'

interface Props {
  onLogin: () => void
}

export function LoginPanel({ onLogin }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const fn = mode === 'login' ? login : register
      const res = await fn(email, password)
      if (res.error) { setError(res.error) }
      else if (res.token) { setToken(res.token); setUserEmail(res.user?.email || email); onLogin() }
    } catch {
      setError('网络错误，请稍后重试')
    }
    setLoading(false)
  }

  return (
    <div className="login-overlay">
      <div className="login-card">
        <h2>电脑报价方案</h2>
        <p className="login-sub">登录以同步云端硬件库</p>
        <form onSubmit={handleSubmit}>
          <input className="login-inp" type="email" placeholder="邮箱" value={email}
            autoCapitalize="off" autoCorrect="off" spellCheck="false"
            onChange={(e) => setEmail(e.target.value.trim())} required />
          <input className="login-inp" type="password" placeholder="密码" value={password}
            autoCapitalize="off" autoCorrect="off"
            onChange={(e) => setPassword(e.target.value.trim())} required minLength={6} />
          {error && <p className="login-err">{error}</p>}
          <button className="login-btn" type="submit" disabled={loading}>
            {loading ? '请稍候…' : mode === 'login' ? '登录' : '注册'}
          </button>
        </form>
        <p className="login-switch">
          {mode === 'login' ? '没有账号？' : '已有账号？'}
          <button type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }}>
            {mode === 'login' ? '注册' : '登录'}
          </button>
        </p>
      </div>
    </div>
  )
}
