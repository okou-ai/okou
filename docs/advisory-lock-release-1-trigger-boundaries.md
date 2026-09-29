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
approval to retain these objects in the terminal schema. Migration
`1290_retire_cloudflare_scope_change_trigger` removes one redundant trigger
and its function. With the two unshipped Forms triggers withdrawn, eight
application triggers remained before the independent canonical mutation-guard
retirement below. Migration `1291_retire_billing_attribution_mutation_guard`
removes that redundant trigger and function; seven application triggers remain
in the proposed R1 schema.

## Existing billing attribution triggers

| Table and trigger                                                                                                  | Current business guarantee                                                                                           | Replacement work                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `agent_runs.capture_billing_run_attribution`                                                                       | Captures the original organization, user, run start, source and thread identity.                                     | Both Run insertion paths now publish attribution atomically with the Run; their broader launch transaction ownership is unfinished.  |
| `billing_run_attribution.billing_run_attribution_immutable`                                                        | Rejects changed attribution, regressing `usage_observed`, or replacement of an established thread identity.          | Removed by migration 1291: every supported mutation already preserves these identities and monotone observation; see evidence below. |
| `usage_event.capture_usage_billing_attribution` and `usage_event_hourly_rollup.capture_hourly_billing_attribution` | Resolves run identity, context and original allowance anchor, including Pi Stage 1, and rejects inconsistent owners. | Raw and rollup writers must explicitly resolve and validate these ordinary business values in their owning commit.                   |
| `built_in_generation_jobs.capture_generation_billing_identity`                                                     | Establishes immutable run/runless generation attribution.                                                            | Generation creation now supplies its identity explicitly; outgoing and operator writers still require a complete retirement audit.   |
| `usage_event.mark_raw_billing_usage_observed` and `usage_event_hourly_rollup.mark_hourly_billing_usage_observed`   | Marks attribution as having observed usage, protecting its retention.                                                | Raw insertion and compaction must include the monotone attribution update in their atomic writes.                                    |

Retirement of the six remaining billing triggers still requires **unfinished replacement
protocols**, not only outgoing-version drain. The complete caller/retention
audit remains open. Existing
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

- `compactUsageEventBatch$` retains at most 500 raw events and their canonical
  attribution rows in a stable parent-first order. It validates organization,
  user and original allowance anchor before committing each immutable hourly
  fragment. The same command transaction explicitly marks only this batch's
  Run identities observed; a failed identity or amount reconciliation rolls
  back both insertion and deletion. This explicit path covers already resolved
  `run` rows. It does not yet replace trigger-assisted legacy identity resolution:
  `candidateCtes` retains and validates attribution only for `billing_context =
'run'`, while `billingGrainColumns` and `mutationCtes` copy other contexts and
  their anchors unchanged. The current hourly capture trigger can still resolve
  `legacy_unknown` with a surviving Run or `missing_run` with later canonical
  attribution. R1 must explicitly resolve those cases within the bounded batch,
  or establish an exclusion invariant for eligible data and supported writers.
  No such data/retention evidence has been obtained; outgoing API drain alone
  is insufficient. This is a source-level conditional dependency, not a claim
  that affected production rows were observed. Existing API coverage preserves
  totals across compaction, late usage and a repeated compaction run.
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

## Remaining fixture and legacy-resolution evidence

A limited writer trace at `903d90e` also identified direct Run INSERTs in
`dev-bench-seed.ts:insertProfileRows` and both bulk Run insertion sites in
`chat-threads.bench.ts`. Those benchmark/dev fixtures currently obtain canonical
attribution from the Run INSERT trigger. Before retirement, make their intended
billing state explicit or demonstrate that their datasets do not require that
identity. They are not proof of a serving API compatibility requirement.

The traced production Run, generation, raw usage and operator writers supply
identity and observation explicitly; their remaining command-ownership chains
are separate obligations. This review did not certify every fixture alias,
producer adapter, retention/deletion transition or production-data convergence.
The compaction legacy-resolution case above remains specific R1 implementation
work; the broad trigger audit is not declared complete.

## Canonical mutation guard: independent retirement evidence

Migration `1291_retire_billing_attribution_mutation_guard` removes
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

## Existing SSH and Cloudflare triggers

