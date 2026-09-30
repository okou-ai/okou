# Release 1 explicit row lock inventory

Ethan clarified on 2026-09-30 that explicit row locks used as a mutex
(`SELECT … FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE / FOR KEY SHARE`) are
not part of the terminal state. A necessary short transaction contains only
the bounded reads and writes for one atomic business result and relies on
PostgreSQL's implicit locks from ordinary `INSERT`, `UPDATE`, `DELETE` and
foreign-key checks. Replacements used in this PR:

- conditional state transitions: `UPDATE/DELETE … WHERE <current state,
identity, revision, xmin or updated_at> RETURNING`, where zero rows is a
  deterministic lost/stale result (409, superseded, not published, no-op);
- uniqueness: existing unique constraints and partial unique indexes with
  `INSERT … ON CONFLICT`;
- admission that must see current parents: one `INSERT … SELECT … WHERE
EXISTS(…)` or a conditional statement, with foreign-key checks as the
  implicit protection;
- counts and balances: atomic arithmetic.

Two default-index races and one account-deletion race use a savepoint to turn
a constraint conflict into the serialized result instead of a 500: default
changes and default promotion (partial unique default index) and account
deletion racing a new chat-thread selection (RESTRICT foreign key; late
selections are deleted and counted).

## Syntactic count relative to main

At `12dec82`, non-test API source has 288 explicit lock clauses against 377 on
main (−89). Only five files still exceed main, each holding a lock moved from
a main file:

| File                                          | main | this PR | Why kept                                                                                                                         |
| --------------------------------------------- | ---: | ------: | -------------------------------------------------------------------------------------------------------------------------------- |
| `services/credit-usage-settlement-plan.ts`    |    0 |       1 | Run parent `KEY SHARE` keeps Run-before-usage order with Run deletion (the later FK inserts take the same lock).                 |
| `services/managed-usage-attribution.ts`       |    0 |       1 | Same Run-parent ordering.                                                                                                        |
| `services/usage-allowance-settlement-plan.ts` |    0 |       1 | Entitlement `FOR UPDATE`: the only arbiter preventing duplicate allowance windows; no existing unique constraint covers windows. |
| `services/x-resource-usage-values.ts`         |    0 |       1 | Run `SHARE` keeps completion/provider fields stable across admission checks (moved from main).                                   |
| `services/clerk-lifecycle-plan.ts`            |    0 |       3 | `run_uploaded_files` and stable-context locks moved from main's deletion services.                                               |

Grant and lot deductions are conditional on the row version and remaining
balance with the batch rejected on a short row count; the wallet debit is
atomic arithmetic; expiration clamps in one statement. Morning Brief
settlement, toggle, timezone and materialization use row-version conditional
writes that re-run from a fresh read; automation thread bindings use
`ON CONFLICT` and conditional attachment. Clerk deletion no longer uses
`NOWAIT` or ordered parent locks. Remaining risk: a checkpoint racing Clerk
run deletion can leave a blob reference count one too high; closing it fully
needs `conversations.run_id` to become RESTRICT with every run-deleting path
removing conversations first (a constraint change on existing columns).
