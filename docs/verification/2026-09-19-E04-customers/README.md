# E02/E04 · 客户主数据与隔离预览环境验证

日期：2026-09-19。范围：客户台账从「订单聚合只读」升级为受权限保护的真实客户主数据；同时补上不触生产的本地隔离后端（E02 的前置），并清掉契约 C-01 的存量失败。

本目录属于**本地实现 + 本地验收**，不是生产登录结果，也不是微信真机验收。

## 1. 入口与命令

| 用途 | 命令（仓库根） |
|---|---|
| 起隔离后端（miniflare + 真实 Worker + 内存 D1 + 演示数据） | `npm --prefix backend run dev:local` |
| 起网页端（`/api` 自动代理到上面的本地后端） | `npm --prefix frontend run dev` |
| 浏览器验收（自动起前后端、走真实登录、出截图与报告） | `node docs/verification/2026-09-19-E04-customers/verify-customers.cjs` |
| 后端客户接口测试 | `node --test backend/tests/e04-customers.test.mjs` |
| 前端客户页测试 | `npx --prefix frontend vitest run src/components/CustomersPage.test.tsx` |

演示账号：`owner@local.test` / `local-preview-pass`（只存在于内存，进程退出即消失）。

## 2. 改了什么

| 文件 | 改动 |
|---|---|
| `backend/migrations/0010_customers.sql` | 表级 `UNIQUE(store_id, phone)` → 部分唯一索引 `WHERE phone <> ''` |
| `backend/src/index.ts` | 客户设备增删改路由；详情补 orderCount/totalCents/receivedCents；空手机号不做订单归属；重复手机号返回 409 与可照做提示；改不存在的客户返回 404 |
| `backend/tests/e04-customers.test.mjs` | 新增 12 个用例（真实 Worker 入口 + 真实 D1） |
| `backend/tests/lib/worker.mjs` | 新增：把 `src/index.ts` 打包进 miniflare 跑的夹具，测试与本地预览共用 |
| `backend/scripts/dev-server.mjs` | 新增：本地隔离后端 + 演示数据 |
| `frontend/src/utils/api.ts` | 客户主数据接口与类型 |
| `frontend/src/components/CustomersPage.tsx` | 重写：真实数据 + 建档/编辑 + 设备登记/改/删 + 列表/详情分离 |
| `frontend/src/styles/customers.css` | 补表单、设备列表、提示等样式 |
| `frontend/vite.config.ts` | dev 的 `/api` 默认打到本地后端，不再默认指向生产 |
| `contracts/v1/*` | 登记 8 张新表；重算 21 条失效证据行；缺口引文随行号修正 |

### 2.1 三个必须记住的缺陷（都是实测发现的，不是推测）

1. **空手机号散客插不进去**（0010 原样）。
   表级 `UNIQUE(store_id, phone)` 把「同店两条空串」判为重复，而契约 Customer 规则写明「散客允许最少信息」。
   实测：第二个 `phone=''` 的客户直接撞 `UNIQUE constraint failed`。改为 `WHERE phone <> ''` 的部分唯一索引。

2. **空手机号会吞掉别人的无电话订单**。
   原列表 SQL 用 `o.customer_phone = c.phone` 关联订单，空串会匹配到全部无电话订单 ——
   不给手机号的散客会凭空多出一堆别人的单。现加 `phone <> ''` 前置：没有手机号就不做订单归属。

3. **详情页累计金额显示 `¥NaN`**。
   详情接口只返回客户列，没有 `orderCount / totalCents`，而类型继承自列表项 —— 前端拿到 `undefined`。
   这条是浏览器验收的**截图**发现的，第一次跑验收时 33 项全绿却没照出来（当时断言的是整页文本，订单行里本来就有那个金额）。
   现已改为断言 `.customer-total` 区块本身，并加「不出现 NaN」一条。

### 2.2 顺手修掉的两个静默问题

- **DELETE 设备返回 400**：删设备走进了带 `req.json()` 的分支，空 body 让它抛错。已把 DELETE 提到解析之前。
- **秒级同时间戳排序不稳**：`ORDER BY updated_at DESC` 在 `datetime('now')` 同秒时不保证顺序，补 `id DESC`。

## 3. 实跑证据