| Table and trigger                                                | Current business guarantee                                                                                                                | Replacement work                                                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ssh_connections.ssh_cloudflare_access_binding_guard`            | A shared config read rejects a personal Cloudflare config owned by another user. The separate foreign key protects organization identity. | R1 writers implement the predicate; retirement still needs the historical writer gate below.                        |
| `cloudflare_access_configs.cloudflare_access_scope_change_guard` | Rejects incompatible scope/owner changes while hosts still reference the config.                                                          | All conversion writers already implement this invariant. Migration 1290 retires it while the binding guard remains. |

Migration 1203 creates both; 1222 updates scope-change behavior. The source audit
at `29f6115` distinguishes these two boundaries rather than assuming they share
a release gate. R1 SSH create/update commands directly read the visible config
`FOR SHARE`; Cloudflare mutation commands now own their finite transactions and
SQL. The R1 ownership refactor does not itself prove every historical writer is
safe without the binding trigger.

### Binding guard: concrete historical dependency

The foundation commit
[`076b125`](https://github.com/okou-ai/okou/blob/076b125ca6e884f9355279ca6f7c4c7f2dba7c61/turbo/apps/api/src/signals/services/ssh-connection.service.ts#L213)
(#36274, which introduced migration 1203) validates a selected configuration
through `findCloudflareAccessConfig` without row ownership. The shared config
read was added in
[`018ed551`](https://github.com/okou-ai/okou/blob/018ed55169aac0d1321ef50107817237eebb6e11/turbo/apps/api/src/signals/services/cloudflare-access.service.ts#L110)
(#36396). The inspected outgoing main `0921863` keeps that read for creation and
replacement, including an unchanged binding during host edits.

Without the trigger, a foundation API request can read a configuration personal
to A, then pause before inserting its SSH binding. Newer API requests can
promote A's configuration to organization scope and demote it to personal B.
The old request's later insert still uses A's earlier validation. The same-org
foreign key permits this cross-owner reference; the binding trigger currently
takes `FOR SHARE`, rereads the owner, and rejects it. This is a static
interleaving, not a reported runtime reproduction.

The [existing activation rules](deployment-compatibility.md#organization-cloudflare-access-foundation-36260)
exclude rollback to pre-foundation API/Runner versions once shared state is
written. They do not establish that the foundation API itself is excluded.
Before dropping the binding trigger and `validate_ssh_cloudflare_access_binding`,
verify that every serving API, in-flight request, and retained rollback target
includes the `018ed551` binding protocol or an equivalent fix. No production
deployment or drain evidence was obtained by this source audit. If that evidence
is established before R1, this trigger needs no additional preparation release;
otherwise the existing two-release gate applies. R1/R2 writers themselves share
the explicit owner/scope check under config row ownership.

### Scope-change guard: independent retirement evidence

Demotion's first implementation
[`5d1ba8b`](https://github.com/okou-ai/okou/blob/5d1ba8b930cd414c3e3700996e25d79ba99a4ce6/turbo/apps/api/src/signals/services/cloudflare-access.service.ts#L559)
(#36623) locks the organization config `FOR UPDATE`, locks its referencing
hosts, detaches every other owner's binding into `needs_rebind`, then changes
the config to personal ownership by the acting admin. Promotion's first
implementation
[`aa20d6a`](https://github.com/okou-ai/okou/blob/aa20d6a8609326008f5da853bd9db75d0ad1d204/turbo/apps/api/src/signals/services/cloudflare-access.service.ts#L616)
(#36715) locks the acting admin's same-org personal config and only changes it
to organization scope with a null user owner. Neither moves an organization or
transfers a personal config directly to another user.

The subsequent modifying versions `b3119bb`, `c639e33`, and `3ca3ea0`, outgoing
main `0921863`, and R1 `29f6115` preserve this order and these predicates.
Earlier API versions do not perform scope or owner conversion. The remaining
current writer inventory is:

- Standalone and inline SSH config creation insert the declared organization
  scope or the actor's personal ownership; ordinary edits change only name,
  encrypted credentials, revision, generation, and modification time.
- Clerk organization/user cleanup deletes SSH references before deleting
  configs. It never transfers config ownership.
- SSH credential rotation, host-key pinning/reset, and chat-default writes do
  not change config scope or the SSH binding owner. Host ownership is not
  editable through these writers.
- The retained `013-kms-account-rotation` operator lists only
  `encrypted_client_id` and `encrypted_client_secret` for this table; it does
  not write `scope`, `org_id`, or `user_id`.

While the binding trigger remains, an older late attachment still takes its
trigger-side shared config lock and rechecks ownership after a conversion.
Thus removing only `cloudflare_access_scope_change_guard` and
`reject_cloudflare_access_scope_change` does not require the foundation API to
disappear first. Preserve the same-org foreign key and scope/owner check
constraint. Migration `1290_retire_cloudflare_scope_change_trigger` retires this redundant
trigger/function and updates the expected schema inventory. Its metadata was
generated with Drizzle; migrations 1203/1222 stay unchanged.
The historical `test-cloudflare-access.ts` migration test applies selected old
migrations in an isolated schema; its old-schema assertions are not production
writers or evidence for retaining the final trigger.

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
Drizzle generated the remaining purge, Cloudflare scope-change and canonical
attribution mutation-guard retirements as 1289, 1290 and 1291 respectively,
without a Forms schema change or added table/column.

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

The seven remaining application triggers are explicit acceptance obligations.
Billing replacements remain unfinished; the SSH binding trigger has the
specific historical dependency above. Forms introduces no trigger. No trigger
is a permanent exemption.
