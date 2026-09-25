# MP17 · 顾客身份与归属契约

日期：2026-09-23。状态：**契约与迁移已落地，C 档门禁全绿，待复核（review）**。
上游：[MP16 隔离环境与演示开关](../MP16/README.md)（已实现，review）。

## 本卡交付

把「顾客是谁、能看什么、怎么登录、旧档案怎么认领、失效怎么办」冻结成契约，并落一张新表。
**本卡不写后端实现** —— `backend/src/domains/customer-identity.ts` 属 MP18。

## 已改文件

| 文件 | 改动 |
|---|---|
| `contracts/v1/objects.json` | 新增 `CustomerIdentity`（表 `customer_wechat_identities`，**不含 memberId**）与 `CustomerSession`（无表）；追加 `revisions` |
| `contracts/v1/enums.json` | 新增 `CustomerClaimStatus`、`CustomerClaimMethod`；首次补入 `revisions` |
| `contracts/v1/errors.json` | 新增 `CUSTOMER_CODE_INVALID`(401)、`CUSTOMER_IDENTITY_REVOKED`(401)、`CUSTOMER_CLAIM_REQUIRED`(403) |
| `contracts/v1/actions.json` | `authActions` 新增 A05 顾客微信登录、A06 顾客登出、A07 顾客会话与认领状态；追加 `revisions` |
| `contracts/v1/legacy-mapping.json` | `tables` 登记 `customer_wechat_identities`；`objectsWithoutLegacyTable` 加 `CustomerSession`；`sources` 补迁移；`revisionNote` 前置本次记录；`openQuestions` 新增 Q05（跨店） |
| `backend/migrations/0026_customer_wechat_identity.sql` | **新增**顾客微信身份表 |
| 生成物（4 处） | `contracts/generated`、`frontend/src/contracts/generated`、`miniprogram/contracts/generated`、`backend/src/generated/error-codes.ts`（18→21 个错误码），全部由工具生成 |

未改动：`conventions.json`、`money-rules.json`、`fixtures.json`、任何既有对象/枚举/错误码/动作取值。

## 设计决策（2026-09-23 栋哥拍板）

| 决策 | 取值 | 影响 |
|---|---|---|
| 顾客与门店 | **单店绑定**：唯一键 `(appid, openid)` | 一名顾客在当前小程序里只对应一条身份；多门店须升契约版本（已登记 Q05） |
| 旧档案认领 | **微信验证手机号（wechat-phone）+ 店员确认（clerk-confirm）** | `CustomerClaimMethod` 刻意**不含**「顾客自填手机号」——自填号码可冒领他人档案 |
| 顾客会话 | **30 天，活动即续期** | `CustomerSession.expiresAt` 默认 30 天；员工会话仍为 7 天（沿用 `session.ts`） |

## 授权矩阵

| 场景 | 结果 | 依据 |
|---|---|---|
| 匿名读公开商品 / 文章 / 门店 | 允许 | 不进本卡对象；MP20 定义公开 DTO |
| 匿名读任何私人数据 | `AUTH_REQUIRED`(401) | 顾客私人接口一律要求会话 |
| 顾客 A 读自己的报价/订单 | 允许 | 服务端按 `customerId` 过滤 |
| 顾客 B 读 A 的数据 | 拒（按 `ENTITY_NOT_FOUND` 语义处理，不泄露存在性） | 顾客不能收到他人资料 |
| 微信身份有效、未认领 | `CUSTOMER_CLAIM_REQUIRED`(403)，**不是空数据** | 空数据会让页面误判「没有记录」 |
| 认领被驳回 | 同上（403），走重认领 | `claimStatus = rejected` |
| 顾客身份解绑 / `session_version` 递增 | `CUSTOMER_IDENTITY_REVOKED`(401)，清缓存与草稿 | 与员工撤权同处理 |
| 员工 token 访问顾客私人接口 | 拒 | 载荷不同：员工带 `memberId`、顾客带 `customerId`，**不得互相通过校验** |
| 顾客 token 访问员工接口 | 拒 | 同上 |
| 同店 / 跨店 | 单店绑定下不存在跨店查询；跨店一律不可见 | `CustomerIdentity` 唯一键 `(appid, openid)` |
| 拒绝授权后返回原页 | `A05` 的 `returnTarget` 按白名单校验，不得跳员工路由或外部地址 | 复用 `session.ts` 的 `SAFE_TARGET` 思路 |

