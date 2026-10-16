# Link wallet grant migration

Issue #40206 retires the pre-#40198 encrypted credential shape. Production
releases retain the compatible reader until this independent migration has
completed and its convergence evidence has been accepted.

Run the **Migrate Link Wallet Grants** GitHub Actions workflow on `main`.
It is manual-only and defaults to `apply: false`: inventory without writes or
Link refresh/revocation. Inspect that report before dispatching `apply: true`.
Both modes use the production environment and retain aggregate evidence.

The workflow invokes `ops/link-wallet-grants-40206/migrate.sh`, which verifies
that the serving API contains #40198, loads the resolved production API
environment, and runs `turbo/apps/api/src/scripts/migrate-link-wallet-grants.ts`.
The shell adapter needs Bash, curl, jq, git and pnpm; it does not need GitHub CLI.
The rollback resolver continues to reject APIs preceding the metadata writer.
The workflow serializes its own runs and rejects a changed serving deployment
in its final acceptance check. It does not participate in the release queue.

For local operator use, from `turbo/apps/api` with the target API environment
loaded, the TypeScript command also defaults to a dry run:

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
initial inventory before changes. Any failure fails this workflow without
blocking unrelated releases. A full final scan must find zero retained legacy
credentials. A rerun skips completed work.

Reports contain aggregate counts only. Do not print decrypted credentials,
provider bodies, database errors, or environment files. Record the workflow run
URL, operator commit, serving identity and convergence report in the owning PR
before declaring production migration complete. A dry-run report is inventory,
not proof that migration was applied. If serving changed, recheck against the
new artifact before accepting convergence.

After production acceptance and verification that old writers/rollback targets
cannot recreate legacy credentials, require `scope` and `readOnly` in a separate
cleanup PR. Remove the compatible payment inference, metadata-only refresh and
legacy consent marker together with this one-time operator, its dedicated tests
and dispatch workflow. Keep the rollback floor and the current response contract.
