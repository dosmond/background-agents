import { createLogger } from "../logger";
import {
  SessionFoldersStore,
  SessionFolderValidationError,
  MAX_SESSION_FOLDER_NAME_LENGTH,
} from "../db/session-folders";
import { SessionIndexStore } from "../db/session-index";
import type { Env } from "../types";
import { type Route, type RequestContext, parsePattern, json, error } from "./shared";

const logger = createLogger("router:session-folders");

function extractUserId(match: RegExpMatchArray): string | null {
  const userId = match.groups?.userId;
  if (!userId) return null;
  return decodeURIComponent(userId);
}

async function handleListSessionFolders(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const userId = extractUserId(match);
  if (!userId) return error("userId is required", 400);
  if (!env.DB) {
    return json({ userId, folders: [], assignments: [] });
  }

  const store = new SessionFoldersStore(env.DB);
  const [folders, assignments] = await Promise.all([
    store.listFolders(userId),
    store.listAssignments(userId),
  ]);

  return json({ userId, folders, assignments });
}

async function handleCreateSessionFolder(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const userId = extractUserId(match);
  if (!userId) return error("userId is required", 400);
  if (!env.DB) {
    return error("Session folders storage is not configured", 503);
  }

  let body: { repoOwner?: string; repoName?: string; name?: string };
  try {
    body = (await request.json()) as { repoOwner?: string; repoName?: string; name?: string };
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!body.repoOwner || !body.repoName || !body.name) {
    return error("Request body must include repoOwner, repoName, and name", 400);
  }

  const store = new SessionFoldersStore(env.DB);
  const folderId = crypto.randomUUID();

  try {
    const folder = await store.createFolder({
      userId,
      folderId,
      repoOwner: body.repoOwner,
      repoName: body.repoName,
      name: body.name,
    });

    logger.info("session_folder.created", {
      event: "session_folder.created",
      user_id: userId,
      folder_id: folder.id,
      repo_owner: folder.repoOwner,
      repo_name: folder.repoName,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "created", folder }, 201);
  } catch (e) {
    if (e instanceof SessionFolderValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to create session folder", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Session folders storage unavailable", 503);
  }
}

async function handleRenameSessionFolder(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const userId = extractUserId(match);
  if (!userId) return error("userId is required", 400);
  if (!env.DB) {
    return error("Session folders storage is not configured", 503);
  }

  const folderId = match.groups?.folderId;
  if (!folderId) return error("folderId is required", 400);

  let body: { name?: string };
  try {
    body = (await request.json()) as { name?: string };
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!body.name) {
    return error("Request body must include name", 400);
  }

  const store = new SessionFoldersStore(env.DB);
  try {
    const folder = await store.renameFolder(userId, folderId, body.name);
    if (!folder) return error("Folder not found", 404);

    logger.info("session_folder.renamed", {
      event: "session_folder.renamed",
      user_id: userId,
      folder_id: folderId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "updated", folder });
  } catch (e) {
    if (e instanceof SessionFolderValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to rename session folder", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Session folders storage unavailable", 503);
  }
}

async function handleDeleteSessionFolder(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const userId = extractUserId(match);
  if (!userId) return error("userId is required", 400);
  if (!env.DB) {
    return error("Session folders storage is not configured", 503);
  }

  const folderId = match.groups?.folderId;
  if (!folderId) return error("folderId is required", 400);

  const store = new SessionFoldersStore(env.DB);
  try {
    const result = await store.deleteFolder(userId, folderId);
    if (!result.existed) return error("Folder not found", 404);

    logger.info("session_folder.deleted", {
      event: "session_folder.deleted",
      user_id: userId,
      folder_id: folderId,
      moved_count: result.movedCount,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "deleted", folderId, movedToUnfiledCount: result.movedCount });
  } catch (e) {
    logger.error("Failed to delete session folder", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Session folders storage unavailable", 503);
  }
}

async function handleMoveSessionToFolder(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const userId = extractUserId(match);
  if (!userId) return error("userId is required", 400);
  if (!env.DB) {
    return error("Session folders storage is not configured", 503);
  }

  const sessionId = match.groups?.sessionId;
  if (!sessionId) return error("sessionId is required", 400);

  let body: { folderId?: string | null };
  try {
    body = (await request.json()) as { folderId?: string | null };
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (body.folderId !== null && body.folderId !== undefined && typeof body.folderId !== "string") {
    return error("folderId must be a string or null", 400);
  }

  const sessionStore = new SessionIndexStore(env.DB);
  const session = await sessionStore.get(sessionId);
  if (!session) return error("Session not found", 404);

  const foldersStore = new SessionFoldersStore(env.DB);
  const folderId = body.folderId ?? null;

  try {
    if (folderId === null) {
      await foldersStore.clearAssignment(userId, sessionId);
      return json({ status: "updated", sessionId, folderId: null });
    }

    const folder = await foldersStore.getFolder(userId, folderId);
    if (!folder) return error("Folder not found", 404);

    if (folder.repoOwner !== session.repoOwner || folder.repoName !== session.repoName) {
      return error("Cannot move session across repos", 400);
    }

    await foldersStore.setAssignment({ userId, sessionId, folderId });
    logger.info("session_folder_assignment.updated", {
      event: "session_folder_assignment.updated",
      user_id: userId,
      session_id: sessionId,
      folder_id: folderId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "updated", sessionId, folderId });
  } catch (e) {
    if (e instanceof SessionFolderValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to move session into folder", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Session folders storage unavailable", 503);
  }
}

export const sessionFoldersRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/session-folders/:userId"),
    handler: handleListSessionFolders,
  },
  {
    method: "POST",
    pattern: parsePattern("/session-folders/:userId"),
    handler: handleCreateSessionFolder,
  },
  {
    method: "PATCH",
    pattern: parsePattern("/session-folders/:userId/:folderId"),
    handler: handleRenameSessionFolder,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/session-folders/:userId/:folderId"),
    handler: handleDeleteSessionFolder,
  },
  {
    method: "PUT",
    pattern: parsePattern("/session-folders/:userId/sessions/:sessionId"),
    handler: handleMoveSessionToFolder,
  },
];

export { MAX_SESSION_FOLDER_NAME_LENGTH };
