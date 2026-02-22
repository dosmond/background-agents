import { describe, expect, it, vi } from "vitest";
import { RepoContextDocumentsStore } from "./repo-context-documents";

function createDocumentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    repo_owner: "owner",
    repo_name: "repo",
    title: "Doc",
    source_type: "note",
    content: "hello",
    tags: null,
    timeframe_start: null,
    timeframe_end: null,
    metadata: null,
    ingest_status: "pending_index",
    indexed_at: null,
    created_by: "user",
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe("RepoContextDocumentsStore status transitions", () => {
  it("marks a document indexed and sets indexed timestamp", async () => {
    const prepare = vi.fn((sql: string) => {
      if (sql.startsWith("SELECT metadata FROM repo_context_documents")) {
        return {
          bind: () => ({ first: async () => ({ metadata: null }) }),
        };
      }
      if (sql.startsWith("UPDATE repo_context_documents")) {
        return { bind: () => ({ run: async () => ({}) }) };
      }
      if (sql.startsWith("SELECT * FROM repo_context_documents")) {
        return {
          bind: () =>
            ({
              first: async () =>
                createDocumentRow({
                  ingest_status: "indexed",
                  indexed_at: 1234,
                  metadata: JSON.stringify({ indexing: { status: "indexed", indexedAt: 1234 } }),
                }),
            }) as unknown,
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const store = new RepoContextDocumentsStore({ prepare } as unknown as D1Database);
    const result = await store.markIndexed("owner", "repo", "doc-1", 1234);
    expect(result?.ingestStatus).toBe("indexed");
    expect(result?.indexedAt).toBe(1234);
  });

  it("marks a document failed and stores failure metadata", async () => {
    const prepare = vi.fn((sql: string) => {
      if (sql.startsWith("SELECT metadata FROM repo_context_documents")) {
        return {
          bind: () => ({ first: async () => ({ metadata: JSON.stringify({ original: true }) }) }),
        };
      }
      if (sql.startsWith("UPDATE repo_context_documents")) {
        return { bind: () => ({ run: async () => ({}) }) };
      }
      if (sql.startsWith("SELECT * FROM repo_context_documents")) {
        return {
          bind: () =>
            ({
              first: async () =>
                createDocumentRow({
                  ingest_status: "failed",
                  metadata: JSON.stringify({
                    original: true,
                    indexing: { status: "failed", error: "boom" },
                  }),
                }),
            }) as unknown,
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const store = new RepoContextDocumentsStore({ prepare } as unknown as D1Database);
    const result = await store.markIndexFailed("owner", "repo", "doc-1", "boom");
    expect(result?.ingestStatus).toBe("failed");
    expect((result?.metadata?.indexing as { error?: string })?.error).toBe("boom");
  });
});
