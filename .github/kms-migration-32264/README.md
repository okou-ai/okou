# GitHub Actions KMS migration identity

The production application remains the existing `vm0-kms-prod` IAM user.
GitHub Actions uses a separate OIDC role for ciphertext rewrap. No new access
keys or static operator credentials are required.

The production backfill is complete. Follow the
[permanent retirement plan](permanent-retirement.md) for retained recovery
dependencies and isolated snapshot inspection before scheduling old-key deletion.

## One-time IAM prerequisite

An AWS administrator must provision or reconcile this exact role in account
`251964670836` through the approved IAM change process:

`arn:aws:iam::251964670836:role/vm0-kms-migration-github-32264`

- Reuse the account's `token.actions.githubusercontent.com` OIDC provider if it
  already exists. Its URL is `https://token.actions.githubusercontent.com` and
  its client ID is `sts.amazonaws.com`; create it only if absent.
- Apply [role-trust.json](role-trust.json). Trust is restricted to
  `vm0-ai/vm0` jobs in the protected `production` environment and the STS
  audience. Keep that environment's protected-branch and human-reviewer rules.
  Both migration workflow jobs also require `refs/heads/main`.
- Set the role's maximum session duration to 7,200 seconds and attach
  [role-permissions.json](role-permissions.json) as an inline policy. This
  allows decrypt and bidirectional rewrap only on the two production keys, and
  data-key generation only on the target key for nested queue payloads. Every
  operation requires `purpose=vm0-stored-secret`.
- After the role exists, the owners of the source and target accounts add the
  respective [source](source-key-policy-statement.json) and
  [target](target-key-policy-statement.json) statements to the existing key
  policies. These files are **individual additive statements**, not replacement
  policies. Preserve all current administration, runtime, and rollback grants.
- Set the GitHub `production` environment variable `KMS_MIGRATION_ROLE_ARN` to
  the role ARN above. It is configuration, not a secret.

The IAM setup identity needs role administration only for this named role,
OIDC-provider administration only if the GitHub provider is missing, and
`kms:GetKeyPolicy` / `kms:PutKeyPolicy` on the corresponding production key in
each account. These setup permissions are not granted to the migration role.
The workflows never bootstrap IAM using application credentials and never
add `ReEncrypt` to runtime users.

The currently recorded personal `AWSReservedSSO_KMSMigrationAccess` session is
not a GitHub OIDC identity. Its existence does not prove this role is ready.
Role provisioning is a prerequisite, not an operation performed by these
workflow files. Verify it live before dispatching a production migration.

## Protected execution

1. Run **KMS Production Preflight** on `main` with the current production API
   Vercel deployment ID. Approve its `production` job. It checks the exact
   current target IAM user, loads the old user only from the verified rollback
   backup, proves synthetic forward and rollback reads, and authenticates all
   stored ciphertext using the target runtime user. It creates no role and
   writes no database rows.
2. Run **KMS Production Business Verification** for that deployment, with the
   approving operator's Clerk user ID, the internal `vm0` organization ID, and
   an existing visible agent ID. Review the production environment gate before
   it starts. This requires the operator to be an admin of that organization.
   Retain both `operation.json` and `business-verification.json`: the operation,
   all five business checks, and cleanup must pass against the same deployment
   before approving historical migration. The runtime canary and database scan
   alone do not certify deployed application behavior.
3. Run **KMS Production Migrate** with that deployment ID, initially with the
   default 1,000-field limit. Each dispatch repeats the full target-runtime
   scan, then obtains a temporary operator session using GitHub OIDC. It
   verifies the exact role with STS and exercises the real migration tool's
   forward and reverse `ReEncrypt` paths on synthetic envelope and legacy
   ciphertext before changing database rows.
4. Review `operation.json`, `verification.json`, and `migration.json` in the
   run's artifact. `complete: false` is a bounded partial migration; the next
   dispatch can use its `cursor`. Conditional writes preserve concurrent user
   changes. Check `concurrentChanges` and scan from the beginning to recover
   rows changed or deleted during a prior batch. A failed or cancelled run can
   have partial writes: inspect its retained checkpoint before resuming.
5. Run **KMS Production Preflight** again without a cursor. Only a fresh,
   complete target-runtime report with `databaseVerifiedOnTarget: true` is the
   final database certificate. A successful bounded migration is not that
   certificate.

The three workflows share a concurrency group and require manual production
approval. Each dispatch uses the existing GitHub production Neon credentials,
the exact `production` branch of `hidden-lab-39609750`, an unpooled connection,
and TLS certificate verification. No agent-side Neon connection is necessary.
The backup digest is pinned in the workflow and the backup's original run/head
provenance is checked before using its configuration. Plaintext credentials,
database URIs, OIDC tokens, and data keys remain in process memory and child
environments; only sanitized metadata and checkpoints enter artifacts.

The Linux workflow passes STS input through an anonymous memory file so AWS CLI
can read its JSON more than once without consuming a pipe or persisting the OIDC
token. On an AWS CLI failure, `operation.json` retains `awsFailure` with an
allowlisted operation name, error code, and exit status. Unknown error names and
raw stdout/stderr remain suppressed; inspect this checkpoint before changing IAM
permissions or retrying the production job.

