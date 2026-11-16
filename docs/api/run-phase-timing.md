# Run phase timing

Run phase marks observe elapsed time until server-side Run completion. They do not measure the sum of tool execution time or the exact moment the client paints the result.

## Collection

```sh
okou run mark research-start
okou run mark generation-start --kind presentation
# Only when the task actually has no research phase:
okou run mark generation-start --kind image --skip-research
```

Both commands are optional, quiet by default, capability-gated, and make one request with a 500 ms deadline. Do not retry marks or use `--skip-research` to repair a missing research mark. A timeout leaves delivery unknown.

`POST /api/runs/current/phase-mark` accepts only the authenticated Run and the strict phase/kind/skip fields. The existing artifact timing feature switch controls admission and prompt instructions. The API derives Run, user, organization and receive time, then schedules one direct, five-second-bounded Axiom ingestion attempt. HTTP 202 / receipt schema version 2 means accepted, not indexed or durable.

Observations use `type=run_phase_mark`, event schema version 1, in the existing `vm0-web-logs-{suffix}` dataset. There is no phase-state lookup, online deduplication, timing-table write, or arbitrary caller payload. Deployments using native telemetry still send these observations directly to Axiom because the collector reads that dataset.

## Daily collector

`GET /api/cron/aggregate-run-phase-timings` requires the existing cron bearer secret. Vercel schedules it at 17:00 UTC (01:00 Asia/Shanghai). Each invocation reads a fixed three-day raw window and rebuilds the previous two completed Beijing dates within a 45-second work deadline.

The collector uses a complete count query and a raw query over the same source window. Partial results, a count of 10,000 or more, mismatched row counts, provider errors and malformed stored partitions fail the invocation; they never publish a fabricated zero result. Increasing volume beyond this explicit bound requires a reviewed bounded collection strategy, not silent truncation.

Only well-formed phase-marked Run IDs drive batched reads of existing lifecycle metadata. Run/user/organization identities must match. Run start and terminal completion clocks bound admissible observations. Completion day determines the sole daily partition, including Runs that cross midnight. No new timing table, MaskDB allowance or database writes are required.

Private daily JSON is stored in `R2_USER_STORAGES_BUCKET_NAME` at:

```text
telemetry/run-phase-timings/v1/YYYY-MM-DD.json
```

Daily JSON contains only aggregate distributions and quality counts, not Run/user/organization IDs or task content. Creates use `If-None-Match: *`; replacements use the ETag read with the object. Conditional conflicts fail without application-level retry. Older or lower-source-coverage rebuilds preserve the stronger object. Additional complete evidence may invalidate an earlier sample and must be allowed to correct it.

A missing date is a collection gap, not zero. Raw data outside the retention window cannot be reconstructed from this pipeline. Do not backfill missing partitions with zeros. The job does not change Axiom retention or bucket lifecycle policies; the dataset must retain at least three days and the telemetry prefix must remain private and exempt from short-lived-object expiration.

## Statistical contract

Every daily partition includes groups by generation kind and terminal status (`completed`, `failed`, `cancelled`, `timeout`). Use only `completed` groups for successful-Run latency trends; unsuccessful counts and durations remain separate. The population is **phase-marked Runs**, not all artifact-producing Runs. Global instrumentation coverage is unknown; within-group metric coverage is `metric.count / group.runs` when the denominator is nonzero.

| Metric           | Boundaries                                                                              |
| ---------------- | --------------------------------------------------------------------------------------- |
| `prepare`        | Run start → research start; for explicit skipped research, Run start → generation start |
| `research`       | Research start → generation start; explicit unambiguous skip contributes an exact zero  |
| `makingDelivery` | Generation start → Run completion, including checks, repair and publication             |
| `total`          | Run start → Run completion; does not add queue time before execution start              |

The earliest lifecycle-valid observation wins for each phase. Later duplicate/conflicting declarations remain quality counts. Tied earliest competing kinds are `unknown`; tied skip conflicts or a prior research mark contradicting a skip declaration invalidate the affected segmentation. Missing marks are not skipped research and do not become zero durations. When Run start predates the raw window, retained duplicates cannot prove the earliest phase; phase-dependent samples are excluded, while lifecycle-only total duration remains usable.

Each metric stores sample count, sum/min/max, P50/P90, missing/invalid counts, exact-zero count and sparse positive histogram bins. Empty sample counts are zero; empty statistics are null. Positive bins have a 1,000 ms width and represent `((key-1)*widthMs, key*widthMs]`; quantiles use nearest-rank upper bounds, so positive percentiles are approximate to the bin width.

For weekly/monthly trends, merge compatible histogram bin counts and exact zeros, then recompute the quantile from the combined sample count. Never average daily P50/P90. Only completion-day counts/groups are additive across daily partitions; `source` diagnostics describe overlapping three-day scans and must not be summed as daily populations. Preserve missing dates and coverage denominators in every chart.
