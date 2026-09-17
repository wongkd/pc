/**
 * 把 TypeScript 模块打成 ESM 供本地测试直接调用。
 *
 * 为什么要这一步：miniflare 的 scriptPath 只当 JS/ESM 解析，不做 TS 转译
 * （实测报 `Unexpected token`）；而 Node 的类型擦除又不解析无扩展名的相对导入。
 * 用 esbuild 预先打包，既能让测试调到真函数，又不必为此把生产代码改成
 * 带 .ts 后缀的导入风格。
 *
 * 打包只做转译与内联，不改语义；wrangler 生产构建同样走 esbuild。
 */

import esbuild from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const backendRoot = resolve(here, '..', '..')
/** 临时构建区；目录名匹配 .gitignore 的 .validation- 前缀规则，不会进仓库。 */
export const buildRoot = join(backendRoot, '.validation-t04', 'build')

export async function bundleModule(entryRelativePath, name) {
  const entry = join(backendRoot, entryRelativePath)
  const outfile = join(buildRoot, `${name}.mjs`)
  mkdirSync(buildRoot, { recursive: true })

  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'warning',
    // 产物要可读，方便出问题时人工核对是不是同一份源码
    minify: false,
    keepNames: true,
  })

  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)
}
