# Retiring PostgreSQL advisory locks

Starting **2026-09-26**, Okou is progressively removing PostgreSQL advisory
locks. Do not introduce new advisory locks. Existing call sites are temporary
cleanup work; remove them as their business invariants move to database
constraints, atomic SQL, or a smaller transaction over the affected rows.

## Why we are removing them

Advisory locks have been overused for problems that a unique index or a simple
SQL statement already solves: preventing duplicate creation, updating a value,
claiming queued work, or reconciling one resource. In these cases the extra
lock adds a second coordination protocol without strengthening the data model.

Every writer must know the same advisory key and acquire locks in the same
order. An unrelated writer can bypass that convention. Broad organization or
global keys serialize independent requests, keep transactions and connections
open while waiting, and make deadlocks harder to reason about. Holding a lock
across provider calls also makes database contention depend on network latency.

Put each invariant at the smallest boundary that can enforce it. PostgreSQL
still takes the row and index locks required by normal SQL; this policy retires
application-defined advisory locking, not transactional consistency.

## Choose a replacement

| Required behavior                               | Preferred approach                                                                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| At most one row for a business identity         | A primary key or unique index over the actual identity, including tenant scope where appropriate. Use `INSERT ... ON CONFLICT` for the intended duplicate outcome.         |
| Create a resource if absent                     | A unique constraint and an atomic insert/upsert. Let the database arbitrate concurrent creation.                                                                           |
| Increment a counter or reserve positions        | `UPDATE ... SET value = value + delta RETURNING ...`, or an atomic upsert that initializes and increments the owning row.                                                  |
| Only one request may perform a state transition | `UPDATE ... WHERE state = expected_state RETURNING ...`; only the request that changes the row owns the transition.                                                        |
| Reject an edit based on stale state             | A version predicate in the update, incrementing the version on success. Return the existing conflict result when no row matches.                                           |
| Change several rows under one invariant         | First look for a constraint or one statement. If necessary, use a short transaction and lock the existing row that owns the invariant in a consistent order.               |
| Multiple workers may process independent jobs   | Atomically claim durable job rows. `FOR UPDATE SKIP LOCKED` can select an available job when processing a different job is valid.                                          |
| Avoid duplicate provider effects                | A durable operation identity, a transactional outbox where needed, and the provider's idempotency key where supported. Keep network work outside the database transaction. |
| Enforce a product limit                         | Decide whether the limit is soft or strict. A soft limit can use the current count. A strict limit needs an atomic reservation or a transaction over the quota owner.      |

These are design choices for the actual contract. Do not mechanically replace
every advisory lock with `FOR UPDATE`, a new lock table, an in-memory mutex, or
a distributed lock in another service.

## SQL examples

The following use illustrative tables and parameters. Use the repository's
Drizzle APIs and bound values when implementing them.

### Deduplicate using the business key

Assume all three identity columns below are `NOT NULL`:

```sql
CREATE UNIQUE INDEX webhook_receipts_event_key
ON webhook_receipts (org_id, provider, event_id);

INSERT INTO webhook_receipts (org_id, provider, event_id)
VALUES ($1, $2, $3)
ON CONFLICT (org_id, provider, event_id) DO NOTHING
RETURNING id;
```

A returned row identifies the request that inserted the receipt. An empty
result means the event already exists. Commit the receipt and any corresponding
business changes or durable outbox work in the same transaction, so a failed
attempt cannot consume the identity without recording the work.

Choose the unique key from the business contract. Account for nullable keys,
case normalization, and soft deletion explicitly. A preceding existence check
does not prevent another request from inserting the same key. Handle the
specific intended conflict; do not swallow unrelated constraint failures.

### Update from the stored value

```sql
UPDATE counters
SET value = value + $2
WHERE id = $1
RETURNING value;
```

This avoids reading a value into application code and later overwriting a
concurrent increment. If initialization is required, use an upsert with an
increment expression. Atomic arithmetic alone does not deduplicate repeated
requests; retain a business idempotency key when the operation requires one.

### Let the state transition select the winner

```sql
UPDATE jobs
SET state = 'claimed'
WHERE org_id = $1
  AND id = $2
  AND state = 'queued'
RETURNING id;
```

