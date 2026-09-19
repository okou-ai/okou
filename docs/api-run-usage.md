# API-owned run usage

API-first Pi inference does not traverse the Runner MITM addon, so its token evidence has a separate API-owned source. The source is observational: it never changes billing, execution ownership, sandbox demand, output publication, or retry behavior.

New Run admissions create one `agent_run_api_usage` row in the same transaction as `agent_runs`. The row starts as either authoritative `no-inference` or `pending`; missing rows therefore identify old writers and are never interpreted as zero. Provider ownership registers a stable attempt UUID before transport. Normal, failed, late, and recovered evidence for that UUID converges into one cumulative replacement projection.

The projection retains at most eight attempt identities and 32 KiB. Identities are never evicted, because forgetting a deduplication key could count it again. Conflicts, missing categories, lost evidence, in-flight work, and overflow make coverage incomplete without discarding still-valid quantities. First-terminal evidence loss is sticky, while a later missing historical replay cannot downgrade evidence already recorded. Repeating identical evidence does not advance the revision.

Official Runners read the source with `POST /api/runners/runs/:runId/api-usage`. The request contains the Runner UUID and heartbeat generation. The API requires official Runner authentication and an exact current `running` claim; it does not consult SSH grants. Missing, stale, unbound, and old-writer cases all return the same `unavailable` result. Every response uses `Cache-Control: no-store`.

This endpoint is one source for later Runner aggregation. It does not combine MITM observations or expose a CLI command.
