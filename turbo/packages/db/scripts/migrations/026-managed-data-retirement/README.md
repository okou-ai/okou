# Retire archived managed Data jobs

This one-time operator archives the four retired managed Data job tables, proves
a lossless restore, then deletes only reviewed, unchanged rows. The separate
schema migration retains its empty-table protection. Default mode is read-only.
The operator never calls providers, recreates jobs, modifies usage/balances,
marks uncertain jobs completed, charges users, refunds or compensates them.

The approved disposition is limited to the reviewed one Data Search `unknown`
job (16 reserved credits, unconfirmed actual cost) and nine SocialKit
`link_failed` jobs (105 charged credits). The platform absorbs unconfirmed
provider cost; the original charges remain, with no compensation. The archive
retains original statuses, costs, errors, ownership and provider identities. The
business disposition is separate from those original facts. Additional uncertain
jobs or different financial amounts stop retirement. Complete the requested
analysis of the nine original `link_failed` errors before production deletion;
this operator is not evidence of their root cause.

## Prerequisites

- Independently deploy `b220a504c5e633de162791f1216c4458188ffe72` or a descendant,
  record actual API traffic cutover, and wait the enforced 300-second request
  limit. Exclude older rollback artifacts. Stop old writers and schema changes
  before archiving; the archive must postdate the drain deadline.
- Rehearse on a fresh production clone. Preparing this operator or testing a
  clone does not authorize production deletion. Revalidate live inventory just
  before a separately authorized execution.
- Use compatible `pg_dump` / `pg_restore` binaries; `PG_BIN` can select their
  directory. Run from `turbo/packages/db` with locked workspace dependencies.
- Set `DATABASE_URL_FILE` to a private file containing the source URI. Archive
  files contain private requests and provider references: never publish them in
  PRs, CI artifacts or chat. Credentials travel to PostgreSQL tools through a
  clean libpq environment, never command arguments or output. Target identity
  includes the port. The supported URI parameters are `sslmode` and
  `channel_binding`; their exact values pass to libpq for every query, dump and
  restore. In particular, `channel_binding=require` fails before SQL if the
  server cannot authenticate with channel binding. Other parameters and duplicate
  settings are rejected. Queries use `psql` with no startup file and SQL through
  stdin; private values never enter command arguments.

## Inventory and archive

```bash
node --import tsx scripts/migrations/026-managed-data-retirement/retire.ts
node --import tsx scripts/migrations/026-managed-data-retirement/retire.ts \
  --archive /private/managed-data-retirement
```

The explicit archive command creates a mode-0700 directory with mode-0600 files:
`jobs.dump` (custom-format PostgreSQL schema and data) and `archive.json` (source
identity, schema/dependency inventory, original lossless row text, timestamp and
dump SHA-256). Row JSON stays text, preserving integers beyond JavaScript's safe
range. Before/after inventories must match; the restore also verifies the dump's
snapshot. More than 5,000 rows in any table stops the command. Partial archives
are not accepted and are not automatically retried or deleted.

## Verify recovery and retain a private durable copy

Provision a distinct disposable database with all four job tables absent.
Required external dependencies, such as the referenced `agent_runs` records,
must already exist. `RESTORE_DATABASE_URL_FILE` contains its private URI. The
operator refuses source identity or any existing target job table. It recreates
the definitions and data from the verified `jobs.dump`, then compares every
original row field exactly. Physical column-number gaps and equivalent
PostgreSQL expression formatting need not survive reconstruction. The archive
retains the original raw schema fingerprint, which must still match the source
exactly before retirement.

```bash
node --import tsx scripts/migrations/026-managed-data-retirement/retire.ts \
  --verify-restore /private/managed-data-retirement \
  --expect-restore-host localhost:5432 --expect-restore-database retirement_restore
```

Success writes `restore-receipt.json`, bound to both archive digests. A failure
may leave partial disposable-target definitions or data: inspect it and provision
another fresh target before a deliberate retry. The same full dump recreates
the retired definitions after physical DROP; retain its external dependencies.

