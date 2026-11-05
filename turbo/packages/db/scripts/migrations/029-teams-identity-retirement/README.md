# Teams identity retirement preflight

Run from `turbo/packages/db` with an authorized read-only `DATABASE_URL`:

```sh
pnpm exec tsx scripts/migrations/029-teams-identity-retirement/preflight.ts
```

The protected production entry point is the **Read production Teams ownership
readiness** GitHub workflow. Dispatch it on `main`; its production environment
gate controls execution. It resolves the same fixed production database as the
release workflow and keeps credentials inside CI. Its direct connection retains
the read-only session setting without relying on transaction-pool state. It has
no database, SQL or branch-selection inputs. Only aggregate counts, the database query timestamp
and the verified read-only transaction setting are retained as an artifact.

The command sets the connection to read-only with a five-second statement limit.
It exits 1 when a connection still has no explicit organization owner. It does
not assign ownership, disconnect accounts or perform a migration. A zero unowned
count establishes only the row prerequisite for the NOT NULL constraint. Missing
AAD identities are reported separately; they do not gain execution authority.

Before merging the final retirement, record the API preparation and v2 CLI
release artifacts, outgoing API cutover and request limit, the exit of every
supported v1 caller and old Runner/Guest owner, the App compatibility floor,
and compatible API/Runner rollback artifacts in #43729. Re-run this row check
against the intended database after those writer/drain gates pass. Resolve any
unowned rows through verified owner connection or an explicitly authorized
disconnection; never infer ownership from the bot installation.

The generated contraction rejects remaining null owners transactionally. Keep
the cleanup PR in draft until production evidence covers these prerequisites.
Retire this one-time preflight and its workflow after the final contraction's
production acceptance; keep the shipped migration and permanent invariant tests.
