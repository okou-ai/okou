# Advisory Lock Retirement Constraints

This guide retains the accepted engineering constraints and product tradeoffs
from the September 29–30, 2026 retirement decisions. It defines the target, not
a claim of implementation or production completion. Implementation inventories,
worker assignments, release packages, and acceptance receipts belong in their
owning issue or PR.

## Binding Constraints

- No advisory acquisitions remain in executable application code, retained
  operators, executable fixtures, or functions in the final database schema.
  An earlier KEEP classification is not a permanent exemption.
- This retirement adds no tables, persisted fields, or coordination state hidden
  in existing JSON. Reuse actual business identities, state, and constraints.
  The briefly considered subscription-table exception was withdrawn.
- Do not replace advisory locks with explicit row locks, retry loops, `NOWAIT`,
  `lock_timeout`, a generic mutex, lock table, or claim/lease framework.
  PostgreSQL's implicit statement and constraint locks remain normal SQL behavior.
- No application-defined business triggers remain in the terminal schema.
  Express transitions in the owning SQL rather than moving coordination into
  trigger functions. Follow the [trigger policy](eslint/no-database-trigger.md)
  for narrowly scoped, temporary outgoing-schema compatibility.
- Keep external I/O outside transactions and preserve authorization, credential
  ownership, recoverable financial correctness, and exact-resource cleanup.
- Preserve shipped migration history. Historical SQL is not a live acquisition
  merely because its text remains in the repository.

Indexes or constraints over existing fields are allowed when the actual business
contract requires them. If a replacement cannot meet the accepted constraints,
record its specific unresolved gap rather than adding hidden coordination state
or weakening a retained correctness guarantee.

## Transaction Boundaries

The September 30 Release 1 priority update made command ownership and remaining
`db`/`tx` propagation non-goals for that release's acceptance. Preserve existing
conversions without turning remaining propagation into an invented release gate.
The prohibitions on external I/O and advisory-lock replacement machinery still
apply.

For new API work, the current
[API ccstate rules](api-ccstate.md#10-keep-database-handles-local-and-prefer-atomic-sql)
are stricter than the earlier general short-transaction examples: introduce no
non-billing transactions, and justify every necessary billing transaction.
One atomic statement needs no transaction wrapper.

The target ownership shape is one ccstate command acquiring `set(writeDb$)`,
opening and awaiting its necessary local transaction, and executing SQL directly
inside the transaction callback. Keep `db` and `tx` inside that owner. Do not
pass them through helpers, services, argument objects, injected contexts,
callbacks, state, or escaping closures. Exchange ordinary inputs and committed
results between commands; pure calculations and SQL builders use ordinary values.

Keep HTTP, Stripe, Clerk, OAuth, KMS, R2/S3, realtime publication, remote
pagination, and lengthy preparation outside SQL transactions. Awaiting another
command that performs that work does not make the transaction local or short.
Do not split required financial atomicity into independently committing writes
solely to remove a transaction.

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

### Accepted Product Tradeoffs — 2026-09-29

The September 30 decisions below supersede earlier stronger ordering proposals.
These are retained exceptions, not new behavior introduced by documentation
cleanup.

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

## Verification and Completion

Trace actual writers and their existing SQL, constraints, provider identities,
and supported old/new consumers. Lower acquisition counts do not prove
financial correctness or complete retirement.

Apply [deployment compatibility](deployment-compatibility.md) only to an actual
changed consumer or schema boundary. Do not invent an App upgrade, Runner drain,
extra preparation release, or fixed elapsed-time gate merely because those
surfaces exist. A source merge is not deployment evidence.

Completion requires no executable advisory acquisitions, no new coordination
state or terminal business triggers, no transaction-held external I/O, and the
required observable correctness and cleanup. Assess operator and reader
retirement against their actual data-convergence conditions. Track remaining
handle propagation separately from the historical Release 1 acceptance scope.

Tests use production caller boundaries. Do not hold locks, install blocking
triggers, inspect waiters, or add private gates to assert an implementation.
Apply the accepted watch gaps, display delays, and configuration drift to
expectations while retaining normal delivery, repair, disable, explicit
connector selection, authorization, accurate settlement, and financial
idempotency. See [Testing](testing.md).
