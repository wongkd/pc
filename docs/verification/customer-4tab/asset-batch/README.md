# 顾客 4Tab 图像资源批量交付回执

日期：2026-09-22。状态：资源已生成并本地检查，尚未接入页面，未完成微信工具/真机验收。

## 交付

- `miniprogram/assets/customer/`：10 张照片类 JPEG、6 张透明品牌/IP PNG、30 张黑灰双态图标 PNG。
- `docs/design/2026-09-22-customer-ip/originals/customer-assets/`：imagegen 高清 PNG 原件。
- `assets-manifest.json`：路径、来源、尺寸、用途、焦点、授权状态和 ready 状态。
- `build-customer-assets.cjs`：从高清原件重建包内位图和图标。
- `customer-assets-preview.html/png`：包内资源总览。
- `customer-assets-prompts.md`：本轮提示词集合与共同约束。

未覆盖旧资源；照片高清 PNG 从小程序包目录移除，但原件保存在设计交付目录，可重建。

## 实际验证

| 命令 | 结果 |
|---|---|
| `node docs/design/2026-09-22-customer-ip/build-customer-assets.cjs` | 通过 |
| `node docs/design/2026-09-22-customer-ip/verify-customer-assets.cjs` | 通过；46 个资源，922871 bytes，低于内部 1.5 MiB 缓冲线 |
| `node scripts/check-doc-links.mjs` | 190 个 Markdown，470 个本地链接，0 断链 |
| `node miniprogram/scripts/check-pages.mjs` | 通过 |
| `node miniprogram/scripts/check-classes.mjs` | 通过 |
| `node miniprogram/scripts/sync-contracts.mjs --check` | 通过 |
| `miniprogram/node_modules/.bin/tsc.cmd -p miniprogram/tsconfig.json --noEmit` | 通过 |
| `node --test miniprogram/tests/*.test.mjs` | 92/92 通过 |

`npm` 在当前 PowerShell 不可用，因此用项目等价的 `node`/本地 `tsc.cmd` 命令执行；不是跳过检查。

## 看图结论与边界

已实际查看总览：照片、字标、猫 IP、头像和图标可正常加载；透明素材在棋盘格上显示透明边缘；字标为准确的“装一下机”；没有把整屏图当页面素材。

这不是 MP00/MP01 正式卡验收：MP00 测量基线尚未执行，资源尚未接入四页，未在微信开发者工具、iOS 或 Android 真机看过。下一步仍先执行 MP00，再按 MP01 清单核对并进入 MP05/MP07 等接入卡。
