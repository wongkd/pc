# MP02 · 顾客专用视觉令牌

日期：2026-09-23。状态：`review`。

## 结果

新增 [customer-tokens.wxss](../../../../miniprogram/styles/customer-tokens.wxss)，并由 [app.wxss](../../../../miniprogram/app.wxss) 在首行导入。令牌严格来自 MP00：白页底、`#111111` 主文字、`#808080` 辅助文字、`#E5E5E5` 细线、`#F8F0DC` 档案卡；375 宽起始字号为 21/15/12.5/11.5px（42/30/25/23rpx），常规 400、强调 500，视觉圆角 2–4px。

新变量与基类一律使用 `customer-` 前缀，旧 `--mp-*` 变量和旧员工页样式未删除、未改值。后续四页只需在根节点采用 `customer-page`，即可使用统一的内容边距、标题、辅助字、细线、档案卡、图片、触控和等宽金额基类；本卡不改页面结构、路由、数据或任何共享契约。

## 实际检查

PowerShell 无法使用本项目的 `npm`，因此按项目等价脚本实际运行：

| 命令 | 结果 |
|---|---|
| `node --test "miniprogram/tests/*.test.mjs"` | 92/92 通过 |
| `node miniprogram/scripts/check-pages.mjs` | 通过 |
| `node miniprogram/scripts/check-classes.mjs` | 通过 |
| `miniprogram/node_modules/.bin/tsc.cmd -p miniprogram/tsconfig.json --noEmit` | 通过 |
| `node miniprogram/scripts/sync-contracts.mjs --check` | 通过 |
| `node scripts/check-doc-links.mjs` | 通过：196 个 Markdown、489 个本地链接、0 断链 |

## 未验证与下一步

没有运行微信开发者工具，也没有小程序页面截图；本卡只证明静态令牌可编译、现有结构/类/类型/契约检查未受破坏，不证明 iOS/Android 的系统字体回退、胶囊/安全区或视觉还原。下一步为 MP03 顾客基础组件；MP04 才应在微信开发者工具以截图复测实际字号和间距。
