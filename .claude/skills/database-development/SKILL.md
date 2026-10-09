---
name: database-development
description: Choose migration workflows, transaction boundaries, or Drizzle runtime decoding and SQL construction rules
---

# Database Development

| Task                                     | Read                                                                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema changes or data migration         | [Migration workflows](references/migrations.md) and [DB migrations](../../../turbo/packages/db/MIGRATIONS.md)                                                  |
| Selections, raw results, or SQL rewrites | [Query contracts](references/query-contracts.md)                                                                                                               |
| Transactions or concurrency changes      | [Transaction boundaries](../../../docs/advisory-lock-terminal-state.md#transaction-boundaries) and [Advisory lock retirement](../../../docs/advisory-locks.md) |
| Persisted shapes or deploy order         | [Deployment compatibility](../../../docs/deployment-compatibility.md)                                                                                          |

Use Drizzle to generate migration metadata; do not hand-edit journals or
snapshots. Numbered external-data migration scripts are permanent historical
records, even after their referenced schema is retired. Keep them self-contained
and dry-run by default.

TypeScript generics do not decode PostgreSQL results. Use the first applicable
schema column, installed Drizzle helper, or reviewed runtime decoder; preserve
nullability, precision, and provenance. Query rewrites must preserve the whole
SQL contract, including bindings, transactions, locks, and material plan costs.
The query reference contains the complete decision order and examples.

## Transaction principles

Follow the [transaction boundary contract](../../../docs/advisory-lock-terminal-state.md#transaction-boundaries)
and [external effects and recovery rules](../../../docs/advisory-lock-terminal-state.md#external-effects-and-recovery):

- Enforce each invariant at the smallest sufficient boundary. Prefer existing
  primary/unique constraints, `INSERT ... ON CONFLICT`, conditional
  `UPDATE ... WHERE ... RETURNING`, and atomic arithmetic. Atomic increments do
  not deduplicate retries; retain the existing business identity when needed.
- Use a short transaction for related writes that must commit together. Keep
  its local reads and writes bounded around one atomic business result. A clear
  local transaction need not become a complicated CTE or ledger redesign.
- The target ownership shape is one ccstate command obtaining its database with
  `set(writeDb$)`, opening and awaiting `db.transaction(...)`, and executing SQL
  directly in its callback. Keep `db` and `tx` inside that command; do not pass
  them through helpers, services, argument objects, injected contexts, or
  escaping closures. Exchange ordinary inputs and committed results between
  commands; pure calculations and SQL builders accept ordinary values.
- Keep HTTP/provider calls, KMS, R2/S3, realtime publication, remote pagination,
  and lengthy preparation outside transactions. Waiting for another command
  to perform external I/O still holds the transaction open.
- A database rollback cannot undo a remote effect. Preserve the accepted
  recovery, retry, and reconnect behavior using existing operation identities
  and provider idempotency where available. Keep authorization and recoverable
  financial correctness; prevent duplicate financial effects, stale credential
  publication, and permission resurrection.

For [advisory-lock retirement](../../../docs/advisory-locks.md), do not add new
advisory locks or substitute a generic lock table, mutex, or claim/lease
framework. The cleanup also forbids new persisted coordination state and
triggers, or explicit row locks, retry loops, `NOWAIT`, and `lock_timeout` added
as advisory-lock replacements. Follow the
[accepted product tradeoffs](../../../docs/advisory-lock-terminal-state.md#accepted-product-tradeoffs--2026-09-29):
do not add CAS, savepoint, or ordering machinery solely to serialize
nonfinancial operations when another save, reconnect, or scheduled task is an
accepted recovery path.

**Release 1 scope:** the September 30 priority update in the transaction
boundary contract makes command ownership and remaining `db`/`tx` propagation
non-goals for Release 1 acceptance. Preserve existing conversions without
turning remaining handle passing into a release gate; the prohibition on
external I/O inside transactions still applies.
