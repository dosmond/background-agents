---
title: feat: Web App Clarifying Question Loop
type: feat
status: completed
date: 2026-02-21
source_brainstorm: docs/brainstorms/2026-02-21-web-app-command-clarifying-qa-brainstorm.md
---

# feat: Web App Clarifying Question Loop

## Overview

Add Cursor/Claude-like model clarifying questions to the web app with a blocking answer flow, plus
explicit slash-command recognition. This plan keeps MCP capabilities out of scope for v1 and focuses
on reliable event contracts, session state transitions, replay/reconnect correctness, and safe
answer validation.

## Problem Statement / Motivation

Current chat flow treats every user input as a direct prompt and lacks structured model-to-user
clarification. That makes ambiguous requests slower and less reliable to execute. We need:

- model-initiated clarifying questions during runs,
- first-class UI to answer them,
- deterministic blocking/resume behavior,
- and slash command recognition for command ergonomics.

## Proposed Solution

Implement an additive clarifying-question protocol across shared types, control plane, and web UI:

1. Add new event/message contracts for `clarifying_question` and answer submission.
2. Extend session queue behavior with an explicit blocked state (`awaiting_user_answer`).
3. Persist pending question state and answered status so reconnect, replay, and DO hibernation are
   safe.
4. Add UI components to render single-choice, multi-select, and optional Other text answers.
5. Add slash command parsing/validation (`/plan`, `/explain`, `/debug`, `/refactor`, `/test`)
   without regressing non-slash prompts.

## Technical Considerations

- **Architecture impact:** touches `packages/shared`, `packages/control-plane`, and `packages/web`
  event lifecycles.
- **State integrity:** first-valid-answer-wins idempotency is required to prevent duplicate resume
  paths (multi-tab/multi-user).
- **Timeout behavior:** blocked runs must have explicit timeout policy (recommended: keep execution
  timeout active and fail with stale-question response when reached).
- **Backward compatibility:** all contracts are additive; old clients must fail gracefully without
  breaking current prompt flow.
- **Conventions:** TypeScript durations in milliseconds, centralized constants, and explicit unit
  suffixes per `CLAUDE.md`.

## Research Findings

### Internal references

- Existing socket/event flow:
  - `packages/control-plane/src/types.ts`
  - `packages/control-plane/src/session/durable-object.ts`
  - `packages/control-plane/src/session/message-queue.ts`
  - `packages/control-plane/src/session/sandbox-events.ts`
  - `packages/web/src/hooks/use-session-socket.ts`
  - `packages/web/src/app/(app)/session/[id]/page.tsx`
- Brainstorm constraints and acceptance baseline:
  - `docs/brainstorms/2026-02-21-web-app-command-clarifying-qa-brainstorm.md`

### Institutional learnings

- No `docs/solutions/` corpus exists in this repo; planning is based on current architecture and
  prior project docs.
- Replay/hydration and event persistence are critical: pending question state must survive reconnect
  and Durable Object hibernation.

### External research decision

Skipped. Local code patterns and constraints are strong, and the feature is architecture-internal
rather than framework-unknown.

## SpecFlow Gaps Incorporated

- Define stop behavior while blocked.
- Define timeout behavior while blocked.
- Define stale and invalid-answer semantics.
- Define multi-tab first-answer-wins UX.
- Ensure `clarifying_question` / `clarifying_answer` events appear in replay/history.
- Ensure slash-command flow is validated with clarifying-question loop.

## Implementation Plan

### Phase 1: Contracts and Session State Foundation

- Extend shared unions in `packages/shared/src/types/index.ts` and
  `packages/control-plane/src/types.ts`:
  - `SandboxEvent` variant: `clarifying_question`
  - `SandboxEvent` variant: `clarifying_answer` (for echo/audit trail)
  - `ClientMessage` variant: `answer_clarifying_question`
  - extend `processing_status` payload with blocked metadata (e.g. `blockedReason`).
- Add/extend persistent session state fields in control plane storage for:
  - pending `questionId`,
  - question payload,
  - answered flag/idempotency key.
- Add constants for validation limits (e.g. `MAX_OTHER_TEXT_LENGTH`) with single source of truth.

### Phase 2: Control Plane Blocking/Resume Logic

- In `packages/control-plane/src/session/durable-object.ts`:
  - route and validate `answer_clarifying_question`,
  - return deterministic errors for stale/invalid/already-answered cases.
- In `packages/control-plane/src/session/message-queue.ts`:
  - enforce blocked gate while awaiting answer,
  - resume processing only once after first valid answer.
