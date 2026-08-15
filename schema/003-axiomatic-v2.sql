-- Durable SQLite profile for the axiomatic v2 semantic tree and execution ledger.
-- Sequence values are storage ordering only and never participate in semantic identity.

CREATE TABLE axiomatic_roots (
  root_ref TEXT PRIMARY KEY,
  agent_ref TEXT NOT NULL,
  body_bytes BLOB NOT NULL,
  UNIQUE (agent_ref),
  CHECK (length(root_ref) = 71),
  CHECK (length(agent_ref) = 71)
) STRICT;

CREATE TABLE axiomatic_revisions (
  revision_ref TEXT PRIMARY KEY,
  root_ref TEXT NOT NULL,
  agent_ref TEXT NOT NULL,
  revision_kind TEXT NOT NULL CHECK (revision_kind IN ('root', 'node')),
  FOREIGN KEY (root_ref) REFERENCES axiomatic_roots(root_ref),
  UNIQUE (revision_ref, root_ref, agent_ref)
) STRICT;

CREATE TABLE axiomatic_nodes (
  node_ref TEXT PRIMARY KEY,
  root_ref TEXT NOT NULL,
  agent_ref TEXT NOT NULL,
  parent_ref TEXT NOT NULL,
  block_bytes BLOB NOT NULL,
  FOREIGN KEY (root_ref) REFERENCES axiomatic_roots(root_ref),
  FOREIGN KEY (parent_ref, root_ref, agent_ref)
    REFERENCES axiomatic_revisions(revision_ref, root_ref, agent_ref)
) STRICT;

CREATE TABLE axiomatic_execution_records (
  record_ref TEXT PRIMARY KEY,
  record_kind TEXT NOT NULL CHECK (record_kind IN (
    'invocation-occurrence', 'evaluation-occurrence', 'projection', 'evaluation',
    'attempt', 'emission', 'outcome', 'unknown', 'local-failure'
  )),
  body_bytes BLOB NOT NULL
) STRICT;

CREATE TABLE axiomatic_adoptions (
  adoption_key TEXT PRIMARY KEY,
  decision_ref TEXT NOT NULL UNIQUE,
  body_bytes BLOB NOT NULL
) STRICT;

CREATE TABLE axiomatic_requests (
  request_ref TEXT PRIMARY KEY,
  body_bytes BLOB NOT NULL
) STRICT;

CREATE TABLE axiomatic_commands (
  seq INTEGER PRIMARY KEY CHECK (seq > 0),
  command_ref TEXT NOT NULL UNIQUE,
  command_kind TEXT NOT NULL CHECK (command_kind IN (
    'create-root', 'materialize-invocation', 'materialize-evaluation-occurrence',
    'materialize-environment', 'materialize-endpoint', 'prepare-evaluation',
    'record-request', 'claim-attempt', 'record-emission', 'complete-evaluation',
    'mark-unknown', 'fail-local', 'adopt-evaluation'
  )),
  body_bytes BLOB NOT NULL,
  result_bytes BLOB NOT NULL,
  UNIQUE (seq, command_ref)
) STRICT;

CREATE TABLE axiomatic_command_head (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  command_seq INTEGER NOT NULL,
  command_ref TEXT NOT NULL,
  state_ref TEXT NOT NULL,
  FOREIGN KEY (command_seq, command_ref)
    REFERENCES axiomatic_commands(seq, command_ref)
) STRICT;

CREATE TABLE axiomatic_schema_manifest (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  schema_hash TEXT NOT NULL,
  threat_boundary TEXT NOT NULL
) STRICT;

CREATE TRIGGER axiomatic_roots_no_update
BEFORE UPDATE ON axiomatic_roots
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_TABLE: axiomatic_roots UPDATE forbidden');
END;

CREATE TRIGGER axiomatic_roots_no_delete
BEFORE DELETE ON axiomatic_roots
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_TABLE: axiomatic_roots DELETE forbidden');
END;

CREATE TRIGGER axiomatic_revisions_no_update
BEFORE UPDATE ON axiomatic_revisions
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_TABLE: axiomatic_revisions UPDATE forbidden');
END;

CREATE TRIGGER axiomatic_revisions_no_delete
BEFORE DELETE ON axiomatic_revisions
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_TABLE: axiomatic_revisions DELETE forbidden');
END;

CREATE TRIGGER axiomatic_nodes_no_update
BEFORE UPDATE ON axiomatic_nodes
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_TABLE: axiomatic_nodes UPDATE forbidden');
END;

CREATE TRIGGER axiomatic_nodes_no_delete
BEFORE DELETE ON axiomatic_nodes
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_TABLE: axiomatic_nodes DELETE forbidden');
END;

CREATE TRIGGER axiomatic_execution_records_no_update
BEFORE UPDATE ON axiomatic_execution_records
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_TABLE: axiomatic_execution_records UPDATE forbidden');
END;

CREATE TRIGGER axiomatic_execution_records_no_delete
BEFORE DELETE ON axiomatic_execution_records
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_TABLE: axiomatic_execution_records DELETE forbidden');
END;

CREATE TRIGGER axiomatic_adoptions_no_update
BEFORE UPDATE ON axiomatic_adoptions
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_TABLE: axiomatic_adoptions UPDATE forbidden');
END;

CREATE TRIGGER axiomatic_adoptions_no_delete
BEFORE DELETE ON axiomatic_adoptions
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_TABLE: axiomatic_adoptions DELETE forbidden');
END;

CREATE TRIGGER axiomatic_requests_no_update
BEFORE UPDATE ON axiomatic_requests
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_TABLE: axiomatic_requests UPDATE forbidden');
END;

CREATE TRIGGER axiomatic_requests_no_delete
BEFORE DELETE ON axiomatic_requests
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_TABLE: axiomatic_requests DELETE forbidden');
END;

CREATE TRIGGER axiomatic_commands_no_update
BEFORE UPDATE ON axiomatic_commands
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_TABLE: axiomatic_commands UPDATE forbidden');
END;

CREATE TRIGGER axiomatic_commands_no_delete
BEFORE DELETE ON axiomatic_commands
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_TABLE: axiomatic_commands DELETE forbidden');
END;

CREATE TRIGGER axiomatic_command_head_update_guard
BEFORE UPDATE ON axiomatic_command_head
WHEN NEW.singleton <> OLD.singleton OR NEW.command_seq <> OLD.command_seq + 1
BEGIN
  SELECT RAISE(ABORT, 'INVALID_COMMAND_HEAD_UPDATE');
END;

CREATE TRIGGER axiomatic_command_head_no_delete
BEFORE DELETE ON axiomatic_command_head
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_TABLE: axiomatic_command_head DELETE forbidden');
END;

CREATE TRIGGER axiomatic_schema_manifest_no_update
BEFORE UPDATE ON axiomatic_schema_manifest
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_TABLE: axiomatic_schema_manifest UPDATE forbidden');
END;

CREATE TRIGGER axiomatic_schema_manifest_no_delete
BEFORE DELETE ON axiomatic_schema_manifest
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_TABLE: axiomatic_schema_manifest DELETE forbidden');
END;