Only the caller receiving the row owns this claim. A caller receiving no row
follows the existing already-claimed or unavailable result. Persist dependent
work in the same transaction. Durable worker claims also need explicit crash
recovery; changing a status does not guarantee that a worker will finish.

For optimistic edits, the same pattern can use `WHERE version = $expected`
and `SET version = version + 1`. Keep authorization and ownership predicates
in the write as well as in the API boundary.

### Keep a multi-row invariant on its owner

When one statement cannot express the operation, lock the existing owner row,
validate the invariant, and change its dependent rows in the same short
transaction. All participating writers must follow the same row-lock order.
Reuse a row lock the transaction already holds instead of adding another
coordination layer.

A row lock cannot protect a row that does not exist. Use a unique constraint
to arbitrate creation. Likewise, a transaction containing `COUNT` followed by
`INSERT` does not by itself enforce a strict capacity limit under concurrent
requests. Use an atomic quota reservation when strict capacity is required.
Accepting occasional overshoot is a product decision for a soft limit; it is
not a general replacement for billing or authorization invariants.

`SKIP LOCKED` is appropriate only when skipping busy work preserves the
contract. It must not silently skip required billing, deletion, or lifecycle
work. A database transaction also cannot atomically commit a remote provider
effect: keep a durable operation record and the recovery semantics required by
that provider.

## Retire existing calls progressively

For each removal, identify the user-visible invariant and all production
writers, including callbacks and background jobs. Check the existing schema
and transaction first: many callers already have the necessary primary key,
unique constraint, conditional write, or row lock.

Land any genuinely necessary constraint before relying on it. Preserve
tenant scope, idempotency, rollback behavior, and the supported old/new writer
combinations described in [deployment compatibility](./deployment-compatibility.md).
If a remaining lock protects a real multi-row invariant, describe that
invariant and its replacement before removing the call.

Remove obsolete lock helpers, test hooks, and migration acceptance utilities
with their callers. Retire a backfill tool or compatibility fallback based on
its completed data and rollout conditions. A CI reference alone does not prove
that an operator tool is still needed. Preserve shipped migration history.

Do not hide unresolved ordering with `NOWAIT`, lock retry loops, larger
timeouts, or a new fallback. Simplify the invariant and transaction boundary.

## Testing the resulting behavior

Follow the [testing guide](./testing.md): construct API state through production
endpoints and assert responses or state available through production endpoints.
Concurrent requests can verify one resource, one accepted transition, correct
amounts, permissions, cancellation, and the specified duplicate outcome.

Do not hold production advisory locks in a test, inspect lock waiters, install
temporary blocking triggers, or add internal gates solely to force an
interleaving. Do not assert that a particular lock was acquired. Tests whose
only contract is that implementation detail should be removed with their
fixtures. A change in synchronization should not break a test when the
user-visible contract remains the same.

## Lint enforcement and initial inventory

`api/no-new-advisory-lock` is enabled for API and DB TypeScript source and
scripts in their ESLint configurations. It rejects literal PostgreSQL advisory
lock and unlock function calls, including try/shared/transaction variants.
Existing calls have individual next-line exemptions marking them as
pre-2026-09-26 stock. These exemptions identify cleanup work; do not copy them
onto new calls or expand them to files or directories. Remove an exemption
when its call is removed.

This is a lexical rule. Standalone SQL migrations, dynamically assembled
function names, and files outside the configured lint scope are not checked
by it. They remain subject to the same no-new-advisory-lock policy in review.

The first cleanup PR, [#36978](https://github.com/okou-ai/okou/pull/36978), has
the following source inventory at commit `f76ca2717067e29b6c36afcf6eeb32404dc701c5`
on 2026-09-26:

| Scope                                    | Acquisition call sites |
| ---------------------------------------- | ---------------------: |
| API production TypeScript                |                     55 |
| Official-workflow catalog test isolation |                      1 |
| Billing-attribution operator backfill    |                      1 |
| **Total**                                |                 **57** |

This counts literal acquisition sites in API/DB TS/JS files, not distinct lock
keys or runtime acquisitions. It excludes comments, unlocks, lint-rule fixture
strings, and SQL migration files. Six acquisition sites in shipped SQL
migration files are outside this inventory; it is not a census of installed
database functions. The table is a dated PR snapshot, not a claim that all
remaining calls are necessary or that the cleanup has already shipped.
