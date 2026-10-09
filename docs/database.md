# Database Development Guide

This guide owns the shared database policy: concurrency, atomic SQL,
transactions, external effects, recovery, and transaction lint. It describes
engineering constraints, not a claim of source or production retirement completion.

## Select the Matching Guidance

- For schema changes, follow [migration workflows](../.claude/skills/database-development/references/migrations.md)
  and [DB migrations](../turbo/packages/db/MIGRATIONS.md). Use Drizzle to generate
  metadata; do not hand-edit journals or snapshots. Numbered external-data
  migration scripts are permanent history, self-contained and dry-run by default.
- For selections, decoding, or SQL rewrites, read [query contracts](../.claude/skills/database-development/references/query-contracts.md).
  TypeScript generics do not decode PostgreSQL results. Preserve nullability,
  precision, provenance, bindings, returned outcomes, and material query cost.
- For reactive reads, commands, and graph ownership, read [API ccstate](api-ccstate.md).
- For persisted shapes, deployment order, and old/new consumers, read
  [deployment compatibility](deployment-compatibility.md).

## Concurrency and Coordination

Do not introduce PostgreSQL advisory locks. No advisory acquisitions may remain
in executable application code, retained operators, executable fixtures, or
functions in the final database schema. Historical SQL is not a live acquisition
merely because its text remains in the repository; preserve shipped migrations.
PostgreSQL's implicit row/index locks and statement atomicity remain normal SQL
behavior.

An advisory key is a second coordination protocol that every writer must know
and acquire in the same order. Broad keys serialize unrelated work, occupy
connections while waiting, and make deadlocks harder to reason about. Provider
I/O under a lock ties database contention to network latency.

Do not replace advisory locks with new coordination tables, persisted fields,
coordination state hidden in JSON, business triggers, explicit row locks, retry
loops, `NOWAIT`, `lock_timeout`, a generic mutex, or a claim/lease framework.
An earlier KEEP classification is not a permanent exemption; the proposed
subscription-table exception was withdrawn. No application-defined business
triggers may remain in the final schema; express transitions in the owning SQL.
Indexes or constraints over existing fields are allowed when the actual business
contract requires them. For narrowly scoped outgoing-schema trigger
compatibility, follow the
[trigger policy](eslint/no-database-trigger.md).

Enforce each invariant at the smallest sufficient boundary: an existing business
key, constraint, atomic statement, or necessary billing transaction. If a design
cannot meet these constraints, record its specific unresolved gap rather than
adding hidden coordination state or weakening correctness.

## Choose the Smallest Atomic Operation

| Required behavior                             | Preferred approach                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| One row for an existing identity              | Existing primary/unique key and the intended `INSERT ... ON CONFLICT` outcome.                                |
| Increment or decrement                        | Atomic arithmetic, plus existing business deduplication where required.                                       |
| Conditional transition                        | `UPDATE ... WHERE ... RETURNING` over actual state or identity.                                               |
| Reject stale publication                      | An existing state/identity predicate when the accepted contract requires it.                                  |
| Several financial writes must commit together | One statement where reasonable; otherwise a necessary short billing transaction owned by one command.         |
| Independent resource preparation              | Separate preparation from publication; allow duplicate candidates when accepted.                              |
| Cleanup after unsuccessful publication        | Resolve uncertain commit state and clean only the attempt's exact unreferenced identities.                    |
| Avoid duplicate financial provider effects    | Existing stable operation identity and provider idempotency, with required recovery outside SQL transactions. |

These choices do not authorize new coordination tables, fields, JSON state,
triggers, mutexes, leases, explicit row locks, or retry machinery to replace an
advisory lock. Follow this concurrency policy rather than mechanically substituting
`FOR UPDATE`, `NOWAIT`, or a longer timeout.

## Atomic SQL Examples

Use the repository's Drizzle APIs and bound parameters. The tables below are
illustrative, not proposed schema additions.

### Deduplicate on the Existing Business Key

