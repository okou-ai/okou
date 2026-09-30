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
and GC boundaries remain in #37402. Agent-instruction publication inside its
existing authorization transaction also remains unchanged.

## Deployment compatibility

This is additive control data, with no schema migration. The cleanup input has
an explicit handler version and captures bucket plus exact prefix/key. Older API
workers ignore the new job kind; queued obligations remain pending until a
compatible worker serves them. Older Clerk cleanup instances still use their
previous R2-first order until they drain, so the new deletion invariant starts
with the new implementation, not merely with the creation of its first job.
Existing user-deletion jobs can retry through the new path without a checkpoint
migration. Rolling the API back delays new cleanup jobs rather than losing them.
