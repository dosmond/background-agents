import type { Env } from "../types";

export interface CloudflareAiSearchDocumentResult {
  fileId: string;
  filename: string;
  score: number;
  content: string;
  attributes?: Record<string, unknown>;
}

export interface CloudflareAiSearchResponse {
  searchQuery: string;
  response?: string;
  results: CloudflareAiSearchDocumentResult[];
}

export interface CloudflareAiSearchQueryOptions {
  maxNumResults?: number;
  scoreThreshold?: number;
  filters?: Record<string, unknown>;
  rewriteQuery?: boolean;
  reranking?: { enabled?: boolean; model?: string };
}

export class CloudflareAiSearchClient {
  constructor(private readonly env: Env) {}

  isConfigured(): boolean {
    return Boolean(
      this.env.CF_ACCOUNT_ID &&
      this.env.CLOUDFLARE_AI_SEARCH_AUTORAG_NAME &&
      this.env.CLOUDFLARE_AI_SEARCH_API_TOKEN
    );
  }

  private endpoint(path: "search" | "ai-search"): string {
    return `https://api.cloudflare.com/client/v4/accounts/${this.env.CF_ACCOUNT_ID}/autorag/rags/${this.env.CLOUDFLARE_AI_SEARCH_AUTORAG_NAME}/${path}`;
  }

  async search(
    query: string,
    options: CloudflareAiSearchQueryOptions = {}
  ): Promise<CloudflareAiSearchResponse | null> {
    if (!this.isConfigured()) return null;

    const response = await fetch(this.endpoint("search"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.env.CLOUDFLARE_AI_SEARCH_API_TOKEN!}`,
      },
      body: JSON.stringify({
        query,
        rewrite_query: options.rewriteQuery ?? false,
        max_num_results: Math.max(1, Math.min(options.maxNumResults ?? 8, 50)),
        ranking_options:
          options.scoreThreshold !== undefined
            ? { score_threshold: options.scoreThreshold }
            : undefined,
        reranking: options.reranking,
        filters: options.filters,
      }),
    });

    if (!response.ok) {
      throw new Error(`Cloudflare AI Search request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      success?: boolean;
      result?: {
        search_query?: string;
        response?: string;
        data?: Array<{
          file_id?: string;
          filename?: string;
          score?: number;
          attributes?: Record<string, unknown>;
          content?: Array<{ text?: string }>;
        }>;
      };
    };

    const rows = payload.result?.data ?? [];
    return {
      searchQuery: payload.result?.search_query ?? query,
      response: payload.result?.response,
      results: rows.map((row) => ({
        fileId: row.file_id ?? "",
        filename: row.filename ?? "unknown",
        score: row.score ?? 0,
        content: (row.content ?? [])
          .map((item) => item.text)
          .filter((value): value is string => typeof value === "string")
          .join("\n"),
        attributes: row.attributes,
      })),
    };
  }
}
