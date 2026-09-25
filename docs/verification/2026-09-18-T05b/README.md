# T05b · 库存界面（网页表格 / 逐件视图，小程序搜索 / 实物页）

日期：2026-09-18。状态：**本地通过**（两端界面已实现并各有测试；**演示数据源，未接真实后端**）。

任务卡：[05-implementation-tasks.md](../../plans/2026-09-17-web-wechat-plan/05-implementation-tasks.md) T05b。
前置：[2026-09-18-T05a](../2026-09-18-T05a/README.md)（约束）、[2026-09-18-T03b](../2026-09-18-T03b/README.md)（请求层铁律）。
同批：[2026-09-18-T05c](../2026-09-18-T05c/README.md)（契约 V5 样本，本卡演示数据的唯一来源）。

---

## 1 · 这张卡做了什么

**让库存第一次能被看见，并且看得不骗人。** 网页端是一张能点开数量看构成的表格，小程序端是以搜索为主的卡片列表加实物详情页。三条口径是硬要求，也是本卡的全部难点：

1. **在途与客户保管不能混进三桶**（03 §4 L84）—— 不是"记得别加"，而是页面上单列、并写明不计入在库；
2. **未知成本不能写成 ¥0.00**（03 §1 R01）；
3. **没有成本权限时，成本字段根本不出现**（04 §3 L57），不是置空。

---

## 2 · 实际改动

### 2.1 网页端

| 文件 | 状态 | 职责 |
|---|---|---|
| `frontend/src/features/workbench/inventory-view.ts` | 新增 | 库存显示口径（标签表、三桶计算、成本文案、搜索筛选、行装配）。只含 `import type`，可被门禁直接加载 |
| `frontend/src/features/workbench/demoInventory.ts` | 新增 | 契约 V5 的端内副本（4 商品 / 6 实物 / 4 余额 / 8 流水 / 1 在途） |
| `frontend/src/features/workbench/WorkbenchInventoryPage.tsx` | 新增 | 库存表格：搜索、可用性 / 成色筛选、点行展开构成、成本按权限开关 |
| `frontend/src/features/workbench/inventory-view.test.ts` | 新增 | 口径单测（三桶、成本、搜索、标签覆盖） |
| `frontend/src/features/workbench/demoInventory.test.ts` | 新增 | 端内样本逐字段钉回契约 V5，并机械重算数量守恒 |
| `frontend/src/features/workbench/WorkbenchInventoryPage.test.tsx` | 新增 | 渲染测试：成本列有无、未知成本文案、展开构成、搜索空态 |
| `frontend/src/styles/workbench.css` | 修改 | 追加 `wb-inv-*` 样式（纯追加，未改既有类） |
| `frontend/src/App.tsx` | 修改 | `/inventory` 指向新库存页；旧「商品与库存」页改挂 `/inventory/products`，**不删除入口** |

### 2.2 小程序端

| 文件 | 状态 | 职责 |
|---|---|---|
| `miniprogram/features/inventory-view.ts` | 新增 | 网页端口径模块的端内副本，导出物逐项一致（门禁保证） |
| `miniprogram/features/demo-inventory.ts` | 新增 | 契约 V5 的端内副本 |
| `miniprogram/pages/inventory/index.{ts,wxml,wxss}` | 修改 | 从占位说明页改为搜索为主的卡片列表（可卖 / 已订 / 待处理 + 在途客户保管单列） |
| `miniprogram/packages/inventory/item-detail/index.*` | 新增 | 实物 / 型号详情：来源、状态、成本权限、去向、流水 |
| `miniprogram/tests/inventory-view.test.mjs`、`demo-inventory.test.mjs` | 新增 | 口径单测与契约一致性 |
| `miniprogram/app.json` | 修改 | 分包加入 `packages/inventory` |

### 2.3 门禁

| 文件 | 状态 | 职责 |
|---|---|---|
| `contracts/tools/check-client-parity.mjs` | 修改 | 新增「库存显示口径」一节：8 张标签表逐项比对 + 4 个函数同输入实跑 + **用契约 V5 作输入实跑两端** + 6 条三桶 / 成本语义断言 |

---

## 3 · 关键设计决策（后续卡必须遵守）

### 3.1 口径模块两端各一份，但由门禁钉死

库存的桶 / 成色 / 所有权标签若两端各写一遍，漂移不会报错、只会让人看错账 —— 这正是 T-10（金额方向反转）的教训。故两端各有一份 `inventory-view.ts`，由 `check-client-parity.mjs` 逐项 `deepEqual`，并用**契约 V5 的同一份数据**分别喂给两端函数、比对输出。

已实测：两端文件除注释与 import 路径外**逐字一致**（`diff` 验证）。

### 3.2 成本「整列消失」而不是置空

`costCellText(cents, costKnown, canViewCost)` 在无权限时返回 `null`，调用方据此**不渲染该列**。测试直接断言这一点：点「隐藏成本」后页面上既没有 `¥2,860.00` 也没有「成本未知」。

### 3.3 不画库龄列

