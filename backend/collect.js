// Phase 4: 批量采集硬件库 (纯 JS)
const BASE = process.env.PC_QUOTE_API_BASE || 'https://pc-backend.563838884.workers.dev'
const EMAIL = process.env.PC_QUOTE_EMAIL
const PASSWORD = process.env.PC_QUOTE_PASSWORD

if (!EMAIL || !PASSWORD) {
  console.error('请先设置 PC_QUOTE_EMAIL 和 PC_QUOTE_PASSWORD 环境变量')
  process.exit(1)
}

const KEYWORDS = {
  CPU: [
    'Intel Core i9-14900K', 'Intel Core i7-14700K', 'Intel Core i5-14600KF',
    'Intel Core i3-14100F', 'Intel Core i9-13900K', 'Intel Core i7-13700K',
    'AMD Ryzen 9 7950X', 'AMD Ryzen 7 7800X3D', 'AMD Ryzen 5 7600X',
    'AMD Ryzen 9 9950X', 'AMD Ryzen 7 9800X3D',
  ],
  主板: [
    'ASUS ROG STRIX Z790-A', 'MSI MAG Z790 TOMAHAWK WIFI',
    'Gigabyte Z790 AORUS ELITE AX', 'ASUS TUF GAMING B760M-PLUS',
    'MSI B760M MORTAR WIFI', 'ASUS ROG STRIX B650-A',
    'MSI MAG B650 TOMAHAWK WIFI', 'Gigabyte B650 AORUS ELITE AX',
  ],
  内存: [
    '金士顿 Fury Beast DDR5 32GB', '芝奇 Trident Z5 DDR5 32GB',
    '海盗船 复仇者 DDR5 32GB', '宏碁 掠夺者 DDR5 32GB',
    '三星 DDR5 5600 32GB', '威刚 XPG LANCER DDR5 32GB',
    '金士顿 Fury Beast DDR5 16GB', '芝奇 Trident Z5 RGB DDR5 32GB',
  ],
  显卡: [
    'NVIDIA RTX 4090', 'NVIDIA RTX 4080 SUPER', 'NVIDIA RTX 4070 SUPER',
    'NVIDIA RTX 4060 Ti', 'NVIDIA RTX 4060', 'NVIDIA RTX 3050',
    'AMD RX 7900 XTX', 'AMD RX 7800 XT', 'AMD RX 7600',
    'NVIDIA RTX 4070 Ti SUPER',
  ],
  硬盘: [
    '三星 990 PRO 2TB', '三星 990 EVO Plus 1TB', 'WD SN850X 2TB',
    'WD SN770 1TB', '致态 TiPlus7100 2TB', '金士顿 KC3000 2TB',
    '铠侠 EXCERIA PRO 2TB', '三星 870 EVO 2TB',
    '希捷 酷鱼 2TB', '西部数据 蓝盘 2TB',
  ],
  散热器: [
    '猫头鹰 NH-D15', '九州风神 AK620', '利民 PA120 SE',
    '海盗船 H150i ELITE', 'Arctic Liquid Freezer III 360',
    '酷冷至尊 冰神 B360', '利民 AX120 R SE', '九州风神 玄冰400',
    '瓦尔基里 GL360', '九州风神 阿萨辛4S',
  ],
  电源: [
    '海盗船 RM850e', '海盗船 RM750e', '海韵 FOCUS GX-850',
    '海韵 FOCUS GX-750', '振华 LEADEX III 850W', '微星 MAG A850GL',
    '华硕 ROG STRIX 850W', '酷冷至尊 V850 SFX', '利民 TR-TP850', '先马 XP850',
  ],
  机箱: [
    '联力 LANCOOL 216', '联力 O11 Dynamic EVO', '追风者 P400A',
    '海盗船 4000D Airflow', '酷冷至尊 MB520', '先马 黑洞7',
    '九州风神 CH560', '安钛克 NX410', '乔思伯 D31', '华硕 TUF GT502',
  ],
  风扇: [
    'Arctic P12 PWM PST', '猫头鹰 NF-A12x25', '利民 TL-C12C',
    '联力 UNI FAN SL120', '海盗船 LL120 RGB', '酷冷至尊 Mobius 120',
    '追风者 T30-120', '九州风神 MF120', '先马 冰洞4', 'ID-COOLING XF12025',
  ],
  显示器: [
    'LG 27GP850-B', 'Dell U2724D', '华硕 TUF VG27AQ1A',
    'AOC Q27G3XMN', '三星 Odyssey G7', '小米 Redmi 27 4K',
    'HKC 27英寸 2K 显示器', '泰坦军团 P27GN', 'ROG PG27AQDM', 'Dell U3224KB',
  ],
  鼠标: [
    '雷蛇 炼狱蝰蛇 V3', '罗技 G502 X', '雷蛇 毒蝰 V2 Pro',
    '罗技 G Pro X Superlight 2', '雷蛇 DeathAdder V3 Pro',
    '罗技 G304', 'ROG 战刃3', 'VGN 蜻蜓F1 Pro MAX',
  ],
  键盘: [
    '樱桃 MX3.0S', '罗技 G913 TKL', '雷蛇 黑寡妇 V4 Pro',
    'Keychron Q1 Pro', 'ROG 夜魔', 'Akko 3098B',
    '达尔优 A98 Master', 'VGN V98 Pro', 'Leopold FC980M', 'Filco 忍者',
  ],
  耳机: [
    '索尼 WH-1000XM5', 'Bose QC45', 'AirPods Max',
    '森海塞尔 HD660S2', '铁三角 ATH-M50x', '罗技 G Pro X',
    '雷蛇 黑鲨 V2 Pro', '漫步者 G6 Pro', 'ROG 棱镜S', '森海塞尔 GSP 600',
  ],
  座椅: [
    '网易严选 人体工学椅', '西昊 M57', '赫曼米勒 Aeron',
    '保友 金豪B', '冈村 Sylphy', '永艺 沃克',
    '黑白调 E3', '傲风 C3', '迪锐克斯 DXRACER', '恋树 L1',
  ],
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const data = await res.json()
  if (!data.token) throw new Error('登录失败: ' + JSON.stringify(data))
  return data.token
}

