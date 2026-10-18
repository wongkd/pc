import esbuild from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = resolve(root, process.argv[2] ?? '.node-host/build/worker.mjs')
await esbuild.build({ entryPoints: [resolve(root, 'src/index.ts')], outfile, bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', logLevel: 'warning' })
console.log(`Node Worker 构建完成：${outfile}`)
