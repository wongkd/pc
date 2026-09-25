# 顾客端独立图像资源

本目录保存 2026-09-22 已确认四屏视觉基准的独立资源。位图由内置 imagegen 参照
`docs/design/2026-09-22-customer-ip/four-tab-board-clean.png` 生成；图标保留可重建 SVG 源。
照片使用包体友好的 JPEG，品牌字标、猫 IP 和图标使用透明 PNG。

具体来源、尺寸、用途、裁切焦点和验收状态见
`docs/design/2026-09-22-customer-ip/assets-manifest.json`。

重建与验证：

```text
node docs/design/2026-09-22-customer-ip/build-customer-assets.cjs
node docs/design/2026-09-22-customer-ip/verify-customer-assets.cjs
```
