# Completion post-commit terminal-redrive READ ownership

Related to #37513. D5 is a bounded READ slice, not completion of the webhook,
callback dispatcher, Pi architecture, or parent issue.

## Scope and identity

Baseline main: `1931f04221f64f604ccb1c6791c94bef111c94ed`. Exactly three files:
completion owner, completion route, and this record. Full source/import/registry
inspection finds one direct production completion consumer: the completion
webhook route. Tests consume its unchanged route array through HTTP, not the
completion command. The lifecycle module imports only the distinct side-effects
core and input type.

The public `createAgentRunCompletion(runId)` exposes only `{ complete$ }`.
Its input remains the original plain auth/body/allowCheckpointlessSuccess and
final caller AbortSignal. The private plain-run-ID query factory constructs one
lazy computed; it obtains `get(db$)` locally and performs the actual schema-aware
SELECT. No DB/Tx, node, accessor, executor, callback, or signal is injected.
The old global completion export is removed without a compatibility adapter.
Initial load, checkpoint preparation, transaction and expiry helpers remain
unchanged and explicitly capability-bearing.

Package-scope `completeRequest$` derives the factory from the same validated
body whose object the handler passes into completion. The existing sandbox
signature/token/run-ID check still follows body parsing and its abort check.
Verified token userId/runId/orgId are not synthesized. Initial and locked Run
queries retain body runId plus auth userId, without adding an org predicate.
The response side-effects ID remains input.body.runId; persisted Run supplies
org/user/thread identities. No new UUID validation/cast or identity fallback.

The actual app mounts `honoSignalHandler`, which creates a new Store per request
and invokes the handler once. Completion is called at most once per request;
invalid body/auth does not execute the completion action or callback READ.
Construction executes no SQL. There is no consumed guard, mutable parameter
slot, cache/reset, runtime command construction, signal in computed, dynamic
import, or public READ-node bundle.

## SQL, ordering and cancellation

Only after the original transaction loop commits, existing time-budget expiry
finishes, and completion outcome recording runs does the original short-circuit
condition consume the computed:

- not transitioned;
- committed Run status is completed or failed;
- selected callback ID is not undefined.

The computed has not been consumed by construction, initial load, checkpoint,
transaction, expiry or outcome recording. It observes an independent post-commit
statement, not a cached initial/locked snapshot. Original final caller abort
check and completionResponse follow in place. No pre-SELECT abort guard is added;
the query itself remains uncancellable, with the original owner check afterwards.
Existing nowDate/now/telemetry positions and best-effort error behavior remain.

Projection remains schema callback id; predicates remain runId, internalKind
chat, status pending/failed; LIMIT 1 and no ORDER BY/lock/join/new tenant fence.
Missing row remains undefined; id remains the schema's non-null primary-key UUID,
and SQL NULL internalKind is not coerced into chat. Preserve the real column's
encoder/decoder and ordered bindings; no schema or raw-result cast is introduced.

Target READ is zero on early exits, first transitions, cancelled/timeout states,
or preceding failure; one on a committed duplicate completed/failed run. Empty
and nonempty results both cost one SELECT. Other owners' initial/locked/expiry/
dispatch queries are excluded from this ledger, not removed. No added SELECT,
ordering tie-breaker, CAS, lock, retry, timeout, outbox or exactly-once claim.
Both db$ and writeDb$ resolve the same existing singleton Drizzle/pg Pool, not a
replica or transaction-specific connection. Teardown resets remain unchanged.

## Transactions and explicit residuals

Target READ explicit transactions: 0 before / 0 after. Transactions removed 0,
combined 0, moved 0. Existing completion transaction remains one per loop attempt
(retry may create further attempts; early exits may create none). Original lock,
checkpoint/terminal/Pi handling and slot release LAST SQL stay in that owner.
External checkpoint preparation remains before the transaction; time-budget
expiry, telemetry, callback delivery/accounting/publication remain outside it.
No surrounding transaction is declared eliminated or executed on every request.

Removed: only completion's post-commit Db-to-undelivered-query READ edge.
Retained: Db into initial load; Tx into transition/lock/checkpoint/terminal/Pi/
slot helpers; Db into expiry and its read/revoke; required-dispatch pre/post
reads until D4b lands; dispatcher Db/read/delivery; lifecycle/background usage,
accounting/publication; cancel's shared undelivered helper. That helper remains
for its other callers; no opaque adapter hides those capabilities.

## D4b integration and coverage

D4b is not a functional prerequisite. If it lands first, extend its existing
completeRequest result with completion while preserving requiredChatCallback.
If it lands later, preserve this completion graph. Do not restore a global
command or reserve merge order for conflict avoidance. D5 post-commit READ and
D4b before/after dispatch READs must own distinct computeds: their temporal
observations and counts are not interchangeable even with identical SQL shapes.
No new completion-owner-to-route/required-service runtime import is introduced;
existing lifecycle/dispatcher edges are retained.

