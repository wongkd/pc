# 小任务执行与验收规则

日期：2026-09-22。适用于本目录 `tasks/MP*.md`；规划交付不代表这些任务已完成。

## 使用方式

双击[任务选择器](index.html)，从 MP00 开始，选择当前卡并复制**整段提示词**到能访问本仓库的 AI。
也可以直接把对应 Markdown 文件发给 AI。每张卡含目标、只读输入、允许文件、步骤、验收与停手条件。
无需自行拼接“通用提示词 + 分卡”。不支持本地文件读取的 AI 必须同时提供卡内列出的文档、源码和参考图。

默认按编号串行；依赖图用于判断能否先处理独立卡，不授权多个 AI 同时改共享文件。
大多数卡是轻量模型可做的单页/单组件/单接口；标为**复核**的卡也可由轻量模型起草，但需要能力更强的 AI 或人工检查证据后放行。
“复核”是工程建议，不是要求用户每一步点确认；已有明确规则的实现直接按卡执行。

## 卡片粒度

- 一张卡只交付一个可见区域、一个页面或一个明确服务端责任；通常一次会话 30–90 分钟，时间仅作拆分参考。
- 若一张卡需要修改超过 8 个业务源文件或产生两个独立写流程，在本卡目录拆为子卡，先完成当前最小结果；注册/生成物/证据文件不计入这 8 个。
- 不借修页面去换架构，不补做别的卡，不重新设计四个 Tab。
- 公共组件/契约不够用时先写具体缺口；不得复制协议类型、绕鉴权或随手扩展金额语义。
- 连续两次修复仍无法解释根因：保存失败命令、日志和最小复现，标 blocked 并给出具体接续任务，避免小模型反复扩改。

## 状态与接手

实施时每张卡在 `docs/verification/customer-4tab/MPxx/` 保存自己的 README 与 `receipt.json`。
选择器只显示任务目录，**不自动宣称已完成，也不自动读取其他 AI 的回执**。整体以任务证据与 STATUS 为准。

```json
{
  "id": "MP00",
  "status": "review",
  "updatedAt": "实际 ISO 时间",
  "summary": "本卡实际结果",
  "evidence": ["实际存在的相对路径"],
  "checks": [{"command": "实际命令", "result": "pass/failed/not_run"}],
  "visual": "not_applicable/not_run/review/passed",
  "blockedBy": [],
  "next": "下一条具体动作"
}
```

允许状态：working / blocked / review / verified。无回执为未开始。verified 需本卡必需验证全部通过；需截图但看不到图只能 review。
核验依赖时读对应回执、证据及源码；依赖代码变化后重新评估，不能只认一个 verified 字符串。
在全局 STATUS/交接仅更新“顾客 4Tab 专项”段，保留并行 ERP 断点；旧长规划不再作为执行入口。

## 检查档位

| 档位 | 必跑 |
|---|---|
| D：文档/素材规划 | `node scripts/check-doc-links.mjs`；本任务 `check-plan.mjs`；实际查看新增图 |
| M：小程序实现 | `npm --prefix miniprogram test` → `run check-pages` → `run check-classes` → `run typecheck` → `run check-contracts`；改 UI 实际截图 |
| B：服务端实现 | 本域测试 + `npm --prefix backend test` + `npm --prefix backend run check:error-codes`；真实本地 HTTP，不能只有 mock 返回 |
| C：契约/迁移/接线 | 下列共享门禁全套；新增迁移必须本地隔离库从空库应用并覆盖受影响场景 |
| W：配套 ERP UI | `npm --prefix frontend test` 然后 `npm --prefix frontend run build`；改 UI 看浏览器图，相关 lint 与既有失败分开记录 |

M 档的 `run` 命令均带 `npm --prefix miniprogram`。新组件/目录要纳入 tsconfig 和结构检查，不能通过 exclude 逃避检测。

共享区动手前查看 `contracts/v1`、生成物、`backend/migrations`、`backend/src/index.ts` 时间戳及 diff，确认没有其他任务写入。
时间戳只是线索，不能当真正的锁；有活动变更时保存草稿并让出共享区。单点卡必须串行完成：

```text
node contracts/tools/generate-dto.mjs
node frontend/scripts/sync-contracts.mjs
node miniprogram/scripts/sync-contracts.mjs
node backend/scripts/sync-error-codes.mjs
node contracts/tools/validate-contracts.mjs
node contracts/tools/generate-dto.mjs --check
node frontend/scripts/sync-contracts.mjs --check
node miniprogram/scripts/sync-contracts.mjs --check
node contracts/tools/check-client-parity.mjs
node backend/scripts/sync-error-codes.mjs --check
npm --prefix backend run check:migrations
node scripts/check-doc-links.mjs
```

新增迁移编号现场查询最小未用四位编号，不从本文猜编号。入口改动须逐条核对权限映射 evidence 行号真实落点，校验器变绿不替代查证。
网页 test/build 串行，同一文件的写入串行。历史测试数字不复制成本轮结果。

## 总验收矩阵

| 维度 | 必须覆盖 | 证据 |
|---|---|---|
| 四屏视觉 | 四 Tab × 375/390/430、320 溢出、固定样本、顶部与底部安全区 | 原图/实图/叠加、偏差表、人工看图记录 |
| 交互 | 四 Tab 返回恢复、分类切换、长列表、二级返回、表单键盘、连续点击、拒绝授权 | 微信工具步骤与截图/录屏 |
| 状态 | 加载、空、图片坏链、断网、超时、4xx/5xx、无权、过期/撤销/新版本 | 可复现样本，错误后输入保留 |
| 隐私 | A/B 两顾客、同店/跨店、修改 ID、转发分享、私有图、退出再登录 | 对实际 HTTP 响应字段做断言，不能只截图隐藏 |
| 报价 | ERP 发出 → 顾客查看 → 确认 → ERP 显示确认；旧版、撤回、重复确认 | 真实本地接口与双端证据 |
| 意向 | 三表单提交 → ERP 看见 → 店员处理关联 → 顾客查看；重试不重复 | 输入、HTTP、ERP 关联与顾客详情 |
| 订单/资金 | 客户仅见本人；部分收款、待付、取消/退货退款状态；未付不锁库 | 数据库/接口断言及页面显示 |
| 支付 | 伪通知、错商户/订单/金额、重复通知、乱序/超时查询、客户端取消、库存冲突 | 服务端测试+受控测试环境；真实到账另单列 |
| 发布 | 主体/AppID、域名、隐私配置、图片来源、包体、无员工路由/演示数据 | 当前控制台与工具结果，不凭历史政策断言 |

最高风险的顾客授权、分享、金额/支付卡要单独复核；前后端“返回成功”不是支付/库存业务已正确的证据。
开发者工具、iOS、Android、生产/支付平台分别记 pass/failed/not_run；不能互相替代。

## 阻塞与止损

- **素材缺失**：可以做结构与独立业务，视觉保持未通过。不能让小模型凭想象找图替换。
- **身份归属未定**：公开内容可继续，私人业务停在接口契约；不把员工 token 发给顾客。
- **测试域名/主体未就绪**：离线视觉与隔离 HTTP 可继续；微信实连标 blocked。
- **支付未就绪**：保留真实“待接入/联系门店”，支付阶段保持未完成；不能悄悄降为已交付交易版。
- **工作区冲突**：只保留本卡可审查改动与回执，不 reset/clean、不覆盖他人代码、不混合提交。
