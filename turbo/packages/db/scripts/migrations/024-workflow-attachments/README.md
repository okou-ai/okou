# Custom Workflow attachment preparation

Stage 1 of [Epic #42362](https://github.com/okou-ai/okou/issues/42362).
This operator migrates supplementary files into independently owned R2 packages.
It never rewrites instruction text, deletes Storage rows/objects, activates claim
output, or starts a cleanup worker. NULL descriptors are unconverted; missing
legacy sources require investigation rather than conversion to empty.

Run from `turbo/packages/db` with Node and the locked workspace dependencies.
`DATABASE_URL=postgresql://... pnpm test:workflow-attachments` verifies the
actual CLI against disposable local PostgreSQL and a local S3 fixture. The
fixture requires a local database and keeps its credentials in a temporary
private file; it does not access production.
Set `DATABASE_URL_FILE` to a private local file containing the temporary database
URL. Supply `R2_ENDPOINT`, `R2_USER_STORAGES_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, and
`R2_SECRET_ACCESS_KEY` securely in the environment; never paste credentials into
the command, receipt, issue, or PR.

Before apply, verify Stage 1 API promotion and outgoing-request drain, exclude
older non-dual-writing rollback targets, and review every source anomaly. Keep
legacy objects and the new packages throughout Stage 2 acceptance. Stage 1 does
not delete superseded/prepared attachment packages; inventory them for the later
retirement after publication and execution retention gates have been proved.

## Dry-run and bounded apply

```bash
node --import tsx scripts/migrations/024-workflow-attachments/backfill.ts \
  --limit 100 --output /private/tmp/workflow-plan-001.json

node --import tsx scripts/migrations/024-workflow-attachments/backfill.ts \
  --migrate --writers-drained --limit 100 \
  --plan-file /private/tmp/workflow-plan-001.json \
  --expect-plan-sha256 <reviewed-plan-sha256>
```

The first command performs no provider/database writes. Review its counts and
blocked identities. An apply rereads and verifies each exact immutable source,
uploads before publication, and converts only a still-unconverted row with the
same owner, visibility, instruction hash, timestamp, HEAD, and no pending
publication. Changed rows are skipped. An uncertain write stops the batch;
retain its uploaded object and reconcile authoritative state before continuing.
The operator does not retry uncertain mutations or delete candidate objects.

Use the returned `lastWorkflowId` as `--after <uuid>` for the next dry-run batch.
Revisit skipped/blocked rows with a fresh plan; a cursor is not proof of global
completion. Output files are private, create-only, and contain only identifiers,
metadata, and hashes. Preserve plans and apply receipts for acceptance.

## Full acceptance

```bash
node --import tsx scripts/migrations/024-workflow-attachments/backfill.ts \
  --audit --limit 100
```

Repeat using `--after` through the full ordinary-Workflow inventory. Audit is
read-only: it validates descriptors and every referenced package's archive and
per-file hashes, and reports global ordinary/unconverted counts. Compare all
plan instruction hashes with the audit receipts, classifying legitimate user
edits, creation and deletion separately. Require zero unresolved candidates and
zero unconverted ordinary Workflows before activation. Do not claim a production
acceptance merely from local tests or a completed batch.

Stage 2 must additionally bind exact attachment references to the successful
claim transition and prove cleanup exclusion for pending claims and surviving
Runner work. This preparation does not activate that protocol. Later legacy
retirement needs a separately reviewed exact Storage/version/prefix inventory,
durable worker receipts, old-context/Runner exit and rollback evidence. Preserve
shared Storage, Official Workflow and Connector resources.
