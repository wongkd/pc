# 字体微调记录

日期：2026-09-22。状态：图片候选稿，未替换原图，未进入生产实现。

用户最新要求：只修改字体，其他不动。后续不继续重排四屏、不使用本轮先前生成的独立猫与主机插画。

输入为 `four-tab-board-clean.png`，产物为 [字体微调版](four-tab-board-font-only.png)。使用内置 imagegen，调整方向为接近喜茶参考的较细中文无衬线字形与字重，保留四 tab 内容和原布局。

已查看生成图：主要结构、图片位置和内容保留；但生成式编辑对照片和图标存在细微重绘，不能把这张图认定为非文字区域像素完全不变。原图原样保留，本轮不覆盖。暂无可直接改字体的原始设计源文件。

下一步：以用户字体限定为准评审候选；若要求非文字像素严格不变，需使用原始可编辑设计文件或经过明确授权的局部合成方式。

## 实际生成提示词

```text
Use case: precise-object-edit / text typography edit.
EDIT TARGET: reference image 1, the existing four-screen Chinese computer shop mini-program design board. Output the SAME complete 1536 by 1024 composition.
Reference image 2 is ONLY a typography reference. Do NOT copy any layout, imagery, navigation design, background, or wording from image 2.

USER HAS EXPLICITLY RESTRICTED THIS EDIT TO FONTS ONLY. All non-text regions must remain unchanged. Preserve the exact original four phone panels, phone outlines, heights, widths, gutters, rounded corners, shadows, backgrounds, photos, cats, avatar, cream member card, dividers, tab bar icons, control icons, and every object's position. Do not add any new content. Do not remove anything. Keep all existing text verbatim, with the same line breaks, font sizes, alignment, and text block coordinates. Do not enlarge whitespace, move buttons, or redesign navigation. In particular keep the original bottom icons above their labels; keep the existing grid shop layout and image feed.

Only change the letterforms and their font weight to closely match the delicate Chinese sans-serif typography of reference image 2 (HEYTEA screenshot): clean modern Chinese system sans, Noto Sans SC / HarmonyOS Sans-like, mostly regular weight 400, supporting text light 350, high quality thin and clear strokes, restrained medium 500 for section names/product names, never heavy rounded or bold UI fonts. Retain the original text colors and font sizes. Digits should be clean slender sans numerals, matching the reference. Page titles 商城 社区 我的 should look regular-weight, not bold, but remain exactly where and how large they were. Bottom labels retain their positions and sizes: selected medium 500, others regular 400. Buttons retain all their existing boxes and sizes; only glyph strokes become lighter.

The homepage large handwritten brand title 装一下机 remains handwritten, with its exact existing wording, position and occupied footprint, but refine strokes into the finer, natural single-line pen style seen in the user's HEYTEA reference. Its subtitle text remains exactly as on the target. NO photo changes, NO mascot changes, NO new drawings. Do not use the previously generated standalone cat-and-PC illustration. This is a surgical typography-only revision of image 1, NOT a new design.
```
