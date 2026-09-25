# 小程序品牌与功能图标

日期：2026-09-18。状态：已生成、已接入本地小程序；未发布，未做微信模拟器 / 真机验收。

## 目标与入口

为现有奶油白、森林绿工作台补齐功能图标，用用户提供头像中的橘猫、银灰猫与少量冰蓝建立品牌联系。功能图标保持小尺寸清晰，插画仅用于空状态。

- [资源预览页](index.html)：本地直接打开，含按钮反馈；不是业务页面或微信模拟器。
- [390px 预览截图](preview-390.png)、[桌面预览截图](preview-1440.png)。
- [包内交付资源](../../../miniprogram/assets/ui)、[生成提示词与来源](prompts.md)。

## 已实现

- 14 种功能图标，每种森林绿、灰绿、奶油白三个版本，共 42 张透明 PNG（81×81）；另保留可编辑 SVG。
- 原生 tabBar 四项默认 / 选中图标，共 8 个引用。
- 今天页头像、开单、搜索、扫码图标；开单和更多页合计 8 个入口图标。
- 今天页与库存页空状态使用新的双猫插画（320×320 透明 PNG）。头像是用户原图缩小版（160×160 JPEG），没有重绘。
- 仍保留按钮文字、空状态说明、演示数据与未接通状态，未改变业务事件或权限。

## 文件职责

| 文件 | 职责 |
|---|---|
| `build.cjs` | 原创图标几何、颜色、SVG / PNG 输出与预览页生成 |
| `svg/` | SVG 图标源文件导出，不进入小程序包 |
| `originals/` | 用户头像与内置 image_gen 生成插画原图归档 |
| `optimize.cjs` | 仅缩放编码；保留插画透明通道 |
| `prompts.md` | 完整实际提示词、来源、授权核实状态 |
| `verify.cjs`、`verification.json` | 浏览器资源检查与实际结果 |
| `preview-*.png` | 资源评审页截图 |

## 重建与验证

项目根目录运行，使用已有 Puppeteer 与本机 Edge，无新增依赖：

```powershell
node docs/design/2026-09-18-miniprogram-icons/build.cjs
node docs/design/2026-09-18-miniprogram-icons/optimize.cjs
node docs/design/2026-09-18-miniprogram-icons/verify.cjs
```

实际通过：

- Windows / headless Edge：320、375、390、430、1440px 资源页图像全部加载、无横向溢出、按钮反馈；键盘 Enter 操作。
- 8 个 tabBar 图标路径存在，尺寸 81×81，单张小于 40 KiB。
- 小程序目录 `node node_modules/typescript/bin/tsc --noEmit`、`node scripts/check-pages.mjs`、`node scripts/check-classes.mjs`。
- 人工查看 390px 资源页截图及生成插画，插画透明通道检查通过。
- 新增包内资源 44 个文件，206,041 bytes（约 201 KiB），不等于微信最终打包体积。

全仓 `git diff --check` 发现此前已修改的契约样本与网页文件有行尾空白提示；本轮未改动那些文件。未运行网页 / 后端构建与业务测试，因为本次仅改小程序资源呈现。

## 限制与下一步

微信开发者工具编译、原生 tabBar 尺寸观感、iOS / Android 真机、小程序整体页面布局与实际包体未验收。浏览器证据仅覆盖资源页；下一步在微信工具打开小程序并检查今天 / 开单 / 库存 / 更多，筛选空结果确认插画。上传头像仅用于本地项目，未变更微信后台账号头像。

商业授权状态见 [来源记录](prompts.md)。插画不能作为商品照片或实物证据。
