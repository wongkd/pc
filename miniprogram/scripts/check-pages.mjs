#!/usr/bin/env node
/**
 * T02b · 小程序结构自检。
 *
 *   node miniprogram/scripts/check-pages.mjs
 *
 * 校验三件事：
 *   1. app.json 声明的每个页面，磁盘上都有对应的 .ts 与 .wxml；
 *   2. custom tabBar 符合顾客端四项「首页、商城、社区、我的」，且页面都在主包；
 *   3. 磁盘上不存在「已建但未被 app.json 引用」的页面目录（漏注册同样是缺陷）。
 *
 * 这不是「能在微信里跑起来」的证明 —— 那是开发者工具与真机的事（见验证记录）。
 * 它只保证「注册表与文件系统一致」，这一层不需要运行时就能机械验证。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')

/**
 * 顾客端 tabBar：首页 / 商城 / 社区 / 我的（栋哥 2026-09-19 确认）——顺序也是定案的一部分。
 *
 * 小程序已收拢为顾客端；内部 ERP 只留在网页。
 * 旧店员页与销售/库存详情分包已从 app.json 和源码移除。
 */
const EXPECTED_TABBAR = ['首页', '商城', '社区', '我的']
const EXPECTED_TAB_PATHS = [
  'pages/home/index',
  'pages/shop/index',
  'pages/community/index',
  'pages/mine/index',
]
const REMOVED_STAFF_PAGES = [
  'pages/today/index',
  'pages/sales/index',
  'pages/inventory/index',
  'pages/more/index',
  'packages/sales/order-detail/index',
  'packages/inventory/item-detail/index',
]

/** 页面必须存在的文件后缀。页面级 json / wxss 可省略，故不强制。 */
const REQUIRED_EXTS = ['ts', 'wxml']

const failures = []
const notes = []

const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'))

// ── 1. 主包页面 ─────────────────────────────────────────────────────────
const mainPages = appJson.pages ?? []
if (!Array.isArray(mainPages) || mainPages.length === 0) {
  failures.push('app.json 未声明任何主包页面')
}

// ── 2. tabBar ───────────────────────────────────────────────────────────
const tabList = appJson.tabBar?.list ?? []
if (tabList.length !== EXPECTED_TABBAR.length) {
  failures.push(`tabBar 应为 ${EXPECTED_TABBAR.length} 项，实际 ${tabList.length} 项`)
}
const tabTexts = tabList.map((t) => t.text)
if (JSON.stringify(tabTexts) !== JSON.stringify(EXPECTED_TABBAR)) {
  failures.push(
    `tabBar 文案与 02 §4 不符：期望 ${EXPECTED_TABBAR.join('、')}，实际 ${tabTexts.join('、')}`
  )
}
const tabPaths = tabList.map((tab) => tab.pagePath)
if (JSON.stringify(tabPaths) !== JSON.stringify(EXPECTED_TAB_PATHS)) {
  failures.push(`tabBar 页面顺序错误：期望 ${EXPECTED_TAB_PATHS.join('、')}，实际 ${tabPaths.join('、')}`)
}
for (const item of tabList) {
  if (!item.pagePath) {
    failures.push('存在缺少 pagePath 的 tabBar 项')
    continue
  }
  if (!mainPages.includes(item.pagePath)) {
    failures.push(`tabBar 页面必须在主包 pages 中：${item.pagePath}`)
  }
}
if (appJson.tabBar?.custom !== true) {
  failures.push('顾客 tabBar 必须启用 custom:true')
}
if (appJson.tabBar && appJson.tabBar.selectedColor !== '#111111') {
  failures.push(`tabBar 选中色应为顾客主文字 #111111，实际 ${appJson.tabBar.selectedColor}`)
}
if (appJson.tabBar && appJson.tabBar.color !== '#808080') {
  failures.push(`tabBar 未选中色应为顾客辅助文字 #808080，实际 ${appJson.tabBar.color}`)
}
const customTabBarFiles = ['index.ts', 'index.wxml', 'index.wxss', 'index.json']
for (const name of customTabBarFiles) {
  if (!existsSync(join(projectRoot, 'custom-tab-bar', name))) {
    failures.push(`自定义底栏文件缺失：custom-tab-bar/${name}`)
  }
}
for (const item of tabList) {
  for (const key of ['iconPath', 'selectedIconPath']) {
    if (item[key] && !existsSync(join(projectRoot, ...item[key].split('/')))) {
      failures.push(`tabBar 图标文件缺失：${item[key]}`)
    }
  }
}

// ── 3. 分包页面 ─────────────────────────────────────────────────────────
const subPages = []
for (const sub of appJson.subPackages ?? []) {
  if (!sub.root) {
    failures.push('存在缺少 root 的 subPackages 项')
    continue
  }
  if (!Array.isArray(sub.pages) || sub.pages.length === 0) {
    failures.push(`分包 ${sub.root} 未声明任何页面`)
    continue
  }
  for (const p of sub.pages) subPages.push(`${sub.root}/${p}`.replace(/\/{2,}/g, '/'))
}

const declaredPages = [...mainPages, ...subPages]
for (const page of REMOVED_STAFF_PAGES) {
  const pageFile = join(projectRoot, ...`${page}.wxml`.split('/'))
  if (declaredPages.includes(page) || existsSync(pageFile)) {
    failures.push(`旧店员页仍存在：${page}`)
  }
}
if (new Set(declaredPages).size !== declaredPages.length) {
  failures.push('app.json 中存在重复声明的页面路径')
}

// ── 4. 声明 → 磁盘 ──────────────────────────────────────────────────────
for (const page of declaredPages) {
  for (const ext of REQUIRED_EXTS) {
    const file = join(projectRoot, ...`${page}.${ext}`.split('/'))
    if (!existsSync(file)) failures.push(`页面文件缺失：${page}.${ext}`)
  }
}

// ── 5. 磁盘 → 声明（漏注册） ────────────────────────────────────────────
function findPageFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) findPageFiles(full, acc)
    else if (name.endsWith('.wxml')) {
      const rel = full.slice(projectRoot.length + 1).split('\\').join('/').replace(/\.wxml$/, '')
      acc.push(rel)
    }
  }
  return acc
}

const onDisk = [...findPageFiles(join(projectRoot, 'pages')), ...findPageFiles(join(projectRoot, 'packages'))]
for (const page of onDisk) {
  if (!declaredPages.includes(page)) failures.push(`磁盘上存在未被 app.json 注册的页面：${page}`)
}

// ── 6. 结果 ─────────────────────────────────────────────────────────────
notes.push(`主包页面 ${mainPages.length} 个：${mainPages.join('、')}`)
if (subPages.length) notes.push(`分包页面 ${subPages.length} 个：${subPages.join('、')}`)
notes.push(`磁盘页面 ${onDisk.length} 个，全部已在 app.json 注册`)

for (const n of notes) console.log('  · ' + n)
if (failures.length) {
  console.error(`\n✗ 结构自检失败 ${failures.length} 项：`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('\n✓ 结构自检通过：app.json 注册与磁盘文件一致，顾客 custom tabBar 四项与顺序一致。')
