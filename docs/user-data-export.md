# User Data Export

`POST /api/user/export` creates a downloadable ZIP containing the user's
conversations, readable agent and workflow instructions, and current memory.
The export page lists these five categories and preserves the existing job,
download, expiry, and cooldown flow.

## ZIP format v2

Read `export-manifest.json` first. Its `formatVersion` is `2`; older exports
have the preceding layout and no format version. JSONL files contain one JSON
object per line, encoded as UTF-8. Empty record sets produce empty files.

| Path                             | Content                                                                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat-threads.jsonl`             | Every existing thread owned by the user, including empty threads, with the user-facing metadata described below.                                                        |
| `chat-messages/<threadId>.jsonl` | Canonical chat-event rows for that thread, including message bodies and control events. Every exported thread has a file, even when it has no events.                   |
| `agents.jsonl`                   | Readable agents with their IDs, organization IDs, names, display names, visibility, update times, and canonical `instructions` content.                                 |
| `workflows.jsonl`                | Readable workflows with IDs, organization and agent associations, names, descriptions, visibility, timestamps, official definition identity, and `instruction` content. |
| `memory/<orgId>/<relativePath>`  | Files from the current head of the user's memory storage in each organization, preserving their relative paths and bytes.                                               |
| `export-manifest.json`           | Format and chat-event schema versions, collection timestamps, owner and request organization, membership organization IDs, record counts, and file checksums.           |

Thread, agent, and workflow records are emitted in ascending ID order. Chat
events are in ascending `seqId` order. Sequence IDs can have gaps; a gap does
not establish missing content.

Thread metadata retains `id`, `userId`, `title`, `agentId`, `orgId`, and
`sourceScheduleRunId`; creation, update, activity, read, pin, and rename times;
`pinOrder`; saved `draftUserMessage` and `draftAttachments` metadata; and
`selectedModel`, `modelSettings`, `codexServiceTier`, `selectedImageModel`, and
`selectedVideoModel`. Attachment metadata does not include attachment binaries.

The manifest's `counts` fields mean:

- `chatThreads`: rows in `chat-threads.jsonl`.
- `chatMessages`: canonical event rows across all thread files, including
  controls such as revocations and run-state events. This is not a count of
  visible message bubbles.
- `agents` and `workflows`: instruction records, including empty instructions.
- `memoryFiles`: memory files included in the ZIP.

Each `files` entry records a relative `path`, uncompressed byte count (`bytes`),
and lowercase SHA-256 digest (`sha256`) of that entry's exported bytes. The
manifest lists every data file, including empty JSONL files, and excludes
itself. Validate the extracted bytes against these values; ZIP compressed sizes
are different. The checksums detect corruption but are not a signature or proof
of source authenticity.

Memory collection also verifies the source archive: its file count must match
the current storage metadata and manifest, and each file's byte count and
SHA-256 must match the source manifest. A mismatch fails the export before it
can be completed.

## Scope and authority

The request organization identifies where the user started the export; it does
not limit the export to that organization. Collection fetches all current Clerk
organization memberships once and records their IDs in `accessibleOrgIds`.
Agent and workflow queries are restricted to those organizations and use the
same read-visibility predicates as their production readers:

- Agents are readable when public within a member organization or owned by the
  user. Another member's private agent is excluded.
- Workflows are readable when owned by the user or public on a readable agent.
  Another member's private workflow is excluded. Organization administration
  does not independently grant private instruction access.
- Official workflows must be installed. Their instruction body comes from the
  accepted official catalog revision; custom workflows use their canonical
  stored instruction.

Chat threads and memory are selected by user ownership. They are not broadened
to other organization members' conversations or memory. Agent instructions use
the canonical instruction reader, including its existing normalization of
legacy profile metadata.

A missing canonical agent instruction document fails the export. A present,
empty document is valid and exports as an empty string.

## Conversation consistency

The exporter uses the canonical current-history reader: the immutable R2
snapshot plus PostgreSQL events after the snapshot's physical coverage cursor.
The reader verifies the snapshot checksum, schema, thread identity, ordering,
and terminal metadata, and reads the snapshot head and database continuation
inside one read-only repeatable-read transaction per thread.

Rows retain their IDs, thread IDs, sequence numbers, event types, timestamps,
payloads, run/context references, and revocation relationships. Consumers must
interpret controls when reconstructing the visible conversation; the exporter
does not flatten the history into text or discard those relationships.

This is a consistent event history for each thread, not an account-wide
database snapshot. Thread metadata, different threads, instructions, and memory
are collected at different times. Memberships reflect the start-of-collection
lookup. `startedAt` and `exportedAt` describe the collection interval; they do
not assert that all records existed together at either instant.

## Exclusions and resource use

The ZIP excludes runner session history, workflow supporting files and derived
`SKILL.md` files, automation configuration, artifact and attachment binaries,
historical memory versions, and memory processing jobs/candidates/provenance.
References already present in canonical chat-event payloads remain in those
records; referenced files are not downloaded into the ZIP.

Records are paginated and ZIP output streams into multipart object storage.
The exporter does not retain the entire account's content or completed ZIP in
memory. Chat histories are read in batches of at most four and appended to the
ZIP sequentially; each history is materialized by the canonical reader.
Memory extraction materializes one current storage archive. Thread IDs and the
file-checksum inventory also grow with the export. Missing required archives,
invalid snapshots, unsafe/duplicate ZIP paths, and upload failures fail the
export instead of publishing a partial successful download.

Only the claimed running job can transition to completed. If timeout cleanup
has already failed the job, a late worker cannot revive it or enqueue the ready
email; it deletes its newly uploaded ZIP using a bounded cleanup request.

## Deployment compatibility

The HTTP request/response schemas, persisted job schema and statuses, status
polling, completion email, cooldown, and signed download mechanism are
unchanged. No database migration or Runner change is required. Old and new
clients can use either API version's job/status contract during deployment.

The new API creates v2 archives. Previously completed jobs keep their original
object keys and archives and remain downloadable until their existing expiry;
they are not rewritten. A rollback to the preceding API can still serve a
completed v2 ZIP because status/download handling does not parse its contents.
An old API executing an export during a mixed-version deployment still creates
the older layout, so consumers must inspect the archive's manifest rather than
infer its format from the client version.
