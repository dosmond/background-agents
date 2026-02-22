import { describe, expect, it, vi, afterEach } from "vitest";
import { CloudflareAiSearchClient, CloudflareAiSearchError } from "./cloudflare-ai-search";
import type { Env } from "../types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SESSION: {} as DurableObjectNamespace,
    REPOS_CACHE: {} as KVNamespace,
    DB: {} as D1Database,
    TOKEN_ENCRYPTION_KEY: "token-key",
    DEPLOYMENT_NAME: "test",
    ...overrides,
  };
}

describe("CloudflareAiSearchClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when configuration is missing", async () => {
    const client = new CloudflareAiSearchClient(makeEnv());
    const result = await client.search("hello");
    expect(result).toBeNull();
  });

  it("maps search response documents", async () => {
    const client = new CloudflareAiSearchClient(
      makeEnv({
        CF_ACCOUNT_ID: "acc",
        CLOUDFLARE_AI_SEARCH_AUTORAG_NAME: "rag",
        CLOUDFLARE_AI_SEARCH_API_TOKEN: "token",
      })
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          result: {
            search_query: "shipping policy",
            data: [
              {
                file_id: "doc-1",
                filename: "meetings/2026-02-20.md",
                score: 0.91,
                content: [{ text: "Decisions from planning meeting." }],
              },
            ],
          },
        }),
      }))
    );

    const result = await client.search("shipping policy");
    expect(result?.searchQuery).toBe("shipping policy");
    expect(result?.results[0].fileId).toBe("doc-1");
    expect(result?.results[0].content).toContain("planning meeting");
  });

  it("indexes document on successful ingest endpoint", async () => {
    const client = new CloudflareAiSearchClient(
      makeEnv({
        CF_ACCOUNT_ID: "acc",
        CLOUDFLARE_AI_SEARCH_AUTORAG_NAME: "rag",
        CLOUDFLARE_AI_SEARCH_API_TOKEN: "token",
      })
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => "",
      }))
    );

    await expect(
      client.indexDocument({
        documentId: "doc-123",
        filename: "repo/doc-123.txt",
        content: "hello",
      })
    ).resolves.toBeUndefined();
  });

  it("falls back across ingest endpoints and throws with details", async () => {
    const client = new CloudflareAiSearchClient(
      makeEnv({
        CF_ACCOUNT_ID: "acc",
        CLOUDFLARE_AI_SEARCH_AUTORAG_NAME: "rag",
        CLOUDFLARE_AI_SEARCH_API_TOKEN: "token",
      })
    );

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "not found",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 405,
        text: async () => "method not allowed",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "bad request",
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client.indexDocument({
        documentId: "doc-123",
        filename: "repo/doc-123.txt",
        content: "hello",
      })
    ).rejects.toBeInstanceOf(CloudflareAiSearchError);
  });
});
