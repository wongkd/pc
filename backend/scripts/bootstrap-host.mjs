import { resolve } from 'node:path'
import { createLocalD1 } from './lib/d1-sqlite.mjs'
import { bootstrapOwner } from './lib/host-bootstrap.mjs'

if (!process.env.PCQ_DB) throw new Error('需要已迁移的 PCQ_DB')
const db = createLocalD1(resolve(process.env.PCQ_DB))
try {
  await bootstrapOwner(db, { email: process.env.PCQ_OWNER_EMAIL, password: process.env.PCQ_OWNER_PASSWORD, storeName: process.env.PCQ_STORE_NAME })
  console.log('门店与老板已初始化；请立即从受控环境移除初始化密码变量')
} finally { db.close() }
