# Model identity release three: selected history and immutable execution

This is the release-three implementation tracked by
[#38114](https://github.com/okou-ai/okou/issues/38114), following
[#38270](https://github.com/okou-ai/okou/pull/38270). It must remain draft until
its data, serving, installed-consumer and retained-history gates are verified.
There is no database switch, phase row, write-version marker, trigger or new
activation mechanism. Creating this PR does not authorize a production backfill
or release.

## Current selection identity

The API's current catalog, capability lookup and available-model response name
Auto as `auto`. Current catalog replacement targets normalize to that selection;
legacy catalog rows remain historical records rather than current capability
identity. The Web optimistic model annotation also uses `auto`.

Public null intent still selects Auto. Omitted PATCH/send fields still mean no
change. Omitted creation fields resolve member preferences through admission;
the database default is not a substitute for that resolution. Explicit personal
models and their effort preferences are preserved. Auto accepts neither effort
nor Fast.

## Relational migration

Migration `1358_canonical_selected_model_history` uses 1,000-row keyset write
sets inside the existing transactional migration runner. It is restartable by
transaction rollback; its data transform is idempotent. The per-statement bound
is 120 seconds. Validate duration on an authorized representative database copy
before deployment; a timeout is a failed migration, not permission to increase
it without measurement.

- Thread and member nullable Auto, `okou-1.0`, and its two replacement aliases
  become `auto`. The aliases' selection equivalence comes from migration 1298,
  not a guess about the upstream execution.
- Only Auto/Auto-replacement and `@preset/` effort keys are removed. Other
  explicit-model preferences survive, including retained personal keys.
- Selection-bearing thread events get canonical Auto. Unrelated events keep
  absent model fields. Personal incremental effort patches are preserved.
- Legacy input decisions and user-message model annotations become canonical
  selected history. A whole SQL NULL `model_selection` stays NULL: it is not
  converted into a capture. Unconsumed legacy runless decisions block the
  migration so admission cannot reinterpret an existing queued decision.
- Runs, native conversation bodies/references, queued execution configurations
  and observation records are not rewritten. Original event IDs, stream
  positions, ownership and user timestamps are unchanged.

UPDATE predicates and SET expressions inspect the current row, not a saved
backfill copy. A concurrent personal selection cannot be overwritten with Auto.
Defaults cover outgoing writer INSERTs that omit the selection. Final NOT NULL
applies only to thread/member preferences. Present event/Run selections and
present input annotations must be nonempty; optional events and unresolved
lifecycle history stay optional. Pending/running Built-in Runs with a launch
snapshot require their selected identity, concrete runtime provider/model and
managed key. This is a relational constraint, not proof of every serialized
execution capability or credential field.

Use `turbo/packages/db/scripts/audit-model-identity-history.sql` for read-only
before/after counts on an authorized database copy. It reports capture and
retained reference coverage without emitting private records. It does not prove
object readability or successful resume.

## R2 snapshots

[The numbered maintenance tool](../turbo/packages/db/scripts/migrations/020-canonical-model-selections/README.md)
handles one owner-scoped thread snapshot or V8 event snapshot per invocation and
is dry-run by default. SQL and R2 work are separate; the SQL transaction never
performs external I/O.

The tool verifies scope, source content hash, size and supported representation.
It uploads a new immutable gzip object with a hash-derived key, then publishes
only if the exact previous pointer and cursors still match. It preserves
microsecond timestamp precision in thread-pointer comparisons. Event framing,
ordering, physical watermark and terminal cursor do not change. Neither source
objects nor other export references are deleted or retargeted. An upload failure
leaves the pointer unchanged; a failed or conflicting publication leaves an
unreferenced immutable object. Retrying reads the current head and can reuse an
identical destination. Reported conflicts are not completed migrations.

Relational history can therefore be canonical while an unprocessed immutable
snapshot is still legacy. Retain its readers until every relevant head and
retained exported snapshot is accounted for. Existing garbage collection owns
unreferenced objects; this tool does not perform bucket scans or delete blobs.

## Retained execution and remaining retirement

A selected alias does not identify an old execution's provider, account, key,
dialect, transport or capabilities. Never substitute today's organization
preset for missing captured execution state. Both inline native history and
content-addressed native-history references remain unchanged. An old captured
Responses configuration must stay authoritative; new OpenRouter launches keep
generation-5 Chat Completions. Background memory retains its independent
capture and is not foreground Auto.

The existing legacy capture readers in core helpers, queued admission, native
session-family comparison, Pi configuration and captured observation/reporting
remain required until their support window is actually closed. They are not
retired by this draft. No historical runtime conversion is claimed from an alias
or a relational reference census alone. Complete any justified conversion and
remove the proven-expired readers, declarations and obsolete tests in this same
PR before declaring all of #38114 complete; do not treat this draft as a new
release boundary.

## Readiness gates

1. Verify PR2's real production API/App/CLI release, serving instance drain and
   supported rollback targets. A successful production promotion does not prove
   the complete fleet or rollback policy. Exclude pre-PR2 nullable writers.
2. Verify supported Web, CLI, iOS and actually installed CLI/Pi/rootfs readers
   against canonical catalog/selection output. Browser caches and old snapshot
   responses are also consumers; a Web floor does not cover CLI/iOS.
3. Drain old queued/active executions and unconsumed legacy inputs; verify late
   producers and retained execution semantics independently.
4. Complete the relational census, online/R2 snapshot inventory and owner-scoped
   dry-runs. Establish real native/R2 restoration for retained sessions in both
   dialects. Completed Runs and session references remain relevant.
5. Verify DB-before-API operation with the still-serving PR2 API. Normal null
   intent is canonicalized and omitted INSERT selections use the new default;
   omission of PATCH/send preserves the existing choice. A pre-migration request
   holding old settings or a captured legacy input can still attempt an old
   write. Drain those requests and inputs; constraints reject incompatible
   stale settings rather than silently changing them. Rollback must not restore
   nullable writers. The migration is not an operational fleet fence.

## Validation boundary

The migration test exercises multiple keyset pages, preserved personal state,
optional uncaptured inputs, admission drain rejection, transactional recovery,
transform replay and lifecycle constraints. Permanent checks run against replayed
migrations and a freshly generated schema. The snapshot CLI test uses real
PostgreSQL and an external object-store HTTP fixture to exercise dry-run,
conditional upload, pointer conflict, partial-failure recovery, owner/hash
rejection and V8 replay. API tests cover canonical public output and the existing
omission/personal-preference contract.

These are local/nonproduction checks, not installed-consumer, production
backfill, native-session restoration or deployment acceptance.
