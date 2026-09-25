# T03a（第一轮）· 微信身份地基

日期：2026-09-18 · 状态：**地基已验证，尚未接 HTTP 路由**
范围：后端 `migrations/0008`、`src/domains/identity.ts`、`src/domains/session.ts`、抽出旧 JWT

---

## 1. 背景与决定

T03a 原文：`05-implementation-tasks.md` §T03 L61 —— 「后端绑定码、微信身份交换、绑定成员、撤权 / 登出」。

本轮动工前先确认了三件事：

1. **后端早就有一套 JWT 凭证体系**（`src/index.ts` 的 `signJWT` / `verifyJWT` / `loadAuthContext`，
   载荷 `uid / email / sid / tv`，`tv` 就是 `users.token_version`），微信登录只是**多一条入口**，
   不是另起一套。⇒ 抽出 `src/domains/session.ts` 作为单一实现，避免同一仓库出现两套 JWT
   （凭证漂移是安全事故，参照 T-10 「两端各写一份必然漂移」的教训）。
2. **走的是不依赖 ICP 备案的那条路**（云函数中转，见 OPEN-ITEMS T-11 线路 B）。
   因此本轮的集中点是**后端身份内核**——它无论入口是云函数还是 code2session 都通用。
3. **不新增契约错误码**：全部映射到既有码（`ENTITY_NOT_FOUND` / `PERMISSION_DENIED` /
   `AUTH_REQUIRED` / `VALIDATION_ERROR`）。新增错误码属于新增规范性表面，须提 `contractVersion`。

## 2. 改了什么

| 文件 | 变化 |
|---|---|
| `backend/migrations/0008_wechat_identity.sql` | **新增**。`wechat_binding_codes`（只存 `code_hash`；一个成员同时只允许一个 pending 码）+ `wechat_identity_bindings`（`UNIQUE(appid, openid)`、活跃绑定按 `member_id` 唯一） |
| `backend/src/domains/session.ts` | **新增**。从 `index.ts` **原样搬来** `signJWT / verifyJWT / b64url / hmacSha256`，算法与载荷一字未改 |
| `backend/src/index.ts` | 删掉上述四个函数的私有定义，改为 `import { signJWT, verifyJWT } from './domains/session'`。**行为等价，未动任何路由逻辑** |
| `backend/src/domains/identity.ts` | **新增**。`createBindingCode` / `bindWechatIdentity` / `resolveBoundIdentity` / `rotateSessionVersion` / `issueIdentityToken` |
| `backend/tests/t03a-identity.test.mjs` | **新增**。12 个用例（真实 workerd + 真实 D1） |
| `docs/OPEN-ITEMS.md` | 登记 **G-19**、更新 T-05 / T-11 |

**0008 没有应用到任何远端。** 本地 migrations 会被测试自动按序应用，远端状态见 OPEN-ITEMS §3。

## 3. 三条设计取舍

1. **明文绑定码只在生成的那一次出现**，库里只有 SHA-256 摘要（契约 A02 要求）。
2. **不使用「条件 UPDATE + 查影响行数」**（T04 的血泪）。抢一份绑定靠的是：
   `UNIQUE(appid, openid)` 与 `UNIQUE(member_id) WHERE status='active'` 两条索引做**断言**，
   `UPDATE` 之后再 `SELECT` 复核 `consumed_by_openid` 是不是自己。
   一个 batch 就是一个事务，抢不到就整批回滚 —— 不会出现「码消耗了但没绑上」的半截账。
3. **跨店一律 404，不用 403**。否则这个接口可以拿来探测哪些 `memberId` 存在。

## 4. 验证

```bash
npm --prefix backend test          # 70 用例通过（原 58 + 本轮 12）
node scripts/sync-error-codes.mjs --check   # ✓ 与契约一致（16 个错误码）
```

实测 `# tests 70 / # pass 70 / # fail 0`，耗时 128.6s。

用例覆盖：**明文码不落库**、同一成员同时只允许一个待用码、正常绑定全链路 +
凭证可验证、**同一个码不能用第二次**、**同一微信不能绑第二个成员**（失败后原绑定不变）、
**一个成员不能收两张工牌**、尝试次数用尽、过期码、跨店 memberId、**停用成员**、**登出后 token_version 推进**、
换 appid 后同一 openid 视为陌生人。

## 5. 未验证 / 已知限制

- ⚠️ **本地没有 TypeScript 编译器**（backend 与根 `node_modules/.bin` 都没有 `tsc`）。
  测试通过的是 esbuild **转译**后的产物，只能证明语法与运行时正确，**类型错误没有被拦住**。
  接路由前必须在有 `tsc` 的环境补一次 `tsc --noEmit`。
- ⚠️ **尚未接 HTTP 路由**：`/auth/wechat/login`、`/auth/wechat/binding-codes`、`/auth/logout`、
  `/me` 都还没有出口，`index.ts` 的请求入口一行没动。
- **G-19（本轮实测发现的设计漏洞）**：只存摘要 ⇒ 猜错的码查不到任何行 ⇒ 尝试次数加不上。
  数据层挡不住枚举，枚举防护必须在网关层按来源限流（`RATE_LIMITED`）。限值待负责人定。
- 绑定流程里尚未写审计日志（现有 `audit_logs` 表可用，接线时补）。
- `index.ts` 的改动只做了**搬移**，旧登录路径没有任何自动化测试覆盖。

## 6. 下一步

1. **先确认前提**：这个小程序账号到底有没有开通**云开发环境**（开发者工具左上角有无「云开发」按钮）。
   有 → 入口写云函数 → 云函数用 `getWXContext()` 取 OPENID（连 AppSecret 都不需要）；
   没有 → 入口走 code2session（需要 AppSecret，且绕不开备案）。
2. 接 HTTP 路由 + 网关层限流（G-19）。
3. 两端登录页（T03b 的请求层已在，缺的是登录交互）。
