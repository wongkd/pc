-- B36：允许将服务端生成的 HTML 单据作为受权限保护的持久附件追溯。
-- 只扩展附件用途枚举，不改变既有附件数据或对象存储内容。
-- 已应用迁移只追加，不改写；生产/远端应用须另行授权。

ALTER TABLE attachments RENAME TO attachments_before_document_export;

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  upload_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (upload_state IN ('pending', 'uploaded', 'attached', 'failed', 'orphaned')),
  purpose TEXT NOT NULL
    CHECK (purpose IN ('product_reference', 'service_intake', 'recovery_evidence', 'delivery_evidence', 'document_export')),
  visibility TEXT NOT NULL DEFAULT 'internal'
    CHECK (visibility IN ('internal', 'customer_shared')),
  object_key TEXT NOT NULL,
  declared_mime TEXT NOT NULL,
  declared_byte_size INTEGER NOT NULL,
  declared_sha256 TEXT,
  content_type TEXT,
  byte_size INTEGER,
  sha256 TEXT,
  width INTEGER,
  height INTEGER,
  owner_entity_type TEXT,
  owner_entity_id TEXT,
  upload_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  failure_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(trim(object_key)) > 0),
  CHECK (declared_byte_size > 0),
  CHECK (declared_byte_size <= 20971520),
  CHECK (
    upload_state NOT IN ('uploaded', 'attached')
    OR (sha256 IS NOT NULL AND byte_size IS NOT NULL AND content_type IS NOT NULL)
  ),
  CHECK (
    upload_state <> 'attached'
    OR (owner_entity_type IS NOT NULL AND owner_entity_id IS NOT NULL)
  ),
  CHECK (upload_state IN ('pending', 'uploaded', 'attached') OR owner_entity_type IS NULL),
  UNIQUE (store_id, object_key),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

INSERT INTO attachments (
  id, store_id, upload_state, purpose, visibility, object_key,
  declared_mime, declared_byte_size, declared_sha256, content_type, byte_size, sha256,
  width, height, owner_entity_type, owner_entity_id, upload_token_hash, expires_at,
  failure_reason, version, request_id, created_by, created_at, updated_at
)
SELECT
  id, store_id, upload_state, purpose, visibility, object_key,
  declared_mime, declared_byte_size, declared_sha256, content_type, byte_size, sha256,
  width, height, owner_entity_type, owner_entity_id, upload_token_hash, expires_at,
  failure_reason, version, request_id, created_by, created_at, updated_at
FROM attachments_before_document_export;

DROP TABLE attachments_before_document_export;

CREATE INDEX idx_attachments_store_state ON attachments(store_id, upload_state);
CREATE INDEX idx_attachments_expiry ON attachments(upload_state, expires_at);
CREATE INDEX idx_attachments_owner ON attachments(store_id, owner_entity_type, owner_entity_id);
CREATE INDEX idx_attachments_request ON attachments(store_id, request_id);
CREATE UNIQUE INDEX idx_attachments_document_revision
  ON attachments(store_id, owner_entity_type, owner_entity_id, version)
  WHERE purpose = 'document_export';
