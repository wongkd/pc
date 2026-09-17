# 视觉效果图生成提示词

日期：2026-09-17

用户后续要求：界面不要无用宣传词。下方为此前实际提交的历史提示词；若重试，须删除其中的欢迎标语，改为“今日待办”等功能文案，并以 rendered-preview.html 当前版本为准。

尝试方式：内置 imagegen，每个方向独立提交一张桌面与手机组合概念图的请求。三次请求最终均返回网络错误，未取得生成图片。以下保留实际发送的完整提示词（共用部分与方向部分拼接），供后续重试参考；本目录实际交付图片来自 rendered-preview.html 的浏览器渲染，不声称为 imagegen 输出。

## 共用提示词

```text
Use case: ui-mockup. Create a high-fidelity, polished product design presentation for a Chinese small computer assembly shop business management application, for a serious client choosing a visual direction. This is a software workbench, not an ecommerce shop or marketing landing page.
Canvas: very high resolution landscape 2400x1500 or similar 16:10. One clean presentation board showing a large fully visible front-facing desktop WEB dashboard on the left about 75% width, and one tall smartphone mobile app / WeChat mini-program dashboard on the right about 22% width. Both screens perfectly sharp, no perspective skew, no laptop physical shell, no overlap covering any interface. Sparse outer board margins, tiny art direction title top left, small "概念设计 · 示例数据" bottom left. Desktop UI has enough readable generous Chinese typography; do not fill with illegible tiny repeated text. Chinese must be rendered accurately. No foreign brand logos, no Apple logo, no MUJI logo, no OCE logo. Application is labelled "装机店工作台" and small subtitle "电脑店经营管理".
Identical functional content for style comparison: left sidebar six items "今天" active, "开单", "库存", "售后", "回收置换", "账本", and small bottom "设置". Thin topbar with search "搜索客户 / 单号 / SN" and modest round user avatar. Desktop content header "今天，井井有条。" and subtext "先处理交付，再安排手边的事。" with single dominant "+ 开单" button at right.
Four summary metrics in one calm row: "待交机" 3, "缺货订单" 2, "维修待办" 4, "待收款" "¥12,800". Status cues semantic and restrained.
Primary working area approx 2/3 width: title "今天要处理", tabs "全部" "待交机" "待补货" "待维修". Three spacious actionable rows, each has a beautiful coherent photographic computer hardware thumbnail and readable simple words: row1 "陈先生 · 白色装机" "今天 16:00" status "待交机" action "查看交付"; row2 "林女士 · 设计主机" "缺少 1 件" status "待补货" action "查看缺件"; row3 "周先生 · 显卡检测" "已接收" status "待检测" action "开始检测". Avoid stray numbers.
Secondary work area at right inside desktop: compact striking feature panel with exquisite photographic white custom PC tower and GPU, occupying no more than 20% of app content; heading "常用配置" and label "设计办公 · 安静高效" with discreet "套用配置 →". Below small panel "二手可用库存", product photograph of GPU, "显卡 U-017", "已检测 · 可装机", "查看库存 →".
Below tasks a calm horizontal quick action strip with consistent simple outline icons and text "扫码入库" "接收维修" "旧机估价". All icons use same visual weight. No emoji.
Mobile must be a distinctly reflowed useful Chinese mobile workbench, not shrunken desktop: system status line, mini-program-like title "今天", unobtrusive ellipsis capsule at top right, "装机店工作台", a wide search field, prominent "扫一扫" entry. A compact 2x2 metric grouping with the SAME 3,2,4,¥12,800 values. Then "今天要处理" with two or three task cards matching desktop including hardware thumbnails and legible status. Bottom bar exactly four destinations "今天" "开单" "库存" "更多", label and simple line icons, appropriate safe area. No squeezed six-tab mobile sidebar.
Real product / hardware photography is crucial: use convincing white PC cases, a black GPU, carefully lit materials and detailed realistic textures. No unrelated decorative furniture or lifestyle shop products. UI must feel buildable in real software; business data stays on opaque calm readable surfaces.
```

## A · 苹果式轻质感

```text
Art direction: Apple-inspired refined productivity interface, not a clone of Apple's website. Cool near-white #F5F5F7 canvas, white solid content, very dark #202124 text, a single blue #2563EB primary action. Precisely rounded 16px corners, subtly raised white cards, beautiful compact typography inspired by native platform typography with generous spacing. Sidebar and mobile bottom nav only have a faint frosted glass effect; do NOT put transparent glass under tables or amounts. Crisp modern hairline icons. Product photography is silver-white and graphite, isolated on gently lit neutral studio surfaces. A soft very pale blue-to-white backdrop only in the compact product feature. No neon, no purple, no big hero occupying the dashboard. Desktop and mobile feel exceptionally clean, premium, efficient and technologically elegant. Outer board light cool gray. Top title exact "A · 苹果式轻质感".
```

## B · OCE 灵感生活方式

```text
Art direction: OCE-inspired Scandinavian lifestyle editorial taste translated into computer store management software. This must be visibly different from the Apple option, not just recoloring. Cream #F7F5EF background, warm ink #2F3431 text, deep desaturated forest #37584C primary buttons, sage #C4D1BE blocks and small butter yellow #E9D89F or restrained terracotta #B97758 accents. Flat beautiful editorial grid, large modest serif Chinese main heading contrasted with a clean Chinese sans-serif UI, softly squared 8px containers, thin olive-gray rules, no glass or floating translucent effects. Stats grouped in one horizontal pale sage panel with separators, tasks have flatter editorial rows. A narrow ochre colored strip may introduce the feature panel. PC photography is an authentic bright creative studio scene: beautiful white custom PC on a pale wooden workbench lit by warm natural side daylight; cropped carefully so the computer dominates. GPU inventory photo against a matte sage background. Photographic thumbnails cohesive and warm, no vases as hero objects. Layout has subtle magazine-like asymmetry but remains a practical readable dashboard. Mobile same design system with a soft cream background and forest green clear actions. Outer board creamy ivory. Top title exact "B · OCE 灵感生活方式".
```

## C · MUJI 灵感朴素工具

```text
Art direction: MUJI-inspired quiet Japanese functional warmth, translated into a computer shop professional tool. Off-white #F5F2EB background, charcoal #33312E text, pale warm gray #E6E1D7 dividers, tiny muted deep red #7C2D35 accent reserved for primary button and selected mark. Flat compact architecture with organized fine horizontal rules, no floating shadows, no glass, no gradients, very small 4px corner radius, understated nearly square buttons. Put stats in a simple typography-led strip separated by rules, not four pill cards. Sparse precise Japanese editorial influence but all text Chinese, Chinese UI sans serif, calm careful letter spacing and strong legible contrast. Almost monochrome business surface, warmth comes from material photography: matte ivory computer chassis, brushed silver graphics card and brown recycled paper product labels on light warm studio background, sober beautifully lit catalog still-life with real material texture. Tiny inventory number tag U-017. Main heading modest and confident rather than oversized. Desktop task rows look like a beautifully typeset practical ledger. Mobile bottom nav flat with thin dividing rule, no shadow. The single primary red action is immediately findable. Be refined and intentionally composed, not a generic beige template, not aged parchment, not rustic nostalgia, not a stationery shop. Outer board warm stone. Top title exact "C · MUJI 灵感朴素工具".
```
