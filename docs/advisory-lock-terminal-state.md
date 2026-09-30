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
   command.** Its caller-supplied parameters contain business inputs and, when
   needed, a final `AbortSignal`; they never contain `db` or `tx`. Inside the
   command, obtain the database with `const db = set(writeDb$)`, open the
   transaction with `db.transaction(...)`, execute the necessary SQL, and await
   its commit. For example, inserting a unique credit grant and updating its
   corresponding balance can be one local atomic operation.
3. **Database and transaction handles stay inside their owning command.** That
   command must not pass `db` or `tx` to a helper, another command or service,
   a store adapter, a callback API, or an injected context. Neither handle may
   be returned or captured by work that escapes the command. The ORM's local
   transaction callback is where `tx` is used directly.
4. **This cleanup adds no database tables or persisted fields.** Reuse existing
   business records, identifiers, states, values and constraints. Derive the
   desired Stripe subscription from that data; do not persist a second copy
   in a new subscription table. Do not add revision, generation, claim, lease,
   operation or publication fields to implement the plan, or hide new persisted
   coordination state inside existing JSON fields.
5. **No application-defined database triggers remain in the final schema.**
   Do not move coordination, cursor lifecycle, projections, or other business
   writes into trigger functions. Express those transitions explicitly in the
   owning command's SQL and keep necessary related writes in its local short
   transaction. Mixed-version compatibility does not make a trigger part of
   the accepted terminal design.

Adding or adjusting an index or constraint over existing fields is compatible
with this target when the actual business contract requires it. Normal SQL
continues to use PostgreSQL's internal row/index locks and atomicity.

Ethan withdrew the briefly considered subscription-table exception on
September 29. The no-new-tables/no-new-fields constraint applies to every
package, including declarative Stripe synchronization. If a path has no
demonstrated implementation under these constraints, record the specific gap
as unresolved. Do not silently add schema state or weaken the accepted
observable correctness requirements to declare the path complete.

## Transaction boundaries

> **Priority update (Ethan, 2026-09-30):** the terminal state is about removing
> advisory locks. Database/transaction handle passing and the "command owns
> its transaction" shape below are **non-goals** for release 1 acceptance:
> existing conversions stay, but remaining handle passing is not tracked as a
> gap. Still required: no explicit row locks, retry loops, `NOWAIT` or
> `lock_timeout` as replacements for advisory locks; no external I/O inside a
> transaction; no new tables, fields, JSON coordination state or triggers.

A short transaction contains a bounded set of local database reads and writes
for one atomic business result. Its SQL lives inside the owning command's
transaction callback. Reusable pure calculations and SQL builders may accept
ordinary values; they must not receive a database or transaction handle.

The required shape is a ccstate `command` that acquires its own database from
`writeDb$`. The following example illustrates the boundary; the table and input
names stand for the operation's existing business schema:

```typescript
const updateRelatedRows$ = command(
  async (
    { set },
    input: UpdateRelatedRowsInput,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    await db.transaction(async (tx) => {
      await tx
        .update(firstTable)
        .set(input.firstValues)
        .where(eq(firstTable.id, input.firstId));
      await tx
        .update(secondTable)
        .set(input.secondValues)
        .where(eq(secondTable.id, input.secondId));
    });
  },
);
```

The command owns the whole open/write/commit boundary. A helper or store that
accepts `Db` and opens its own transaction does not satisfy this shape. Moving
`db` or `tx` into an argument object, a closure, a callback, or a `Db | Tx` type
does not satisfy it either. Returning plain committed business results is
allowed; returning a handle or a query that still depends on it is not.

The surrounding workflow exchanges plain inputs and committed results between
commands. It does not open a transaction and pass it down a call chain.

Keep HTTP, Stripe, Clerk, OAuth, KMS, R2/S3, realtime publication, remote
pagination, and lengthy preparation outside transactions. A transaction must
not wait for another command to perform such work. Moving an entire workflow
into one large command does not make its transaction short.

Remove caller-injected database and transaction parameters from commands that
own these writes, together with transaction-bearing argument objects and
callback wrappers. Execute their SQL inside the owning command instead of
forwarding either handle through the workflow.

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

Preserve recovery, retry, and reconnect behavior needed by the accepted product
contract below. Use existing stable operation identities and provider idempotency
where available. Do not preserve stronger delivery or cleanup guarantees that
the product has explicitly dropped, or make a new generic
uncertainty/compensation system a prerequisite for this cleanup.

