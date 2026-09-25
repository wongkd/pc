# E04b · 商品 / 实物 / 期初库存接真实接口

日期：2026-09-19。范围：把 T05a 的商品主数据、逐件实物、数量余额与受控期初**接上 HTTP 路由**，
并把库存页从演示数据换成真实读写，补上商品建档与期初录入两个界面。

本目录属于**本地实现 + 本地验收**：真实 Worker 入口 + 内存 D1 + 真实 HTTP，但不连生产、不部署、不应用远端迁移。

## 1. 入口与命令

| 用途 | 命令（仓库根） |
|---|---|
| 起隔离后端（miniflare + 真实 Worker + 内存 D1 + 演示数据，含商品与期初） | `npm --prefix backend run dev:local` |
| 起网页端（`/api` 自动代理到上面的本地后端） | `npm --prefix frontend run dev` |
| 浏览器验收（自动起前后端、走真实登录、出截图与报告） | `node docs/verification/2026-09-19-E04b-inventory/verify-inventory.cjs` |
| 后端接口测试（25 个用例，覆盖 401/403/跨店 404/幂等/版本/期初） | `node --test backend/tests/e04b-inventory-http.test.mjs` |
| 前端库存页测试（读取、成本列、建档、期初、结果未知） | `npx --prefix frontend vitest run src/features/workbench/WorkbenchInventoryPage.test.tsx` |

演示账号：`owner@local.test` / `local-preview-pass`（只存在于内存，进程退出即消失）。

## 2. 接了什么

新增一条契约链路，路径按 `conventions.api.prefix` 落在 `/api/v2`：

| 契约条目 | 方法 / 路径 | 权限码 | 说明 |
|---|---|---|---|
| R06 | `GET /api/v2/inventory` | `inventory/view` | 型号汇总 + 逐件实物 + 合计；`productRef` 只看一个型号 |
| R07 | `GET /api/v2/inventory/items/:id` | `inventory/item-view` | 单件实物：来源、有效占用、最近流水 |
| B12 | `POST /api/v2/inventory/products` | `inventory/product-edit` | 商品建档与修订（幂等 + 版本） |
| B13 | `POST /api/v2/inventory/openings` | `inventory/opening` | 期初建账（老板专属） |
| R14 | `GET /api/v2/operations/:requestId` | 无（登录即可） | 「结果未知」后的第一步 |

这几条编号、路径、权限码、错误码**都是契约里早已冻结的**，本卡没有新造动作，也没有新造权限码。

### 2.1 改了什么

| 文件 | 改动 |
|---|---|
| `backend/src/routes/inventory-v2.ts` | **新增**。整条 v2 库存链路：分发、权限、契约信封、入参解析、写结果映射 |
| `backend/src/index.ts` | 只加 1 行 import + 2 行分发；旧 `/api` 路由一行未动 |
| `backend/src/domains/inventory.ts` | 读模型补 `brand` / `defaultSalePriceCents` / `version`；`queryInventory` 支持 `productRef`；B12 落 `category_id` / `brand_id` |
| `backend/tests/e04b-inventory-http.test.mjs` | **新增 26 个用例**（真实 Worker 入口 + 真实 D1） |
| `backend/scripts/dev-server.mjs` | 演示数据补 5 个商品与 3 张期初单；另列区两件实物直接播（采购/接修卡还没接） |
| `frontend/src/features/workbench/inventory-api.ts` | **新增**。走 T03b 请求核心的接口包装，不自己拼 fetch |
| `frontend/src/features/workbench/WorkbenchInventoryPage.tsx` | 重写：真实读写、加载/失败/重试/空态、商品表单、期初表单、单件下钻 |
| `frontend/src/App.tsx` | 给库存页传会话权限（只用于提前隐藏按钮） |
| `frontend/src/styles/workbench.css`、`theme.css` | 新件样式；补 4 个被引用却从未定义的变量；窄屏页头与复选框修正 |
| `contracts/v1/actions.json` | index.ts 行号证据整体 +1（24 条）、specBasis 1 条、2 处正文行号引用 |

### 2.2 两个必须记住的取舍

**① 新权限码不能写进 `src/index.ts`。**
`validate-contracts.mjs` 第 10.6 节把 index.ts 里所有 `'xx/yy'` 字面量当成**旧**权限码，要求它们全部出现在
`legacyPermissionMap` 里。新码（`inventory/view` 等）放进入口会让契约校验直接变红。
所以整条 v2 链路单独成文件，入口只留分发。这条以后接别的域同样适用。

