// 第二波采集：补量核心五大件 + 收尾其他分类
const BASE = process.env.PC_QUOTE_API_BASE || 'https://pc-backend.563838884.workers.dev'
const EMAIL = process.env.PC_QUOTE_EMAIL
const PASSWORD = process.env.PC_QUOTE_PASSWORD

if (!EMAIL || !PASSWORD) {
  console.error('请先设置 PC_QUOTE_EMAIL 和 PC_QUOTE_PASSWORD 环境变量')
  process.exit(1)
}

const KEYWORDS = {
  CPU: [
    'Intel Core i9-14900KF', 'Intel Core i7-14700KF', 'Intel Core i5-14400F',
    'Intel Core i5-13400F', 'Intel Core i3-12100F', 'Intel Core i5-12400F',
    'AMD Ryzen 9 7900X', 'AMD Ryzen 7 7700X', 'AMD Ryzen 5 5600',
    'AMD Ryzen 7 5700X3D', 'AMD Ryzen 9 5950X', 'AMD Ryzen 5 7500F',
  ],
  显卡: [
    'NVIDIA RTX 5070 Ti', 'NVIDIA RTX 5060 Ti', 'NVIDIA RTX 4070',
    'NVIDIA RTX 3080', 'AMD RX 9070 XT', 'AMD RX 7700 XT',
    'NVIDIA RTX 4090D', 'Intel Arc B580', 'AMD RX 6750 GRE',
    'NVIDIA RTX 4070 Ti', 'NVIDIA RTX 3090', 'AMD RX 7900 GRE',
  ],
  内存: [
    '金士顿 FURY Beast DDR5 32GB 6000', '金士顿 FURY Renegade DDR5 32GB 6400',
    '芝奇 幻锋戟 DDR5 32GB 6800', '海盗船 复仇者 DDR5 32GB 6400',
    '宏碁 掠夺者 Pallas II DDR5 32GB 6000', '三星 DDR5 32GB 4800',
    '威刚 龙耀 DDR5 32GB 6400', '光威 奕 DDR5 32GB 6000',
    '金士顿 DDR4 32GB 3600', '芝奇 DDR4 32GB 3600',
  ],
  散热器: [
    '猫头鹰 NH-D15', '九州风神 AK620', '利民 PA120 SE',
    '海盗船 H150i ELITE', 'Arctic Liquid Freezer III 360',
    '酷冷至尊 冰神 B360', '利民 AX120 R SE', '瓦尔基里 GL360',
    '九州风神 阿萨辛4S', '九州风神 冰堡垒 360',
  ],
  电源: [
    '海盗船 RM850e', '海盗船 RM750e', '海韵 FOCUS GX-850',
    '海韵 FOCUS GX-750', '振华 LEADEX III 850W', '微星 MAG A850GL',
    '华硕 ROG STRIX 850W', '酷冷至尊 V850 SFX', '利民 TR-TP850', '先马 XP850',
  ],
  机箱: [
    '联力 LANCOOL 216', '联力 O11 Vision', '追风者 NV5',
    '海盗船 4000D Airflow', '酷冷至尊 HAF 700', '先马 黑洞7',
    '九州风神 CH560', '安钛克 P20C', '乔思伯 D31', '华硕 TUF GT502',
  ],
  风扇: [
    'Arctic P12 PWM PST', '猫头鹰 NF-A12x25', '利民 TL-C12C',
    '联力 UNI FAN SL120', '酷冷至尊 Mobius 120',
    '追风者 T30-120', '九州风神 MF120', 'ID-COOLING XF12025',
  ],
  显示器: [
    'LG 27GP850-B', 'Dell U2724D', '华硕 ROG PG27AQDM',
    'AOC Q27G3XMN', '三星 Odyssey G7', '小米 Redmi 27 4K',
    'HKC 27英寸 2K 显示器', '泰坦军团 P27GN', 'ROG PG27AQDM', 'Dell S2722QC',
  ],
  鼠标: [
    '雷蛇 炼狱蝰蛇 V3', '罗技 G502 X', '罗技 G Pro X Superlight 2',
    'RAZER Viper V3 Pro', '罗技 G304', 'ROG 战刃3',
  ],
  键盘: [
    '樱桃 MX3.0S', '罗技 G913 TKL', 'Keychron Q1 Pro',
    'ROG 夜魔', 'VGN V98 Pro', 'Filco 忍者',
  ],
  耳机: [
    '索尼 WH-1000XM5', 'Bose QC Ultra', 'AirPods Max',
    '森海塞尔 HD660S2', '罗技 G Pro X', '雷蛇 黑鲨 V2 Pro',
  ],
  座椅: [
    '网易严选 人体工学椅', '西昊 M57', '赫曼米勒 Aeron',
    '保友 金豪B', '永艺 沃克', '傲风 C3',
  ],
}

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const { token } = await loginRes.json()
  if (!token) { console.error('登录失败'); return }
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
  let total = 0

  for (const [category, keywords] of Object.entries(KEYWORDS)) {
    console.log(`\n📦 ${category}...`)
    const raw = []
    for (const kw of keywords) {
      try {
        const r = await fetch(`${BASE}/api/search?q=${encodeURIComponent(kw)}`)
        const d = await r.json()
        for (const item of (d.data || []).slice(0, 2))
          raw.push({ title: item.title, price: item.price, image: item.picUrl, platform: item.source })
        process.stdout.write('.')
      } catch { process.stdout.write('x') }
      await new Promise(r => setTimeout(r, 250))
    }
    if (!raw.length) { console.log(`\n  0条`); continue }

    console.log(`\n  🧠 ${raw.length}条...`)
    const batchSize = 15, normalized = []
    for (let i = 0; i < raw.length; i += batchSize) {
      const batch = raw.slice(i, i + batchSize)
      try {
        const r = await fetch(`${BASE}/api/normalize`, { method: 'POST', headers, body: JSON.stringify({ titles: batch.map(b => b.title) }) })
        const d = await r.json()
        if (d.ok && d.items) {
          for (let j = 0; j < d.items.length; j++) {
            const item = d.items[j]
            if (item.category !== category) continue
            normalized.push({ category: item.category, name: item.name, price: item.price || batch[j]?.price || 0, image: batch[j]?.image || '', platform: batch[j]?.platform || '' })
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 600))
    }
    if (normalized.length) {
      const r = await fetch(`${BASE}/api/library`, { method: 'POST', headers, body: JSON.stringify({ items: normalized }) })
      const d = await r.json()
      console.log(`  ✅ ${d.count || normalized.length}件`)
      total += d.count || normalized.length
    }
  }
  console.log(`\n🎉 完成 ${total} 件`)
}
main().catch(e => console.error(e))
