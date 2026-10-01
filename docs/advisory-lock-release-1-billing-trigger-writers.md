# Release 1 billing capture and observation writer trace

This source inventory follows imported table bindings, INSERT/UPDATE callers,
raw SQL builders and the retained operator. R1 migration 1309 retires the six
application capture/observation triggers after explicit current writer/fixture
coverage. Their historical function definitions remain for migration-layer
retirement only; no current producer invokes them. This is not a production
catalog, production operation or data-convergence report.

## Production writers

| Source and owning caller                                                        | Explicit replacement behavior                                                                                                                                                                                                                                            | Remaining boundary                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-run-create.service.ts`: `insertLaunchRunRows`, `persistAtomicLaunchRows` | Both Run insertion branches publish `billingRunAttributionWrite` in the same launch transaction. The timestamp is the value used for the new Run. The conflict predicate compares organization, user, original start and source, and only fills unknown thread identity. | The launch graph still forwards its transaction. That command-ownership work is distinct from the already explicit capture SQL.                                                                                     |
| `built-in-generation.service.ts`: `createImageGenerationJob$`                   | The job INSERT supplies the original `billingRunId` and explicit run/runless context. All five job UPDATE sites change lifecycle, request or result fields; none replaces billing identity.                                                                              | Outgoing creation omits these fields. Late callbacks must continue to use the independent job identity after the live Run FK becomes null.                                                                          |
| `managed-usage.service.ts`: `recordManagedUsage$`                               | Its local transaction retains the live Run, validates or captures canonical attribution, inserts the raw event and marks observation for an inserted event.                                                                                                              | Callers include Maps, web search, scrape, SEO, people search, finance, weather, air quality, Social and Socialkit download. Each passes business values to this command.                                            |
| `credit-usage-settlement.service.ts`: `commitUsageBatch$`                       | Social's combined settlement uses the same capture predicates and `managedUsagePublicationSql`; receipt insertion and the false-to-true observation write share its financial commit.                                                                                    | This is a separate producer from the standalone managed path. Removing a trigger must preserve that combined money/reservation commit.                                                                              |
| `provider-usage-publication.service.ts`: `recordRunnerUsageBatch$`              | The authenticated Runner usage route validates the exact live owner, captures canonical identity, inserts the accepted event categories and marks observation together.                                                                                                  | The caller is `webhooks-agent-health-usage-telemetry.ts`. BYOK model exclusion and existing event idempotency remain.                                                                                               |
| `provider-usage-publication.service.ts`: `recordProviderUsageBatch$`            | OpenRouter and image-result publication resolve authoritative billing identity and atomically insert the finite event categories plus observation. A legacy image without original identity remains unknown.                                                             | Callers are `recordOpenRouterUsage$` and the image-generation result publisher. Retained billing identity must not restore a deleted live content link.                                                             |
| `x-resource-usage.service.ts`: the owning X usage command                       | Source reservations, canonical capture, resource claims, final event quantities and observation share the local transaction.                                                                                                                                             | `resourceUsagePublicationSql` only changes quantity or deletes zero placeholders; it does not rewrite billing identity. Marking a reserved then removed zero event observed preserves the current trigger behavior. |
| `pi-memory-stage1-usage.service.ts`: `recordPiMemoryStage1Usage`                | Every category explicitly sets null live/billing Run IDs, `pi_memory_stage1`, and the same database time for occurrence and allowance anchor. It validates deterministic-key replays.                                                                                    | Its worker caller still passes `Db`; it is not command-owned yet. This is an ownership gap, rather than missing attribution values.                                                                                 |
| `cron-compact-usage-events.service.ts`: `compactUsageEventBatch$`               | At most 500 raw events retain their parents, explicitly resolve legacy/missing identities, publish hourly rows and delete exactly that raw batch. Observed identities are marked in the same transaction. Identity or amount disagreement rolls back.                    | `b8e1c9f` closes the earlier reliance on the hourly capture trigger for legacy/missing raw facts. Historical missing sources remain unresolved rather than receiving invented anchors.                              |
| `packages/db/scripts/billing-attribution.ts`                                    | Its Run phase captures original identity. Job/raw/hourly phases only upgrade unresolved context from matching canonical attribution. Raw/hourly writes explicitly preserve the canonical anchor and publish observation under retained parent/source rows.               | The operator still requires its documented writer-drain acknowledgement and compaction barrier. Do not execute it or delete reader fallbacks based on source coverage.                                              |
| `scripts/benchmark-run-seed.ts`: `insertBenchmarkRunBatch$`                     | The three direct Run seeding sites in `dev-bench-seed.ts` and `chat-threads.bench.ts` now insert Runs and their exact stored timestamp/source/thread attribution together, in batches of at most 500.                                                                    | Other benchmark transaction ownership is outside this capture-specific proof.                                                                                                                                       |

The ordinary settlement UPDATEs change pending/processed state, price/credit
results or errors; they do not rewrite billing identity. The current STT usage
command in `voice-io-post.service.ts` writes behavior counters, not raw billing
usage. The older foundation document's writer list is therefore historical and
must not be used as a current producer inventory without this trace.

## Six application trigger invariants

| Retired trigger (1309) / table                                     | Invariant and explicit replacement                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture_billing_run_attribution` / `agent_runs`                   | Capture independent original Run ID, owner, exact stored start, normalized source/thread at Run insertion; launch/benchmark/converted fixtures publish `billingRunAttributionWrite` in the insertion transaction. Deleting live content must not delete attribution. |
| `capture_generation_billing_identity` / `built_in_generation_jobs` | Preserve original billing Run ID/context independently of live Run FK, including late result after live deletion; the owning job creation supplies these values and lifecycle updates do not replace them.                                                           |
| `capture_usage_billing_attribution` / `usage_event`                | Publish owned Run identity and original allowance anchor, or explicit intentional runless context; unresolved historical facts remain unknown. Managed, Runner/provider, X and Pi producers supply the appropriate values locally.                                   |
| `mark_raw_billing_usage_observed` / `usage_event`                  | Insertion monotonically marks known canonical Run observation in the same raw publication transaction, including reserved then deleted zero rows; publication builders perform the explicit mark.                                                                    |
| `capture_hourly_billing_attribution` / `usage_event_hourly_rollup` | Compaction preserves raw identity/context/exact anchor and rejects amount/identity disagreement before deleting the selected raw batch; explicit compaction SQL owns that commit.                                                                                    |
| `mark_hourly_billing_usage_observed` / `usage_event_hourly_rollup` | Hourly publication monotonically marks known Run observation together with hourly insertion and raw deletion; compaction and the retained operator explicitly publish it.                                                                                            |

