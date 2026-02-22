export const MAX_SESSION_FOLDER_NAME_LENGTH = 64;

export interface SessionFolder {
  id: string;
  userId: string;
  repoOwner: string;
  repoName: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionFolderAssignment {
  userId: string;
  sessionId: string;
  folderId: string;
  createdAt: number;
  updatedAt: number;
}

interface SessionFolderRow {
  id: string;
  user_id: string;
  repo_owner: string;
  repo_name: string;
  name: string;
  created_at: number;
  updated_at: number;
}

interface SessionFolderAssignmentRow {
  user_id: string;
  session_id: string;
  folder_id: string;
  created_at: number;
  updated_at: number;
}

export class SessionFolderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionFolderValidationError";
  }
}

function toFolder(row: SessionFolderRow): SessionFolder {
  return {
    id: row.id,
    userId: row.user_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAssignment(row: SessionFolderAssignmentRow): SessionFolderAssignment {
  return {
    userId: row.user_id,
    sessionId: row.session_id,
    folderId: row.folder_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SessionFoldersStore {
  constructor(private readonly db: D1Database) {}

  async listFolders(userId: string): Promise<SessionFolder[]> {
    const result = await this.db
      .prepare(
        `SELECT id, user_id, repo_owner, repo_name, name, created_at, updated_at
         FROM session_folders
         WHERE user_id = ?
         ORDER BY repo_owner ASC, repo_name ASC, name ASC`
      )
      .bind(userId)
      .all<SessionFolderRow>();

    return (result.results ?? []).map(toFolder);
  }

  async listAssignments(userId: string): Promise<SessionFolderAssignment[]> {
    const result = await this.db
      .prepare(
        `SELECT user_id, session_id, folder_id, created_at, updated_at
         FROM session_folder_assignments
         WHERE user_id = ?`
      )
      .bind(userId)
      .all<SessionFolderAssignmentRow>();

    return (result.results ?? []).map(toAssignment);
  }

  async getFolder(userId: string, folderId: string): Promise<SessionFolder | null> {
    const row = await this.db
      .prepare(
        `SELECT id, user_id, repo_owner, repo_name, name, created_at, updated_at
         FROM session_folders
         WHERE user_id = ? AND id = ?`
      )
      .bind(userId, folderId)
      .first<SessionFolderRow>();

    return row ? toFolder(row) : null;
  }

  async createFolder(input: {
    userId: string;
    folderId: string;
    repoOwner: string;
    repoName: string;
    name: string;
  }): Promise<SessionFolder> {
    const name = this.validateAndNormalizeName(input.name);
    const repoOwner = input.repoOwner.trim().toLowerCase();
    const repoName = input.repoName.trim().toLowerCase();
    if (!repoOwner || !repoName) {
      throw new SessionFolderValidationError("repoOwner and repoName are required");
    }

    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO session_folders (id, user_id, repo_owner, repo_name, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(input.folderId, input.userId, repoOwner, repoName, name, now, now)
      .run();

    return {
      id: input.folderId,
      userId: input.userId,
      repoOwner,
      repoName,
      name,
      createdAt: now,
      updatedAt: now,
    };
  }

  async renameFolder(
    userId: string,
    folderId: string,
    nameInput: string
  ): Promise<SessionFolder | null> {
    const existing = await this.getFolder(userId, folderId);
    if (!existing) return null;

    const name = this.validateAndNormalizeName(nameInput);
    await this.db
      .prepare(
        `UPDATE session_folders
         SET name = ?, updated_at = ?
         WHERE user_id = ? AND id = ?`
      )
      .bind(name, Date.now(), userId, folderId)
      .run();

    return this.getFolder(userId, folderId);
  }

  async deleteFolder(
    userId: string,
    folderId: string
  ): Promise<{ existed: boolean; movedCount: number }> {
    const existing = await this.getFolder(userId, folderId);
    if (!existing) {
      return { existed: false, movedCount: 0 };
    }

    const countResult = await this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM session_folder_assignments
         WHERE user_id = ? AND folder_id = ?`
      )
      .bind(userId, folderId)
      .first<{ count: number }>();
    const movedCount = countResult?.count ?? 0;

    // Moving to unfiled means removing assignment rows for this folder.
    await this.db
      .prepare(
        `DELETE FROM session_folder_assignments
         WHERE user_id = ? AND folder_id = ?`
      )
      .bind(userId, folderId)
      .run();

    await this.db
      .prepare(
        `DELETE FROM session_folders
         WHERE user_id = ? AND id = ?`
      )
      .bind(userId, folderId)
      .run();

    return { existed: true, movedCount };
  }

  async setAssignment(input: {
    userId: string;
    sessionId: string;
    folderId: string;
  }): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO session_folder_assignments (user_id, session_id, folder_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, session_id) DO UPDATE SET
           folder_id = excluded.folder_id,
           updated_at = excluded.updated_at`
      )
      .bind(input.userId, input.sessionId, input.folderId, now, now)
      .run();
  }

  async clearAssignment(userId: string, sessionId: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM session_folder_assignments
         WHERE user_id = ? AND session_id = ?`
      )
      .bind(userId, sessionId)
      .run();
  }

  private validateAndNormalizeName(nameInput: string): string {
    if (typeof nameInput !== "string") {
      throw new SessionFolderValidationError("name must be a string");
    }

    const name = nameInput.trim();
    if (!name) {
      throw new SessionFolderValidationError("name must not be empty");
    }

    if (name.length > MAX_SESSION_FOLDER_NAME_LENGTH) {
      throw new SessionFolderValidationError(
        `name must be <= ${MAX_SESSION_FOLDER_NAME_LENGTH} characters`
      );
    }

    return name;
  }
}