**② 请求层认旧码，但期初不认。**
门店现有角色行里存的是旧码，契约 `legacyPermissionMap` 已声明 `library/view → inventory/view` 等映射，
所以读与商品写都同时接受新旧码 —— 否则所有店员一律无权限。
但 `inventory/opening` 是 `owner_only` 且 `library/edit` 的 `doesNotGrant` 明确列出它：
**旧宽权限换不到期初录入**。这一条有专门用例（`noWidening`）挡着。

## 3. 实测发现并修掉的缺陷

都不是推测，是这一轮跑出来的：

1. **四个 CSS 变量从未定义，整条声明被浏览器丢弃。**
   `workbench.css` 引用了 `--wb-accent`、`--wb-radius-btn`、`--wb-radius-card`、`--wb-surface-sunken`，
   但 `theme.css` 里一个都没定义。无回退值的 `var()` 会让整个属性失效 ——
   于是 `outline: 2px solid var(--wb-accent)`（键盘焦点）**完全不生效**，行悬停没有底色，卡片圆角一直是 0。
   已按既有色板补上（不新增颜色、不新增圆角档位）。这是 V-01「键盘可达/对比度未验收」里最实的一条。

2. **全局 `input{width:100%}` 把复选框拉成一整行。**
   于是「需要登记 SN」勾选框跑到最左、文字被推到最右（截图可见）。旧页面各自写过同样的例外，本页跟上。

3. **窄屏下页头按钮被压成竖排字。** 390×844 实测「录入期初库存」变成一列单字。
   修法是按钮不换行 + `.wb-page` 作用域内页头改上下排（不影响工作台与落地页）。

4. **期初被拒时用户看到的是「字段无效」。**
   写动作的断言守卫只把错误码带出异常（T04 的设计），而 `VALIDATION_ERROR` 的契约兜底文案是
   「字段无效，或金额不是整数分」。触发最多的场景恰恰是「这个型号已经有库存事实了」——
   字段明明没问题。已在路由层补 `guidanceFor()` 给出可照做的说明，并在页面选中已有库存的型号时就提前写明。
   这一条是**浏览器验收第一次跑出来的**：脚本原本以为能再入一次期初，结果拿到 400。

5. **写完动作后有一段「提示说已保存、表格还是旧数字」的窗口。**
   原来是先 `setNotice` 再 `await reload()`。已改成先刷新再提示。

6. **展开区在写动作后停在上一次快照。** 列表刷新了，展开的逐件列表没有。
   现在 `reload()` 会连带刷新展开行 —— 否则同一个页面会同时显示两套数字。

7. **验收脚本自己的两个假阳性**（不是产品缺陷，但会让报告说谎，所以也记下来）：
   行已经展开时再点会把它收起（后续步骤全部找不到元素）；上一条回执会满足下一次「等页面出现某提示」的等待，
   于是一次 400 被当成成功。现在 `expandRow` 先看 `aria-expanded`，每个写动作前先关掉上一条回执，
   并把每一条 4xx/5xx 的响应体写进报告。

## 4. 实跑证据

| 检查 | 命令 | 结果 |
|---|---|---|
| 后端测试 | `npm --prefix backend test` | **125 通过 / 0 失败**（本卡新增 26；E04 基线 99） |
| 前端测试 | `npm --prefix frontend test` | **12 文件 138 用例通过**（库存页 14 个用例；此前 131） |
| 前端构建 | `npm --prefix frontend run build` | 通过（`tsc -b` + vite build） |
| 契约校验 | `node contracts/tools/validate-contracts.mjs` | **通过 3233 项 / 失败 0 项** |
| 契约生成物 | `node contracts/tools/generate-dto.mjs --check`、`node frontend/scripts/sync-contracts.mjs --check` | 通过 |
| 跨端一致性 | `node contracts/tools/check-client-parity.mjs` | 通过 |
| 后端错误码 | `node backend/scripts/sync-error-codes.mjs --check` | 通过（16 个） |
| 文档链接 | `node scripts/check-doc-links.mjs` | 通过 |
| 浏览器验收 | `node docs/verification/2026-09-19-E04b-inventory/verify-inventory.cjs` | **71 项检查 / 0 失败 / 0 页面错误** |
| 前端 lint | `npm --prefix frontend run lint` | 39 项既有失败（35 error + 4 warning），**本卡新增 0 项**；两个新文件不在报告里 |