## 实测命令与结果

C 档要求全套共享门禁 + 新增迁移从空库应用：

| 命令 | 结果 |
|---|---|
| `node contracts/tools/validate-contracts.mjs` | **exit=0，全部检查通过**（重生成前有 11 项"生成物待重生成"，属预期） |
| `node contracts/tools/generate-dto.mjs --check` | pass（6 个文件） |
| `node frontend/scripts/sync-contracts.mjs --check` | pass |
| `node miniprogram/scripts/sync-contracts.mjs --check` | pass |
| `node contracts/tools/check-client-parity.mjs` | pass（两端行为表、常量、请求核心逐项一致） |
| `node backend/scripts/sync-error-codes.mjs --check` | pass（21 个错误码） |
| `node backend/scripts/check-migration-sequence.mjs` | pass（**27 个文件，0000–0026 连续无缺号**，下一个必须是 0027） |
| `node scripts/check-doc-links.mjs` | pass（213 文件 / 521 链接 / 0 断链） |
| 后端全量 `node --test --test-concurrency=1 "tests/*.test.mjs"`（在 `backend/`） | **360 用例 / 0 失败**（`applyMigrations()` 从空库全量重放，即 `0026` 已被真实应用并跑通） |
| 小程序 `node --test "miniprogram/tests/*.test.mjs"` | **123/123** |
| 小程序 `tsc -p tsconfig.json --noEmit` | pass |
| 前端 `tsc -b`（在 `frontend/`） | pass |
| 前端 `vitest run src/api/error-behavior.test.ts` | 16/16 |

## 超出卡内清单的改动（附理由）

卡内「只允许改动」未列两端的行为表，但**必须一并改**：

- `miniprogram/features/error-behavior.ts`
- `frontend/src/api/error-behavior.ts`

理由：两端都有 `ERROR_HANDLING: Record<ErrorCode, ErrorHandling>`，用 tsc 强制「不多不少」覆盖契约全部错误码。
新增 3 个码后若不同步，会同时触发：① `tsc` 编译失败；② 小程序 `error-behavior.test.mjs` 4 项失败
（实测现象就是这个）；③ 契约侧要求「契约里每个 code 都必须有客户端行为」。
这属于卡内步骤 2「冻结…**错误语义**」的必要连带，与「重新生成产物」同类；改动内容只是为 3 个新码补行为条目，
未动任何既有码的取值。`check-client-parity.mjs` 已复核两端逐项一致。

## 未验证范围

- **未在微信开发者工具运行**：本卡无 wxml/wxss 与页面改动（`visual: not_applicable`）。
- **契约目前没有业务代码消费**：顾客登录的实现在 MP18；本卡只冻结语义。因此"登录交换是否真能跑通"未验证。
- **认领流程的测试样本未在本卡交付**：卡内清单允许的后端测试文件是 MP18 的 `backend/tests/customer-identity*.mjs`，
  本卡不新建后端测试文件（那会超出清单且无实现可测）。安全流程本身已用枚举与 CHECK 约束冻结。
- 未访问生产、未部署、未提交、**未执行任何远端迁移**。
- 备案状态未现场核实（故环境地址表仍为空，见 MP16）。

## 阻塞

1. **无可用 HTTPS API 域名** —— 同 MP16：`pc.huangqidong.cn` 未做国内接入备案，本地 Worker 为 `http://127.0.0.1:8787`。
2. **`0026` 未应用到任何远端**：卡与项目规则都不授权 apply；本地隔离库已验证可应用。

## 下一动作

**MP18 · 顾客登录服务端**（`backend/src/domains/customer-identity.ts`、`backend/src/routes/customer-auth.ts`、
`backend/src/index.ts` 接线、`backend/tests/customer-identity*.mjs`）。动接线前先复核单点区时间戳与 diff。
本卡未自动进入下一卡。
