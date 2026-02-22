-- Repository-scoped contextual documents and derived decision graph.
CREATE TABLE IF NOT EXISTS repo_context_documents (
  id               TEXT    NOT NULL,
  repo_owner       TEXT    NOT NULL,
  repo_name        TEXT    NOT NULL,
  title            TEXT    NOT NULL,
  source_type      TEXT    NOT NULL, -- meeting | slack | linear | note | upload | other
  content          TEXT    NOT NULL,
  tags             TEXT,             -- JSON array of strings
  timeframe_start  INTEGER,
  timeframe_end    INTEGER,
  metadata         TEXT,             -- JSON object
  ingest_status    TEXT    NOT NULL, -- pending_index | indexed | failed
  indexed_at       INTEGER,
  created_by       TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (repo_owner, repo_name, id)
);

CREATE INDEX IF NOT EXISTS idx_repo_context_documents_repo_updated
  ON repo_context_documents (repo_owner, repo_name, updated_at DESC);

CREATE TABLE IF NOT EXISTS repo_context_decisions (
  id            TEXT    NOT NULL,
  repo_owner    TEXT    NOT NULL,
  repo_name     TEXT    NOT NULL,
  document_id   TEXT,
  title         TEXT    NOT NULL,
  summary       TEXT    NOT NULL,
  status        TEXT    NOT NULL, -- active | superseded | draft
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (repo_owner, repo_name, id)
);

CREATE INDEX IF NOT EXISTS idx_repo_context_decisions_repo_updated
  ON repo_context_decisions (repo_owner, repo_name, updated_at DESC);

CREATE TABLE IF NOT EXISTS repo_context_decision_edges (
  repo_owner        TEXT    NOT NULL,
  repo_name         TEXT    NOT NULL,
  from_decision_id  TEXT    NOT NULL,
  to_decision_id    TEXT    NOT NULL,
  edge_type         TEXT    NOT NULL, -- supersedes | related
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (repo_owner, repo_name, from_decision_id, to_decision_id, edge_type)
);
