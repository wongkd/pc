import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import esbuild from '../../backend/node_modules/esbuild/lib/main.js'

const bundle = await esbuild.build({
  entryPoints: [fileURLToPath(new URL('../pages/shop/index.ts', import.meta.url))],
  bundle: true, write: false, format: 'iife', platform: 'neutral',
  plugins: [{ name: 'runtime-fixtures', setup(build) {
    build.onResolve({ filter: /customer\/(environment|catalog|routes)$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'test' }))
    build.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'environment'
      ? 'export const resolveCustomerEnvironment = () => testEnvironment()'
      : args.path === 'catalog' ? 'export const fetchPublicCatalog = (...args) => testFetch(...args)'
        : 'export const consumePendingShopCategory=()=>null; export const syncCustomerTabSelection=()=>{}' }))
  } }],
})
function page(environment, fetch) {
  let instance
  vm.runInNewContext(bundle.outputFiles[0].text, {
    Error, testEnvironment: environment, testFetch: fetch,
    Page(value) { instance = value; value.setData = data => Object.assign(value.data, data); value.getTabBar = () => ({}) },
  })
  return instance
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const product = { id:'public-product',title:'真实目录商品',category:'整机',description:'白名单说明',priceCents:19999,coverUrl:'https://example.test/cover.png',heroUrl:null }
test('真实模式只使用公开目录；切分类时过期请求不覆盖当前内容', async () => {
  const calls=[]
  const p=page(()=>({demoData:false}), (category)=>new Promise(resolve=>calls.push({category,resolve})))
  assert.equal(p.data.items.length,0)
  p.selectCategory('整机'); p.selectCategory('配件')
  calls[1].resolve({items:[{...product,title:'配件结果'}],hasMore:false}); await tick()
  calls[0].resolve({items:[product],hasMore:false}); await tick()
  assert.equal(p.data.items[0].title,'配件结果')
  assert.equal(p.data.demoMode,false)
  assert.equal(p.data.heroImage,'')
})
test('真实服务报错不回退虚构商品，重试可恢复', async () => {
  let failed=true
  const p=page(()=>({demoData:false}),async()=>{ if(failed) throw new Error('网络错误'); return {items:[product],hasMore:false} })
  p.selectCategory('整机'); await tick()
  assert.equal(p.data.loadError,'网络错误'); assert.equal(p.data.items.length,0)
  failed=false; p.onRetry(); await tick()
  assert.equal(p.data.items[0].id,product.id); assert.equal(p.data.loadError,'')
})
test('环境未配置时显示原因；明确演示模式才显示样本', () => {
  const unavailable=page(()=>{throw new Error('未配置')},()=>{throw new Error('不应请求')})
  unavailable.selectCategory('整机'); assert.equal(unavailable.data.items.length,0); assert.equal(unavailable.data.loadError,'未配置')
  const demo=page(()=>({demoData:true}),()=>{throw new Error('不应请求')})
  demo.selectCategory('配件'); assert.ok(demo.data.items.length>0); assert.equal(demo.data.demoMode,true)
  demo.selectCategory('我的报价'); assert.equal(demo.data.items.length,0)
})
