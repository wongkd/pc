# ERP 旧界面来源与项目治理

日期：2026-09-25。状态：全库文件盘点、入口清理、本地回归与生产发布完成；未宣称全库技术债清零。
目标：解释线上旧界面，隔离历史工具，清除确认失效的代码，建立可复查文件清单。

## 已确认原因

1. Edge 实际打开 `https://erp.huangqidong.cn/`，登录会话被导航到 `/quotes`，显示旧报价编辑器；点击“今天”可进入 `/dashboard` 的新版工作台。这说明新版已存在，默认入口仍指向旧工具。
2. 原 `App.tsx` 同时承载认证、路由、报价状态、云端同步、三秒自动保存、标题与打印样式。访问其他业务页也会挂载报价副作用。
3. `/sales` 把旧报价放首位，仍写已经失效的 E08/E09 未完成说明；旧 12 项导航仅用于生成两条占位路由，与现行导航重复。
4. 本轮 HTTP 读取：ERP 域名引用 `index-DB5iA6Tg.js`，旧 `pc.huangqidong.cn` 引用 `index-u5jt6vl9.js`。两个地址不是同一构建，不能混用验收；没有据此断言 CDN 缓存故障。

线上页面含已有业务内容，只记录路径与界面现象，不复制客户资料、截图或报价内容到仓库。未点击保存、收款或订单动作；旧页面自身存在自动保存，未抓取请求证明此次是否触发写入。

## 实施与文件职责

| 文件 | 本轮处置 |
|---|---|
| `frontend/src/App.tsx` | 从 800 余行收敛为认证、外壳和路由；首页与登录落点改为 `/dashboard` |
| `features/legacy-quote/LegacyQuotePage.tsx` | 旧 `/quotes` 按需加载；只在此页同步旧报价；首次载入不自动保存，读取失败暂停写回；卸载清除打印样式与恢复标题 |
| `features/legacy-quote/state.ts` | 集中历史草稿兼容、默认值、报价编号与模板规范化；新草稿去除示例客户，已有草稿不批量改写 |
| `app/workspaces.ts`、`WorkspaceLandingPage.tsx` | 开单优先展示报价、销售与交付；历史工具折叠且仍可进入 |
| `app/navigation.ts` | 更新 `/assembly` 兼容规则，实际重定向到 `/sales/fulfillment` |
| `erpNavigation.ts` | 删除。运行时唯一调用者原为 App 的占位过滤，已用显式供应商占位与交付重定向替代；历史回执中的裸路径仅保留追溯 |
| `components/OrdersPages.tsx` | 删除无调用者的旧 `DashboardPage`；历史订单列表与详情保留 |
| `types/hardware-categories.ts` | 合并两个编辑组件重复的硬件分类；消除组件文件导出常量的问题 |
| `utils/api.ts` | 旧接口去除显式 any，集中模板、报价与比价结果类型 |
| `vite.config.ts` | 删除抢占 `/api/search` 的 POST 开发代理，统一使用现有后端 `/api` 代理；前端实际调用 GET，后端已有搜索实现 |
| `index.html` | 标题改为门店 ERP，移除生产入口中的 B1 临时全局报错注入脚本 |
| `scripts/audit-repository.mjs` | JSON 增加逐文件路径、大小、分类与备份候选；只读、不自动删除 |
| `scripts/check-web-release.mjs` | 比较本地 dist 与线上 HTML 的 JS/CSS 引用，返回不一致状态；不访问业务 API、不部署 |

## 全库文件管理结论

开工盘点 1,269 个非依赖/非数据文件：根目录 9、backend 115、contracts 19、docs 787、frontend 133、miniprogram 203、scripts 3。
本轮完成目录和文件元数据盘点，不等于逐行审计所有业务代码。清理依据运行时引用，不以年份、文件大小或命名“旧”判断无用。

| 范围 | 管理决定与剩余事项 |
|---|---|
| frontend | 当前 ERP 与兼容工具已有独立职责；客户、商品、SN、设置仍有真实路由，保留。剩余 lint 见下表；主 bundle 仍有体积警告 |
| backend | 销售 2,702、库存 2,453、装机 1,805、入口 1,781 行是维护热点；涉及资金库存与契约绝对行号，按业务域及专门回归拆分，不能按大文件删除 |
| contracts / migrations | 唯一协议与历史迁移保持原位；`actions.json.bak-r02` 列入备份候选，未按无引用直接删除。生成副本有同步职责 |
| miniprogram | 顾客 4Tab 与旧店员页仍同时注册；退出需同步 app.json、导航、分包与测试，不能把清理网页入口扩为删除已注册页面 |
| docs | 计划、设计、验证、归档继续分区；修正文档地图和当前交接，历史回执保留其当时状态；图片/截图不是可自动删除缓存 |
| 本地目录 | node_modules、backups、.wrangler、.sync_temp_dir、.validation-*、凭据/数据库跳过内容扫描；保留已有依赖、备份、数据库及用户未提交改动 |

逐文件清单见 [inventory.json](inventory.json)，可重跑 `node scripts/audit-repository.mjs --json`。

## 实跑验证

| 检查 | 结果 |
|---|---|
| `npm --prefix frontend test` | 27 文件、217 测试通过；含新增 6 项入口/副作用回归 |
| `npm --prefix frontend run build` | 通过；旧报价生成独立 chunk；主 JS 约 564 KB，仍有 >500 KB 警告 |
| 前端 ESLint | 开工 40 errors / 5 warnings；收尾 9 errors / 3 warnings，未关闭规则来掩盖剩余问题 |
| 本地 Edge | 独立内存 Worker :8798 + 前端 :5188；演示账号登录后实际落 `/dashboard`，开单页实看三个当前入口；历史工具可用 Enter 展开 |
| 线上只读比对 | 发布前线上包与本地新构建不一致；发布后 `erp.huangqidong.cn/` 返回新版包，Edge 实看根路径自动进入 `/dashboard`，页面标题为「装一下机 · 门店 ERP」 |
| 生产发布 | `pc-backend` Worker 版本 `0d0d21c8-6800-409b-b775-85dca2823970`，100% 流量，消息 `erp entry cleanup: dashboard default and legacy quote isolation`；路由 `erp.huangqidong.cn/*` 保持不变 |
| 文档链接 | `node scripts/check-doc-links.mjs`：244 个现行 Markdown、649 个本地链接、0 断链 |
| Diff 空白检查 | 本轮 frontend / README / docs / scripts 范围通过；全库仍被既有 `contracts/v1/fixtures.json` CRLF 空白差异阻断，该文件本轮未改 |

剩余 lint 分布：OrdersPages 1 error / 1 warning，ProductManagementPage 2 / 1，SystemSettingsPage 3 / 0，TradeInPanel 2 / 1，WorkbenchTodayPage 1 / 0。主要是 effect 内状态更新、依赖项和非组件导出，后续需结合请求竞态与业务状态处理，不能简单加禁用注释。

临时命令日志位于根 `.validation-maintenance-20260925/`，不入 Git。没有修改后端/契约/迁移，无提交、部署、生产数据清理。
未验证：手机/微信、全量业务交易、历史报价打印文件导出、剩余大领域拆分。生产首页与登录会话已复验；页面中已有一笔回收演示/测试事项，本轮未创建、修改或删除生产业务数据。
