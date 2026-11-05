# Registry resource inventory and backfill preparation

The first release added independent archive/head tables and the shared private
archive allowlist. The reader cutover uses these independent tables and private
objects; the presentation publisher maintains both indices during transition.
The operator described here prepares a reviewed original-byte backfill;
deploying its code does not run it or establish production convergence. See the
[publisher and cutover gate](../../../../../../.github/scripts/release/presentation-template-release/README.md)
before activating readers.

## Archive identity

Registry clients pin the SHA-256 of the **existing complete compressed bytes**.
Repacking a logically identical directory changes that public identity. The
operator therefore preserves original tar.gz bytes and proposes
`registry-archives/v1/<sha256>.tar.gz` with the
`registry-tar-gzip-v1` descriptor. This is separate from canonical
`bundles/v1/` archives: existing registry packages contain directory entries and
must not be passed to the canonical content-bundle reader.

The registry archive index is keyed by `(resource_id, sha256)`. Its `version_id`
retains the opaque download response value without a Storage foreign key. The
head table can reference only an archive for the **same** presentation runbook.
Deleting a Storage cannot cascade into either table.

## Read-only inventory

Run from `turbo/packages/db`, with workspace dependencies installed:

```bash
node --import tsx scripts/migrations/028-registry-resource-bundles/inventory.ts \
  --output /private/path/registry-inventory.json
```

Required environment:

- `DATABASE_URL_FILE` (preferred) or `DATABASE_URL`; use a read-only role.
- `R2_USER_STORAGES_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
- `R2_ACCOUNT_ID`, or `R2_ENDPOINT` for a native R2 HTTPS endpoint. Loopback HTTP
  endpoints are accepted only for local fixtures.

Optional `--resource-id <exact-id>` narrows the allowlist. `--selection pinned`,
`latest`, or `all` (default) selects fixed archives, presentation HEADs, or both.
The full current source inventory contains 98 fixed bindings and 23 current
presentation runbooks. The script derives this set from the API's shared list;
counts are not hard-coded readiness checks.

The connection enforces PostgreSQL `default_transaction_read_only=on`. The R2
client issues GETs, with one attempt and a 30-second request deadline. Each
archive is checked against compressed byte count, gzip/tar format, safe paths,
package root, file count and expanded byte count. Fixed downloads also require
the pinned compressed SHA-256. Both compressed and expanded content are bounded
to 32 MiB and 501 regular files. Oversized or incompatible packages are blockers,
not silently rewritten archives.

The source version and Storage row are re-read after each download. A changed
row produces an incomplete receipt. This is a per-row observation, **not** a
global snapshot or permission to apply it later; a future publisher must
revalidate all relevant source identities and concurrency conditions.

The output is created exclusively with mode `0600`, never overwrites an earlier
receipt, and includes scope, descriptors, source identities, and classified
failures. It contains no credentials or signed URLs. Stdout contains a summary
and the SHA-256 of the receipt. Exit `0` means every selected archive verified;
exit `1` means configuration or validation failed. An incomplete receipt is
diagnostic evidence, not an apply plan. `--migrate` is explicitly rejected;
the inventory command has no write mode.

## Prepare a backfill plan

Use a fresh complete inventory from the same database, source bucket and
endpoint. Plans can cover a selected resource/batch; completing one is not proof
that the entire current allowlist is ready. Keep plans and receipts private.

```bash
node --import tsx scripts/migrations/028-registry-resource-bundles/backfill.ts \
  --inventory /private/path/registry-inventory.json \
  --output /private/path/registry-backfill-plan.json
```

In addition to the inventory environment, explicitly provide
`REGISTRY_ARCHIVES_BUCKET_NAME`, `REGISTRY_R2_ACCESS_KEY_ID` and
`REGISTRY_R2_SECRET_ACCESS_KEY`. `REGISTRY_R2_ENDPOINT` defaults to the source
R2 endpoint; the bucket has **no default**. Use read-only database/object
credentials while planning. The database session enforces read-only mode and
the two object clients only GET. Planning never provisions a bucket or changes
its access policy. The intended target is a private bucket, configured and
verified separately before authorizing an apply.

The planner verifies the current allowlist, pinned digests, source row identities,
original compressed bytes, target objects and immutable index metadata. It
records each presentation target HEAD's digest and PostgreSQL `xmin`. A failure
produces an incomplete diagnostic plan and a nonzero exit. Stdout reports the
SHA-256 of the **exact plan file bytes**. Plans are point-in-time observations,
not rollout approval or a global database snapshot.

## Future authorized apply

**Production execution requires separate authorization.** This command is
documented for review and isolated rehearsal, not as an instruction to run it
against production after merging this preparation PR.

```bash
node --import tsx scripts/migrations/028-registry-resource-bundles/backfill.ts \
  --apply --plan /private/path/registry-backfill-plan.json \
  --approve-plan-sha256 <reviewed-exact-file-sha256> \
  --output /private/path/registry-backfill-receipt.ndjson
