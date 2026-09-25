import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const homeWxml = read('../pages/home/index.wxml')
const homeTs = read('../pages/home/index.ts')
const shopWxml = read('../pages/shop/index.wxml')
const shopTs = read('../pages/shop/index.ts')
const shopWxss = read('../pages/shop/index.wxss')
const fixtures = read('../features/customer/fixtures.ts')

test('首页主视觉使用独立字标、主图、双猫与唯一副句', () => {
  assert.match(homeWxml, /brand-wordmark\.png/)
  assert.match(homeTs, /hero-home\.jpg/)
  assert.match(homeTs, /banner-home\.jpg/)
  assert.match(homeWxml, /cat-home-pair\.png/)
  assert.equal((homeWxml.match(/class="home-slogan"/g) ?? []).length, 1)
  assert.match(fixtures, /slogan: '不挣钱，交个朋友'/)
  assert.match(homeTs, /requireCustomerDemoMode\('demo'\)/)
})

test('首页四个服务入口与推荐横幅具有独立触控事件', () => {
  for (const name of ['我要装机', '回收置换', '预约维修', '门店与联系']) assert.ok(homeTs.includes(name))
  assert.match(homeWxml, /bindtap="onEntryTap"/)
  assert.match(homeWxml, /bindtap="onRecommendationTap"/)
  assert.match(homeTs, /switchCustomerTab\('shop'/)
})

test('商城保持三类顺序、我的报价不暴露样本，商品两列展示四件混合推荐', () => {
  assert.deepEqual([...shopTs.matchAll(/label: '(整机|配件|我的报价)'/g)].map((match) => match[1]), ['整机', '配件', '我的报价'])
  assert.match(shopWxml, /activeCategory === '我的报价'/)
  assert.match(shopWxml, /不会显示样本或他人资料/)
  assert.match(shopWxss, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
  for (const itemId of ['demo-product-black', 'demo-product-white', 'demo-product-gpu', 'demo-product-monitor']) {
    assert.ok(fixtures.includes(itemId))
  }
  assert.match(shopWxml, /data-id="\{\{item\.id\}\}"/)
  assert.match(shopWxml, /item\.available/)
  assert.match(shopWxml, /wx:else class="shop-product-unavailable"/)
  assert.match(shopTs, /cents === null\) return '面议'/)
  assert.match(shopTs, /requireCustomerDemoMode\('demo'\)/)
})

test('商城配置与商品详情是不同事件，未接入时只给说明', () => {
  assert.match(shopWxml, /bindtap="onChooseConfig"/)
  assert.match(shopWxml, /catchtap="onProductAction"/)
  assert.match(shopWxml, /bindtap="onItemTap"/)
  assert.match(shopTs, /商品详情服务尚未接入/)
  assert.match(shopTs, /在线选配与提交功能尚未开通/)
})
