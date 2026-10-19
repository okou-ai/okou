# Link wallet retirement inventory

Run the **Audit Link Wallet Retirement** workflow on `main`. It uses the existing
production environment and Neon connection, independently of release. The job
installs its PostgreSQL driver explicitly and connects directly with PostgreSQL's
read-only startup setting and the installed system CA bundle for `verify-full`.
One fixed aggregate `SELECT` uses one implicit
statement transaction; there is no explicit transaction, migration, credential
decryption, token refresh, or provider revocation.

For an authorized local database, install Python 3 and `psycopg[binary]==3.2.13`,
supply `DATABASE_URL` through the environment, and invoke the script by path:

```bash
python3 ops/link-wallet-retirement-40206/audit.py /existing/directory/new-report.json
```

The output path must not already exist. Exit zero publishes the complete JSON
report atomically; a query or validation failure exits nonzero without a report.
Counts are decimal strings to preserve PostgreSQL bigint precision. Neither the
report nor stdout contains owner IDs, authorization IDs, tokens, verifier values,
or requested-scope contents. The workflow adds the checked-out operator commit
and retains the aggregate report for 30 days.

`activeMissingRequestedScopes` includes temporarily credential-less connections:
a refresh in flight can still restore their credentials. `liveLegacy` and
`liveMissingRequestedScopes` count only pending/exchanging attempts that have not
expired; terminal and expired attempts cannot publish another grant.
`completedLegacy` separately records the historical connect-status reader surface.
Nonzero `unexpectedScope` or `unexpectedStatus` requires investigation.

This report is a point-in-time data inventory, not permission to remove consent
or compatibility. Before cleanup, record serving API identity, outgoing-request
drain and supported rollback writer evidence in #40206. Active legacy grants
must be explicitly reauthorized or revoked; never invent consent snapshots.
Retire this operator and its workflow after the cleanup is accepted.