async function main() {
  console.log('🔑 登录...')
  const token = await login()
  console.log('✅ 登录成功')
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
  let totalCollected = 0

  for (const [category, keywords] of Object.entries(KEYWORDS)) {
    console.log(`\n📦 采集 ${category}...`)
    const rawItems = []

    // 搜索
    for (const kw of keywords) {
      process.stdout.write(`  搜索: ${kw} → `)
      try {
        const res = await fetch(`${BASE}/api/search?q=${encodeURIComponent(kw)}`)
        const data = await res.json()
        const items = (data.data || []).slice(0, 2)
        for (const item of items) {
          rawItems.push({ title: item.title, price: item.price, image: item.picUrl, platform: item.source })
        }
        console.log(`${items.length}条`)
      } catch (e) { console.log('失败') }
      await new Promise(r => setTimeout(r, 300))
    }

    if (rawItems.length === 0) { console.log('  ⏭ 无结果'); continue }

    // DeepSeek normalize
    console.log(`  🧠 DeepSeek 标准化 ${rawItems.length} 条...`)
    const batchSize = 15
    const normalized = []
    for (let i = 0; i < rawItems.length; i += batchSize) {
      const batch = rawItems.slice(i, i + batchSize)
      const titles = batch.map(b => b.title)
      try {
        const res = await fetch(`${BASE}/api/normalize`, {
          method: 'POST', headers, body: JSON.stringify({ titles }),
        })
        const d = await res.json()
        if (d.ok && d.items) {
          for (let j = 0; j < d.items.length; j++) {
            const item = d.items[j]
            if (item.category !== category) continue
            normalized.push({
              category: item.category,
              name: item.name,
              price: item.price || batch[j]?.price || 0,
              image: batch[j]?.image || '',
              platform: batch[j]?.platform || '',
            })
          }
        }
      } catch (e) { console.log('  标准化失败:', e.message) }
      await new Promise(r => setTimeout(r, 800))
    }

    // 存储
    if (normalized.length > 0) {
      console.log(`  💾 保存 ${normalized.length} 件...`)
      try {
        const res = await fetch(`${BASE}/api/library`, {
          method: 'POST', headers, body: JSON.stringify({ items: normalized }),
        })
        const r = await res.json()
        console.log(`  ✅ ${r.count || normalized.length} 件`)
        totalCollected += (r.count || normalized.length)
      } catch (e) { console.log('  保存失败:', e.message) }
    }
  }

  console.log(`\n🎉 完成！共 ${totalCollected} 件`)
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
