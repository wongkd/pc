/**
 * T02b · 结构自检：wxml 引用的 class 是否都有样式定义。
 *
 * 为什么需要：WXSS 对「未定义的类名」不报错，写错一个类名只会**静默丢掉样式**，
 * 表现为某个元素没样式，真机上很难定位。本脚本把它变成可机械检查的项。
 *
 * 作用域与小程序实际规则一致：
 *   - 页面 `pages/x/index.wxml` 与 `packages/y/detail/index.wxml` → 本页 wxss + app.wxss 的并集；
 *   - 模板 `templates/landing.wxml` 没有同名 wxss → 只与 app.wxss 比对。
 *
 * 动态类名也算被引用：`class="filter {{activeFilter === 'all' ? 'filter-on' : ''}}"`
 * 中的 `filter`、`filter-on` 都会被提取。
 *
 * 用法：node scripts/check-classes.mjs（从任意工作目录执行均可）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const appWxssPath = path.join(root, 'app.wxss')

function parseCssClasses(css) {
  const set = new Set()
  const re = /\.([A-Za-z_][A-Za-z0-9_-]*)/g
  let m
  while ((m = re.exec(css))) set.add(m[1])
  return set
}

function wxmlClasses(src) {
  const set = new Set()
  const re = /class="([^"]*)"/g
  let m
  while ((m = re.exec(src))) {
    const raw = m[1]
    // 动态表达式里引号内的类名（如 'filter-on'）。
    // 只取形如标识符的串，避免把 `? 'a' : 'b'` 里的分隔片段当成类名。
    for (const q of raw.matchAll(/'([A-Za-z_][A-Za-z0-9_-]*)'/g)) set.add(q[1].trim())
    // 去掉 {{...}} 后剩下的静态类名
    const statics = raw.replace(/\{\{[^}]*\}\}/g, ' ')
    for (const c of statics.split(/\s+/)) if (c.trim()) set.add(c.trim())
  }
  return set
}

function collectWxml(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') collectWxml(p, out)
    } else if (entry.name.endsWith('.wxml')) {
      out.push(p)
    }
  }
  return out
}

function parseCssWithImports(css, cssPath, visited = new Set()) {
  const resolvedPath = path.resolve(cssPath)
  if (visited.has(resolvedPath)) return new Set()
  visited.add(resolvedPath)
  const classes = parseCssClasses(css)
  const importPattern = /@import\s+["']([^"']+)["']\s*;?/g
  let match
  while ((match = importPattern.exec(css))) {
    const importedPath = path.resolve(path.dirname(resolvedPath), match[1])
    if (!fs.existsSync(importedPath)) continue
    const importedClasses = parseCssWithImports(fs.readFileSync(importedPath, 'utf8'), importedPath, visited)
    for (const name of importedClasses) classes.add(name)
  }
  return classes
}

const appClasses = parseCssWithImports(fs.readFileSync(appWxssPath, 'utf8'), appWxssPath)
const files = collectWxml(root, [])
let problems = 0

for (const file of files) {
  const used = wxmlClasses(fs.readFileSync(file, 'utf8'))
  const pageWxss = file.replace(/\.wxml$/, '.wxss')
  const pageClasses = fs.existsSync(pageWxss)
    ? parseCssWithImports(fs.readFileSync(pageWxss, 'utf8'), pageWxss)
    : new Set()

  const missing = [...used].filter((c) => !appClasses.has(c) && !pageClasses.has(c))
  const rel = path.relative(root, file)
  if (missing.length) {
    problems++
    console.log(`✗ ${rel}  引用 ${used.size} 个类 ／ 未定义：${missing.join(', ')}`)
  } else {
    console.log(`✓ ${rel}  引用 ${used.size} 个类`)
  }
}

if (problems) {
  console.log(`\n✗ ${problems} 个文件存在未定义类名，检查是否有拼写错误或漏写样式。`)
  process.exit(1)
}
console.log('\n✓ 所有 wxml 引用的类名都有定义。')
