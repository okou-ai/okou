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
no database, SQL or branch-selection inputs. Only aggregate row/dependency
counts, the database query timestamp and verified read-only transaction setting
are retained as an artifact. The fixed catalog census permits the legacy
column's own generation expression and its known installation foreign key;
unexpected column dependencies or a missing expected foreign key reject readiness.
Run this census before production contraction, and require
`legacyDependencyReady: true`. The accepted bounded disconnection allows a
nonzero owner count before deployment; after deployment both readiness flags
must be true.

The command sets the connection to read-only with a five-second statement limit.
It exits 1 when a connection still has no explicit organization owner or catalog
dependencies are not ready. It does
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

The owner explicitly accepted a breaking cutover for at most seven remaining
unowned connections in #45198. The custom disconnection migration captures at
most eight candidates and refuses before deleting anything when more than
seven remain. It also reads the live incoming-foreign-key catalog and requires
the single declared reply-route cascade, refusing unexpected references before
any deletion. It deletes only captured rows that still have no organization
owner; their reply routes cascade, while chat history, Teams contexts and bot
installations remain. The next generated migration contracts the schema.
These are separate migration transactions: a later contraction failure does
not restore the already accepted disconnections. Reconnection establishes a new
explicit owner; an API rollback does not restore removed bindings or routes.

`test-disconnection.ts` runs through the actual migration runner from the native
migration consistency suite. It verifies atomic refusal with eight candidates,
unexpected-reference refusal before deletion, then seven removals,
byte-stable owned-account data/routes, preserved threads,
events, contexts and installation, and journal advancement only on success.
The existing permanent validator covers the contracted schema and prepared
reader/writer projection. Fresh empty replay also exercises zero removals.
Keep the cleanup PR in draft until source verification and the remaining
production preparation, caller-exit and rollback evidence are complete.
Retire this one-time preflight, transition acceptance, its consistency-suite call
and dispatch workflow after final production acceptance; keep the shipped SQL
and permanent schema invariant tests.
