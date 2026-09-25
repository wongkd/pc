-- F1 · 附件基础（B35）：上传意图与业务附件元数据一张表。
--
-- Prerequisite: apply 0000 -> 0021 first（0021 为 E12 的 trade_ins / offsets）。
-- Additive only: 本迁移只新增一张表，不重建任何既有表，不碰库存、资金与既有业务表。
--
-- 契约依据（contracts/v1）：
--   objects.json  Attachment           —— ownerEntityRef / purpose / objectKey / contentType / byteSize /
--                                         width / height / sha256 / uploadState / visibility
--   enums.json    AttachmentPurpose    —— product_reference / service_intake / recovery_evidence / delivery_evidence
--                 AttachmentUploadState—— pending / uploaded / attached / failed / orphaned
--                 AttachmentVisibility —— internal / customer_shared
--                 stateMachines.AttachmentUploadState（F1 补入的转换表）
--   actions.json  B35 附件上传         —— POST /attachments/upload-intents
--                                         PUT  /attachments/upload-intents/:id/blob
--                                         POST /attachments/upload-intents/:id/complete
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 设计要点
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. 对象存储与 D1 不构成同一事务（04 §7 第 9 条）。本表只存**元数据与状态**，
--    字节在对象存储。流程被刻意拆成两段：先签发意图并落 pending 行，字节写成功后才
--    置 uploaded，最后完成确认才置 attached。业务记录只能引用 attached 行（契约 rules）。
--    本表不存任何公开永久访问地址 —— 需要读图时由服务端按权限签发临时读取地址。
--
-- 2. 「约束即断言」：upload_state = uploaded / attached 时，说明服务端**已经实测过**这条
--    附件（sha256 / byte_size / content_type 三项都是服务端算的，不是客户端报的）。
--    这三项缺失却标 uploaded/attached，是半截账，必须在数据库层挡住，不能只靠代码自觉。
--    declared_* 三列保留客户端原始声明，用于「声明与实际不符」的比对与审计留痕。
--
-- 3. 孤立上传（04 §7 第 9 条要求明确保留期与引用检查）：
--    expires_at 是保留期终点。到点仍未 attached 的行即孤立上传，由清理路径置 orphaned
--    并删除对象存储字节。清理不依赖定时任务也能工作（签发新意图时惰性扫同店过期行），
--    要精确排程再加 CF Cron，不是本迁移的前置。
--
-- 4. 门店隔离：object_key 由服务端拼接并带 store 前缀，本表另有 store_id 列，
--    读取一律带 store_id 条件。owner_entity_* 是**泛化引用**（接修工单 / 回收单 /
--    实物 / 销售单都可能挂附件），因此不建外键 —— 但关联时必须校验该实体确实属于同店。
--
-- 5. 幂等与重复完成保护：签发与完成都走 domains/operations.ts 的幂等执行器
--    （同门店 + requestId 唯一）。本表的 request_id 列只作审计留痕，不作为幂等键。
--
-- Rollback: structural rollback requires restoring a verified pre-migration D1 export.
-- ⚠️ 与 0004–0021 一样，本文件在明确授权前不得 apply 到任何远端环境。

-- ─────────────────────────────────────────────────────────────────────────────
-- attachments · 上传意图与附件元数据（契约 Attachment）
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,

  -- 状态与分类（取值与枚举对齐，见头注释）
  upload_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (upload_state IN ('pending', 'uploaded', 'attached', 'failed', 'orphaned')),
  purpose TEXT NOT NULL
    CHECK (purpose IN ('product_reference', 'service_intake', 'recovery_evidence', 'delivery_evidence')),
  visibility TEXT NOT NULL DEFAULT 'internal'
    CHECK (visibility IN ('internal', 'customer_shared')),

  -- 对象存储定位
  object_key TEXT NOT NULL,
  -- declared_* 是客户端在签发时的声明；其余三列是服务端写字节后实测回填的值。
  declared_mime TEXT NOT NULL,
  declared_byte_size INTEGER NOT NULL,
  declared_sha256 TEXT,
  content_type TEXT,
  byte_size INTEGER,
  sha256 TEXT,
  width INTEGER,
  height INTEGER,

  -- 业务关联（attached 时才写；泛化引用，关联时另行校验同店归属）
  owner_entity_type TEXT,
  owner_entity_id TEXT,

  -- 一次性上传凭证只存摘要，不存明文（与分享凭证同一口径）
  upload_token_hash TEXT NOT NULL,
  -- 保留期终点；到期仍未 attached 即孤立上传
  expires_at TEXT NOT NULL,

  -- 失败原因（upload_state = failed 时写），不占有效存储
  failure_reason TEXT,

  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(object_key)) > 0),
  CHECK (declared_byte_size > 0),
  -- 兜底硬上限 20MB：契约的产品预算是「客户端压缩后 ≤2MB」，那是压缩目标不是平台上限，
  -- 这里挡的是明显异常的大对象，不把产品预算写成硬约束。
  CHECK (declared_byte_size <= 20971520),
  -- 标记为已上传 / 已关联的行，必须已经有服务端实测的三项（防止半截账）。
  -- 单向蕴含：反方向不成立 —— orphaned 行是从 uploaded 回收来的，保留实测元数据是对的
  -- （审计要能看出「当时确实传上去过、内容是什么」，只是没关联业务对象）。
  CHECK (
    upload_state NOT IN ('uploaded', 'attached')
    OR (sha256 IS NOT NULL AND byte_size IS NOT NULL AND content_type IS NOT NULL)
  ),
  -- attached 必须真的挂到某个业务实体上（单向蕴含：非 attached 状态不受此项约束，
  -- 因为签发时就要声明归属意图，那只是一个待验证的目标）。
  CHECK (
    upload_state <> 'attached'
    OR (owner_entity_type IS NOT NULL AND owner_entity_id IS NOT NULL)
  ),
  -- 已失效的行（failed / orphaned）不得保留业务关联；pending 行可以带「意图关联」，
  -- 真正的关联生效只认 upload_state = attached，读取时按该状态过滤。
  CHECK (upload_state IN ('pending', 'uploaded', 'attached') OR owner_entity_type IS NULL),

  UNIQUE (store_id, object_key),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- 按状态翻同店附件（列表与进度）
CREATE INDEX idx_attachments_store_state ON attachments(store_id, upload_state);
-- 孤立上传清理扫描：按保留期找未关联行
CREATE INDEX idx_attachments_expiry ON attachments(upload_state, expires_at);
-- 按业务实体取附件（接修 / 回收详情页）
CREATE INDEX idx_attachments_owner ON attachments(store_id, owner_entity_type, owner_entity_id);
-- 幂等重放时按签发请求回查
CREATE INDEX idx_attachments_request ON attachments(store_id, request_id);
