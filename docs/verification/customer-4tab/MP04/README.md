# MP04 · 顶部导航与安全区组件

日期：2026-09-23。状态：`review`。

## 结果

- 新增 `miniprogram/components/customer-nav/`：支持标题、门店行、可选返回按钮、辅助动作 slot，以及“我的”二维码/设置入口。
- `miniprogram/features/customer/layout.ts` 读取窗口状态栏与微信胶囊的屏幕坐标，计算导航区高度和胶囊右侧保留空间。微信 `ClientRect.right` 按窗口内 x 坐标处理，再用 `windowWidth - right` 得到屏幕右边距；字段缺失、非正数、超出窗口或与状态栏冲突时用固定值回退。
- 四个顾客 Tab 配置自定义导航并注册组件；返回动作仅在有上级页面时返回，配置 fallback 时使用 Tab 跳转。导航没有绘制状态栏或伪胶囊。
- 首页、商城、社区、我的页面均已挂载组件；门店名长时单行截断，右侧给系统胶囊留出屏幕坐标对应的避让空间。
- “我的”右上动作保留至少 44px 点击区，并整体放在胶囊左侧；概念稿将二维码/设置画在右上，实际微信胶囊会造成位置差异，需在截图中记录最终偏移。
- `check-classes.mjs` 现在解析本地 WXSS `@import`，组件和页面均正常参与类名检查，没有通过忽略类名绕过检查。

## API 与检查

实现依据为项目安装的 `miniprogram-api-typings` 声明中 `wx.getWindowInfo()`（基础库要求 2.20.1）及 `wx.getMenuButtonBoundingClientRect()`（2.1.0）；运行时仍先检查 API 是否可用，并验证返回值后回退。浏览器工具未能打开微信官方文档页面，本回执不把第三方搜索结果当作官方核验。

| 命令 | 结果 |
|---|---|
| `npm --prefix miniprogram test` | 未运行：当前 PowerShell 找不到 `npm` |
| `node --test "miniprogram/tests/*.test.mjs"` | 通过，99/99 |
| `node miniprogram/scripts/check-pages.mjs` | 通过 |
| `node miniprogram/scripts/check-classes.mjs` | 通过，含局部 WXSS import |
| `miniprogram/node_modules/.bin/tsc.cmd -p miniprogram/tsconfig.json --noEmit` | 通过 |
| `node miniprogram/scripts/sync-contracts.mjs --check` | 通过 |
| `node scripts/check-doc-links.mjs` | 通过，208 篇现行 Markdown、494 个本地链接、0 断链 |

## 视觉与范围边界

已实际查看 MP00 两张参考图。当前桌面会话未检测到微信开发者工具窗口（UI 库存无已打开应用），因此未取得工具截图或 iOS/Android 真机图；导航高度和胶囊避让只有纯函数边界测试，没有原生布局验收。状态为 `review`，截图前不能标 verified。

本轮没有改 `contracts/v1`、迁移或后端入口；自定义导航仅接入四个顾客页，旧店员页面配置不变。

## 下一步

在微信开发者工具运行四个 Tab，留存顶部安全区/胶囊截图，重点复核长门店名、“我的”双辅助动作和返回按钮，再决定 MP04 是否放行。
