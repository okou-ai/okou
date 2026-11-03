# Registry resource bundle preparation

Preparation only. Production downloads and presentation publication still use
Storage. This change creates empty independent archive/head tables, exposes the
same private archive allowlist to the API and inventory operator, and adds an
original-byte archive descriptor to presentation build artifacts. It does not
publish registry objects, populate either table, move a HEAD, or enable readers.

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
there is no write mode in this preparation.

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
HEAD publication protocol. None of those write paths is activated here.

Production acceptance uses both database invariants and real downloads/logs:
all intended mappings resolve, downloaded bytes retain their hashes, new
presentation releases advance the correct independent HEAD, and old/new CLI
callers work. Deployment and CI success alone do not establish acceptance.

## Verification

```bash
# Only against a disposable local or CI migration database with migrations applied.
DATABASE_URL=postgresql://user@127.0.0.1:55439/registry_bundle_preparation \
  pnpm test:registry-resource-inventory
```

The integration test exercises the child CLI with a real database/filesystem
and a local S3 HTTP boundary. It covers latest selection, fixed hash validation,
source HEAD movement, read-only operation, same-resource head integrity and
independence from deleted Storage rows. The migration-consistency pipeline
also runs it. The archive reader has focused integrity/extraction tests, and
presentation build/verify tests cover the new publication descriptor.
