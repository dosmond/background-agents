import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_SESSION_FOLDER_NAME_LENGTH,
  SessionFoldersStore,
  SessionFolderValidationError,
} from "./session-folders";

type FolderRow = {
  id: string;
  user_id: string;
  repo_owner: string;
  repo_name: string;
  name: string;
  created_at: number;
  updated_at: number;
};

type AssignmentRow = {
  user_id: string;
  session_id: string;
  folder_id: string;
  created_at: number;
  updated_at: number;
};

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

class FakeD1Database {
  private folders = new Map<string, FolderRow>();
  private assignments = new Map<string, AssignmentRow>();
  private usersByFolder = new Map<string, string>();

  private assignmentKey(userId: string, sessionId: string): string {
    return `${userId}:${sessionId}`;
  }

  prepare(query: string) {
    return new FakePreparedStatement(this, query);
  }

  first(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);
    if (
      normalized.startsWith(
        "SELECT id, user_id, repo_owner, repo_name, name, created_at, updated_at FROM session_folders WHERE user_id = ? AND id = ?"
      )
    ) {
      const [userId, folderId] = args as [string, string];
      const row = this.folders.get(folderId);
      if (!row || row.user_id !== userId) return null;
      return row;
    }
    if (
      normalized.startsWith(
        "SELECT COUNT(*) AS count FROM session_folder_assignments WHERE user_id = ? AND folder_id = ?"
      )
    ) {
      const [userId, folderId] = args as [string, string];
      let count = 0;
      for (const row of this.assignments.values()) {
        if (row.user_id === userId && row.folder_id === folderId) count++;
      }
      return { count };
    }
    throw new Error(`Unexpected first() query: ${query}`);
  }

  all(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);
    if (
      normalized.startsWith(
        "SELECT id, user_id, repo_owner, repo_name, name, created_at, updated_at FROM session_folders WHERE user_id = ? ORDER BY repo_owner ASC, repo_name ASC, name ASC"
      )
    ) {
      const [userId] = args as [string];
      return [...this.folders.values()]
        .filter((row) => row.user_id === userId)
        .sort((a, b) =>
          `${a.repo_owner}/${a.repo_name}/${a.name}`.localeCompare(
            `${b.repo_owner}/${b.repo_name}/${b.name}`
          )
        );
    }
    if (
      normalized.startsWith(
        "SELECT user_id, session_id, folder_id, created_at, updated_at FROM session_folder_assignments WHERE user_id = ?"
      )
    ) {
      const [userId] = args as [string];
      return [...this.assignments.values()].filter((row) => row.user_id === userId);
    }
    throw new Error(`Unexpected all() query: ${query}`);
  }

  run(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);
    if (
      normalized.startsWith(
        "INSERT INTO session_folders (id, user_id, repo_owner, repo_name, name, created_at, updated_at)"
      )
    ) {
      const [id, userId, repoOwner, repoName, name, createdAt, updatedAt] = args as [
        string,
        string,
        string,
        string,
        string,
        number,
        number,
      ];
      this.folders.set(id, {
        id,
        user_id: userId,
        repo_owner: repoOwner,
        repo_name: repoName,
        name,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      this.usersByFolder.set(id, userId);
      return { meta: { changes: 1 } };
    }
    if (
      normalized.startsWith(
        "UPDATE session_folders SET name = ?, updated_at = ? WHERE user_id = ? AND id = ?"
      )
    ) {
      const [name, updatedAt, userId, folderId] = args as [string, number, string, string];
      const row = this.folders.get(folderId);
      if (!row || row.user_id !== userId) return { meta: { changes: 0 } };
      this.folders.set(folderId, { ...row, name, updated_at: updatedAt });
      return { meta: { changes: 1 } };
    }
    if (
      normalized.startsWith(
        "DELETE FROM session_folder_assignments WHERE user_id = ? AND folder_id = ?"
      )
    ) {
      const [userId, folderId] = args as [string, string];
      for (const [key, row] of this.assignments.entries()) {
        if (row.user_id === userId && row.folder_id === folderId) {
          this.assignments.delete(key);
        }
      }
      return { meta: { changes: 1 } };
    }
    if (normalized.startsWith("DELETE FROM session_folders WHERE user_id = ? AND id = ?")) {
      const [userId, folderId] = args as [string, string];
      const row = this.folders.get(folderId);
      if (!row || row.user_id !== userId) return { meta: { changes: 0 } };
      this.folders.delete(folderId);
      this.usersByFolder.delete(folderId);
      return { meta: { changes: 1 } };
    }
    if (
      normalized.startsWith(
        "INSERT INTO session_folder_assignments (user_id, session_id, folder_id, created_at, updated_at)"
      )
    ) {
      const [userId, sessionId, folderId, createdAt, updatedAt] = args as [
        string,
        string,
        string,
        number,
        number,
      ];
      const key = this.assignmentKey(userId, sessionId);
      const existing = this.assignments.get(key);
      this.assignments.set(key, {
        user_id: userId,
        session_id: sessionId,
        folder_id: folderId,
        created_at: existing ? existing.created_at : createdAt,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }
    if (
      normalized.startsWith(
        "DELETE FROM session_folder_assignments WHERE user_id = ? AND session_id = ?"
      )
    ) {
      const [userId, sessionId] = args as [string, string];
      this.assignments.delete(this.assignmentKey(userId, sessionId));
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unexpected run() query: ${query}`);
  }
}

class FakePreparedStatement {
  private bound: unknown[] = [];

  constructor(
    private readonly db: FakeD1Database,
    private readonly query: string
  ) {}

  bind(...args: unknown[]) {
    this.bound = args;
    return this;
  }

  async first<T>() {
    return this.db.first(this.query, this.bound) as T | null;
  }

  async all<T>() {
    return { results: this.db.all(this.query, this.bound) as T[] };
  }

  async run() {
    return this.db.run(this.query, this.bound);
  }
}

describe("SessionFoldersStore", () => {
  let store: SessionFoldersStore;

  beforeEach(() => {
    const db = new FakeD1Database();
    store = new SessionFoldersStore(db as unknown as D1Database);
  });

  it("normalizes repo casing and trims folder names", async () => {
    const folder = await store.createFolder({
      userId: "u1",
      folderId: "f1",
      repoOwner: "Acme",
      repoName: "Widgets",
      name: "  Backlog  ",
    });

    expect(folder.repoOwner).toBe("acme");
    expect(folder.repoName).toBe("widgets");
    expect(folder.name).toBe("Backlog");
  });

  it("rejects empty folder names", async () => {
    await expect(
      store.createFolder({
        userId: "u1",
        folderId: "f1",
        repoOwner: "acme",
        repoName: "widgets",
        name: "   ",
      })
    ).rejects.toThrow(SessionFolderValidationError);
  });

  it("rejects too-long folder names", async () => {
    await expect(
      store.createFolder({
        userId: "u1",
        folderId: "f1",
        repoOwner: "acme",
        repoName: "widgets",
        name: "x".repeat(MAX_SESSION_FOLDER_NAME_LENGTH + 1),
      })
    ).rejects.toThrow(SessionFolderValidationError);
  });

  it("lists folders and assignments per user", async () => {
    await store.createFolder({
      userId: "u1",
      folderId: "f1",
      repoOwner: "acme",
      repoName: "widgets",
      name: "Backlog",
    });
    await store.setAssignment({ userId: "u1", sessionId: "s1", folderId: "f1" });

    const folders = await store.listFolders("u1");
    const assignments = await store.listAssignments("u1");

    expect(folders).toHaveLength(1);
    expect(assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId: "s1", folderId: "f1" })])
    );
  });

  it("deleting a folder removes assignments and reports moved count", async () => {
    await store.createFolder({
      userId: "u1",
      folderId: "f1",
      repoOwner: "acme",
      repoName: "widgets",
      name: "Backlog",
    });
    await store.setAssignment({ userId: "u1", sessionId: "s1", folderId: "f1" });
    await store.setAssignment({ userId: "u1", sessionId: "s2", folderId: "f1" });

    const result = await store.deleteFolder("u1", "f1");
    expect(result).toEqual({ existed: true, movedCount: 2 });
    expect(await store.listAssignments("u1")).toHaveLength(0);
  });
});
