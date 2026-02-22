import { describe, expect, it, vi } from "vitest";
import {
  contextDocumentR2Key,
  mirrorContextDocumentToR2,
  deleteContextDocumentFromR2,
} from "./context-documents-r2";
import type { RepoContextDocumentRecord } from "../db/repo-context-documents";
import type { Env } from "../types";

function makeDocument(): RepoContextDocumentRecord {
  return {
    id: "doc-123",
    repoOwner: "Owner",
    repoName: "Repo",
    title: "Roadmap",
    sourceType: "note",
    content: "Ship the thing.",
    tags: ["planning", "q1"],
    ingestStatus: "pending_index",
    createdBy: "alice",
    createdAt: 100,
    updatedAt: 200,
  };
}

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

describe("context-documents-r2", () => {
  it("builds a deterministic lowercase key", () => {
    expect(contextDocumentR2Key(" MyOrg ", " MyRepo ", "doc-1")).toBe("myorg/myrepo/doc-1.txt");
  });

  it("mirrors documents into r2 bucket", async () => {
    const put = vi.fn(async (..._args: unknown[]) => {});
    const env = makeEnv({
      CONTEXT_DOCUMENTS_BUCKET: {
        put,
      } as unknown as R2Bucket,
    });

    await mirrorContextDocumentToR2(env, makeDocument());

    expect(put).toHaveBeenCalledTimes(1);
    const [key, content, options] = put.mock.calls[0];
    expect(key).toBe("owner/repo/doc-123.txt");
    expect(content).toContain("title: Roadmap");
    expect(content).toContain("Ship the thing.");
    expect(options).toEqual({ httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  });

  it("deletes mirrored document from r2 bucket", async () => {
    const del = vi.fn(async (..._args: unknown[]) => {});
    const env = makeEnv({
      CONTEXT_DOCUMENTS_BUCKET: {
        delete: del,
      } as unknown as R2Bucket,
    });

    await deleteContextDocumentFromR2(env, "Owner", "Repo", "doc-123");
    expect(del).toHaveBeenCalledWith("owner/repo/doc-123.txt");
  });
});
