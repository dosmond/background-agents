"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import useSWR, { mutate } from "swr";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { formatRelativeTime } from "@/lib/time";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { useIsMobile } from "@/hooks/use-media-query";
import {
  ArchiveIcon,
  AutomationsIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  PlusIcon,
  RepoIcon,
  SettingsIcon,
  SidebarIcon,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DanstackDMark } from "@/components/ui/danstack-logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  buildGroupedSessions,
  type SessionFoldersResponse,
  type SessionRepoGroup,
} from "@/lib/session-folders";
import type { Session } from "@open-inspect/shared";

export type SessionItem = Session;
export const MOBILE_LONG_PRESS_MS = 450;

export function buildSessionHref(session: SessionItem) {
  return {
    pathname: `/session/${session.id}`,
    query: {
      repoOwner: session.repoOwner,
      repoName: session.repoName,
      ...(session.title ? { title: session.title } : {}),
    },
  };
}

interface SessionSidebarProps {
  onNewSession?: () => void;
  onToggle?: () => void;
  onSessionSelect?: () => void;
}

export function SessionSidebar({ onNewSession, onToggle, onSessionSelect }: SessionSidebarProps) {
  const { data: authSession } = useSession();
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const [searchQuery, setSearchQuery] = useState("");
  const [archivingIds, setArchivingIds] = useState<Set<string>>(new Set());
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());

  const { data, isLoading: loadingSessions } = useSWR<{ sessions: SessionItem[] }>(
    authSession ? "/api/sessions" : null
  );
  const { data: folderData, isLoading: loadingFolders } = useSWR<SessionFoldersResponse>(
    authSession ? "/api/session-folders" : null
  );

  const sessions = useMemo(() => data?.sessions ?? [], [data]);
  const { activeRepoGroups, inactiveRepoGroups } = useMemo(
    () => buildGroupedSessions(sessions, searchQuery, folderData),
    [sessions, searchQuery, folderData]
  );

  const currentSessionId = pathname?.startsWith("/session/") ? pathname.split("/")[2] : null;
  const loading = loadingSessions || loadingFolders;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );

  const setRepoCollapsed = (repoKey: string, collapsed: boolean) => {
    setCollapsedRepos((previous) => {
      const next = new Set(previous);
      if (collapsed) {
        next.add(repoKey);
      } else {
        next.delete(repoKey);
      }
      return next;
    });
  };

  const mutateFolders = async () => {
    await mutate("/api/session-folders");
  };

  const createFolder = async (repoOwner: string, repoName: string) => {
    const name = window.prompt("Folder name");
    if (!name?.trim()) return;

    const response = await fetch("/api/session-folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoOwner, repoName, name }),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      window.alert(payload.error || "Failed to create folder");
      return;
    }

    await mutateFolders();
  };

  const renameFolder = async (folderId: string, currentName: string) => {
    const name = window.prompt("Rename folder", currentName);
    if (!name?.trim() || name === currentName) return;

    const response = await fetch(`/api/session-folders/${encodeURIComponent(folderId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      window.alert(payload.error || "Failed to rename folder");
      return;
    }

    await mutateFolders();
  };

  const deleteFolder = async (folderId: string, folderName: string, sessionCount: number) => {
    const confirmed = window.confirm(
      sessionCount > 0
        ? `Delete "${folderName}"? ${sessionCount} session(s) will move to Unfiled.`
        : `Delete "${folderName}"?`
    );
    if (!confirmed) return;

    const response = await fetch(`/api/session-folders/${encodeURIComponent(folderId)}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      window.alert(payload.error || "Failed to delete folder");
      return;
    }

    await mutateFolders();
  };

  const moveSessionToFolder = async (sessionId: string, folderId: string | null) => {
    const previous = folderData;
    if (previous) {
      await mutate(
        "/api/session-folders",
        {
          ...previous,
          assignments:
            folderId === null
              ? previous.assignments.filter((assignment) => assignment.sessionId !== sessionId)
              : [
                  ...previous.assignments.filter(
                    (assignment) => assignment.sessionId !== sessionId
                  ),
                  { sessionId, folderId },
                ],
        },
        false
      );
    }

    const response = await fetch(`/api/session-folders/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId }),
    });

    if (!response.ok) {
      await mutateFolders();
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      window.alert(payload.error || "Failed to move session");
      return;
    }

    await mutateFolders();
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeData = active.data.current as
      | { sessionId: string; repoKey: string; folderId: string | null }
      | undefined;
    const overData = over.data.current as { repoKey: string; folderId: string | null } | undefined;

    if (!activeData || !overData) return;
    if (activeData.repoKey !== overData.repoKey) {
      window.alert("Sessions can only be moved within the same repository.");
      return;
    }
    if (activeData.folderId === overData.folderId) return;

    await moveSessionToFolder(activeData.sessionId, overData.folderId);
  };

  const handleArchive = async (sessionId: string) => {
    const confirmed = window.confirm(
      "Archive this session? You can restore archived sessions from Settings > Data Controls."
    );
    if (!confirmed) return;

    setArchivingIds((previous) => {
      const next = new Set(previous);
      next.add(sessionId);
      return next;
    });

    try {
      const response = await fetch(`/api/sessions/${sessionId}/archive`, { method: "POST" });
      if (response.ok) {
        mutate("/api/sessions");
      } else {
        console.error("Failed to archive session from sidebar");
      }
    } catch (error) {
      console.error("Archive session error:", error);
    } finally {
      setArchivingIds((previous) => {
        const next = new Set(previous);
        next.delete(sessionId);
        return next;
      });
    }
  };

  return (
    <aside className="flex h-dvh w-72 flex-col border-r border-border-muted bg-background">
      <div className="flex items-center justify-between border-b border-border-muted px-4 py-3">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggle}
            title={`Toggle sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
            aria-label={`Toggle sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
          >
            <SidebarIcon className="h-4 w-4" />
          </Button>
          <Link href="/" className="flex items-center gap-2">
            <DanstackDMark className="h-5 w-5" />
            <span className="font-semibold text-foreground">Danstack</span>
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onNewSession}
            title={`New session (${SHORTCUT_LABELS.NEW_SESSION})`}
            aria-label={`New session (${SHORTCUT_LABELS.NEW_SESSION})`}
          >
            <PlusIcon className="h-4 w-4" />
          </Button>
          <Link
            href="/settings"
            className={`p-1.5 transition ${
              pathname === "/settings"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
            title="Settings"
          >
            <SettingsIcon className="h-4 w-4" />
          </Link>
          <UserMenu user={authSession?.user} />
        </div>
      </div>

      <div className="flex flex-col gap-0.5 px-3 pb-1 pt-2">
        <Link
          href="/automations"
          className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition ${
            pathname?.startsWith("/automations")
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          <AutomationsIcon className="h-4 w-4" />
          Automations
        </Link>
      </div>

      <div className="px-3 py-2">
        <Input
          type="text"
          placeholder="Search sessions..."
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-muted-foreground" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">No sessions yet</div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <RepoGroupList
              repoGroups={activeRepoGroups}
              currentSessionId={currentSessionId}
              collapsedRepos={collapsedRepos}
              setRepoCollapsed={setRepoCollapsed}
              onCreateFolder={createFolder}
              onRenameFolder={renameFolder}
              onDeleteFolder={deleteFolder}
              isMobile={isMobile}
              onSessionSelect={onSessionSelect}
              onArchive={handleArchive}
              archivingIds={archivingIds}
            />

            {inactiveRepoGroups.length > 0 && (
              <>
                <div className="mt-2 px-4 py-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-secondary-foreground">
                    Inactive
                  </span>
                </div>
                <RepoGroupList
                  repoGroups={inactiveRepoGroups}
                  currentSessionId={currentSessionId}
                  collapsedRepos={collapsedRepos}
                  setRepoCollapsed={setRepoCollapsed}
                  onCreateFolder={createFolder}
                  onRenameFolder={renameFolder}
                  onDeleteFolder={deleteFolder}
                  isMobile={isMobile}
                  onSessionSelect={onSessionSelect}
                  onArchive={handleArchive}
                  archivingIds={archivingIds}
                />
              </>
            )}
          </DndContext>
        )}
      </div>
    </aside>
  );
}

function UserMenu({ user }: { user?: { name?: string | null; image?: string | null } | null }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="h-7 w-7 overflow-hidden rounded-full focus:outline-none focus:ring-2 focus:ring-primary"
          title={`Signed in as ${user?.name || "User"}`}
        >
          {user?.image ? (
            <img src={user.image} alt={user.name || "User"} className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center rounded-full bg-card text-xs font-medium text-foreground">
              {user?.name?.charAt(0).toUpperCase() || "?"}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4}>
        <DropdownMenuLabel className="truncate font-medium">{user?.name || "User"}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => signOut()}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RepoGroupList({
  repoGroups,
  currentSessionId,
  collapsedRepos,
  setRepoCollapsed,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  isMobile,
  onSessionSelect,
  onArchive,
  archivingIds,
}: {
  repoGroups: SessionRepoGroup[];
  currentSessionId: string | null;
  collapsedRepos: Set<string>;
  setRepoCollapsed: (repoKey: string, collapsed: boolean) => void;
  onCreateFolder: (repoOwner: string, repoName: string) => Promise<void>;
  onRenameFolder: (folderId: string, currentName: string) => Promise<void>;
  onDeleteFolder: (folderId: string, folderName: string, sessionCount: number) => Promise<void>;
  isMobile: boolean;
  onSessionSelect?: () => void;
  onArchive?: (sessionId: string) => Promise<void> | void;
  archivingIds: Set<string>;
}) {
  if (repoGroups.length === 0) return null;

  return (
    <>
      {repoGroups.map((repoGroup) => {
        const isCollapsed = collapsedRepos.has(repoGroup.key);

        return (
          <div key={repoGroup.key} className="border-t border-border-muted/40 first:border-t-0">
            <div className="flex items-center gap-1 px-3 py-2">
              <button
                type="button"
                onClick={() => setRepoCollapsed(repoGroup.key, !isCollapsed)}
                className="flex min-w-0 flex-1 items-center gap-1 text-sm text-foreground hover:text-foreground/80"
                aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${repoGroup.key}`}
              >
                {isCollapsed ? (
                  <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <RepoIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{repoGroup.key}</span>
              </button>
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground"
                title="Create folder"
                onClick={() => onCreateFolder(repoGroup.repoOwner, repoGroup.repoName)}
              >
                <PlusIcon className="h-3.5 w-3.5" />
              </button>
            </div>

            {!isCollapsed && (
              <div className="pb-1">
                <FolderSessionSection
                  title="Unfiled"
                  repoKey={repoGroup.key}
                  folderId={null}
                  sessions={repoGroup.unfiled as SessionItem[]}
                  currentSessionId={currentSessionId}
                  isMobile={isMobile}
                  onSessionSelect={onSessionSelect}
                  onArchive={onArchive}
                  archivingIds={archivingIds}
                />
                {repoGroup.folders.map((folder) => (
                  <FolderSessionSection
                    key={folder.id}
                    title={folder.name}
                    repoKey={repoGroup.key}
                    folderId={folder.id}
                    sessions={folder.sessions as SessionItem[]}
                    currentSessionId={currentSessionId}
                    isMobile={isMobile}
                    onSessionSelect={onSessionSelect}
                    onArchive={onArchive}
                    archivingIds={archivingIds}
                    onRename={() => onRenameFolder(folder.id, folder.name)}
                    onDelete={() => onDeleteFolder(folder.id, folder.name, folder.sessions.length)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function FolderSessionSection({
  title,
  repoKey,
  folderId,
  sessions,
  currentSessionId,
  isMobile,
  onSessionSelect,
  onArchive,
  archivingIds,
  onRename,
  onDelete,
}: {
  title: string;
  repoKey: string;
  folderId: string | null;
  sessions: SessionItem[];
  currentSessionId: string | null;
  isMobile: boolean;
  onSessionSelect?: () => void;
  onArchive?: (sessionId: string) => Promise<void> | void;
  archivingIds: Set<string>;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  const droppableId = folderId ? `folder:${folderId}` : `unfiled:${repoKey}`;
  const { isOver, setNodeRef } = useDroppable({
    id: droppableId,
    data: { repoKey, folderId },
  });

  return (
    <div
      ref={setNodeRef}
      className={`mx-2 mb-1 border border-transparent ${isOver ? "border-accent bg-accent-muted/40" : ""}`}
    >
      <div className="flex items-center gap-1 px-3 py-1.5 text-xs text-muted-foreground">
        <FolderIcon className="h-3.5 w-3.5" />
        <span className="truncate">{title}</span>
        {onRename && (
          <>
            <button
              type="button"
              className="ml-auto text-[11px] hover:text-foreground"
              onClick={onRename}
              title="Rename folder"
            >
              Rename
            </button>
            <button
              type="button"
              className="text-[11px] hover:text-foreground"
              onClick={onDelete}
              title="Delete folder"
            >
              Delete
            </button>
          </>
        )}
      </div>

      {sessions.length === 0 ? (
        <div className="px-3 pb-2 text-xs text-muted-foreground/70">Drop sessions here</div>
      ) : (
        sessions.map((session) => (
          <SessionListItem
            key={session.id}
            session={session}
            isActive={session.id === currentSessionId}
            isMobile={isMobile}
            onSessionSelect={onSessionSelect}
            onArchive={onArchive}
            isArchiving={archivingIds.has(session.id)}
            repoKey={repoKey}
            folderId={folderId}
          />
        ))
      )}
    </div>
  );
}

function SessionListItem({
  session,
  isActive,
  isMobile,
  onSessionSelect,
  onArchive,
  isArchiving,
  repoKey,
  folderId,
}: {
  session: SessionItem;
  isActive: boolean;
  isMobile: boolean;
  onSessionSelect?: () => void;
  onArchive?: (sessionId: string) => Promise<void> | void;
  isArchiving?: boolean;
  repoKey: string;
  folderId: string | null;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `session:${session.id}`,
    data: { sessionId: session.id, repoKey, folderId },
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.6 : 1,
  };
  const timestamp = session.updatedAt || session.createdAt;
  const relativeTime = formatRelativeTime(timestamp);
  const displayTitle = session.title || `${session.repoOwner}/${session.repoName}`;
  const repoInfo = `${session.repoOwner}/${session.repoName}`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={`group flex cursor-grab items-center gap-2 border-l-2 px-4 py-2.5 transition active:cursor-grabbing ${
        isActive ? "border-l-accent bg-accent-muted" : "border-l-transparent hover:bg-muted"
      }`}
    >
      <Link
        href={buildSessionHref(session)}
        onClick={() => {
          if (isMobile) {
            onSessionSelect?.();
          }
        }}
        className="min-w-0 flex-1"
      >
        <div className="truncate text-sm font-medium text-foreground">{displayTitle}</div>
        <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          <span>{relativeTime}</span>
          <span>·</span>
          <span className="truncate">{repoInfo}</span>
        </div>
      </Link>
      <button
        type="button"
        disabled={isArchiving}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onArchive?.(session.id);
        }}
        className={`flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 ${
          isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        title="Archive session"
        aria-label="Archive session"
      >
        <ArchiveIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
