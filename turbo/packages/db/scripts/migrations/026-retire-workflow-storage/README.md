# Retire legacy custom Workflow Storage

One-time operator for Epic #42362, after the Workflow claim reader has cut over
to database instructions and Workflow-owned R2 attachments. Run from
`turbo/packages/db` using the repository-supported Node.js version and installed
workspace dependencies. This tool is not a production startup migration.

The default is a database-only, read-only dry-run. It never reads instruction
bodies into the process, downloads archives, or calls R2. It writes a private
review plan containing source identities, exact version directories, row
fingerprints, predetermined cleanup job IDs, and a hash-only Workflow census.
Plans bind to the bucket, R2 account endpoint and a hash of pg's effective database
host, port, decoded database name and routing options, excluding credentials. This
includes PGPORT/PGOPTIONS defaults. Host/port query overrides and repeated options
are rejected before connecting. Do not edit a reviewed plan to bypass
a protection or widen a target.

## Deployment and consumer gates

Before **either** write mode, independently verify and record in the Epic:

- The claim reader release is serving and all outgoing API instances drained.
- Every supported Runner has the claim-time Workflow document/attachment reader;
  no legacy queued work, active Run, retained sandbox producer or other old
  consumer still needs generic Workflow Storage.
- All ordinary Workflows have valid, owned attachment descriptors; no Workflow
  publication tokens remain. An empty instruction may legitimately be SQL NULL.
- Rollback versions that read or publish `custom-skill@…` Storage are excluded.
  Retaining terminal Run history is not a promise that those old archives remain
  replayable by old software.
- The reviewed dry-run is complete across every page, all blocked candidates
  have been investigated, exact targets are approved, and a recoverable database
  snapshot/backup policy has been checked.

The acknowledgement flag records this operator decision; it does not establish
these deployment facts. A terminal Run, an expired queue row, or elapsed time
alone is insufficient evidence of consumer retirement. Database checks protect
known references at planning, metadata removal and immediately before object
deletion. They cannot stop an incompatible old writer from returning later.

The former generic `storage-object-cleanup` worker was retired in #42250.
Consequently this tool owns its **own explicit, bounded local execution** of
`workflow-storage-retirement` jobs in the existing `background_jobs` table.
There is no new online worker, cron, table, migration, or automatic driver.
The online Workflow attachment worker and its
`WORKFLOW_ATTACHMENT_CLEANUP_ENABLED` switch are independent; keep that switch
in its separately reviewed state. Running this tool does not enable it.

## Credentials and outputs

Provide environment variables without putting secrets in command arguments,
shell history, plans, reports, or GitHub:

| Variable                                   | Modes            | Purpose                                                                         |
| ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------- |
| `DATABASE_URL_FILE`                        | All              | Existing private regular file containing an explicit PostgreSQL URL             |
| `R2_USER_STORAGES_BUCKET_NAME`             | All              | Reviewed legacy user Storage bucket                                             |
| `R2_ENDPOINT`                              | All              | HTTPS Cloudflare R2 account endpoint; HTTP localhost is accepted for tests only |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | `--process-jobs` | Separately authorized, bucket-scoped list/delete credentials                    |

Every connection explicitly uses UTC and the public schema, regardless of the
temporary role's defaults. Dry-run and audit set the session to read-only. Metadata retirement and
job processing require a database role with the necessary write access. Neither
dry-run nor metadata retirement requires an R2 token. Use private directories
(0700); credential and plan files must be private regular files (0600). Output
files are created exclusively at 0600 and existing files are never overwritten.
Keep plans and all receipt files outside the repository. Receipts contain
identifiers/counts/hashes and static error classifications, never raw database
or provider errors. Preserve them until final acceptance and tooling retirement.

## 1. Capture and review every page

```bash
node --import tsx scripts/migrations/026-retire-workflow-storage/cleanup.ts \
  --limit 100 --output /private/tmp/workflow-retirement/plan-001.json
```

Selection is limited to organization-owned (`user_id='__org__'`)
`custom-skill@<Workflow UUID>` and historical `custom-skill@<slug>` Storage.
Historical slugs follow the original publisher's 2–64 character lowercase
alphanumeric/hyphen contract, without leading or trailing hyphens. They are
Storage identities only, regardless of zero, one or multiple current
same-organization Workflow name matches. Only a UUID identity is checked
against a current Workflow owner; a slug is never cast to UUID.
All candidates still require the exact captured locations and reference gates.
Use the reported `nextAfter` as `--after` for the next plan until it is null.
`--storage-id UUID` scopes investigation to
one candidate. A page can contain blocked candidates: following its cursor is
not permission to ignore them. `--max-ms` bounds work (default 180,000 ms, maximum
300,000); a partially examined page retains the last **examined** cursor.

The plan captures the persisted Storage prefix, without deriving its historical
organization slug. It additionally captures only exact version directories
outside that prefix. Recognized roots end in the Storage ID or exact Storage
name; version directories end in their captured version hash. Unknown shapes
are blocked. Every R2 operation appends `/` to its captured prefix, preserving
similarly named siblings and the new `workflow-attachments/` namespace.

Plans block overlapping foreign Storage/version locations, Skills, official
definition revisions, custom connector version references, lineage, export
artifacts, claimed or current attachments, unfinished background consumers,
queued contexts, and Runs with a live execution owner. Structured consumers are
checked for captured Storage/version IDs and exact Storage names; name-only
references are scoped to the consumer's organization.
Pending or running Pi resource indexing blocks retirement, including expired
leases. Ready/unindexable indexes are derived cache entries and follow their
parent Storage version's existing cascading deletion; the operator neither
cancels indexing nor changes its leases. Review external retirement gates even
if all these checks are clear.

