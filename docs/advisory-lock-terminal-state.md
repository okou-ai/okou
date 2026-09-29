# Advisory lock cleanup terminal state

Agreed on **2026-09-29**. This document defines the target for the remaining
cleanup releases. It is a design contract, not a claim that the changes have
already shipped.

The inventory was checked against main
`dfe37c15a1e09d0066fefe0cc616c0d49794cee7`: **28 production advisory-lock
acquisition definitions** remain. The earlier 16 P0 findings are a subset of
these 28 definitions, not the complete retirement scope.

## Binding constraints

1. **No advisory locks remain in executable application or operational code.**
   This includes API commands, background jobs, retained operator scripts, test
   fixtures, and functions present in the final database schema. An earlier
   audit classification of KEEP is temporary, not an exemption.
2. **Necessary cross-table writes may use a short transaction owned by one
   command.** The command opens the transaction, executes the necessary SQL,
   and commits. For example, inserting a unique credit grant and updating its
   corresponding balance can be one local atomic operation.
3. **Transactions are not propagated.** A transaction object must not be passed
   to a helper, another command or service, supplied through a transaction-aware
   callback API, injected into context, returned, or captured by deferred work.
   The ORM's transaction callback is the local scope in which its transaction
   object may be used.
4. **This cleanup adds no persisted fields.** Reuse existing identifiers,
   states, values, and constraints. Do not add revision, generation, claim,
   lease, operation, or publication fields to implement the plan. Do not
   circumvent this constraint with a new coordination table or new coordination
   fields hidden inside JSON.

Adding or adjusting an index or constraint over existing fields is compatible
with this target when the actual business contract requires it. Normal SQL
continues to use PostgreSQL's internal row/index locks and atomicity.

The no-new-fields requirement is a design constraint, not a default with an
automatic exception. If a path has no demonstrated implementation under these
constraints, record it as unresolved. Do not silently add schema state or
weaken observable correctness to declare the path complete.

## Transaction boundaries

A short transaction contains a bounded set of local database reads and writes
for one atomic business result. Its SQL lives inside the owning command's
transaction callback. Reusable pure calculations and SQL builders may accept
ordinary values; they must not receive or execute against that transaction.

The surrounding workflow exchanges plain inputs and committed results between
commands. It does not open a transaction and pass it down a call chain.

Keep HTTP, Stripe, Clerk, OAuth, KMS, R2/S3, realtime publication, remote
pagination, and lengthy preparation outside transactions. A transaction must
not wait for another command to perform such work. Moving an entire workflow
into one large command does not make its transaction short.

Remove transaction-accepting interfaces, including transaction-bearing argument
objects and callback wrappers. Renaming a transaction parameter to `db`, using
a database/transaction union type, or capturing it in a closure does not change
the boundary.

Prefer, in order:

| Required behavior                                      | Preferred implementation                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| One row for an existing business identity              | Existing primary/unique key and the appropriate `INSERT ... ON CONFLICT` outcome |
| Conditional state transition or stale-result rejection | `UPDATE ... WHERE ... RETURNING` using the actual existing state or identity     |
| Increment or decrement                                 | Atomic arithmetic, with existing business deduplication where required           |
| A small set of writes that must succeed together       | One command-local short transaction                                              |
| Independent resource preparation                       | Separate committed steps; permit duplicate candidates where acceptable           |
| Selecting a prepared result                            | Conditional publication at the actual business decision point                    |
| Cleaning an unsuccessful candidate                     | Cleanup of that candidate's exact existing IDs and object prefix                 |

Do not introduce a general lock table, mutex, distributed lock, or generic
claim/lease framework as a replacement. Do not require every intermediate
resource to have a fixed business key when only the final published result
needs to be unique.

There is no requirement to replace a clear local transaction with a complicated
CTE, an immutable-ledger redesign, or versioned credential storage. Use a single
SQL statement when it is simpler; retain a small local transaction when that
is the simpler way to preserve atomicity.

## External effects and recovery

An existing database transaction cannot roll back a remote API effect. Remote
success followed by a lost response or failed local commit is an existing
failure window, not a reason to retain advisory locks.

Preserve existing recovery, retry, and reconnect behavior. Use existing stable
operation identities and provider idempotency where available. Do not make a
new generic uncertainty/compensation system a prerequisite for this cleanup.

