# Guarded initial-receipt replay version READ

Related to #37513. This D12 increment owns only the StorageVersion READ in the
initial-receipt-matched sandbox storage replay branch. It does not close the
parent issue or complete storage/database/transaction ownership migration.

Implementation baseline: `73ddcf90af7e260d331987c18b380970afb59590`.
The relevant service, route, storage schema, DB provider and engineering guidance
are unchanged from the approved design baseline
`7341256d123ca8583d5af1537afe80c5b827297c`.

## Private graph and guarded consumption

`createSandboxStorageCommit` prebuilds a private
`createInitialSandboxStorageReplayVersion(storageId, versionId)` computed from
the verified plain request's `args.storageId` and `args.versionId`. Its callback
obtains `get(db$)` locally. Construction performs no provider access or SQL.
No DB/Tx/accessor/node/AbortSignal is transported into the new factory, and no
state slot, manual cache, invalidation counter or command-time graph is added.
The public operation interface remains only `{ commit$ }`.

The unchanged storage webhook route constructs the operation after body and
sandbox-auth validation, before command execution. The command retains its
caller-owned final positional AbortSignal and this order:

1. Initialize the existing writer with `set(writeDb$)`.
2. Await the unchanged mounted helper and retain all its internal Abort checks,
   its asynchronous return, the command's outer Abort and mounted-error gate.
3. Conditionally read the unchanged initial receipt, then check Abort.
4. Require a receipt and retain the original version-equality/content-hash guard
   and its short-circuit order.
5. At the old helper call's position, await `get(initialReplayVersion$)`.
6. Retain the original command Abort, missing-version 404, and deduplicated
   success response, including `Number(version.size)` and `version.fileCount`.

At step 5, `receipt.versionId === args.versionId`, so the prebuilt request
version binding equals the original helper's receipt version binding. The
lookup still uses request `args.storageId`, not the mounted storage identity.
No eager read or prefetch precedes these guards. Mounted rejection, absent
receipt and either replay mismatch issue zero targeted version SELECTs; a
matched receipt issues one on first consumption in the fresh request Store.
These are source/control-flow counts, not measured runtime counts.

## SQL and decoded row contract

The READ retains `.select().from(storageVersions)`, the storageId and id
`eq` predicates in that order, `and`, and `LIMIT 1`. Bindings remain
`[args.storageId, args.versionId, 1]`, equal to the previous
`[args.storageId, receipt.versionId, 1]` at the guarded consumption point.
No JOIN, ORDER BY, extra tenant condition, cast, clock, lock or raw row schema
is introduced. Zero rows still return `undefined`; one row returns the official
Drizzle-decoded table row.

All nine official columns remain selected:

| Column property | Existing runtime contract                     |
| --------------- | --------------------------------------------- |
| id              | Non-null varchar(64) string, primary key      |
| storageId       | Non-null UUID string                          |
| s3Key           | Non-null text string                          |
| size            | Non-null bigint, existing number-mode decoder |
| archiveSize     | Non-null bigint, existing number-mode decoder |
| fileCount       | Non-null integer number                       |
| message         | Nullable text; SQL NULL remains null          |
| createdBy       | Non-null text string                          |
| createdAt       | Non-null timestamp with existing Date decoder |

No assertion, coercion decoder or reduced projection replaces these columns.
The response-level `Number(version.size)` is preserved, not a new safe-integer
or precision guarantee. Query rejection still propagates before the following
Abort check; no catch, retry, fallback or new provider cancellation is added.
Both DB nodes use the existing lazy `db()` provider; this does not promise a
shared statement snapshot/client or replica behavior. Writer initialization
and initial receipt consumption still precede the new READ's provider access.
Target transaction, lock, write and external-I/O deltas are zero.

## Independent observations and remaining debt

The original `findStorageVersion` signature and its prepare, generic commit and
terminal-retry callers remain unchanged, including their independent timing.
Locked transaction version SELECTs do not consume this computed. D10's initial
receipt and all maintenance guard/post-lock receipt rechecks remain independent;
no initial cached fact replaces a later current/locked/transactional fact.
D11 mounted ownership remains deferred, with every helper/outer Abort boundary
unchanged. D7, full D9, full H1/H1a and whole-parent closure are outside this PR.
No imports, protocol/schema fields, auth/body/expiry guards or clock operations
change. Existing old/new API, Runner, App and persisted shapes remain compatible;
no migration, activation or deployment is performed or authorized here.

The supported HTTP route creates a fresh Store per request and invokes this
operation once. Repeated calls in the same Store can reuse the computed row or
`undefined` where the imperative helper previously re-read. Same-Store repeat
freshness and mid-lifecycle mutation of supposedly fixed request identities are
not established; no state/manual invalidation is added to hide that limitation.

## Verification boundary

Normal formatting, targeted static checks and mandatory commit hooks are
reported separately at handoff. They do not establish public acceptance,
SQL execution/plans, runtime query counts or exact clock/microtask equivalence.
Existing tests and mocks are unchanged. No local Vitest, development server,
production SQL, dependency/tool installation, resource override or hook bypass
is used for this increment.

WHCB-09 ordinary HTTP sandbox commits and WHCB-10 terminal/retry regressions
remain source coverage, not proof of the private attested receipt-replay branch.
Internal fixtures and excluded maintenance boundary tests are not public
acceptance or a newly executed PASS. Still unproved are public construction of
that replay, provider-error versus Abort interleavings, in-flight query
cancellation, races between independent reads, lock-wait/current-statement
behavior, latency/resource effects, exact scheduling and same-Store freshness.
No stronger guard, lock/CAS, timeout, retry or exactly-once claim compensates for
these gaps. Draft PR creation is the implementation handoff, not code LGTM,
review/merge authorization, deployment approval or completion of #37513.
