import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const communityTs = fs.readFileSync(new URL('../pages/community/index.ts', import.meta.url), 'utf8')
const fixtures = fs.readFileSync(new URL('../features/customer/fixtures.ts', import.meta.url), 'utf8')
const communityWxml = fs.readFileSync(new URL('../pages/community/index.wxml', import.meta.url), 'utf8')
const communityWxss = fs.readFileSync(new URL('../pages/community/index.wxss', import.meta.url), 'utf8')
const communityJson = JSON.parse(fs.readFileSync(new URL('../pages/community/index.json', import.meta.url), 'utf8'))
const mineTs = fs.readFileSync(new URL('../pages/mine/index.ts', import.meta.url), 'utf8')
const mineWxml = fs.readFileSync(new URL('../pages/mine/index.wxml', import.meta.url), 'utf8')
const navWxml = fs.readFileSync(new URL('../components/customer-nav/index.wxml', import.meta.url), 'utf8')
const navWxss = fs.readFileSync(new URL('../components/customer-nav/index.wxss', import.meta.url), 'utf8')
const navTs = fs.readFileSync(new URL('../components/customer-nav/index.ts', import.meta.url), 'utf8')

test('社区保留三类入口、分类过滤及三种独立图文节奏', () => {
  for (const category of ['装机案例', '电脑知识', '门店公告']) assert.ok(communityTs.includes(category))
  assert.match(communityTs, /items\.filter\(\(item\) => item\.category === category\)/)
  for (const layout of ['large', 'compact', 'horizontal']) {
    assert.ok(communityTs.includes(layout))
  }
  assert.ok(communityWxss.includes('.community-card {'))
  assert.ok(communityWxss.includes('.community-card-horizontal '))
  assert.match(communityWxml, /item\.layout === horizontalLayout \? 'community-card-horizontal'/)
  // 清爽稿第二张图约 325 × 136，宽高比 2.39。
  assert.match(communityTs, /layout: 'compact', aspectRatio: 2\.39/)
  assert.match(communityWxml, /wx:if="\{\{posts\.length === 0\}\}"/)
  assert.ok(communityJson.usingComponents['customer-image'].endsWith('/customer-image/index'))
  assert.ok(communityJson.usingComponents['customer-state'].endsWith('/customer-state/index'))
  for (const asset of ['post-cream-desk.jpg', 'post-dark-desk.jpg', 'post-cooling.jpg', 'cat-gold-lounging.png']) {
    assert.ok(`${fixtures}\n${communityWxml}`.includes(asset))
    assert.ok(fs.existsSync(new URL(`../assets/customer/${asset}`, import.meta.url)))
  }
  assert.match(communityWxml, /<customer-image/)
  assert.match(communityWxml, /<customer-state/)
  assert.match(communityTs, /data: \{[\s\S]*?selectedCategory: '装机案例'/)
})

test('我的页未知记录显示横线、四项统计与菜单都有具名处理器', () => {
  assert.match(mineTs, /value: '—'/)
  for (const method of ['onArchiveTap', 'onStatTap', 'onMenuTap', 'onStoreTap', 'onNavAction']) {
    assert.match(mineTs, new RegExp(`${method}\\(`))
    assert.ok(mineWxml.includes(method))
  }
  assert.match(mineWxml, /bindtap="onMenuTap"/)
  assert.match(mineWxml, /bindtap="onStoreTap"/)
  assert.match(mineWxml, /mine-actions="\{\{true\}\}" bind:action="onNavAction"/)
  assert.match(navWxml, /wx:if="\{\{mineActions\}\}"/)
  assert.match(navWxml, /menuQr-active\.png/)
  assert.match(navWxml, /menuSettings-active\.png/)
  for (const [handler, action] of [['onQrTap', 'qr'], ['onSettingsTap', 'settings']]) {
    assert.ok(navWxml.includes(`bindtap="${handler}"`))
    assert.match(navTs, new RegExp(`${handler}\\(\\)\\s*\\{\\s*this\\.triggerEvent\\('action', \\{ action: '${action}' \\}\\)`))
  }
  assert.ok(fs.existsSync(new URL('../assets/customer/menuQr-active.png', import.meta.url)))
  assert.ok(fs.existsSync(new URL('../assets/customer/menuSettings-active.png', import.meta.url)))
  assert.match(navWxss, /customer-nav__action[\s\S]*?width: 44px/)
})
