# 生成与来源记录

日期：2026-09-18。内置 image_gen 生成，未使用 API / CLI。

参考图：用户提供的小程序头像，归档为 `originals/brand-avatar.png`。仅作为角色与风格参考；头像本身未重绘，只缩小编码为包内 JPEG。原图内品牌、字体和素材的商业授权未经独立核实。

生成文件：`originals/empty-cats.png`，包内压缩版 `miniprogram/assets/ui/empty-cats.png`。装饰性空状态插画，不代表设备实拍、型号、成色或验机证据；生成素材未做独占性及商业权利核实。

## 实际提示词

```text
Use case: stylized-concept. Asset type: compact empty-state mascot illustration for a Chinese PC workshop WeChat mini program. Input image is a STYLE AND CHARACTER REFERENCE ONLY, not an edit target. Create a single isolated pair of adorable voxel cats, one orange tabby and one silver gray tabby, leaning over a small empty open parts box with a tiny simplified computer tower beside it. Match reference blocky cubic fur, expressive dark eyes, warm friendly PC-builder personality. Simplify heavily for visibility at 160px. Cream and sage green box, very subtle ice-cyan accent on tiny tower, warm orange cat. Front three-quarter view, centered compact silhouette, generous clear margin. Real transparent background with alpha, soft minimal contact shadow only. No text, no lettering, no labels, no logos, no circular border, no busy workshop background, no neon glow. Must feel at home on cream #F8F6EF and forest green #334B42 business UI. This is a decorative no-results illustration, not product evidence.
```

## 功能图标

14 种原创 SVG 几何图标，源码集中在 `build.cjs`；24×24 坐标、1.7 线宽，输出 81×81 透明 PNG。森林绿 / 灰绿 / 奶油白三套颜色。无外部图标库，无远程资源。像素猫为品牌辅助图形，其余功能使用容易识别的轮廓。
