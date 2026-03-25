"use client";

import { useMemo } from "react";
import {
  CollapsibleSection,
  ParticipantsSection,
  MetadataSection,
  TasksSection,
  FilesChangedSection,
  CodeServerSection,
} from "./sidebar";
import { ChildSessionsSection } from "./sidebar/child-sessions-section";
import { extractChangedFiles } from "@/lib/files";
import { extractLatestTasks } from "@/lib/tasks";
import type { Artifact, SandboxEvent } from "@/types/session";
import type { ParticipantPresence, SessionState } from "@open-inspect/shared";

interface SessionRightSidebarProps {
  sessionState: SessionState | null;
  participants: ParticipantPresence[];
  events: SandboxEvent[];
  artifacts: Artifact[];
}

export type SessionRightSidebarContentProps = SessionRightSidebarProps;

export function SessionRightSidebarContent({
  sessionState,
  participants,
  events,
  artifacts,
}: SessionRightSidebarContentProps) {
  const tasks = useMemo(() => extractLatestTasks(events), [events]);
  const filesChanged = useMemo(() => extractChangedFiles(events), [events]);

  if (!sessionState) {
    return (
      <div className="p-4">
        <div className="animate-pulse space-y-4">
          <div className="h-4 bg-muted w-3/4" />
          <div className="h-4 bg-muted w-1/2" />
          <div className="h-4 bg-muted w-2/3" />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="border-b border-border-muted px-4 py-4">
        <ParticipantsSection participants={participants} />
      </div>

      <div className="border-b border-border-muted px-4 py-4">
        <MetadataSection
          createdAt={sessionState.createdAt}
          model={sessionState.model}
          reasoningEffort={sessionState.reasoningEffort}
          providerMode={sessionState.providerMode}
          providerFallbackReason={sessionState.providerFallbackReason}
          baseBranch={sessionState.baseBranch}
          branchName={sessionState.branchName || undefined}
          repoOwner={sessionState.repoOwner}
          repoName={sessionState.repoName}
          artifacts={artifacts}
          parentSessionId={sessionState.parentSessionId}
        />
      </div>

      {sessionState.codeServerUrl && (
        <div className="border-b border-border-muted px-4 py-4">
          <CodeServerSection
            url={sessionState.codeServerUrl}
            password={sessionState.codeServerPassword ?? null}
            sandboxStatus={sessionState.sandboxStatus}
          />
        </div>
      )}

      {tasks.length > 0 && (
        <CollapsibleSection title="Tasks" defaultOpen={true}>
          <TasksSection tasks={tasks} />
        </CollapsibleSection>
      )}

      <ChildSessionsSection sessionId={sessionState.id} />

      {filesChanged.length > 0 && (
        <CollapsibleSection title="Files changed" defaultOpen={true}>
          <FilesChangedSection files={filesChanged} />
        </CollapsibleSection>
      )}

      {tasks.length === 0 && filesChanged.length === 0 && artifacts.length === 0 && (
        <div className="px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Tasks and file changes will appear here as the agent works.
          </p>
        </div>
      )}
    </>
  );
}

export function SessionRightSidebar({
  sessionState,
  participants,
  events,
  artifacts,
}: SessionRightSidebarProps) {
  return (
    <aside className="hidden w-80 overflow-y-auto border-l border-border-muted lg:block">
      <SessionRightSidebarContent
        sessionState={sessionState}
        participants={participants}
        events={events}
        artifacts={artifacts}
      />
    </aside>
  );
}