```

Use a narrowly scoped database role that can SELECT source Storage rows and
SELECT/INSERT the independent archive index, plus SELECT/INSERT/UPDATE independent
HEADs. It needs no Storage write or archive UPDATE/DELETE privilege. Use a
separate target credential permitting GET and conditional PUT, without DELETE;
the source credential remains GET-only. This operator does not grant privileges.

The apply validates the reviewed digest, complete plan, current allowlist and
exact source/target scope before any write. Every row revalidates source identity
and bytes. Objects are uploaded unchanged with `If-None-Match: *`; existing
objects must validate to the same bytes. A lost PUT response or precondition race
is resolved with a single authoritative GET, never a blind PUT retry. The
clients use one attempt and bounded requests. Conflicting objects are never
overwritten, deleted or repacked.

Archive insertion is conditional on the reviewed source identity and uses the
existing `(resource_id, sha256)` key. Existing immutable metadata must match
exactly, including the original opaque `version_id`. If latest selects the
pinned bytes through a different opaque version alias, the planner rejects it:
one `(resource_id, sha256)` entry cannot preserve both response values. Resolve
that conflict separately rather than silently changing either response value.

A missing planned HEAD uses INSERT with conflict-do-nothing. An existing planned
HEAD uses UPDATE conditional on **both** its SHA and `xmin`, protecting against
another publication and SHA A-to-C-to-A changes. A deleted expected HEAD is not
recreated. Already-correct HEADs are verified without updating their timestamps.
These are independent conditional statements, without transactions, advisory
locks, row locks or coordination tables. Uncertain database writes are resolved
by authoritative reads instead of automatic mutation retries.

The output is an exclusive `0600` append-only NDJSON receipt. Each intent is
flushed before effects, followed by classified outcomes and final source/index/
HEAD reconciliation. Interrupted receipts can end without a completion event;
that is not success. Re-run the same reviewed plan into a **new receipt path**
after investigating an interruption. Correct objects/indices are reused without
rewriting them. If a source or conflicting target HEAD changed, capture/review a
fresh inventory and plan instead. Partially published immutable objects or
historical index entries remain for reconciliation; this command has no cleanup.

Legacy publishers can still advance immediately after any statement/read. No
receipt claims continuous or globally atomic freshness. Before activating a new
reader, drain old-only publishers and reconcile the **whole current allowlist**
and presentation heads again. This PR does not change a reader, publisher,
activation switch, rollout policy, or the MaskDB policy.

## Three-release rollout

1. **Prepare:** deploy the additive schema and inventory/build preparation.
   Keep old readers and writers. Verify the empty new tables, existing fixed
   download hashes, and presentation current-version behavior.
2. **Activate:** after separately reviewed original-byte publication and
   reconciliation, switch API downloads to the independent index. Prepare the
   presentation publisher to maintain both indices during this transition.
   Reconcile all fixed bindings and current heads after old publishers have
   drained. Keep IDs, auth capabilities, response shape, pinned hashes, and
   latest semantics compatible with existing CLIs.
3. **Retire:** after acceptance, API request drain and an executable rollback
   floor, stop Storage publication and remove legacy resolvers/operators. Old
   Storage/R2 object deletion is a separate audited operation.

Publication/backfill is an operational step between releases 1 and 2, not a
production data update authorized by this tool. It needs reviewed scope,
verified immutable uploads, idempotency/conflict handling and a conditional
HEAD publication protocol. No production execution is implied by this PR.

Production acceptance uses both database invariants and real downloads/logs:
all intended mappings resolve, downloaded bytes retain their hashes, new
presentation releases advance the correct independent HEAD, and old/new CLI
callers work. Deployment and CI success alone do not establish acceptance.

## Verification

```bash
# Only against a disposable local or CI migration database with migrations applied.
DATABASE_URL=postgresql://user@127.0.0.1:55439/registry_bundle_preparation \
  pnpm test:registry-resource-inventory
DATABASE_URL=postgresql://user@127.0.0.1:55439/registry_bundle_preparation \
  pnpm test:registry-resource-backfill
```

The integration test exercises the child CLI with a real database/filesystem
and a local S3 HTTP boundary. It covers latest selection, fixed hash validation,
source HEAD movement, read-only operation, same-resource head integrity and
independence from deleted Storage rows. The migration-consistency pipeline
also runs it. The archive reader has focused integrity/extraction tests, and
presentation build/verify tests cover the new publication descriptor.

The backfill suite invokes the real child commands with real PostgreSQL and an
HTTP object peer. It covers dry-run, reviewed-plan digest, unchanged archive
bytes, an accepted upload with a lost response, idempotent reruns, immutable
object/metadata conflicts, source movement, target HEAD ABA and explicit fresh
reconciliation. It never connects to production or needs private archives.