```sql
INSERT INTO webhook_receipts (org_id, provider, event_id)
VALUES ($1, $2, $3)
ON CONFLICT (org_id, provider, event_id) DO NOTHING
RETURNING id;
```

The existing unique key must express the actual tenant-scoped identity. A
returned row identifies the accepted insert; an empty result follows the
specified duplicate outcome. A preceding existence check is not arbitration.
Handle only the intended conflict, not unrelated constraint failures.

When a financial receipt and amount change must be atomic, do not consume the
identity independently of its business write. Use one atomic statement or the
necessary local billing transaction permitted by the API rules.

### Update from the Stored Value

```sql
UPDATE counters
SET value = value + $2
WHERE id = $1
RETURNING value;
```

Atomic arithmetic prevents lost updates, but does not deduplicate repeated
requests. Preserve the operation's existing business identity when needed.

### Let the State Transition Select the Winner

```sql
UPDATE jobs
SET state = 'claimed'
WHERE org_id = $1 AND id = $2 AND state = 'queued'
RETURNING id;
```

Only a returned row owns the transition. Preserve authorization and ownership
predicates, dependent-write consistency, and existing recovery. Changing a
status is not proof that a worker will finish. Do not add a new coordination
claim framework merely to remove a lock.

## Transaction Boundaries

Do not introduce new explicit database transactions except for necessary
billing-related atomicity. The exception is limited to operations that directly
protect financial correctness, such as charges, refunds, credit or balance
accounting, and usage settlement. All new non-billing transactions are
prohibited, even for short multi-statement writes, consistent read snapshots,
or transaction-local settings.

This rule covers ORM and driver transactions, handwritten SQL transaction
boundaries, and new execution paths through transaction-opening helpers.
Aliases, wrappers, or nested transactions do not create an exemption. Existing
non-billing transactions are cleanup work, not patterns to copy or extend into
new operations.

Billing is not a blanket exemption. Document the financial invariant and why a
simpler atomic SQL operation cannot reasonably preserve it. A billing filename,
Stripe integration, or paid-entitlement check alone does not justify a
transaction. Do not include unrelated application writes in a billing
transaction.

A single SQL statement is already atomic. Remove its transaction wrapper, even
for billing. Remove read-only transactions unless a demonstrated necessary
billing snapshot or transaction-local setting requires them. Prefer conditional
writes, upserts, business-key uniqueness, atomic arithmetic, and gated CTEs over
read-then-write in application code. Preserve authorization, idempotency,
returned outcomes, snapshot and clock boundaries, and material query cost;
fewer transaction call sites alone do not prove correctness.

When a billing invariant requires multiple statements to commit together and
one statement cannot reasonably preserve it, keep a short, lightweight
transaction inside one owning command. A necessary billing snapshot or
transaction-local setting must meet the same documented necessity requirement.
Use `tx` only in that transaction callback and write its database statements
inline. Never pass it to a helper or sub-command, capture it in a returned
closure, or store it. Do not run external I/O such as fetch, Stripe, KMS, S3, or
Ably inside the transaction: prepare before it and publish after it. Do not
split one atomic business operation into independently committing sub-commands
merely to remove a transaction or `tx` parameters; use a transaction-free design
that preserves its required guarantees instead.

Shared transaction logic becomes pure builders that return values, conditions,
or SQL fragments, never functions that execute queries. Document the financial
invariant, billing snapshot, or billing transaction-local setting that requires
each remaining billing transaction. Follow
[query contracts](../.claude/skills/database-development/references/query-contracts.md)
for SQL rewrites; do not add locks, retries, or timeouts to compensate for a
changed transaction boundary.

The target ownership shape is one ccstate command obtaining `set(writeDb$)`,
opening and awaiting its necessary local transaction, and executing SQL directly
in that callback. Reads obtain `get(db$)` inside their owning node. Outside the
external database adapter, keep handles local: do not pass `db` or `tx` through
helpers, services, argument objects, injected contexts, callbacks, state, or
escaping closures. Exchange ordinary inputs and committed results between
commands; pure calculations and SQL builders accept ordinary values.

