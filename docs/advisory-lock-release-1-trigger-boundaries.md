# Release 1 database trigger retirement boundaries

The terminal contract added in `4fa8844` forbids every application-defined
database trigger. This inventory is implementation work for the same two-release
plan. It does not authorize another release or relax the no-new-fields rule.

At `4fa8844`, replaying the migration journal's trigger creation, removal and
table deletion agrees with `EXPECTED_PERMANENT_TRIGGERS` in
`turbo/packages/db/scripts/test-migration-consistency-schema.ts`: **11 active
application triggers**, backed by nine distinct trigger functions. PostgreSQL's
internal constraint triggers are excluded. This is checked-in schema evidence,
not a live production catalog query. The test constant's historical name is not
approval to retain these objects in the terminal schema. Main `3103651`
contains migration `1290_retire_cloudflare_access_triggers`, removing both
Cloudflare guards and their functions with independently documented serving and
rollback evidence. This PR preserves that migration unchanged and withdraws its
redundant unshipped scope-only retirement. With both unshipped Forms triggers
withdrawn and migration `1292_retire_billing_attribution_mutation_guard` removing
the redundant canonical guard, **six billing application triggers remain** in the
proposed R1 schema. No production migration completion is inferred from main.

## Existing billing attribution triggers

| Table and trigger                                                                                                  | Current business guarantee                                                                                           | Replacement work                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `agent_runs.capture_billing_run_attribution`                                                                       | Captures the original organization, user, run start, source and thread identity.                                     | Both Run insertion paths now publish attribution atomically with the Run; their broader launch transaction ownership is unfinished.  |
| `billing_run_attribution.billing_run_attribution_immutable`                                                        | Rejects changed attribution, regressing `usage_observed`, or replacement of an established thread identity.          | Removed by migration 1292: every supported mutation already preserves these identities and monotone observation; see evidence below. |
| `usage_event.capture_usage_billing_attribution` and `usage_event_hourly_rollup.capture_hourly_billing_attribution` | Resolves run identity, context and original allowance anchor, including Pi Stage 1, and rejects inconsistent owners. | Raw and rollup writers must explicitly resolve and validate these ordinary business values in their owning commit.                   |
| `built_in_generation_jobs.capture_generation_billing_identity`                                                     | Establishes immutable run/runless generation attribution.                                                            | Generation creation now supplies its identity explicitly; outgoing and operator writers still require a complete retirement audit.   |
| `usage_event.mark_raw_billing_usage_observed` and `usage_event_hourly_rollup.mark_hourly_billing_usage_observed`   | Marks attribution as having observed usage, protecting its retention.                                                | Raw insertion and compaction must include the monotone attribution update in their atomic writes.                                    |

Retirement of the six remaining billing triggers still requires **unfinished replacement
protocols**, not only outgoing-version drain. The [current producer and retention trace](./advisory-lock-release-1-billing-trigger-writers.md)
now identifies all observed production writers and the remaining fixture
dependencies. Command ownership and those fixture conversions remain open. Existing
attribution readers and the retained convergence fallbacks do not replace
these writes.

The following producer changes are implemented:

- `createImageGenerationJob$` supplies both `billing_run_id` and its explicit
  `run`/`runless` context in the existing single job INSERT. Status, provider
  callback and result updates leave these fields unchanged. A later Run FK
  `SET NULL` does not erase the original independent billing identity.
- `recordManagedUsage$` owns Run parent retention, canonical attribution lookup,
  any missing live-Run capture, raw event insertion and monotone
  `usage_observed` publication in one short SQL transaction. Only pure query and
  value builders are reused. An existing attribution remains authoritative
  even after the live Run is deleted; it must match the billed organization and
  user. A supplied Run without either source stays `missing_run`, with no
  fabricated allowance anchor. An explicitly runless event uses its own
  database occurrence time. The original Run timestamp travels as PostgreSQL
  text so sub-millisecond precision survives. Capturing a previously missing
  row validates original organization/user/start/source and only fills unknown
  thread grouping, preserving captured identity and observed history. A
  duplicate event does not add a second usage receipt or charge.
- Social's `commitUsageBatch$` now directly performs the same canonical capture
  before wallet ownership. A bounded SQL publication inserts the receipt and
  sets observed only for an inserted event with `run` context. Job claim, usage,
  credit and allowance settlement, and reservation release remain in the same
  transaction. Replayed idempotency keys do not insert or observe another event.
  Builders receive ordinary values only; no transaction or database handle is
  passed out of the command. The existing Social API settlement tests remain.
- OpenRouter and image-result usage use `recordProviderUsageBatch$`. One provider
  response's finite categories, canonical ownership/anchor validation and
  monotone observation commit in a command-local SQL transaction. Pricing,
  provider and archive work stay outside it. A retained image billing identity
  does not restore a deleted live Run link; a legacy job without an original
  identity remains `legacy_unknown`. Existing idempotency keys arbitrate replay.
