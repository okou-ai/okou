# Chat Event schema versioning

Snapshot NDJSON rows and Raw Chat Event API rows are two representations of
the same Chat Event schema. The current and only served version is V7.

## Client compatibility

Chat Event read endpoints carry no schema-version request or response header.
The API always serves the current version, and client compatibility follows the
general client rules instead of a per-endpoint negotiation:

- The Web App is gated by the enforced Web client floor (`X-Client-Version`
  with `426 Upgrade Required`). A schema bump that old App builds cannot read
  raises that floor.
- CLI artifacts are commit-addressed and live at most about two hours, so they
  track the current API without a separate version floor.

Platform and CLI readers still require Snapshot responses to include the
paired `lastEventId`; they do not reconstruct missing response metadata from
the immutable NDJSON body.

Raw Events are read from the current database schema and returned in V7. The
API does not downgrade rows or Snapshot objects to retired versions.

### MCP source reader preparation (#37233)

V7 readers now recognize a bounded, server-owned `source.kind: "mcp"` user-message
part with an OAuth client ID and optional client-name display snapshot. The App
renders a local MCP mark with the saved name or a generic `MCP` label. Existing
messages do not gain an MCP source by inference. Direct chat sends reject
caller-authored MCP source parts; the `/mcp` writer still emits only the old
text-only input shape in this reader-preparation release.

The new kind is **not** readable by older strict V7 App/API/snapshot readers.
Before the separate writer activation in #37234, verify that this prepared
reader has been promoted to every serving API and App, older App builds are
blocked by an enforced Web client floor, earlier serving/rollback APIs and
persisted-history readers are excluded or prepared, and outstanding old CLI
contexts have drained. A merged reader PR or newer `main` alone does not prove
this gate. Do not let a writer emit the new kind until this compatibility
boundary is satisfied.

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
