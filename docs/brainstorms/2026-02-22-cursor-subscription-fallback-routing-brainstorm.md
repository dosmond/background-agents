---
date: 2026-02-22
topic: cursor-subscription-fallback-routing
---

# Cursor Subscription With Provider Fallback

## What We're Building

Define a model routing policy for Open-Inspect where Cursor is the primary execution path for models
Cursor supports, and provider API tokens are used when (a) a requested model is not available via
Cursor or (b) Cursor returns a hard-limit/quota signal. The key product requirement is no user
interruption when this transition happens.

Open-Inspect remains the system of record for session state, conversation history, and context
injection. Backend model execution can switch providers without changing user-facing session
behavior.

## Why This Approach

We considered user-selectable dual mode and proactive preflight routing. Dual mode is simpler but
does not meet the seamless continuity goal when limits are hit. Preflight routing may reduce
failures, but adds complexity before we confirm hard-limit frequency in real usage.

Cursor-first with strict hard-limit failover is the smallest approach that matches the stated
priorities: cost control first, strict preference for Cursor, and continuity of session experience.

## Key Decisions

- Cursor-first routing policy: Every eligible request attempts Cursor first for cost control and
  default behavior consistency.
- Unsupported-model routing: If the requested model is unavailable in Cursor, route directly to
  provider API tokens.
- Strict fallback trigger: Provider token fallback is allowed only after recognized hard-limit/quota
  responses from Cursor.
- Control-plane source of truth: Open-Inspect control plane owns session state and context injection
  regardless of which backend executes.
- Seamless user experience target: Fallback should happen without requiring user intervention
  mid-session.

## Session Tracking Implications

- Open-Inspect should persist a stable mapping between internal session IDs and external Cursor
  agent IDs.
- Open-Inspect remains the canonical source for session metadata, context policy, and user-visible
  history.
- Cursor status and conversation data should be mirrored into Open-Inspect through API polling
  and/or webhooks.
- Any MCP-dependent behavior should be treated as out of scope for the Cursor Cloud Agents backend
  until Cursor adds MCP support.

## Resolved Questions

- Hard-limit detection: Treat HTTP 429 responses and explicit quota/credits-exhausted error signals
  as failover-eligible.
- Post-failover behavior: Pin routing to provider mode for a cooldown window, then re-attempt
  Cursor.
- User visibility in v1: Show a subtle session-level indicator when provider fallback occurs.
- Cooldown default: Make cooldown configurable with a default of 15 minutes.

## Open Questions

- None currently.

## Next Steps

→ `/workflows:plan` for implementation design, routing boundaries, failure semantics, and
verification strategy.
