# Storage version publication and cleanup

A committed physical Storage version is the publication receipt for its R2
archive and manifest. Normal prepare/commit, server-side volume publication and
system-skill reuse trust that receipt; they do not HEAD or re-upload registered
objects, or rewrite the version's registered archive size.

## Publish after upload

Creating a `storages` container reserves its immutable ID and prefix; it does not
publish a version. Server-side publishers await both archive and manifest PUTs
before registering `storage_versions` and moving HEAD in the existing database
transaction. A failed PUT does not register the version or move HEAD. A database
failure can leave unreferenced R2 bytes, not a published pointer to an unfinished
upload.

For client-direct uploads the API does not observe the PUT acknowledgements.
Only the first commit verifies the uploaded manifest and archive outside the
publication transaction. Registered-version retries use the committed metadata
without another R2 probe. The legacy `force` request field cannot turn a
registered logical version into a new upload.

The existing initial empty memory/artifact version is an explicit archive-less
contract (`fileCount=0`, `archiveSize=0`); it is not evidence of a missing upload.

## Bootstrap seed publication

Limited-free bootstrap prepares seed instructions against a fresh private Storage
UUID and `{orgId}/{storageId}` prefix. Preparation does not create or resolve the
canonical instructions parent. Archive creation, index extraction and both R2
PUTs finish outside database transactions. The prepared logical version remains
bound to that UUID/prefix; it is never translated to a peer's generation.

A short READ COMMITTED transaction inserts the canonical owner/name identity
with `ON CONFLICT DO NOTHING`, then reads its parent `FOR UPDATE` before a fresh
default-Agent decision. The insert arbitrates an absent parent. The direct strong
lock avoids a NO KEY UPDATE-to-UPDATE upgrade cycle with a version writer that
already holds FK KEY SHARE before updating its parent. No provider work runs in
this transaction.

- A committed peer default wins. The losing candidate cannot rewrite HEAD or
  edited seed instructions.
- An incumbent registered HEAD is preserved even when default metadata needs
  repair. Its version must belong to the locked canonical parent; a foreign HEAD
  fails closed. Its content is not reseeded.
- A parent with neither HEAD nor registered versions has never published content.
  Under its strong row lock it may be retired by exact identity and replaced by
  the already-uploaded private candidate in the same transaction. A null HEAD
  with retained versions is an invariant error, not deletion authority.
- Only the elected candidate registers its version/HEAD/index before the existing
  Agent, metadata, entitlement and credit finalization. Storage and Agent unique
  constraints retain canonical identity; onboarding grants retain their existing
  idempotency key. Paid tiers, ownership/visibility and catalog-selected system
  default are preserved. The free metadata upsert checks the conflicting row's
  tier at write time: a concurrent paid writer wins without its entitlement being
  replaced or receiving a free onboarding grant. That branch only completes the
  default-Agent pointer; an earlier tier read is not write authority.
  Configured non-default policies retain Custom even when
  they precede metadata creation; on conflict they retain the stored mode.
  Unconfigured new organizations still start in Auto.

Only an `INSERT RETURNING` receipt owns retirement of a newly inserted,
unpublished candidate; ID equality alone does not. A candidate's captured prefix
must also match its selected parent before publication. An existing live
same-identity generation is retained rather than treated as disposable work.

Losing candidates and retired empty parents enqueue exact-prefix cleanup v1 in
that transaction. Preparation or publication failure joins all started PUTs
before bounded compensation. Compensation arbitrates the captured candidate's
primary key with an insert probe and checks only its exact UUID/prefix. The probe
uses a private name and is removed in the same transaction, so it cannot contend
with or adopt a peer's canonical generation. This waits for an uncertain
publication instead of mistaking an invisible in-flight insert for rollback.
Recovery SQL has a one-second lock timeout and five-second statement timeout,
independent of the cancelled request's signal.
Any already-registered captured parent is retained. Compensation never resolves
a replacement by canonical name and never deletes a live parent. Cleanup
inventory uses an independently bounded signal after request cancellation; its
failure cannot replace the original preparation/publication error. R2 work runs
outside transactions, with the existing worker's durable retry/lease protocol.

