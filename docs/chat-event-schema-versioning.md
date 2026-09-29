# Chat Event schema versioning

Snapshot NDJSON rows and Raw Chat Event API rows are two representations of
the same Chat Event schema. The current and only served version is V8.

## Client compatibility

Chat Event read endpoints carry no schema-version request or response header.
The API always serves the current version, and client compatibility follows the
general client rules instead of a per-endpoint negotiation:

- The Web App is gated by the enforced Web client floor (`X-Client-Version`
  with `426 Upgrade Required`). A schema bump that old App builds cannot read
  raises that floor.
- Runs may use a commit-addressed CLI package captured when their execution
  context was created or a compatible CLI installed in the runner rootfs.
  Neither necessarily advances with each API deployment. Before adding a
  persisted kind, inspect the CLI's actual readers and gate or drain any
  incompatible supported callers rather than assuming a fixed expiry.

Platform and CLI readers still require Snapshot responses to include the
paired `lastEventId`; they do not reconstruct missing response metadata from
the immutable NDJSON body.

Raw Events are read from the current database schema and returned in V8. The
API does not downgrade rows or Snapshot objects to retired versions.

### MCP source reader preparation (#37233)

V7 readers now recognize a bounded, server-owned `source.kind: "mcp"` user-message
part with an OAuth client ID and optional client-name display snapshot. The App
renders a local MCP mark with the saved name or a generic `MCP` label. Existing
messages do not gain an MCP source by inference. Direct chat sends reject
caller-authored MCP source parts; the `/mcp` writer still emits only the old
text-only input shape in this reader-preparation release.

The new kind is **not** readable by older strict V7 App/API/snapshot readers.
The #37234 writer appends the source to the same immutable input as MCP text,
using only the verified OAuth client ID. A bounded, optional name is snapshotted
from a matching HTTPS CIMD document; the document is self-asserted display
metadata, not proof of which software is running. Invalid or unavailable
metadata leaves the name absent and the authorized send succeeds. Replays
preserve the original name and source, even when another authorized OAuth
client retries the same request ID and text; retry identity does not require
the original client ID. After the #37276 cleanup, pre-cutover text-only MCP
inputs remain readable but no longer match an MCP retry. The requester
explicitly waived the old-writer 24-hour drain, so a still-eligible old input
may return `request_id_conflict` instead of its original receipt. Existing
messages are never inferred or retroactively labeled.

