---
date: 2026-02-22
topic: session-title-editing-and-first-prompt-auto-title
---

# Session Title Editing and First-Prompt Auto-Title

## What We're Building

Add two user-facing capabilities for sessions:

1. Users can manually rename a session from the session page header.
2. Sessions get an initial auto-generated title once, based on the first prompt.

The auto-title is generated only one time for a session. If generation fails or times out, the UI
falls back to the existing repository label behavior (owner/repo-style fallback) rather than
deriving a title from prompt text. Manual renames should update immediately across header, sidebar,
and other open views.

## Why This Approach

We chose an API-driven design with realtime broadcast updates because session metadata already spans
Durable Object + D1 index, and clients already consume live session state over WebSocket. A single
update path for title changes keeps behavior consistent between manual edits and server-side
auto-title assignment.

Alternatives considered:

- WebSocket-only title updates (less explicit API surface, tighter client coupling)
- Auto-title only now and defer manual editing (smaller scope but misses requested UX)

The selected approach is the best fit for current requirements while staying simple and aligned with
existing patterns.

## Key Decisions

- Manual rename entry point is session header only: keeps UI scope small and focused.
- Validation is trim + non-empty + max 120 chars: prevents noisy/unbounded titles.
- Auto-title is AI-generated from first prompt only: one-time naming avoids churn.
- Auto-title lifecycle is one-time and never auto-changes later: predictable behavior.
- Failure fallback is repo label (not prompt truncation): safe and stable fallback UX.
- Title updates must appear instantly everywhere: header, sidebar, and active views stay in sync.
- Use a dedicated title update API plus live broadcast: supports both edit and auto-set flows
  consistently.

## Resolved Questions

- Should first title come from prompt text or AI? → AI-generated.
- Should auto-title regenerate later? → No, one-time only.
- Where can user rename? → Session header only.
- Validation limits? → Max length around 120 chars (plus trim/non-empty).
- Update timing? → Immediate across all relevant views.
- Fallback on AI failure? → Keep repo label fallback.

## Open Questions

- None currently.

## Next Steps

→ `/workflows:plan` for implementation details (API shape, DO/D1 synchronization, and UI
interactions).
