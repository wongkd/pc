# MP00 · 四屏测量表与当前源码基线

日期：2026-09-23。状态：`review`；本卡仅建立后续实现可复用的视觉基线，没有修改小程序生产文件。

## 结果与入口

- [测量基线](visual-baseline.json) 固定了清爽版布局图与细字体图的 SHA-256、画板尺寸、四屏结构、归一化坐标、起始令牌和复用组件建议。
- 布局/图片以 `four-tab-board-clean.png` 为准，字形/字重以 `four-tab-board-font-only.png` 为准；两图已实际查看。
- 已核对当前代码：四个顾客 Tab 路径存在，但仍采用旧 `app.wxss`、系统 tabBar、`assets/ui` 和 `features/demo-customer.ts` 演示壳；没有将它们误报成新四屏已接入。

## 测量边界

参考画板为 1536×1024，四个手机内容面板均约 355px 宽。表内的坐标以概念稿内容面板归一化，而不是把整张四宫格图当作一部 375px 手机。

系统状态栏、微信胶囊和底部安全区没有被当成页面内容。375px 下的字号、边距和控件尺寸只是后续 WXSS 的起始值；MP04 必须用开发者工具截图复测。

## 实际检查

| 命令 | 结果 |
|---|---|
| `node docs/plans/2026-09-22-customer-miniprogram-reset/check-plan.mjs` | 通过 |
| `node scripts/check-doc-links.mjs` | 通过 |

## 未验证与下一步

未运行微信开发者工具，未取得 iOS/Android 真机截图，也未实施四页、custom tab bar、样式令牌或真实顾客接口。本卡状态保持 `review`，不是视觉验收通过。

下一张先做 MP01 前置复核：资源虽已由独立资源交付准备完毕，仍需确认其与本基线一致并写正式卡回执；随后才进入 MP02 的视觉令牌。
