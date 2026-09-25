# MP05 · 四 Tab 底栏与页面导航

日期：2026-09-23。状态：`review`。

## 结果

- `app.json` 启用 custom tabBar，固定首页、商城、社区、我的顺序；使用顾客资源目录中的黑/灰双态图标，选中黑色 `#111111`，未选中灰色 `#808080`。
- 新增 `custom-tab-bar/`：根据当前页面路由恢复选中态，读取安全区底部高度；重复点击当前 Tab 不重复导航，点击其他 Tab 使用 `switchTab`。
- 新增 `features/customer/routes.ts`：顾客 Tab 状态和商城分类状态与 URL 分离；详情仅允许 `packages/customer/` 并通过 `navigateTo`，旧店员页面不会被路由助手开放。
- 商城 `onShow` 消费一次性分类状态；`check-pages.mjs` 校验 custom 配置、四项名称/路由顺序、主包页面、底栏文件及图标资源。

## 实际检查

本机 PowerShell 没有 `npm` 命令；用本地 Node 与 TypeScript CLI 跑等价命令：

| 命令 | 结果 |
|---|---|
| `npm --prefix miniprogram test` | 未运行：`npm` 不在 PATH |
| `node --test "miniprogram/tests/*.test.mjs"` | 105/105 通过 |
| `node miniprogram/scripts/check-pages.mjs` | 通过，含 tab 顺序、图标及 custom-tab-bar 文件检查 |
| `node miniprogram/scripts/check-classes.mjs` | 通过 |
| `miniprogram/node_modules/.bin/tsc.cmd -p miniprogram/tsconfig.json --noEmit` | 通过 |
| `node miniprogram/scripts/sync-contracts.mjs --check` | 通过 |

## 未验证与下一步

代码未在微信开发者工具运行，本机当前没有工具窗口；因此四 Tab 循环、详情返回、真实安全区与底部内容避让没有原生截图证据。状态保持 review。下一步在微信开发者工具检查四 Tab 切换、重复点击、分类恢复、详情返回及底部最后一项可滚出底栏，再处理页面还原卡 MP07。
