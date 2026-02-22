# Brainstorm: Web App Command + Clarifying Q&A

Date: 2026-02-21 Status: Finalized for planning handoff

## What We're Building

- Add slash-command recognition in the web app (explicit slash commands only for command UX).
- Add model-initiated clarifying questions during chat runs, with dedicated answer UI.
- Clarifying questions are blocking: execution pauses until the user responds.
- Clarifying-question behavior is global (not limited to slash commands).
- User answers are required in v1 (no skip behavior).

## Why This Approach

- It delivers a Cursor/Claude-like conversational loop in the web app with minimal conceptual
  overhead.
- It keeps command UX deterministic (slash-only) while allowing the model to ask for missing context
  in any run.
- It fits existing real-time session/event architecture without requiring MCP expansion in the same
  milestone.

## Key Decisions

- Primary milestone: Cursor-like chat UX first; MCP later.
- Command recognition: slash commands only.
- Clarification model behavior: global, model-initiated clarifying questions.
- Run control: blocking question flow.
- Answer types: single-choice, multi-select, and Other (free text).
- Question count: unlimited.
- User control: answer required; no skip in v1.

## Candidate Slash Commands (v1)

- `/plan`
- `/explain`
- `/debug`
- `/refactor`
- `/test`

## V1 Acceptance Criteria

### A. Command Recognition

1. When a user enters a supported slash command, the web app recognizes it and routes command
   metadata with the prompt.
2. Unsupported slash commands return a clear in-UI validation error and do not start execution.
3. Slash-command behavior is additive: non-slash prompts continue to work exactly as today.

### B. Clarifying Question Loop (Blocking)

1. The model can emit a structured clarifying question event at any point during run
   planning/execution.
2. On clarifying question event, active run transitions to blocked/waiting state until a user answer
   is submitted.
3. While blocked, users cannot start duplicate execution for the same pending question in the same
   session.
4. After answer submission, execution resumes from the paused run context without losing prior
   conversation state.
5. This behavior applies to both slash and non-slash prompts.

### C. Answer UI Capabilities

1. UI renders single-choice questions and allows exactly one selected answer.
2. UI renders multi-select questions and allows one or more selected answers.
3. UI supports optional Other free-text answers when enabled by the question payload.
4. UI enforces required-answer validation and prevents submission of empty answers.
5. Submitted answers are echoed into session history in a human-readable form for auditability.

### D. Reliability and UX Guardrails

1. Reconnect/reload restores pending clarifying question state for the session.
2. Duplicate answer submissions are idempotent (first valid answer wins for a pending question).
3. Error states (failed submit, stale question, disconnected session) show actionable recovery
   messaging.

## Non-Goals (This Milestone)

- MCP server setup and capability management UX.
- User-configurable provider/tool registries.
- Skip/defer answer behavior.
- Advanced policy controls for limiting question count.

## Constraints and Alignment

This brainstorm aligns to existing session and event architecture in:

- `packages/web/src/hooks/use-session-socket.ts`
- `packages/control-plane/src/session/durable-object.ts`
- `packages/control-plane/src/session/message-queue.ts`

## Planning Handoff (API/Event/UI Focus)

The implementation plan should define:

1. Event schema additions for `clarifying_question` and `clarifying_answer`.
2. Session state transitions for `running -> waiting_for_answer -> running`.
3. WebSocket and/or HTTP contracts for submitting answers.
4. Frontend rendering states for pending question cards, validation, submit, and resume states.
5. Slash-command parsing contract and validation surface.
6. Backward compatibility behavior for existing clients that do not understand new events.

## Open Questions

- None for brainstorm scope.
