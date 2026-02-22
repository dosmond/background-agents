---
date: 2026-02-21
topic: cloudflare-ai-search-context-docs
---

# Cloudflare AI Search for Business Context

## What We're Building

Add an organization-wide contextual document layer so the AI can access business context (meetings,
Slack, Linear) alongside repository code context. In v1, context ingestion is manual upload only.
Retrieval is default-on for prompts, with a per-prompt opt-out.

The goal is to improve answer trust by ensuring responses reflect real team decisions and process
context, not just code and user prompt text.

## Why This Approach

We considered a simpler manual context-pack approach and a phased hybrid rollout. We chose
Cloudflare AI Search as the primary direction because the desired outcome is org-wide
discoverability and trusted grounding across repositories, not just small, manually selected
snippets.

This repo is treated as a second draft of the same core objective explored in Continuity:
high-signal contextual retrieval with provenance for agent workflows. The design keeps scope tight
(manual ingestion in v1) while validating the core value early: better trusted answers informed by
business context.

## Key Decisions

- **Org-wide scope**: Context is shared across repositories to match how business knowledge is
  created and used.
- **Manual ingestion for v1**: Start with uploaded docs to minimize integration complexity and
  validate value quickly.
- **Default-on retrieval with opt-out**: Context search runs by default to maximize impact, while
  preserving user control.
- **Continuity-style interface continuity**: Preserve the same conceptual context surface
  (`search_context`, decision lookup, lineage, context pack) so the product model remains familiar
  while infrastructure evolves.
- **Primary success metric is trust**: Early validation focuses on whether users trust responses
  more when business context is included.

## Open Questions

- None for brainstorming handoff.

## Next Steps

→ `/workflows:plan` for implementation details
