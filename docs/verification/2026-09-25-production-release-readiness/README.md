# 生产发布前只读核查证据

- 日期：2026-09-25
- 状态：只读实查完成到当前可访问范围；**生产发布不放行**。
- 目标：核实生产 D1 迁移、员工权限数据、密钥名称存在性、生产/预览隔离、发布版本及代码/数据回退证据。
- 边界：仅运行清单与 `SELECT`；未读取密钥值、员工身份字段或客户数据；未导出生产库；未创建资源、应用生产迁移、发布 Worker、修改 DNS、写入生产 D1/R2 或执行回退。
- Wrangler：本机 4.105.0；另用 4.139.0 复核生产迁移清单。两版本结果一致。

## 核查结果

| 项目 | 实查结果 | 放行判断 |
|---|---|---|
| 生产 D1 `pc-db` | `d1_migrations` 记录至 `0005_sn_hardening.sql`；`0003_orders`、`0004_sn` 两行没有 `.sql` 后缀。Wrangler 4.105.0 与 4.139.0 均把 `0003_orders.sql`、`0004_sn.sql` 列为待迁移，并列出 `0006`–`0028`。订单与 SN 核心表实查存在。 | 迁移历史与当前文件名不一致；不得直接 apply。需先在隔离库复现并核对迁移名称及 DDL。生产迁移未执行。 |
| 员工权限数据 | 2 个 active 用户、1 个 active 门店、2 个 active 成员（含 1 个 owner）；5 个角色、11 个权限、33 条角色权限关联、2 条成员角色关联；active 成员无角色数为 0。 | 旧权限数据存在；`0001` 仅建表，未提供默认种子来源。计数不能证明覆盖当前契约权限矩阵或逐人授权正确。 |
| 生产 Worker secrets | `JWT_SECRET`、`DEEPSEEK_KEY` 在 `secret list` 中存在。`PDD_CLIENT_ID`、`PDD_CLIENT_SECRET`、`PDD_PID` 未出现在 secret 名称清单。 | 仓库配置说明这三项可能来自旧部署普通 `vars`；其生产变量名/存在性尚未确认。发布前只核对 Worker 变量名和存在状态，不读取或记录值。 |
| 生产/预览隔离 | 配置声明不同 Worker 与 D1：生产 `pc-backend` / `pc-db` / `2218dbef-fb7d-4248-8430-07dcd4fd0a17`；预览 `pc-erp-preview` / `pc-erp-preview-20260924` / `05601ff0-8e47-460f-8997-431712d83da4`。预览 D1 实查 `0000`–`0028` 共 29 条迁移，无待迁移；部署历史也属于不同 Worker。 | D1 与 Worker 声明分离有配置和远端读取证据；生产当前部署的完整绑定和变量仍未从部署设置复核。隔离部分通过。 |
| R2 附件桶 | 生产配置声明 `BUCKET=pc-attachments`；R2 清单查询返回 Cloudflare API 错误 10042，提示先启用 R2。 | 无法确认桶存在或 Worker 实际绑定；没有真实 R2 读写 canary。 |
| 发布与回退 | 生产 Worker 最近可见部署为 2026-07-22 18:14 UTC，版本 `b27148e0-25e1-4ff2-a44e-ed2b93aaafc1`；此前版本 `7f9de0df-4a82-4902-8e21-27e608f40a22` 在历史中。预览最近部署为 2026-09-24 18:55 UTC，版本 `0fe28ea4-1d56-4efb-8f22-85c4dcab2b87`。 | 有历史代码版本供后续兼容性评估；未执行代码回退。没有生产导出、备份恢复或数据回退演练证据。 |

## 生产 D1 与迁移编号

远端只读查询 `SELECT name FROM d1_migrations ORDER BY name` 得到：

```text
0000_baseline.sql
0001_erp2_stores_members_permissions.sql
0002_product_master_data.sql
0003_orders
0004_sn
0005_sn_hardening.sql
```