| 检查 | 命令 | 结果 |
|---|---|---|
| 后端测试 | `npm --prefix backend test` | **99 通过 / 0 失败**（本卡新增 12 个；此前记录为 87） |
| 前端测试 | `npm --prefix frontend test` | **12 文件 131 用例通过**（本卡新增 1 文件 10 用例；此前 11 文件 120 用例） |
| 前端构建 | `npm --prefix frontend run build` | 通过（`tsc -b` + vite build） |
| 契约校验 | `node contracts/tools/validate-contracts.mjs` | **通过 3233 项 / 失败 0 项**（改动前为 29 项失败；历史记录 C-01 为 23 项失败） |
| 契约生成物 | `node contracts/tools/generate-dto.mjs --check`、`node frontend/scripts/sync-contracts.mjs --check` | 通过 |
| 跨端一致性 | `node contracts/tools/check-client-parity.mjs` | 通过 |
| 后端错误码 | `node backend/scripts/sync-error-codes.mjs --check` | 通过（16 个） |
| 文档链接 | `node scripts/check-doc-links.mjs` | 通过（25 入口 / 143 链接 / 0 断链） |
| 浏览器验收 | `node docs/verification/2026-09-19-E04-customers/verify-customers.cjs` | **35 项检查 / 0 失败 / 0 页面错误** |
| 前端 lint | `npm --prefix frontend run lint` | 39 项既有失败（35 error + 4 warning），**本卡新增 0 项**；本卡文件已不在报告里 |

浏览器验收的完整报告在 `logs/report.json`，截图为 `screenshots/*.png`。
视口覆盖 1920×1080 / 1440×1000 / 1366×768 / 1280×800 / 1024×768 / 390×844，六个档位均无横向溢出。

验收脚本里有一条硬边界：`page.on('request')` 收集实际请求主机，断言**全程没有任何请求发往 `huangqidong.cn`**。

## 4. 已确认成立的行为

- 未登录 → 401；已登录但无权限的店员 → 403（读与写都挡）。
- 同店重复手机号 → 409 且提示「该手机号已有客户档案，请直接搜索该号码」；不同门店用同一号码各自成立。
- 猜别家门店的客户 ID 读、改、挂设备一律 404，且确认**没有落库**（不是「报了错但写进去了」）。
- 无手机号的散客订单数 0、累计 ¥0.00、详情不带订单；有手机号的按号码聚合。
- 设备增 / 改 / 删走真实接口，删完确实消失，删第二次 404。
- 保存失败时已填内容保留（前端）。
- 归档的客户不出现在列表，但按 ID 仍查得到（归档 ≠ 删除）。

## 5. 未验证 / 未做（不要当已完成）

- **未接生产**：没有登录生产、没有应用远端迁移、没有部署。远端 0006–0010 是否应用仍未核实。
- **微信真机、小程序端**：本卡完全不涉及。
- **客户独立权限码**：客户接口目前复用 `quote/view` / `quote/edit`。这已如实写进 `actions.json` 的 `actuallyGuards`，但权限码归属（D-C）仍未裁定。
- **导航可见性**：`/customers` 在侧栏 `ERP_NAV_ITEMS` 里有条目（描述文案已更新），但实际壳层用的是顶部导航，本次没有为新客户页加入口，也没有做入口权限判断。
- **登录页文案**仍是旧的「电脑报价方案 / 登录以同步云端硬件库」，与本产品定位不符，属壳层（E03）。
- **视觉未做新设计**：本页沿用原有中性灰白，**没有**套用 E01 原型的新视觉。全站换肤是 E03，要等 E01 评审。
- **客户设备 ≠ 契约 CustomerDevice**：`customer_devices` 只有 label/serial/remark，不含 custodyLocation、stockItemRef 等保管字段，**不进库存账**。送修与客供件的保管归属在 E10。
- **报价与客户未打通**：`quote_headers.customer_id` 仍无外键，也没有界面可以给报价选客户（E05）。
- 键盘可达、对比度、缩放未做完整验收（V-01 仍在）。

## 6. 环境说明

- 本地后端只监听 `127.0.0.1`，数据在内存，进程退出即清空；每次启动重建演示数据。
- 前端 dev 的 `/api` 代理默认指向 `http://127.0.0.1:8787`。要连别的环境用 `VITE_API_TARGET` 显式指定，且指向非本地地址时启动会打印警告。
- 为让 Vite 重建依赖缓存（配置已改），`frontend/node_modules/.vite` 被改名为 `.vite.bak-20260919`；这是可再生缓存，保留一份仅为可逆。
