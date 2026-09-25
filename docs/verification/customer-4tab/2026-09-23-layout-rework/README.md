# 小程序排版重做 · 当前接续入口

日期：2026-09-23。状态：**本地实现及部分原生模拟器检查完成，视觉未放行**。用户要求先保存断点，下个对话继续。

## 目标与已确认方向

用户反馈排版与效果图差别很大。继续还原已确认的清爽版布局/图片与细字体版字重，不重新设计。
唯一图片基准：[清爽版](../../../design/2026-09-22-customer-ip/four-tab-board-clean.png)、[细字体版](../../../design/2026-09-22-customer-ip/four-tab-board-font-only.png)。尺寸参考：[MP00 测量](../MP00/visual-baseline.json)。图片为 1536×1024 四屏概念画板，每屏约 355×954，不能当作一张手机截图缩放。

## 已完成，不要重复实现

- 底栏返回首页及高亮滞后已修复：各页 onShow 同步；底栏点击直接 switchTab，不能恢复用旧 selected 拦截点击。
- 首页：测出字标 PNG 墨迹边界 `(199,78)-(736,247)`，用 WXSS 容器裁掉透明留白；双猫同样修正透明边距；调整字标左对齐、主图比例、服务入口和横幅间距。
- 商城：主标题分两行、按钮 size=mini 并明确宽度，黑色可见按钮与透明触控区分开；商品图改 1.42 横向容器/aspectFit，价格与动作并排；演示金额纠正为 7999/5299/4799/1699 元（整数分保存）。
- 社区：改用 features/customer/fixtures.ts 的固定短文案，日期移到底部，默认两个案例加一条知识；三种布局比例 1.407/2.39/1.39；知识与公告仍可筛选。
- 我的：档案卡、统计、菜单和留白按稿调整；去查看移至卡片右下；换行不用 br；辅助入口改用导航内建 mine-actions，保留未登录和未知记录横线。
- 公共：四页明确高度、滚动与底栏安全区；尺寸直接用 rpx，避免变量中的 rpx/组件变量作用域造成实际字号回退；颜色变量在组件根定义。customer-image 依据源图宽高及焦点计算尺寸/偏移，不再仅依赖 object-position；换图重置裁切状态。tsconfig 加入 custom-tab-bar，原先类型检查遗漏该目录。

## 源码定位（只读本次涉及部分）

| 范围 | 文件 |
|---|---|
| 页面布局 | miniprogram/pages/{home,shop,community,mine}/index.wxml、index.wxss；社区 index.ts |
| 图片裁切 | miniprogram/components/customer-image/{index.ts,index.wxml,index.wxss,view.ts} |
| 字号/底栏/导航 | miniprogram/styles/customer-tokens.wxss、custom-tab-bar/index.wxss、components/customer-nav/index.wxss |
| 样本/验证 | miniprogram/features/customer/fixtures.ts、tests/customer-components.test.mjs、tests/customer-community-mine.test.mjs、tsconfig.json |

库内大量既有未提交改动；不要以 HEAD diff 作为本次独占改动。15 个初始文件备份在 `.validation-customer-layout/before/`，只作比对，不直接覆盖现文件。期间存在其他续接改动，操作前看时间戳和局部现状。未提交、未发布。

## 已实际验证

- `node --test "miniprogram/tests/*.test.mjs"`：113/113；包括新增裁切比例/焦点边界回归。
- 项目内 `tsc.cmd -p miniprogram/tsconfig.json --noEmit`、check-pages、check-classes、sync-contracts --check 通过。
- 微信开发者工具 **Stable 2.02.2608060** 确实可绑定，窗口名 `pc-quote-miniprogram`。通过 computer-use 的 node_repl + @oai/sky 检查原生界面；旧 MP15“没有可绑定窗口”已经过时。
- 390 宽（iPhone 12/13 Pro）：四页已看；首页横幅、社区知识卡滚动可完整显示；社区公告空态为白底；Tab 页面/图标对应。
- 320 宽（iPhone 5）：首页、商城商品列表及我的已看；四商品价格和按钮并排不溢出；我的设置点击显示真实“尚未接入”说明。
- 430 宽（iPhone 14 Pro Max）：仅首页和商城已看。
- 375 尚未看；320 社区、430 社区/我的以及完整尺寸矩阵未做。没有本轮 iOS/Android 真机证据、50% 叠加或达标偏差表，不能写视觉验收通过。

## 原生截图证据

截图均为原始工具窗口截图，含模拟器；没有伪造手机截图。无尺寸后缀者为 390 宽：

- [首页](screenshots/home-native.png)、[首页底部](screenshots/home-bottom-native.png)、[商城](screenshots/shop-native.png)、[社区](screenshots/community-native.png)、[社区底部](screenshots/community-bottom-native.png)、[社区空态](screenshots/community-empty-native.png)、[我的](screenshots/mine-native.png)。
- [320 首页](screenshots/home-320-native.png)、[320 商品列表底部](screenshots/shop-320-bottom-native.png)、[320 我的](screenshots/mine-320-native.png)、[320 设置点击](screenshots/mine-320-action-native.png)。
- [430 首页](screenshots/home-430-native.png)、[430 商城](screenshots/shop-430-native.png)。

## 剩余差异与下一动作

1. **先看上述四张 390 截图及两张效果图**，量化业务区偏差。图库的照片/猫是独立生成素材，与画板原图内容仍不同；不要把调整裁切说成素材完全一致。首页横幅照片、商城猫造型、社区照片/猫位置和我的头像仍有差异。
2. 原稿画板纵横比比实际 iPhone 更长，现实现保留图片比例，短屏需滚动，首页横幅/商城第二排在首屏下方。这一点需按同宽内容比较，不整体 transform 缩屏；重点确认是否还需压缩无依据的留白。
3. 核对首页服务图标仍为灰色（效果图接近黑色）、商城主图构图、社区第一图与猫角标、我的辅助按钮胶囊避让。仅改有证据的差异。
4. 补 375 四页与缺失尺寸的关键检查；保存截图，做业务区并排/叠加与偏差表。每次编辑会热编译并回首页，观察稳定画面后再截图；不能保存点击后尚未切换的前一页。
5. 按触及范围复验，更新本入口、STATUS 和交接；MP15 全部要求未满足时继续保持未放行。

## 工具与省 Tokens 提示

- PowerShell 的 rg.exe 拒绝访问，直接用 Select-String；npm 不在 PATH，用已可用 node 和 `miniprogram/node_modules/.bin/tsc.cmd`。无需重复排查运行时。
- CLI auto 实测返回服务端口关闭；不再反复尝试、不更改安全设置。Windows UI 已能工作。
- computer-use SKILL 路径：`C:/Users/wuerl/.codex/plugins/cache/openai-bundled/computer-use/26.917.51856/skills/computer-use/SKILL.md`。读指导后通过工具发现 `mcp__node_repl__js`，import @oai/sky，list_apps/list_windows 后唯一选窗口。不要沿用旧坐标/截图 ID。
- 截止暂停：模拟器为 iPhone 14 Pro Max 430×932、商城；底部机型菜单刚展开，下一轮先取新截图处理菜单。原始机型是 iPhone 12/13 Pro 390×844。
- 已完成检查不因换对话重跑；有新改动才跑对应测试，交付前执行工程规定门禁。不要通读历史 65 张卡、ERP、后端、生成物或锁文件；本任务不触及共享契约/迁移。
