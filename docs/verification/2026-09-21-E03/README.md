# E03 · 界面换肤收尾 · 验证记录

日期：2026-09-21。范围：把订单 / 商品 / SN 台账 / 系统设置 / 模块占位五类页面并入 E03 彩色视觉层；
旧报价编辑器与顾客打印**零改动**。上一卡：[E05b 报价确认态](../2026-09-19-E05b-confirm/README.md)。

## 背景：为什么要做这一刀

`frontend/src/styles/erp-polish.css` 首行已声明「沿用 erp-core/v2 的彩色设计」，并已在 `App.tsx` 加载；
但它此前只覆盖工作台、库存、客户、报价编辑器与登录卡——选择器全部带 `wb-` 前缀或限定 `.customers-page`。
其余页面用各自独立的类前缀，**根本不在它的作用域内**：

| 页面 | 类前缀 | 改动前状态 |
|---|---|---|
| 订单列表 / 订单详情 | `orders-`、`order-`、`todo-` | 走 index.css 的旧中性灰白 |
| 商品管理（旧页） | `product-` | 走 index.css 的旧中性灰白 |
| SN 台账 | `sn-` | **任何 CSS 文件里都没有定义**，裸样式 |
| 系统设置 | `settings-`、`role-` | 走 index.css 的旧中性灰白 |
| 模块占位页 | `module-placeholder` | **无定义**，裸样式 |

同时 `STATUS.md`、`OPEN-ITEMS.md`（E03-视觉 条目）、`NEXT-SESSION-PROMPT.md` 仍写着
「客户页与库存页沿用原有中性灰白、E03 评审前不动手」，与代码实际不符；`docs/verification/` 下也没有 E03 记录。
本轮一并纠正（见「文档订正」一节）。

## 改动清单

| 层 | 文件 | 内容 |
|---|---|---|
| 样式 | `frontend/src/styles/erp-polish.css` | 追加 185 行（173 → 358 行），把五类页面接到同一套彩色视觉 |
| 前端 | `frontend/src/components/SerialNumberPage.tsx` | 1 行：`{contextOrderItemId && …}` → `{contextOrderItemId > 0 && …}` |
| 验收 | `verify-e03.cjs` | 浏览器验收 27 项；产出 `verification.json` 与 `screenshots/` 13 张 |

### 样式口径

- **按页面作用域补齐，不改全局 `.btn`**：规则一律写成
  `.app-shell :is(.orders-page, .product-page, .sn-page, .settings-page) .btn` 或单页面前缀。
  报价编辑器不在这些作用域内，其蓝绿渐变主按钮与胶囊圆角原样保留（Q01 裁定：旧报价编辑器保留不动）。
  验收脚本对此有专门回归断言。
- 彩色块沿用 erp-core/v2 的一组分色：薄荷 `#d4e9df`、浅蓝 `#dce6f4`、浅杏 `#f4dfc4`、浅紫 `#e0d9f2`；
  工作台指标卡用更深一档的 `#ceeadf` / `#f6dbbd` / `#ddd6f4` / `#efd5de`。
- 主按钮取 `var(--wb-ink)`（#242939）；白卡统一 `border-radius: 20px` + `var(--erp-shadow)`；
  表头 `#f9fafc`，行分隔 `#edf0f4`。
- **SN 台账与占位页此前完全没有样式**，本轮是补基础版式再套彩色，不是改配色。
- 响应式：900px 断点内把页面头、摘要格、详情两栏、表单格、角色行降为单列。

## 与 v2 原型的关系（2026-09-21 补记，重要）

栋哥当天追问「这些模块是不是都基于 V2 开发的」，逐项核实后的结论（**先前记录漏了这一段**）：

- `v2/app.js` 第 8 行的页面表**只有四屏**：
  `titles = { workbench:'工作台', quote:'报价编辑', order:'订单详情', inventory:'库存' }`；
  加上 E01b 的 `售后维修` / `回收拆件` 两个独立原型，**整个原型体系一共 6 屏**。