At the same time, removing a lock must not introduce duplicate financial
effects, stale credential publication, or permission resurrection. Identify
which existing state, constraint, conditional statement, or local atomic
operation preserves each actual guarantee. A final database CAS cannot undo a
remote request that has already taken effect.

### Accepted product tradeoffs — 2026-09-29

Ethan explicitly accepted the following behavior. These decisions supersede the
earlier Forms cursor-continuity requirement, strict Stripe configuration-write
ordering, and inventory notes that describe the Gmail, Calendar, usage-display
or shared-prefix choices as pending. They define the target; recording them
does not mean their implementation has shipped.

**Google Forms: recovery may skip the outage interval.** Forms is a best-effort
automation trigger. A broken, missing or replaced watch may lose triggers during
the failure/recovery interval. Repair may establish a fresh baseline from the
latest response instead of preserving the old cursor and replaying every
readable response. Normal trigger delivery and recovery to a working watch
remain required. Do not retain cursor-detachment machinery, the two Forms
cursor/source triggers, compensation protocols or lock ordering solely to
guarantee uninterrupted cursor continuity. An outgoing repair resetting the
cursor is not, by itself, a compatibility blocker under this accepted behavior.

**Gmail: local stop is immediate; remote notification expiry may be delayed.**
Disabling an automation stops its local consumption. When no relevant consumer
remains, stop renewing the watch and let the remote subscription expire instead
of requiring an account-wide `users.stop` call. Notifications may continue to
arrive until expiry and are ignored for inactive consumers. Other enabled
consumers must remain functional. Temporary unused provider resources and
notification traffic are accepted; precise synchronous remote teardown is not
required. This removes the need to globally order ordinary local stop against
every new remote watch merely to avoid a late `users.stop` stopping that watch.

**Google Calendar: channel replacement and recovery may have notification gaps.**
Create or renew remote channels outside database transactions and conditionally
publish the current channel. Stop superseded or unpublished candidates on a
best-effort basis; failed cleanup may leave an unused channel until expiry.
Replacement or repair may miss notifications. Do not preserve pending/previous
channel recovery state solely to guarantee gap-free handover or perfect remote
cleanup, and do not block usable new subscriptions on obsolete-channel cleanup.
Authenticate notifications and accept only the current authorized channel and
source. Event update/cancellation semantics still apply to events actually
consumed.

**Google Meet: the Calendar tradeoff also applies (accepted 2026-09-30).**
Workspace Events subscriptions are created, renewed or deleted outside
database transactions and published conditionally. Cleanup is best effort,
and a consumer enabled while another consumer's cleanup is in flight may miss
notifications until repair recreates its subscription.

**Rotating refresh tokens: a rare cross-instance duplicate refresh may require
reconnection (accepted 2026-09-30).** This extends the ordinary refresh decision
beyond Airtable; no lock, lease or pre-consumption is used to prevent it.

For all four watch integrations, retain current account/source authorization,
explicit enabled state and basic deduplication through existing identities and
unique constraints. Delayed preparation must not recreate revoked authority or
re-enable an automation the user disabled. Provider requests and local writes
do not need to form one atomic operation. Forms and Calendar do not promise
exactly-once delivery or mandatory replay across the accepted outage windows;
the Gmail decision concerns delayed remote teardown, not interruption of
remaining enabled consumers. Necessary local transactions still follow the
command-owned shape above. Any remaining mixed-version boundary must protect a
guarantee that is still required, rather than an abandoned delivery guarantee.

**Chat usage display may lag behind settlement.** The settled billing data is
the authority for amounts; the display read path should obtain current totals
from that data. Chat/realtime events can act as refresh hints, without a strict
one-notification-per-update guarantee. Adapt API and App readers together so
display accuracy does not depend on a perfectly synchronized chain of chat-event
replacements and archive lookups. Delayed display or redundant refresh hints are
accepted. Lost or duplicate charges, permanently missing settled amounts, and
weaker access checks are not. This decision concerns chat usage presentation;
subscription projections that determine actual entitlements are not merely
display caches.

**Custom connectors may share a service URL prefix.** Remove the rule that
every prefix must be exclusive within an organization. Keep connector identity
uniqueness, including the existing organization/slug constraint. Requests must
resolve to the intended authorized connector; when several connectors match,
require an explicit valid connector selection and reject unresolved ambiguity.
Never choose the first matching connector or inject an arbitrary account's
credentials. Verify this behavior across API/server and Runner entrypoints
before removing prefix-exclusivity locks, organization-wide scans and rejection
paths. Existing connector identity/intent is the selection mechanism; this
decision does not authorize new persisted coordination fields.