The September 30, 2026 Release 1 acceptance scope excluded remaining handle
propagation and command-ownership migration. That historical scope does not
exempt new work from the current ownership rules or permit transaction-held
external I/O; track remaining handle cleanup separately.

## External Effects and Recovery

A database transaction cannot roll back a remote effect. A lost response or
failed local commit after remote success is an uncertainty window, not permission
to retain a lock or blindly repeat a payment. Reuse stable operation identities
and provider idempotency where available, and preserve the recovery required by
the accepted product contract.

A timeout does not prove that publication lost. Re-read authoritative state
before deleting an uncertain candidate. Cleanup must target only its exact
unreferenced IDs and object prefix, never another candidate adopted by name.

Do not introduce duplicate financial effects, stale credential publication,
permission resurrection, or a generic compensation framework as a prerequisite
for retirement. A final database CAS cannot undo a remote request that already
took effect.

### Accepted Recovery Contracts

These retained product contracts come from the September 29–30, 2026
decisions. They are not new behavior introduced by this guide, nor permission
to weaken financial correctness, authorization, or resource identity.

- **Nonfinancial operations:** transient concurrent-operation failures can be
  recovered by another save, reconnect, or scheduled task. Do not retain
  old-version acquisitions, new revision/generation CAS, savepoint arbitration,
  or ordering solely to serialize settings, connector selection, watches,
  queues, or preference scheduling. Preserve authorization and natural
  primary/foreign-key/unique constraints. This does not relax payments, refunds,
  amounts, or credits. Direct nonfinancial lock removal has no additional
  serving/in-flight/rollback gate solely for that lock; independent schema and
  trigger transitions retain their actual compatibility requirements.
- **Google Forms:** recovery may skip the outage interval and establish a fresh
  latest-response baseline. Normal delivery and recovery to a working watch
  remain required; gap-free continuity and exhaustive replay do not.
- **Gmail:** disabling stops local consumption immediately; unused remote
  watches may expire without a mailbox-wide stop. Other enabled consumers must
  remain functional. The September 30 decision accepts a finite rolling gap
  from an outgoing `users.stop`; do not add forced renewal or compensation
  solely for that overlap, or reintroduce mailbox-wide stop in new code.
- **Google Calendar and Meet:** preparation and renewal happen outside SQL.
  Publication preserves authorized source identity; remote cleanup is best
  effort, and replacement/repair may miss notifications. Do not preserve
  pending/previous resources solely for gap-free handover or perfect teardown.
- **Rotating refresh tokens:** a rare cross-instance duplicate refresh may
  require reconnection. This does not authorize publishing another account's
  credentials or treating revoked authority as current.
- **Watch integrations:** retain current account/source authority, explicit
  enabled state, basic deduplication, and rejection of delayed preparation
  that would revive revoked authority or a disabled automation.
- **Usage display:** settlement is the amount authority. Display and realtime
  refresh hints may lag or repeat; lost or duplicate charges, missing settled
  amounts, and weaker access checks are not accepted. Entitlement projections
  are not merely display caches.
- **Shared custom connector prefixes:** exclusivity is not required. Preserve
  connector identity and organization/slug uniqueness. Require explicit valid
  selection when several connectors match; reject unresolved ambiguity rather
  than choosing the first account or injecting arbitrary credentials.

### Declarative Stripe Subscriptions and Daily Reconciliation

Derive desired subscription configuration from existing local business data,
not a new table or a second stored subscription snapshot. Map desired plan,
quantities, cancellation, and current/next-period configuration to their actual
sources and writers. Keep user intent, observed provider facts, and confirmed
paid entitlements distinct. An incomplete mapping is unresolved work.

Commit necessary local financial writes before provider I/O. Synchronization
reloads latest committed data, derives the complete projection, reads Stripe,
and applies configuration differences outside the transaction. Immediate sync
and daily reconciliation use that same projection, not a replayed imperative
quantity change.