- 本轮补齐的五类页面里，**只有订单页（`/orders`、`/orders/:id`）在 v2 里有对应画面**。
  **商品管理、SN 台账、系统设置、模块占位这四类在 v2 里没有稿** ——
  它们是按 v2 的**色板与面板尺度推导**的（`#d4e9df` / `#dce6f4` / `#f4dfc4` / `#e0d9f2`、20px 圆角、28px 标题、`#f9fafc` 表头），
  **不是照稿搬**。
- ⇒ 这两类性质不同，**不要把「推导」记成「对齐了 v2」**。
- 生产前端从来不是 v2 的像素级复刻：v2 是静态演示原型（CSP `connect-src 'none'`，按钮只改内存），
  E03 的定位是「把 v2 的**视觉语言**变成 React 公共组件」，布局按业务需要走。
- 栋哥裁定（2026-09-21）：**这四屏的视觉稿他之后另找人画；先写功能代码**。
  在那之前**不要为了「更贴近 v2」去大改这四屏的样式**。

### 顺手排除的两个假警报

扫描「引用了但未定义的 `--wb-*` 变量」时报出 3 个，逐个核实后**都不是问题**，未做改动：

- `--wb-motion-press` / `--wb-motion-out`：`motion.css` 自己就在 `.app-shell` 里定义了它们；
- `--wb-warning-border`：`workbench.css` 用的是 `var(--wb-warning-border, var(--wb-line))`，**带回退值**，
  不会触发 P-32 那种「整条声明被丢弃」。

## 实跑结果（2026-09-21）

| 检查 | 结果 |
|---|---|
| `npm --prefix frontend test` | **13 文件 152 用例通过 / 0 失败**（与 E05b 基线一致；本轮未新增用例） |
| `npm --prefix frontend run build` | 通过（CSS 无语法错误） |
| `npm --prefix frontend run lint` | **39 项（35 error + 4 warning）与基线一字不差，本轮新增 0** |
| `npm --prefix backend test` | **172 通过 / 0 失败**（本轮未改后端，跑一遍确认无回归） |
| 浏览器验收 `verify-e03.cjs` | **27 / 27 通过**，13 张截图已**实际查看** |

截图：`01-login`、`02-workbench-regression`、`03-orders-list`、`04-order-detail`、`05-products`、`06-sn`、
`07-settings`、`08-placeholder`、`09-quote-editor-regression`，以及 `10`~`13` 窄屏 390 四张。

### 看图发现并修掉的问题

- **SN 台账页渲染出游离的「0」**：`{contextOrderItemId && …}` 在 `contextOrderItemId` 为 0 时返回数字 0，
  React 会把 0 渲染成文本节点。这是既有缺陷，此前页面没有样式所以不显眼，加版式后暴露在页面左上角。
  已改为 `> 0` 判断，并加了专门断言（`SN 页不渲染游离的「0」`）。
- 订单详情「配置明细」是空表，原因是**演示数据没有 order_items**，不是样式问题；本轮未伪造数据填补。

## 文档订正

- 新建本目录与 `verify-e03.cjs`（此前 E03 无验证记录）。
- `STATUS.md`：本地实现事实表补一行「新版视觉（E03）」，并去掉「客户页库存页刻意保持灰白」的旧表述。
- `OPEN-ITEMS.md`：E03-视觉 条目改为「已落地」并降级为 D-D 的收尾口径。
- `NEXT-SESSION-PROMPT.md`：把「E03 评审前不要动手」替换为 E03 现状与剩余缺口。

## 未验证 / 留给后续

- **顾客端与微信真机未验收**：本轮只覆盖网页 ERP 的本地预览。
- **旧商品管理页职责边界未裁定**（G-20）：只统一了视觉，`/inventory/products` 与 `/inventory` 并存的问题照旧。
- **客户台账仍无顶栏入口**（G-21）、**导航与占位路由重复**（D-D）未处理。
- **键盘完整路径与对比度**（V-01）仍未走一遍；本轮只做了 1440 / 390 两个尺寸的视觉检查。
- 未提交、未部署、未应用任何远端迁移。