At the same time, removing a lock must not introduce duplicate financial
effects, stale credential publication, or permission resurrection. Identify
which existing state, constraint, conditional statement, or local atomic
operation preserves each actual guarantee. A final database CAS cannot undo a
remote request that has already taken effect.

Where the product accepts temporary inconsistency, use the existing repair
path. For Google Forms, the intended direction is to tolerate a temporary watch
gap and repair it through reconciliation. The existing renewal cron must be
able to discover missing remote watches even when local state appears healthy,
retain the consumption cursor, and catch up readable responses. Increasing the
cron frequency alone is insufficient. This tradeoff does not automatically
apply to billing or credential rotation.

## Bootstrap reference design

The decisive shared operation is publishing the organization's default Agent.
Preparing instructions and Storage does not need to be serialized for the
whole organization.

The preferred shape, without new fields, is:

1. Allocate independent candidate IDs, internal names, and object prefixes
   using existing fields. Prepare Storage and instructions, upload objects, and
   complete verification outside a transaction.
2. Grant onboarding credits through an independent command-local short
   transaction. The existing grant identity prevents duplicate grants; the
   grant and balance change commit together. Preserve paid-tier and entitlement
   behavior. Complete required credit work before publishing the default Agent.
3. In a final command-local short transaction, insert the fully prepared Agent
   and conditionally bind `org_metadata.default_agent_id` while it is still
   absent. Check the actual `RETURNING` result. If publication loses the race,
   roll back the candidate Agent insertion.
4. A winner returns its published Agent. A confirmed loser returns the existing
   default and cleans only its own unreferenced Storage and object prefix.

Deferring Agent insertion to the final local transaction avoids exposing a
partially initialized Agent or adding a candidate/publication field. This is
the preferred implementation shape to verify against all relevant readers,
references, and deletion paths; the implementation is not yet complete.

A timeout is not proof that publication lost. If the commit result is uncertain,
re-read authoritative state before deciding what can be removed. Never delete
a potentially published candidate merely because the request threw. Cleanup
must not adopt another candidate's resource by name. Abandoned preparatory
resources can be reclaimed using their existing identities and references.

## Release work packages

These packages cover all 28 production acquisition definitions at the pinned
baseline. Counts are SQL acquisition definitions, not caller counts or distinct
keys. They are planning packages, not a mandatory merge order or a promise of
exactly seven deployments.

| Package   | Scope                                                                                                                                    | Definitions | Required result                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------: | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | Org Bootstrap                                                                                                                            |           1 | Independent preparation, local credit transaction, conditional default publication, exact candidate cleanup                           |
| 2         | Browser; Custom account target; Custom prefix; Model policy                                                                              |           4 | Existing identity/constraint arbitration and conditional writes; necessary cross-table changes owned by one command                   |
| 3         | Builtin credentials; Model provider credentials; Automatic OAuth/DCR; Gmail, Calendar, and Forms watches                                 |           6 | External I/O outside transactions; complete credential writes and exact resource publication/cleanup using existing data              |
| 4         | Morning Brief preference and native schedule                                                                                             |           2 | Respect the latest user choice; independent preparation; local conditional publication; remove the outer transaction and lock polling |
| 5         | Stripe customer, organization purchase, subscription synchronization, allocation, plan change, invitation purchase, and invitation email |           7 | Existing idempotency and conditional business transitions; external Stripe work; local atomic financial writes                        |
| 6         | Usage display, credits/allowance, compaction shared and exclusive acquisition                                                            |           4 | Conditional settlement and amount conservation; bounded local compaction/deletion; no global advisory barrier                         |
| 7         | SSH owner and the three VNC acquisition definitions                                                                                      |           4 | Existing credential/host identity checks; conditional resource updates; deletion cannot revive revoked authority                      |
| **Total** |                                                                                                                                          |      **28** | **Zero production acquisition definitions**                                                                                           |

Preserve one implementation owner per focused PR. Independent work may proceed
concurrently. Shared files and expected merge conflicts are coordination
information, not reasons to serialize otherwise independent changes.

Coordinate actual shared behavior:

- Credits and compaction share settlement and entitlement-refresh paths.
- Allocation and invitation purchase share Stripe projection updates.
- Credential services share refresh infrastructure; watches consume the same
  account identity and credentials.

