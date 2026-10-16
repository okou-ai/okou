# Link wallet grant migration

Issue #40206 retires the pre-#40198 encrypted credential shape. The release
migrates retained credentials before deploying the strict credential reader.

The API release runs `.github/scripts/release/migrate-link-wallet-grants.sh`
after SQL migrations and before API promotion. It verifies that the serving API
contains #40198, uses the resolved production API environment, and invokes
`turbo/apps/api/src/scripts/migrate-link-wallet-grants.ts`. The rollback resolver
rejects APIs preceding that writer. The existing status enum and historical CLI
artifacts are preserved.

The operator defaults to a dry run. From `turbo/apps/api`, with the normal API
environment loaded, run:

```sh
pnpm exec tsx src/scripts/migrate-link-wallet-grants.ts
pnpm exec tsx src/scripts/migrate-link-wallet-grants.ts --migrate --report /tmp/link-wallet-grants.json
```

It scans all retained encrypted credentials in UUID batches of 100, including
historical agent-scoped and revoked connections. Existing complete credentials
are untouched. Legacy active grants use Link's one-time refresh lifecycle and
persist the actual returned scopes/actions with the historical payment-consent
marker. Revoked legacy grants finish revocation. Ownership, authorization IDs,
requested-scope snapshots and purchase history are never migrated or broadened.

A conditional update consumes each old refresh token before the remote effect.
Disconnect or reauthorization cannot be overwritten. A provider error or process
interruption after consumption can require that wallet to reconnect; never
restore or replay the consumed token. Incomplete/malformed metadata fails the
initial inventory before changes. Any failure blocks promotion. A full final
scan must find zero retained legacy credentials. A rerun skips completed work.

Reports contain aggregate counts only. Do not print decrypted credentials,
provider bodies, database errors, or environment files. The release retains the
report as a GitHub Actions artifact. Record its run URL and result in the owning
PR before declaring production migration complete. Remove this one-time operator,
its tests and release step after production acceptance; keep the rollback floor.
