-- MP17 · 顾客微信身份（与内部成员的微信绑定是两条独立链路）
-- Written: 2026-09-23
-- ⚠️ 尚未应用到任何远端环境；在明确授权前不得 apply。
--
-- 设计要点：
--   · **顾客不是内部成员**：本表不引用 store_members、也不复用 0008 的
--     wechat_identity_bindings —— 那是「员工把微信绑到成员账号」用的，
--     两者混用会让顾客拿到成员语义的授权（契约硬约束）。
--   · openid 只在**同一个 appid 下**唯一：它是相对小程序的标识，换一个小程序就不是同一个人。
--   · 当前为**单店绑定**：唯一键取 (appid, openid)，一名顾客在这个小程序里只对应一条记录。
--     多门店需求出现时须先升契约版本，再改本表的唯一键。
--   · **认领（claim）禁止仅凭顾客自填手机号** —— 自填号码可冒领他人档案。
--     只接受微信验证手机号（wechat-phone）或店员确认（clerk-confirm），取值由 CHECK 锁死。
--   · session_version 递增即让该顾客的全部旧会话失效，思路与 users.token_version 一致。
--
-- 与 0006 一致的写法：约束用**单向蕴含**表达，不写 (A) = (B) 的等价式 ——
-- 等价式会把合法的中间态（例如已建身份但尚未认领）误判为非法。

CREATE TABLE customer_wechat_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appid TEXT NOT NULL,
  openid TEXT NOT NULL,
  store_id INTEGER NOT NULL,
  -- 认领成功前为 NULL：允许「先建微信身份、后由店员确认关联」的中间态。
  customer_id INTEGER,
  claim_status TEXT NOT NULL DEFAULT 'unclaimed' CHECK (claim_status IN ('unclaimed', 'claimed', 'rejected')),
  claim_method TEXT CHECK (claim_method IS NULL OR claim_method IN ('wechat-phone', 'clerk-confirm')),
  claim_note TEXT NOT NULL DEFAULT '',
  session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  bound_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  last_seen_at TEXT,
  -- 单向蕴含：已认领必须有客户指针与认领方式；反向不强制，保留中间态。
  CHECK (claim_status <> 'claimed' OR customer_id IS NOT NULL),
  CHECK (claim_status <> 'claimed' OR claim_method IS NOT NULL),
  CHECK (claim_status <> 'rejected' OR customer_id IS NULL),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE UNIQUE INDEX idx_customer_wx_identity_appid_openid
  ON customer_wechat_identities(appid, openid);
CREATE INDEX idx_customer_wx_identity_customer
  ON customer_wechat_identities(store_id, customer_id);