浏览器验收的完整报告在 `logs/report.json`，截图为 `screenshots/*.png`（已人工查看）。
视口覆盖 1920×1080 / 1440×1000 / 1366×768 / 1280×800 / 1024×768 / 390×844，六个档位均无横向溢出。

## 5. 已确认成立的行为

- 未登录 → 401；没有任何权限的店员 → 三个入口全 403，且 403 是契约信封（`code=PERMISSION_DENIED`）。
- 只有旧码 `library/view` 的店员读得到库存（契约映射生效），但**写不了期初**（noWidening）。
- 无成本权限时响应里**没有** `totalCostCents` / `costKnown` / `acquisitionCostCents` 这几个键，
  而不是返回 0 或 null 再由前端藏起来；列表成本列随之整列不渲染。
- 未知成本落库是 `NULL` + `costKnown=0`，页面显示「成本未知」，全程不出现 `¥0.00`。
- 期初：数量件按数量、逐件件一行一件且必须有内部编号；同一型号第二次期初被拒（「期初不是日常入库的捷径」）。
- 同 `requestId` 同载荷复用结果、不重复入库；同 ID 改载荷 → 409 `IDEMPOTENCY_MISMATCH`；
  缺 `requestId` 或 `Idempotency-Key` 与 body 不一致 → 400。
- 改商品必须带 `expectedVersion`；版本落后 → 409 `VERSION_CONFLICT`。
- 跨店：别家门店的型号读不到、期初写不进（404 且不在对方门店留任何流水）；猜实物 ID 也是 404。
- 商品建档会同时把分类与品牌链接进 `product_categories` / `product_brands`，
  所以旧「商品管理」页看到的也是同一份分类品牌，不是「未分类 / 无品牌」。
- 单件下钻能看到来源（期初凭据 + 时间）、有效占用与最近流水。
- 全程没有任何请求发往 `huangqidong.cn`。

## 6. 未验证 / 未做（不要当已完成）

- **未接生产**：没有登录生产、没有应用远端迁移、没有部署。远端 0006–0010 是否应用仍未核实。
- **微信真机、小程序端**：本卡完全不涉及；小程序仍是旧店员页，按 Q-06 独立清理。
- **旧「商品管理」页一行未动**：它仍走 `/api/products`（`library/*` 权限），
  `is_salable` / `reference_price_cents` / 分类品牌下拉仍只在那一页维护。
  新页只管契约 Product 模型里的字段（分类、品牌、管理方式、需要 SN、状态、默认售价）。
- **在途与客户保管两件演示实物是直接播表的**：能产生这两种状态的接口属采购到货（B15）与接修（B20），
  本卡没有。它们只影响另列区，不进余额表。
- **采购、到货、盘点、报损、整备上架**：仍无路由，库存只能靠期初与后续卡补齐。
- **导航入口：库存页有，客户页没有。** `/inventory` 由顶栏「库存」进入（`src/app/navigation.ts` L30，实测截图里该项高亮）；
  **`/customers` 至今没有任何界面入口**，只能输地址。E04b 初稿把两者一起记成「都没有入口」，经核实后已更正（OPEN-ITEMS G-21）。
- **视觉未做新设计**：本页沿用既有中性灰白；E01 视觉仍等评审，E03（壳与公共组件、全站换肤）未动。
- **演示样本仍留在仓库**：`frontend/src/features/workbench/demoInventory.ts` 与 `demoInventory.test.ts`
  保留（它把契约 `fixtures.json` 的 V5 样本钉住）。它已不被任何生产代码引用，不进构建产物；
  D-E「演示数据进产物」的收口仍留到营业版本发布前。
- **键盘序列、缩放、对比度**没有做完整验收（V-01 仍在）；本轮只补上了此前完全不生效的焦点轮廓。
- **无权限店员的可视化路径未实测**：403 有后端用例，但浏览器验收只用老板账号跑过。

## 7. 环境说明

- 本地后端只监听 `127.0.0.1`，数据在内存，进程退出即清空；演示数据每次启动重建。
- 前端 dev 的 `/api` 代理默认指向 `http://127.0.0.1:8787`；验收脚本用 8812/5200 并显式传 `VITE_API_TARGET`。
- `actions.json` 里的证据行是 `backend/src/index.ts` 的**绝对行号**：本卡只在入口顶部加了 1 行 import，
  因此 24 条证据行整体 +1；再改入口必须重跑 `validate-contracts.mjs`。
