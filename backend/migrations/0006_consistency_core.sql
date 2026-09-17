-- T04 · Consistency core: idempotent operations, assertion guards, entity version log.
-- Prerequisite: apply 0000 -> 0005 first. This migration only adds new tables and triggers;
-- it does not alter or drop any existing table, column, trigger or row.
-- Validation: after apply, the three tables (operations, assertion_guards, entity_version_log),
-- operation_failures, and the trigger assertion_guards_abort must appear in sqlite_master.
-- Rollback: structural rollback requires restoring a verified pre-migration D1 export.
-- Do not run this migration against production until T20 has verified the migration tracker.
--
-- Design note (measured on real workerd+D1, see docs/verification/2026-09-T04):
--   A conditional UPDATE that matches 0 rows is NOT a SQL error. Inside a D1 batch the later
--   statements still run, which silently produces half-written records. The mechanisms below
--   turn every "this must have happened" assumption into a hard constraint violation, so the
--   whole batch rolls back instead of continuing. Nothing here relies on Worker memory locks.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. operations · idempotency record for every critical write action
--    Uniqueness of (store_id, request_id) is the idempotency assertion itself: a duplicate
--    insert fails, so a concurrent repeat can never execute the payload twice.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded')),
  result_json TEXT NOT NULL DEFAULT '{}',
  result_entity_type TEXT,
  result_entity_id TEXT,
  result_version INTEGER CHECK (result_version IS NULL OR result_version >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (store_id, request_id),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);

CREATE INDEX idx_operations_store_created ON operations(store_id, created_at DESC);
CREATE INDEX idx_operations_action ON operations(store_id, action, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. assertion_guards · generic guard that aborts a whole batch
--    Usage inside a batch, after the statement whose effect must be asserted:
--      INSERT INTO assertion_guards (code) SELECT 'VERSION_CONFLICT' WHERE NOT EXISTS (...);
--    When the condition holds, no row is inserted and the batch continues silently.
--    When the condition fails, the row is inserted and the trigger raises, aborting the
--    entire batch with the error code carried in the message.
--    This table must stay empty at rest; any row in it means a bug.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE assertion_guards (
  code TEXT NOT NULL
);

CREATE TRIGGER assertion_guards_abort
BEFORE INSERT ON assertion_guards
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, NEW.code);
END;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. entity_version_log · optimistic concurrency without "check 0 rows"
--    Bumping a version means inserting a new row here. The primary key is the assertion:
--    two clients racing from version N both try to insert N+1 and exactly one wins,
--    the loser's batch aborts with a primary-key violation. The owning business table
--    keeps a denormalised version column for cheap reads; this log stays the source of truth
--    for history and for the "(entity, version) must be newly created" guarantee.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE entity_version_log (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  request_id TEXT NOT NULL,
  store_id INTEGER NOT NULL,
  actor_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entity_type, entity_id, version),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);

CREATE INDEX idx_entity_version_log_store_created ON entity_version_log(store_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. operation_failures · redacted failure diagnostics
--    A failed action rolls back completely, so operations keeps no row for it. These
--    diagnostics are written outside the failed batch and are explicitly NOT accounting
--    records: the table name must never be read as proof that an action succeeded.
--    Never store tokens, secrets, raw request bodies or full customer payloads here.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE operation_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  error_code TEXT NOT NULL,
  diagnostic TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (store_id) REFERENCES stores(id)
);

CREATE INDEX idx_operation_failures_store_created ON operation_failures(store_id, created_at DESC);
CREATE INDEX idx_operation_failures_request ON operation_failures(store_id, request_id);
