# Release 1 billing capture and observation writer trace

This source review uses the integrated R1 changes through `b8e1c9f` and main
`3103651`, which retires both Cloudflare guards. It follows imported table
bindings, their INSERT/UPDATE callers, raw SQL builders and the retained
operator. It is not a production catalog or data-convergence report. The six
capture/observation triggers remain installed; no retirement is authorized by
this inventory alone.

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

The following checked-in state producers still obtain attribution implicitly
from the current schema. They are not evidence of a missing production entry
point, but need explicit fixture values or migration to ordinary API setup
before tests can run against a trigger-free schema.

- `routes/test-cron-cleanup-sandboxes-state.ts` is now explicit: Run insertion
  and canonical capture share a short transaction using the exact returned
  database timestamp/source/thread. Raw usage carries original Run identity,
  context and anchor; capture, raw insertion and monotone observation commit
  together. Generation jobs carry original billing Run identity/context. No
  trigger, row lock, replay loop or new fixture API supplies these facts.
  A fresh isolated local database with all six application billing triggers
  removed passed the whole cleanup/cancellation API file (47 tests). This
  closes that fixture's source dependency, not every producer or production
  convergence. Other fixture dependencies below remain unfinished.
- `test-computer-use-state.ts` now captures its Run's canonical identity in
  the insertion transaction using exact stored time/source/thread. Its existing
  Computer Use API file passes 26 tests against the same isolated trigger-free
  schema; authorization and ordinary behavior assertions are unchanged.
- Other direct Run setup remains in `test-pi-memory-stage1-state.ts`,
  `test-cron-monitor-chat-event-queue-state.ts`,
  `test-ssh-connection-state.ts`, `test-telegram-state.ts`, and the
  `test-fixtures/chat-event-retention.ts` / `chat-events.ts` seeders. Several
  service-local Pi fixtures also insert Runs directly. Their caller-specific
  billing expectations have not all been migrated by this inventory.
- `services/__tests__/pi-memory-stage1-usage.service.test.ts` contains direct
  raw INSERTs without anchors and identity mutation assertions. Historical
  database migration scripts separately construct historical schemas and
  rows. Do not delete historical migration coverage or present it as current
  application API coverage; assess each test's actual purpose when retiring
  current-schema dependencies.

These are real source dependencies, not permission to add a test trigger, lock
waiter or artificial database gate. New behavior regression cases must continue
to construct state and assert results through the user's API.

## Release classification

This trace found no additional production raw/hourly/Run/job INSERT producer
outside the paths above. All identified production producers now supply the
capture/observation values explicitly; transaction ownership remains unfinished
in the identified launch, Pi and operator paths. The test-only producer audit
and conversions above are unfinished work, rather than a deployment condition.

The outgoing API still relies on the six installed triggers: old Run and job
INSERTs omit canonical/original identities, old raw producers omit resolved
anchors and observation, and old compaction depends on hourly capture. Current
R1 SQL alone does not make those old writes safe without the triggers. R2
retirement requires no such API serving or in-flight writer, a compatible
rollback target, and verified R1 producer/fixture coverage. Production-data
convergence for removing reader fallbacks is a separate gate. The two-release
plan is unchanged.
