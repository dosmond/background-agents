CREATE TABLE IF NOT EXISTS session_folders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name  TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, repo_owner, repo_name, name)
);

CREATE INDEX IF NOT EXISTS idx_session_folders_user_repo
  ON session_folders (user_id, repo_owner, repo_name);

CREATE TABLE IF NOT EXISTS session_folder_assignments (
  user_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  folder_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (folder_id) REFERENCES session_folders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_folder_assignments_user_folder
  ON session_folder_assignments (user_id, folder_id);