The table is the current owning-command SQL replacement contract. Migration
1309 drops all six application hooks in the normal R1 schema, with no replacement
trigger/lock/state and no rolling-writer compatibility. Run/job/raw/hourly source
and observation publish explicitly. Credit issuance and settlement semantics
are unchanged. Only historical migration-layer function-definition retirement
remains for the second release; reader fallback removal still needs its separate
production convergence evidence.

## Retention and mutation transitions

`billing_run_attribution` has no content, user, organization or thread foreign
key. Its independent identity is not deleted by Run/content deletion. Run
foreign keys on raw usage, hourly usage and generation jobs use `SET NULL` only
for the live `run_id`; `billing_run_id`, context and original anchor survive.

The traced production deletion paths are conversation history deletion and
Clerk user/organization lifecycle cleanup. They remove live Runs and their
content, not canonical attribution. Usage cleanup removes raw/hourly ledger
rows but never resets canonical `usage_observed`. No supported production
canonical DELETE remains after retirement of the unused provisional-purge
function. The operator does not delete canonical rows or regress observation.

This does not certify a future erasure coordinator. Any such writer must prove
producer quiescence and the billing obligation closure before purging
provisional attribution. It also does not establish data convergence: retained
legacy thread/allowance reader fallbacks require the scoped inventory results
listed in `docs/database/billing-attribution.md`.

## Existing test-only producer dependencies

