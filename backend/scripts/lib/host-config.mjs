import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

/** 正式模式不接受演示账号、隐式路径或固定密钥；不把密钥放进诊断。 */
export function hostConfig(args, source = process.env, root = process.cwd()) {
  const mode = source.PCQ_MODE ?? source.NODE_ENV ?? 'development'
  if (!['development', 'test', 'production'].includes(mode)) throw new Error('PCQ_MODE 必须为 development/test/production')
  const production = mode === 'production'
  const db = source.PCQ_DB ?? args.db
  const dataDir = source.PCQ_ATTACHMENTS ?? args.dataDir
  const secret = source.JWT_SECRET
  if (production) {
    if (!secret || Buffer.byteLength(secret) < 32) throw new Error('正式模式需要至少32字节的 JWT_SECRET')
    if (!source.PCQ_DB || db === ':memory:') throw new Error('正式模式需要显式持久化 PCQ_DB')
    if (!source.PCQ_ATTACHMENTS) throw new Error('正式模式需要显式 PCQ_ATTACHMENTS')
    if (args.seed || args.fresh) throw new Error('正式模式禁止 --seed/--fresh')
    if (!source.PCQ_WORKER_ENTRY) throw new Error('正式模式需要预构建 PCQ_WORKER_ENTRY')
  }
  const port = Number(source.PCQ_PORT ?? args.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口须为1–65535')
  const opening = source.INVENTORY_OPENING_MODE ?? (production ? 'closed' : 'preview')
  if (!['closed', 'preview', 'formal'].includes(opening)) throw new Error('INVENTORY_OPENING_MODE 配置无效')
  return {
    ...args, mode, production, port, db: db === ':memory:' ? db : resolve(root, db),
    dataDir: resolve(root, dataDir), entry: source.PCQ_WORKER_ENTRY ? resolve(root, source.PCQ_WORKER_ENTRY) : null,
    bindings: {
      JWT_SECRET: secret || randomBytes(48).toString('base64url'),
      DEEPSEEK_KEY: source.DEEPSEEK_KEY ?? '', PDD_CLIENT_ID: source.PDD_CLIENT_ID ?? '',
      PDD_CLIENT_SECRET: source.PDD_CLIENT_SECRET ?? '', PDD_PID: source.PDD_PID ?? '',
      INVENTORY_OPENING_MODE: opening, REQUIRE_PERSISTENT_STORAGE: 'true',
    },
  }
}
