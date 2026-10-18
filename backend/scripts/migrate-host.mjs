import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalD1 } from './lib/d1-sqlite.mjs'
import { migrateHost } from './lib/host-migrations.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (!process.env.PCQ_DB || args.some((arg, index) => index % 2 === 0 && arg !== '--baseline')) throw new Error('用法：PCQ_DB=<已有库> node scripts/migrate-host.mjs [--baseline <已应用文件>]')
const db = createLocalD1(resolve(root, process.env.PCQ_DB))
try { console.log(JSON.stringify(migrateHost(db, resolve(root, 'migrations'), { baseline: args[1] }))) }
finally { db.close() }
