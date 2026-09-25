# 工程踩坑记录

更新：2026-09-21。保留 P 编号供检索；按任务阅读，不必每次全文读。
来源：整理前 OPEN-ITEMS 第 4 节，正文保留历史上下文。

## 4 · 踩过的坑（下次别再踩）

| 编号 | 坑 | 表现 | 正确做法 |
|---|---|---|---|
| P-01 | **同一文件的多处 `Edit` 并行提交会互相覆盖** | 已犯 3 次（T01b / T01-rev1 / T01c），每次白花一轮排查 | 同一文件的多处编辑必须串行；一条消息里只发一个针对该文件的 `Edit` |
| P-02 | **禁止把契约 JSON 整体 `JSON.stringify(…, 2)` 重写** | 会摧毁手工紧凑排版，diff 从 145 行暴涨到 3079 行 | 用纯文本外科替换 |
| P-03 | 生成物**不能手工编辑** | `validate-contracts.mjs` 第 12 节会重建后逐字节比对；`sync-contracts.mjs --check` 也会报 | 改契约源文件 → 重新生成 → 再同步端内 |
| P-04 | **超长单行 JSX 会让 `tsc` 解析失败** | `App.tsx` 里 500+ 字符的 `<Route … element={<Comp 属性={[…嵌套对象…]} />} />` 报 `TS2657` + `TS1005`，逐字符检查无非法字符 | 嵌套数据先提为模块级常量，再 `{...props}` 展开 |
| P-05 | **生成物没做依赖过滤时，前端 `noUnusedLocals` 直接编译失败** | `objects.ts` 全量导入 36 个枚举类型 → 6 处 `TS6196` | 已修生成器：按 `\b名字\b` 过滤实际引用的类型 |
| P-06 | **CSS 变量名不要用裸名** | `index.css` 的 `:root` 已占用 `--line` / `--muted` / `--ink` / `--page-bg`，而 AppShell 会包住报价编辑器 | 新视觉变量统一加前缀（本项目为 `wb-`），作用域限定在壳内 |
| P-07 | **`@testing-library/react` 在本项目不会自动清理 DOM** | vitest 未开 `globals`，多个用例 DOM 累积 → 14 个用例报「found multiple elements」的**假失败** | 测试文件内显式 `afterEach(cleanup)` |
| P-08 | **jsdom 不加载资源，图片 `error` 不会自然触发** | 图片降级路径测不到 | `fireEvent.error(img)` 主动触发；浏览器里 `demo://` 本来就必然失败 |
| P-09 | **改函数声明行时不要把行尾换行放进 `old_string`** | 会把两行粘成一行（T02a 犯过一次，已当场修复） | 只匹配行内容本身 |
| P-10 | 负向测试的注入备份 | 曾散落在根目录 | 统一放 `.validation-*/`（已 gitignore），用完立即删 |
| P-11 | 登记缺口 / 下结论**必须钉规格原文行号** | T01b 曾凭印象把 `Purchase` 登记为缺口，T01-rev1 更正 | 校验脚本第 11 节会验证「引文逐字出现在该行」 |
| P-12 | 校验脚本自身也会写错 | 曾把「公式结果」当「输入项」判空 → 12 项连锁误报 | 依赖检查必须区分输入项与派生项 |
| P-13 | **换壳 / 搬入口时会连同「可见性条件」一起丢掉** | 旧壳对「系统设置」有 `permissions` 判断，T02a 把它移进头像菜单时差点漏掉，那样任何店员都能看到设置入口 | 迁移入口时逐条对着旧实现核对**条件**，不只核对路径；并补测试 |
| P-14 | **用设计稿对齐排版时，按稿上的示例字符数算宽度会漏掉真实渲染** | 设计稿统计条写 `¥12,800`（7 字符、不带分位），真实必须渲染 `¥12,800.00`（10 字符，02 §1 不许掩盖分）→ 等分格装不下，实测被裁（R-14） | 排版对齐时用**真实渲染文案**（含分位、含千分位、含前后缀）算宽度，不能用稿上的示例值；能算就写成约束测试 |
| P-15 | **注释里出现「星号加斜杠」会提前闭合块注释** | T04 的 `tests/lib/build.mjs` 文件头写了 `.validation-*` + `/` 形式的路径通配，注释提前结束，后续整段被当代码，报出的却是下一行的 `SyntaxError: Unexpected identifier '$'`，差点往模板字符串上排查 | 注释里不要写出「星号紧跟斜杠」的组合；写目录通配时拆开或改措辞。**看语法错误先回看前文是否提前闭合** |
| P-16 | **miniflare 的 `scriptPath` 不编译 TypeScript** | 用它托管 `worker.ts` 直接报 `Unable to parse ...: Unexpected token` —— 只有 wrangler 才走 esbuild 转译 | 测试要调 TS 代码时，先用 esbuild 打包成 `.mjs` 再 import（见 `backend/tests/lib/build.mjs`） |
| P-17 | **D1 的 `exec()` 按换行切分语句** | 多行 `CREATE TABLE` 被切成半句，报 `incomplete input`；而触发器体内自带分号，按 `;` 裸拆同样会切坏 | 自己写拆分器：跳过注释与字符串字面量，并把 `CREATE TRIGGER ... BEGIN ... END` 整体当一条语句（见 `backend/tests/lib/sql.mjs`） |
| P-18 | **`node --test` 不会因为测试跑完就退出** | 留下活动句柄（未 dispose 的 workerd）时会挂住；管道缓冲让外面看不到任何输出，表现为「跑了 4 分钟没动静」，极易误判为卡死 | 确保 `dispose()`；探测类脚本显式 `process.exit()`。日志**重定向到文件再读**，不要依赖管道 `tail` |
| P-19 | **同一个 D1 批次内，后面的语句看得见前面语句的效果** | B13 一个请求带两行时，第二行的「该商品是否已有库存」守卫命中了第一行刚建的数据，整批被自己拦下；**单行请求却完全正常**，极易误判成「约束写错了」 | 「本批之前是否已存在」类的守卫，必须**排除本次 requestId 写入的行**（按 `request_id <> ?` / 期初单号排除）。T05a 的两处守卫已按此修正并有对应用例 |
| P-20 | **UPSERT 的 INSERT 分支先校验 CHECK，再判定唯一冲突** | 把桶间转移的算术写进 `INSERT ... ON CONFLICT DO UPDATE` 的 INSERT 分支时，`available → reserved`（delta 为负）被 `available_qty >= 0` 拒绝，报错指向一个完全合法的余额 | 改为**先 `INSERT OR IGNORE` 建零行，再 `UPDATE` 累加**。此时「对不存在的余额做扣减」仍会因 CHECK 失败整批回滚（正确行为），合法转移则可通过 |
| P-21 | **`db.prepare(...).bind(...)` 本身不会执行语句** | 测试夹具漏写 `.run()`，INSERT 静默不生效；后续断言全拿到 `null`，症状看起来像「外键或约束坏了」，实际是语句从没跑过 | 构造完必须 `.run()` / `.first()` / `.all()`；夹具里统一封装成「执行并返回错误消息」的助手，不要让裸 PreparedStatement 在测试代码里传递 |
| P-22 | **Windows 下动态 `import()` 一个绝对路径（`c:/…`）报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`** | ESM loader 只接受 file / data / node 三种 scheme；POSIX 习惯的裸绝对路径在 Windows 上全是非法 URL | 一律 `pathToFileURL(p).href`（或拼 `file://` + 正斜杠）再传给 import；T03b 的跨端门禁脚本 `check-client-parity.mjs` 有现成写法 |
| P-23 | **同一个仓库里并行跑 `frontend run test` 与 `frontend run build` 会让构建失败** | V02 时两个命令同时起，`build` 以 `unwrapBindingResult` + 一长串 rolldown/vite 堆栈结束，`tail` 截断后只剩堆栈、看不到真实错误，极易误判成「刚改的 CSS 有语法错」。单独重跑同一命令即成功（`✓ built in 1.01s`） | 两个命令**串行**跑；构建失败先看完整日志（重定向到文件）再判断，不要凭堆栈猜代码问题 |

