# T03b · 两端请求层：错误码映射、401/403、requestId 保存

日期：2026-09-18。状态：**本地通过**（请求层基础设施建成并被两端测试与跨端门禁覆盖；**未接入任何页面，未连接真实后端**）。

入口：`frontend/src/api/`（网页端）、`miniprogram/features/api-core.ts` 等（小程序端）、`contracts/tools/check-client-parity.mjs`（跨端门禁）。
规格依据：[03-domain-rules.md](../../plans/2026-09-17-web-wechat-plan/03-domain-rules.md) §1 R07/R10、§8 L194；[04-data-and-api.md](../../plans/2026-09-17-web-wechat-plan/04-data-and-api.md) §1 L7、§4 L75–L79、§6 L128–L143、§8、§10 L195；`contracts/v1/errors.json`。
任务卡：[05-implementation-tasks.md](../../plans/2026-09-17-web-wechat-plan/05-implementation-tasks.md) T03b。

---

## 1 · 这张卡要解决什么（一句话）

**动作发出后结果不确定时，两端怎么表现。** 用户点「确认收款」后请求超时 —— 旧写法当失败处理，用户再点一次就成了第二笔。本卡把「重试必须复用同一个 requestId」「超时是结果未知不是失败」「撤权后两端旧会话失效」这三条规格变成两端共用的机器规则。

## 2 · 实际改动

| 文件 | 状态 | 职责 |
|---|---|---|
| `frontend/src/api/error-behavior.ts` | 新增 | 16 个契约错误码 → **结构化行为枚举**（不是文本）；未知结果流程；兜底文案 |
| `frontend/src/api/core.ts` | 新增 | 请求核心：requestId 生成/复用、载荷摘要、Idempotency-Key、超时→结果未知、401/403 副作用 |
| `frontend/src/api/session.ts` | 新增 | 身份缓存清理（401 两条分支区别对待）、目标页记住/恢复 |
| `frontend/src/api/client.ts` | 新增 | 网页端装配（fetch + AbortController + localStorage + 行为表），`/api/v2` 前缀 |
| `miniprogram/features/error-behavior.ts` | 新增 | 与网页端同构（由同一份源码派生） |
| `miniprogram/features/api-core.ts` | 新增 | 与网页端 `core.ts` 同构 |
| `miniprogram/features/session.ts` | 新增 | 同构 + wx 同步存储适配器 |
| `miniprogram/features/api-client.ts` | 新增 | 小程序装配（wx.request + `dataType:'text'`）；**baseUrl 缺配置立刻抛错**，不静默 |
| `contracts/tools/check-client-parity.mjs` | 新增 | **跨端一致性门禁**（三级强度，见 §4） |
| `frontend/src/api/error-behavior.test.ts`、`core.test.ts` | 新增 | 网页端 41 用例 |
| `miniprogram/tests/error-behavior.test.mjs`、`api-core.test.mjs` | 新增 | 小程序端 28 用例 |

**未改**：`backend/src/index.ts`（一行未动）、`contracts/v1` 全部文件（冻结未动）、两端契约生成物、既有页面与数据源（两端仍为演示数据源）。

## 3 · 关键设计决策（后续卡必须遵守）

### 3.1 requestId 的复用与清除规则（会救钱的那条）

- 写动作在**用户动作时刻**生成 requestId，与载荷摘要一起存进存储（刷新页面不丢）。
- **重试复用**：同动作 + 同实体 + 载荷摘要相同 → 复用同一 requestId（结果未知后重试不产生第二笔）。
- **载荷变了必须换新 ID**：否则服务端判 IDEMPOTENCY_MISMATCH —— 那是服务端的判断，客户端不主动制造。
- **只在服务端明确成功后清除**。响应确定成功后，用户再提交同一动作是**新的**一次 —— 防重复收款由服务端余额约束（BALANCE_EXCEEDED）与界面提交锁负责，不靠客户端一直复用旧 ID（否则真收第二笔会被误当第一笔）。

### 3.2 结果未知 ≠ 失败

- 传输层超时/断网、无契约错误码的 5xx/网关（502/503/504）→ `unknownResult: true`，写动作必须先查 `GET /operations/:requestId`。
- 结果类型**不抛异常**：抛异常会让调用方把「未知」误当「失败」（正是 errors.json 禁止的「统一 toast 后关闭表单」）。
- 网关抖动**不清会话**：只有明确契约错误码才触发会话副作用，否则一次 502 就把人踢下线。

### 3.3 401 的两条分支与「结果未知时保留、撤权时清掉」的 pending 规则

- `AUTH_REQUIRED`：清身份缓存，**保留**草稿与待确认动作，记录目标页 —— 用户没做错什么。
- `SESSION_REVOKED`：清身份缓存**与**本地草稿**与**待确认动作（03 §8 L194），记录目标页 —— 权限已收回，新身份不应残留旧动作。
- 这条规则是**跨端门禁当场抓出来的**：首版只清了草稿没清 pending，两端一致地错，被门禁场景 B 拦下后修正（见 §5）。

### 3.4 错误行为枚举不进冻结契约（新待裁定项 D-J）

契约 `clientHandling` 是给人看的文本，`errors.ts` 声明「程序分支只能依据 code」。行为表是端内实现（`Record<ErrorCode,…>` 让 tsc 强制 16 码全覆盖），由门禁脚本与契约逐项对齐。**若负责人日后裁定升入契约（与 D-A/D-H 合并考虑，须建 contracts/v2），应删除两端行为表改为消费生成物。**