- Both Run insertion paths directly insert the canonical attribution in the
  same launch transaction, using the exact timestamp supplied to the Run INSERT.
  Conditional conflict handling rejects changed owner/start/source and preserves
  captured thread identity and observed history. These writes prepare the
  trigger replacement, but the surrounding launch helpers still receive `tx`;
  command ownership of that caller graph remains unfinished.
- Ordinary Runner usage and mixed X resource batches explicitly retain the live
  owner, validate/capture canonical billing identity, insert their bounded event
  set and mark observation in their owning command. BYOK model exclusion remains.
  X source reservations, ordered resource claims, final quantities and replay
  checks commit together; database clock samples after possible waits preserve
  the existing date-admission window. Pure builders replace all transaction-aware
  X ingestion helpers. X retention cleanup also owns its database and bounded
  deletion. Existing Runner usage and X API tests cover the business contract.

- `compactUsageEventBatch$` retains at most 500 raw events and their live Run and
  canonical attribution parents in a stable order. Every context now participates
  in explicit resolution: `legacy_unknown` with a surviving Run captures its
  canonical identity; `missing_run` uses a later canonical attribution when one
  exists. Capture preserves exact PostgreSQL timestamps, owner, source and known
  thread grouping. Existing attribution remains authoritative. A missing live
  and canonical source stays unresolved without inventing an allowance anchor.
  A busy live parent is skipped, and the candidate identity is rechecked when
  retaining each event. Conflicting owner/anchor or amount reconciliation rolls
  back the complete batch. The same local transaction publishes only this batch's
  observed Run identities. Hourly publication no longer needs its trigger to
  repair a copied legacy identity. Existing API coverage preserves totals across
  compaction, deleted Runs, late usage and repeated/concurrent compaction. The
  historical legacy-row branch is justified by the shipped capture semantics;
  no artificial database state or trigger test was added to manufacture it.
- The retained `billing-attribution` operator now retains canonical attribution
  before its bounded source rows, sets the original allowance anchor explicitly,
  and marks matching raw/hourly identities observed in the same commit. Conflicting
  existing anchors are reported, never replaced. This prepares the operator's
  billing writes without executing it or certifying production convergence; its
  existing outgoing-compactor barrier and writer-drain acknowledgement remain.
- Pi Stage 1 explicitly supplies its runless billing identity and database
  occurrence/allowance timestamp. This removes its implicit anchor initialization,
  but does not complete ownership of its worker and provider caller graph.

The standalone managed path commits before financial settlement as before;
Social keeps its combined financial commit. Only the redundant canonical mutation guard is removed; capture and observation triggers remain. Existing public API
coverage for managed Run billing display, runless allowance consumption and
image webhook completion remains; behavioral verification belongs to the
integrated PR pipeline.

The effective function definitions are migration 1119 for generation identity
and observed publication, 1141 for usage context and anchor, 1193 for canonical
identity and thread capture, and 1226 for the source classifier, including
Discord. The standalone managed writer follows the canonical owner and anchor
when that row already exists, independently of a missing or differently owned
live Run; only a matching live owner retains the content FK. Without canonical
attribution, a differently owned live Run cannot establish a new billed
identity. These are separate checks, not a fallback to the live Run's billing
owner. Preserve the historical migrations. Once all R1 writers
explicitly maintain the guarantees, use serving, in-flight and rollback evidence
to retire current trigger/function definitions in a new migration. A source
scan or the age of the old migrations cannot establish that gate.

## Fixture writers and remaining audit evidence

The three direct Run INSERT sites in `dev-bench-seed.ts:insertProfileRows` and
`chat-threads.bench.ts` now invoke `insertBenchmarkRunBatch$` with business rows.
The command acquires `writeDb$` itself and inserts at most 500 Runs plus their
explicit provisional canonical identities in one local transaction. Capture
selects the stored timestamp directly, validates owner/start/source on conflict,
and only fills unknown thread grouping. These benchmarks no longer need the
Run INSERT trigger to establish billing identity. Other benchmark setup is not
claimed to have completed the production transaction-ownership sweep.

Production Run, generation, raw usage, compaction and operator writers supply
identity and observation explicitly in the traced paths. Their remaining
command-ownership chains are separate obligations. This review has not certified
every fixture alias, producer adapter, retention/deletion transition or
production-data convergence. The broad trigger audit is not declared complete,
and reader fallback removal still needs its own data evidence.

## Canonical mutation guard: independent retirement evidence

Migration `1292_retire_billing_attribution_mutation_guard` removes
`billing_run_attribution_immutable` and `reject_billing_attribution_update`.
It does not remove any capture, observation or attribution reader fallback.

