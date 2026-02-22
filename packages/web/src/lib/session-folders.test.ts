import { describe, expect, it } from "vitest";
import {
  buildGroupedSessions,
  type SessionFoldersResponse,
  type SessionListItem,
} from "./session-folders";

const now = Date.now();

function makeSession(
  partial: Partial<SessionListItem> & Pick<SessionListItem, "id">
): SessionListItem {
  return {
    id: partial.id,
    title: partial.title ?? null,
    repoOwner: partial.repoOwner ?? "acme",
    repoName: partial.repoName ?? "widgets",
    status: partial.status ?? "active",
    createdAt: partial.createdAt ?? now - 1000,
    updatedAt: partial.updatedAt ?? now - 1000,
  };
}

describe("buildGroupedSessions", () => {
  it("groups sessions by repo and folders with unfiled fallback", () => {
    const sessions: SessionListItem[] = [
      makeSession({ id: "s1", title: "One", updatedAt: now - 100 }),
      makeSession({ id: "s2", title: "Two", updatedAt: now - 200 }),
      makeSession({ id: "s3", title: "Other repo", repoName: "api", updatedAt: now - 300 }),
    ];
    const folderData: SessionFoldersResponse = {
      folders: [
        { id: "f1", repoOwner: "acme", repoName: "widgets", name: "Backlog" },
        { id: "f2", repoOwner: "acme", repoName: "api", name: "Bugs" },
      ],
      assignments: [
        { sessionId: "s2", folderId: "f1" },
        { sessionId: "s3", folderId: "f2" },
      ],
    };

    const grouped = buildGroupedSessions(sessions, "", folderData);
    expect(grouped.activeRepoGroups).toHaveLength(2);
    const widgets = grouped.activeRepoGroups.find((group) => group.key === "acme/widgets");
    expect(widgets?.unfiled.map((session) => session.id)).toEqual(["s1"]);
    expect(widgets?.folders[0]?.sessions.map((session) => session.id)).toEqual(["s2"]);
  });

  it("falls back to unfiled if assignment folder is missing", () => {
    const sessions = [makeSession({ id: "s1" })];
    const grouped = buildGroupedSessions(sessions, "", {
      folders: [],
      assignments: [{ sessionId: "s1", folderId: "unknown" }],
    });
    expect(grouped.activeRepoGroups[0]?.unfiled.map((session) => session.id)).toEqual(["s1"]);
  });

  it("filters by search query and excludes archived", () => {
    const sessions = [
      makeSession({ id: "s1", title: "Refactor parser" }),
      makeSession({ id: "s2", title: "Auth hardening", status: "archived" }),
      makeSession({ id: "s3", title: "Bugfix", repoName: "api" }),
    ];
    const grouped = buildGroupedSessions(sessions, "parser", { folders: [], assignments: [] });
    expect(grouped.activeRepoGroups).toHaveLength(1);
    expect(grouped.activeRepoGroups[0]?.unfiled.map((session) => session.id)).toEqual(["s1"]);
  });
});