### 3.5 为什么是「零运行时依赖核心 + 薄装配层」

微信编译链能否接受带 `.ts` 扩展名的 import 尚未验证，且小程序 tsconfig 没有 `allowImportingTsExtensions`。因此两端核心文件（error-behavior / core / session）**只允许 `import type`**，Node 22 类型擦除后可直接加载 —— 跨端门禁因此不需要 esbuild、不需要新依赖。装配层（fetch / wx.request）薄到不需要跨端比对。

## 4 · 跨端一致性门禁（`node contracts/tools/check-client-parity.mjs`）

| 级别 | 检查 |
|---|---|
| 1 | 两端导出物逐项深比较：行为表、结果未知行为、decide/fallback/isRetryable 同输入同输出（16 码 × 读写 + 未知码） |
| 2 | 两端行为表与 `errors.json` 对齐：16 码不多不少、兜底文案 = meaning 逐字、retryable 一致 |
| 3 | 两端请求核心**同输入实跑**：常量、payloadHash、pendingKeyOf、isGatewayFailure、错误体解析；三个场景（未知→重试复用同 ID、撤权清理、网关不清会话）逐项比对可观察输出 |

## 5 · 验证证据

环境：本机 Node v22.22.2；后端测试为 miniflare 真实 workerd + 真实 D1（隔离内存库）。**未连接远程、未部署、未触碰生产。**

| 检查 | 命令 | 结果 |
|---|---|---|
| 后端全量（确认未破坏） | `npm --prefix backend test` | ✅ 58/58 |
| 前端全量 | `npm --prefix frontend run test` | ✅ 8 文件 / 91 用例（原 50 + 本卡 41） |
| 小程序全量 | `npm --prefix miniprogram test` | ✅ 6 文件 / 67 用例（原 39 + 本卡 28） |
| 契约自洽 | `node contracts/tools/validate-contracts.mjs` | ✅ 3109 项，退出码 0 |
| 网页端生成物防漂移 | `node frontend/scripts/sync-contracts.mjs --check` | ✅ 6 文件一致 |
| 小程序端生成物防漂移 | `node miniprogram/scripts/sync-contracts.mjs --check` | ✅ 6 文件一致 |
| 后端错误码防漂移 | `node backend/scripts/sync-error-codes.mjs --check` | ✅ 16 个错误码一致 |
| **跨端一致性门禁** | `node contracts/tools/check-client-parity.mjs` | ✅ 36 项检查全部通过 |
| 前端类型检查 | `tsc -b`（frontend） | ✅ 退出码 0 |
| 小程序类型检查 | `tsc --noEmit`（miniprogram） | ✅ 退出码 0 |
| 新文件 lint | `eslint src/api`（仅本卡新目录） | ✅ 0 错误（**全仓 lint 的 39 项既有失败未跑未修**） |
| 后端生产构建自检 | `npx wrangler deploy --dry-run` | ✅ 通过，**未部署** |

日志：`logs/`。

## 6 · 未完成 / 阻断

| 项 | 说明 |
|---|---|
| **请求层未被任何页面使用** | 两端数据源仍是演示数据。页面接入从 T05b 开始，接入时必须走 `createWebApiClient` / `createMiniProgramApiClient`，不得绕过核心自己拼 fetch / wx.request |
| **baseUrl 的小程序端配置** | `createMiniProgramApiClient` 强制要求 HTTPS baseUrl；API 域名未定（OPEN-ITEMS T-05），接入前必须先提供 |
| **微信重新登录恢复目标页的端到端验证未做** | 记住/恢复的**逻辑**已测；真实微信登录 → 恢复页面的**链路**要等 T03a（后端微信身份交换）与登录页接入 |
| **T03a / T03c 未开始** | T03a 阻塞在微信条件（AppSecret / 主体 / API 域名，见 OPEN-ITEMS T-05）；T03c（跨店访问、码过期、解绑后旧 token 测试）依赖 T03a |
| **行为枚举升入契约待裁定（D-J）** | 与 D-A / D-H 合并考虑；裁定升入时须建 contracts/v2 并删除两端行为表 |
| **载荷摘要算法是端内约定** | FNV-1a 32 位不在契约里；门禁保证两端一致，但后端**不得**依赖客户端摘要做任何判断（它只是复用判定，安全边界在服务端） |

## 7 · 新增踩坑（已登记 OPEN-ITEMS §4）

| 编号 | 坑 | 正确做法 |
|---|---|---|
| P-22 | **Windows 下动态 `import()` 一个绝对路径（`c:/…`）直接报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`** | 一律用 `pathToFileURL(p).href`（或拼 `file://` + 正斜杠）再传给 import；写跨端加载脚本时别按 POSIX 习惯裸传路径 |

## 8 · 下一步

1. **T05b**（网页库存表格 / 逐件视图，小程序搜索 / 实物页）—— 现在有请求层可用；但 B12/B13 的 HTTP 路由仍未接（依赖 T03a 鉴权），接入方式需要先裁定：演示数据 + 请求层并存，或等待 T03a。
2. **T03a**（后端绑定码 / 微信身份交换）—— 等负责人提供 AppSecret、确认主体类型与 API 域名（OPEN-ITEMS T-05）。
3. 待负责人裁定：**D-J**（错误行为枚举是否升入契约）。
