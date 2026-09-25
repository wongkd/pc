/**
 * T03a · 身份域测试（真实 workerd + 真实 D1）。
 *
 * 打的都是真会出事的地方：
 *   · 明文绑定码有没有混进库里（出了事就是全员能登）；
 *   · 同一个码能不能用两次、同一个微信能不能绑两家成员、同一个成员能不能收两张工牌；
 *   · 跨lowest(店)的 memberId 能不能偷到码；
 *   · 登出之后旧凭证到底还在不在有效期（靠 token_version 推进）。
 *
 * 边界：本地 miniflare 内存库，不连远端、不 deploy。
 */

import test, { describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv, seedStore } from './lib/env.mjs'
import { bundleModule } from './lib/build.mjs'

const APPID = 'wx1b14bf01ef71718d'
const JWT_SECRET = 'T03a-test-secret'
const TTL_MS = 10 * 60 * 1000

let env
let identity
let session

/** 建一个本机用户 + 它在本店的成员身份。 */
async function createMember(db, { userId, storeId = 1, status = 'active', isOwner = 0 }) {
  await db
    .prepare(`INSERT INTO users (id, email, password_hash, status) VALUES (?, ?, 'seed:seed', 'active')`)
    .bind(userId, `t03a-u${userId}@example.test`)
    .run()
  await db
    .prepare(`INSERT INTO store_members (store_id, user_id, status, is_owner) VALUES (?, ?, ?, ?)`)
    .bind(storeId, userId, status, isOwner)
    .run()
  const row = await db
    .prepare('SELECT id FROM store_members WHERE store_id = ? AND user_id = ?')
    .bind(storeId, userId)
    .first()
  return row.id
}

async function expectFailure(fn) {
  try {
    await fn()
  } catch (error) {
    return error
  }
  throw new Error('这里本该失败，却成功了')
}

before(async () => {
  env = await createTestEnv({ demo: false })
  identity = await bundleModule('src/domains/identity.ts', 'identity')
  session = await bundleModule('src/domains/session.ts', 'session')
  await seedStore(env.db, { storeId: 1, userId: 1 })
  await seedStore(env.db, { storeId: 2, userId: 2 })
})

after(async () => {
  await env?.dispose()
})

