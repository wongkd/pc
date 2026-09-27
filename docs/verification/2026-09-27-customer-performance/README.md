# 客户查询修复与仓库弱网复测

- 日期：2026-09-27。
- 状态：客户列表修复与本地复测完成；迁移 `0033` 尚未应用到远端，代码尚未部署。
- 入口：[客户列表实现](../../../backend/src/index.ts)、[迁移](../../../backend/migrations/0033_customer_list_indexes.sql)、[查询基准结果](customer-query-benchmark.json)、[浏览器弱网结果](browser-measure.json)。

## 修复内容

- 客户列表默认每页 50 条，最大 100 条，按更新时间和 ID 倒序游标分页。台账页面可逐页加载；报价客户选择支持服务端搜索及继续加载匹配结果。
- 旧查询对每位客户分别执行三次订单汇总。现在先选出一页客户，再按门店和手机号关联订单，一次计算订单数、总额和已收金额；空手机号仍不归属任何订单。
- 迁移 `0033` 新增客户状态 / 更新时间分页索引和订单手机号金额覆盖索引。

## 查询基准

基准脚本复制既有的本机压力数据库，包含 1,500 位客户和 4,000 笔旧订单。旧查询在未新增索引的副本上测量；之后在同一副本加入 `0033` 的两个索引，再测新分页查询与实际 Node 宿主接口。原始数据库没有被写入。

| 读法 | 中位耗时 | 返回量 | JSON 大小 |
|---|---:|---:|---:|
| 旧全量客户列表查询（5 次） | 4,699.43 ms | 1,500 位 | 423,596 B |
| 新分页 SQL，含 1 条 lookahead（5 次） | 0.42 ms | 50 位 | 14,245 B |
| 新 Worker 接口 / Node 宿主（6 次） | 13.56 ms | 50 位 | 14,245 B |

新接口样本均为 HTTP 200，`EXPLAIN QUERY PLAN` 显示客户列表和订单汇总都使用了新增索引。旧 SQL 与新 SQL 的耗时不包含 HTTP 开销；Node 宿主耗时包含鉴权与 JSON 返回。

## 最新仓库弱网复测

Edge CDP 单客户端分别限速为下行 1 Mbps、3 Mbps、上行 1 Mbps，RTT 150 ms；每档开始前清空浏览器缓存。前端通过 Vite 开发服务，后端为隔离 Worker 和内存 D1 演示数据。账号登录令牌由本机验证脚本取得，不接触生产。

| 网络 | 登录页主控件出现 | 今天页可用 | 仓库数据可用 |
|---|---:|---:|---:|
| 1 Mbps | 17,586 ms | 1,929 ms | 8,532 ms |
| 3 Mbps | 6,271 ms | 1,824 ms | 4,553 ms |

仓库导航阶段观测到 47 个浏览器请求，其中 API 6 个、9,420 B；Vite 开发模块的 JS 约 683 KB。该数字包含开发服务模块和热更新开销，不能代表线上压缩包；此轮是每档单次采样，也不能代表共享出口或真实移动网络。

## 验证与边界

- `node --test backend/tests/e04-customers.test.mjs`：14/14 通过，覆盖游标分页、跨门店手机号隔离及金额汇总。
- `npm.cmd --prefix frontend test -- src/components/CustomersPage.test.tsx src/features/workbench/WorkbenchQuotePage.test.tsx`：39/39 通过。
- `npm.cmd --prefix frontend run build`、`npm.cmd --prefix backend run check:migrations`：通过；迁移序列连续到 `0033`。
- 文档检查 `node scripts/check-doc-links.mjs`：286 份文档、899 条本地链接、0 断链；`git diff --check` 通过。
- 基准和弱网结果均为本机合成数据证据。未应用远端迁移、未部署、未写生产业务数据；Linux 目标机容量、共享带宽和真实员工会话仍未验。