02 §5 把「库龄」列为库存页必要字段，但契约 `StockItem` / `StockBalance` / `InventoryMovement` **都没有入库时间字段**。T05c 曾尝试在样本里加 `acquiredAt`，因违反「样本不得发明契约外字段」已移除，并登记为 **G-18**。

与其编一个天数，不如留到有数据支撑时再画。**两端库存表都不画库龄列。**

### 3.4 不放点不动的假按钮

入库 / 盘点属 T06，本卡两端都不出现这些入口。小程序搜索框是真的能筛（本地过滤演示数据）。

### 3.5 旧商品管理页没有消失

`/inventory` 换成新库存页后，旧 `ProductManagementPage` 改挂 `/inventory/products`，不是删除 —— 它是已确认功能，不能因为重建而失去入口。

---

## 4 · 验证证据

| 检查 | 命令 | 结果 |
|---|---|---|
| 后端集成（真实 workerd + 真实 D1） | `npm --prefix backend test` | ✅ **58 / 58**（未受影响） |
| 前端单测 | `npm --prefix frontend run test` | ✅ **117 / 117**（11 文件；T03b 时为 91 / 8 文件） |
| 小程序单测 | `npm --prefix miniprogram test` | ✅ **92 / 92**（8 文件；T03b 时为 67 / 6 文件） |
| 契约自洽 | `node contracts/tools/validate-contracts.mjs` | ✅ 退出码 0，**3182 项** |
| 跨端一致性门禁 | `node contracts/tools/check-client-parity.mjs` | ✅ **53 项通过**（原 31 项打印 + 库存口径 22 项） |
| 网页端生成物防漂移 | `node frontend/scripts/sync-contracts.mjs --check` | ✅ 6 个文件一致 |
| 小程序端生成物防漂移 | `node miniprogram/scripts/sync-contracts.mjs --check` | ✅ 6 个文件一致 |
| 后端错误码防漂移 | `node backend/scripts/sync-error-codes.mjs --check` | ✅ 16 个错误码一致 |
| 前端类型检查 + 构建 | `npm --prefix frontend run build` | ✅ `tsc -b` + vite build 通过 |
| 小程序类型检查 | `npm --prefix miniprogram run typecheck` | ✅ `tsc --noEmit` 0 错误 |
| 小程序页面注册自检 | `npm --prefix miniprogram run check-pages` | ✅ 分包 2 个（含新的 `packages/inventory/item-detail`） |
| 小程序类名自检 | `npm --prefix miniprogram run check-classes` | ✅ 全部 wxml 类有定义（本卡修掉 7 个漏定义的类） |
| 新文件 lint | `npx eslint <6 个新文件>` | ✅ 0 错误 |

**未运行**（不得当成通过）：微信开发者工具编译、真机 / iOS / Android、浏览器视觉验收（U01 尺寸 / U02 缩放 / U05 键盘）、颜色对比度实测、lint 全仓（既有失败未跑未修）。

---

## 5 · 未完成 / 阻断

| 项 | 说明 |
|---|---|
| **仍是演示数据源** | 两端界面全部读 `demoInventory` / `demo-inventory`，**没有接后端**。B12 / B13 的 HTTP 路由仍未暴露（等 T03a 鉴权）。接真实服务时必须走 `createWebApiClient` / `createMiniProgramApiClient`，不得自己拼 fetch / wx.request（T03b 铁律） |
| **D-E 仍未解决：演示样本进了生产构建产物** | 实测 `frontend/dist/assets/index-CA0IEvvr.js` 含 `DEMO-PRODUCT-GPU`（9 处）。本卡新增的 `demoInventory.ts` 与既有 `demoData.ts` 同样在生产包里。**在此项裁定前，本卡产物不得当可用版本发布** |
| **G-18 库龄缺口** | 见 §3.3，库存表没有库龄列 |
| **P07 的 `:id` 语义** | 02 §2 写 P07 实物详情为 `/inventory/items/:id`。本卡小程序详情页**同时支持两种入口**：列表点开传 `productRef`（看该型号全部实物与去向），也支持 `stockItemId` 直达某一件（反查型号）。`:id` 究竟指型号还是实物，留给 T06 扫码入库场景收口 |
| **G-12 已裁定** | SN 不单列导航：SN 在实物详情与网页展开的逐件构成里显示 |
| 微信开发者工具编译 | 未跑；`preview` 不产出截图，真机观感仍未被任何人看过 |

---

## 6 · 下一步

1. **T03a**（后端绑定码 / 微信身份交换）—— 界面接真实数据的前置。⚠️ 新增 OPEN-ITEMS **T-11**：后端域名能否进 request 白名单取决于 **ICP 备案**，比 AppSecret 更硬。
2. 库存界面接线：演示数据换成 `createWebApiClient` / `createMiniProgramApiClient`，并删除端内演示文件（受 D-E 约束）。
3. 补 G-18 后画库龄列。
4. 待裁定：**D-E**（演示样本进生产包）、**G-18** 的补法、**C-2**（`specs` 数组 / 字符串冲突）。
