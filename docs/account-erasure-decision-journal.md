# Dormant account erasure decision journal

[G2d1a #34205](https://github.com/vm0-ai/vm0/issues/34205) implements an initially
empty, independent PostgreSQL journal for the [B1 projection](account-erasure-foundation.md).
It is internal persistence, with no production ingress, worker, bridge, signing,
retirement or restore-admission implementation. Platform billing is preserved;
other account-owned data, including Stripe/banking connector business content,
is subject to erasure. This journal must not become a permanent nonbilling archive.

## Separate installation and connection

| Surface                    | Boundary                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Schema                     | `turbo/packages/db/src/erasure-journal/schema.ts`, outside main's `src/schema/*` glob and `src/index.ts` schema aggregate            |
| Generated SQL and metadata | `turbo/packages/db/erasure-journal-migrations/`, independent of `src/migrations/` and its numbering                                  |
| Generate                   | From `turbo/packages/db`, run `pnpm journal:generate`; Drizzle owns SQL, snapshots and journal metadata                              |
| Explicit installation      | Import `migrateErasureJournal` from `@okouai/db/erasure-journal/migrate` and call it with an explicitly authorized control-store URL |
| Runtime                    | Import `createErasureJournal` from `@okouai/db/erasure-journal` and pass an explicit PostgreSQL URL and canonical authority UUID     |
| Migration ledger           | `erasure_journal_migrations.__drizzle_migrations` inside the separate control database                                               |

Neither import nor client creation runs DDL or appends a decision. Main
`db:generate`, `db:migrate`, `db:reset`, prepare and release paths do not install
the journal. No production environment variable is added or required, and the
client never reads or falls back to application `DATABASE_URL`. Empty or
incomplete URLs fail before connecting. The explicit migrator uses the genuine
independent generated chain and may be replayed; it is not an operational
provisioning command or authorization to access production.

Two databases on one development server prove the code and migration boundary.
They do **not** prove independent production IAM, restore lineage or backup/key
lifecycle. Actual infrastructure has not been verified. G2d1b must establish those
facts before activation, whether it reuses suitable infrastructure or provisions
another store. Moving these tables to a schema/pool in the application database
would not satisfy [ADR 0004](adr/0004-account-telemetry-recovery-erasure.md).

## Exported contract

`createErasureJournal(connectionString, authorityId)` returns four methods:

- `append(input: JournalAppend): Promise<ErasureDecision>` commits one decision.
- `readWatermark(): Promise<JournalWatermark>` returns `{ authorityId, sequence }`.
- `readPage({ afterSequence, watermark, limit })` returns `{ decisions, watermark,
nextAfterSequence, done }`.
- `close()` releases the client's connections. No caller-owned transaction or
  callback can be supplied to the journal.

`JournalAppend` contains every B1 decision field except `authorityId` (bound at
client construction) and `decisionSequence` (allocated in the transaction):
subject kind/ID, generation, decision reference, confirmation reference,
predecessor reference or explicit null, disposition version, requested time and
deadline. UUID references must be canonical lowercase hyphenated UUIDs.
`confirmationRef` is the stable event identity for idempotency, **not authentication**.
The caller must retain the exact input across uncertain responses. The journal
generates no references or deadlines, including on retry or reconstruction.

Subjects distinguish `user` from `organization`, retain case, and accept 1–192
UTF-8 bytes. Versions are positive PostgreSQL integers. Dates must be finite,
with deadline later than request; persisted timestamps retain the millisecond
precision of the JavaScript Date input. Schema-column decoders preserve bigint
sequence values, including values above JavaScript's safe-integer range. Sequence
and watermark APIs use `bigint`, never JSON numbers; a future wire bridge must
encode them losslessly. Every read validates the complete B1-compatible projection
and authority before returning it; malformed persisted fields fail closed.

The first append binds the singleton authority head to the supplied authority
UUID. An empty, installed store returns watermark zero. A differently bound
client fails once that head exists. The same decision or confirmation reference
with changed fields is a conflict; an exact retry returns the original complete
decision and sequence, even after a later generation or sequence exhaustion.
Subjects share one explicit predecessor chain: an initial decision has a null
predecessor and any positive generation; a successor names the latest decision
and strictly advances generation, matching B1's gap-tolerant contract. Concurrent
first decisions or successor forks cannot both commit. The singleton head is
never rebound through this API.

## Commit order and failure handling

Each append runs in a SERIALIZABLE control-store transaction:

1. Create the initially empty head if needed, then lock its singleton row.
2. Check the bound authority, exact decision/event retry and subject predecessor.
3. Insert the immutable decision with `committedSequence + 1`.
4. Update the head to that sequence and commit both atomically.

The lock stays held through COMMIT. A later writer cannot allocate its sequence
until the earlier writer commits or rolls back. Rollback advances neither the
stream nor its watermark; readers see only committed rows. This establishes
commit order without `nextval()` allocation order. The head serializes appends
across subjects; throughput remains an activation measurement, not a production
performance claim.

Only SQLSTATE `40001` (serialization) and `40P01` (deadlock), which abort the
transaction, retry, at most five total attempts. The same captured immutable input
is used each time. Connection/unknown-commit failures, constraint errors, lock
and statement timeouts propagate without producing an authority receipt. The
caller can retry the exact input after reconciliation. Connections use a 10-second
connect/statement/idle-transaction bound and 1-second lock timeout. No transaction
spans the other database, KMS or provider network calls.

## Bounded replay and two-store protocol

A caller first reads a committed authority-bound watermark, then requests pages
with `0 <= afterSequence <= watermark.sequence` and integer `1 <= limit <= 100`.
A future watermark, wrong authority, invalid cursor or limit fails. Each page uses
`decision_sequence > afterSequence AND decision_sequence <= watermark.sequence`,
ascending primary-key order and LIMIT. There is no offset scan. Concurrent appends
do not enter the pinned replay. Resume from `nextAfterSequence` until `done`;
re-reading a page after interruption returns the same retained decisions.
The watermark is an observation, not a signature, ACK, or promotion attestation.

The synthetic protocol, using real B1, is:

1. Await the external append's COMMIT.
2. Separately call `projectErasureDecision` in the application database. It must
   finish its own commit before a future B2 bridge can complete its ACK/fence gate.
3. If the application write fails, leave the external decision intact. On restart,
   read and project it again. Exact B1 replay returns the same job.
4. For an application restore, replay **all retained applicable decisions** in
   sequence order, beginning at zero unless a trustworthy checkpoint proves a
   complete prefix. Requested time before the restore point does not exclude a
   decision: its job may have been incomplete or missing in the restored copy.
5. Advance a durable replay cursor only after the application projection commits.
   A crash between that commit and cursor persistence causes safe duplicate
   projection. Restored jobs may receive new local job IDs; all authority fields,
   references and deadlines remain identical.

This slice does not implement the production bridge, ACK, cursor scheduler,
producer fences (B2), recovered-identity reconciliation, admission leases or
promotion (G2d2). It never uses missing optional `users` rows to infer deletion.

## Verification and activation gates

`DATABASE_URL=<development server URL> pnpm test:erasure-journal` creates two
uniquely named disposable databases, applies the genuine main and independent
migration chains, and exercises the exported journal and actual B1 operations.
The existing migration-consistency CI runs this focused script. Tests cover
concurrent append/rollback visibility, exact retry/conflicts, predecessor forks,
canonical UUIDs and subject domains, bounded SQLSTATE recovery, unavailable control
store, pinned multi-page replay (203 decisions in 100/100/3 pages), abrupt child-process
exit after COMMIT, application rollback/restart, missing projections,
bigint precision/exhaustion, strict reads and independent main reset/replay.
Test-only locks/triggers and injected corrupted values model infrastructure faults;
no production or historical payload is used.

G2d1b must implement and verify trusted ingress, signing/verification, key lifecycle,
role/IAM separation, rejection of old retired events, and finite decision/backup/
export retirement before production activation. This API deliberately exposes no
retirement/delete operation; a boolean, TTL or UUID cannot prove retirement.
B2 activation also needs its actual ACK/bridge/fences and B1-S claim-scale gates.
Broader purge requires A2 billing isolation and domain collectors/handlers.
No production readiness, physical erasure, restoration safety or parent-EPIC
completion is established by these development tests.