The expected deployment is checked before verification, before mutation, and
after the operation. A concurrent deployment stops successful certification;
it does not automatically undo completed rows. Keep both keys and both runtime
users' cross-account read access throughout the rollout. These workflows do
not modify deployments, restore stale database snapshots, touch shared staging,
or retire keys, users, retained sandbox state, or backup recovery access.

### Business verification scope

The business workflow first assumes the existing GitHub migration role and
checks synthetic forward/reverse `ReEncrypt` for both envelope and direct legacy
ciphertext. It then uses the existing production Clerk secret to create a
60-second sign-in ticket for the approving operator, exchanges it through the
normal Clerk Frontend API, and obtains a 15-minute session token. No existing
session is reused or revoked, and no development authentication bypass is used.

The deployed API creates a private, uniquely named workflow and an explicitly
disabled webhook automation. The verifier checks both ciphertext key ARNs and
the actual secret-reveal response. It then connects and reconnects one temporary
manual connector using synthetic values and reads only that connection's stored
ciphertext. Because connector GETs mask secrets, the verifier copies each of
these two ciphertexts into the disabled webhook fixture and checks the deployed
shared reader's exact plaintext response. It repeats that reader check for the
synthetic source-key envelope and direct legacy ciphertext. This certifies
deployed secret writes, updates, and shared decryption; it does not claim to
exercise an external connector request, a webhook delivery, or an agent run.

The only direct database mutations are four compare-and-swap updates to the
new webhook's secret field. Each write is bound to its random workflow name,
agent, organization, owner, exact automation ID, disabled state, unchanged token
and prior ciphertext, and absence of any delivery or run. The database session
is read-only outside these fixture transactions. No historical row is rewritten.

Cleanup deletes the temporary automation, thread, workflow, and connector through
the API, independently verifies their database removal, and ends only the new
Clerk login. Lost create responses are recovered by the random name and ownership
scope. Cleanup failures fail certification. A hard-killed runner can interrupt
cleanup; the sanitized checkpoint records fixture IDs and the random name for
an operator to inspect and remove through another approved Action. Do not start
historical migration until that cleanup is verified. Neither synthetic plaintext
nor credentials, session JWTs, cookies, or ciphertext enter the uploaded reports.

## Read-only exit dependency inventory

After the final database verification, run **KMS Production Exit Dependencies**
on `main` and approve its existing `production` environment gate. Supply the UTC
completion time of the accepted full database verification. This timestamp is
an operator-provided comparison point; this workflow does not validate or replace
the database certificate.

The two independent jobs reuse existing production credentials:

- Runner inventory uses the existing Cloudflare SSH transport and production
  host list. A Python program is sent over SSH stdin and only reads
  `/var/lib/vm0-runner/runners/v{version}/proxy-registry.json`, including retained
  production release directories. It does not install a program, restart a
  service, unregister a sandbox, or decrypt a secret. Only aggregate outer-key
  counts and sanitized failure metadata leave each host. PR and staging
  directories are excluded. A missing registry also collects directory-entry
  count, whether only a regular `runner.yaml` remains, exact systemd service
  properties, and a count of `runner` command lines mentioning the version.
  Config contents and process command lines never leave the host. The check
  uses `systemctl show` and `ps`; it does not invoke runner maintenance commands
  that can clean state. These observations aid review and do not convert a
  missing registry into a successful or zero-key inventory.
- Recovery inventory makes GET requests to the production Neon project's
  metadata, branch list, snapshot list and production backup schedule. It does
  not request a database connection URI or connect to PostgreSQL. It reports
  configured history-window overlap and counts every retained snapshot as
  requiring key review: snapshot creation time does not prove which historical
  LSN was captured. Snapshot evidence contains an ID fingerprint, production
  branch match, reported snapshot timestamp/LSN, creation time, expiration, and
  sanitized backup schedule. Names and raw snapshot IDs are omitted. Missing
  snapshot points and expirations remain explicitly unreported; an expiration
  in the past does not prove deletion while the snapshot is still listed.
  These fields describe recovery metadata, not successful decryption or a
  tested restore. Other branches are counted without inspecting their data.

The workflow needs no new AWS credentials, IAM roles or KMS grants. It retains
sanitized reports for 30 days. Failed SSH, unreadable or changing files, unknown
keys, malformed envelopes, metadata failures, or incomplete pagination prevent
a successful collection. A missing production registry is unresolved coverage,
not a zero count. A workflow failure during SSH setup can occur before a report
exists; do not treat that missing artifact as a successful inventory.

Successful collection is **not retirement clearance**. The reports explicitly
leave nested runner payloads, state outside these registries, actual earliest
restorable timestamps, backup ciphertext and external backups unverified. A
configured recovery window overlapping the migration is a potential recovery
dependency, not proof that a particular historical point is still restorable.
Review these results alongside the full database certificate, old-key CloudTrail
activity, source/target CloudTrail and Config delivery, historical audit-log
retention, and the agreed rollback requirements before retiring anything. This
workflow never disables keys/users, changes retention, deletes state, restores
backups, or changes a deployment.
