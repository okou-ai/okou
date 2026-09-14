# Production KMS account migration (#32264)

Move stored-secret dependencies from AWS account `072707626411` to
`251964670836` in `us-west-2`. Shared staging is explicitly outside this rollout.
The disposable test-runtime PR #32646 is verification evidence and must not merge.
Reuse the existing keys and credentials; this tooling creates no credentials,
changes no deployment configuration, and disables no keys.

| Role   | Production key ARN                                                            |
| ------ | ----------------------------------------------------------------------------- |
| Source | `arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8` |
| Target | `arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947` |

## Production preflight

After production configuration has switched to the existing target user,
manually run **KMS Production Preflight** on `main` with the expected current
production API Vercel deployment ID.
It uses the existing GitHub `production` environment's protected-branch and
required-reviewer gates. PR branches cannot access that job.

The job first loads the actual old production IAM user from the independently
verified Doppler rollback snapshot, uses the current GitHub production target
credentials, and then the old user again to
verify synthetic envelope/legacy reads, target writes, rollback reads, and denial
of old-key writes, test-key access, and the wrong encryption context. STS must
identify the exact `vm0-kms-prod` user in each expected account. Only synthetic
ciphertext fixtures are written locally and they are removed at the end.
Credential verification finishes before the potentially long database scan.
This canary checks production IAM cryptography; production application business
flows still need verification after deployment.

It then resolves the exact `production` branch in Neon project
`hidden-lab-39609750`, verifies stored ciphertext with PostgreSQL read-only mode,
and uploads a sanitized inventory with seven-day retention. KMS plaintext is
used only in process memory for authentication checks and nested queue parsing;
it is never logged, written to a report, or uploaded. JavaScript strings cannot
be explicitly zeroed; plaintext byte buffers are cleared after use.

The preflight workflow has no deployment, secret-update, or database-mutation
step. After checking deployed application business flows, **KMS Production
Migrate** executes the bounded mutation through the separate production OIDC
migration role. It uses GitHub's existing Neon credentials, repeats a fresh full
target-runtime scan, and verifies synthetic operator re-encryption and rollback
before writing. It does not grant runtime users `ReEncrypt`.

See the [Actions execution and IAM prerequisite](../../../../../../.github/kms-migration-32264/README.md).
The workflows share a concurrency group. Verification always starts from the
beginning; migration accepts a checkpoint cursor and defaults to a 1,000-field
limit. After all batches, run the preflight again and require a fresh complete
`databaseVerifiedOnTarget: true` report. These post-cutover workflows must not
be used to repeat the already-completed backup step below.

## Completed pre-cutover configuration backup