Before activating the writer, verify that the prepared reader is serving from
every current API/App and history/snapshot path, and independently deploy and
verify the Web client floor at `0.982.0` or newer (the first reader-capable App;
#37277 / PR #37278). Inspect the actual CLI read paths rather than requiring
a blanket old-context drain: `okou chat messages` validates Raw Event and
Snapshot rows with `chatEventRowSchema`, whose `payload.userMessage` is opaque;
other current CLI chat commands do not parse that document's source kind. This
new MCP part does not require a CLI floor or old-run drain for those paths. If
an independently supported strict CLI reader is identified, verify its
compatibility or gate and drain it before activation. A merged reader PR,
newer `main`, or production release tag alone does not prove the serving gate.
Older rollback artifacts are expressly unsupported for this change; restoring
one after source-bearing events exist requires a separate coordinated
compatibility decision. Do not activate the writer until the current-serving
compatibility boundary is satisfied.

## V8

V8 removes retired Goal, run group, queue marker, thinking and browser
lifecycle data from the schema. V8 rows are a strict subset of V7 rows, so a V7
reader accepts every V8 row.

- Event types go from 21 to 13: `input.prompt`, `input.automation`,
  `input.budget`, `input.rejected`, `output.message`, `output.error`,
  `output.followups`, `run.completed`, `run.failed`, `run.cancelled`,
  `control.interrupt`, `control.revoke` and `usage.recorded`. The deleted
  types are `input.goal`, `goal.open`, `goal.close`, `run.queued`,
  `run.dequeued`, `output.thinking`, `browser.open` and `browser.close`.
- `contextType` is an enum of `web`, `slack`, `discord`, `feishu`, `teams`,
  `telegram`, `agentphone`, `automation` and `agent_run`; `goal` and `github`
  are removed. `input.*` rows carry a `contextType`.
- A userMessage document has no `goal` part, and projected events have no
  `runGroupId`. Saved shares have no `runGroupIndex`.
- The runless `Okou Goal retired.` notices written by migration
  `1094_archive_retired_goals` are ordinary `output.message` rows and are
  unchanged.

### V7 to V8 upgrade rules

Migration `1286_chat_event_v8` applies these rules to the Raw Event table, and
the adjacent V7 to V8 Snapshot migration applies the same rules to stored V7
Snapshot objects:

1. Rows of the eight deleted types are removed. Revocation edges that pointed
   at them may dangle; readers treat revocations only as a set of IDs.
2. A `goal` context on an input row (`input.*` or `control.revoke`) becomes
   `automation` with a null `contextId`.
3. A `goal` context on any other row becomes a null `contextType` and
   `contextId`, like ordinary output.
4. A `github` context becomes `web` with a null `contextId`. An
   `input.rejected` row without a context also becomes `web`; V7 did not
   require a context on rejections.
5. Every userMessage part `{type: "goal", goalBrief}` becomes
   `{type: "text", text: goalBrief}`, keeping the part order.

The same migration rewrites `agent_runs.trigger_source` and
`run_uploaded_files.source` from `goal` to `automation-schedule` (billing
already counted both as automation), converts Goal parts in thread and agent
drafts to text parts, and removes `runGroupIndex` from saved shares.

A thread's V8 Snapshot pointer is published beside its V7 pointer, so
`chat_event_snapshots.archive_schema_version` accepts 7 and 8 during the
transition. The V7 to V8 Snapshot migration and the V7 pointers are transition
code: the V8 plan's PR-3 removes them after every thread's Snapshot has
converged to V8 and no rollback target serves V7.

### Optional V7 failure reasons

V7 `run.failed` readers accept an optional `failureReason` field and continue
to accept historical rows that omit it. Other event types reject the field.
The field uses the bounded failure-reason wire token, so prepared readers also
preserve well-formed values that are newer than their known semantic taxonomy.

Because existing V7 readers are strict, adding the optional field uses a
reader-first rollout even though the version number does not change:

1. Deploy the tolerant contract to every API, app, CLI, and persisted-history
   reader while all writers continue to omit the field.
2. Wait until previous app bundles, commit-addressed CLI artifacts, serving and
   rollback APIs, and other strict V7 readers have drained or are blocked by an
   enforced compatibility floor.
3. Enable writers in a later release.

Reader preparation shipped in release
`89c6a521944e2ac8550da424f164db08f4f80f0c` and contains reader commit
`c093e0ffdab988d2a8a071809f90d87fa3e79f20`. Writer activation stores the
optional value in a nullable `chat_events.failure_reason` column outside the
strict payload JSON. The minimum supported App version is `0.830.0`, the first
prepared App build.

Commit-addressed CLI contexts created before reader API promotion must drain
through their two-hour queue lifetime, two-hour execution budget, and bounded
finalization before writer activation. Production rollback targets must contain
the reader commit above; the release commit is the first compatible tagged
baseline. A rollback to an earlier strict V7 reader is unsafe after any
reason-bearing row has been persisted.

The rollout does not change Snapshot pointers, client cache versions, or the V7
wire version. A V7 cache can therefore contain both historical reasonless
failures and later failures with a reason.

## Snapshot storage and reads

The API owns exactly one canonical pointer per
`(chat_thread_id, archive_schema_version)`, enforced by a unique database
index. Readers select the current-version pointer directly.

The pointer contains the immutable, content-addressed R2 object key and a
paired `{lastEventId, lastSeqId}` terminal cursor. `last_event_id` is required.
Snapshot pointers have no parent or head identity columns.

Snapshot reads persist and return the current-version pointer. A request cannot
fall back to a stored retired-version pointer when the current pointer is
unavailable.

## Snapshot upgrade invariant

Only the first Snapshot for a thread may bootstrap from the currently available
Raw Event prefix. Sequence positions may start above 1 and contain gaps. Once
any Snapshot exists, every refresh or schema upgrade must:

1. Download and validate the stored Snapshot object.
2. Run the adjacent Snapshot migration chain on that historical prefix.
3. Read only Raw Events after the stored paired cursor.
4. Append that tail, upload a new immutable object, then publish its database
   pointer with an exact compare-and-swap.

A missing object, invalid Snapshot, missing migration, or missing historical
prefix fails closed. It must never authorize a full Raw Event rebuild because
older Raw Events may already have been reclaimed.

Future Chat Event schema bumps must include every required adjacent Snapshot
migration before release; if an old version is not migratable, all pointers
relying on it must first converge to a migratable version.

## Browser cache

The IndexedDB database version combines a cache-layout base version with the
current Chat Event schema version. Any IndexedDB version change deletes and
recreates all Chat Event cache stores. The cache cursor stores the schema
version and paired event/sequence boundary, and row-plus-cursor writes are
atomic.

Raw Event retention and orphaned R2 object collection policy are outside this
change. The invariant above makes later Raw Event reclamation safe without
adding retention behavior here.
