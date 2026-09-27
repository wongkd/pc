# 页面切换修复与商城商品管理

日期：2026-09-28。状态：ERP 网页与 API 已生产发布；小程序真实环境待配置。目标：修复切页卡住，分离仓库与小程序商品展示，提供图片尺寸说明和裁切。

## 入口与职责

- 网页 `/products` 为新增独立「商品」入口，维护名称、整机/配件分类、说明、整数分售价、列表图、主推图、草稿/上架/下架。
- `/inventory` 继续管理实物来源、成本、检测和收发；旧 `/inventory/products` 保留为型号档案。商城上架不改库存、不自动锁货、不接支付。
- [网页源码](../../../frontend/src/features/catalog/CatalogPage.tsx)、[裁切组件](../../../frontend/src/features/catalog/ImageCropDialog.tsx)、[后端路由](../../../backend/src/routes/catalog.ts)、[追加迁移0034](../../../backend/migrations/0034_catalog.sql)。
- [增量契约](../../../contracts/v2/catalog.json)是字段和尺寸来源；生成器同步网页、后端和小程序，不修改冻结的v1.2。
- [小程序读取服务](../../../miniprogram/services/customer/catalog.ts)与商城页面已接公开目录。真实环境域名、门店ID尚未配置；未就绪时明确报错，不回退演示商品。

## 已修问题

1. `LazyRoute` 在渲染内 `useMemo(lazy(load))`，切页挂起时组件身份不稳定。改为按加载器的模块级 WeakMap 缓存；显式重试才淘汰。新增连续切页/返回回归，旧实现调用同一加载器3次，修复后1次；原有失败恢复测试保留。
2. 附件会话直接调用 `crypto.randomUUID()`，普通HTTP环境可能不可用；复用既有跨端请求编号生成器，测试覆盖缺少该API。
3. 型号档案保存错误原先显示在弹窗背后，现同步显示于当前弹窗内。

## 图片规范与来源

| 用途 | 比例 | 上传输出 | 建议原图 |
|---|---|---|---|
| 商品列表图 | 1.42:1 | 710×500 PNG | 至少1420×1000 |
| 商城主推图 | 1.144:1 | 572×500 PNG | 至少1144×1000 |

输入 JPG/PNG/WebP ≤20MB，输出≤2MB。裁切支持固定比例、拖动和键盘微调；小图有清晰度提示，取消保留原表单。沿用当前小程序实际布局比例。
复用 [React Image Crop 11.1.2](https://github.com/dominictobias/react-image-crop)，ISC许可保留于依赖包；未复制无授权来源代码。
浏览器截图中的整机图片来自仓库既有小程序演示素材，仅用于本地虚构样本验收，不代表实物或生产商品证据。

## 实测证据

- 网页全量252/252通过；收尾调整后相关页面与路由专项11/11通过，生产构建通过。
- 后端全量418/418通过，耗时约12分14秒；隔离 Worker 与内存 D1，无线上访问。
- 商城 Worker/D1/R2专项3/3：鉴权/权限、跨店隔离、草稿私有、公开字段白名单、上架必填图片、下架图片404、版本冲突、同请求重放不重复审计、非法金额/图片拒绝；库存流水仍为0。
- 小程序全量68/68：含商城运行态3项（真实目录、过期响应隔离、失败重试/环境隔离）及商城页面专项4项；typecheck/check-pages/check-classes通过。
- 契约3758项、跨端一致性、D10及商城生成物、迁移编号0000–0034与错误码检查通过。
- 浏览器：本地5196→8896，内存D1与临时图片存储。已验证连续导航、售后接修表单打开、选图裁切上传、上架列表读回、离开商品页再返回编辑。桌面及390px宽度已实看；[桌面截图](catalog-desktop.png)、[手机宽度截图](catalog-mobile.png)。没有写任何生产记录。

## 生产发布与只读核验

- 代码提交 `e4c6a81` 已快进推送 GitHub `main`；生产 Worker `pc-backend` 版本 `cbfd2a60-f798-4b34-8cd7-548f4032a6dd` 于2026-09-27 23:05 UTC 发布到100%流量，路由仍为 `erp.huangqidong.cn/*`。构建资源总计 gzip 174.69 KiB。
- 发布前 D1 Time Travel 点：`2026-09-27T23:02:51.884Z`，bookmark `0000013a-00000006-000050f3-1d7d16eba5ab9c191cf820448faeb3a6`；Cloudflare 迁移命令应用时另自动捕获备份。
- 生产 D1 `pc-db` 已应用 `0034_catalog.sql`；Wrangler 显示无待迁移。只读检查确认商品表、索引和两条审计触发器存在，`PRAGMA foreign_key_check` 为空。未创建商品或写入库存、报价、客户等业务记录。
- `https://erp.huangqidong.cn/` 与 `/products` 均返回200；商城管理匿名请求返回401；`check-web-release.mjs` 确认入口 JS/CSS 引用与本地产物相同。此证据不代表登录后的员工操作已验收。
- 生产 Worker 绑定 `pc-db` 与 `pc-attachments` R2；本地浏览器测试图片在内存存储中，生产商品图片需由员工上传后才会进入 R2。

## 未验证与下一步

- 未使用员工账号做生产登录和模块点击验收；静态资源、路由与匿名权限已核验，生产登录后的业务闭环仍待真实员工只读验收。
- 两份历史测试曾引用已删除的店员 `features/demo-data.ts`：纯显示规则改用冻结契约样本，退役店员模块的一致性测试完整[归档](../../archive/2026-09-28-retired-mini-tests/README.md)，未恢复退役运行代码。修正后全量68/68。
- 小程序生产 API 地址与门店ID当前仍为 `null`，正式版不能读取商城，且未提交微信体验/审核版本。接入备案 HTTPS 域名与真实门店 ID 后再做开发者工具/真机和微信发布验证。
- 生产 D1 迁移与 Worker 已发布；生产恢复、员工登录、真实图片上传和小程序真机触控仍需独立验收。

## 复验命令

```powershell
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run build
npm.cmd --prefix backend test
node --test backend/tests/catalog-http.test.mjs
node --test miniprogram/tests/catalog-runtime.test.mjs miniprogram/tests/customer-home-shop.test.mjs
npm.cmd --prefix miniprogram run typecheck
npm.cmd --prefix miniprogram run check-pages
npm.cmd --prefix miniprogram run check-classes
node contracts/tools/generate-catalog-contract.mjs --check
node contracts/tools/validate-contracts.mjs
node contracts/tools/check-client-parity.mjs
npm.cmd --prefix backend run check:migrations
node scripts/check-doc-links.mjs
```