当前仓库文件为 `0003_orders.sql` 和 `0004_sn.sql`。当前 Wrangler 清单因此把这两份旧记录名对应的迁移再次列为待应用，并列出 `0006`–`0028`，总计 25 项（其中 2 项名称冲突、23 项为 0006–0028）。`sqlite_master` 中 `orders`、`order_items`、`order_payments`、`serial_numbers`、`sn_events`、`order_item_sn` 均存在；`hardware.warranty_months` 列也存在。当前 `0003` 用普通 `CREATE TABLE orders`，`0004` 用 `ALTER TABLE hardware ADD COLUMN warranty_months`，均没有幂等保护；再次 apply 有重复建表/加列失败风险。这证明相关结构已存在，不证明所有迁移语句都与当前文件一致。

使用 Wrangler 4.139.0 的隔离演练已从空 D1 应用 `0000`–`0028` 共 29 项，重复 apply 无待迁移项，见[隔离 D1 迁移部分回执](../../plans/2026-09-25-data-attachment-go-live/drill-20260925/README.md)。该结果验证新库迁移路径，不解决生产历史名称差异。不要在生产修补 `d1_migrations` 或应用待迁移列表；先用隔离库复现并形成由维护者审查的对齐方案。生产查询结果含 `changed_db=false`、`rows_written=0`。

预览 D1 的跟踪表从 `0000_baseline.sql` 到 `0028_document_export_attachments.sql`，共 29 条；`wrangler d1 migrations list` 显示 `No migrations to apply`。

## 员工权限与种子

查询仅返回行数和角色/权限代码，没有读取账号邮箱、姓名、手机号、密码摘要或具体用户授权。生产角色权限关联汇总：

| 角色代码 | 权限关联数 |
|---|---:|
| `admin` | 11 |
| `owner` | 11 |
| `purchasing` | 4 |
| `sales` | 5 |
| `service` | 2 |

生产 `permissions` 表的 11 个旧权限码为：`cost/view`、`library/edit`、`library/view`、`margin/view`、`member/manage`、`quote/edit`、`quote/view`、`role/view`、`store/manage`、`template/edit`、`template/view`。当前源码 `backend/src/domains/access.ts` 将部分旧码映射到新业务权限，并禁止自动扩大权限；数据库角色分配与当前契约矩阵尚未逐项复核。`0001_erp2_stores_members_permissions.sql` 只有建表语句、没有默认角色或权限插入，因此当前数据的种子来源不能由迁移证明。

以下为本轮员工/权限只读查询的 SQL（只返回计数、角色代码和权限代码）：

```sql
SELECT
  (SELECT COUNT(*) FROM users) AS users_total,
  (SELECT COUNT(*) FROM users WHERE status='active') AS users_active,
  (SELECT COUNT(*) FROM stores WHERE status='active') AS stores_active,
  (SELECT COUNT(*) FROM store_members WHERE status='active') AS members_active,
  (SELECT COUNT(*) FROM store_members WHERE status='active' AND is_owner=1) AS active_owners,
  (SELECT COUNT(*) FROM roles) AS roles_total,
  (SELECT COUNT(*) FROM roles WHERE code='sales') AS sales_roles,
  (SELECT COUNT(*) FROM permissions) AS permissions_total,
  (SELECT COUNT(*) FROM role_permissions) AS role_permission_links,
  (SELECT COUNT(*) FROM member_roles) AS member_role_links;

SELECT COUNT(*) AS active_members_without_role
FROM store_members sm
WHERE sm.status='active'
  AND NOT EXISTS (SELECT 1 FROM member_roles mr WHERE mr.member_id=sm.id);

SELECT r.code, COUNT(rp.permission_id) AS permission_count
FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id
GROUP BY r.code ORDER BY r.code;

SELECT code FROM permissions ORDER BY code;
```

## 密钥名称

需要的名称依据 `backend/src/index.ts` 与 `backend/wrangler.toml`。生产 `wrangler secret list` 仅记录以下名称状态：

| 名称 | 生产 secret | 备注 |
|---|---|---|
| `JWT_SECRET` | 存在 | 仅记录名称和状态。 |
| `DEEPSEEK_KEY` | 存在 | 仅记录名称和状态。 |
| `PDD_CLIENT_ID` | secret 清单未列出 | 旧生产普通变量是否仍存在，未确认。 |
| `PDD_CLIENT_SECRET` | secret 清单未列出 | 旧生产普通变量是否仍存在，未确认。 |
| `PDD_PID` | secret 清单未列出 | 旧生产普通变量是否仍存在，未确认。 |

