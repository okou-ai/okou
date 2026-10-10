# Model identity finalization operators

Operator tools only. Nothing here runs as part of a release migration. Execute only
after explicit operator authorization, Release 1 serves all new writes, outgoing
writers have drained, and rollback will not expose an API that reinterprets
normalized historical selections. Refs #38114. No rollout switch is used.

## Relational pages

From `turbo/packages/db`, with `DATABASE_URL` set securely:

```sh
pnpm exec tsx scripts/migrations/021-model-identity-finalization/backfill.ts --mode verify --before "$RELEASE1_SERVING_UTC"
pnpm exec tsx scripts/migrations/021-model-identity-finalization/backfill.ts --mode runs --before "$BACKFILL_CUTOFF_UTC" --limit 100
pnpm exec tsx scripts/migrations/021-model-identity-finalization/backfill.ts --mode events --before "$BACKFILL_CUTOFF_UTC" --limit 100
```

For manual SQL execution, render a page without connecting to any database:

```sh
pnpm exec tsx scripts/migrations/021-model-identity-finalization/backfill.ts --mode runs --before "$BACKFILL_CUTOFF_UTC" --limit 100 --print-sql > reviewed-preview.sql
# Separately authorize the reviewed write page; rendering itself performs no writes.
pnpm exec tsx scripts/migrations/021-model-identity-finalization/backfill.ts --mode runs --before "$BACKFILL_CUTOFF_UTC" --limit 100 --migrate --print-sql > reviewed-apply.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f reviewed-apply.sql
```

Use the same pattern for `events`, adding `--after` from the previous report. The
printed SQL uses session-local PREPARE/EXECUTE/DEALLOCATE, not a transaction wrapper
or persisted database switch. Do not execute the printed write page without
operator authorization. Preview SQL works in a read-only session.

Fix one UTC cutoff for the entire pass. Inspect each dry-run classification, then
repeat the exact command with `--migrate` only after authorization. Each invocation
commits one bounded statement independently. Save the returned `next_cursor` and
pass it as `--after <UUID>` for the next page. Empty `scanned` ends that pass.
Replay from the beginning after concurrent producers drain: the predicates make
already-normalized rows ineligible. Do not mistake an empty final page for zero
blocked rows on earlier pages. Preserve the aggregate reports outside Git.

`runs.sql` and `events.sql` are executable parameterized PostgreSQL statements:
cutoff, nullable UUID cursor, page size, apply boolean. The CLI executes a SELECT-only
projection for previews; a read-only role is sufficient. There is no encompassing
transaction, all-table rewrite, explicit row lock, or persistent progress row.
Statements have a bounded session-local deadline. On a timeout, inspect contention
and reduce the reviewed page size; do not wrap pages in a larger transaction or
blindly retry/raise timeouts.
Predicates compare the original captured values before accepting an update.

Run normalization captures an independent immutable usage identity and category
boundary **before** replacing a legacy selected projection. It never rewrites
usage records, categories, native transcripts, execution contexts, or exports.
Legacy Auto preserves the pre-normalization execution rule. Replacement aliases
require an original retained usage identity. A cancelled legacy Pi execution may
also recover its producer's selected-alias usage identity when its complete
managed runtime is `openrouter-codex` and the retained preset exactly matches the
selected alias. The producer's `modelUsageProviderForContext` contract reported
that selected alias; it did not substitute the upstream preset. This recovery
never manufactures a usage observation or consults today's catalog. Completed
executions, mismatched presets and conflicting observations remain blocked.
Partial runtime captures and missing selected values are classified, not filled.

Personal runtime recovery requires retained compiled Runner environment, an exact
member/account binding, permanent account identity, and no conflicting Pi runtime
pin. Only then can existing NULL runtime columns be filled. A personal managed key
remains NULL. Missing queue evidence is **not** permission to copy selected into
runtime or consult today's catalog/account default. Claimed queues are deleted;
those histories require separately reviewed native/export evidence or an explicit
irrecoverable/lifecycle exception. This operator does not assert that absent queue
evidence proves irrecoverability, and does not guess a selection for SQL NULL Runs.

## Snapshot inventory and publication

Set the R2 environment names used by the existing `020` tool securely. From the
same directory:

```sh
pnpm exec tsx scripts/migrations/021-model-identity-finalization/snapshots.ts --kind threads --limit 100
pnpm exec tsx scripts/migrations/021-model-identity-finalization/snapshots.ts --kind events --limit 100
```

Inspect reports and separately authorize writes; repeat each page with `--migrate`.
Save `nextCursor` and supply `--after '<cursor>'`. The thread cursor is a JSON pair;
the event cursor is a UUID. Finish every page, then perform a complete read-only
pass from the beginning. Canonical heads report zero `changedRows`; conflict,
unresolved ownership, unsupported version, missing head, or integrity errors are
not convergence. A process error stops the page; rerun its original cursor rather
than skipping uncertain work. Failed CAS publishes nothing and retains both
immutable objects; replay reads the authoritative current head. No automatic retry
or deletion occurs.

