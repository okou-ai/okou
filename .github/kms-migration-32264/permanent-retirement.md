# Permanent production KMS retirement

The requested end state is permanent deletion of the old **production** key:
`arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8`.
Its replacement is
`arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947`.
On September 15 the owner authorized deletion after current target-only production
verification, accepting loss of historical old-key recovery. Follow the
[protected retirement operation](source-retirement.md); this supersedes the
historical retention gates below. Preserve original backups. This plan does not
retire staging, the old account, historical audit logs, CloudTrail, or AWS Config.

## Accepted evidence as of September 14, 2026 (UTC)

These are dated, collected results. Refresh time-sensitive evidence at the
retirement decision; do not repeat completed backfill or business flows solely
to refresh this document.

- [Full production verification 34449151278](https://github.com/vm0-ai/vm0/actions/runs/34449151278)
  completed at `2026-09-10T07:38:23.484Z`: 77,331 verified target fields, with no
  source or nested source references. The production backfill is complete.
- [Target audit 34556455859, attempt 2](https://github.com/vm0-ai/vm0/actions/runs/34556455859/attempts/2)
  verified actual CloudTrail and Config delivery into the new S3 buckets.
  Preserve both accounts' audit services and historical logs.
- [Source audit 34813865003](https://github.com/vm0-ai/vm0/actions/runs/34813865003)
  successfully exercised the granted `cloudtrail:LookupEvents` permission as
  `arn:aws:iam::072707626411:user/vm0-kms-prod`. Complete full-ARN and key-ID queries
  covered `2026-09-10T07:38:23.484Z` through
  `2026-09-14T06:17:54.228959Z`: 19 read-only management events, zero cryptographic
  operations, unclassified operations or reported errors. None matched the
  retained source runtime credential. The 15-minute visibility buffer does not
  exclude late arrivals. Permission is no longer a blocker; refresh the whole
  historical interval at retirement using [source-audit mode](source-audit.md),
  which creates no old-key canary.
- [Runner inventory 34811428216](https://github.com/vm0-ai/vm0/actions/runs/34811428216)
  read all 18 production registries across three hosts: 36 target outer headers,
  zero source, unknown, invalid, unreadable or concurrently changed entries.
  This supersedes the older missing-registry result. It does not authenticate
  nested contents or cover state outside those registries.
- [Manual snapshot inspection 34801916529](https://github.com/vm0-ai/vm0/actions/runs/34801916529)
  restored the February 16 snapshot in isolation: one database, 35 tables and
  36,569 rows; zero envelope markers, literal source references, binary values,
  foreign tables and large objects. Original state and preview cleanup passed.
  This predates the stored-secret KMS writer introduced in
  [PR 13693](https://github.com/vm0-ai/vm0/pull/13693); no KMS call was made.
- [September 11 snapshot marker inspection 34836589200](https://github.com/vm0-ai/vm0/actions/runs/34836589200)
  completed all 215 tables in one database: 6,974,074 rows, 77,410 rows containing
  an envelope substring, 20 rows containing the literal source UUID, and 10,220
  binary values. Foreign tables and large objects were absent. Cleanup and
  original-state preservation passed. This is complete marker evidence, not
  target-only decryption or retirement clearance.
- [September 11 target-only recovery 34866103749](https://github.com/vm0-ai/vm0/actions/runs/34866103749)
  completed at `2026-09-14T17:01:17.802586Z`. All 77,416 fields in the reviewed
  historical manifest decrypted successfully with a session restricted to the
  target key. Source, nested source, uninspected nested, invalid and unknown-key
  counts were zero, with no database updates. Complete marker records exactly
  matched run 34836589200. The 77,416 encrypted-field count differs from the
  77,410 marker-containing-row count above. Original state was preserved, and
  the temporary preview was removed from both live and deleted-branch listings.
  The collected report SHA-256 is
  `7b31c67db66180478aeddd2dec3524a0f45d156b44498d084021ef1d9e8adb8f`.

This completes the September 11 known-field and nested-queue recovery check.
Reuse that evidence; another preparatory PR merge is not a reason to repeat the
full scan and decryption. The independent remaining coverage below still applies.

## Remaining recovery coverage

The September 14 [backup inventory](https://github.com/vm0-ai/vm0/actions/runs/34811428216)
contains the manual snapshot, 11 previously identified daily snapshots and three
new daily snapshots. The August 29–31 snapshots have actually disappeared from
the paginated inventory; the remaining original hashes still need disposition.
The September 11 snapshot's reported expiration is `2026-09-25T00:00:14Z`.
Verify actual disappearance by the original hash, or accept independently
verified target-only recovery; a configured date is not expiration evidence.
Classify new daily snapshots by their data and writers rather than repeatedly
extending a wait because a new snapshot exists.

The finite retention follow-up is scheduled for `2026-09-25T00:20:00Z`
(08:20 Asia/Shanghai). Preserve the original recovery points until then and
reconcile their actual presence by the recorded hashes. Actual expiration can
discharge a historical point's remaining classification work once no retained
copy needs that point. This appointment does not schedule KMS deletion or clear
other retained branches, live state or PITR coverage.

All 15 listed snapshots lack reported data timestamps/LSNs. The configured
24-hour PITR window and its calculated start do not establish the earliest
actually restorable point. Six other retained branches have reported parent
points after the migration verification time; their lineage has been collected,
but their ciphertext has not been verified. Do not delete branches or original
recovery points to manufacture a zero count. Resolve concrete external backup
locations found in the operational inventory before claiming coverage.

The September 11 marker result leaves these specific classification gaps:

| Observed state                | Required evidence                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 20 literal source-UUID rows   | Exact catalog/field locations and reader semantics; literal text is not a decoded key reference.                 |
| 10,220 binary values          | Actual catalog identities, formats and decoded contents; repository schema names alone do not prove the mapping. |
| Later and current SSH storage | Actual schema coverage for every retained encrypted field, including `ssh_credentials.encrypted_password`.       |

The snapshot's accepted historical manifest lists `ssh_connection_credentials`.
[PR 34135](https://github.com/vm0-ai/vm0/pull/34135) adds an explicit, read-only
`--verify --recovery-schema` option covering either that table or the later
`ssh_credentials` table, including its different primary key and password field.
At least one SSH table must exist; every present table must pass column and key
validation. The original migration manifest remains unchanged. The recovery
workflow now selects this option explicitly. This prepares later/current checks;
local tests and the merged PR do not establish their actual data coverage.

Registry reader semantics also bound the remaining work: the API encrypts the
runtime string map once, the runner copies that envelope unchanged, and the API
decrypts it once before using its string values. These inspected readers do not
recursively KMS-decrypt individual map values. Bind the deployed readers and
refresh registry evidence at retirement; do not infer recursive dependencies
solely from the inventory's `outerHeadersOnly` flag. Backing database credential
refresh and concrete state outside the registries require their own coverage.

## Current production target-only verification

To refresh current production ciphertext, dispatch **KMS Production Preflight**
from `main` with `operation=verify-target` and the current production API
`expected_deployment_id`, then use the protected `production` environment.
This mode selects the read-only `--verify --recovery-schema` CLI and the same
restricted target-only KMS session used for snapshot verification. It does not
read the source credential backup or run source/rollback canaries. The original
`operation=verify` retains migration canaries and is unsuitable for this check.

The controller pins the production project, uniquely resolves its production
database, and requires an unchanged database connection and API deployment
before accepting the completed report. The recovery manifest covers historical
and current SSH storage, including encrypted passwords. All fields must verify
on the target key with zero source, unknown, uninspected, or updated values.
Provider credentials and database contents stay out of the retained aggregate
`target-verification.json`; a failed child retains sanitized diagnostics.

This refresh checks current production state. It does not restore snapshots,
verify other branches or PITR, change data or deployment configuration, or grant
retirement clearance. Keep the independent retained-recovery gates below.

## Isolated snapshot inspection

Run **KMS Recovery Snapshot Inspect** from `main` through the protected
`production` environment. Select the exact snapshot ID SHA-256 and creation
timestamp from a reviewed **KMS Production Exit Dependencies** artifact. The
defaults identify the manual snapshot created `2026-02-16T05:57:00Z`:
`02762df9fab6d6f04a398d5ff4e1afd10bf5fa0a6e270855fff4e7df2bbcbe37`.

The workflow pins the project and uniquely resolves production. It records the
production branch/endpoint identities and snapshot metadata, then restores one
snapshot to a new deterministic preview with `finalize_restore: false`.
It never calls the finalize endpoint. Existing inspection previews block a new
run, including after an uncertain request.

The new branch must have the exact snapshot provenance and must not be an
existing, default, or protected branch. Snapshot restore may return a primary
compute and read replicas. The workflow selects the unique `read_write` primary
and records endpoint type counts; multiple primaries and duplicate identities
are rejected. If no primary exists, one 0.25-CU preview primary is created with
60-second idle suspend. Connection discovery pins the branch, endpoint and type;
production endpoints and pooled connections are rejected. Database transactions
remain read-only regardless of the compute type.

The workflow reads every database returned for the preview in PostgreSQL
read-only, repeatable-read transactions. It scans physical user tables, partition
leaves, and materialized views for `vm0secret:` and the old key UUID. Only counts
and operational identifiers leave the database. Foreign tables, large objects,
and binary fields are reported as coverage limitations. Provider and SQL errors
never export their bodies.

Table marker scans use contiguous ranges of at most 128 heap pages per query
on PostgreSQL 14 or newer. All table locks and range measurements belong to one
read-only, repeatable-read transaction, preventing rewrites or truncation while
the scan runs. Inherited tables are counted separately with `ONLY`, including
partition leaves. The decoder requires the declared table count and complete,
nonoverlapping range coverage before accepting aggregates; unsupported table
access methods and missing or repeated chunks fail the check. The 120-second
statement timeout, total inspection budget and cleanup reserve are unchanged.

Finally, it deletes only the newly created and revalidated preview, checks that
it is no longer live, and separately inspects its provider recovery window.
A deleted but recoverable copy still belongs in the retirement inventory.
Production branch/endpoint identities and the original snapshot set are read
back; cleanup or preservation uncertainty makes the run incomplete. Cancellation
or an uncertain provider response can leave a preview: inspect the deterministic
name before cleanup, and never blindly retry a restore.

This operation creates a temporary recovery copy and compute. It does not write
production data, modify existing snapshots, change credentials or deployments,
finalize a restore, or schedule key deletion. The default marker-only mode does
not call KMS. `collectionComplete` only means the declared scan completed.
The marker-only scan does not authenticate ciphertext,
inspect plaintext nested inside encryption, decode arbitrary opaque formats, or
prove application-level recovery. `retirementCleared` is always false.

For a retained target-era snapshot, enable `verify_target_ciphertext`. The same
preview isolation and cleanup checks run, followed by the existing migration
CLI's **read-only `--verify`** mode against each preview database. Its reviewed
storage manifest and queue payload decoder check the listed stored fields and
nested queue ciphertext. This mode does not run old-key canaries, `--migrate`, or production
verification.

The workflow assumes the existing GitHub migration role through OIDC with an
inline session policy: allow only target-key `kms:Decrypt` with the stored-secret
encryption context, explicitly deny KMS on every other key, and explicitly deny
all other actions except caller-identity lookup. This does not modify the role,
key grants, static credentials, or deployments. Source-key ciphertext cannot be
silently decrypted using the role's broader migration grants; encountering it
makes the verification fail. Such an attempted decrypt can still appear as a
denied inspection request in CloudTrail and must be attributed accordingly.

Success requires a complete, unresumed report bound to the preview connection,
nonzero ciphertext count, every row verified on target, zero source/nested source,
invalid/unknown/uninspected values, and zero database updates. Only aggregate
verification counters and manifest hashes are retained. If a verifier fails,
cleanup still runs and no cryptographic success is claimed. `kmsCallsMade: null`
means a started verification failed before its call count could be established.
Both modes have a 90-minute inspection budget and separately reserved cleanup
time. Each database marker scan is capped at 60 minutes or the remaining overall
budget, whichever is smaller. A full first-database scan therefore leaves up to
30 minutes for target verification; no phase extends the overall deadline.

When a database scan fails, `databaseScanFailure` retains the PostgreSQL
SQLSTATE when available, the process exit code, planned and completed table
counts, completed chunk count, the last completed chunk, and the last returned
table or binary-column progress record. For table chunks it also retains the
starting and exclusive ending block. A separate `lastStartedBatch` record names
the dispatched batch's relation OID, block range and server timestamp. Results
inside a batch can be buffered, so `lastStartedScan` alone is not the current
query or an exact failure location.
If the bounded `psql` process deadline expires, the failure is
`snapshot_database_scan_process_timeout`. The report keeps that deadline and
validated progress from complete output lines; a truncated final JSON or UTF-8
fragment is discarded. The process exit code remains unknown, and partial
output is never accepted as completed coverage. `lastDatabaseStage` is saved
before connection metadata, marker scanning and target verification so failures
in those phases can be distinguished even when no database result is returned.
These diagnostics contain no table contents, SQL text, database names or raw
error messages. Partial scan progress is not a complete inventory or evidence
of zero dependencies. Inspect the failure and verify preview cleanup before
dispatching another isolated check; do not increase timeouts or repeat restores
without diagnosing the actual cause.

The September 14 runs 34816611497 and 34824009475 exhausted the former cumulative
900-second limit with identical last-returned progress, including after batching.
That evidence establishes a process-budget failure, not a measured CPU, storage
or network cause. The 60-minute scan budget accommodates the retained database
within the existing maximum inspection window; it is not a throughput guarantee.

The marker scan sends at most 64 of its 128-page chunks in one database request.
Each chunk still has its own 120-second statement limit, progress record and
aggregate result. The decoder requires every chunk in order under the same
read-only repeatable-read transaction. One separate request reports each batch
before its chunk statements, and `stdbuf -oL` flushes the client's aggregate
output to its capture pipe. This keeps useful progress visible when the next
batch is still running. Batching does not turn an incomplete scan into a success;
the statement, overall inspection and independent cleanup limits remain enforced.

The provider contract is documented in
[Neon's snapshot restore API](https://neon.com/docs/reference/api/snapshots/restore-snapshot).
Run `bash .github/scripts/tests/kms-recovery-snapshot-inspect-test.sh` for the
external-boundary CLI scenarios and real isolated PostgreSQL aggregate tests.

## Resolve recovery paths before scheduling deletion

1. Complete target-only recovery verification of the retained target-era
   snapshot and resolve the literal-reference and binary-format gaps above.
   Bind each accepted result to its snapshot hash, creation time, run attempt,
   inspected code and actual schema. A green marker-only job, a partial report,
   or absent counters does not satisfy this gate. The February manual inspection
   is already collected; do not restore it again without new evidence of a gap.
2. Preserve daily backups through their retention, and verify actual expiration
   or independently verified replacement recovery for every original point that
   could require the source key. Refresh snapshot, PITR, live-branch and
   recoverable-deleted-branch coverage. Branch lineage and snapshot creation
   dates alone do not certify ciphertext. Preserve required recovery points.
3. At the retirement decision, refresh the relevant production fields and runner
   state under the actual writer/schema inventory. Refresh the whole source
   CloudTrail interval using `operation=source-audit`, including late and newer
   events. Classify cryptographic and unclassified calls without introducing
   old-key canaries. A previously passed audit is not indefinite clearance.
4. Code rollback must retain the current target KMS configuration. The immutable
   pre-cutover Doppler snapshot remains historical evidence; it must not be
   restored as an executable configuration rollback after source-key retirement.
   Keep credentials, deployments, original backups and both accounts' audit
   services unchanged by the retirement operation.
5. Once these dependency and recovery gates pass, prepare a separately reviewed
   operation for `ScheduleKeyDeletion` on the exact old production ARN above.
   Verify account, key identity and current state, choose an AWS-supported
   7–30 day waiting period, and record the returned `DeletionDate`. Reconcile an
   existing pending/deleted state or uncertain response before any new request.
   Scheduling immediately makes the key unusable; it is not physical deletion.
   During the waiting period, cancellation and re-enabling are separate steps;
   retain the recovery procedure and observe relevant production failures before
   the irreversible deadline. Verify actual deletion after the returned date.

No old-key mutation or deletion date has been established by the evidence above.
Do not substitute `DisableKey`, a successful metadata job, configured expiration,
or an empty denied query for these dependency checks. Production-key retirement
alone does not close the broader account-migration issue.

The exit inventory includes metadata for every branch returned by the existing
paginated project listing: hashed IDs and names, parent relationships, creation
time, and any reported parent timestamp or LSN. It identifies the exact
`kms-recovery-32264-<run>-<attempt>` inspection naming pattern without exporting
other branch names. A recent creation time does not prove a recent data point;
missing parent timestamps remain unknown. `otherBranchesNotInspected` and each
branch's `ciphertextVerified: false` remain explicit until separate data
verification resolves those dependencies. This collection adds no API requests,
database connections, resource mutations or retirement clearance.
