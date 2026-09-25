# 图片与动效资源补充

日期：2026-09-18。状态：资源已生成并接入本地网页、小程序演示；未部署，未接入真实业务。沿用 v3 的奶油白、森林绿和紧凑设备摘要。

## 查看结果

- [可点击资源预览](./index.html)：可直接双击打开，不需要网络；展示四类设备图和按钮反馈。
- [资源总览截图](./gallery.png)、[网页设备看板](./board.png)、[网页工作台](./workbench.png)、[搜索空状态](./empty.png)。
- 业务入口：网页今天页的设备看板和订单摘要；小程序今天页缩略图与事项详情页。

## 为什么补这些

当前演示的七条图片 URI 均是 `demo://photos/...`，浏览器和小程序不能直接加载。本轮用显示层映射提供可离线使用的四类图；不修改冻结的契约、金额、附件用途和演示样本。所有生成图显示「AI 示意 · 非实拍」，不能充当交付、验机、接修或回收证据。主机类共用一幅类别示意，不声称与订单型号、成色、配置一致。

网页补充搜索无结果、图片加载失败的代码原生 SVG 图形，仍保留文字和下一步操作。图片失败状态按事项隔离，避免一张图失败后其他事项也只剩占位。

动效只用于按钮反馈：CSS `transform: scale(.97)`、120ms、`cubic-bezier(0.23, 1, 0.32, 1)`；按压与释放可中断。键盘焦点操作、禁用按钮和减少动态效果模式不位移。高频搜索、列表、菜单保持即时；不加入循环动画、数字滚动、GIF、视频或新依赖。小程序保持原生按压反馈，不加入依赖媒体查询兼容性的位移动画。

## 资源清单、来源与用途

| 文件 | 来源 | 用途 | 网页 / 小程序体积 |
|---|---|---|---|
| `tower.jpg` | 内置 image_gen 生成 | 主机类别演示 | 64,104 / 21,338 bytes |
| `gpu.jpg` | 内置 image_gen 生成 | 显卡类别演示 | 55,537 / 20,568 bytes |
| `laptop.jpg` | 内置 image_gen 生成 | 笔记本类别演示 | 23,965 / 9,217 bytes |
| `monitor.jpg` | 内置 image_gen 生成 | 显示器类别演示 | 17,096 / 7,289 bytes |

网页总计 160,702 bytes（约 157 KiB），640×640 JPEG；小程序总计 58,412 bytes（约 57 KiB），320×320 JPEG。压缩仅缩放、JPEG 编码，不修改图像内容。原始 1254×1254 PNG 保存在 `originals/`，不进入前端 public 或小程序包。

来源记录：[实际生成提示词](./prompts.md)。未使用第三方产品照片、商标素材或远程图床；生成素材未进行独占性、具体型号与商业权利核实。仅批准作为本地演示；正式客户资料必须使用自有或已获授权的准确型号图、实物照片。代码原生状态图形由本轮编写，无外部图标依赖。

## 文件职责

| 位置 | 职责 |
|---|---|
| `originals/`、`prompts.md` | 可追溯的生成原图与提示词 |
| `index.html` | 独立资源评审页，不连接业务服务 |
| `optimize.cjs` | 从原图重建两端压缩图 |
| `verify.cjs`、`verification.json` | 隔离网页组件与资源页的浏览器验证、结果 |
| [网页资源](../../../frontend/public/assets/workbench/) | Vite 本地静态资源 |
| [小程序资源](../../../miniprogram/assets/workbench/) | 原生小程序包内 JPEG |
| 小程序演示映射 | `demo-visuals.ts` 曾给旧店员演示页匹配七条 URI；旧页面下线后该映射已删除。真实接口不补生成图，见[工作台真实接口回执](../../verification/2026-09-25-workbench-live-api/README.md) |
| [状态图形](../../../frontend/src/features/workbench/StateGraphic.tsx) | 无结果、图片失败两个 SVG 图形 |
| [动效样式](../../../frontend/src/styles/motion.css) | 按压反馈、键盘与减少动态效果规则 |

## 运行与验证

在项目根目录执行（使用现有 Puppeteer、本机 Edge，无需新增依赖）：

```powershell
node docs/design/2026-09-18-assets/optimize.cjs
node docs/design/2026-09-18-assets/verify.cjs
```

浏览器验证临时启动 `127.0.0.1:8824`，创建 gitignore 下 `frontend/.validation-assets/` 的组件入口，禁用项目代理并阻断外网请求；完成后关闭服务和浏览器。不会登录生产环境。

当前终端没有 npm 命令，实际通过的是等价 Node 入口：

| 工作目录 | 实际命令 | 结果 |
|---|---|---|
| `frontend` | `node node_modules/vitest/vitest.mjs run --config vitest.config.ts` | 6 文件、50 测试通过 |
| `frontend` | `node node_modules/typescript/bin/tsc -b`，再 `node node_modules/vite/bin/vite.js build` | TypeScript 与 Vite 构建通过 |
| `miniprogram` | `node node_modules/typescript/bin/tsc --noEmit` | 类型检查通过 |
| `miniprogram` | `node --test "tests/*.test.mjs"` | 39 测试通过 |
| `miniprogram` | `node scripts/check-classes.mjs`、`node scripts/check-pages.mjs` | 样式引用与页面注册检查通过 |
| 根目录 | `node docs/design/2026-09-18-assets/verify.cjs` | 18 项本地浏览器检查通过，详见 JSON |

浏览器覆盖真实网页组件 1366/1440/1920 宽度、七张列表图加载、AI 标识、图片失败与切单恢复、空状态、减少动态效果；资源评审页覆盖 1440/320/375/390/430、键盘与触控点击。已人工查看生成原图、压缩后的评审页和设备看板截图。

## 限制与下一步

- 小程序此次未运行微信开发者工具编译、模拟器或 iOS/Android 实机验收；列表缩略图角标、加载和包体仍须平台验收。静态资源约 57 KiB，不等于微信实际打包体积。
- 手机宽度浏览器检查仅针对资源评审页，不代表建设或验收手机业务网页。业务手机端仍为原生小程序。
- 未改变历史 v3 原型；生产构建仍有演示样本，不得因此发布。
- 后续接真实附件服务时移除演示映射，验收缺图、权限、上传失败及实际设备照片。
