# D acceptance map (#34267)

Implementation owner: `lancy`. PR creation and current-HEAD tracked review/CI/queue
receipts are recorded in the linked PR; this document does not assert deployment
or live monitor activation.

| #   | Implemented behavior and code evidence                                                                                                                                                                                                             | Verification / limits                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Existing billing context expands to `pi_memory_stage1` in `usage-event.ts`, `usage-event-hourly-rollup.ts` and migrations 1136/1137. Capture preserves immutable org/user/original anchor and NULL run identities; raw anchor equals created time. | Real PostgreSQL writer/constraint tests reject incompatible inserts and owner/context/kind/run/time mutations. Old checks/capture are replayed in the scale validator before applying actual migrations.                                                                                        |
| 2   | `pi-memory-stage1-usage.service.ts` keeps the four category UUIDv5 keys and quantities. Retained complete legacy `runless` replay is immutable and inserts nothing; collisions fail closed. `billing-attribution.ts` recognizes the subtype.       | Legacy/cross-day/quantity/context cases and real operator audit; existing worker BYOK success/no-output/replay tests remain. No new key retention or second ledger; compaction still removes raw keys.                                                                                          |
| 3   | Existing compactor carries the new context in its physical grain. `v1/ledger.sql` reads raw + hourly with one snapshot and exact numeric arithmetic, original anchor and query-time price basis.                                                   | Infrastructure tests exercise actual compactor, repeat pass, true late raw addition/reconsolidation and concurrent repeatable-read snapshot. Existing compactor coverage protects genuine run/source deletion. Pending, billing errors, unknown prices and unattributed history remain visible. |
| 4   | `core/model-usage-cost.ts` computes the integer rational sum before category ceil/allowance. Cost observer shares canonical exact/alias pricing and writer cache-inclusive tier. USD divides by 1000.                                              | Pure pricing tests cover fractions, zero, missing/fallback/invalid rates and quantities; writer tests cover the tier boundary; real transport exercises an owned canonical alias and repricing. SQL verifies an integer above JS safe range. Historical /1250 assumptions remain unchanged.     |
| 5   | Worker records usage and observes cost before parse/commit handling. Runtime retains usage-bearing incomplete terminal responses. Original receipt identity/time separates first observations, replay and missing usage.                           | Worker suite covers existing output/no-output/commit/cancellation and admission fences; added incomplete-response persistence and logger-failure/no-paid-retry regressions. Logs can be lost and are not an exactly-once transactional journal.                                                 |
| 6   | `v1/definitions.json`, cost/health APL, fixture corpus and offline compiler define production-only, UTC-day >=20, 5-minute evaluation, original-response deduplication and previous-day reconciliation.                                            | Actual SDK NDJSON field mapping plus independent local fixture oracle. Exact integer nano-USD summation covers fractional equality. This is not live APL/parser/service validation.                                                                                                             |
| 7   | Runbook requires actual reviewed notifier IDs, disabled monitor creation, authorized activation and bounded delivery after deployment, before C. Definitions are explicitly unactivated.                                                           | No live monitor, notifier, notification or repeated inventory probe. Existing 403 access gap and unknown destination remain explicit; all-off/no-data is not monitoring health.                                                                                                                 |
| 8   | 1136 expands NOT VALID checks/capture; 1137 validates in a separate transaction. Defaults remain 1s lock / 10s statement; permanent SQL inventory updated.                                                                                         | Full real schema comparison, snapshot chain and function inventory; 134426 raw + 321528 hourly current-schema scale fixture, mixed writers and exact query plan. Production counts came from two separate MaskDB snapshots; production lock contention/tag coverage remain unknown.             |
| 9   | Accepted source admission, frozen UTC slots, quota/credential pins, routing, budgets, watermarks/retries, Phase 2 and Storage code paths retain their contracts.                                                                                   | Targeted worker/runtime/compactor suites and diff/caller review. No feature/breaker changes, prices/allowances, release, probe, production SQL, cron, public UI, broad A2 or next-child work.                                                                                                   |
| 10  | One focused PR with same-owner `/pr-auto` and SHA-bound full tracked review; normal required CI and protected merge queue.                                                                                                                         | The PR's latest review and GitHub terminal state are authoritative. Owner stops after MERGED; controller independently accepts release/operations later.                                                                                                                                        |

## Implemented / adapted / improved

- **Implemented:** durable explicit attribution, one newly priced observation,
  exact daily SQL, versioned disabled cost/health definitions and activation runbook.
- **Adapted:** two migration transactions instead of an unsafe combined
  expansion/validation transaction; migrations regenerated after canonical #34234, #34272 and #34273 merged.
  Existing compaction and pricing resolution are reused without a new ledger.
- **Improved:** usage-bearing terminal failures remain observable; integer
  rational valuation and exact nano-USD aggregation protect the equality budget
  boundary; operator coverage and true late-row snapshot tests close attribution
  gaps. No billing price, rounding, allowance or historical report is changed.

## Remaining boundaries

The 20 USD figure is fractional gross credit value, not a provider invoice or
net credits. Logs and their bounded deduplication window do not prove complete
billing coverage. Sub-nano fractions or out-of-int64 observations remain priced
for display/SQL but report incomplete exact APL coverage. Current canonical token
unit sizes are representable; aggregate range is an activation check.

Live APL semantics, missing-group recovery/delivery details, actual destination,
monitor activation, production labels/scale/locks, enabled-user runtime billing
and seven days below budget are unverified. These files leave PiMemory off for
everyone and the background breaker false. No production operation is delegated.
