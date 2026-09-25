/**
 * T03a · 会话凭证（JWT）的单一实现。
 *
 * 这段代码是从 `src/index.ts` **原样搬过来**的，算法与载荷字段都没改，
 * 所以已经在线上跑的旧客户端不受影响。
 *
 * 抽出来的理由：T03a 的微信登录要签发**同一种**凭证。如果 border 旧登录写在
 * index.ts、微信登录另写一份，同一仓库里就有两套 JWT 实现 —— 而登录凭证上的
 * 漂移是安全事故，不是代码风格问题（参考 T-10：两端各写一份必然漂移）。
 *
 * TODO(T-08)：index.ts 拆成 routes / domains 之后，本文件应成为 auth 的唯一入口。
 */

export function b64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function hmacSha256(data: string, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 签发凭证。载荷沿用旧字段：uid / email / sid / tv（tv = users.token_version）。
 * 有效期 7 天，与旧实现一致。
 */
export async function signJWT(payload: object, secret: string): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 * 7 }))
  const sig = await hmacSha256(`${header}.${body}`, secret)
  return `${header}.${body}.${sig}`
}

/** 校验签名与过期时间。任何异常一律返回 null，不外泄原因。 */
export async function verifyJWT(token: string, secret: string): Promise<Record<string, any> | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const expectedSig = await hmacSha256(`${parts[0]}.${parts[1]}`, secret)
    if (parts[2] !== expectedSig) return null
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(parts[1]), (c) => c.charCodeAt(0))))
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch { return null }
}
