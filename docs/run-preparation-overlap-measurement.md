# Run preparation overlap measurement

These nested API dispatch operations establish an unchanged-schedule baseline for
[#32558](https://github.com/vm0-ai/vm0/issues/32558). They do not change run
preparation order or demonstrate a startup-latency improvement.

## Boundaries

| Operation                                                          | Complete boundary                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `api_dispatch_prepare_context_select_connector_catalog`            | Runtime catalog selection, including empty and preloaded results                  |
| `api_dispatch_prepare_context_resolve_thread_connector_selections` | Thread connector account selection and validation, including the no-thread return |

Catalog selection, thread selection and the existing
`api_dispatch_prepare_context_resolve_model_provider` operation still start in
one all-settled wave. Connector-context loading still starts after all three
results pass their existing checks.

Both measurements include no-op paths; their presence does not imply a database
query or a nonempty connector scope.

The existing collector records at most two additional observations per reached
runtime wave. They use its existing batched flush, with no new queries, network
requests or identifying dimensions.
There is a small timer and record-allocation cost; this instrumentation is not
itself a performance optimization.

## Cohort and correlation rules

1. Fix the observation window and record whether ingestion time was also fixed.
   Query bounded raw operation groups, checking result limits and late arrivals.
2. Join API operations and successful `api_to_spawn` records by `run_id`. Require
   one record per operation needed for the candidate and consistent API identity.
   Exclude missing, repeated or conflicting records; do not multiply joins or
   substitute zero for a missing measurement.
3. Stratify by exact `api_commit_sha`, the spawn's `runner_version` and
   `runner_startup_path`, `agent_run_origin`, `trigger_source`,
   `api_process_dispatch_ordinal_bucket` and `run_preparation_retry_count`.
   Do not pool different revisions or origins to satisfy a sample gate.
4. Exclude ambiguous preparation retries. The collector can accumulate repeated
   operations under the eventual run ID and attach final-flush retry metadata.
   That field does not uniquely label each recorded attempt. Neither array order
   nor summing repeated operations establishes a valid candidate pair.
5. API operation `_time` is its completion timestamp, not ingestion time or
   start time. `duration_ms` uses a monotonic clock, while `_time` has millisecond
   wall-clock precision. Reject contradictory timelines and disclose clock and
   rounding uncertainty; sub-millisecond finish-time differences are not precise
   overlap evidence.
6. Collector records use the existing `success: true` convention, including
   measurements recorded in `finally`. This is not an individual operation
   outcome or a fleet-wide failure denominator. Successful-spawn cohorts cannot
   establish startup failure rates.

## Candidate-specific ideal ceilings

Calculate each ceiling per run before computing percentiles. These calculations
assume unchanged operation costs without additional resource contention; they
are not measured improvements.

### Connector-context loading

Let `catalog_end` and `thread_end` be the two prerequisite completion timestamps,
`provider_end` the existing model-provider completion timestamp, and
`context_duration` the existing
`api_dispatch_prepare_context_load_connector_contexts` duration, all in
milliseconds.

```text
inputs_ready = max(catalog_end, thread_end)
provider_remaining = max(0, provider_end - inputs_ready)
ideal_overlap = min(context_duration, provider_remaining)
```

Do not use the entire provider duration as the proposed saving: catalog or thread
selection can finish later. Nested catalog substeps cannot replace the complete
prerequisite wrapper, especially for preloaded catalogs or catalog work performed
inside thread account selection. Provider-dependent framework, secret,
permission and usage materialization remain outside this overlap.

### Subscription capture and thread observation (#35497)

The unchanged-schedule implementation baseline is exact main
`f2146eeacd252a357fc62ccf5c80b2fe0b715590`. Record the exact candidate PR head
with every comparison; never pool a rebased head with an older sample.

For a personal subscription thread run, compare these existing complete spans:

- `api_dispatch_pre_create_agent_capture_subscription_account`;
- `api_dispatch_pre_create_agent_resolve_thread_session` plus
  `api_dispatch_pre_create_agent_web_chat_resolve_session_prompt_context` when
  present;
- the containing `api_dispatch_pre_create_agent_run` and successful
  `api_to_spawn` interval.

The candidate starts only the first read-only thread observation alongside
capture. Post-authorization remains gated on successful capture, while it may
continue alongside a slower thread branch. Capture remains once per request;
only thread observation repeats after a stale snapshot. Deterministic latch
tests that show both branches in flight prove dependency receipt and ownership,
not elapsed-time improvement.

No query statement is added and successful-path counts must match the baseline.
A failed capture may now retain the already-started, bounded read-only thread
session/prompt queries. Report those failure-path reads separately; they must
not include post-authorization, writes, proof, admission, queue publication or
spawn. Compare database acquisition and queueing as well as query counts so
overlap is not mistaken for a benefit obtained by increasing pool pressure.

Run baseline and candidate samples sequentially with identical fixtures and
concurrency. Report every per-run observation, exclusion, failure,
cancellation, retry and measurement error before computing distributions.
Local route observations do not establish deployed `api_to_spawn`, tail, pool
or failure behavior. Production follow-up must use exact serving API and Runner
identities and same-run intervals. If the controlled comparison cannot show a
repeatable critical-path benefit without worse tail, pool, failure or retry
behavior, remove the scheduling change and record a no-change result.

### Retired paused-Goal candidate

The paused-Goal lookup and its measurement were removed during Goal retirement.
Following [S5 acceptance on 2026-09-10](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5623079780),
this candidate no longer requires samples or an overlap decision. Do not treat
its absent operation as a missing connector measurement. The connector-context
candidate and its evidence requirements remain applicable.

## Decision gate

Report complete sample counts, exclusions and candidate-specific distributions.
Do not sum independent timing percentiles, represent these ceilings as observed
savings, or infer that every run benefits from the connector candidate.

Before retaining any scheduling change, compare it with the unchanged schedule
under representative concurrent API-entry runs. Report preparation latency,
p95/p99, query count, database pool-acquisition pressure, failures and measurement
noise. Preserve authorization, error/abort priority, fresh session retries,
materialized output and durable launch behavior. If a candidate lacks a justified
benefit, record its no-change decision instead of adding concurrency complexity.

The attribution PR alone does not close #32558: deployment and the
evidence-backed connector-context decision remain required.