### Declarative Stripe subscriptions and daily reconciliation

**Existing local business data defines the desired subscription; Stripe
converges to that derived configuration.** Build the organization's intended
plan, item quantities, cancellation and current/next-period configuration from
existing records and fields. The desired subscription is a computed business
projection, not another persisted copy. Daily reconciliation is accepted;
adding a subscription table or fields is not.

The implementation must map each part of the projection to its authoritative
existing source and trace the commands and webhooks that write those sources.
Keep user intent, observed provider state and confirmed paid entitlements
distinct in that mapping. Do not merely round-trip an observed Stripe snapshot
as the desired configuration, or reinterpret paid slots or invoice facts as an
unpaid request. If a mapping is incomplete, identify the precise business fact
and writer still to resolve without adding schema state or declaring the whole
projection complete.

The required flow is:

1. A command accepts business inputs, obtains `writeDb$` internally and commits
   the change to existing business records and any necessary related local
   writes in a short transaction. No database handle escapes and no Stripe
   request runs inside it.
2. Synchronization receives the organization identity and reloads its latest
   committed business data, then derives the complete desired subscription with
   a shared projection. Outside the transaction, read Stripe, compare
   current/future configuration, and apply the differences. Do not replay a
   captured imperative request such as an old quantity increment. Mutation-time
   sync and daily reconciliation use the same projection.
3. Reconcile organizations once per day, including changes whose immediate
   synchronization failed or never ran. A best-effort sync after a user change
   can reduce delay; immediate provider convergence is not a correctness
   requirement. Process the sweep in bounded batches without one transaction
   spanning organizations or remote requests.
4. Accept temporary provider drift and out-of-order intermediate writes. If an
   older sync writes quantity 2 after a newer sync wrote 3, a subsequent sync
   reads the desired 3 and repairs Stripe. Once changes stop and reconciliation
   succeeds after outstanding stale work, current and scheduled configuration
   must match the latest desired state. Daily attempts are not a hard 24-hour
   recovery promise during a provider outage.
5. Webhooks record payment, invoice and observed provider facts, and may request
   reconciliation. A delayed webhook must not overwrite the current desired
   configuration with an older provider snapshot.

This replaces the requirement for a globally ordered quantity/schedule writer
protocol. Do not keep advisory locks, provider calls inside transactions,
schedule-identity fencing or a generic claim/lease framework solely to prevent
temporary configuration drift. Missed work must be recoverable by the daily
sweep; a new generic coordination system is not a prerequisite.

Financial effects remain a separate boundary. Repeating configuration
reconciliation must not repeatedly charge, refund or grant credits. Preserve
business-operation deduplication, payment-action behavior and paid entitlement
checks; an intended purchase is not evidence of payment. Stripe quantity or
schedule changes can affect proration and invoices, so eventual configuration
repair alone does not repair an already-issued invoice. The implementation
must account for those effects without silently changing billing semantics.
Likewise, two payable subscriptions are not merely a temporary quantity drift.

Financial amounts, grants, refunds, permission revocation and credential
ownership retain their correctness requirements. The accepted watch gaps,
display delays and subscription configuration drift do not approve duplicate
payments, stale credential publication or changes to one-time provider
token-rotation semantics. Other simplification proposals remain separate from
these explicit product decisions.

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

| Package   | Scope                                                                                                                                    | Definitions | Required result                                                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------: | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | Org Bootstrap                                                                                                                            |           1 | Independent preparation, local credit transaction, conditional default publication, exact candidate cleanup                            |
| 2         | Browser; Custom account target; Custom prefix; Model policy                                                                              |           4 | Identity/constraint arbitration; shared prefixes with explicit authorized selection; command-owned necessary cross-table writes        |
| 3         | Builtin credentials; Model provider credentials; Automatic OAuth/DCR; Gmail, Calendar, and Forms watches                                 |           6 | External I/O outside transactions; complete credential writes; authorized watch publication with the accepted gaps and delayed cleanup |
| 4         | Morning Brief preference and native schedule                                                                                             |           2 | Respect the latest user choice; independent preparation; local conditional publication; remove the outer transaction and lock polling  |
| 5         | Stripe customer, organization purchase, subscription synchronization, allocation, plan change, invitation purchase, and invitation email |           7 | Local desired subscription state and daily Stripe convergence; deduplicated financial effects; local atomic financial writes           |
| 6         | Usage display, credits/allowance, compaction shared and exclusive acquisition                                                            |           4 | Accurate settlement and amount conservation; display may lag; bounded local compaction/deletion without a global advisory barrier      |
| 7         | SSH owner and the three VNC acquisition definitions                                                                                      |           4 | Existing credential/host identity checks; conditional resource updates; deletion cannot revive revoked authority                       |
| **Total** |                                                                                                                                          |      **28** | **Zero production acquisition definitions**                                                                                            |

