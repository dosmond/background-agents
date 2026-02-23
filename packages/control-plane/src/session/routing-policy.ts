import { isCursorSupportedModel } from "../utils/models";

export type ProviderMode = "cursor" | "provider";

export type ProviderFallbackReason = "unsupported_model" | "cursor_429" | "cursor_quota_exhausted";

export const DEFAULT_CURSOR_FALLBACK_COOLDOWN_MS = 15 * 60 * 1000;

export interface RoutingStateSnapshot {
  providerMode: ProviderMode;
  providerFallbackUntilMs: number | null;
  providerFallbackReason: ProviderFallbackReason | null;
}

export interface RoutingPolicyInput {
  model: string;
  nowMs: number;
  cursorRoutingEnabled: boolean;
  existingState: RoutingStateSnapshot;
}

export interface RoutingPolicyDecision {
  route: ProviderMode;
  nextState: RoutingStateSnapshot;
}

export function shouldUseProviderDueToCooldown(
  state: RoutingStateSnapshot,
  nowMs: number
): boolean {
  return (
    state.providerMode === "provider" &&
    typeof state.providerFallbackUntilMs === "number" &&
    state.providerFallbackUntilMs > nowMs
  );
}

export function decideRouting(input: RoutingPolicyInput): RoutingPolicyDecision {
  const { model, nowMs, cursorRoutingEnabled, existingState } = input;
  const cursorSupported = isCursorSupportedModel(model);
  const cooldownActive = shouldUseProviderDueToCooldown(existingState, nowMs);

  if (!cursorRoutingEnabled || !cursorSupported) {
    return {
      route: "provider",
      nextState: {
        providerMode: "provider",
        providerFallbackUntilMs: null,
        providerFallbackReason: "unsupported_model",
      },
    };
  }

  if (cooldownActive) {
    return {
      route: "provider",
      nextState: existingState,
    };
  }

  return {
    route: "cursor",
    nextState: {
      providerMode: "cursor",
      providerFallbackUntilMs: null,
      providerFallbackReason: null,
    },
  };
}

export function classifyHardLimitFallbackReason(
  errorMessage: string | null | undefined
): ProviderFallbackReason | null {
  if (!errorMessage) return null;
  const normalized = errorMessage.toLowerCase();

  if (/\b429\b/.test(normalized) || normalized.includes("rate limit")) {
    return "cursor_429";
  }
  if (
    normalized.includes("quota") ||
    normalized.includes("credits exhausted") ||
    normalized.includes("credit balance") ||
    normalized.includes("insufficient credits")
  ) {
    return "cursor_quota_exhausted";
  }
  return null;
}