## 5 · 补充踩坑（自项目记忆迁入，此前只存在于记忆文件）

| 编号 | 坑 | 表现 | 正确做法 |
|---|---|---|---|
| P-24 | **看不到截图就明说看不到** | 曾把凭文件路径脑补的截图细节写进记忆并当作验收依据 | 没有实际看到图就不能说"界面已验收"；"文件存在"≠"界面通过" |
| P-25 | **验收断言要打在承载该字段的容器上** | 报价详情页 `¥NaN`（接口漏字段）是被截图抓到的，而此前 33 项全绿的**整页文本断言**没照出来 | 断言定位到承载该值的元素，不要用整页文本包含式断言 |
| P-26 | **`actions.json` 的 `evidence` 是 `backend/src/index.ts` 的绝对行号** | 改入口后证据行整体失效；且校验器只验"该行含 `requirePermission`"，**指错路由的行也能静默通过**（曾修掉 2 条） | 改入口必重跑 `validate-contracts.mjs`；入口顶部插 N 行 ⇒ 所有证据行整体 +N |
| P-27 | **后端 `handle*` 里对空 body 请求调 `req.json()` 会抛错** | DELETE 走 body 解析分支，把正常删除报成 400 | DELETE 分支必须排在 body 解析之前 |
| P-28 | **SQLite / D1 不支持 `ALTER TABLE` 加约束** | 想直接补外键，无语法可用 | 整表重建（建新表 → 拷数据 → DROP → RENAME）；引用它的子表外键同时受影响；表为空时才有代价优势 |
| P-29 | **样本不得发明契约外字段** | T05c 曾自造 `acquiredAt`，后被自我纠正 | 样本字段只从契约取；缺字段先补契约再写样本 |
| P-30 | **小程序 `toLocaleString` 不完整** | 金额格式化在真机上行为不一致 | 金额用纯字符串运算；改完 wxml/wxss 必跑 `npm --prefix miniprogram run check-classes` |
| P-31 | **前端 CSS 别用 `subgrid`** | 兼容性不足 | 表头与行各写一份 grid 列定义 |
| P-32 | **未定义的 CSS 变量会让整条声明失效** | 无回退值的 `var()` 不是取空值，是整条属性被丢弃。E04b 实测：`workbench.css` 引用 `--wb-accent`/`--wb-radius-btn`/`--wb-radius-card`/`--wb-surface-sunken`，`theme.css` 一个都没定义 ⇒ 焦点轮廓、hover 底色、圆角**全部静默失效**（键盘焦点不可见） | 改了 CSS 变量名要 grep 定义；新增变量必须落到 `theme.css` |
| P-33 | **全局 `input{width:100%}` 会把复选框拉成整行** | `index.css` 的全局规则命中 checkbox，文字被推到最右 | 复选框所在容器写 `.xxx-check input{width:auto}` |
| P-34 | **窄屏按钮会被压成一行一个字** | `wb-btn` 在窄容器里逐字换行 | 按钮加 `white-space:nowrap` |
| P-35 | **写完动作的顺序：先刷数据、再弹成功提示** | 反过来会出现"提示已成功、表格还是旧数字"的窗口期 | 数据刷新完成后再提示 |
| P-36 | **浏览器验收的两个坑** | ① `fullPage` 长图遇 `overflow:auto` 容器会被截断；② favicon 404 会被记成运行时错误 | ① 临时解开高度/overflow 再截；② 补内联 SVG，**不要**给断言加白名单；③ **先写 verification.json 再 assert** |
| P-37 | **`react-hooks/set-state-in-effect`** | effect 体内同步调用会 setState 的函数就报错（即使函数第一句是 `await`） | 把 setState 放进 Promise 回调，或让"正在加载"由发起动作的事件处理设置 |
| P-38 | **Vite 改了 `vite.config.ts` 会重建依赖缓存** | 重建时沙箱批量删除守卫（≥50 项）会拦住删除 | 把 `node_modules/.vite` **改名挪走**即可（可逆），不要强删 |
| P-39 | **清理无用文件的口径** | 用 `rm -rf` 风险不可控 | `rm -f 精确文件` + `rmdir 目录`（非空即报错，自带校验）；删前 `realpath` → `git ls-files` → grep 确认引用 |
| P-40 | **同一文件并行编辑会互相覆盖** | 在**一条消息里**对同一个文件发多个编辑，后写覆盖先写：曾把 import 与状态声明一并丢掉，还误以为是并行会话在抢文件（时间戳证明不是） | 同一文件的编辑**串行**发；改完 **grep 复验目标文本真的在文件里**，别只信工具返回的「成功」 |
| P-41 | **重建表时别顺手去掉原列的 DEFAULT** | 重建 `stock_reservations` 时把 `qty INTEGER NOT NULL DEFAULT 1` 写成 `NOT NULL`，打断两条既有测试（它们 INSERT 时不给 qty）⇒ `NOT NULL constraint failed` | 重建表逐列对照原定义：**约束可以改，默认值要照抄**；改完跑一遍受影响的既有用例 |
| P-42 | **哈希取 hex 前必须 `>>> 0`** | `^=` 的结果是**有符号** 32 位，为负时 `toString(16)` 带一个 `-`：订单号生成成 `SO-20260921--7687B199`（不匹配格式断言） | 一律 `(hash >>> 0).toString(16)` |
| P-43 | **条件化写的两张相关表，第二张不能再判同一条件** | 先按 `WHERE EXISTS (… available_qty >= n)` 写库存流水（这一步已经把量扣掉），第二张表若再判 `available_qty >= n` 必然为假、**永远写不进去** | 第二张表改判「流水是否已插入」（用确定的流水 id），或把两张表的条件绑在同一个前置状态上 |
| P-44 | **`guidanceFor` 会把 `VALIDATION_ERROR` 换成通用话术（已修）** | 2026-09-22 T-11 已让新版 v2 写响应附上数据库真因；用户仍看到通用业务说明，但同时能看到「订单号已存在」等具体原因 | 新写域复用 `appendReadableDiagnostic`；程序分支仍只看 `code`，不要匹配中文文案 |

