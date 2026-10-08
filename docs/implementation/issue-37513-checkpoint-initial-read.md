# Initial checkpoint Run/session READ ownership

Related to #37513. D8 is separate from the deferred D7 cancellation-redrive
identity-source work. This is a bounded READ slice, not whole checkpoint-owner
or transaction closure.

## Scope and graph ownership

Baseline: `bd1325fac1869a939f3f4fd83f250e084db72b2e`.

`createAgentCheckpointOperations(runId, userId)` accepts plain verified identity
and returns only `{ prepare$, create$ }`, the business operations needed by the
two real consumers. A private initial context computed obtains `get(db$)`
locally. Both commands are constructed inside the owning factory and share
that private dependency lexically. No DB/accessor/executor/node injection,
parameter state, manual cache/reset/reload, or computed-captured signal is added.

Combined completion instantiates this factory inside the existing
`createAgentRunCompletion` factory. Its command consumes `prepare$` only in the
original checkpoint-input branch after its initial nonmissing, nontimeout Run
read. No input or initial timeout means zero checkpoint initial SELECTs.

Standalone creation derives an inert authorization computed from validated body
identity. After the original body await, abort check and bad-body return, the
route synchronously consumes authorization once and constructs the business
graph there. Construction adds no auth, HMAC, env, clock, await or DB work.
Invalid body/auth means zero initial SELECTs; valid creation means one. The
original `settle`, foreign-key-to-404 conversion, rethrow and post-await abort
remain in place. History upload preparation's route is unchanged.

Each operation graph is request-owned. Internal computeds and raw context rows
are not exposed. Original auth/body/source options and prepared/error response
unions cross business boundaries as plain values. Caller AbortSignal remains
the final positional argument.

## SQL and temporal contract

The initial READ retains exactly these six projections, in order:

1. `agentSessions.conversationId` as `agentSessionConversationId`;
2. `agentRuns.chatThreadId`;
3. `agentRuns.launchSnapshot`;
4. `agentRuns.status`;
5. `agentRuns.storageMounts`;
6. `agentRuns.sessionId`.

It retains Run INNER JOIN session on session id, Run id + verified user id
predicates, LIMIT 1, no ordering and bindings `[runId, userId, 1]`. Real schema
columns continue to own encoders/decoders; nullable values remain nullable.
Missing row remains `undefined`. Status parsing still occurs before the original
post-await abort. No org predicate, identity fence, guard, lock, CAS, clock,
retry, timeout, fallback, receipt or outbox is introduced.

Standalone creation still obtains `set(writeDb$)` before preparation; preparation
still obtains its own writer before awaiting the initial READ. Those acquisition
and error boundaries remain because maintenance/validation/commit work retains
its existing capabilities. `db$` and `writeDb$` both call the same lazy singleton
Drizzle/Pool provider in `lib/db.ts`; this introduces no replica.

Preserve initial READ -> abort -> missing-row response -> type rejection ->
standalone unsettled rejection -> maintenance read/abort -> conditional Pi
validation. The separately locked checkpoint context remains inside its owning
transaction. No D6 initial Run row, D5 post-commit callback row, or D4b
before/after-dispatch row is reused: they are independent temporal facts.

Target READ transactions: zero. Transactions removed, moved or added: zero.
Checkpoint commit, locked admission, blob/refcount/session writes, private
maintenance, upload, Pi validation, completion Thread retry, slot-release-last,
usage and storage boundaries remain unchanged. Residual module Db/Tx arguments
and helper capabilities are explicitly not migrated in this slice.

## Imports and size

New runtime imports are `computed`, local `db$`, and the operations factory in
its two actual consumers. Existing Run/session columns and query/status helpers
are reused. The checkpoint module does not import completion; there is no new
runtime back-edge, dynamic import or credential captured by the business
factory. Existing Pi/S3/maintenance import initialization is retained.

The private READ, operations factory and route nodes use normal responsibility
boundaries, not compressed lines or lint exceptions. Ordinary 128-size and
other static checks must establish their actual rule-scoped result.

## Verification boundaries and history

The first completion edit was rejected by the precise-edit tool because one
oldText matched both an import and a command call. The entire rejected call
wrote nothing; the route was also unchanged at STOP. That actual failure remains
non-PASS. Partial draft SHA256 was
`89f9a5274906e628315565a8efa34dfb947b4bf80282162605f3066a3bbde9db`.
Explicit resumption verified HEAD/draft and used three unique disjoint contexts.
This does not retroactively turn the rejected edit into a successful operation.
Earlier D6 OOM/hook history and D7 dependency remain unchanged.

Two later tool failures also remain non-PASS: the hand-written Oxlint executable
path was absent (exit 127; lint never started), and the first offline audit
invocation changed cwd to the API package then failed its root-relative source
read (ENOENT, exit 1; comparison assertions never executed). Each caused STOP.
Explicit resumption used project-local `pnpm exec` for lint and then an explicit
verified git root for the audit source read, without changing the comparison
assertions, source baseline or project configuration.

Ordinary scoped Oxlint (including 128-size), type-aware Oxlint and ESLint each
exited 0. The actual-schema public ESM/tsx audit subsequently exited 0: baseline
helper and new private computed produced identical SQL, INNER JOIN and ordered
bindings, with all six identical official column encoder/decoder owners. It
used an offline Drizzle builder, with no DB connection or SQL execution. Static
and SQL evidence are not public timing acceptance. Frozen installation exited
0 with pnpm 10.33.4; full applicable hooks, including types and Knip, are
required without exclusions before commit.

Existing public lifecycle cases cover generic/Pi combined checkpoints, generic
cancellation recovery, timeout acknowledgement, late cancellation checkpoint,
and standalone pending rejection followed by combined checkpoint. Natural PR
CI logs must establish actual current-head suite execution; historical green
runs and test names alone do not do so. Exact auth-expiry/abort timing and initial
versus locked session/Thread-change schedules remain unverified. No tests are
changed, no production hooks or forced races/sleeps are added, and no internal
DB/mock count assertion is introduced.

#37513 remains OPEN/PARTIAL. D7 is deferred, not complete. D4b remains
independently owned; this work carries no queue, merge, release or deployment
authority.
