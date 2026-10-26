# Custom Workflow attachment preparation

Stage 1 of [Epic #42362](https://github.com/okou-ai/okou/issues/42362).
This operator migrates supplementary files into independently owned R2 packages.
It never rewrites instruction text, deletes Storage rows/objects, activates claim
output, or starts a cleanup worker. NULL descriptors are unconverted; missing
legacy sources require investigation rather than conversion to empty.

Run from `turbo/packages/db` with Node and the locked workspace dependencies.
`DATABASE_URL=postgresql://... pnpm test:workflow-attachments` verifies the
actual CLI against disposable local PostgreSQL and a local S3 fixture. The
fixture requires a local database (or the migration suite's owned PostgreSQL
service database) and keeps credentials in a temporary private file. The same
CLI regression runs inside `test:migration-consistency` against its disposable
replayed database; it does not access production.
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

The first command performs no provider/database writes. It scans all ordinary
Workflows, including non-NULL descriptors: an outgoing old API may have changed
the legacy package after a new API populated that descriptor. It compares the
current legacy files with the descriptor, verifies matching new packages, and
plans conversion or reconciliation only when needed. Review its counts and
blocked identities; `alreadyCurrent` means the files and package were verified.
The private plan captures instruction-hash baselines for the whole page.
Legacy normalized/duplicate paths follow the published encoder's canonical
filesystem; differing duplicate archive bytes remain an anomaly.

Plans now use `schemaVersion: 2` and capture the exact manifest checksum and
source evidence. Regenerate and review every plan with this operator version;
version 1 plans cannot be applied. A manifest change after review stops apply,
even if its archive and effective attachment files are unchanged.

Some retained manifests carry an obsolete `version` label. A differing label is
accepted only when the manifest's complete raw file list, hashed with the owned
Storage ID by the published content-hash algorithm, equals the captured HEAD.
The archive and every supplementary file still undergo the same integrity
checks. `legacyManifestLabels` reports verified rows using this compatibility;
the migration never rewrites their legacy manifests. This path is limited to
this one-time operator and retires with the legacy sources under Epic #42362.

An apply rereads and verifies each exact immutable source, uploads before
publication, and updates only a row with the same captured descriptor, owner,
visibility, instruction hash, timestamp, HEAD, and no pending publication.
Changed rows are skipped. An uncertain write stops the batch;
retain its uploaded object and reconcile authoritative state before continuing.
The operator does not retry uncertain mutations or delete candidate objects.

Use the returned `lastWorkflowId` as `--after <uuid>` for the next dry-run batch.
Revisit skipped/blocked rows with a fresh plan; a cursor is not proof of global
completion. Output files are private, create-only, and contain only identifiers,
metadata, and hashes. Preserve plans and apply receipts for acceptance.

## Reviewed unpublished empty sources

An existing Storage container with no HEAD and no versions remains blocked by
default. If a bounded read-only investigation finds an exact orphan archive
containing `SKILL.md` and no supplementary files, an operator can supply an
explicit private review file:

```json
{
  "schemaVersion": 1,
  "sources": [
    {
      "workflowId": "<reviewed-workflow-uuid>",
      "storageId": "<reviewed-storage-uuid>",
      "archiveKey": "<exact-storage-prefix>/<64-character-version>/archive.tar.gz",
      "archiveSha256": "<reviewed-archive-sha256>"
    }
  ]
}
```

```bash
node --import tsx scripts/migrations/024-workflow-attachments/backfill.ts \
  --reviewed-empty-sources /private/tmp/workflow-empty-sources.json \
  --limit 100 --output /private/tmp/workflow-reviewed-plan.json
```

The Workflow and Storage identities must match. The exact archive must be inside
the current database-owned prefix, and a single non-truncated listing (at most
two keys) must contain that archive alone. The archive checksum must match the
review, `SKILL.md` must exist, and supplementary files must be absent. Missing
archives, additional objects, existing versions and pending publications remain
blocked; an unavailable source is never inferred empty. `reviewedEmptySources`
counts verified explicit reviews, including already-current descriptors.

Apply uses only the checksummed version 2 plan, without the review-file flag. It
rereads the same archive and prefix and rechecks the source evidence. Publication
requires the same container, prefix, Storage timestamp, absent HEAD, zero
versions, unchanged Workflow fields and no pending publication in the final
conditional update. A changed source is skipped; no Storage/version rows or
legacy objects are repaired, created or deleted. Empty conversion uploads no
new package. Keep the private review file for the full legacy parity audit:

```bash
node --import tsx scripts/migrations/024-workflow-attachments/backfill.ts \
  --audit --reviewed-empty-sources /private/tmp/workflow-empty-sources.json \
  --limit 100
```

This explicit recovery path retires with this operator under Epic #42362.

## Full acceptance

```bash
node --import tsx scripts/migrations/024-workflow-attachments/backfill.ts \
  --audit --limit 100
```

Repeat using `--after` through the full ordinary-Workflow inventory. Audit is
read-only: it compares every descriptor with its current legacy HEAD, verifies
every referenced package's archive and per-file hashes, and reports global
ordinary/unconverted counts. A valid package with stale files fails acceptance.
Run it after all apply commands finish; every page must pass parity checks.
This parity audit belongs to Stage 1 while legacy publication is active; it is
not the post-activation audit once Stage 2 starts new-only writes. Compare all
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