The outgoing API at main `13a2692` does not issue direct canonical attribution
INSERT/UPDATE statements. Its trigger-driven writers use these historical SQL
functions, whose current definitions remain installed:

- `ensure_billing_run_attribution` (1119, replaced by 1193) only updates the same
  Run ID on conflict after exact organization, user, original start and source
  comparison. A mismatch raises instead of replacing captured identity.
- `ensure_billing_run_thread` and the thread fill in `ensure_billing_run_attribution`
  (1193) update only `thread_context = 'unknown'`. Neither rewrites a known thread
  or its original captured time.
- `mark_billing_usage_observed` (1119) only changes false to true.
- The retained `billing-attribution` operator's Run phase already compares the
  same immutable owner/start/source values and only fills unknown thread identity.
  Its R1 raw/hourly phase adds explicit false-to-true observation.

R1's two Run inserts and canonical usage producers use
`billingRunAttributionWrite`, which preserves known thread identity and rejects
an owner/start/source conflict. Their usage publications, Social, X and compaction
only set observation true. No API business input can assign `captured_at`, regress
observation, change canonical ownership, or replace an established thread.
Deletion remains deletion, not an identity transfer. A repository-wide writer
trace found no additional production mutation of this table; historical
migrations remain unchanged.

These predicates are already shared with outgoing writers, so this guard does
not need a new preparation release or an API drain. The six capture/observation
triggers still cover outgoing writers and require their own complete replacement
audit and release gate. Existing user API tests continue to protect amounts,
retained grouping, cross-owner rejection and compaction; the permanent schema
inventory verifies that the retired guard/function are absent.

## SSH and Cloudflare trigger retirement integrated from main

Main `3103651` retires `ssh_cloudflare_access_binding_guard` and
`cloudflare_access_scope_change_guard` in published-history migration 1290.
The source and observed serving/rollback evidence are recorded in
[deployment compatibility](./deployment-compatibility.md#cloudflare-access-trigger-retirement-37355-37369).
That newer evidence supersedes this inventory's earlier foundation-writer
uncertainty. The serving aliases and rollback floor must still be rechecked
before release; this PR does not establish actual production journal completion.

Supported SSH writers read the owned/same-org config `FOR SHARE`; conversion
writers retain the config `FOR UPDATE`. Demotion detaches other-owner hosts
before changing scope. Promotion now additionally rejects an incompatible
retained other-owner binding. The integration preserves that defensive predicate
inside `convertCloudflareAccessToOrganization$`, without reintroducing main's
ordinary database-taking helper. Same-org FK and ownership/rebind checks remain.
No replacement trigger, stored coordination state or new release is added.

The main-only service test constructed an otherwise unreachable corrupt binding
in a private database schema and compared SQL rows. This PR omits that fixture
and its two lint exemptions to follow the authorized user-API test boundary.
Existing Cloudflare API cases still assert inaccessible personal references,
retained hosts requiring explicit rebind, conversion and stale-revision behavior.
Those public cases are not claimed to construct the same corrupt SQL state; the
new defensive predicate remains implemented and reviewable. Historical migration
catalog tests remain historical schema checks, not application behavior fixtures.

## Forms trigger proposal withdrawn

The accepted Forms behavior now permits missed triggers during watch failure or
repair. Newest-response repair is allowed, so outgoing unconditional cursor
reseeding is no longer grounds for adding progress-preserving triggers.

The unshipped `1289_google_forms_cursor_detachment` and
`1290_google_forms_cursor_lifecycle` are withdrawn together with their generated
metadata and the two trigger/function inventory entries. The original non-null
`ON DELETE CASCADE` cursor/watch relationship remains unchanged. Main `c26098d`
and the observed production deployment tree `c501c3b7` exclude these PR-only
migrations; #37313 is still open and unmerged. Existing published migration history, including main 1288, is untouched.
Main migrations 1289 and 1290 are preserved. Drizzle generated the two remaining
PR-only purge and canonical mutation-guard retirements as 1291 and 1292, without
a Forms schema change or added table/column.

Application SQL still checks active authority, selected source and normal
uniqueness. Late provider preparation cannot revive a disabled or revoked
source. The dedicated detachment, retained-seed recovery, synthetic catch-up and
second activation lock are removed. Remaining command-boundary migration is
implementation work, but there is no Forms trigger retirement gate to defer to R2.

## Verification and readiness

Existing API tests must continue to verify attribution amounts/anchors,
cross-owner SSH access rejection, Forms recovery for later notifications, duplicate notification
deduplication and explicit disable/restart behavior. No lock waiter, temporary
test trigger or artificial database gate is a substitute. The migration schema
inventory must change alongside the eventual retirement migration.

The six remaining billing application triggers are explicit acceptance
obligations. Their replacement writer/retention audit remains unfinished.
Cloudflare retirement follows main's documented gate; Forms introduces no trigger.
No trigger is a permanent exemption.
