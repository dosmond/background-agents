---
date: 2026-02-25
topic: modal-browser-proof-recording
---

# Modal Browser Proof Recording

## What We're Building

Add a manual "proof recording" capability for browser-based dev environments so users can request
evidence that the agent tested a feature. When requested, the system captures a short browser
recording (up to 2 minutes) and returns it to the session chat UI as an inline playable artifact.

V1 focuses on clear trust evidence, not full observability. The goal is to let a user quickly verify
that key functionality was exercised, without introducing always-on recording overhead or broad
media platform complexity.

## Why This Approach

We evaluated three directions: manual proof clips, structured test+clip bundles, and rolling-buffer
recording. We selected manual proof clips for V1 because it delivers the core value (credible visual
proof of testing) with the lowest operational and product complexity.

This follows YAGNI: ship the smallest useful trust mechanism first, learn from usage, and only then
decide whether stronger assertions (structured test reports) or broader capture coverage (rolling
buffers) are needed.

## Key Decisions

- **Primary objective:** Recording exists to prove the agent tested functionality, not to archive
  all activity.
- **Capture trigger:** User-controlled manual recording in V1.
- **Recording scope:** Capture starts when explicitly requested; no always-on capture.
- **Duration cap:** 2 minutes maximum per proof clip in V1.
- **Playback surface:** Recording is shown inline in the chat timeline first.
- **Access control:** Only authenticated users with session access can view recordings.
- **Retention policy:** Default retention is 7 days.
- **V1 success criterion:** A user can manually request proof, receive a playable clip inline in
  chat, and use it to confirm the tested flow occurred.

## Resolved Questions

- **What is the main user value?** Proof that the agent actually tested implemented functionality.
- **When should recording run?** Manual only in V1.
- **Where should playback happen first?** Inline in chat timeline.
- **How long can clips be?** About 2 minutes max for V1.
- **Who can view recordings?** Session-authorized users only.
- **How long are recordings kept?** 7 days by default.
- **What defines V1 success?** User-requested proof clip appears inline and is usable as test
  evidence.

## Open Questions

- None at the product-definition level for V1. Technical implementation and operational safeguards
  are deferred to planning.

## Next Steps

-> `/workflows:plan` for implementation details across Modal infra, control-plane artifacts/events,
storage binding strategy, and chat UI rendering behavior.