A crash before inventory persistence and a provider accepting a PUT after its
cancelled response can still leave unreferenced bytes. Those require the wider
parent's late-upload/grace-period sweep; this slice does not claim a complete
physical-immutability or orphan-GC solution. See the
[bootstrap scope and unchanged data contract](deployment-compatibility.md#bootstrap-private-generation-publication-and-advisory-retirement).

## Agent instruction update ordering

Agent instruction PUT uses two short database transactions around transaction-free
preparation. The first locks and authorizes the Agent, reserves the canonical
Storage ID/prefix and the existing same-key Pi publication token, then commits.
Only afterward does it build files/archive/index and await archive/manifest PUTs.
Preparation uses the captured Storage generation; it never recreates a deleted
container. Registered instruction versions still need no HEAD or PUT.

The final transaction rechecks the Agent's existence, name, ownership/visibility,
canonical Storage ID/prefix and exact publication token. It locks Storage before
Pi lifecycle rows, then atomically commits version/HEAD/index, Agent updated
metadata, Pi demands and token completion. A later reservation supersedes an
older same-key preparation even if the older upload finishes last. Unrelated
metadata updates do not supersede that token and their latest fields are retained.

An update that loses its publication or Storage generation returns `409 CONFLICT`;
callers should read the current instructions before deciding to retry. Deletion
and permission loss retain the existing 404/403 outcomes. Failed, cancelled or
rejected work awaits database-only settlement of its exact token, never clearing
a replacement token or deleting uploaded R2 bytes. The previous published HEAD
remains readable while upload is pending. Process termination can still strand a
pending token until a replacement update or lifecycle deletion; this is not a
crash-recoverable upload job. Ordinary updates and bootstrap now use the shared
preparation/DB-only publication helpers. The old transaction wrapper has no
remaining caller and is retired.

## Remove references before objects

Clerk organization/user cleanup locks the owned Storage parents in UUID order.
Deleting their versions through the parent cascade and enqueueing their R2
cleanup inventory commit together. Export output keys are likewise captured in
the same transaction that deletes their export references. No R2 call occurs in
these transactions.

The inventory uses handler version 1 of `storage-object-cleanup` in the existing
`background_jobs` table. It has no owner foreign key, so deleting a user or
organization cannot cascade away the cleanup obligation. A request attempts a
small owned batch after database deletion; `/api/cron/process-background-jobs`
reclaims pending work or expired leases independently of a Clerk redelivery.

A prefix job lists at most 1,000 objects, deletes that page, then yields if the
listing was truncated. It uses delete-first pagination, not a persisted R2
continuation token. Listing failures, partial delete responses and uncertain
receipts retain the target and retry with backoff from one to fifteen minutes.
Retries are not discarded after a fixed failure count. Each worker call is
bounded to eight jobs/pages and a forty-second cancellation deadline; completion
and continuation retain the existing database-clock lease checks.

Cleanup checks for live database references before deletion and lists only the
captured prefix with a trailing slash. A prefix cannot consume a sibling merely
because its name starts the same way. User deletion retains org-owned Agent
instruction Storage and the existing conservative treatment of legacy shared
prefixes: only canonical `{orgId}/{storageId}` user prefixes are queued for
physical deletion. Organization cleanup retains its broader owned-data scope.

## Read integrity and remaining boundaries

Readers fetch objects directly rather than performing an existence HEAD first.
Actual downloads still have their caller-owned byte limits, declared transfer
length checks and decoding/content checks. A missing object fails the GET; normal
reuse is not an infrastructure repair path. Historical missing objects or
out-of-band bucket changes require repair, not a fabricated successful read.

The logical version hashes file paths and contents, not gzip bytes. Historical
`archiveSize` remains an encoding hint for decoded readers. Pi's existing index
is not a full attestation of every extracted file against `versionId`.

This change does not make physical keys immutable: concurrent first uploads and
already-issued presigned PUT URLs can still overwrite or create objects after a
cleanup completed. It introduces no grace-period sweep for those late uploads
or for uploads that never registered a version. Those physical-key, retention
and GC boundaries remain in #37402, including bytes left by rejected instruction
preparation.

## Deployment compatibility

Instruction update requests and successful responses are unchanged; 409 is an
additive failure outcome. There is no new persisted shape or migration. Old
transaction-held instruction writers and new prepared writers use the same keyed
Pi token and Agent/Storage serialization, so an older preparation cannot publish
over a newer reservation. Old instances continue holding locks through their IO
until they drain; rolling back restores that locking behavior, not physical R2
immutability. Existing readers continue following the last committed HEAD.

Cleanup is additive control data, with no schema migration. The cleanup input has
an explicit handler version and captures bucket plus exact prefix/key. Older API
workers ignore the new job kind; queued obligations remain pending until a
compatible worker serves them. Older Clerk cleanup instances still use their
previous R2-first order until they drain, so the new deletion invariant starts
with the new implementation, not merely with the creation of its first job.
Existing user-deletion jobs can retry through the new path without a checkpoint
migration. Rolling the API back delays new cleanup jobs rather than losing them.
