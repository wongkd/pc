# 2026-09-22 · 回执目录健康校验（未开新业务卡）

日期：2026-09-22 凌晨。状态：**只做只读校验；未新增业务回执、未改任何回执状态、未写业务代码。**

前置：[进度台与回执协议](../../design/2026-09-21-prompt-launcher/README.md)、[上一轮建立与复核](../../verification/2026-09-21-receipts/README.md)。

## 本会话认编号的结论（先看这条）

**本会话没有实际负责的 E 系列任务编号。**

判断依据（都是可查的事实，不是印象）：

| 依据 | 事实 |
|---|---|
| 在册回执 | `docs/verification/progress/` 只有 **E06 / E07 / E08 / E10** 四份，全部 `verified`，写入时间分别为 09-21 12:20、12:20、20:05、23:14 |
| 本会话起点 | 2026-09-22 01:55 起的新会话，此前未做任何业务开发、未持有任何进行中的卡 |
| 断点约定 | `docs/NEXT-SESSION-PROMPT.md` 第 70 行：「候选下一刀**等栋哥点，别自己开工**」 |
| 已有先例 | 2026-09-21 receipts 第 54 行：「未写 E08 及之后任何回执——**收到回执指令不构成开工依据**」 |
| OPEN-ITEMS | Q-09 / G-25 / T-11 / D-D / G-20 / G-21 均为「待办」而非「进行中」，无已开工未回报的 E 卡 |

⇒ 因此**没有**凭空新建任何编号的回执。若本会话后续被指派具体卡，从 `working` 起写，逐步更新到 `verified`。

## 本轮做了什么

1. 逐份解析四份在册回执，校验**字段完整性 / status 合法性 / id 与文件名一致 / evidence 路径合规与存在性 / evidence 文件 mtime 是否晚于 updatedAt / verified 是否同时具备源码与验证记录**。
2. 把校验逻辑固化成可复用脚本 `check-receipts.mjs`（放本目录），以后任何会话都能一键体检。

## 实跑与结果

命令：`node docs/verification/2026-09-22-receipts/check-receipts.mjs docs/verification/progress`
退出码：**0**

| 回执 | status | 缺证据 | 路径不合规 | **触发「待复核」的证据数** |
|---|---|---|---|---|
| E06 | verified | 0 | 0 | **4** |
| E07 | verified | 0 | 0 | 0 |
| E08 | verified | 0 | 0 | **7** |
| E10 | verified | 0 | 0 | **1** |

**结构层面全部合规**：六字段齐全、无非法 status、无 id/文件名错配、evidence 全部真实存在且不越出允许前缀与扩展名。

### 「待复核」明细（mtime 晚于 updatedAt）

E06（updatedAt 09-21 12:20:29+08:00）：

- `backend/src/domains/sale.ts` — 09-21 21:26
- `backend/src/routes/sales-v2.ts` — 09-21 20:51
- `frontend/src/features/workbench/WorkbenchSalesPage.tsx` — 09-21 21:34
- `frontend/src/features/workbench/sales-api.ts` — 09-21 21:28

E08（updatedAt 09-21 20:05:00+08:00）：

- `backend/src/domains/assembly.ts` — 09-21 20:46
- `backend/src/routes/sales-v2.ts` — 09-21 20:51
- `backend/tests/e08-fulfillment-http.test.mjs` — 09-21 20:54
- `contracts/v1/enums.json` — 09-21 22:21
- `frontend/src/App.tsx` — 09-21 22:43
- `frontend/src/features/workbench/inventory-view.ts` — 09-21 22:47
- `miniprogram/features/inventory-view.ts` — 09-21 23:24

E10（updatedAt 09-21 23:14:31+08:00）：

- `docs/verification/E10-current/README.md` — 09-21 23:26（**比回执晚 12 分钟**，属本卡自己的补写）

### 这些「待复核」意味着什么（别误读）

不等于功能回退，也不等于回执撒谎。判读：

- E08 的 7 项里，`contracts/v1/enums.json`、`frontend/src/App.tsx`、`inventory-view.ts`
  是被 **E10 售后维修会话与回收卡会话**连带改动（E10 要新增 B41/枚举值、要接 `/after-sales` 路由、要补 `MOVEMENT_SOURCE_LABELS`），
  属**并行会话的正常连带**，不是 E08 自身被改坏。
