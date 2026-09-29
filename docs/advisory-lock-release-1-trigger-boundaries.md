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
approval to retain these objects in the terminal schema.

## Existing billing attribution triggers

| Table and trigger                                                                                                  | Current business guarantee                                                                                           | Replacement work                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `agent_runs.capture_billing_run_attribution`                                                                       | Captures the original organization, user, run start, source and thread identity.                                     | Both Run insertion paths must explicitly publish attribution atomically with the Run.                              |
| `billing_run_attribution.billing_run_attribution_immutable`                                                        | Rejects changed attribution, regressing `usage_observed`, or replacement of an established thread identity.          | Every mutation must use the same identity predicates and monotone observed transition.                             |
| `usage_event.capture_usage_billing_attribution` and `usage_event_hourly_rollup.capture_hourly_billing_attribution` | Resolves run identity, context and original allowance anchor, including Pi Stage 1, and rejects inconsistent owners. | Raw and rollup writers must explicitly resolve and validate these ordinary business values in their owning commit. |
| `built_in_generation_jobs.capture_generation_billing_identity`                                                     | Establishes immutable run/runless generation attribution.                                                            | Generation job creation and updates must publish the same identity explicitly.                                     |
| `usage_event.mark_raw_billing_usage_observed` and `usage_event_hourly_rollup.mark_hourly_billing_usage_observed`   | Marks attribution as having observed usage, protecting its retention.                                                | Raw insertion and compaction must include the monotone attribution update in their atomic writes.                  |

These seven triggers are **unfinished replacement protocols**, not only an
outgoing-version drain condition. For example, `managedValues` in
`managed-usage-record.ts` still supplies `missing_run` for an existing Run and
relies on the trigger to complete the context and anchor. Generation insertion
in `built-in-generation.service.ts` supplies `runId` without the complete billing
identity. Both Run creation paths in `agent-run-create.service.ts` still depend
on trigger-side attribution publication. Existing attribution readers and the
retained convergence fallbacks do not replace these writes.

Their creation is historical migration 1119; migrations 1141 and 1193 contain
later function definitions. Preserve those migrations. Once all R1 writers
explicitly maintain the guarantees, use serving, in-flight and rollback evidence
to retire current trigger/function definitions in a new migration. A source
scan or the age of the old migrations cannot establish that gate.

## Existing SSH and Cloudflare triggers

| Table and trigger                                                | Current business guarantee                                                                                                                | Replacement work                                                                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ssh_connections.ssh_cloudflare_access_binding_guard`            | A shared config read rejects a personal Cloudflare config owned by another user. The separate foreign key protects organization identity. | All attachment/replacement writers must preserve the config owner/scope predicate under the common row order.   |
| `cloudflare_access_configs.cloudflare_access_scope_change_guard` | Rejects incompatible scope/owner changes while hosts still reference the config.                                                          | Promotion, demotion and owner changes must validate or detach incompatible host bindings in the owning command. |

Migration 1203 creates both; 1222 updates scope-change behavior. SSH attachment
already takes the visible config's shared row ownership and checks the owner.
Cloudflare promotion/demotion owns the config and then its referencing hosts,
detaching other owners when required. This is partial preparation, not a full
all-writer proof: `cloudflare-access.service.ts` still has helper-owned
transactions and propagated handles. Finish that graph and its supported
writers before classifying either trigger as outgoing-only compatibility.

## Forms compatibility triggers

Migration 1290 adds `google_forms_cursor_rebind_preserves_progress` on
`google_forms_automation_cursors` and `google_forms_cursor_source_lifecycle` on
`workflow_automations`. Neither is an accepted permanent design. The
[credential/watch inventory](./advisory-lock-release-1-credentials.md) records
the evolving explicit command implementation and outstanding writers.

The concrete mixed-version risk is an outgoing repair that reads the newest
remote response and unconditionally upserts that timestamp after R1 preserved
the earlier cursor. An outgoing explicit disable/source change has the opposite
requirement: end the old consumption interval. Removing the triggers while
those writers remain supported would reopen the gap created by the changed
cursor/watch foreign key. Do not simply drop migration 1290 while keeping the
same lock-free preparation order.

R1 must first express repair/rebind, initial/reopened baseline, explicit disable
and source replacement in its own SQL. The transition must then retain only the
FK/lifecycle/provider boundary actually needed by the inspected outgoing code.
If the temporary triggers remain in R1, their R2 removal gate includes every
supported writer implementing that distinction, no pre-R1 serving/in-flight
requests, and a compatible rollback target. Remove both triggers and their
trigger functions in that transition; no business write may depend on them in
the terminal schema.

## Verification and readiness

Existing API tests must continue to verify attribution amounts/anchors,
cross-owner SSH access rejection, Forms repair catch-up, duplicate notification
deduplication and explicit disable/restart behavior. No lock waiter, temporary
test trigger or artificial database gate is a substitute. The migration schema
inventory must change alongside the eventual retirement migration.

The active trigger inventory is a new explicit acceptance gap. No item above is
an exemption, and no trigger can be called drain-only until its replacement
writers are actually implemented and verified.
