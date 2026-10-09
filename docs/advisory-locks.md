# Retiring PostgreSQL Advisory Locks

Do not introduce new PostgreSQL advisory locks. Existing application-defined
acquisitions are cleanup work, not examples to copy. PostgreSQL's implicit
row/index locking and statement atomicity still apply.

The [terminal constraints](advisory-lock-terminal-state.md) define the accepted
retirement target. For API graphs, the stricter
[database ownership and transaction rules](api-ccstate.md#10-keep-database-handles-local-and-prefer-atomic-sql)
apply: no new non-billing transactions, and necessary billing transactions stay
short and local. This guide is not a dated call-site inventory or release plan.

## Why We Are Removing Them

An advisory key is a second coordination protocol that every writer must know
and acquire in the same order. Broad keys serialize unrelated work, occupy
connections while waiting, and make deadlocks harder to reason about. Provider
I/O under a lock also ties database contention to network latency.

Enforce each actual invariant at the smallest sufficient boundary: an existing
business key, constraint, atomic statement, or necessary billing transaction.
Do not retain stronger serialization for nonfinancial operations whose accepted
recovery is another save, reconnect, or task.

## Choose the Smallest Replacement

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
advisory lock. Follow the terminal contract rather than mechanically substituting
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

## Retire Calls Without Changing the Accepted Contract

Trace all writers, including callbacks, background work, and retained operators.
Identify the observable guarantee, existing constraint, statement predicate,
financial idempotency, and recovery boundary before editing the call.

Keep external I/O outside transactions. A database rollback cannot undo a
provider effect; final local CAS cannot undo an already issued remote payment.
Preserve financial correctness, current authorization, credential ownership,
and exact-candidate cleanup under an uncertain commit result.

Remove unused helpers, test hooks, and acceptance utilities with their callers.
Do not retire compatibility or operator paths based solely on age, a declining
lock count, or a CI reference. Use their actual data and deployment gates from
[deployment compatibility](deployment-compatibility.md). Preserve shipped
migration history; inspect the final schema and retained execution paths rather
than editing old SQL to make a text search return zero.

## Testing

Follow [Testing](testing.md) and [external behavior](testing/testing-external-behavior.md).
Construct scenarios and assert outcomes through the real caller's production
boundary. Verify specified duplicate outcomes, amounts, authorization,
cancellation, and recoverable failures where publicly constructible.

Do not hold production advisory locks, inspect waiters, install temporary
blocking triggers, add internal gates, or assert that a lock was acquired.
Tests that only pin the removed implementation and their unused fixtures should
be removed with it. Do not restore private setup to preserve such coverage.

## Lint Enforcement

`api/no-new-advisory-lock` rejects literal PostgreSQL advisory lock/unlock calls
in its configured API/DB TypeScript and script scope, including shared, try,
and transaction variants. Existing next-line exemptions mark old stock; do not
copy or broaden them, and remove each exemption with its acquisition.

The rule is lexical. Dynamically assembled names, standalone SQL, and files
outside lint scope remain subject to the same policy in review. A lint pass is
not proof that the final database has no executable advisory acquisition.