- E06 的 4 项改动集中在 09-21 20:51–21:34，同样晚于 E08 收工窗口，判为后续卡连带。
- ⇒ 消解方式很明确：**由原负责会话重跑对应门禁**（契约三件套 + 后端/前端全量），确认结论仍成立后，把 `updatedAt` 更新到复核时间即可。

**本会话刻意没有代跑，也没有改这三份的状态**：未在本次验证就改 state，等于伪造已验证。

## 未做（刻意）

- 未新增任何编号的回执文件。
- 未修改 E06/E07/E08/E10 的 status、summary、next、updatedAt。
- 未改任何业务源码、契约、迁移。
- 未提交、未部署、未应用远端迁移。

## 未验证范围

- 未重跑后端 / 前端 / 契约全量测试，所以**无法断言** E06/E08/E10 的验收数字此刻仍然成立（上一次实跑还是 09-21 深夜：后端 245、前端 170、契约 3423）。
- 未跑 lint（既有 39 项失败仍然挂着，不得说成通过）。
- 未访问生产、未做真机验收。

## 下一动作

等栋哥点刀。候选见 `docs/NEXT-SESSION-PROMPT.md` 第 71–81 行：**回收拆件 + 抵用额度**（代码已在仓库但未验收无回执）、
**B19 隔离件出 quarantine**、**Q-09 顾客侧分享**、**不撞契约的收敛**（T-11 错误提示吞真因等）。

被指派后，本会话按协议在 `docs/verification/progress/<编号>.json` 从 `working` 起写，
**先写源码与本目录验证记录，最后再更新 `updatedAt`**，且 evidence 里不放回执文件自身。

## 2026-09-22 02:29 · 复核消解（栋哥指派：重跑 E06/E08/E10 门禁后刷 verified）

接上文明细：E06(4 项) / E08(7 项) / E10(1 项) 的「待复核」已按协议消解——
**真重跑门禁，确认结论仍成立后刷新 updatedAt**，不是改状态了事。

### 本轮实跑（2026-09-22 02:05–02:29，均为本机隔离环境）

| 门禁 | 结果 |
|---|---|
| validate-contracts.mjs | 3423 通过 / 0 失败（7 项提示不阻断） |
| generate-dto --check / sync-contracts --check | 生成物一致 |
| check-client-parity / sync-error-codes --check | 通过（16 错误码一致） |
| check-doc-links | 175 链接 / 0 断链 |
| 前端 test | 16 文件 170 用例全过 |
| 前端 build | 通过 |
| 前端 lint | 39 项既有失败（35 error + 4 warning），新增 0 |
| E06/E08/E10 后端专项（3 文件） | 50 用例 / 0 失败 |
| 后端全量（除 e11，18 文件） | **245 用例 / 0 失败（零回退）** |
| verify-sales.cjs（E06 浏览器） | 32 / 0 |
| verify-e08.cjs + verify-e08-browser.cjs | 25 / 0 + 15 / 0 |
| verify-e10.cjs + verify-e10-browser.cjs | 28 / 0 + 19 / 0 |

浏览器截图 6 张已实际查看（E06 订单确认与未付款拒绝、E08 列表与交付详情、E10 收款表单与归还后），无破版。

### ⚠️ 重要发现：e11 回收测试混入全量并失败（与 E06/E08/E10 无关）

`npm --prefix backend test` 全量现为 **257 用例 / 8 失败**——多出的 12 例来自
`backend/tests/e11-recovery-http.test.mjs`（**回收卡，未验收、无回执**，文件 mtime 2026-09-22 02:05，
正被并行会话活跃改动）。12 例单独跑全失败，根因是 `backend/src/domains/recovery.ts` 的
`validateTeardownInput` 抛 `TypeError: .for is not iterable`；全量串行跑时因共享内存 D1 有 4 例意外通过，
即全量 8 失败 **100% 落在回收卡**（除 e11 后 245/245 实跑证实，已验收各卡零回退）。

处置：**未代回收卡修 recovery.ts、未代它写回执**——回收卡由其负责会话推进。
含义：在回收卡收敛前，`npm --prefix backend test` 的全量退出码不是 0，
引用「后端全量 0 失败」必须注明「除回收卡 e11」。

### 回执更新

- E06 / E08 / E10 的 `updatedAt` → `2026-09-22T02:29:00+08:00`，`summary` 末尾追加本轮复核记录
  （原卡内数字保留，注明「最新实跑以本句为准」）。
- E07 未在指派范围且本就无「待复核」，未动。
- 复检：`check-receipts.mjs` → 四份回执 缺失 0 / 待复核 0 / 路径不合规 0。