Process daily reconciliation in bounded batches, without one transaction across
organizations or remote calls. Temporary drift and out-of-order intermediate
configuration writes are accepted. After changes stop, outstanding stale work
finishes, and reconciliation succeeds, configuration must converge to latest
intent. Daily attempts are not a hard 24-hour recovery promise during outages.

Webhooks record payment, invoice, and observed provider facts; they must not
replace current desired intent with an old provider snapshot. Configuration
repair cannot undo an issued invoice, refund, credit, duplicate charge, or extra
payable subscription. Preserve their independent deduplication, authorization,
and financial recovery contracts.

## Verification and Cleanup

Trace all writers, callbacks, background work, retained operators, existing SQL,
constraints, provider identities, and supported old/new consumers. Identify the
observable guarantee before changing concurrency or transactions. Removing
call sites alone does not prove correctness or production completion.

Remove unused helpers, test hooks, and acceptance utilities with their callers.
Preserve shipped migration history; inspect the final schema and retained
execution paths rather than editing old SQL to make a search return zero.
Retire compatibility and operator paths against actual data-convergence and
deployment gates, not age, lower lock counts, or a CI reference.

Apply [deployment compatibility](deployment-compatibility.md) only to an actual
changed consumer or schema boundary. Do not invent an App upgrade, Runner drain,
extra release, or fixed elapsed-time gate merely because those surfaces exist.
A source merge is not deployment evidence.

Tests use [production caller boundaries](testing/testing-external-behavior.md)
and follow [Testing](testing.md). Do not hold production advisory locks, install
blocking triggers, inspect waiters, add internal gates, or assert lock acquisition.
Remove tests that only pin retired implementations with their unused fixtures.
Apply accepted watch gaps, display delays, and configuration drift while retaining
normal delivery, repair, disable, explicit connector selection, authorization,
accurate settlement, financial idempotency, and exact-resource cleanup.

## Advisory Lock Lint

`api/no-new-advisory-lock` rejects literal PostgreSQL advisory lock/unlock calls
in its configured API/DB TypeScript and script scope, including shared, try,
and transaction variants. Do not add or broaden exemptions; remove any retained
exemption with its acquisition.

The rule is lexical. Dynamically assembled names, standalone SQL, and files
outside lint scope remain subject to the same policy in review. A lint pass is
not proof that the final database has no executable advisory acquisition.

## Transaction Lint

