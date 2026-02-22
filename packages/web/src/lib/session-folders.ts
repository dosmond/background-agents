import { isInactiveSession } from "./time";

export interface SessionListItem {
  id: string;
  title: string | null;
  repoOwner: string;
  repoName: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionFolderItem {
  id: string;
  repoOwner: string;
  repoName: string;
  name: string;
}

export interface SessionFolderAssignmentItem {
  sessionId: string;
  folderId: string;
}

export interface SessionFoldersResponse {
  folders: SessionFolderItem[];
  assignments: SessionFolderAssignmentItem[];
}

export interface SessionRepoGroup {
  repoOwner: string;
  repoName: string;
  key: string;
  folders: Array<{
    id: string;
    name: string;
    sessions: SessionListItem[];
  }>;
  unfiled: SessionListItem[];
  latestTimestamp: number;
}

export interface GroupedSessions {
  activeRepoGroups: SessionRepoGroup[];
  inactiveRepoGroups: SessionRepoGroup[];
}

function sortByRecent(first: SessionListItem, second: SessionListItem): number {
  const firstTime = first.updatedAt || first.createdAt;
  const secondTime = second.updatedAt || second.createdAt;
  return secondTime - firstTime;
}

function getRepoKey(repoOwner: string, repoName: string): string {
  return `${repoOwner.toLowerCase()}/${repoName.toLowerCase()}`;
}

function buildRepoGroups(
  sessions: SessionListItem[],
  folders: SessionFolderItem[],
  assignments: SessionFolderAssignmentItem[]
): SessionRepoGroup[] {
  const sortedSessions = [...sessions].sort(sortByRecent);
  const assignmentBySession = new Map(assignments.map((item) => [item.sessionId, item.folderId]));

  const foldersByRepo = new Map<string, SessionFolderItem[]>();
  for (const folder of folders) {
    const key = getRepoKey(folder.repoOwner, folder.repoName);
    const current = foldersByRepo.get(key) ?? [];
    current.push(folder);
    foldersByRepo.set(key, current);
  }

  const groups = new Map<string, SessionRepoGroup>();
  for (const session of sortedSessions) {
    const key = getRepoKey(session.repoOwner, session.repoName);
    if (!groups.has(key)) {
      const repoFolders = (foldersByRepo.get(key) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      groups.set(key, {
        repoOwner: session.repoOwner.toLowerCase(),
        repoName: session.repoName.toLowerCase(),
        key,
        folders: repoFolders.map((folder) => ({ id: folder.id, name: folder.name, sessions: [] })),
        unfiled: [],
        latestTimestamp: session.updatedAt || session.createdAt,
      });
    }

    const group = groups.get(key)!;
    group.latestTimestamp = Math.max(group.latestTimestamp, session.updatedAt || session.createdAt);
    const folderId = assignmentBySession.get(session.id);
    if (!folderId) {
      group.unfiled.push(session);
      continue;
    }

    const targetFolder = group.folders.find((folder) => folder.id === folderId);
    if (!targetFolder) {
      group.unfiled.push(session);
      continue;
    }

    targetFolder.sessions.push(session);
  }

  return [...groups.values()].sort((a, b) => b.latestTimestamp - a.latestTimestamp);
}

export function buildGroupedSessions(
  sessions: SessionListItem[],
  searchQuery: string,
  folderData?: SessionFoldersResponse
): GroupedSessions {
  const query = searchQuery.trim().toLowerCase();
  const filtered = sessions
    .filter((session) => session.status !== "archived")
    .filter((session) => {
      if (!query) return true;
      const title = session.title?.toLowerCase() ?? "";
      const repo = getRepoKey(session.repoOwner, session.repoName);
      return title.includes(query) || repo.includes(query);
    });

  const activeSessions: SessionListItem[] = [];
  const inactiveSessions: SessionListItem[] = [];
  for (const session of filtered) {
    const timestamp = session.updatedAt || session.createdAt;
    if (isInactiveSession(timestamp)) {
      inactiveSessions.push(session);
    } else {
      activeSessions.push(session);
    }
  }

  const folders = folderData?.folders ?? [];
  const assignments = folderData?.assignments ?? [];

  return {
    activeRepoGroups: buildRepoGroups(activeSessions, folders, assignments),
    inactiveRepoGroups: buildRepoGroups(inactiveSessions, folders, assignments),
  };
}
