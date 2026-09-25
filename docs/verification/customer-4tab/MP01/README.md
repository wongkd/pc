# MP01 · 素材与基线复核

日期：2026-09-23。状态：`review`。

## 结果

已复核 MP00 的两张基准图、独立资源总览和正式 manifest。19 个资源条目均为 `ready`，覆盖运行时 46 个文件、922,871 bytes；没有 `missing` 或 `preview_only` 条目。布局/照片取清爽版，字体/字重取细字体版，和 MP00 中锁定的两个 SHA-256 一致。

复核明细见 [asset-baseline-review.json](asset-baseline-review.json)。本卡没有重绘、裁切、替换或接入任何素材；`miniprogram/assets/customer/` 与 manifest 不需要改动。

## 实际检查

| 命令 / 检查 | 结果 |
|---|---|
| 实际查看 `four-tab-board-clean.png`、`four-tab-board-font-only.png`、`customer-assets-preview.png` | 已查看；照片、字标、猫 IP、头像与黑灰双态图标可辨，透明边缘正常 |
| `node docs/design/2026-09-22-customer-ip/verify-customer-assets.cjs` | 通过：46 个资源，922,871 bytes |
| `node docs/plans/2026-09-22-customer-miniprogram-reset/check-plan.mjs` | 通过 |
| `node scripts/check-doc-links.mjs` | 通过：196 个 Markdown、489 个本地链接、0 断链 |

## 未验证与下一步

资源尚未接入四页，未运行微信开发者工具，未取得 iOS/Android 真机截图；因此不是页面还原或高清视觉验收的结论。下一步 MP02 已在同一用户授权下完成顾客端隔离视觉令牌，后续可执行 MP03 顾客基础组件。
