# MP03 · 固定演示样本与页面 ViewModel

日期：2026-09-23。状态：`review`。

## 结果

- 新增 `miniprogram/features/customer/fixtures.ts`：以固定样本描述门店、商城商品、社区内容和“我的”页计数，日期固定为参考稿日期；样本始终标记 `mode: demo`，不导入 `contracts/v1`。
- 商城价格用整数分；`null` 表示未知/面议，保留与 `0` 的区别。另提供明确 loading、empty、error 样本状态。
- 新增 `miniprogram/typings/customer-view.ts`：仅描述顾客界面展示模型，不冒充 API 契约；真实模式需由服务端数据显式映射。`requireCustomerDemoMode` 拒绝 `live` 模式载入这组样本。
- `tsconfig.json` 将 `components/**/*.ts` 与 `typings/**/*.ts` 纳入现有 strict 检查。

## 实际检查

| 命令 | 结果 |
|---|---|
| `npm --prefix miniprogram test` | 未运行：当前 PowerShell 找不到 `npm` |
| `node --test "miniprogram/tests/*.test.mjs"` | 通过，99/99 |
| `node miniprogram/scripts/check-pages.mjs` | 通过 |
| `node miniprogram/scripts/check-classes.mjs` | 通过 |
| `miniprogram/node_modules/.bin/tsc.cmd -p miniprogram/tsconfig.json --noEmit` | 通过 |
| `node miniprogram/scripts/sync-contracts.mjs --check` | 通过 |
| `node scripts/check-doc-links.mjs` | 通过，208 篇现行 Markdown、494 个本地链接、0 断链 |

## 视觉与范围边界

已实际查看 MP00 锁定的清爽版与字体微调版参考图。未运行微信开发者工具、未取得当前页面截图或 iOS/Android 真机图；当前页面 ViewModel 仍与 MP05–MP15 的视觉页面接线分开，本卡不宣称截图或视觉放行。

## 下一步

MP04 顶部导航与安全区组件已在同一用户请求内继续实施；完成工具截图后复核顶部偏差，再按卡序接续 MP05。