The owner-scoped `020` tool remains available for targeted reconciliation. V8,
physical and terminal cursors, hashes, framing and unrelated payloads are retained.
SQL decision capture is separate: V8 event rows do not contain `model_selection`.
Current-head normalization does not retire old object references: inventory native
history, exports, cached copies and installed/captured CLI readers independently.
Never delete originals or remove historical readers based only on current heads.
The existing event snapshot collector protects current heads and
`user_export_entries.source_key`; after a CAS, an unreferenced old head can become
collector-eligible. Before authorizing publication, reconcile those export sources
and every known cached/native/direct-object reference against its owning lifetime.
Do not treat the tool's no-delete behavior as protection against an independent
collector. Unaccounted live references block publication and reader retirement;
this operator neither disables collection nor introduces a retention switch.

## Verification and Release 2 gates

Repeat `--mode verify --before "$RELEASE1_SERVING_UTC"`. Canonical catalog/route
counts must be present, replacement relationship mismatches zero, new successful
personal runtime gaps zero, and relational legacy decisions/annotations zero after
approved pages. Reconcile raw and compacted usage identities independently; a lack
of compacted rows is not a passed compaction check. Record classified historical
NULL/partial captures and their accepted lifecycle or evidence dispositions.

Before Release 2: prove outgoing API writers and rollback targets are excluded;
verify permanent personal/built-in execution/account binding; complete authorized
relational pages; reconcile the complete V8 inventory and retained object/consumer
references; confirm native execution support and unchanged usage interpretation.
Release 2 installs the checks in `1367_enforce_canonical_model_capture` and
validates them in `1368_validate_canonical_model_capture`. They are separate
migration transactions in the same release: ADD CHECK NOT VALID takes brief
ACCESS EXCLUSIVE locks; VALIDATE takes SHARE UPDATE EXCLUSIVE locks and permits
ordinary reads/writes. Both retain the runner's normal bounded timeouts. There
is no history rewrite or explicit table lock in either file.

Run the executable read-only preflight **before** release, using an explicitly
read-only connection/session:

```sh
pnpm exec tsx scripts/migrations/021-model-identity-finalization/backfill.ts --mode preflight --before "$RELEASE1_SERVING_UTC"
# Render the exact same SELECT without connecting:
pnpm exec tsx scripts/migrations/021-model-identity-finalization/backfill.ts --mode preflight --before "$RELEASE1_SERVING_UTC" --print-sql
```

Preflight uses the ten actual migration predicates, covers all rows (the cutoff
is only a report label), and exits 2 for any violation. All ten counts must be
zero. A zero report is not writer/rollback drain or snapshot/consumer acceptance.
`verify` additionally inventories runtime pairs by lifecycle and independent raw
and compacted usage coverage. Save full-page classifications outside Git.

The lifecycle exception is structural, not a rollout marker: uncaptured runtime
must be a pair of SQL NULLs; pending/running personal Runs with a launch snapshot
must have runtime, selected personal identity and permanent account binding.
Historical completed/failed/cancelled personal records may retain an uncaptured
pair; absence of evidence is **not** proof of irrecoverability. Pending records
without an executable launch may also be uncaptured. Complete captures keep their
provider/account ownership on every later update. This intentionally does not
pretend that a completed snapshot distinguishes old and new captures, nor that a
CHECK can enforce OLD/NEW immutability. Current launch writers own capture; the
ordinary metadata patch type excludes execution/usage/account fields. Arbitrary
SQL writes remain an operator responsibility.

Terminal managed history with no runtime, key, usage or category capture may
retain its original provider ID, but never a personal account identity. Captured
or active executions do not receive that exception. Personal Codex history may
retain the native `openai-codex` transport alongside its `codex-oauth-token`
credential owner, with the same permanent account-binding requirements.

Managed runtime captures require managed keys, not personal accounts. Captured
usage and positive optional category thresholds require managed runtime evidence;
new executable canonical Auto must capture its usage identity. Personal usage
remains outside platform model usage. Whole uncaptured Run/event decisions stay
SQL NULL; unrelated thread events remain optional; created/model-selection events
require their actual canonical selection. Historical personal IDs are not checked
against today's changing catalog.

The executable production rollback resolver rejects API artifacts before merged
Release 1 commit `b6919718b6d856dfa3a7c500b6e899dd3fde7674`. Deployment of that
resolver, actual serving writers, retained targets and all in-flight consumers
must still be verified; a source change does not execute the floor.

The disposable database regression executes the authenticated Runner usage
webhook against outgoing-schema historical fixtures. It compares legacy,
selection-only Auto (a deliberately incompatible control), and operator-captured
Auto, including expired tokens, unchanged categories and idempotent replay.

Only the temporary selected replacement-lineage projection is retired: migration
1364 has rebound its relationships. Physical legacy catalog/routes and execution,
native, installed CLI, V8/cache/export readers remain supported. Do not delete a
catalog primary key while routes/reference ranks still point to it (route foreign
keys do not cascade updates), or retire readers based solely on canonical current
heads. Existing usage identity/category interpretation and original histories are
unchanged. No new format version, progress row, activation switch or extra release
is introduced by these checks.