## 2. Remove reviewed metadata and register every exact job

After reviewing the plan bytes and their reported SHA-256:

```bash
node --import tsx scripts/migrations/026-retire-workflow-storage/cleanup.ts \
  --migrate --plan-file /private/tmp/workflow-retirement/plan-001.json \
  --expect-plan-sha256 REVIEWED_SHA256 --ack-consumer-retirement \
  --output /private/tmp/workflow-retirement/retire-001.jsonl
```

Each Storage removal is one atomic SQL statement: compare the exact identity,
Storage xmin, HEAD, and all captured version fingerprints/xmins; recheck
references; delete Storage (cascading its versions); insert every predetermined
cleanup job. Any insertion failure rolls back that whole statement. Changed or
referenced sources remain intact and are reported; refresh their dry-run after
investigation. The operator never writes Workflow instructions or attachments,
Agents, chats, Runs, Skills, official definitions, or historical SQL migrations.

After an uncertain reply, reuse the **same** plan and a new receipt path. Source
absence plus the complete, matching job inventory proves the committed metadata
step; it does not reset job progress. Source absence with missing jobs is an
error, not proof that R2 cleanup succeeded. Do not generate replacement job IDs
or edit the plan to make a missing receipt disappear.

## 3. Explicitly process a bounded group of R2 pages

```bash
node --import tsx scripts/migrations/026-retire-workflow-storage/cleanup.ts \
  --process-jobs --plan-file /private/tmp/workflow-retirement/plan-001.json \
  --expect-plan-sha256 REVIEWED_SHA256 --ack-consumer-retirement \
  --max-pages 8 --max-ms 180000 \
  --output /private/tmp/workflow-retirement/objects-001.jsonl
```

Only jobs from this plan, with matching kind, handler version, organization,
bucket, source identity and exact input can run. The operator uses the existing
60-second database lease protocol. Busy leases, failed/cancelled jobs and missing
receipts are not force-reopened. An expired running lease can be reclaimed by a
subsequent explicitly invoked call.

One page lists at most 1,000 objects and deletes only the returned bounded keys.
R2 calls have a 10-second timeout and SDK retries are disabled. After deleting a
page, the next call lists from the beginning, so deletion cannot invalidate a
continuation token. A job completes only after an explicitly empty,
non-truncated listing. Nonempty final pages still require that empty relist.

A failure stops the invocation, records a static classification and increments
failure history. It leaves the job pending when the owned lease can be saved;
there is no automatic retry. Inspect the receipt and current job before
explicitly resuming. Partial deletes and lost replies can safely be reconciled
by relisting the same exact prefix. A lost database save or expired lease needs
reconciliation first; do not start a second unbounded driver.

An invocation's wall-clock budget is checked between bounded operations; an
already started database/provider call can finish after that budget. Server SQL
execution remains capped at 10 seconds. The initial inventory observation can
contain several megabytes of Workflow hashes and attachment metadata, so only
that query has a 120-second client result-receive deadline. Other database
queries retain their 12-second client deadline. The default 180-second invocation
budget leaves time to receive the inventory and perform bounded work afterward.
The 60-second job leases and 10-second R2 call deadlines are unchanged.

## 4. Audit every original plan and global preservation

```bash
node --import tsx scripts/migrations/026-retire-workflow-storage/cleanup.ts \
  --audit --plan-file /private/tmp/workflow-retirement/plan-001.json \
  --expect-plan-sha256 REVIEWED_SHA256 \
  --output /private/tmp/workflow-retirement/audit-001.jsonl
```

Require all captured Storage/version rows absent and every exact job present,
matching and completed. Compare the hash-only Workflow census; natural user
edits, creations and deletions are reported for review, never overwritten or
automatically certified as cleanup damage. An unexplained change blocks final
acceptance. Recovered failure history remains visible even after completion.

`batch_complete` certifies only that plan. Final acceptance also requires every
plan/page accounted for and zero global legacy Storage, versions, Workflow
publication tokens, unconverted Workflows and unfinished retirement jobs.
`globalInventoryEmpty` reports the observation at `observedAt`; it is not a
transaction spanning all audit statements. Recheck global totals at the end.
Review current claim/startup runtime evidence and the externally verified
consumer/rollback gates before removing temporary credentials.

Completed jobs establish bounded R2 listing and successful deletion responses
through a final empty page. They do not establish independent third-party R2
relisting, reclaimed bytes, or fresh controlled Agent execution tests. Retain
these limits in the acceptance report. Keep Epic #42362 open until its cleanup,
runtime verification and contraction criteria are satisfied. Remove this
one-time operator and its test registration only after that acceptance.

## Exit statuses and local verification

- `0`: dry-run page ready, or the explicit batch mode completed without a
  preservation discrepancy. This does not mean every global page is finished.
- `2`: blocked/changed candidates, bounded work remaining, busy/terminal jobs,
  incomplete audit, or Workflow preservation changes requiring review.
- `1`: invalid arguments/configuration/plan, missing durable identity, database
  failure, failed provider attempt, or lost lease; inspect receipts first.

Run `pnpm test:workflow-storage-retirement` with a migrated, disposable local
`DATABASE_URL`. The suite runs the real CLI against PostgreSQL and a local HTTP
S3 fixture; it never accepts a remote production database. The migration
consistency suite also invokes it. No GitHub workflow or online runtime changes
are needed. Coverage includes historical slugs with zero/one/multiple namesakes,
current Workflow preservation, name-only consumers appearing during listing,
custom connector and version-only Skill ownership, Pi indexing lifecycle, and
slow inventory result reception through a local PostgreSQL transport fixture.
