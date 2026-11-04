# Presentation Registry publication

`publish-presentation-template-archives.mjs` builds, verifies and publishes the
configured `Template-artifact/main` presentation runbooks. Build and publish
tooling must come from the same dispatched Okou commit. The production workflow
serializes publications; never rerun a publisher pinned to retired tooling.

## Independent publication

Publication writes only the private bucket's
`registry-archives/v1/<sha256>.tar.gz`, immutable `(resource_id, sha256)` archive
metadata, and that resource's independent HEAD. It does not read or write legacy
Storage tables, prefixes or manifests. Existing historical rows and objects stay
available to their remaining owners.

Archives are conditionally created with `If-None-Match: *` and read back before
any database publication. The returned bytes must exactly match the verified
bundle. A missing PUT response is resolved with one GET, without replaying the
mutation. Conflicting objects or immutable metadata fail instead of being
replaced. Original packages are not repacked.

The independent HEAD is published last using its observed digest and PostgreSQL
`xmin`. This rejects concurrent changes even when a competing writer restores
the original digest. Publication uses conditional statements, without
transactions, explicit row locks or coordination records. There is no
all-template atomic snapshot: an interruption can leave verified immutable
candidates or some resources already published.

Investigate uncertain results before rerunning. Reuse the **same verified
bundle**, rather than rebuilding mutable source, to finish a partial publication.
Already-correct objects, archive metadata and HEAD timestamps are preserved. A
changed HEAD is a conflict, not permission to undo another writer's publication.
No command deletes historical objects or index rows.

The configured `storageId` values remain only as fixed hash namespaces for the
existing opaque version-ID algorithm and verified bundle format. They do not
resolve a Storage entity or bind archive lifetime to a Storage row.

## Reader and rollback gate

The first independent-only publication requires all of these checks:

1. Verify both production API domains serve the independently indexed reader
   from #45172 or a descendant. Record the verified traffic cutover and the
   outgoing artifact's request limit; allow its full five-minute request drain
   before retiring the old writer. A merge or a version tag alone is insufficient.
2. Ensure the current main-owned `registry-archive-reader` rollback floor is
   active. The supported rollback resolver rejects APIs before that reader,
   before provider or host access. The floor is the reader's merged main commit,
   not a branch-only SHA or the later publisher-retirement commit.
3. Read every page of active `publish-presentation-template-archives.yml` runs
   (`queued`, `in_progress`, `pending`, `waiting`, `requested`). Drain attempts
   pinned to the old-only or dual publisher before first publication. Do not
   approve or rerun those attempts after retirement. Workflow concurrency does
   not make a later rerun of old tooling safe.
4. Recheck the accepted independent archive/HEAD coverage and any movement since
   reader acceptance. Reconcile unexplained divergence before publication; do
   not rerun the historical Storage backfill against independently advanced HEADs.

The publication job fetches full main history and verifies both serving API
commits against the main-owned floor before retrieving the database URL. This
fresh compatibility check does not replace the recorded request/publisher drain.
It also requires the approved `user-artifact-private-prod` bucket. Deployment,
first production publication and its acceptance remain separately authorized
operations; merging this code does not dispatch a publisher.

## Configuration

The `build` and `verify` commands require `tar` only. `publish` additionally
requires `postgres` and `@aws-sdk/client-s3`, plus:

- `DATABASE_URL`: the reviewed production database writer.
- `R2_ACCOUNT_ID`.
- `R2_PRIVATE_ARTIFACTS_BUCKET_NAME`, `R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID`,
  `R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY`.

The target bucket must remain private. No legacy-bucket credentials are required
or passed by the production job. `R2_ENDPOINT` is optional and accepts only the
native account endpoint or a loopback HTTP object fixture. SDK requests use one
attempt and bounded deadlines.

The database role needs SELECT on `registry_resource_archives` and
`registry_resource_heads`, INSERT on the former, and UPDATE on the latter. It
needs no legacy-table privileges or archive UPDATE/DELETE privilege. Do not
create roles, revoke shared privileges or grant production privileges as part of
deploying this code.

## Isolated checks

```bash
node --test .github/scripts/__tests__/publish-presentation-template-archives.test.mjs
bash .github/scripts/tests/verify-registry-publisher-cutover-test.sh
bash .github/scripts/tests/resolve-production-rollback-target-test.sh

# From turbo/packages/db, with a disposable local PostgreSQL database:
DATABASE_URL=postgresql://user@127.0.0.1:5432/publication_test \
  pnpm test:registry-resource-publication
```

The publication integration invokes the real build/publish child commands using
PostgreSQL constraints and a loopback S3 peer. The publisher has only the new
index privileges and private-bucket credentials. Coverage includes original
bytes, retained archives, lost PUT responses, immutable-object conflicts,
idempotent reruns, partial-publication recovery and competing publishers,
including a changed-and-restored HEAD. It owns its schemas, fixture roles, files
and HTTP lifetime. The migration-consistency pipeline runs this check on its
isolated database.

Physical Storage/R2 reclamation remains later work. In particular, retain old
objects for outstanding signed URLs (currently 48 hours) and account separately
for other Storage consumers before deleting anything.
