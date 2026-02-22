---
date: 2026-02-21
topic: mcp-support-for-model-sessions
---

# MCP Support for Model Sessions

## What We're Building

Add repository-scoped MCP server support so model runs in a session can use MCP tools during
prompting. MCP servers are configured per repository, then applied automatically to sessions created
for that repo.

For v1, the target scope is full production readiness: configuration management, validation and
health checks, UI management surface, diagnostics, and clear error visibility. Credentials for MCP
servers are sourced through the existing repository secrets system rather than ad-hoc environment
passthrough.

## Why This Approach

We considered three options: control-plane managed config injection, repo file-driven config, and a
hybrid model. The selected approach is control-plane managed configuration with sandbox injection
because it best matches existing patterns in this codebase for repository metadata, secret
management, and session lifecycle orchestration.

This keeps governance and security centralized while still delivering per-repo behavior. It also
avoids introducing a new config-as-code format in v1, reducing migration and support complexity.

## Key Decisions

- Per-repo MCP configuration: MCP server definitions are managed at repository scope, not
  global-only and not per-session-only.
- Runtime target: MCP support is for tool availability during session model runs.
- Security model: MCP credentials use existing repo secrets infrastructure.
- Chosen baseline: control-plane managed MCP config + sandbox injection.
- v1 ambition: include configuration UX, validation/health checks, diagnostics, and explicit error
  surfacing.

## Resolved Questions

- What is the primary goal? Enable MCP tools during inference/session model runs.
- Where is MCP configured? Per repository.
- How are MCP credentials handled? Via existing repo secrets.
- What is v1 scope? Full production-ready path (management + validation + diagnostics).
- Which design path should we use? Approach A (control-plane managed configuration).

## Open Questions

- None currently.

## Next Steps

→ `/workflows:plan` for implementation details, architecture slices, and rollout/testing plan.
