import {
  RepoContextDocumentsStore,
  type ContextSearchResult,
  type RepoContextDecisionEdgeRecord,
} from "../db/repo-context-documents";
import { CloudflareAiSearchClient } from "./cloudflare-ai-search";
import type { Env } from "../types";

export interface ContextCitation {
  documentId: string;
  title: string;
  excerpt: string;
  score?: number;
}

export interface SearchContextResponse {
  query: string;
  results: Array<{
    id: string;
    title: string;
    sourceType: string;
    score: number;
    citations: ContextCitation[];
  }>;
}

export interface DecisionResponse {
  id: string;
  title: string;
  summary: string;
  status: string;
  citations: ContextCitation[];
}

export interface ContextPackResponse {
  taskOrScope: string;
  generatedAt: number;
  decisions: DecisionResponse[];
  supportingDocuments: Array<{
    id: string;
    title: string;
    sourceType: string;
    citations: ContextCitation[];
  }>;
}

function toCitationFromLocal(result: ContextSearchResult): ContextCitation[] {
  return result.citations.map((citation) => ({
    documentId: citation.documentId,
    title: citation.title,
    excerpt: citation.excerpt,
    score: result.score,
  }));
}

export class ContextRetrievalService {
  private readonly store: RepoContextDocumentsStore;
  private readonly cloudflareSearch: CloudflareAiSearchClient;

  constructor(private readonly env: Env) {
    this.store = new RepoContextDocumentsStore(env.DB);
    this.cloudflareSearch = new CloudflareAiSearchClient(env);
  }

  async searchContext(
    owner: string,
    name: string,
    query: string,
    maxResults = 6
  ): Promise<SearchContextResponse> {
    const localResults = await this.store.searchDocuments(owner, name, query, maxResults);
    const enriched = localResults.map((result) => ({
      id: result.document.id,
      title: result.document.title,
      sourceType: result.document.sourceType,
      score: result.score,
      citations: toCitationFromLocal(result),
    }));

    if (this.cloudflareSearch.isConfigured()) {
      try {
        const filters = {
          repo_owner: owner.toLowerCase(),
          repo_name: name.toLowerCase(),
        };
        const remote = await this.cloudflareSearch.search(query, {
          maxNumResults: maxResults,
          scoreThreshold: 0.2,
          rewriteQuery: true,
          filters,
          reranking: { enabled: true, model: "@cf/baai/bge-reranker-base" },
        });
        if (remote?.results.length) {
          return {
            query,
            results: remote.results.slice(0, maxResults).map((row) => ({
              id: row.fileId || row.filename,
              title: row.filename,
              sourceType: "indexed",
              score: row.score,
              citations: [
                {
                  documentId: row.fileId || row.filename,
                  title: row.filename,
                  excerpt: row.content.slice(0, 220),
                  score: row.score,
                },
              ],
            })),
          };
        }
      } catch {
        // Cloudflare path is best-effort; local search remains source of truth fallback.
      }
    }

    return { query, results: enriched };
  }

  async getDecision(owner: string, name: string, id: string): Promise<DecisionResponse | null> {
    const decision = await this.store.getDecision(owner, name, id);
    if (!decision) return null;
    const doc = decision.documentId
      ? await this.store.getDocument(owner, name, decision.documentId)
      : null;
    return {
      id: decision.id,
      title: decision.title,
      summary: decision.summary,
      status: decision.status,
      citations: doc
        ? [
            {
              documentId: doc.id,
              title: doc.title,
              excerpt: doc.content.slice(0, 220),
            },
          ]
        : [],
    };
  }

  async getDecisionLineage(
    owner: string,
    name: string,
    id: string
  ): Promise<RepoContextDecisionEdgeRecord[]> {
    return this.store.getDecisionLineage(owner, name, id);
  }

  async buildContextPack(
    owner: string,
    name: string,
    taskOrScope: string,
    maxResults = 6
  ): Promise<ContextPackResponse> {
    const search = await this.searchContext(owner, name, taskOrScope, maxResults);
    const docs = await this.store.listDocuments(owner, name, maxResults);
    const decisions: DecisionResponse[] = [];
    for (const doc of docs.slice(0, 3)) {
      const decision = await this.store.getDecision(owner, name, `decision:${doc.id}`);
      if (!decision) continue;
      decisions.push({
        id: decision.id,
        title: decision.title,
        summary: decision.summary,
        status: decision.status,
        citations: [
          {
            documentId: doc.id,
            title: doc.title,
            excerpt: doc.content.slice(0, 220),
          },
        ],
      });
    }

    return {
      taskOrScope,
      generatedAt: Date.now(),
      decisions,
      supportingDocuments: search.results.map((result) => ({
        id: result.id,
        title: result.title,
        sourceType: result.sourceType,
        citations: result.citations,
      })),
    };
  }
}