The existing `test-usage-state.ts` Run seeder is now an owning command. It
inserts the session, Run and canonical attribution together, selecting the exact
stored timestamp and source/thread fields. Its action dispatcher passes only
business values. Raw/model fixture insertion also owns its command, resolves the
original Run attribution with owner validation, and publishes at most 500 rows
plus monotone usage observation per transaction. A NULL legacy Run link remains
`legacy_unknown`; the fixture does not invent an intentional runless anchor.
Manual hourly materialization now copies the original identity, context and
exact anchor, marks observation, and deletes the selected raw rows together in
locked batches of at most 500. Its loop is outside each transaction. These
existing actions pass only business values and remove their implicit capture
and observation dependency; no new fixture endpoint or sequencing gate was added.

The formerly implicit checked-in state producers below now supply explicit
attribution; their existing public API callers execute against the normal R1
trigger-free schema. They are fixture coverage, not a new production endpoint.

- `routes/test-cron-cleanup-sandboxes-state.ts` is now explicit: Run insertion
  and canonical capture share a short transaction using the exact returned
  database timestamp/source/thread. Raw usage carries original Run identity,
  context and anchor; capture, raw insertion and monotone observation commit
  together. Generation jobs carry original billing Run identity/context. No
  trigger, row lock, replay loop or new fixture API supplies these facts.
  A fresh isolated local database with all six application billing triggers
  removed passed the whole cleanup/cancellation API file (47 tests). This
  closes that fixture's source dependency, not every producer or production
  convergence. The other current fixture conversions are listed below.
- `test-computer-use-state.ts` now captures its Run's canonical identity in
  the insertion transaction using exact stored time/source/thread. Its existing
  Computer Use API file passes 26 tests against the same isolated trigger-free
  schema; authorization and ordinary behavior assertions are unchanged.
- SSH, queue-monitor and Telegram fixture Run insertions now publish canonical
  attribution in the same transaction, using exact stored time/source/thread.
  Existing Runner SSH (43), queue-monitor (9) and Telegram integration (39) API
  tests pass against the isolated six-trigger-free schema; ordinary assertions
  are unchanged. They add no endpoint or sequencing gate.
- `test-fixtures/chat-event-retention.ts` and the canonical interrupt-target
  Run in `chat-events.ts` now insert Run/canonical attribution in one transaction
  using exact returned database time, owner, source and thread identity. Existing
  retention cron, archived consumer and canonical event storage APIs pass all
  14 cases against a freshly migrated current-main database with all six billing
  triggers removed. Thread-bound and threadless setup preserve their own source;
  no new endpoint, fixture field, lock or coordination state is introduced.
- All three Run inserts in `test-pi-memory-stage1-state.ts` now capture in their
  insertion transaction. Existing Pi candidate accounting (including 1002-Run
  bulk setup), phase-2 job/worker and stage-1 schedule fixture inserts do the
  same. The common fixture capture selects exact stored database time, uses the
  production attribution builder and inserts at most 500 canonical rows per
  statement; no no-op conflict UPDATE, trigger or new fixture API is used.
- Stage-1 direct historical raw setup now explicitly supplies its retained
  anchor. DB subtype/anchor CHECK assertions remain. The removed trigger-only
  assertions that arbitrary SQL may not change owner/context are not claimed as
  application protection: current owning publishers validate actor/Run ownership
  and exact replay identity, and product APIs expose no raw identity UPDATE.
  Existing original owner/time/response replay and untrusted-context collision
  cases remain. Historical migration coverage is retained.

These are real source dependencies, not permission to add a test trigger, lock
waiter or artificial database gate. New behavior regression cases must continue
to construct state and assert results through the user's API.

## Release classification

This trace found no additional production raw/hourly/Run/job INSERT producer
outside the paths above. All identified production producers now supply the
capture/observation values explicitly. Db/tx handle propagation in the launch,
Pi and operator paths is a non-goal of this capture retirement. The identified current producer and fixture conversions above now accompany
actual application-trigger retirement, not a drain-only handoff.

Older API versions relied on the installed triggers; that is historical context,
not a requirement to build rolling-version coordination. Under the current R1
scope, current producer/fixture and identity-mutation contracts are explicit,
and migration 1309 retires the six application hooks in R1, not R2 or a
writer-drain-only deliverable. Historical migration-definition retirement
still follows the two-release fallback plan. Production-data convergence before
removing reader fallbacks is a separate evidence gate; no production operator
or erasure action is authorized here.
