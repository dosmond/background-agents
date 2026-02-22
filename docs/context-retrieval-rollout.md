# Context Retrieval Rollout Checklist

## Feature Flag

- `CONTEXT_RETRIEVAL_ENABLED=false` keeps prompt flow unchanged.
- Set `CONTEXT_RETRIEVAL_ENABLED=true` to enable context augmentation in the message queue.
- Per-prompt opt-out is available via `includeContext: false` on prompt requests.

## Required Configuration

- `CLOUDFLARE_AI_SEARCH_AUTORAG_NAME`
- `CLOUDFLARE_AI_SEARCH_API_TOKEN`
- Existing `CF_ACCOUNT_ID`

If Cloudflare AI Search is not configured or fails, the queue falls back to local document retrieval
and then to prompt-only behavior.

## Trust-Focused Acceptance Checks

1. **Citation Presence**
   - Save a context document in Settings → Data Controls → Context Documents.
   - Run context search and verify each result includes excerpted citation text.

2. **Relevance**
   - Send a business-context prompt with `includeContext=true`.
   - Confirm response behavior references uploaded context (via emitted prompt enrichment logs).

3. **Opt-out Behavior**
   - Send the same prompt with `includeContext=false`.
   - Confirm no context block is appended during queue dispatch.

4. **Graceful Degradation**
   - Disable Cloudflare AI Search token and send prompt with context enabled.
   - Confirm processing continues without request failure and uses fallback retrieval path.
