import { describe, expect, it } from "vitest";
import {
  classifyHardLimitFallbackReason,
  decideRouting,
  shouldUseProviderDueToCooldown,
} from "./routing-policy";

describe("routing-policy", () => {
  it("routes unsupported models to provider", () => {
    const result = decideRouting({
      model: "anthropic/claude-sonnet-4-6",
      nowMs: 1000,
      cursorRoutingEnabled: true,
      existingState: {
        providerMode: "cursor",
        providerFallbackUntilMs: null,
        providerFallbackReason: null,
      },
    });

    expect(result.route).toBe("provider");
    expect(result.nextState.providerFallbackReason).toBe("unsupported_model");
  });

  it("routes cursor-supported models to cursor when cooldown inactive", () => {
    const result = decideRouting({
      model: "openai/gpt-5.3-codex",
      nowMs: 1000,
      cursorRoutingEnabled: true,
      existingState: {
        providerMode: "provider",
        providerFallbackUntilMs: 900,
        providerFallbackReason: "cursor_429",
      },
    });

    expect(result.route).toBe("cursor");
    expect(result.nextState.providerFallbackUntilMs).toBeNull();
    expect(result.nextState.providerFallbackReason).toBeNull();
  });

  it("keeps provider route while cooldown active", () => {
    expect(
      shouldUseProviderDueToCooldown(
        {
          providerMode: "provider",
          providerFallbackUntilMs: 2000,
          providerFallbackReason: "cursor_429",
        },
        1000
      )
    ).toBe(true);
  });

  it("classifies 429 and quota signals", () => {
    expect(classifyHardLimitFallbackReason("HTTP 429 Too Many Requests")).toBe("cursor_429");
    expect(classifyHardLimitFallbackReason("quota exceeded for this account")).toBe(
      "cursor_quota_exhausted"
    );
  });
});