Release 1 has one integration owner and one PR,
[#37313](https://github.com/okou-ai/okou/pull/37313). Independent work may proceed
concurrently in isolated worktrees with clear scope owners, and all effective
changes are integrated into that PR. Shared files and expected merge conflicts
are coordination information, not reasons to serialize independent work.

Coordinate actual shared behavior:

- Credits and compaction share settlement and entitlement-refresh paths.
- Allocation and invitation purchase share Stripe projection updates.
- Credential services share refresh infrastructure; watches consume the same
  account identity and credentials.

The final implementation must follow the constraints above, even where earlier
discussion proposed new revisions, operation columns, generation pointers, or
versioned storage. Those table- or field-adding proposals are not part of this
target; declarative Stripe synchronization has no schema exception.

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

| Wave                                                    | Work                                                                                                                                                                                                                                                                                                 | Required compatibility                                                                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release 1: prepare and directly retire compatible paths | Complete replacements using existing business data under the accepted contracts. Retire non-GA paths directly and GA paths compatible with every supported writer. For remaining GA paths, retain only the advisory coordination and transaction boundaries needed to coexist with the outgoing API. | Outgoing code and Release 1 remain correct together. Every writer that Release 2 will overlap with must already support the replacement protocol.                                  |
| Release 2: complete retirement                          | Remove the remaining advisory calls and proven temporary compatibility boundaries, including trigger/FK transitions. Finish only transaction ownership steps explicitly required to remain with outgoing writers, retire prepared operator/function compatibility, and repeat the whole-API sweep.   | Release 1 and Release 2 coexist safely without relying on the removed locks. Incompatible pre-Release-1 writers are no longer serving, in flight, or retained as rollback targets. |

Every R2 boundary needs a concrete outgoing-writer dependency and an already
implemented R1 replacement protocol. Missing conditional writes, unbounded
current-writer work, transaction forwarding without such a dependency, and
trigger-dependent business logic are unfinished R1 implementation. They cannot
be assigned to R2 merely because that release is planned.

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

For declarative Stripe synchronization, document the existing source records
and intent ownership across supported old/new writers and webhooks. An old
provider snapshot must not erase a newer user choice in those records. There
is no new subscription table to initialize or keep synchronized. Evaluate
compatibility against the accepted daily convergence contract: temporary
provider quantity/schedule drift alone is not a reason to retain an old lock.
Payment and entitlement effects still require their own compatibility evidence.

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
replacement design is already complete. Additional releases need a concrete
implementation or compatibility reason; package numbering alone is not one.

Completion requires:

- Zero advisory acquisitions in production code, retained operational tools,
  executable fixtures, and functions in the final database schema.
- Transaction-owning commands accept no `db` or `tx`, acquire their own database
  through `set(writeDb$)`, and complete their own local transaction.
- Zero database or transaction handles forwarded out of those commands, and
  zero transaction objects escaping their local transaction callback.
- Zero external I/O or workflow-spanning work inside those transactions.
- Zero new database tables or persisted fields introduced by this cleanup,
  including its Stripe subscription projection; no new persisted coordination
  state hidden inside existing fields.
- Zero application-defined database triggers in the final schema; their business
  transitions are explicit in command-owned SQL.
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
Apply the accepted product tradeoffs to test expectations: retain normal
trigger delivery, recovery to a working subscription, local disable, authorized
source selection, basic deduplication and correct settled amounts. Do not assert
uninterrupted Forms/Calendar delivery, exhaustive replay of their accepted
outage windows, immediate removal of every remote candidate, exact realtime
call counts or prefix exclusivity.
Shared-prefix tests must cover explicit selection and rejection of ambiguity
without credential disclosure. Usage display checks must allow delayed refresh
while obtaining accurate settled amounts from the authoritative read path.
Subscription tests construct choices and assert outcomes through user-accessible
APIs while exercising the normal reconciliation path. Assert convergence to the
latest desired configuration after reconciliation, recovery of a missed sync
and financial idempotency on repeated reconciliation. Do not require every
intermediate Stripe quantity/schedule to match immediately or pin an exact
remote call order.

Track advisory definitions, transaction propagation, and transaction-held
external I/O separately in each package. Record constraints that are not yet
resolved instead of treating a lower advisory-lock count as completion.
