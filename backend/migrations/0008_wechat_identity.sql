-- T03a · 微信身份与绑定码
-- Written: 2026-09-18
-- ⚠️ 尚未应用到任何远端：本地已验证，0004/0005/0006/0007 的远端状态见 docs/OPEN-ITEMS.md。
--    在明确授权前不得 apply。
--
-- 设计要点：
--   · 绑定码只存摘要（code_hash），明文只在生成的那一次响应里出现；
--   · 一个成员同时只能有一个待用码（部分唯一索引），防止刷一堆码到处贴；
--   · openid 只在「同一 appid 下」唯一 —— openid 是相对小程序的，换小程序就不是同一个人；
--   · 一个成员同时只能有一条有效绑定，重复绑定由 UNIQUE 拦下，不靠应用层的行数判断。

CREATE TABLE wechat_binding_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appid TEXT NOT NULL,
  store_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'revoked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  expires_at_ms INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_openid TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (member_id) REFERENCES store_members(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_wx_binding_codes_member_pending
  ON wechat_binding_codes(member_id) WHERE status = 'pending';
CREATE INDEX idx_wx_binding_codes_appid_hash
  ON wechat_binding_codes(appid, code_hash);

CREATE TABLE wechat_identity_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appid TEXT NOT NULL,
  openid TEXT NOT NULL,
  member_id INTEGER NOT NULL,
  store_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  revoked_by INTEGER,
  FOREIGN KEY (member_id) REFERENCES store_members(id),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (revoked_by) REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_wx_identity_appid_openid
  ON wechat_identity_bindings(appid, openid);
CREATE UNIQUE INDEX idx_wx_identity_member_active
  ON wechat_identity_bindings(member_id) WHERE status = 'active';
CREATE INDEX idx_wx_identity_member_lookup
  ON wechat_identity_bindings(member_id, status);
