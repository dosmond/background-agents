import { MAX_SESSION_TITLE_LENGTH, trimSessionTitle } from "@open-inspect/shared";
import type { Env } from "../types";
import type { Logger } from "../logger";
import type { SessionRow } from "./types";
import { OpenAITokenRefreshService } from "./openai-token-refresh-service";
import { extractProviderAndModel } from "../utils/models";

const TITLE_GENERATION_MODEL_ID = "openai/gpt-5.2";
const TITLE_GENERATION_TIMEOUT_MS = 8000;

interface SessionTitleGenerationServiceDeps {
  env: Env;
  db: Env["DB"];
  log: Logger;
  ensureRepoId: (session: SessionRow) => Promise<number>;
}

type OpenAIChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?:
        | string
        | Array<{
            type?: string;
            text?: string;
          }>;
    };
  }>;
};

export class SessionTitleGenerationService {
  constructor(private readonly deps: SessionTitleGenerationServiceDeps) {}

  async generateFromFirstPrompt(
    session: SessionRow,
    promptContent: string
  ): Promise<string | null> {
    if (!this.deps.env.REPO_SECRETS_ENCRYPTION_KEY) {
      return null;
    }

    const refreshService = new OpenAITokenRefreshService(
      this.deps.db,
      this.deps.env.REPO_SECRETS_ENCRYPTION_KEY,
      this.deps.ensureRepoId,
      this.deps.log
    );
    const tokenResult = await refreshService.refresh(session);
    if (!tokenResult.ok) {
      return null;
    }

    const { provider, model } = extractProviderAndModel(TITLE_GENERATION_MODEL_ID);
    if (provider !== "openai") {
      return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TITLE_GENERATION_TIMEOUT_MS);

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenResult.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_completion_tokens: 48,
          messages: [
            {
              role: "system",
              content:
                "Generate a concise session title from the user's first prompt. Return title text only, no quotes, no punctuation suffix.",
            },
            {
              role: "user",
              content: `First prompt:\n${promptContent}`,
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.deps.log.warn("AI title generation request failed", {
          status: response.status,
        });
        return null;
      }

      const payload = (await response.json()) as OpenAIChatCompletionResponse;
      const rawContent = payload.choices?.[0]?.message?.content;
      const text =
        typeof rawContent === "string"
          ? rawContent
          : rawContent?.find((item) => item.type === "text")?.text;
      if (!text) return null;

      const cleaned = this.sanitizeTitle(text);
      return cleaned.length > 0 ? cleaned : null;
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        this.deps.log.warn("AI title generation threw error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private sanitizeTitle(input: string): string {
    const normalizedWhitespace = input.replace(/\s+/g, " ");
    const withoutQuotes = normalizedWhitespace.replace(/^["'\s]+|["'\s]+$/g, "");
    const trimmed = trimSessionTitle(withoutQuotes);
    if (trimmed.length <= MAX_SESSION_TITLE_LENGTH) return trimmed;
    return trimmed.slice(0, MAX_SESSION_TITLE_LENGTH).trimEnd();
  }
}
