# MP11 · 社区分类与第一条案例

状态：review。源码已实现；前置 MP03–06 回执缺失，且未取得微信工具截图。

## 结果

- 社区页接入「装机案例 / 电脑知识 / 门店公告」分类，分类保持选中；公告空分类显示明确空态。
- 第一条案例使用独立奶油桌面图、标题/摘要/日期、金猫角标和箭头；图片和空分类接入 MP06 公共 `customer-image` / `customer-state` 组件。
- 社区仍为商家只读内容，没有发帖、评论、点赞入口。
- 改动：`miniprogram/pages/community/index.ts/.wxml/.wxss/.json`。

## 验证

- `node --test "miniprogram/tests/*.test.mjs"`：111/111 通过；新增社区/我的页不变量回归检查（2/2）。
- `node miniprogram/scripts/check-pages.mjs`：通过。
- `node miniprogram/scripts/check-classes.mjs`：通过。
- `node miniprogram/node_modules/typescript/bin/tsc -p miniprogram/tsconfig.json --noEmit`：通过。
- `node miniprogram/scripts/sync-contracts.mjs --check`：通过。
- 截图：未运行；DevTools 进程存在，但当前桌面控制接口没有可绑定窗口，未在微信开发者工具或真机实看 375/390 布局。

## 未验证 / 下一步

MP03–06 源码与回执现已存在，但均因微信截图未完成而处于 review；必要的安全区/坏图前置截图尚缺。真实公告内容和文章详情也未接入。微信开发者工具进程存在，但当前桌面控制接口没有可绑定窗口，因此 375/390 原生截图仍是本卡最后的视觉放行项。