The final implementation must follow the constraints above, even where earlier
discussion proposed new revisions, operation columns, generation pointers, or
versioned storage. Those field-adding proposals are not part of this target.

## Rollout and completion

Build the full API transaction-propagation inventory from the first package.
Remove each package's transaction-accepting interfaces with its implementation,
then perform a whole-API sweep. Removing the advisory SQL alone does not finish
the transaction-boundary work.

### Minimum compatibility plan: two release waves

Apply [Fallbacks to Avoid](./fallback.md), especially sections 2 and 7. Under
the normal rolling production release model, plan **two deployment waves** for
the complete cleanup. The seven work packages above are implementation groups;
they can feed these same two waves rather than requiring seven releases.

| Wave                                                    | Work                                                                                                                                                                                                                                                                                                                                   | Required compatibility                                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release 1: prepare and directly retire compatible paths | Complete the replacement write protocols using existing fields. Retire non-GA paths directly. Also retire GA paths whose replacement is already compatible with every supported writer. For the remaining GA paths, retain only the advisory coordination and transaction boundaries actually needed to coexist with the outgoing API. | Outgoing code and Release 1 remain correct together. Every writer that Release 2 will overlap with must already support the replacement protocol.                                  |
| Release 2: complete retirement                          | Remove the remaining advisory calls and temporary compatibility boundaries. Finish local transaction ownership, operational-tool and database-function cleanup, and the whole-API sweep.                                                                                                                                               | Release 1 and Release 2 coexist safely without relying on the removed locks. Incompatible pre-Release-1 writers are no longer serving, in flight, or retained as rollback targets. |

Do not add a preparation release or fallback for a feature that is still
non-GA under the feature-switch policy. Confirm the actual affected paths:
a staff-only surface does not make a shared GA billing or credential writer
non-GA. A GA path that already has a compatible replacement needs no new
preparation cycle either.

The remaining GA writer interactions prevent treating one complete rolling
release as demonstrated safe. For example, current settlement reads pending
usage and later marks it processed by ID without a pending-state predicate.
A new conditional writer alone cannot stop an outgoing writer from charging
usage it read before the new writer committed. Current Bootstrap also assigns
the default Agent without a CAS. These writers must first participate in a
common compatible protocol before the shared advisory coordination disappears.
No new fields are needed merely to split that deployment transition.

Between the waves, verify the deployed serving versions, supported rollback
versions, and the relevant in-flight work. Keep Release 1 as a compatible
rollback target where applicable. If a migration adds a constraint or changes
a stored function, respect the normal migration-before-API promotion order and
ensure the outgoing Release 1 statements remain legal.

This is principally an API-writer transition. Do not impose an App upgrade or
Runner drain merely because those surfaces exist. Their separate gates apply
only if an implementation actually changes a contract they consume. A merge
to main is not deployment evidence, and an arbitrary elapsed time is not a
removal gate.

The two waves describe the minimum compatibility plan, not proof that every
no-new-fields design is already complete. Additional releases need a concrete
implementation or compatibility reason; package numbering alone is not one.

Completion requires:

- Zero advisory acquisitions in production code, retained operational tools,
  executable fixtures, and functions in the final database schema.
- Zero transaction objects propagated beyond their owning command's local
  transaction callback.
- Zero external I/O or workflow-spanning work inside those transactions.
- Zero new persisted fields introduced by this cleanup.
- User-visible behavior verified through production APIs, including relevant
  concurrent requests, duplicate outcomes, amounts, permissions, and cleanup.

Retire or rewrite the catalog fixture's session lock and the billing-attribution
operator's lock. Resolve the final-schema
`purge_quiescent_provisional_billing_attribution` function through a new
migration if it is still present. The operator tool and its two reader fallbacks
must be assessed against their actual data-convergence conditions; a CI
reference or their age is not evidence that they remain necessary or are safe
to delete.

Preserve shipped migration history. Its historical SQL and lint-rule examples
are not live acquisition sites in the terminal application. Do not edit old
migrations merely to make a text search return zero; the final schema and all
retained execution paths must meet the target.

Tests construct state and assert outcomes through user-accessible APIs. Do not
hold production advisory locks, install temporary triggers, inspect lock
waiters, or introduce artificial gates to assert a particular implementation.

Track advisory definitions, transaction propagation, and transaction-held
external I/O separately in each package. Record constraints that are not yet
resolved instead of treating a lower advisory-lock count as completion.
