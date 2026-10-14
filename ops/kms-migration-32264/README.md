# Production KMS operational tools

Owner: the AWS migration operation in
[#32264](https://github.com/okou-ai/okou/issues/32264), assigned to `hulh122`.
This directory owns the retained backup and exit-inventory commands and their
inert tests. Shared script standards remain in
[GitHub scripts](../../docs/github-scripts.md); policies and permanent records
remain authoritative under
[`.github/kms-migration-32264`](../../.github/kms-migration-32264/).

## Protected entry points

Use the existing workflows through separately approved manual dispatches on
`main` and their protected `production` environment. They invoke the commands
below from the checked-out repository root. The commands retain exact
repository/workflow identities and fixed resource targets, and require GitHub
run metadata and `RUNNER_TEMP`. Do not fabricate workflow metadata or substitute
other accounts, keys, projects or identities for a local operation.

| Command                                | Supported workflow and prerequisites                                                                                                                                                                                          | Effects and outputs                                                                                                                                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kms-production-backup.py`             | [KMS Production Backup](../../.github/workflows/kms-production-backup.yml); Python 3, `curl`, AWS CLI, approved source runtime credentials/region/key, Vercel token, exact Doppler OIDC identity and `expected_deployment_id` | Verifies the source principal/key and serving deployment, exercises source-key `GenerateDataKey`, creates the original masked Doppler escrow once and verifies readback. Sanitized `RUNNER_TEMP/kms-production-backup.json` is retained for 7 days.      |
| `kms-production-exit-check.py backups` | [KMS Production Exit Dependencies](../../.github/workflows/kms-production-exit-check.yml); Python 3, `curl`, existing Neon project/API key and `migration_verified_at` from the accepted full database verification           | GET-only recovery metadata, branches, snapshots and backup schedule; no database connection URI or PostgreSQL access. Sanitized `RUNNER_TEMP/kms-exit-backups.json` is retained for 30 days.                                                             |
| `kms-production-exit-check.py runners` | The same exit workflow; Python 3, SSH, existing production host list/user and Cloudflare SSH transport. Hosts need the existing non-interactive sudo, Python 3, `systemctl` and `ps`.                                         | Sends its own source over SSH stdin and runs `runner-local /var/lib/vm0-runner/runners`. Reads registries and service/process evidence without installing code or changing state. Sanitized `RUNNER_TEMP/kms-exit-runners.json` is retained for 30 days. |

The backup's fixed scope is source account `072707626411`, region `us-west-2`,
IAM user `vm0-kms-prod`, source key
`a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8`, and Doppler
`vm0-kms-rollback-32264/prd/KMS_BACKUP_JSON`. It accepts only the original source
key forms and source credentials. Availability of this historical tool does
not authorize replacing the existing escrow or using it against target-era
production configuration. It changes neither deployments nor their effective
configuration. The secret snapshot stays in Doppler; credentials, tokens and
data keys must not enter logs or artifacts.

Exit inventory compares the same source key with target account `251964670836`
key `e68917e2-5541-4597-b6ef-7e9eb5670947`, both in `us-west-2`, and limits recovery
metadata to Neon project `hidden-lab-39609750`. The operator-provided migration
timestamp is a comparison point, not a replacement database certificate.
`runner-local <registry-root>` is the read-only child interface used over SSH;
the workflow owns the approved production host/root selection.

## Evidence and retirement

Exit 0 means the backup passed readback or the requested inventory was collected;
nonzero status means failed/incomplete evidence. Exit-inventory reports and the
optional GitHub step summary remain sanitized, with `retirementCleared: false`.
Missing/unreadable/changing registries, partial host responses, malformed data
and incomplete pagination must not become zero-dependency claims. A reported
expiration date does not prove that a still-listed recovery point disappeared.
Collection does not authenticate nested ciphertext or establish full recovery.

Review an uncertain backup response/readback before any replay: a secret write
may already have happened, and the existing/concurrent original must not be
overwritten. Inspect failed or cancelled exit jobs and missing reports as
incomplete collection. No command here disables/deletes a key, restores or
deletes a backup, changes retention, or changes a deployment or runner.

Use the [permanent retirement record](../../.github/kms-migration-32264/permanent-retirement.md)
and [protected retirement operation](../../.github/kms-migration-32264/source-retirement.md)
for independent recovery, rollback and authorization requirements. Source
ownership changes and old receipts do not establish current operational
completion. Retire a retained command only after its owner confirms there is no
supported backup/recovery/dependency-review caller; remove its workflow and test
adapter together while preserving policies, original backups and permanent
evidence. Record decisions and new receipts in the owning issue or PR.

## Inert verification

From the repository root:

```bash
bash .github/scripts/tests/kms-production-backup-test.sh
bash .github/scripts/tests/kms-production-exit-check-test.sh
```

The CI adapters run the owner-local Python suites and propagate their status.
Tests use real temporary files and the actual CLI with isolated external
`aws`/`curl`/SSH/service fixtures, including
`tests/fixtures/kms-production-backup-tools.py`. They make no live provider calls.
The adapters keep their existing workflow-script shard registrations.