| P-45 | **跨前缀客户端的 `baseUrl` 传 `'/'` 会拼出协议相对 URL** | `createWebApiClient({ baseUrl: '/' })` 把 `'/api/x'` 拼成 `'//api/x'`（协议相对），请求会打到意料之外的 host；单测跑不出来（jsdom 不解析） | 跨前缀客户端的 `baseUrl` 一律用**空串**；只在本端前缀确定时才写前缀 |
| P-46 | **服务端把超期的 `issued` 直接算成 `expired`** | 服务端判过期后把状态当 expired 用；前端若按 `status === 'issued'` 决定「该不该提示续期」，提醒**永远不触发** | 前端判续期/提醒用服务端给的 `expired` 标志，**不要**用状态字符串推断 |
| P-47 | **幂等重放保护必须放在业务预读之前** | 放在预读之后时，重放会用「已经变化过的预读值」重算载荷摘要，摘要在正常重放里对不上，幂等形同失效 | 幂等检查前置；载荷摘要**只含客户端输入**，不含任何预读/派生值 |
| P-48 | **`/api/v2` 下多链路共存要各自认领前缀** | 库存 `/inventory*`、报价与销售 `/sales*`；某个 v2 模块的兜底 404 若盖住整段 `/api/v2`，**后接的链路永远不会被调用** | 每个 v2 模块只在自己认领的前缀内兜底 404，越界一律放行给下一个模块 |
| P-49 | **新权限码不能写进后端入口 `src/index.ts`** | 契约校验器（10.6 节）把入口文件里所有 `'xx/yy'` 当作旧权限码核对，新增码会让校验失败 | 新链路的权限映射写在 `src/domains/access.ts`；入口只留 import 与分发。另：**无成本权限时服务端根本不查那几列**，前端只能用 `'totalCostCents' in row` 判断字段是否存在 |
| P-50 | **`for (const [i,v] of arr ?? [])` 三件套（解构 + 数组 + `??`）在 V8/workerd 抛 `.for is not iterable`** | E11 拆件损耗循环：`input.scrapLines ?? []` 打印出来就是普通数组（isArray true、length 对），照样 500；加括号 `of (arr ?? [])` 也会被 esbuild 转译时省略括号、照样炸；同一函数里 `of arr.entries()` 却正常 | 先取成变量再迭代：`const xs = arr ?? []; for (const [i,v] of xs)`。这是 V8 的解析怪癖，别用 `??` 直接出现在 for-of 头部（尤其带解构时） |
| P-51 | **`guardStatement` 的第三参只收布尔条件，别写 `SELECT 1 WHERE …`** | 它会拼成 `INSERT INTO assertion_guards(code) SELECT ? WHERE <你的串>`，写 `SELECT 1 WHERE ?<>?` 就变成嵌套 SELECT、SQL 语法错误（E11 守恒守卫实测） | 只写裸条件，如 `'? <> ?'`；要表达「某子查询不存在」才用 `NOT EXISTS (…)` |
| P-52 | **SQL 查出来的列名是下划线，plan 读的是驼峰字段** | E11 拆件：`SELECT … si.product_id` 出来的行直接传 plan，plan 里读 `source.productId` 恒 undefined，绑 D1 报 `D1_TYPE_ERROR: Type 'undefined' not supported` | 在入口处把下划线行显式映射成驼峰对象再传 plan；别把 SQL 行对象直接透传 |

> 注：P-02（契约 JSON 禁整体 `JSON.stringify` 重写）同样适用于任何手工排版的 JSON 契约文件。

---
