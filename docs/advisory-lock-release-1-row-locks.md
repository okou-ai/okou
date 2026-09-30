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

## Retry loops (Ethan, 2026-09-30)

Retry loops used to coordinate concurrency are not terminal either. A lost race
now yields one deterministic result from a conditional statement (success,
idempotent no-op, "already handled", or a 409/conflict the route maps), or a
settlement batch stays pending for the existing next cycle. Removed in this PR:

| Area                                                             | Former retry                                               | Now                                                                                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credit settlement                                                | `attempt < 3`, 40P01 deadlock retry, expiration-then-retry | One prepare and one commit; stale snapshot or expiration conflict leaves the batch pending for the next cycle; deadlocks propagate as on main         |
| Credit usage paging                                              | `while (true)`                                             | One read of pending keys, fixed batches                                                                                                               |
| Credit expiration                                                | bounded clear + retry                                      | One statement over the expired set                                                                                                                    |
| Org/onboarding/CLI grants                                        | `attempt < 4`                                              | One transaction; `ON CONFLICT` receipt + atomic increment                                                                                             |
| Legacy plan invoice                                              | `attempt < 3`                                              | One commit; a lost wallet race reads the winner once and becomes a no-op when the invoice is now a duplicate or rejected, otherwise Stripe redelivers |
| Get-started rewards/invitations                                  | `attempt < 16`                                             | One transaction; a lost slot race returns the claim unchanged (reward) or 503 for Clerk redelivery (invitation)                                       |
| Chat ingress routes (Slack, Teams, Telegram, Feishu, AgentPhone) | 2–3 attempts with speculative thread + delete              | One CTE statement: the thread is inserted only from a winning route `ON CONFLICT DO NOTHING`; the winner is read once                                 |
| Slack installation/workspace                                     | 4-attempt whole transaction                                | One commit; reward grant in a savepoint maps unique violations to ineligible                                                                          |
| Storage stable-context heads                                     | 8 attempts                                                 | One generation CAS; a miss is the existing stale-publication result                                                                                   |
| Catalog reader                                                   | 2-pass read                                                | One identity read, one combined read on miss                                                                                                          |
| Model provider accounts                                          | 40P01 mapped to 409                                        | Provider row written first so account changes queue on it                                                                                             |
| Connector deletion vs selection                                  | savepoint retry on RESTRICT                                | Selection writes first write the account row; deletion removes selections and the account in one statement                                            |
| Morning Brief settlement/toggle/timezone/materialization         | `MORNING_BRIEF_SNAPSHOT_ATTEMPTS = 5`                      | One pass; `conflict` maps to 409 or leaves enrollment pending for its existing retry schedule                                                         |
| Clerk deletion                                                   | bounded run re-sweep                                       | One pass; a late run/conversation fails the job, which the existing background-job attempts re-run                                                    |
| Usage pack purchase snapshot/checkout                            | `while (true)`                                             | One pass returning `conflict` (409)                                                                                                                   |
| Stripe concurrency invoice                                       | `attempt < 3`                                              | One conditional publish; failure → Stripe redelivery                                                                                                  |

Kept (not concurrency coordination): external provider HTTP retries already on
main (Gmail token refresh), queue/background job attempt counters, Stripe and
Clerk webhook redelivery, and pagination loops.

The allowance window entitlement lock is replaced by the unique index
`uq_org_usage_allowance_windows_entitlement_kind_starts` on existing columns
(migration 1299) with `INSERT … ON CONFLICT`. Before releasing, verify that
production has no duplicate `(entitlement_id, kind, starts_at)` windows.
The [preflight query and duplicate handling](./advisory-lock-release-1-key-retirement.md#allowance-index-1299-preflight)
are required before deployment admission; this change did not query production.

After `4f263928`, both newly introduced empty UPDATEs (connector selection and
legacy Plan invoice admission) are removed. Selection uses a read-only source
and ordinary FK arbitration. Invoice publication conditions the actual receipt
and metadata write and rolls back financial changes on rejection. The operator
also removes its explicit checkpoint/source locks, NOWAIT and lock_timeout;
its existing business checkpoint advances by CAS with no contention retry.
See the [current retirement inventory](./advisory-lock-release-1-key-retirement.md).
