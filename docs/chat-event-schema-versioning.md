# Chat Event schema versioning

Snapshot NDJSON rows and Raw Chat Event API rows are representations of the
same schema. The current and only served version is V8.

## V8

The event catalog contains:

- `input.prompt`, `input.automation`, `input.budget`, `input.rejected`
- `output.message`, `output.error`, `output.followups`
- `run.completed`, `run.failed`, `run.cancelled`
- `control.interrupt`, `control.revoke`, `usage.recorded`

`contextType` is one of `web`, `slack`, `discord`, `feishu`, `teams`, `telegram`,
`agentphone`, `automation` or `agent_run`. Every input row has a context type.
Canonical row payloads are projected into public events by the shared contract.

## Failure reasons

A failed-run row may carry an optional `failureReason`. The bounded wire token
also permits well-formed values newer than the reader's semantic taxonomy.
Failure reasons belong only to failed-run rows; the strict payload JSON does
not store them. Rows without a reason remain valid.

## Client compatibility

Chat Event read endpoints carry no schema-version request or response header.
The API always serves the current version. Client compatibility follows the
general client rules:

- The Web App is gated by the enforced Web client floor (`X-Client-Version`
  with `426 Upgrade Required`). A schema change incompatible with supported
  builds requires advancing that floor after the replacement App is live.
- Runs may use a commit-addressed CLI captured with their execution context
  or a compatible CLI installed in the runner rootfs. Neither necessarily
  advances with each API deployment. Inspect actual readers and gate or drain
  incompatible callers before changing a persisted shape.
- App and CLI Snapshot readers require the paired `lastEventId` response
  metadata; they do not reconstruct it from the NDJSON body.

For earlier release receipts and contraction gates, see the
[pre-cleanup rollout records](https://github.com/okou-ai/okou/blob/efdfb1ce76686698e2446eceb5a439caf88cd854/docs/deployment-compatibility.md).

## MCP source metadata

A server-owned `source.kind: "mcp"` user-message part carries the verified OAuth
client ID and an optional client-name display snapshot. The App renders a local
MCP mark with the saved name or a generic `MCP` label. Existing messages are not
retroactively labeled by inference.

Direct chat sends reject caller-authored MCP source parts. The MCP writer
appends source metadata to the same immutable input as its text. An optional,
bounded name comes from a matching HTTPS CIMD document; this self-asserted name
is display metadata, not proof of which software is running. Invalid or
unavailable metadata leaves the name absent without failing the authorized send.
Replays preserve the original source and name. Retry identity does not require
the original OAuth client ID.

Before introducing a new persisted source kind, verify every supported
App/API/history/Snapshot reader and the enforced Web client floor. The CLI
`okou chat messages` validates rows with `chatEventRowSchema`, whose
`payload.userMessage` is opaque; do not infer that all clients parse the document
in the same way. A merged reader PR or release tag alone does not prove that
the reader is serving.

## Snapshot storage and reads

The API owns one canonical pointer per `(chat_thread_id, archive_schema_version)`,
enforced by a unique database index. Persisted pointers use version 8 and
readers select that version directly.

Each pointer contains an immutable, content-addressed R2 object key, physical
coverage (`last_seq_id`, `last_event_id`) and a paired logical terminal cursor
(`terminal_seq_id`, `terminal_event_id`). The physical event ID is required.
An empty logical body has terminal sequence zero and a null terminal event ID.
Snapshot responses expose the logical terminal cursor.

Only the first Snapshot for a thread may bootstrap from available Raw Events.
Sequence positions may start above 1 and contain gaps. Every subsequent refresh:

1. Downloads and validates the persisted immutable object, including its digest,
   row/projection contract, ordering, thread ownership and terminal metadata.
2. Reads only Raw Events after the stored physical coverage watermark.
3. Appends that tail, uploads a new immutable object and publishes its pointer
   with an exact compare-and-swap against the source metadata.

An unreadable or invalid Snapshot fails closed; it does not authorize rebuilding
history from Raw Events, because covered rows may already have been reclaimed.
A future schema change must provide and verify an explicit prefix-preserving
conversion before activation.

## Browser cache

The IndexedDB version combines a cache-layout base with the current Chat Event
schema version. A version change recreates the Chat Event cache stores. The
cache cursor stores the schema version and paired event/sequence boundary;
row-plus-cursor writes are atomic.

Raw Event retention and orphaned R2 object collection are separate policies.