Copy the complete archive directory to restricted durable storage outside the
workspace and temporary clone. Read/download that retained copy, verify both
SHA-256 digests, and record its private location and verification time below.
The operator checks those recorded hashes; it does not contact the archive store
or certify its durability/access policy. This is an explicit human/operator
attestation. Keep the archive under the organization's retention policy; this
operator does not expire it.

## Reviewed disposition and separate execution

Create a private approval file with the exact reviewed IDs and evidence:

```json
{
  "archiveSha256": "<sha256 of archive.json>",
  "retainedArchiveUri": "<restricted durable location>",
  "retainedArchiveSha256": "<sha256 checked from retained archive.json>",
  "retainedDumpSha256": "<sha256 checked from retained jobs.dump>",
  "retainedCopyVerifiedAt": "<UTC timestamp>",
  "productionCommit": "<full deployed Git commit>",
  "cutoverAt": "<verified production traffic cutover UTC timestamp>",
  "productionProofUrl": "<production promotion evidence URL>",
  "platformAbsorbsUnconfirmedCost": true,
  "additionalUserCharge": 0,
  "refundOrCompensation": 0,
  "unknownJobId": "<the reviewed unknown UUID>",
  "linkFailedJobIds": ["<the nine reviewed link_failed UUIDs>"]
}
```

Match IDs to the approved inventory; do not silently add newly found uncertain
jobs. The script checks archive/restore hashes, source identity, preparation
ancestry, drain timing, exact accepted amounts/states, unchanged rows, and
unsettled legacy usage. Incoming foreign keys, noninternal triggers, rules and
inheritance/partitions block DELETE before any job removal.

```bash
node --import tsx scripts/migrations/026-managed-data-retirement/retire.ts \
  --archive /private/managed-data-retirement --migrate \
  --approval-file /private/managed-data-retirement-approval.json \
  --expect-host '<reviewed hostname>:5432' --expect-database neondb
```

A private, fsynced intent precedes the DELETE. One SQL statement checks the full
inventory and includes exact original-row equality in every DELETE. It never
deletes an unarchived or changed row. Writer/schema drain remains essential:
concurrent updates can reduce DELETE counts and concurrent inserts can survive
its snapshot. Either condition fails and records observed or uncertain outcome;
unchanged archived rows might already have been deleted. There is no automatic
retry or all-or-nothing guarantee against active writers. The verified archive
already retains every removed row.

The final receipt records actual deletion counts and the business disposition.
An existing intent blocks a new deletion attempt. For a matching intent and
four empty tables, a deliberate rerun is read-only in SQL and can write an
empty-state reconciliation receipt when the final receipt was lost; it does not
invent historical deletion counts. Inspect any unknown/partial outcome before
rerunning. Copy operational intent/outcome receipts to the retained private
archive too. After physical DROP, retire this operator rather than rerunning it.

Run the normal migration sequence on a fresh production clone, verify preserved
usage/rollup/balance/grant fingerprints, then perform separately authorized
production retirement and migration. Ordinary PR CI never executes this against
production.

## Acceptance

```bash
PG_BIN=/usr/lib/postgresql/18/bin \
  node --import tsx scripts/migrations/026-managed-data-retirement/test-retire.ts
```

`DATABASE_URL` must address a disposable local PostgreSQL administrator database.
The native test creates/drops uniquely named source and restore databases and
uses the real CLI and PostgreSQL tools. It covers lossless large integers and
private fields, quoted/backslash/Unicode values, required-channel-binding refusal,
full schema/data restore with dropped-column history, existing-target refusal,
stale-row and incoming-CASCADE refusal, no
compensation, unchanged financial data, idempotent replay and missing-receipt
reconciliation. It also runs in migration consistency CI. Retire this directory
and its CI invocation after production acceptance; preserve immutable schema
migration history and the private operational archive.
