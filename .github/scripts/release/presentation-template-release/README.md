# Presentation Registry publication

`publish-presentation-template-archives.mjs` builds, verifies and publishes the
configured `Template-artifact/main` presentation runbooks. Build and publish
tooling must come from the same dispatched Okou commit. The existing production
workflow serializes publications; do not resume an old-only publisher after the
independent reader has been activated.

## Transitional dual publication

The publisher retains the original archive bytes and opaque version ID at both
locations:

- Legacy: the existing Storage prefix, `archive.tar.gz` and `manifest.json`,
  `storage_versions`, and the Storage HEAD. This preserves older API readers.
- Independent: the private bucket's `registry-archives/v1/<sha256>.tar.gz`, an
  immutable `(resource_id, sha256)` archive row, and that resource's HEAD.

All objects are conditionally created with `If-None-Match: *` and read back for
verification before database publication. An uncertain PUT is resolved with one
GET, without replaying the mutation. A conflicting object or immutable metadata
is an error, never overwritten. Original packages are not repacked.

Publication uses conditional statements over the observed source identities and
PostgreSQL `xmin`, without transactions, explicit row locks or coordination
records. The independent HEAD is published last, after the matching archive and
legacy version are available. Its CAS checks both its observed digest and `xmin`
and rechecks the committed Storage identity. There is no all-template atomic
snapshot: an interruption may leave verified immutable candidates or a legacy
HEAD awaiting independent publication.

Investigate uncertain results before rerunning. Reuse the **same verified
bundle**, rather than rebuilding mutable source, to finish a partial publication.
Already-correct objects, archive metadata and HEADs are preserved. If another
writer changed a source or HEAD, stop and reconcile instead of force-updating it.
No command deletes historical objects or index rows.

## Configuration

The `build` and `verify` commands require `tar` only. `publish` additionally
requires `postgres` and `@aws-sdk/client-s3`, plus:

- `DATABASE_URL`: the reviewed production database writer.
- `R2_ACCOUNT_ID`.
- `R2_USER_STORAGES_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
- `R2_PRIVATE_ARTIFACTS_BUCKET_NAME`, `R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID`,
  `R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY`.

The private bucket must differ from the legacy bucket and remain private. The
production workflow uses the existing private-artifact secrets and the matching
bucket variable; verify that its target is `user-artifact-private-prod` before
publication. Configuration is mandatory, with no fallback to the legacy bucket.
`R2_ENDPOINT` is optional and accepts only the native account endpoint or a
loopback HTTP object fixture. SDK requests use one attempt and bounded deadlines.

The database role needs SELECT on all four tables, INSERT on `storage_versions`
and `registry_resource_archives`, and UPDATE on `storages` and
`registry_resource_heads`. It needs no archive UPDATE/DELETE privilege. Do not
create roles or grant production privileges as part of deploying this code.

## Reader cutover gate

Merging the new publisher is not proof that old-only publications drained.
Before deploying the API reader cutover:

1. Ensure subsequent publication jobs use this dual publisher; finish or cancel
   all attempts pinned to earlier tooling and do not rerun them.
2. Reconcile the whole current private archive allowlist and every current
   presentation HEAD using fresh source identities. If anything moved since the
   accepted backfill, review a fresh plan; do not silently reuse stale approval.
3. Verify immutable objects, index metadata, HEADs and private-bucket binding.
4. Deploy the API reader and accept real pinned/latest downloads and compatible
   CLI responses against the independent bucket. An index miss returns the
   normal missing-archive response; there is no silent Storage fallback.

Retiring the old writer, raising rollback floors, removing operators and physical
Storage/R2 reclamation belong to later reviewed work. This change does not
dispatch a publisher or authorize any production data update.

## Isolated checks

```bash
node --test .github/scripts/__tests__/publish-presentation-template-archives.test.mjs

# From turbo/packages/db, with a disposable local PostgreSQL database:
DATABASE_URL=postgresql://user@127.0.0.1:5432/publication_test \
  pnpm test:registry-resource-publication
```

The database integration invokes the real build/publish child commands, uses
actual PostgreSQL constraints and a loopback S3 peer, and owns its schemas,
fixture role, files and HTTP lifetime. It covers original bytes in both
locations, retained fixed archives, lost PUT responses, conflicting objects,
idempotent reruns, partial-publication recovery and competing publishers. The
migration-consistency pipeline runs this check on its isolated database.
