import type { RepoContextDocumentRecord } from "../db/repo-context-documents";
import type { Env } from "../types";

function normalizePart(value: string): string {
  return value.trim().toLowerCase();
}

export function contextDocumentR2Key(owner: string, name: string, documentId: string): string {
  return `${normalizePart(owner)}/${normalizePart(name)}/${documentId}.txt`;
}

function buildDocumentText(document: RepoContextDocumentRecord): string {
  const tags = document.tags?.join(", ") || "";
  const metadata = document.metadata ? JSON.stringify(document.metadata) : "";
  const timeframe =
    document.timeframeStart || document.timeframeEnd
      ? `${document.timeframeStart ?? ""}-${document.timeframeEnd ?? ""}`
      : "";

  return [
    `title: ${document.title}`,
    `source_type: ${document.sourceType}`,
    `repo_owner: ${document.repoOwner}`,
    `repo_name: ${document.repoName}`,
    `document_id: ${document.id}`,
    `tags: ${tags}`,
    `created_by: ${document.createdBy}`,
    `created_at: ${document.createdAt}`,
    `updated_at: ${document.updatedAt}`,
    `timeframe: ${timeframe}`,
    metadata ? `metadata: ${metadata}` : "",
    "",
    document.content,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function requireBucket(env: Env): R2Bucket {
  if (!env.CONTEXT_DOCUMENTS_BUCKET) {
    throw new Error("Context documents R2 bucket is not configured");
  }
  return env.CONTEXT_DOCUMENTS_BUCKET;
}

export async function mirrorContextDocumentToR2(
  env: Env,
  document: RepoContextDocumentRecord
): Promise<void> {
  const bucket = requireBucket(env);
  const key = contextDocumentR2Key(document.repoOwner, document.repoName, document.id);
  await bucket.put(key, buildDocumentText(document), {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
}

export async function deleteContextDocumentFromR2(
  env: Env,
  owner: string,
  name: string,
  documentId: string
): Promise<void> {
  const bucket = requireBucket(env);
  const key = contextDocumentR2Key(owner, name, documentId);
  await bucket.delete(key);
}