- In `packages/control-plane/src/session/sandbox-events.ts`:
  - persist/broadcast `clarifying_question`,
  - persist/broadcast `clarifying_answer`,
  - include both in replay-visible events.
- Stop and timeout behavior:
  - stop during blocked marks run failed, clears pending question,
  - timeout during blocked marks run failed, clears pending question, emits stale-question
    semantics.

### Phase 3: Web App UX and Validation

- In `packages/web/src/hooks/use-session-socket.ts`:
  - parse/store `clarifying_question`,
  - expose `submitClarifyingAnswer`,
  - track blocked processing state and recovery states.
- In `packages/web/src/app/(app)/session/[id]/page.tsx` and new UI components:
  - render pending question card in timeline,
  - implement single-select, multi-select, optional Other text,
  - enforce required answer and field-level validation.
- UX behavior:
  - while blocked, show explicit “Waiting for your answer” status,
  - after submit, show “Resuming…” state,
  - map server errors to actionable recovery text.

### Phase 4: Slash Command Recognition

- Parse first token for slash command in web input submit path.
- Validate against v1 whitelist.
- Unsupported command returns immediate in-UI validation and does not dispatch prompt.
- Supported command sends optional command metadata along with prompt.
- Non-slash prompts continue unchanged.

### Phase 5: Replay/Reconnect/Idempotency Hardening

- Ensure replay payload restores pending question state on subscribe.
- Ensure history pagination includes clarifying question/answer events.
- Ensure multi-tab behavior: first valid answer wins; subsequent answer attempts return
  deterministic already-answered result.

## Acceptance Criteria

### Functional

- [x] Supported slash commands are recognized and submitted with command metadata.
- [x] Unsupported slash commands fail fast in UI without starting execution.
- [x] Model can emit `clarifying_question` at runtime for slash and non-slash prompts.
- [x] Active run blocks until a valid user answer is submitted.
- [x] UI supports single-choice, multi-select, and optional Other text.
- [x] Empty required answers are blocked client-side and server-side.
- [x] Answer submission resumes the paused run context exactly once.
- [x] `clarifying_answer` appears in session history for auditability.

### Reliability and State Integrity

- [x] Reconnect/reload restores pending question and blocked state.
- [x] DO hibernation does not lose pending question state.
- [x] Duplicate submissions are idempotent (first valid answer wins).
- [x] Multi-tab/session participants observe consistent answered state.
- [x] Stop while blocked fails run and clears pending question state.
- [x] Timeout while blocked follows defined stale/fail behavior.

### Error Handling

- [x] Invalid option IDs return validation error without resume.
- [x] Stale question submissions return deterministic stale error.
- [x] Disconnected submission failures show retry guidance.

## Success Metrics

- Increase in tasks completed without user re-prompting due to ambiguity.
- Reduction in aborted runs caused by missing context.
- Low rate of duplicate-answer race incidents (idempotency working).
- No regression in baseline non-slash chat flows.

## Dependencies & Risks

- **Dependencies**
  - Shared type updates consumed by both web and control-plane packages.
  - Sandbox event emission path must support `clarifying_question` payload shape.
- **Risks**
  - blocked-state deadlocks if queue transition guards are incomplete,
  - replay inconsistency if pending question state is only in memory,
  - UX confusion in multi-user sessions if answer ownership is unclear.
- **Mitigations**
  - explicit state machine transitions in queue layer,
  - persisted pending question state in SQLite-backed session data,
  - participant attribution for answer events in UI.

## Testing Plan

### Unit and integration

- `packages/control-plane`: queue transition tests, stale/invalid answer validation, idempotency
  tests, stop/timeout blocked-state tests.
- `packages/web`: hook state tests for pending question lifecycle and reconnect restore.

### End-to-end scenarios

- slash command -> clarifying question -> answer -> resume -> completion
- non-slash prompt -> clarifying question -> answer -> completion
- blocked + stop
- blocked + timeout
- blocked + reconnect
- dual-tab simultaneous answer attempts

## References

- Brainstorm: `docs/brainstorms/2026-02-21-web-app-command-clarifying-qa-brainstorm.md`
- Existing implementation draft:
  `docs/plans/2026-02-21-web-app-command-clarifying-qa-implementation-plan.md`
- Core code paths:
  - `packages/control-plane/src/session/durable-object.ts`
  - `packages/control-plane/src/session/message-queue.ts`
  - `packages/control-plane/src/session/sandbox-events.ts`
  - `packages/web/src/hooks/use-session-socket.ts`
  - `packages/web/src/app/(app)/session/[id]/page.tsx`
