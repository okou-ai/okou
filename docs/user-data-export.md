# User Data Export

`POST /api/user/export` accepts one export containing five groups: the user's
chat threads, chat messages, readable agent instructions, readable workflow
instructions, and current personal memory. The existing status, download,
48-hour expiry, and 24-hour completion cooldown contract remains unchanged.

The default-off `_durableUserExport` switch admits new exports to a persistent
job handler. Its ZIP format is v3. Jobs accepted in legacy mode still execute
the v2 streaming exporter; disabling admission does not stop already accepted
durable jobs. Previously completed ZIP files keep their original contents.

## Reentrant execution

The API atomically creates the user-visible export and its `background_jobs`
record before returning 202. Request `waitUntil` runs a short initial batch;
`/api/cron/process-background-jobs`, scheduled every minute, is the independent
recovery path. A lost response or terminated process does not lose admission.

The minimal job kernel persists handler kind/version, owner, input, checkpoint,
availability, failures, and lease. It claims with `FOR UPDATE SKIP LOCKED` and
a fresh 60-second lease token. Every checkpoint, yield, failure, and completion
checks both the token and lease expiry against the database clock. A process
whose lease expired cannot commit late progress, even if its provider request
later succeeds. Normal yields reset consecutive failures and do not consume a
retry attempt.

The export handler advances these phases across invocations:

1. Collect one source record or a chat tail page bounded by 100 rows and a
   2 MiB byte estimate, and persist immutable staged bytes or an exact existing
   object reference.
2. Read each source in ranges of at most 4 MiB, persisting CRC32 and resumable
   SHA-256 state. Retain its object ETag for conditional reads.
3. Write the paginated checksum inventory and deterministic ZIP layout.
4. Assemble at most 4 MiB per step, retain partial-part bytes in R2, and upload
   complete 16 MiB multipart parts. Store each part receipt with its checkpoint.
5. Complete the object, publish the download, and satisfy the durable email
   notification obligation.

The worker stops starting steps after a 20-second budget. Each attempt has a
30-second cancellation deadline. Failed attempts retain the last committed
checkpoint and back off from 15 seconds up to 10 minutes. Six consecutive
failures end the job; successful progress resets that count. Jobs expire after
seven days. These budgets apply to individual invocations, not the total export.

Execution is at least once. If an object or part was written before checkpoint
commit, a later attempt repeats the same content-addressed write or part number.
A single oversized chat row may exceed the page estimate, but payloads over
32 MiB are rejected before loading their bodies. Metadata-only size queries
prevent a page of many large messages from exhausting worker memory.

A lost multipart completion response is recovered by checking the completed
object's size and job/format metadata before publishing it. Publication and
notification progress remain fenced by the current lease. Publishing the download
and persisting the notification obligation commit together. The subsequent outbox
insert and job completion also commit together, so notification retries cannot
enqueue a second ready email after completion. Recipient lookup failures leave the
already completed download available.

Terminal and orphaned jobs retain their cleanup obligation. After a two-minute
grace, bounded cleanup removes staged objects and unfinished multipart uploads,
then removes inventory/control rows. It preserves unexpired successful ZIPs and
never deletes referenced chat snapshots or memory source objects. Cleanup retries
start with the remaining objects. The legacy ten-minute stuck-export cleanup
excludes durable jobs; a long-running export is not failed merely for its age.

## ZIP format v3

Read `export-manifest.json` and `README.md` first. The included `restore.py`
uses Python 3.9 or newer to verify the ZIP and recover the five content groups
as JSONL and original memory files, without network access or extra packages.
The summary includes format and chat schema versions, collection times, owner and request organization,
initial readable organizations, and the paginated file-inventory descriptor.
The file inventory contains SHA-256 digests and byte counts; its pages also have
an aggregate digest recorded in the summary.

| Path                                             | Content                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `chat-threads/<threadId>.json`                   | One owned thread's metadata, including empty threads.                              |
| `chat-messages/<threadId>/index.json`            | Authoritative snapshot path, physical coverage, and final tail bound.              |
| `chat-messages/<threadId>/snapshots/*.ndjson.gz` | Exact immutable canonical chat snapshot bytes, with adjacent source metadata JSON. |
| `chat-messages/<threadId>/tail/*.jsonl`          | At most 100 canonical event rows per page, in ascending sequence order.            |
| `agents/<agentId>.json`                          | Readable agent identity, metadata, and canonical `instructions`.                   |
| `workflows/<workflowId>.json`                    | Readable workflow identity, metadata, and canonical `instruction`.                 |
| `memory/<orgId>/<storageId>/archive.tar.gz`      | The current memory archive captured for that storage.                              |
| `memory/<orgId>/<storageId>/manifest.json`       | The source file paths, sizes, and hashes for the nested memory archive.            |
| `manifest/files-<pageStart>.jsonl`               | At most 100 data-file inventory records per page.                                  |

The outer ZIP uses the standard uncompressed STORE method with fixed timestamps;
ZIP64 handles large offsets and entry counts. Keeping byte layout deterministic
allows a new process to resume assembly. Existing gzip sources remain compressed.
The maximum archive size is 16 MiB times 10,000 multipart parts, approximately
156 GiB. This is a defined storage limit, not a function-duration limit.

