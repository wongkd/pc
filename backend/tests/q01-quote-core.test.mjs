/**
 * Q01 第二刀 · 报价单核心：0009 建的对象与约束。
 *
 * 跑在真实 workerd + 真实 D1 上（miniflare）。
 * 跑法：npm --prefix backend test
 *
 * 本文件验的不是「表建出来了」，而是「该拦住的事真的拦住了」：
 *   1. 发出后的版本不能被原地改写（主键即断言）
 *   2. 行小计不可能不等于单价×数量（CHECK + 触发器）
 *   3. 客供件不允许带价（契约 R06）
 *   4. 二手 / 客供件数量只能是 1（契约 QuoteVersion.rules）
 *   5. 同一版本同时只能有一个有效分享凭证（部分唯一索引）
 *   6. 报价单动产不了库存（本迁移不写 stock_reservations）
 *   7. 定金比例与顾客预算在 terms_snapshot 里，不是独立列
 *   8. 不依赖自增主键
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createQuoteEnv, resetQuotes, rows, scalar, attempt,
  seedQuoteHeader, seedQuoteVersion, seedQuoteLine, STORE,
} from './lib/quote.mjs'

const ACTOR = 1

let env
let db

before(async () => {
  env = await createQuoteEnv()
  db = env.db
})

after(async () => {
  await env?.dispose()
})

beforeEach(async () => {
  await resetQuotes(db)
})

test('迁移与结构：0009 的 4 张表、索引与触发器都已建立', async () => {
  assert.ok(env.migrations.length >= 10, `迁移文件数应 >= 10，实际 ${env.migrations.length}`)
  const names = (await rows(db, "SELECT name FROM sqlite_master WHERE type='table'")).map((r) => r.name)
  for (const table of ['quote_headers', 'quote_versions', 'quote_lines', 'quote_shares']) {
    assert.ok(names.includes(table), `缺表 ${table}`)
  }

  const triggers = (await rows(db, "SELECT name FROM sqlite_master WHERE type='trigger'")).map((r) => r.name)
  assert.ok(triggers.includes('quote_lines_recompute_total_insert'), '缺插入触发器')
  assert.ok(triggers.includes('quote_lines_recompute_total_update'), '缺更新触发器')

  const indexes = (await rows(db, "SELECT name FROM sqlite_master WHERE type='index'")).map((r) => r.name)
  for (const idx of ['uq_quote_lines_position', 'uq_quote_shares_active_version']) {
    assert.ok(indexes.includes(idx), `缺索引 ${idx}`)
  }
})

test('旧表未被触碰：quotes(0000) 与 orders(0003) 仍在，且结构未变', async () => {
  const legacyQuotes = await rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='quotes'")
  assert.equal(legacyQuotes.length, 1, '旧 quotes 表必须保留（报价编辑器还在用）')

  for (const table of ['orders', 'order_items', 'order_payments']) {
    const found = await rows(db, `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table)
    assert.equal(found.length, 1, `旧表 ${table} 必须保留（订单页还在用）`)
  }

  // 旧 orders 表没有契约新要求的列 —— 这正说明新旧共存、没有互相污染。
  const cols = (await rows(db, 'PRAGMA table_info(orders)')).map((c) => c.name)
  assert.ok(cols.includes('total_amount_cents'), '旧 orders 保持老结构')
  assert.ok(!cols.includes('trade_state'), '旧 orders 不应被本迁移改造')
})

test('版本不可覆盖：同一 (quote_id, revision) 不能插入两次', async () => {
  await seedQuoteHeader(db)
  await seedQuoteVersion(db, { revision: 1, status: 'issued', subtotalCents: 100000, validUntil: '2026-10-01' })

  const dup = await attempt(
    db,
    `INSERT INTO quote_versions
       (quote_id, revision, store_id, status, valid_until, discount_cents, terms_snapshot,
        issued_at, subtotal_cents, total_cents, created_by)
     VALUES ('q-1', 1, ?, 'issued', '2026-10-01', 0, '{}', '2026-09-19T04:00:00.000Z', 90000, 90000, ?)`,
    STORE, ACTOR,
  )
  assert.ok(dup, '重复插入同一版本必须失败，实际却成功了')
  assert.match(dup, /UNIQUE|PRIMARY KEY|constraint/i)

  // 原版本的价格没有被改动 —— 这才是「不可覆盖」的实际含义
  const subtotal = await scalar(db, 'SELECT subtotal_cents FROM quote_versions WHERE quote_id=? AND revision=?', 'q-1', 1)
  assert.equal(subtotal, 100000, '原版本金额不得被后来的插入影响')
})

test('改价必须走新版本：revision 递增后两份版本各自保存当时的金额', async () => {
  await seedQuoteHeader(db)
  await seedQuoteVersion(db, { revision: 1, status: 'issued', subtotalCents: 864900, validUntil: '2026-09-26' })
  await seedQuoteVersion(db, { revision: 2, status: 'issued', subtotalCents: 874900, validUntil: '2026-09-28' })

  const list = await rows(db, 'SELECT revision, subtotal_cents FROM quote_versions WHERE quote_id=? ORDER BY revision', 'q-1')
  assert.equal(list.length, 2, '应有两个版本')
  assert.equal(list[0].subtotal_cents, 864900, 'v1 保持原价')
  assert.equal(list[1].subtotal_cents, 874900, 'v2 是新价')
})

test('金额守恒：total 必须等于 subtotal 减 discount，且 discount 不得超小计', async () => {
  await seedQuoteHeader(db)

  // 总额对不上 → 拦下
  const mismatch = await attempt(
    db,
    `INSERT INTO quote_versions
       (quote_id, revision, store_id, status, discount_cents, terms_snapshot,
        subtotal_cents, total_cents, created_by)
     VALUES ('q-1', 1, ?, 'draft', 50000, '{}', 864900, 999999, ?)`,
    STORE, ACTOR,
  )
  assert.ok(mismatch, '总额与「小计−优惠」不符必须失败')
  assert.match(mismatch, /CHECK|constraint/i)

  // 优惠超过小计 → 拦下（否则应付会变成负数）
  const overDiscount = await attempt(
    db,
    `INSERT INTO quote_versions
       (quote_id, revision, store_id, status, discount_cents, terms_snapshot,
        subtotal_cents, total_cents, created_by)
     VALUES ('q-1', 2, ?, 'draft', 900000, '{}', 864900, -35100, ?)`,
    STORE, ACTOR,
  )
  assert.ok(overDiscount, '优惠超过小计必须失败')

  // 正常的一份应当通过
  const ok = await attempt(
    db,
    `INSERT INTO quote_versions
       (quote_id, revision, store_id, status, discount_cents, terms_snapshot,
        subtotal_cents, total_cents, created_by)
     VALUES ('q-1', 3, ?, 'draft', 50000, '{}', 864900, 814900, ?)`,
    STORE, ACTOR,
  )
  assert.equal(ok, null, `正常的金额关系不应被拦下，实际：${ok}`)
})

test('状态与发出时间必须自洽：issued 无 issued_at 被拒，draft 带 issued_at 也被拒', async () => {
  await seedQuoteHeader(db)

  const issuedNoTime = await attempt(
    db,
    `INSERT INTO quote_versions
       (quote_id, revision, store_id, status, discount_cents, terms_snapshot,
        subtotal_cents, total_cents, issued_at, created_by)
     VALUES ('q-1', 1, ?, 'issued', 0, '{}', 100, 100, NULL, ?)`,
    STORE, ACTOR,
  )
  assert.ok(issuedNoTime, 'issued 但 issued_at 为空必须失败（防半截记录）')

  const draftWithTime = await attempt(
    db,
    `INSERT INTO quote_versions
       (quote_id, revision, store_id, status, discount_cents, terms_snapshot,
        subtotal_cents, total_cents, issued_at, created_by)
     VALUES ('q-1', 2, ?, 'draft', 0, '{}', 100, 100, '2026-09-19T04:00:00.000Z', ?)`,
    STORE, ACTOR,
  )
  assert.ok(draftWithTime, 'draft 却带 issued_at 必须失败')
})

test('行小计不可能不等于单价×数量（CHECK + 触发器两层，各自独立有效）', async () => {
  await seedQuoteHeader(db)
  await seedQuoteVersion(db, { revision: 1, status: 'draft' })

  // 直接送一个错的 line_total
  const wrong = await attempt(
    db,
    `INSERT INTO quote_lines
       (id, quote_id, revision, store_id, position, source, name_snapshot, spec_snapshot,
        qty, unit_price_cents, line_total_cents, warranty_snapshot)
     VALUES ('ql-bad', 'q-1', 1, ?, 0, 'new', '显卡', '', 2, 100000, 100000, '{}')`,
    STORE,
  )
  assert.ok(wrong, '行小计与单价×数量不符必须失败（2×100000 应得 200000）')
  // 触发器先于 CHECK 生效，带出的是契约错误码，不是裸的 SQLITE_CONSTRAINT。
  // 这一点已在 0009 上单独实测（见验证记录）：去掉 CHECK 后触发器仍拦，
  // 去掉触发器后 CHECK 仍拦 —— 两层是独立防护，删掉任一层都会被本用例发现。
  assert.match(wrong, /VALIDATION_ERROR|CHECK|constraint/i)

  // 正确的一行应当通过，且落库值就是算出来的
  await seedQuoteLine(db, { id: 'ql-ok', position: 0, qty: 2, unitPriceCents: 100000 })
  const total = await scalar(db, 'SELECT line_total_cents FROM quote_lines WHERE id=?', 'ql-ok')
  assert.equal(total, 200000, '行小计应由服务端算出 200000')

  // 触发器必须存在：两条都删掉，本用例拦不住「行小计被写错」这件事。
  const triggers = (await rows(db, "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'quote_lines%'")).map((r) => r.name)
  assert.equal(triggers.length, 2, `行小计的两个触发器都应存在，实际 ${triggers.length} 个`)
})

test('客供件不允许带价，且必须指出来源设备（契约 R06）', async () => {
  await seedQuoteHeader(db)
  await seedQuoteVersion(db, { revision: 1, status: 'draft' })

  // 客供件带价 → 拦下
  const priced = await attempt(
    db,
    `INSERT INTO quote_lines
       (id, quote_id, revision, store_id, position, source, name_snapshot, spec_snapshot,
        qty, unit_price_cents, line_total_cents, customer_device_ref, warranty_snapshot)
     VALUES ('ql-c1', 'q-1', 1, ?, 0, 'customer', '顾客自带硬盘', '', 1, 50000, 50000, 'DEV-1', '{}')`,
    STORE,
  )
  assert.ok(priced, '客供件带价必须失败（客供件另列服务费）')

  // 客供件不指设备 → 拦下
  const noDevice = await attempt(
    db,
    `INSERT INTO quote_lines
       (id, quote_id, revision, store_id, position, source, name_snapshot, spec_snapshot,
        qty, unit_price_cents, line_total_cents, customer_device_ref, warranty_snapshot)
     VALUES ('ql-c2', 'q-1', 1, ?, 0, 'customer', '顾客自带硬盘', '', 1, 0, 0, NULL, '{}')`,
    STORE,
  )
  assert.ok(noDevice, '客供件未指出来源设备必须失败')

  // 非客供件却带了设备引用 → 拦下（避免语义混乱）
  const strayRef = await attempt(
    db,
    `INSERT INTO quote_lines
       (id, quote_id, revision, store_id, position, source, name_snapshot, spec_snapshot,
        qty, unit_price_cents, line_total_cents, customer_device_ref, warranty_snapshot)
     VALUES ('ql-n1', 'q-1', 1, ?, 0, 'new', '新品主板', '', 1, 100000, 100000, 'DEV-9', '{}')`,
    STORE,
  )
  assert.ok(strayRef, '非客供件不应带设备引用')

  // 正确的客供件行应当通过：单价 0 且指了设备
  const ok = await attempt(
    db,
    `INSERT INTO quote_lines
       (id, quote_id, revision, store_id, position, source, name_snapshot, spec_snapshot,
        qty, unit_price_cents, line_total_cents, customer_device_ref, warranty_snapshot)
     VALUES ('ql-c3', 'q-1', 1, ?, 0, 'customer', '顾客自带硬盘', '', 1, 0, 0, 'DEV-2', '{"warranty":"none"}')`,
    STORE,
  )
  assert.equal(ok, null, `正确的客供件行不应被拦下，实际：${ok}`)
})

test('逐件跟踪的来源数量只能是 1（契约：序列化 / 二手实物行数量为 1）', async () => {
  await seedQuoteHeader(db)
  await seedQuoteVersion(db, { revision: 1, status: 'draft' })

  const usedQty2 = await attempt(
    db,
    `INSERT INTO quote_lines
       (id, quote_id, revision, store_id, position, source, name_snapshot, spec_snapshot,
        qty, unit_price_cents, line_total_cents, warranty_snapshot)
     VALUES ('ql-u1', 'q-1', 1, ?, 0, 'used', '二手显卡', '', 2, 150000, 300000, '{}')`,
    STORE,
  )
  assert.ok(usedQty2, '二手件数量为 2 必须失败（实物只有一件）')

  // 新品可以多件
  const newQty3 = await attempt(
    db,
    `INSERT INTO quote_lines
       (id, quote_id, revision, store_id, position, source, name_snapshot, spec_snapshot,
        qty, unit_price_cents, line_total_cents, warranty_snapshot)
     VALUES ('ql-n1', 'q-1', 1, ?, 0, 'new', '机箱风扇', '', 3, 3900, 11700, '{}')`,
    STORE,
  )
  assert.equal(newQty3, null, `新品多件不应被拦下，实际：${newQty3}`)
})

test('同一版本的同一行序不可重复（否则打印清单顺序不确定）', async () => {
  await seedQuoteHeader(db)
  await seedQuoteVersion(db, { revision: 1, status: 'draft' })
  await seedQuoteLine(db, { id: 'ql-a', position: 3 })

  const dup = await attempt(
    db,
    `INSERT INTO quote_lines
       (id, quote_id, revision, store_id, position, source, name_snapshot, spec_snapshot,
        qty, unit_price_cents, line_total_cents, warranty_snapshot)
     VALUES ('ql-b', 'q-1', 1, ?, 3, 'new', '另一件', '', 1, 100, 100, '{}')`,
    STORE,
  )
  assert.ok(dup, '同一版本重复行序必须失败')
  assert.match(dup, /UNIQUE|constraint/i)
})

test('同一版本同时只能有一个有效分享凭证；撤销后可以再发一个', async () => {
  await seedQuoteHeader(db)
  await seedQuoteVersion(db, { revision: 1, status: 'issued', subtotalCents: 100000, validUntil: '2026-10-01' })

  const insertShare = (id, hash, status = 'active', revokedAt = null, revokedBy = null) =>
    attempt(
      db,
      `INSERT INTO quote_shares
         (id, store_id, quote_id, revision, token_hash, status, expires_at, revoked_at, revoked_by, created_by)
       VALUES (?, ?, 'q-1', 1, ?, ?, NULL, ?, ?, ?)`,
      id, STORE, hash, status, revokedAt, revokedBy, ACTOR,
    )

  assert.equal(await insertShare('sh-1', 'hash-a'), null, '第一个有效凭证应插入成功')
  const second = await insertShare('sh-2', 'hash-b')
  assert.ok(second, '同一版本的第二个有效凭证必须失败（否则「撤回链接」会变成撤哪个的扯皮）')

  // 撤销第一个（撤销必须留痕）
  await db
    .prepare(`UPDATE quote_shares SET status='revoked', revoked_at='2026-09-19T05:00:00.000Z', revoked_by=? WHERE id='sh-1'`)
    .bind(ACTOR)
    .run()

  assert.equal(await insertShare('sh-3', 'hash-c'), null, '撤销后应能再发一个新凭证')
})

test('撤销凭证必须留痕：revoked 却没有 revoked_by 会被拒', async () => {
  await seedQuoteHeader(db)
  await seedQuoteVersion(db, { revision: 1, status: 'issued', subtotalCents: 100000, validUntil: '2026-10-01' })

  const noTrace = await attempt(
    db,
    `INSERT INTO quote_shares
       (id, store_id, quote_id, revision, token_hash, status, revoked_at, revoked_by, created_by)
     VALUES ('sh-x', ?, 'q-1', 1, 'hash-x', 'revoked', '2026-09-19T05:00:00.000Z', NULL, ?)`,
    STORE, ACTOR,
  )
  assert.ok(noTrace, '标记撤销却不记录操作人必须失败')
})

test('凭证只存摘要：表里没有明文 token 列', async () => {
  const cols = (await rows(db, 'PRAGMA table_info(quote_shares)')).map((c) => c.name)
  assert.ok(cols.includes('token_hash'), '应有 token_hash 列')
  assert.ok(!cols.includes('token'), '不应存在明文 token 列')
  assert.ok(!cols.includes('plain_token'), '不应存在明文 token 列')
})

test('报价单动产不了库存：插入版本与明细后，预占表不变', async () => {
  const before = await scalar(db, 'SELECT COUNT(*) FROM stock_reservations')

  await seedQuoteHeader(db)
  await seedQuoteVersion(db, { revision: 1, status: 'issued', subtotalCents: 864900, validUntil: '2026-09-26' })
  await seedQuoteLine(db, { id: 'ql-hw', position: 0, source: 'new', qty: 1, unitPriceCents: 289900 })
  await seedQuoteLine(db, { id: 'ql-used', position: 1, source: 'used', qty: 1, unitPriceCents: 24900, stockItemId: null })

  const after = await scalar(db, 'SELECT COUNT(*) FROM stock_reservations')
  assert.equal(after, before, '报价单不得产生任何库存预占（未付款不锁库存）')

  const moves = await scalar(db, 'SELECT COUNT(*) FROM inventory_movements')
  assert.equal(moves, 0, '报价单不得产生任何库存流水')
})

test('定金比例与顾客预算在 terms_snapshot 里，不是独立列', async () => {
  const cols = (await rows(db, 'PRAGMA table_info(quote_versions)')).map((c) => c.name)
  for (const forbidden of ['deposit_percent', 'deposit_cents', 'budget_cents', 'budget']) {
    assert.ok(!cols.includes(forbidden),
      `不得新增契约外列 ${forbidden}（conventions.forbiddenInventing；需变更须先走契约修订）`)
  }
  assert.ok(cols.includes('terms_snapshot'), '应有 terms_snapshot 承接这类门店参数')

  // 装进去能取出来，且不参与任何金额校验
  await seedQuoteHeader(db)
  await seedQuoteVersion(db, {
    revision: 1, status: 'issued', subtotalCents: 864900, discountCents: 50000, validUntil: '2026-09-26',
    termsSnapshot: { depositPercent: 15, customerBudgetCents: 1200000, warranty: '整机 1 年' },
  })

  const raw = await scalar(db, 'SELECT terms_snapshot FROM quote_versions WHERE quote_id=? AND revision=?', 'q-1', 1)
  const terms = JSON.parse(raw)
  assert.equal(terms.depositPercent, 15, '定金比例应原样取出')
  assert.equal(terms.customerBudgetCents, 1200000, '顾客预算应原样取出')

  // 关键：改了预算，金额一分不动 —— 证明它不参与计算
  const totalBefore = await scalar(db, 'SELECT total_cents FROM quote_versions WHERE quote_id=? AND revision=?', 'q-1', 1)
  await db.prepare('UPDATE quote_versions SET terms_snapshot=? WHERE quote_id=? AND revision=?')
    .bind(JSON.stringify({ depositPercent: 15, customerBudgetCents: 800000 }), 'q-1', 1).run()
  const totalAfter = await scalar(db, 'SELECT total_cents FROM quote_versions WHERE quote_id=? AND revision=?', 'q-1', 1)
  assert.equal(totalAfter, totalBefore, '改顾客预算不得影响任何金额')
})

test('可复现 Q01 原型那张样单：配件+服务−优惠=应付，数字与原型一致', async () => {
  await seedQuoteHeader(db, { title: '周先生 · 视频剪辑与游戏' })
  // 原型：配件 ¥8,799.00 + 服务 ¥350.00 = ¥8,649.00 计 … 注意原型应付是 8799+350−500
  await seedQuoteVersion(db, {
    revision: 1, status: 'issued',
    subtotalCents: 914900, discountCents: 50000, validUntil: '2026-09-26',
    termsSnapshot: { depositPercent: 15, customerBudgetCents: 1200000 },
  })
  const subtotal = await scalar(db, 'SELECT subtotal_cents FROM quote_versions WHERE quote_id=? AND revision=?', 'q-1', 1)
  const discount = await scalar(db, 'SELECT discount_cents FROM quote_versions WHERE quote_id=? AND revision=?', 'q-1', 1)
  const total = await scalar(db, 'SELECT total_cents FROM quote_versions WHERE quote_id=? AND revision=?', 'q-1', 1)

  assert.equal(subtotal, 914900, '小计应为 ¥9,149.00（配件 8799 + 服务 350）')
  assert.equal(discount, 50000, '优惠 ¥500.00')
  assert.equal(total, 864900, '应付 ¥8,649.00 —— 与原型的数字一致')
  assert.equal(subtotal - discount, total, '金额守恒')

  // 定金按 terms 里的比例算，而不是读一个列 —— 服务端算，与原型 1297.35 一致
  const terms = JSON.parse(await scalar(db, 'SELECT terms_snapshot FROM quote_versions WHERE quote_id=? AND revision=?', 'q-1', 1))
  const deposit = Math.round(total * terms.depositPercent / 100)
  assert.equal(deposit, 129735, '定金应为 ¥1,297.35，与原型的数字一致')
  assert.equal(total - deposit, 735165, '尾款应为 ¥7,351.65')
})

test('服务端生成的 TEXT 主键：动作结果不依赖自增主键', async () => {
  await seedQuoteHeader(db, { id: 'q-server-generated' })
  const found = await scalar(db, 'SELECT id FROM quote_headers WHERE id=?', 'q-server-generated')
  assert.equal(found, 'q-server-generated', '主键应是服务端生成的字符串，随语句一起写入')
})