The [transaction policy](#transaction-boundaries) prohibits new explicit non-billing transactions. Billing is not a directory-level exemption: the transaction must directly protect necessary financial correctness and demonstrate why a simple atomic SQL statement is insufficient.

### Enforcement

`api/no-db-transaction` is an error in the API and DB package configurations. It covers production source, scripts, tests and fixtures (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`), and standalone SQL. `api/db-transaction-exemptions` checks exemption syntax and ownership of one detected boundary on the next line. Package lint retains `--max-warnings 0`, with unused directives reported as errors.

Detection includes:

- `.transaction(...)`, `.begin(...)`, `.savepoint(...)`, optional calls, statically computed property names, nested transactions and transaction builders;
- direct `.bind`, `.call`, `.apply`, local callable aliases and callable destructuring; escaping references on recognizable DB handles;
- SQL `BEGIN`, `START TRANSACTION` and `SAVEPOINT` in strings, statically assembled strings, interpolated templates and `.sql` files.

SQL boundaries are recognized using PostgreSQL parsing and statement splitting outside comments, quoted strings/identifiers and dollar bodies. PL/pgSQL `BEGIN` blocks, quoted data, financial `transaction` fields, type references, `COMMIT`, and `ROLLBACK` are not transaction-opening violations. A valid opening statement before invalid trailing SQL remains detectable.

There is no billing-directory, test-directory or new migration exemption. The independent CI scan includes historical DB scripts that normal package lint already ignores; an existing ignored path cannot hide a new transaction.

### Deletion-only Legacy Inventory

`turbo/db-transaction-baseline.json` is a cleanup ledger of existing transaction boundaries. Each entry has a unique ID, repository-relative file and named owner. It does not pin a main revision or fingerprint the transaction's callback, arguments, receiver or SQL body. Existing business code may change while the cleanup proceeds; transaction scope and semantics still require review.

Each existing boundary has this next-line marker:

```ts
// eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0001; new non-billing transactions are prohibited.
await db.transaction(async (tx) => {
  // Existing work; transaction scope and semantics still require review.
});
```

Place the marker immediately above the reported method/property or SQL literal line, including on a multiline method chain. In standalone SQL, use `-- eslint-disable-next-line ...` immediately before the opening statement.

The `lint-eslint` CI job runs the independent collector with inline configuration disabled. It checks:

1. Every detected transaction has a valid, single-boundary legacy or billing exemption.
2. A legacy ID is used once, and its file and owner match.
3. Every retained inventory entry is still used; removing or converting a transaction requires deleting its legacy marker and inventory row.
4. The PR inventory is a subset of the inventory read from the event's **base/main commit**, with no added IDs or modified records. Total transaction counts are not an authorization check.

For initial activation only, the collector reads the supplied base/main source and verifies that registrations for each file and owner do not exceed its existing transaction boundaries. It does not trust the candidate ledger to authorize additional boundaries. Once enforcement is present on main, a missing inventory is an error; bootstrap cannot be used to restore deleted IDs. PR and merge-group checks supply their captured base SHA, and the lint checkout uses the event commit so reruns do not silently select a newer merge ref.

After activation, the inventory is deletion-only. Do not regenerate it, add or reuse IDs, or change an entry's file or owner to make a change pass. Removing a non-billing transaction or converting a necessary billing transaction requires deleting its legacy marker and ledger row. Callback edits do not require ledger updates. Legacy entries include billing and non-billing sites: registration is not a necessity review or a declaration of correctness.

### Necessary Billing Exceptions

A new necessary billing transaction uses a distinct explanation, not a legacy ID:

```ts
// eslint-disable-next-line api/no-db-transaction -- Billing atomicity: ledger debit and wallet balance update must commit together; single-statement alternative: independently validated writes cannot be safely expressed as one simple atomic statement.
await db.transaction(async (tx) => {
  // Only the financial writes covered by the invariant.
});
```

The comment must disable **only** `api/no-db-transaction`, on **the next line**, and include both the financial invariant and why a single-statement alternative is insufficient. File/block disables, `disable-line`, rule-less disables, multiple-rule exemptions, duplicate IDs, vague `billing` reasons and unused directives are rejected. These comments are the narrow exception to the repository's suppression prohibition; unrelated suppressions remain prohibited.

Lint validates the declaration, not the truth of its financial justification. Reviewers must reject unnecessary wrappers, entitlement checks presented as billing atomicity, unrelated business writes, external I/O, and copied boilerplate that does not explain the actual invariant.

### Local Verification and Limits

From `turbo/`, fetch the relevant base/main revision and run:

```sh
pnpm lint:transactions <full-base-main-sha>
```

Stage file deletions before running the Git-backed scan. This command is intentionally not a baseline-update command.

This is a static policy guard, not a runtime/data-flow proof. It rejects extra detected boundaries and unregistered, copied, moved or resurrected IDs. It intentionally allows an existing callback's business logic to change. Replacing a boundary within the same file and owner while transferring its sole ID cannot be distinguished from an edit; review must reject using that limitation to introduce a new transaction. Expanded transaction scope, external I/O, surrounding control flow, arbitrary reflection, dynamically generated property names or SQL, cross-file callable aliases, external callback bodies and new callers of old transaction-opening helpers also require review. CI workflow/rule/scanner changes themselves require review. Preserve authorization, concurrency, idempotency, cleanup and financial correctness when removing transactions.
