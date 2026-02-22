import { createLogger } from "../logger";
import {
  RepoContextDocumentsStore,
  RepoContextValidationError,
  type ContextDocumentSourceType,
  type ContextIngestStatus,
} from "../db/repo-context-documents";
import { ContextRetrievalService } from "../context/context-retrieval-service";
import { CloudflareAiSearchClient, CloudflareAiSearchError } from "../context/cloudflare-ai-search";
import type { Env } from "../types";
import {
  type Route,
  type RequestContext,
  parsePattern,
  json,
  error,
  resolveInstalledRepo,
} from "./shared";

const logger = createLogger("router:context");
const INDEX_RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1000;

function ensureDb(env: Env): Response | null {
  if (!env.DB) return error("Context storage is not configured", 503);
  return null;
}

function safeDocumentId(input?: string): string {
  if (input && input.trim()) return input.trim();
  return crypto.randomUUID();
}

function inferSummary(content: string): string {
  const compact = content.trim().replace(/\s+/g, " ");
  if (compact.length <= 320) return compact;
  return `${compact.slice(0, 319)}...`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof CloudflareAiSearchError) {
    return error.status === 429 || error.status >= 500;
  }
  return false;
}

async function indexDocumentInBackground(
  env: Env,
  owner: string,
  name: string,
  documentId: string,
  correlation: { requestId: string; traceId: string }
): Promise<void> {
  const store = new RepoContextDocumentsStore(env.DB);
  const document = await store.getDocument(owner, name, documentId);
  if (!document) return;

  if (env.CONTEXT_INDEXING_ENABLED === "false") {
    await store.markIndexFailed(owner, name, documentId, "Context indexing is disabled");
    return;
  }

  const aiSearch = new CloudflareAiSearchClient(env);
  if (!aiSearch.isConfigured()) {
    await store.markIndexFailed(owner, name, documentId, "Cloudflare AI Search is not configured");
    return;
  }

  for (let attempt = 1; attempt <= INDEX_RETRY_ATTEMPTS; attempt++) {
    try {
      await aiSearch.indexDocument({
        documentId: document.id,
        filename: `${document.repoOwner}/${document.repoName}/${document.id}.txt`,
        content: document.content,
        attributes: {
          repo_owner: document.repoOwner,
          repo_name: document.repoName,
          source_type: document.sourceType,
          tags: document.tags ?? [],
          title: document.title,
          created_at: document.createdAt,
        },
      });

      await store.markIndexed(owner, name, documentId, Date.now());
      logger.info("repo.context_document_indexed", {
        event: "repo.context_document_indexed",
        repo_owner: owner.toLowerCase(),
        repo_name: name.toLowerCase(),
        document_id: documentId,
        attempt,
        request_id: correlation.requestId,
        trace_id: correlation.traceId,
      });
      return;
    } catch (error) {
      const message =
        error instanceof CloudflareAiSearchError
          ? `${error.message}${error.details ? `: ${error.details}` : ""}`
          : error instanceof Error
            ? error.message
            : String(error);

      logger.warn("repo.context_document_index_attempt_failed", {
        event: "repo.context_document_index_attempt_failed",
        repo_owner: owner.toLowerCase(),
        repo_name: name.toLowerCase(),
        document_id: documentId,
        attempt,
        error: message,
        request_id: correlation.requestId,
        trace_id: correlation.traceId,
      });

      const shouldRetry = attempt < INDEX_RETRY_ATTEMPTS && isRetryableError(error);
      if (shouldRetry) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      await store.markIndexFailed(owner, name, documentId, message.slice(0, 1000));
      return;
    }
  }
}

async function resolveRepoOrError(
  env: Env,
  owner: string,
  name: string
): Promise<{ repoId: number; repoOwner: string; repoName: string } | Response> {
  try {
    const resolved = await resolveInstalledRepo(env, owner, name);
    if (!resolved) return error("Repository is not installed for the GitHub App", 404);
    return resolved;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return error(
      message === "GitHub App not configured" ? message : "Failed to resolve repository",
      500
    );
  }
}

