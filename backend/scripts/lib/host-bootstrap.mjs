import { pbkdf2Sync, randomBytes } from 'node:crypto'

/** 只初始化空用户库，不重置任何已有账号；密钥不返回、不打印。 */
export async function bootstrapOwner(db, { email, password, storeName }) {
  if (!email?.includes('@') || !password || password.length < 12 || !storeName?.trim()) throw new Error('初始化需要有效邮箱、至少12字符密码和门店名称')
  if (await db.prepare('SELECT id FROM users LIMIT 1').first()) throw new Error('已有账号，拒绝再次初始化')
  const salt = randomBytes(16)
  const passwordHash = `${salt.toString('hex')}:${pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex')}`
  await db.batch([
    db.prepare("INSERT INTO users (id,email,password_hash,status) VALUES(1,?,?,'active')").bind(email.trim().toLowerCase(), passwordHash),
    db.prepare("INSERT INTO stores (id,name,status) VALUES(1,?,'active')").bind(storeName.trim()),
    db.prepare("INSERT INTO store_members(store_id,user_id,status,is_owner,created_by,updated_by) VALUES(1,1,'active',1,1,1)"),
  ])
}
