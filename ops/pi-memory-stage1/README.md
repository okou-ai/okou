# Stage 1 cost attribution and budget guardrail

Issue [#34267](https://github.com/vm0-ai/vm0/issues/34267), child D of
[#33892](https://github.com/vm0-ai/vm0/issues/33892). **Definitions only, not an
active alert.** PiMemory remains off for everyone, including staff, and
`PI_MEMORY_BACKGROUND_WORKERS_ENABLED=false`. This change authorizes no release,
production SQL, purge, override, probe, monitor mutation or notification.

## Accounting and source contract

The existing immutable `billing_context` gains `pi_memory_stage1`. The actual
capture trigger and raw/hourly checks require model usage, NULL live/billing run
identity and an original event-time anchor. Raw anchors equal `created_at`.
Org/user, context and anchor cannot be replaced. This is a specific runless
operation; the foreground source run is never its billing run. Ordinary
`runless`, `run`, `missing_run` and `legacy_unknown` remain separate. The existing
compactor carries the context/anchor in its complete physical grain; no second
source discriminator or ledger is introduced.

Matching retained old `runless` idempotency rows remain untouched and add no
charge. Identity, owner, context, category, quantity or partial-category
collisions fail closed. The writer does not infer historical attribution from a
NULL run, model name, hash or allowance-adjusted zero credits. Known-context
operator inventory recognizes the new context. Phase 2 keeps its real run and
exact private callback credential association. A generic `agent` source or Terra
model is not durable proof of Phase 2; this is not the #33745 A2 reader cutover.

**Retention is unchanged.** UUIDv5 keys deduplicate while raw rows remain in the
existing ledger. The hourly relation does not retain response keys; the normal
four-day compaction boundary is not a permanent idempotency promise. Stage 1's
accepted frozen-day/limited-hourly-retry fences still govern work. Neither this
query nor a late manual replay restores a compacted key. There is no replay API,
historical backfill or new retention obligation in D.

## Observation contract

`pi-memory-stage1-worker.service.ts` records canonical usage before pricing and
before output parsing/commit. A usage-bearing incomplete terminal provider
response also reaches that boundary. Parse/no-output, later cancellation, stale
commit or deletion cannot erase already consumed usage. No-provider admission
skips produce no extraction event. Attempted requests without usable response
usage emit `missing_usage`: vendor cost is unknown. SDK error sentinels with zero
usage are not invented billable responses.

The model remains Luna / low / standard. Four quantities use the writer's
cache-inclusive 272,001-token long-context threshold. Pricing uses the same
`resolveUsagePricingProvider` exact/alias mapping as credit settlement and exact
category rows; `__fallback__` alone is unavailable. The estimate is:

`sum(quantity * unit_price / unit_size) / 1000`

It is **fractional gross credit-value USD**, before each category's billing ceil
and all allowances/packs/cash deductions. It is not an invoice, vendor cash cost
or net credits. Valid zero rates remain zero. Invalid/missing/fallback-only
prices and invalid usage never become fabricated zero cost. Historical EPIC
reports using `/1250` retain their original investigation assumption; D neither
rewrites those reports nor changes prices, billing rounding or allowance policy.
BYOK returns before any model-row write and has no company-cost summand; its
external spend remains unknown.

The valuation computes the rational sum using integers. `grossCreditValueUsd`
is its numeric display estimate. `grossCreditValueNanoUsd` is the **exact**
integer nanodollar representation, serialized as text and summed with APL
`tolong` before conversion to USD. This prevents 100 values of 0.2 from landing
below 20 through floating-point accumulation. No category or money rounding is
introduced. Current canonical token unit sizes (1,000,000) are representable.
A valid rate with a sub-nanodollar fraction or value outside signed int64 keeps
its display valuation but has a NULL integer representation: the health query
reports incomplete budget coverage, rather than rounding it into the budget.
The independent SQL reconciliation retains exact `numeric` arithmetic for such
rates. Activation must verify current price basis and bounded aggregate range.

### Identity, time and replay

The opaque response `accountingId` derives from the existing storage/session/
history/response logical inputs without category or outcome. Provider response
ID absence uses the existing per-request UUID identity. Logs contain none of
those plaintext source inputs, prompts, memories, credentials or account data.
`accountingAt` comes from the retained ledger's original timestamp (UTC display
at millisecond precision); it never moves to replay/processing time.

Only a completely new write attempts an observation-time price lookup. A replay
emits the same original identity/time with NULL cost and `replay` or
`legacy_replay`; it never rereads prices. Zero usage and BYOK have no persisted
billing anchor and no priced summand. First-observation loss remains a coverage
gap, not permission to reprice the response.

The query selects the first original observation by observed UTC timestamp,
then deterministic lexical price-status/basis/value tie breaks, **before**
accounting-day filtering. It ignores delivery/category/outcome duplicates.
Inconsistent identity or repriced duplicates trigger health; later larger
values do not replace the first estimate. Tied inconsistent observations are
ambiguous and unhealthy even though the tie break is reproducible. The bounded
window is not global everlasting deduplication.

Pricing gets a separate transaction with a one-second statement timeout after
usage persistence. All pricing and synchronous log exceptions are owned by a
best-effort boundary, including cancellation exceptions. They cannot suppress
usage or create another paid retry. Logs can still be lost in transport, process
crash or between DB commit and emission; no transactional cost journal exists.

## Exact logger and APL field mapping

`turbo/apps/api/src/lib/log.ts` constructs `AxiomJSTransport` for
`vm0-web-logs-${AXIOM_DATASET_SUFFIX}` at INFO. The logger-owned transport suite
intercepts actual SDK NDJSON over controlled MSW HTTP, including the `prod`
suffix; no live request or credential is used. It verifies:

| Transport field                                                                                     | Meaning                                                                 |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `_time`                                                                                             | SDK observation timestamp, not a billing day                            |
| `source`, `level`                                                                                   | Root `api`, `info`                                                      |
| `fields.context`                                                                                    | `PiMemoryStage1Cost`                                                    |
| `fields.operation`, `fields.costVersion`                                                            | Explicit `pi_memory_stage1`, version 1                                  |
| `fields.accountingId`, `fields.accountingAt`, `fields.observedAt`                                   | Opaque response, original anchor, observation time                      |
| `fields.billingMode`, `fields.model`                                                                | Actual builtin/BYOK mode and model                                      |
| `fields.inputTokens`, `fields.outputTokens`, `fields.cacheReadTokens`, `fields.cacheCreationTokens` | Four quantities; invalid quantities are NULL                            |
| `fields.ledgerStatus`, `fields.usageStatus`, `fields.pricingStatus`                                 | Finite persistence/replay, usage and pricing coverage                   |
| `fields.grossCreditValueUsd`, `fields.grossCreditValueNanoUsd`                                      | Fractional display value and exact APL integer value                    |
| `fields.currency`, `fields.unit`, `fields.creditsPerUsd`                                            | USD, gross_credit_value, 1000                                           |
| `fields.pricingProvider`, `fields.priceBasis`                                                       | Resolved lookup and captured category/rate/unit/update-time JSON string |

APL uses bracketed dotted fields, e.g. `['fields.accountingId']`. Production-only
queries select `vm0-web-logs-prod` and explicit source/context/operation; cost
excludes BYOK, staging and dev. No logger root-field promotion is required.

## Versioned monitor artifacts

[v1/definitions.json](v1/definitions.json), [cost.apl](v1/cost.apl) and
[health.apl](v1/health.apl) are offline, disabled definitions. Cost is a threshold
monitor with `AboveOrEqual`, threshold 20, five-minute interval, three-day
bounded ingestion range and `columnName=grossCreditValueUsd`. The final
aggregation groups by a **string UTC accounting day**, not a time bin.

- Every evaluation independently calculates today's `[00:00, next 00:00)`
  group. Equality breaches a budget whose goal is `< $20/day`.
- The same monitor retains yesterday's group until the end of today. This
  catches delayed logs for up to one day after their accounting day's end and
  preserves that group's identity across midnight. It never adds yesterday's
  amount to today's total. Delays outside this window require the bounded SQL
  reconciliation; they cannot be certified from the alert.
- `notifyByGroup=true`, `notifyEveryRun=false`, `resolvable=false` request one
  opening notification on entry to each day's continuous incident. The platform
  documents notifications on entry and exit, and at most one trigger
  notification per evaluation. A grouped incident staying over threshold should
  not repeat every five minutes. No permanent exactly-once guarantee is claimed
  across monitor edits, restarts, delivery retries or manual operations.
- UTC rollover starts a fresh accounting-day group. A previous group dropping
  out of the query window is a reporting-window reset, not a refund or evidence
  that the historical breach recovered. Verify missing-group recovery behavior
  and simultaneous current/prior-day breaches during activation; public docs do
  not fully specify those delivery details. Preserve the incident receipt.
- Health fires at `>=1` for unknown/invalid pricing/usage, malformed observations,
  unsupported exact integer conversion, inconsistent identities/repricing, and
  replays with no original. Multiple health signals can describe one response;
  `healthProblemCount` is not an extraction count or an amount of money.
- `alertOnNoData=false` is deliberate while everyone is off. Zero/no events do
  **not** prove working ingestion, pricing, billing or monitor delivery.

E1's daily decision/claim state and `staleDiscarded` are the relevant worker
coverage signals. Existing daily decision and batch/claim logs are DEBUG and
are dropped by the INFO Axiom transport; candidate outcomes are INFO but do not
prove a daily claim denominator or ingestion completeness. `sourceActive` and
`sourceExpired` are zero-valued response remnants, not freshness indicators.
Consequently no absence-based heartbeat/coverage guarantee is implemented.
Use authorized DB reconciliation and controller deployment/admission evidence;
do not infer an enabled-user success or seven days below budget from all-off.

### Validation evidence and limits

- `node --test ops/pi-memory-stage1/v1/fixtures.test.mjs` tests the independent
  local fixture oracle: below/equal/above, fractional equality, duplicates,
  first-price/replay, unknown/malformed, BYOK, nonproduction, day boundaries and
  delayed observations. Fixture amounts are controlled threshold inputs, not
  production Luna prices. This does **not execute an APL parser**.
- Logger tests exercise the actual installed SDK transport. Worker route tests
  verify usage persistence on provider/output failures and no new provider call
  after a cost-log failure. Real PostgreSQL tests cover immutable identity,
  historical replay and single-snapshot compaction/reconsolidation.
- Official monitor [semantics](https://axiom.co/docs/monitor-data/threshold-monitors)
  and [create schema](https://axiom.co/docs/restapi/endpoints/createMonitor) were
  read on 2026-09-15. They support the configured fields; this is documentation
  evidence, **not live APL, monitor API or delivery validation**.
- Existing access gap remains: monitors GET 403 despite `monitors|read` allowed;
  notifiers GET 403 and `notifiers|read` denied. No repeated discovery, invented
  notifier, live monitor write or notification occurred. Live parser/query
  validation and actual destination are **unverified**.

## Bounded ledger reconciliation

[v1/ledger.sql](v1/ledger.sql) is a parameterized, read-only single-statement
contract. Its raw + hourly `UNION ALL` uses one DB snapshot; compaction's atomic
replacement/deletion prevents double counting. Real late raw rows add to the
existing hour. Never fetch the two tables in separate snapshots or apply a
client-side rollup-wins rule.

Run only against a separately authorized database:

```sh
cd turbo
pnpm -F @okouai/db billing:pi-memory-stage1 --day 2026-09-15
# Optional exact scope:
pnpm -F @okouai/db billing:pi-memory-stage1 --day 2026-09-15 --org-id ORG --user-id USER
```

The CLI enforces one valid UTC date, read-only repeatable-read, UTC timezone,
1s lock and 5s statement limits. There is no pagination loop. `$4` in the SQL is
the canonical provider-to-lookup alias map; production CLI uses `{}`, matching
the production resolver's identity mapping. Tests may supply exact owned aliases.

`known_stage1_gross_usd` is a **known subtotal**, not a complete cost when
`stage1_unknown_price_rows>0`. Groups preserve exact numeric strings, captured
query-time unit price/size/update time, pending/finalized rows and billing errors.
`untagged_runless_rows_in_day` is unattributable legacy coverage, not inferred
Stage 1 spend. Unanchored model rows cannot be assigned to a day and are reported
as a separately named all-history physical-row count in the exact scope; their
valuation must not be interpreted as part of the selected day. This bounded
statement can scan history for that count and can time out as scale grows.

The price basis is `usage_pricing_at_query_snapshot`. Later price changes can
change this valuation; it is never asserted equal to an earlier log's captured
estimate. Billing errors remain visible even if current pricing is repaired.
All-org sums do not require a net credit deduction: allowance-covered gross
usage is still usage.

## Migration, scale and rollback

The 2026-09-15 05:17:59.234547–05:18:01.438157 UTC production census was
**134,426 raw / 321,528 hourly rows**, from two read-only MaskDB aggregate
statements, not a common snapshot. Attribution columns were not exposed by that
masked schema, so live source coverage is unknown.

1. `1133_pi_memory_stage1_billing_context` replaces only the two context checks
   with expanded `NOT VALID` checks and updates capture in one short transaction.
   Existing rows are not rewritten or relabeled. New writes are checked at once.
2. Commit releases the `ACCESS EXCLUSIVE` locks before
   `1134_validate_pi_memory_stage1_billing_context` scans the existing rows in a
   **different transaction**. It uses `SHARE UPDATE EXCLUSIVE`; no same-transaction
   lock downgrade is claimed. There is no explicit `LOCK TABLE` or timeout raise.
3. Retain runner defaults (1s lock, 10s statement). If expansion times out, its
   whole transaction rolls back. If validation times out, expansion remains
   journaled and enforced but unvalidated; promotion stays blocked. Retry normal
   migration execution after diagnosing the contention, without widening limits
   or skipping journal entries. No manual production retry is authorized here.
4. Migrations precede new API traffic. Old writers keep working after expansion;
   new writers require completed migrations. Rolling API code back is compatible
   with existing subtype rows and the attribution-aware compactor from #33915.
   Retain the expanded schema/capture and new operator classification. An old
   operator may misreport subtype coverage; do not use it for backfill/audit.
   Reverting schema/capture after subtype data exists is unsafe. No cleanup or
   later schema contraction is implied.

The real current-schema scale test replays the actual pre-D capture/checks,
seeds the recorded volumes, executes both new migration files under default
limits, inspects lock modes and commits old/new writes while validation locks
remain held. It values an integer beyond JavaScript's safe range with PostgreSQL
`numeric`, preserves pending/missing-price/billing-error coverage, and records a
representative all-org plan in [scale-evidence.json](v1/scale-evidence.json).
The recorded sample: expansion 15ms, validation 62ms, query 71.821ms; sequential
scans are expected because the existing indexes do not lead with the billing
anchor. No index is added on an unmeasured production workload. Volume is
representative; distribution, hardware, cache and contention are synthetic.

#34234 and #34263 competed for migration numbering during inventory. They are
not ordering blockers. Preserve the first merged canonical main migrations and
regenerate this branch's metadata through Drizzle if a conflict occurs.

## Controller activation and rollback gate — after deployment, before C

This owner stops at protected merge. The controller separately:

1. Confirms batch inclusion, deployed migration journal/schema, retained
   attribution-aware compactor, all-off switches and false breaker.
2. Resolves only the required access and an actual reviewed destination. Reads
   back the real notifier; verifies intended channel/recipients. No IDs or
   secrets are supplied by this repository.
3. Runs both exact APL files through the live parser/query service with a bounded
   range. Verifies dot-field types, integer conversion, `arg_min` string order,
   `let`/`union`, grouped summaries and current/prior-day behavior. Runs the
   controlled corpus in an explicitly authorized test destination if needed;
   local fixtures alone do not pass this gate.
4. Compiles disabled request bodies offline:
   `node ops/pi-memory-stage1/v1/build-definitions.mjs ACTUAL_REVIEWED_NOTIFIER_ID`.
   Reviews exact output, binds actual IDs and creates disabled monitors under
   separate authorization. The script performs no network call or activation.
5. Separately enables the reviewed definitions and performs bounded delivery
   checks: below/equal/above, duplicate replay, sustained breach with no repeated
   opening, group rollover, prior-day delayed breach, unknown-price health,
   no-data and documented recovery/reset behavior. Record monitor/notifier IDs,
   definition revision, query receipts and opening/recovery delivery receipts.
   Platform delivery retries or missing-group behavior that violate the intended
   incident policy must be resolved before C; do not claim an unsupported SLA.
6. On query/destination/coverage failure, disable those exact monitors through
   authorized operations, retain receipts and investigate. Do not reset billing,
   reprice old logs, purge C, change feature switches or trigger paid probes.

No notification, active-alert, destination, complete live coverage, production
provider billing or seven-day cost claim follows from merging these files.
