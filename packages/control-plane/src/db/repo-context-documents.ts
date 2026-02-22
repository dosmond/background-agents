const MAX_DOCUMENT_TITLE_LENGTH = 256;
const MAX_DOCUMENT_CONTENT_LENGTH = 120_000;
const MAX_DOCUMENTS_PER_REPO = 500;

export type ContextDocumentSourceType =
  | "meeting"
  | "slack"
  | "linear"
  | "note"
  | "upload"
  | "other";

export type ContextIngestStatus = "pending_index" | "indexed" | "failed";
export type ContextDecisionStatus = "active" | "superseded" | "draft";
export type ContextDecisionEdgeType = "supersedes" | "related";

export interface RepoContextDocumentRecord {
  id: string;
  repoOwner: string;
  repoName: string;
  title: string;
  sourceType: ContextDocumentSourceType;
  content: string;
  tags?: string[];
  timeframeStart?: number;
  timeframeEnd?: number;
  metadata?: Record<string, unknown>;
  ingestStatus: ContextIngestStatus;
  indexedAt?: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface RepoContextDecisionRecord {
  id: string;
  repoOwner: string;
  repoName: string;
  documentId?: string;
  title: string;
  summary: string;
  status: ContextDecisionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface RepoContextDecisionEdgeRecord {
  fromDecisionId: string;
  toDecisionId: string;
  edgeType: ContextDecisionEdgeType;
  createdAt: number;
}

export interface ContextSearchResult {
  document: RepoContextDocumentRecord;
  score: number;
  citations: Array<{ documentId: string; title: string; excerpt: string }>;
}

interface DocumentRow {
  id: string;
  repo_owner: string;
  repo_name: string;
  title: string;
  source_type: ContextDocumentSourceType;
  content: string;
  tags: string | null;
  timeframe_start: number | null;
  timeframe_end: number | null;
  metadata: string | null;
  ingest_status: ContextIngestStatus;
  indexed_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface DecisionRow {
  id: string;
  repo_owner: string;
  repo_name: string;
  document_id: string | null;
  title: string;
  summary: string;
  status: ContextDecisionStatus;
  created_at: number;
  updated_at: number;
}

interface DecisionEdgeRow {
  from_decision_id: string;
  to_decision_id: string;
  edge_type: ContextDecisionEdgeType;
  created_at: number;
}

export class RepoContextValidationError extends Error {}

function normalizeRepoOwner(owner: string): string {
  return owner.toLowerCase().trim();
}

function normalizeRepoName(name: string): string {
  return name.toLowerCase().trim();
}

function parseJsonArray(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonRecord(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function toDocumentRecord(row: DocumentRow): RepoContextDocumentRecord {
  return {
    id: row.id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    title: row.title,
    sourceType: row.source_type,
    content: row.content,
    tags: parseJsonArray(row.tags),
    timeframeStart: row.timeframe_start ?? undefined,
    timeframeEnd: row.timeframe_end ?? undefined,
    metadata: parseJsonRecord(row.metadata),
    ingestStatus: row.ingest_status,
    indexedAt: row.indexed_at ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDecisionRecord(row: DecisionRow): RepoContextDecisionRecord {
  return {
    id: row.id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    documentId: row.document_id ?? undefined,
    title: row.title,
    summary: row.summary,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function excerptForCitation(content: string, maxLength = 220): string {
  const compact = content.trim().replace(/\s+/g, " ");
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}...`;
}

function lexicalScore(haystack: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const lower = haystack.toLowerCase();
  let matches = 0;
  for (const token of queryTokens) {
    if (lower.includes(token)) matches++;
  }
  return matches / queryTokens.length;
}

export class RepoContextDocumentsStore {
  constructor(private readonly db: D1Database) {}

  private async getRawMetadata(
    owner: string,
    name: string,
    id: string
  ): Promise<Record<string, unknown> | undefined> {
    const row = await this.db
      .prepare(
        "SELECT metadata FROM repo_context_documents WHERE repo_owner = ? AND repo_name = ? AND id = ?"
      )
      .bind(normalizeRepoOwner(owner), normalizeRepoName(name), id)
      .first<{ metadata: string | null }>();
    return parseJsonRecord(row?.metadata ?? null);
  }

  private validateDocumentInput(input: {
    id: string;
    title: string;
    sourceType: ContextDocumentSourceType;
    content: string;
    createdBy: string;
  }): void {
    if (!input.id.trim()) throw new RepoContextValidationError("Document id is required");
    if (!input.title.trim()) throw new RepoContextValidationError("Document title is required");
    if (input.title.length > MAX_DOCUMENT_TITLE_LENGTH) {
      throw new RepoContextValidationError(
        `Document title exceeds ${MAX_DOCUMENT_TITLE_LENGTH} characters`
      );
    }
    if (!input.content.trim()) throw new RepoContextValidationError("Document content is required");
    if (input.content.length > MAX_DOCUMENT_CONTENT_LENGTH) {
      throw new RepoContextValidationError(
        `Document content exceeds ${MAX_DOCUMENT_CONTENT_LENGTH} characters`
      );
    }
    if (!input.createdBy.trim()) throw new RepoContextValidationError("createdBy is required");
  }

  async upsertDocument(
    owner: string,
    name: string,
    input: {
      id: string;
      title: string;
      sourceType: ContextDocumentSourceType;
      content: string;
      tags?: string[];
      timeframeStart?: number;
      timeframeEnd?: number;
      metadata?: Record<string, unknown>;
      ingestStatus?: ContextIngestStatus;
      createdBy: string;
    }
  ): Promise<RepoContextDocumentRecord> {
    this.validateDocumentInput(input);
    const repoOwner = normalizeRepoOwner(owner);
    const repoName = normalizeRepoName(name);
    const now = Date.now();
    const ingestStatus = input.ingestStatus ?? "pending_index";

    const existing = await this.db
      .prepare(
        "SELECT created_at FROM repo_context_documents WHERE repo_owner = ? AND repo_name = ? AND id = ?"
      )
      .bind(repoOwner, repoName, input.id)
      .first<{ created_at: number }>();

    if (!existing) {
      const countResult = await this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM repo_context_documents WHERE repo_owner = ? AND repo_name = ?"
        )
        .bind(repoOwner, repoName)
        .first<{ count: number }>();
      const count = Number(countResult?.count ?? 0);
      if (count >= MAX_DOCUMENTS_PER_REPO) {
        throw new RepoContextValidationError(
          `Repository exceeds ${MAX_DOCUMENTS_PER_REPO} documents`
        );
      }
    }

    await this.db
      .prepare(
        `INSERT INTO repo_context_documents
         (id, repo_owner, repo_name, title, source_type, content, tags, timeframe_start, timeframe_end, metadata, ingest_status, indexed_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_owner, repo_name, id) DO UPDATE SET
           title = excluded.title,
           source_type = excluded.source_type,
           content = excluded.content,
           tags = excluded.tags,
           timeframe_start = excluded.timeframe_start,
           timeframe_end = excluded.timeframe_end,
           metadata = excluded.metadata,
           ingest_status = excluded.ingest_status,
           indexed_at = excluded.indexed_at,
           updated_at = excluded.updated_at`
      )
      .bind(
        input.id,
        repoOwner,
        repoName,
        input.title.trim(),
        input.sourceType,
        input.content,
        input.tags ? JSON.stringify(input.tags) : null,
        input.timeframeStart ?? null,
        input.timeframeEnd ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        ingestStatus,
        ingestStatus === "indexed" ? now : null,
        input.createdBy.trim(),
        existing?.created_at ?? now,
        now
      )
      .run();

    return (await this.getDocument(owner, name, input.id))!;
  }

  async listDocuments(
    owner: string,
    name: string,
    limit = 100
  ): Promise<RepoContextDocumentRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM repo_context_documents
         WHERE repo_owner = ? AND repo_name = ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .bind(normalizeRepoOwner(owner), normalizeRepoName(name), Math.max(1, Math.min(limit, 250)))
      .all<DocumentRow>();
    return (rows.results || []).map(toDocumentRecord);
  }

  async getDocument(
    owner: string,
    name: string,
    id: string
  ): Promise<RepoContextDocumentRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT * FROM repo_context_documents WHERE repo_owner = ? AND repo_name = ? AND id = ?"
      )
      .bind(normalizeRepoOwner(owner), normalizeRepoName(name), id)
      .first<DocumentRow>();
    return row ? toDocumentRecord(row) : null;
  }

  async markIndexed(
    owner: string,
    name: string,
    id: string,
    indexedAt = Date.now()
  ): Promise<RepoContextDocumentRecord | null> {
    const existingMetadata = (await this.getRawMetadata(owner, name, id)) ?? {};
    const metadata = {
      ...existingMetadata,
      indexing: {
        status: "indexed",
        indexedAt,
      },
    };
    await this.db
      .prepare(
        `UPDATE repo_context_documents
         SET ingest_status = ?, indexed_at = ?, metadata = ?, updated_at = ?
         WHERE repo_owner = ? AND repo_name = ? AND id = ?`
      )
      .bind(
        "indexed",
        indexedAt,
        JSON.stringify(metadata),
        Date.now(),
        normalizeRepoOwner(owner),
        normalizeRepoName(name),
        id
      )
      .run();
    return this.getDocument(owner, name, id);
  }

  async markIndexFailed(
    owner: string,
    name: string,
    id: string,
    errorSummary: string
  ): Promise<RepoContextDocumentRecord | null> {
    const now = Date.now();
    const existingMetadata = (await this.getRawMetadata(owner, name, id)) ?? {};
    const metadata = {
      ...existingMetadata,
      indexing: {
        status: "failed",
        failedAt: now,
        error: errorSummary,
      },
    };
    await this.db
      .prepare(
        `UPDATE repo_context_documents
         SET ingest_status = ?, metadata = ?, updated_at = ?
         WHERE repo_owner = ? AND repo_name = ? AND id = ?`
      )
      .bind(
        "failed",
        JSON.stringify(metadata),
        now,
        normalizeRepoOwner(owner),
        normalizeRepoName(name),
        id
      )
      .run();
    return this.getDocument(owner, name, id);
  }

  async deleteDocument(owner: string, name: string, id: string): Promise<boolean> {
    const repoOwner = normalizeRepoOwner(owner);
    const repoName = normalizeRepoName(name);
    await this.db
      .prepare(
        "DELETE FROM repo_context_decisions WHERE repo_owner = ? AND repo_name = ? AND document_id = ?"
      )
      .bind(repoOwner, repoName, id)
      .run();
    const result = await this.db
      .prepare(
        "DELETE FROM repo_context_documents WHERE repo_owner = ? AND repo_name = ? AND id = ?"
      )
      .bind(repoOwner, repoName, id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async upsertDecision(
    owner: string,
    name: string,
    input: {
      id: string;
      title: string;
      summary: string;
      status: ContextDecisionStatus;
      documentId?: string;
    }
  ): Promise<RepoContextDecisionRecord> {
    const repoOwner = normalizeRepoOwner(owner);
    const repoName = normalizeRepoName(name);
    const now = Date.now();
    const existing = await this.db
      .prepare(
        "SELECT created_at FROM repo_context_decisions WHERE repo_owner = ? AND repo_name = ? AND id = ?"
      )
      .bind(repoOwner, repoName, input.id)
      .first<{ created_at: number }>();

    await this.db
      .prepare(
        `INSERT INTO repo_context_decisions
         (id, repo_owner, repo_name, document_id, title, summary, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_owner, repo_name, id) DO UPDATE SET
           document_id = excluded.document_id,
           title = excluded.title,
           summary = excluded.summary,
           status = excluded.status,
           updated_at = excluded.updated_at`
      )
      .bind(
        input.id,
        repoOwner,
        repoName,
        input.documentId ?? null,
        input.title,
        input.summary,
        input.status,
        existing?.created_at ?? now,
        now
      )
      .run();

    const decision = await this.getDecision(owner, name, input.id);
    if (!decision) throw new Error("Failed to upsert decision");
    return decision;
  }

  async getDecision(
    owner: string,
    name: string,
    id: string
  ): Promise<RepoContextDecisionRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT * FROM repo_context_decisions WHERE repo_owner = ? AND repo_name = ? AND id = ?"
      )
      .bind(normalizeRepoOwner(owner), normalizeRepoName(name), id)
      .first<DecisionRow>();
    return row ? toDecisionRecord(row) : null;
  }

  async getDecisionLineage(
    owner: string,
    name: string,
    id: string
  ): Promise<RepoContextDecisionEdgeRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT from_decision_id, to_decision_id, edge_type, created_at
         FROM repo_context_decision_edges
         WHERE repo_owner = ? AND repo_name = ? AND (from_decision_id = ? OR to_decision_id = ?)
         ORDER BY created_at DESC`
      )
      .bind(normalizeRepoOwner(owner), normalizeRepoName(name), id, id)
      .all<DecisionEdgeRow>();
    return (rows.results || []).map((row) => ({
      fromDecisionId: row.from_decision_id,
      toDecisionId: row.to_decision_id,
      edgeType: row.edge_type,
      createdAt: row.created_at,
    }));
  }

  async setDecisionEdges(
    owner: string,
    name: string,
    fromDecisionId: string,
    edges: Array<{ toDecisionId: string; edgeType: ContextDecisionEdgeType }>
  ): Promise<void> {
    const repoOwner = normalizeRepoOwner(owner);
    const repoName = normalizeRepoName(name);
    const now = Date.now();
    await this.db
      .prepare(
        "DELETE FROM repo_context_decision_edges WHERE repo_owner = ? AND repo_name = ? AND from_decision_id = ?"
      )
      .bind(repoOwner, repoName, fromDecisionId)
      .run();

    if (edges.length === 0) return;
    const statements = edges.map((edge) =>
      this.db
        .prepare(
          `INSERT INTO repo_context_decision_edges
           (repo_owner, repo_name, from_decision_id, to_decision_id, edge_type, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(repoOwner, repoName, fromDecisionId, edge.toDecisionId, edge.edgeType, now)
    );
    await this.db.batch(statements);
  }

  async searchDocuments(
    owner: string,
    name: string,
    query: string,
    limit = 5
  ): Promise<ContextSearchResult[]> {
    const docs = await this.listDocuments(owner, name, 250);
    const queryTokens = query
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter((token) => token.length >= 2);
    const scored = docs
      .map((doc) => ({
        document: doc,
        score: lexicalScore(
          `${doc.title}\n${doc.content}\n${(doc.tags || []).join(" ")}`,
          queryTokens
        ),
      }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(limit, 20)));

    return scored.map((result) => ({
      ...result,
      citations: [
        {
          documentId: result.document.id,
          title: result.document.title,
          excerpt: excerptForCitation(result.document.content),
        },
      ],
    }));
  }
}