describe('T03a · 绑定码与身份交换', () => {
  test('1. 明文绑定码不落库：库里只有摘要', async () => {
    const memberId = await createMember(env.db, { userId: 11 })
    const issued = await identity.createBindingCode(env.db, {
      appid: APPID,
      storeId: 1,
      memberId,
      actorUserId: 1,
    })

    assert.equal(issued.code.length, 8, '明文码应为 8 位')

    const row = await env.db
      .prepare('SELECT code_hash FROM wechat_binding_codes WHERE id = ?')
      .bind(issued.codeId)
      .first()

    assert.ok(row, '码应已入库')
    assert.notEqual(row.code_hash, issued.code, '库里绝不能存明文')
    assert.match(row.code_hash, /^[0-9a-f]{64}$/, '应为 SHA-256 十六进制摘要')

    const leaked = await env.db
      .prepare('SELECT COUNT(*) AS n FROM wechat_binding_codes WHERE code_hash = ?')
      .bind(issued.code)
      .first()
    assert.equal(leaked.n, 0, '拿明文当摘要去查，必须查不到')
  })

  test('2. 一个成员同时只允许一个待用码：再发一个，旧的作废', async () => {
    const memberId = await createMember(env.db, { userId: 12 })
    const first = await identity.createBindingCode(env.db, { appid: APPID, storeId: 1, memberId, actorUserId: 1 })
    const second = await identity.createBindingCode(env.db, { appid: APPID, storeId: 1, memberId, actorUserId: 1 })

    assert.notEqual(first.code, second.code)

    const statuses = await env.db
      .prepare('SELECT id, status FROM wechat_binding_codes WHERE member_id = ? ORDER BY id')
      .bind(memberId)
      .all()

    assert.equal(statuses.results.length, 2)
    assert.equal(statuses.results[0].status, 'revoked', '旧码应被作废')
    assert.equal(statuses.results[1].status, 'pending')

    const reuseOld = await expectFailure(() =>
      identity.bindWechatIdentity(env.db, { appid: APPID, openid: 'OPENID-T03A-2', code: first.code }),
    )
    assert.equal(reuseOld.code, 'ENTITY_NOT_FOUND', '已作废的码不能用')
  })

  test('3. 正常走一遍：发码 → 绑定 → 认人 → 签发凭证', async () => {
    const memberId = await createMember(env.db, { userId: 13 })
    const issued = await identity.createBindingCode(env.db, { appid: APPID, storeId: 1, memberId, actorUserId: 1 })

    const before = await identity.resolveBoundIdentity(env.db, { appid: APPID, openid: 'OPENID-T03A-3' })
    assert.equal(before, null, '未绑定时查不到身份（调用方据此返回 401）')

    const bound = await identity.bindWechatIdentity(env.db, { appid: APPID, openid: 'OPENID-T03A-3', code: issued.code })
    assert.deepEqual(bound, { memberId, storeId: 1, userId: 13 })

    const after = await identity.resolveBoundIdentity(env.db, { appid: APPID, openid: 'OPENID-T03A-3' })
    assert.equal(after.memberId, memberId)
    assert.equal(after.storeId, 1)
    assert.equal(after.sessionVersion, 1)

    const token = await identity.issueIdentityToken(JWT_SECRET, {
      userId: 13,
      storeId: 1,
      email: 't03a-u13@example.test',
      sessionVersion: after.sessionVersion,
    })
    const payload = await session.verifyJWT(token, JWT_SECRET)
    assert.ok(payload, '凭证应能解开')
    assert.equal(payload.uid, 13)
    assert.equal(payload.sid, 1)
    assert.equal(payload.tv, after.sessionVersion)
  })

  test('4. 同一个码不能用第二次（哪怕换一个微信）', async () => {
    const memberId = await createMember(env.db, { userId: 14 })
    const issued = await identity.createBindingCode(env.db, { appid: APPID, storeId: 1, memberId, actorUserId: 1 })

    await identity.bindWechatIdentity(env.db, { appid: APPID, openid: 'OPENID-T03A-4A', code: issued.code })

    const second = await expectFailure(() =>
      identity.bindWechatIdentity(env.db, { appid: APPID, openid: 'OPENID-T03A-4B', code: issued.code }),
    )
    assert.equal(second.code, 'ENTITY_NOT_FOUND')

    const bindings = await env.db
      .prepare('SELECT COUNT(*) AS n FROM wechat_identity_bindings WHERE appid = ? AND openid = ?')
      .bind(APPID, 'OPENID-T03A-4B')
      .first()
    assert.equal(bindings.n, 0, '半截账：码被消耗但没绑上，是不允许的')
  })

  test('5. 同一个微信不能绑到第二个成员（防串店）', async () => {
    const memberA = await createMember(env.db, { userId: 15 })
    const memberB = await createMember(env.db, { userId: 16 })
    const openid = 'OPENID-T03A-5'

    const codeA = await identity.createBindingCode(env.db, { appid: APPID, storeId: 1, memberId: memberA, actorUserId: 1 })
    await identity.bindWechatIdentity(env.db, { appid: APPID, openid, code: codeA.code })

    const codeB = await identity.createBindingCode(env.db, { appid: APPID, storeId: 1, memberId: memberB, actorUserId: 1 })
    const dup = await expectFailure(() => identity.bindWechatIdentity(env.db, { appid: APPID, openid, code: codeB.code }))
    assert.equal(dup.code, 'ENTITY_NOT_FOUND')

    const still = await identity.resolveBoundIdentity(env.db, { appid: APPID, openid })
    assert.equal(still.memberId, memberA, '第二次绑定失败后，原有绑定不能被偷偷改掉')
  })

  test('6. 一个成员不能收两张工牌', async () => {
    const memberId = await createMember(env.db, { userId: 17 })
    const first = await identity.createBindingCode(env.db, { appid: APPID, storeId: 1, memberId, actorUserId: 1 })
    await identity.bindWechatIdentity(env.db, { appid: APPID, openid: 'OPENID-T03A-6A', code: first.code })

    const second = await identity.createBindingCode(env.db, { appid: APPID, storeId: 1, memberId, actorUserId: 1 })
    const dup = await expectFailure(() =>
      identity.bindWechatIdentity(env.db, { appid: APPID, openid: 'OPENID-T03A-6B', code: second.code }),
    )
    assert.equal(dup.code, 'PERMISSION_DENIED')
  })

  test('7. 尝试次数用尽的码，即便本身正确也进不来', async () => {
    const memberId = await createMember(env.db, { userId: 18 })
    const issued = await identity.createBindingCode(env.db, {
      appid: APPID,
      storeId: 1,
      memberId,
      actorUserId: 1,
      maxAttempts: 3,
    })

    // 直接把计数推到上限，模拟这条码已被反复提交。
    // 注意：猜错的码在库里查不到任何行（只存摘要），数据层无法给它计数 ——
    // 真正的暴力枚举防护必须在网关层做限流（契约已有 RATE_LIMITED），见 OPEN-ITEMS G-19。
    await env.db
      .prepare('UPDATE wechat_binding_codes SET attempt_count = max_attempts WHERE id = ?')
      .bind(issued.codeId)
      .run()

    const locked = await expectFailure(() =>
      identity.bindWechatIdentity(env.db, { appid: APPID, openid: 'OPENID-T03A-7', code: issued.code }),
    )
    assert.equal(locked.code, 'ENTITY_NOT_FOUND')

    const bound = await env.db
      .prepare('SELECT COUNT(*) AS n FROM wechat_identity_bindings WHERE openid = ?')
      .bind('OPENID-T03A-7')
      .first()
    assert.equal(bound.n, 0, '超限的码不能产生任何绑定')
  })

  test('8. 过期的码不能再用', async () => {
    const memberId = await createMember(env.db, { userId: 19 })
    const issued = await identity.createBindingCode(env.db, {
      appid: APPID,
      storeId: 1,
      memberId,
      actorUserId: 1,
      ttlMs: -1,
    })

    const expired = await expectFailure(() =>
      identity.bindWechatIdentity(env.db, { appid: APPID, openid: 'OPENID-T03A-8', code: issued.code }),
    )
    assert.equal(expired.code, 'ENTITY_NOT_FOUND')
  })

  test('9. 别店的成员：既不给码，也不透露它存在', async () => {
    const otherStoreMember = await createMember(env.db, { userId: 20, storeId: 2 })
    const memberInStore1 = await createMember(env.db, { userId: 21, storeId: 1 })

    // 2 号店的成员，却声称自己是 1 号店的
    const cross = await expectFailure(() =>
      identity.createBindingCode(env.db, { appid: APPID, storeId: 1, memberId: otherStoreMember, actorUserId: 1 }),
    )
    assert.equal(cross.code, 'ENTITY_NOT_FOUND', '跨店一律 404，不用 403 —— 否则能拿来探测')

    // 1 号店的真成员，却被别的店拿来发码
    const wrongStore = await expectFailure(() =>
      identity.createBindingCode(env.db, { appid: APPID, storeId: 2, memberId: memberInStore1, actorUserId: 1 }),
    )
    assert.equal(wrongStore.code, 'ENTITY_NOT_FOUND')
  })

  test('10. 已停用的成员：不给发码，也不给绑定', async () => {
    const memberId = await createMember(env.db, { userId: 22, status: 'disabled' })
    const denied = await expectFailure(() =>
      identity.createBindingCode(env.db, { appid: APPID, storeId: 1, memberId, actorUserId: 1 }),
    )
    assert.equal(denied.code, 'PERMISSION_DENIED')
  })

  test('11. 登出：token_version 往前推，旧凭证的号码就作废了', async () => {
    const memberId = await createMember(env.db, { userId: 23 })
    const issued = await identity.createBindingCode(env.db, { appid: APPID, storeId: 1, memberId, actorUserId: 1 })
    await identity.bindWechatIdentity(env.db, { appid: APPID, openid: 'OPENID-T03A-11', code: issued.code })

    const before = await identity.resolveBoundIdentity(env.db, { appid: APPID, openid: 'OPENID-T03A-11' })
    const oldToken = await identity.issueIdentityToken(JWT_SECRET, {
      userId: 23,
      storeId: 1,
      email: 't03a-u23@example.test',
      sessionVersion: before.sessionVersion,
    })

    const bumped = await identity.rotateSessionVersion(env.db, 23)
    assert.equal(bumped, before.sessionVersion + 1)

    const payload = await session.verifyJWT(oldToken, JWT_SECRET)
    assert.ok(payload, '旧凭证本身没有坏，签名仍然有效')
    assert.notEqual(payload.tv, bumped, '但它带着的会话版本已经过期 —— loadAuthContext 会据此判 401')

    const after = await identity.resolveBoundIdentity(env.db, { appid: APPID, openid: 'OPENID-T03A-11' })
    assert.equal(after.sessionVersion, bumped, '身份表里读到的应是新版本')
  })

  test('12. 换一个小程序 appid，同一个 openid 不是同一个人', async () => {
    const memberId = await createMember(env.db, { userId: 24 })
    const issued = await identity.createBindingCode(env.db, { appid: APPID, storeId: 1, memberId, actorUserId: 1 })
    await identity.bindWechatIdentity(env.db, { appid: APPID, openid: 'OPENID-T03A-12', code: issued.code })

    const otherApp = await identity.resolveBoundIdentity(env.db, {
      appid: 'wxOTHERAPPID000001',
      openid: 'OPENID-T03A-12',
    })
    assert.equal(otherApp, null, 'openid 是相对小程序的，换 appid 必须视为陌生人')
  })
})