The pre-cutover verification ([run 34314877468](https://github.com/vm0-ai/vm0/actions/runs/34314877468))
and configuration backup ([run 34324494642](https://github.com/vm0-ai/vm0/actions/runs/34324494642))
completed before the GitHub production secrets changed. The backup workflow
below documents that completed operation; it requires the old configuration
and refuses the now-existing destination. Do not repeat it after cutover.

For that operation, **KMS Production Backup** ran on `main` with the
then-current production API Vercel deployment ID as `expected_deployment_id`
and an approved protected GitHub `production` environment job. This backup is a
separate operation from deployment or ciphertext migration.

The job verifies the exact old production IAM user and resolves the configured
key through `GenerateDataKey`, emitting only the returned key ARN. It captures
the effective `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SECRETS_KMS_KEY_ID`,
and `AWS_REGION` from the production environment, along with the current API
deployment ID, URL, commit, and workflow provenance. The Vercel production target
must still match the supplied deployment ID immediately before backup.

The existing production-only Doppler OIDC identity writes one masked
`KMS_BACKUP_JSON` secret to `vm0-kms-rollback-32264/prd`. This isolated project
has no deployment integration. The existing `vm0` project membership remains
read-only; only the backup project's `prd` environment receives temporary
Collaborator access. After successful backup and independent verification,
downgrade that backup-project membership to Viewer. The development service
account receives no access to the backup project. No new AWS or static Doppler
credentials are created.

An existing backup blocks the job. The write also uses Doppler's conditional
new-secret operation so a concurrent writer cannot be overwritten. Both the raw
and computed read-back must exactly match the snapshot, with masked visibility.
Only sanitized metadata is uploaded to the seven-day GitHub artifact; credential
values pass directly from the protected runner to Doppler. The report includes a
SHA-256 digest of the complete snapshot for independent verification against a
later Doppler read. Provider error bodies are suppressed because they can contain
secrets. A missing success report or failed read-back is a blocker for replacing
production configuration.

The stored deployment is a rollback reference, not proof that rolling back its
code is still compatible with later schema changes. Recheck the current
deployment and release compatibility before cutover. Restore configuration from
the saved snapshot through the normal protected operational process; do not
paste credential values into issues or chat. Retain the backup and old KMS access
until the agreed rollback and recovery windows end.

## CLI modes

Run from `turbo/packages/db` with a direct, unpooled `DATABASE_URL` set in the execution environment.
Neon pooler endpoints are rejected so session read-only and timeout settings
remain attached to the same database connection.
Do not put database passwords or AWS secret keys in command-line arguments.

```bash
SOURCE_KMS_ARN=arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8
TARGET_KMS_ARN=arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947

# Default: metadata inventory, no KMS calls and no database writes.
pnpm exec tsx scripts/migrations/013-kms-account-rotation/backfill.ts \
  --source-key "$SOURCE_KMS_ARN" --target-key "$TARGET_KMS_ARN" \
  --max-rows 100000 --report-path ./inventory.json

# Read-only verification: authenticate every envelope and inspect inner queue ciphertext.
pnpm exec tsx scripts/migrations/013-kms-account-rotation/backfill.ts \
  --source-key "$SOURCE_KMS_ARN" --target-key "$TARGET_KMS_ARN" \
  --verify --verify-concurrency 8 --max-rows 1000000 --report-path ./verified.json

# Explicit mutation, using a complete, fresh verification report (at most 24 hours old).
pnpm exec tsx scripts/migrations/013-kms-account-rotation/backfill.ts \
  --source-key "$SOURCE_KMS_ARN" --target-key "$TARGET_KMS_ARN" \
  --migrate --preflight ./verified.json --max-rows 1000 \
  --report-path ./migration.json
```

Default batch size is 100, maximum 500; default run limit is 5,000 field values.
Verification allows up to 1,000,000 values; inventory and migration retain the
100,000-value limit. `--verify-concurrency` runs 1–16 rows concurrently (default
1); the production preflight uses 8. This option is rejected outside verification
mode, and migration writes remain serial. Each bounded group finishes before its
results are recorded in primary-key order. On failure, the checkpoint advances
only through the successful prefix; later completed rows are verified again on
resume. A report's `cursor` resumes after its last completed value:
pass `--cursor '<cursor>'` with the same database, mode, keys, and manifest.
Migration resumes also require the verified preflight. Reports checkpoint each
page and before reporting a handled failure. An abrupt process kill can require
revisiting the last page; target envelopes are skipped, and conditional writes
make replay safe. A cursor is scoped to a hash of the database endpoint, database
name, and role, not to credentials. Changing between pooled/direct endpoints
requires a fresh scan.

`complete: false` is a bounded partial scan. A resumed scan is never a final
verification certificate; run a fresh full `--verify` after migration. Reports
contain field names, counts, known source/target ARNs and opaque cursor IDs only.
Provider and SQL error messages are suppressed because they may include data.
Failure reports also include `failureDetails` with a fixed stage and an
allowlisted error code. Connection failures retain an incomplete checkpoint;
provider messages, SQL text, and plaintext are never recorded. The snapshot
inspection wrapper retains validated marker records before target verification,
then records the child exit/timeout and only bound aggregate report fields on
failure. It exposes cursor presence, never the cursor value. Partial counts and
a failed child report do not establish cryptographic recovery or retirement
clearance.

An unknown key, invalid envelope, unsupported schema, or KMS failure prevents
successful migration/verification. No automatic retry overwrites a changed row.

## Storage coverage and transformations

`fields.ts` inventories 23 current fields across 18 tables, plus two optional
historical Custom connector fields if those tables still exist. It covers
connector and model credentials, OAuth/device state, Slack/GitHub/Telegram/Feishu
tokens, webhook secrets, SSH keys, browser URL snapshots, and both run queues.
It validates physical column types and primary keys and rejects untracked
`encrypted_*` columns before scanning.

- Envelope format: KMS `ReEncrypt` changes only `kms.keyId` and
  `kms.encryptedDataKey`; AES ciphertext, IV and authentication tag stay intact.
- Legacy direct KMS format: re-encrypt `kms.ciphertext` with the same purpose.
- `runner_job_queue.execution_context.encryptedSecrets`: update only that JSON
  leaf, comparing its original value so unrelated concurrent JSON changes survive.
- `agent_run_queue.encrypted_params`: decrypt the outer envelope in memory and
  inspect `__api_runner_job_payload__` → `executionContext.encryptedSecrets`.
  Rewrap the inner envelope too, then encrypt the changed outer payload using a
  **fresh data key and IV**. A target outer key does not prove the inner key moved.

All KMS calls use encryption context `purpose=vm0-stored-secret`. Key ARNs are
checked against KMS response IDs. Known bare source/target UUIDs are resolved to
their explicit ARNs and canonicalized during migration; aliases and other keys
require investigation. Verification reports `nonArn` references because the
production application passes stored KeyIds directly to KMS: cross-account
reads require a full ARN. If any bare references exist, migrate them before
switching production credentials. Operator-side canonicalized verification alone
does not prove the new application's raw-KeyId read path works.

KMS operations finish before the short conditional SQL update. The update matches
both primary key and original ciphertext and leaves lifecycle timestamps alone.
`concurrentChanges` means the row changed or disappeared; re-scan from the start
to catch any skipped old-key value. Multi-field rows are updated field by field;
dual-key read access must remain enabled for partial batches and rollback.

## Cutover and rollback sequence

1. Review a complete read-only production report and successful actual-runtime
   canary. Resolve unknown/malformed ciphertext and non-ARN references. The
   credentials and keys already exist; do not create replacements.
2. Complete **KMS Production Backup**, verify its Doppler read-back and sanitized
   report, and downgrade its temporary backup-project access to Viewer. This
   preserves the old effective credentials, KMS configuration, and current
   immutable production API deployment before replacing anything. GitHub cannot
   read back existing secret values; metadata alone is not a rollback backup.
3. Update those three **GitHub `production` environment secrets** to the existing
   target values. `AWS_REGION` remains `us-west-2`. The normal protected API
   release lifecycle consumes them through `.github/actions/web-api-env`.
   Changing the isolated Doppler config alone has no production effect.
4. Verify production secret create/read/update flows and legacy reads using the
   deployed API. Then rewrap old ciphertext in bounded batches using the migration
   operator and perform a fresh full `--verify` with the target runtime credentials.
   `databaseVerifiedOnTarget: true` requires a complete non-resumed scan with no
   source/inner-source, unknown, invalid, or non-ARN references.
5. For rollback, first restore the saved configuration and approved deployment
   through the normal release/rollback gates. Old runtime access can read target
   ciphertext. If ciphertext must also move back, run fresh `--verify` then
   `--migrate` with source/target ARNs reversed. This rewraps **current values**;
   it never restores stale database snapshots over user updates.

This tool verifies the live database only. Running sandboxes retain encrypted
secrets in the runner's on-disk proxy registry (`crates/runner/src/proxy/registry.rs`)
and may continue sending those ciphertexts to the API. Wait for old runs to drain
and inspect old-key use before removing access. Database backups, snapshots and
retained runner state may also require the old key for recovery. Agree the quiet,
rollback and backup-restoration windows before disabling principals or scheduling
key deletion. CloudTrail, AWS Config and historical audit-log retention remain
separate acceptance items in #32264.

## Validation

`pnpm test:kms-rotation` uses a new isolated local PostgreSQL database and an HTTP
KMS fixture. It exercises the real CLI, SQL, filesystem and AWS SDK boundary:
read-only inventory, nested verification, bounded checkpoints, concurrent writes,
KMS failure recovery, preservation of AES ciphertext, reverse migration that keeps
updated values, and malformed-envelope rejection. The existing PR migration
consistency job runs it. Production scans and canaries require the separate
protected manual workflow; local fixtures do not count as production evidence.