本机 `backend/.dev.vars` 仅存在三个 PDD 名称，不代表生产状态；预览 secret 名称清单仅有 `JWT_SECRET`。未读取、输出或保存任何 secret 值。新部署前必须确认旧生产 `vars` 的保留方式，避免配置替换时丢失。

## 隔离、发布与回退边界

- `backend/wrangler.toml` 与 `backend/wrangler.preview.toml` 声明不同 Worker、D1 名称和 ID。当前生产配置另声明 `pc-attachments` 和 `REQUIRE_PERSISTENT_STORAGE=true`。
- `backend/wrangler.toml` 在当前工作区有未提交修改（新增持久附件开关及 R2 绑定）；配置读取结果不代表线上版本已应用相同绑定。
- 当前 `backend`、`frontend`、`miniprogram`、`contracts` 下有 223 个修改/未跟踪源文件项；本地[发布候选验收](../2026-09-25-release-candidate-acceptance/README.md)仍未通过整体验收。生产最近可见部署早于这些改动；本轮没有构建/发布生产候选包。`deployments list` 给出历史代码版本，不证明回退版本与当前 D1/R2 schema 兼容。
- 数据与附件保障计划已定义把 D1/R2 同一静止点备份、恢复到新 D1/桶、SHA-256 校验和代码回退边界；这些仍是计划，不是执行证据。本轮未导出数据库、同步对象或测得 RPO/RTO。
- [发布候选整体验收](../2026-09-25-release-candidate-acceptance/README.md)仍为部分验收、不放行；本地 UI 结果不能替代生产发布核查。

## 放行决定与下一步

**结论：不可据此发布或迁移生产。** 先在隔离环境复现生产迁移名称差异、核验完整角色/权限矩阵、确认生产旧变量名称是否仍存在；待账户启用 R2 后再做隔离读写 canary、同一静止点的 D1/R2 备份恢复与代码回退演练。完成后另立带明确目标环境、维护窗口、备份点和回退条件的上线操作单。

## 后续事实补记（2026-09-25）

本回执采集时账户 R2 尚未启用。此后账户管理员已启用 R2；专用隔离资源上的对象读写、合成数据备份/恢复、SHA 核验及 Worker 控制面回退见[隔离演练回执](../../plans/2026-09-25-data-attachment-go-live/drill-20260925/README.md)。这项后续隔离证据不核实也不改变生产 `pc-attachments` 桶或生产 Worker 的绑定状态；生产仍不得发布或迁移。

## 本轮只读命令

运行目录：`backend/`。远端检查使用当前本机 Wrangler，并以 Wrangler 4.139.0 复核生产迁移清单。

```text
wrangler d1 migrations list DB --remote --config wrangler.toml
wrangler d1 execute pc-db --remote --command "SELECT name FROM d1_migrations ORDER BY name" --json --config wrangler.toml
wrangler secret list --config wrangler.toml
wrangler deployments list --config wrangler.toml
wrangler r2 bucket list --config wrangler.toml
wrangler d1 migrations list DB --remote --config wrangler.preview.toml
wrangler d1 execute pc-erp-preview-20260924 --remote --command "SELECT name FROM d1_migrations ORDER BY name" --json --config wrangler.preview.toml
wrangler secret list --config wrangler.preview.toml
wrangler deployments list --config wrangler.preview.toml
npx --yes wrangler@4.139.0 d1 migrations list DB --remote --config wrangler.toml
```

员工/角色/权限部分的四条 `SELECT` 已在上方列出；本轮每条分别通过 `wrangler d1 execute pc-db --remote --command "<SQL>" --json --config wrangler.toml` 执行，所有语句均只读。

本 README 是生产只读核查事实记录；发布方案继续由[数据与附件保障计划](../../plans/2026-09-25-data-attachment-go-live/README.md)维护。后续新增日期回执，不覆盖本记录；差异更新 STATUS 与 OPEN-ITEMS 当前事实及链接。