Thread metadata preserves IDs, user and agent/organization associations, title,
schedule origin, timestamps, pin order, composer draft and attachment metadata,
and saved model/image/video/service-tier preferences. Attachment metadata does
not include attachment binaries.

### Reconstruct a conversation

For each thread, use only the snapshot selected by its `index.json`, decompress
it, then append tail rows whose `seqId` is greater than
`snapshotPhysicalCoverage` and at most `upperSeqId`. Deduplicate by event ID and
sort by `seqId`. Interpret control and revocation rows when deriving visible
messages. Valid sequences may have gaps.

Each thread initially captures the highest committed sequence in its snapshot
or database tail. Each subsequent bounded read captures ownership, current
snapshot head, and tail page in one read-only repeatable-read transaction. If
archiving advanced in the meantime, the export includes the newer immutable
snapshot so rows removed from PostgreSQL remain available. A snapshot that
passes the initial bound is included whole and finishes the thread immediately;
its later controls cannot safely be trimmed away from the earlier messages.
Earlier snapshot files retained during collection are provenance, not additional
conversation rows.

The result is the latest captured canonical prefix plus its bounded tail. It is
not an account-wide or thread point-in-time database dump. Thread metadata,
instructions, and memory can be collected at different times. Creation-time
fences keep newly created entities from extending an in-progress collection.

### Recover memory files

Extract each nested `archive.tar.gz` to recover the original relative paths and
bytes. Verify them against its adjacent source manifest. The exporter checks the
archive byte count against the selected storage version and hashes the retained
object bytes in bounded ranges. It does not decompress a whole memory archive
inside a Vercel invocation or claim to have validated every nested file there.

## Scope and authority

The request organization identifies where the export began; it does not limit
collection to that organization. Initial Clerk memberships bound instruction
queries, and agent/workflow reads use their production visibility predicates.

- Agents must be public within a member organization or owned by the user.
- Workflows must be owned by the user or public on a readable agent. Organization
  administration does not independently grant private instruction access.
- Official workflows must be installed and use their accepted catalog revision;
  custom workflows use the canonical stored instruction.
- Chat threads and memory are selected by user ownership, never by another
  member's access to their shared organization.

Every publication attempt refreshes membership and rechecks the exported resource
set, even when resuming a saved publication checkpoint. Database share locks hold
resource visibility and ownership stable until the download is published.

An unavailable canonical instruction or required source fails the affected
attempt instead of creating a partial successful export. An existing empty
instruction is valid. Snapshot SHA-256 is checked against its content-addressed
object key. Conditional range reads reject a source that changes during export.

Excluded content includes runner session history, workflow supporting files and
derived `SKILL.md`, automation configuration, artifact and attachment binaries,
historical memory versions, and memory processing jobs/candidates/provenance.
Canonical chat payload references remain in the event records, without fetching
those referenced files.

The source cursor and ZIP inventory live in PostgreSQL, and payloads stay in R2.
The worker never holds the entire account or final ZIP in memory. Agent
instructions prefer the validated exact-version Pi text index. A legacy
volume without usable indexed text has explicit limits: a 16 MiB manifest,
32 MiB compressed archive, and 64 MiB expanded archive. A volume exceeding those
limits fails explicitly, preserving the checkpoint for a later retry; it never
publishes truncated instructions or exposes unrelated volume files. Chat
snapshots and memory archives are copied without whole-object decompression.

## Rollout and rollback

Migration 1175 adds the job control table, nullable export execution mode,
and export entry/part inventory. Apply it before promoting the API.
Old code after migration ignores the additive tables/column; new code before
migration is unsupported, including its unconditional cleanup reads.

Keep `_durableUserExport` disabled until every serving API and scheduled cleanup
instance understands `execution_mode = durable-v1` and excludes those jobs from
legacy timeout cleanup. The same deployment introduces the minute cron route.
Only after that compatibility boundary is verified should a separate activation
enable new durable admissions. This PR does not activate production traffic.

Disabling the switch stops new durable admissions while its cron continues
existing jobs and cleanup. Keep a compatible API/cron serving until these jobs
and their cleanup obligations drain. Rolling back to an API whose old cleanup
fails every export after ten minutes is unsafe while durable jobs remain.
Retain the additive schema throughout the rollback window. Handler version 1
persists hash-wasm 4.12.0 SHA-256 state; keep that decoder compatible while jobs
remain, or introduce a new handler version for a future incompatible change.

Old and new clients use the same POST/GET and signed download contracts. A
completed v3 ZIP remains downloadable by an older status/download reader because
it does not parse the ZIP. Consumers must inspect `formatVersion`, not infer the
layout from the client version.

## Legacy format v2

Legacy execution creates `chat-threads.jsonl`, per-thread
`chat-messages/<threadId>.jsonl`, `agents.jsonl`, `workflows.jsonl`, expanded
`memory/<orgId>/<relativePath>` files, and one `export-manifest.json`. Its manifest
uses `formatVersion: 2` with inline record counts and file checksums. JSONL is
UTF-8, one object per line; empty record sets produce empty files.

That path combines each chat snapshot and PostgreSQL tail through the canonical
whole-history reader, reads at most four histories concurrently, and streams a
compressed ZIP to multipart storage. Memory extraction materializes one current
storage archive and verifies its files against the source manifest. It retains
its original single-invocation time limit. The durable switch and v3 layout are
what remove that limit; legacy completed objects are never rewritten.
