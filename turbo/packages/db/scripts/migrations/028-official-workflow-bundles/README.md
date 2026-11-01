# Prepare Official Workflow execution bundles

This preparation operator publishes `SKILL.md` and declared supplementary files
for every retained, supported immutable definition revision, including retired
definitions. It does not activate the v4 catalog writer, rewrite historical
payloads/provenance, change installations or schedules, or delete any object.

Deploy the preparation API/schema first, record its actual serving identity,
drain outgoing API requests and exclude incompatible rollback writers before
apply. Production apply requires separate authorization. Rehearse on an isolated
database first. Configure `DATABASE_URL_FILE` (or local `DATABASE_URL`),
`R2_USER_STORAGES_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and
`R2_ACCOUNT_ID` or `R2_ENDPOINT`. Credentials must read retained Storage archives
and read/write the private `bundles/v1/` prefix, which must not expire.

From `turbo/packages/db`:

```sh
node --import tsx scripts/migrations/028-official-workflow-bundles/backfill.ts --limit 50 --output /private/official-plan.json
sha256sum /private/official-plan.json
node --import tsx scripts/migrations/028-official-workflow-bundles/backfill.ts --migrate --writers-drained --limit 50 --plan-file /private/official-plan.json --expect-plan-sha256 <reviewed-sha256> --output /private/official-apply.json
```

Continue dry-run pages using `--after <nextAfter>` from the summary. Apply each
reviewed page without a cursor. Reconcile from the beginning after all pages;
new supported rows may have appeared during the live scan. The operator verifies
current accepted-catalog references exist and scans all v2/v3 revision owners,
not just current definitions or installations. Unsupported v1 rows stay intact.

Dry-run performs GETs and local verification only. For legacy rows it checks the
registered Storage version and exact archive files against the pinned revision,
including its historical definition JSON when present. The new package excludes
only that system-owned JSON. Existing shadow references must match reconstructed
bytes and pass a full GET/digest check; conflicting descriptors fail explicitly.
Apply binds the reviewed plan to the database address, bucket, R2 endpoint,
source identity and digest, then uploads and GET-verifies bytes before a
conditional descriptor-only write. Concurrent publication/deletion is never
overwritten. Replan `source-changed` or `source-missing` results. Lost responses
require re-reading/replanning; never delete a shared object as compensation.

Use fresh output paths: receipts are reserved privately before mutation and
flushed after each row, including an explicit failed-or-uncertain status if an
operation fails. They
contain only identities, source fingerprints, hashes and sizes/counts. Do not
publish source instructions, attachment bytes, credentials or signed URLs.

`DATABASE_URL=<disposable-local-db> pnpm test:official-workflow-bundles` exercises
the actual operator against PostgreSQL and a loopback S3 peer. It is not a
production backfill receipt.