Existing HTTP regressions cover combined completion, duplicate/conflicting exit,
checkpoint 400, settled Run status, failure recovery, successor/session resume,
missing checkpoint, cancellation and timeout. Real Thread send/pick/claim and
webhook helpers mount the production boundary with fresh request Stores. Public
Run/Thread responses are evidence; historical DB/blob/failure-reason fixtures
and internal callback seeds are not promoted to target acceptance.

Precise duplicate terminal + undelivered chat row timing, delivery changes
between commit/READ/required dispatch, post-commit abort schedules and exact
Thread-identity retry interleavings remain disclosed gaps. Ownership-only scope
is approved with those gaps; no new test files, internal mocks/DB/log assertions,
fixture controls, production test hooks, forced races or sleeps are introduced.
Maintenance boundary execution and G1 enabled recovery gaps are not closed here.

## Verification status at preparation

Normal pnpm 10.33.4 frozen install completed; effective executable Lefthook
2.1.16 pre-commit/commit-msg and configuration were inspected. Repo-local author
is Ethan Zhang <ethan@okou.ai>; no inherited disable/identity/resource or
hooksPath overrides. At that preparation snapshot no D5 exclusion was
authorized. Prior G1/D4b types waivers apply only to their old PRs; their
lint/loader/OOM/404 failures remain historical failures, not D5 passes or
exemptions.

Actual three-file formatting, affected Oxlint (including ordinary 128-line
rule), ESLint, type-aware Oxlint and diff whitespace check completed with exit 0.
The installed ESM/tsx audit extracted the actual baseline helper/new private
computed query expressions through TypeScript AST and real official schema
imports. Drizzle offline serialization matched exact SQL and ordered bindings
(runId, chat, pending, failed, limit 1); projection and PgUUID decoder ownership
matched. Audit exit 0. No SQL, connection, provider or behavior execution; this
is not timing/cancellation acceptance or proof of the disclosed public gaps.

Full types, Knip, normal pre-commit/commit-msg and natural exact-head CI remain
pending at this preparation snapshot. Their actual results or any fail-fast
STOP will be recorded before handoff; prior waiver/hints do not substitute for
success. No local Vitest/devserver, resource adjustment, pr-auto, queue/merge/
release/deployment or issue closure.

### Fail-fast stop after the normal commit attempt

The sole normal commit attempt used no exclusion or bypass. Hook Prettier and
style-policy reported successful output; Knip emitted 47 configuration hints,
but no complete terminal hook summary was captured. The command exited 137.
Kernel evidence at 2026-10-05 09:46:08 records tsc selected by the OOM killer
(anonymous RSS 3,465,328 kB), followed by termination of the same tool's git,
pre-commit, lefthook and Turbo process group. This confirms current OOM; exit
137 alone is not the diagnosis. No type subproject or terminal Knip success is
inferred from partial logs or the next process having started.

At that STOP, HEAD remained baseline
`1931f04221f64f604ccb1c6791c94bef111c94ed`. No D5 commit, push, PR or CI existed.
Full local types, complete pre-commit and commit-msg did not complete. The
three-file staged draft remained, with the stop-evidence update unstaged. No
retry, cache chase, exclusion, resource adjustment or G1/D4b waiver transfer
was performed.

### Explicit D5-only resumption

Ethan subsequently authorized deferring only command-name `check-types` to
natural exact-head CI for this D5 current normal commit. This is new D5-only
authority, not a G1/D4b or future-task waiver. Lefthook 2.1.16 official
`docs/usage/envs/LEFTHOOK_EXCLUDE.md` documents exact command-name exclusion.
Only `LEFTHOOK_EXCLUDE=check-types` is authorized; local types remain deferred,
not PASS. All other applicable hooks, Knip and commit-msg require actual
terminal success. Full natural CI types must not be excluded.

The actual combined draft SHA256
`78e1287e6239e5915a5cb3fe01ce6f9492c02375878c7b34fdc7678a66a6767e`, baseline,
branch, executable effective hooks and repo-local identity were verified. A
successful fetch resolved main to `8d8d1d834311025e35f74937f999b87f6a7f5c94`;
bounded comparison found no changes in the target code, callback helper, db
provider, reviewed guidance, hooks or lockfile paths. The isolated branch is
retained; no other contributor's workspace or history is rewritten.

An auxiliary `ls` discovery used an unmatched `g1*lefthook*` glob and failed.
Later semicolon-delimited read-only commands returned zero, which does not
retroactively pass the failed ls. Work stopped again before commit or push.
The coordinator explicitly authorized omitting that optional discovery step;
no failed glob, guessed alternate path or broad scan is repeated. This tool
failure and the original kernel-confirmed OOM remain failures.

This resumption stages the original three files including the previously
unstaged OOM record and this evidence update. Existing successful statics and
offline SQL audit remain historical evidence. The normal commit and subsequent
natural CI results will be reported separately; this pre-commit record does
not predeclare their success. No queue, merge, pr-auto, deployment, release,
D4b action or issue closure is authorized.