async function handleUpsertContextDocument(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const dbError = ensureDb(env);
  if (dbError) return dbError;

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required");

  const resolved = await resolveRepoOrError(env, owner, name);
  if (resolved instanceof Response) return resolved;

  let body: {
    document?: {
      id?: string;
      title?: string;
      sourceType?: ContextDocumentSourceType;
      content?: string;
      tags?: string[];
      timeframeStart?: number;
      timeframeEnd?: number;
      metadata?: Record<string, unknown>;
      ingestStatus?: ContextIngestStatus;
      createdBy?: string;
      supersedesDecisionId?: string;
      relatedDecisionIds?: string[];
    };
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return error("Invalid JSON body", 400);
  }
  const input = body.document;
  if (!input) return error("document is required", 400);

  const store = new RepoContextDocumentsStore(env.DB);
  try {
    const doc = await store.upsertDocument(owner, name, {
      id: safeDocumentId(input.id),
      title: input.title ?? "",
      sourceType: input.sourceType ?? "note",
      content: input.content ?? "",
      tags: input.tags,
      timeframeStart: input.timeframeStart,
      timeframeEnd: input.timeframeEnd,
      metadata: input.metadata,
      ingestStatus: input.ingestStatus ?? "pending_index",
      createdBy: input.createdBy ?? "system",
    });

    const decisionId = `decision:${doc.id}`;
    const decision = await store.upsertDecision(owner, name, {
      id: decisionId,
      title: doc.title,
      summary: inferSummary(doc.content),
      status: "active",
      documentId: doc.id,
    });

    const edges = [
      ...(input.supersedesDecisionId
        ? [{ toDecisionId: input.supersedesDecisionId, edgeType: "supersedes" as const }]
        : []),
      ...((input.relatedDecisionIds || []).map((id) => ({
        toDecisionId: id,
        edgeType: "related" as const,
      })) || []),
    ];
    await store.setDecisionEdges(owner, name, decisionId, edges);

    logger.info("repo.context_document_upserted", {
      event: "repo.context_document_upserted",
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      document_id: doc.id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    if (doc.ingestStatus === "pending_index") {
      const job = indexDocumentInBackground(env, owner, name, doc.id, {
        requestId: ctx.request_id,
        traceId: ctx.trace_id,
      }).catch((error) => {
        logger.error("repo.context_document_index_job_failed", {
          event: "repo.context_document_index_job_failed",
          repo_owner: resolved.repoOwner,
          repo_name: resolved.repoName,
          document_id: doc.id,
          error: error instanceof Error ? error.message : String(error),
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
      });
      if (ctx.executionCtx) ctx.executionCtx.waitUntil(job);
      else void job;
    }

    return json({
      status: "updated",
      repo: `${resolved.repoOwner}/${resolved.repoName}`,
      document: doc,
      decision,
    });
  } catch (e) {
    if (e instanceof RepoContextValidationError) return error(e.message, 400);
    logger.error("Failed to upsert context document", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to upsert context document", 500);
  }
}

async function handleListContextDocuments(
  _request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const dbError = ensureDb(env);
  if (dbError) return dbError;

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required");

  const resolved = await resolveRepoOrError(env, owner, name);
  if (resolved instanceof Response) return resolved;

  const store = new RepoContextDocumentsStore(env.DB);
  const documents = await store.listDocuments(owner, name, 200);
  return json({
    repo: `${resolved.repoOwner}/${resolved.repoName}`,
    documents,
  });
}

async function handleDeleteContextDocument(
  _request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const dbError = ensureDb(env);
  if (dbError) return dbError;
  const owner = match.groups?.owner;
  const name = match.groups?.name;
  const id = match.groups?.id;
  if (!owner || !name || !id) return error("Owner, name, and id are required");

  const resolved = await resolveRepoOrError(env, owner, name);
  if (resolved instanceof Response) return resolved;

  const store = new RepoContextDocumentsStore(env.DB);
  const deleted = await store.deleteDocument(owner, name, id);
  if (!deleted) return error("Document not found", 404);
  return json({ status: "deleted", documentId: id });
}

async function handleReindexContextDocument(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const dbError = ensureDb(env);
  if (dbError) return dbError;
  const owner = match.groups?.owner;
  const name = match.groups?.name;
  const id = match.groups?.id;
  if (!owner || !name || !id) return error("Owner, name, and id are required");

  const resolved = await resolveRepoOrError(env, owner, name);
  if (resolved instanceof Response) return resolved;

  const store = new RepoContextDocumentsStore(env.DB);
  const existing = await store.getDocument(owner, name, id);
  if (!existing) return error("Document not found", 404);

  const updated = await store.upsertDocument(owner, name, {
    ...existing,
    ingestStatus: "pending_index",
    createdBy: existing.createdBy,
  });

  const job = indexDocumentInBackground(env, owner, name, id, {
    requestId: ctx.request_id,
    traceId: ctx.trace_id,
  }).catch((error) => {
    logger.error("repo.context_document_reindex_job_failed", {
      event: "repo.context_document_reindex_job_failed",
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      document_id: id,
      error: error instanceof Error ? error.message : String(error),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
  });
  if (ctx.executionCtx) ctx.executionCtx.waitUntil(job);
  else void job;

  return json({
    status: "queued",
    repo: `${resolved.repoOwner}/${resolved.repoName}`,
    document: updated,
  });
}

async function handleSearchContext(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const dbError = ensureDb(env);
  if (dbError) return dbError;
  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required");

  const resolved = await resolveRepoOrError(env, owner, name);
  if (resolved instanceof Response) return resolved;

  const body = (await request.json()) as { query?: string; maxResults?: number };
  if (!body.query?.trim()) return error("query is required");
  const service = new ContextRetrievalService(env);
  const search = await service.searchContext(owner, name, body.query, body.maxResults ?? 6);
  return json({
    repo: `${resolved.repoOwner}/${resolved.repoName}`,
    ...search,
  });
}

async function handleGetDecision(
  _request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const dbError = ensureDb(env);
  if (dbError) return dbError;
  const owner = match.groups?.owner;
  const name = match.groups?.name;
  const id = match.groups?.id;
  if (!owner || !name || !id) return error("Owner, name, and id are required");

  const resolved = await resolveRepoOrError(env, owner, name);
  if (resolved instanceof Response) return resolved;

  const service = new ContextRetrievalService(env);
  const decision = await service.getDecision(owner, name, id);
  if (!decision) return error("Decision not found", 404);
  return json({
    repo: `${resolved.repoOwner}/${resolved.repoName}`,
    decision,
  });
}

async function handleGetDecisionLineage(
  _request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const dbError = ensureDb(env);
  if (dbError) return dbError;
  const owner = match.groups?.owner;
  const name = match.groups?.name;
  const id = match.groups?.id;
  if (!owner || !name || !id) return error("Owner, name, and id are required");

  const resolved = await resolveRepoOrError(env, owner, name);
  if (resolved instanceof Response) return resolved;

  const service = new ContextRetrievalService(env);
  const lineage = await service.getDecisionLineage(owner, name, id);
  return json({
    repo: `${resolved.repoOwner}/${resolved.repoName}`,
    decisionId: id,
    lineage,
  });
}

async function handleBuildContextPack(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const dbError = ensureDb(env);
  if (dbError) return dbError;
  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required");

  const resolved = await resolveRepoOrError(env, owner, name);
  if (resolved instanceof Response) return resolved;

  const body = (await request.json()) as { taskOrScope?: string; maxResults?: number };
  if (!body.taskOrScope?.trim()) return error("taskOrScope is required");
  const service = new ContextRetrievalService(env);
  const pack = await service.buildContextPack(owner, name, body.taskOrScope, body.maxResults ?? 6);
  return json({
    repo: `${resolved.repoOwner}/${resolved.repoName}`,
    contextPack: pack,
  });
}

export const contextRoutes: Route[] = [
  {
    method: "PUT",
    pattern: parsePattern("/repos/:owner/:name/context/documents"),
    handler: handleUpsertContextDocument,
  },
  {
    method: "GET",
    pattern: parsePattern("/repos/:owner/:name/context/documents"),
    handler: handleListContextDocuments,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/repos/:owner/:name/context/documents/:id"),
    handler: handleDeleteContextDocument,
  },
  {
    method: "POST",
    pattern: parsePattern("/repos/:owner/:name/context/documents/:id/reindex"),
    handler: handleReindexContextDocument,
  },
  {
    method: "POST",
    pattern: parsePattern("/repos/:owner/:name/context/search_context"),
    handler: handleSearchContext,
  },
  {
    method: "GET",
    pattern: parsePattern("/repos/:owner/:name/context/decisions/:id"),
    handler: handleGetDecision,
  },
  {
    method: "GET",
    pattern: parsePattern("/repos/:owner/:name/context/decisions/:id/lineage"),
    handler: handleGetDecisionLineage,
  },
  {
    method: "POST",
    pattern: parsePattern("/repos/:owner/:name/context/build_context_pack"),
    handler: handleBuildContextPack,
  },
];
