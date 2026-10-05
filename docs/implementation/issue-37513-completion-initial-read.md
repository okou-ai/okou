# Completion initial Run READ ownership

Related to #37513. D6 ownership-only slice; parent remains partial.

## Scope and identity

Original baseline `caddf459b1af9dedd4ab9ecc99d96bf228b720b0`; authorized main
integration baseline `4844ec7dd63b7854700dc2eb43f5fcf9ba9b41b3`. Only the completion
service, completion route and this English record change. No tests, schema,
locks, retry protocols, query conditions, transaction boundaries or D4b actions.

Private `createInitialCompletionRun(runId, userId)` owns the initial Run SELECT
through local `get(db$)`. Public `createAgentRunCompletion(runId, userId)` takes
only plain identity strings and exposes only `{ complete$ }`. The old Db-taking
initial helper is removed without an adapter or public READ export. Original
plain auth/body/optional checkpointless input and final caller AbortSignal stay.

The route's async request computed only validates/derives body and constructs
an inert private authorized-completion computed. Its construction does not
verify tokens, read clocks/key env or access DB. After the original body await,
post-await abort check and invalid-body return, the handler synchronously reads
that node, without a new await/check. The node calls the unchanged
`getSandboxAuthForRun` once and returns null or the same verified auth plus a
business graph constructed inside the computed, never inside the command.

The sole production factory consumer derives captured Run ID from the same
validated body; original token verification establishes auth.runId equality.
Captured user ID is that same verified auth.userId passed to complete$ with the
unchanged body. No second token decode, raw-header service capture, user fallback,
new runtime identity guard, org predicate or UUID restriction is introduced.
No accessor, node, executor, Store, Db/Tx or signal enters either factory.

Fresh Store per Hono invocation and a single handler call remain the actual
lifetime. No mutable identity slot, manual cache/reset/reload or consumption
guard is added. Same-Store repeated-command freshness is not newly guaranteed.

## Ordering, exceptions and cancellation

Preserved chain: existing path/query validation → body validation await →
original caller abort check → bad-body return → synchronous original sandbox
auth verification/rejection → completion action → local set(writeDb$) → initial
computed SELECT/parse await → original abort check → null 404 or timeout settled
response → original checkpoint preparation/transaction loop → slot release LAST
→ expiry → outcome recording → conditional separate D5 READ → original final
abort check/response → route scheduling/required/background dispatch.

Auth verification remains after the abort boundary and before DB initialization.
Existing key-env/HMAC/schema exceptions are not caught, translated or advanced;
existing exp/now check runs once there. Invalid body or pre-auth abort never
verifies auth. The auth node is synchronous: no new yield/expiry/abort window.
Construction is graph-only, not authority from unchecked header data.

Retained set(writeDb$) stays before initial get, preserving original singleton
initialization/error order. Both providers resolve the same Drizzle/Pool, not a
replica or transaction replacement. No pre-SQL abort guard is added: an abort
after the route check still permits the original initial query before the
original post-query check. Query/status-parse exceptions retain their precedence.
Caller signal stays final; no computed captures it or invents a new controller.

## Actual 17-column query contract

The actual source projection is **17**, not the earlier dispatch estimate 18.
Order: id, apiStartedAt, error, orgId, sessionId, status, userId,
cancellationRecoveryCompleted, chatThreadId, triggerSource, launchSnapshot,
langfuseTraceEnabled, modelProvider, modelProviderCredentialScope, selectedModel,
modelRuntimeProvider, modelRuntimeModel. No additional field is invented.

All selections retain the real runtime agentRuns column objects and their schema
encoders/decoders: UUID identities, Date timestamp, text/varchar fields, booleans
and the existing JSONB launchSnapshot contract. Existing column NULL boundaries
remain; no coercion/default/new JSON validation is introduced. Missing row returns
null; existing `runStatusSchema.parse(run.status)` remains before the command's
post-await abort check, including its original invalid-status exception.

Same Run ID + verified user ID predicates; LIMIT 1, no ORDER BY, join, lock or org
condition. Expected bindings are Run ID, verified user ID, 1. Actual source-based
offline real-schema serialization/projection evidence is reported separately,
not inferred from a fake builder, type annotation or diagram.

Initial query count is zero before valid body/auth completion admission and one
per real completion action reaching the initial load, including absent/timeout
Run or a later abort. Locked Run in each original transaction remains a distinct
observation; it cannot replace the initial precheck. D5 post-commit and future
D4b before/after required-dispatch reads remain distinct temporal facts, without
shared cached queries merely because identity overlaps.

## Transaction ledger and retained capabilities

Target initial READ explicit TX 0 → 0. Transactions removed/combined/moved: zero.
Original transaction loop, Thread-identity retry and row fences/locks remain;
original slot release is LAST SQL for a committed attempt. Checkpoint/Pi storage
locks, metadata, preparation, expiry, terminal outcome clocks and callback/
accounting/realtime capabilities remain with their original owners. This is not
whole-owner Db/Tx closure, new snapshot semantics or exactly-once delivery.

## Coverage and verification boundary

Inspected real Hono/contract helpers and public fixtures: malformed/incoherent
body 400, mismatched token Run 401, verified missing Run 404; public combined,
repeated/conflicting completion, cancellation recovery, checkpoint and missing
checkpoint outcomes. Existing internal blob/failure/timeout fixtures are not
promoted to public acceptance. No assertion/test or production test hook changes.

Gaps remain: malformed body plus expired/key-error auth or pre-auth abort;
token expiry during body await; verified same-Run/wrong-user rejection; malformed
persisted status before abort; precise post-initial-read abort; initial vs locked
Run deletion/Thread changes; same-Store repeated command use; D5 exact duplicate
redrive, concurrency/Abort and Thread-retry timing. G1 enabled recovery and
maintenance boundary execution gaps remain independent. Green CI, source
inspection and offline SQL do not close these gaps or prove runtime performance.

Normal frozen install and effective executable hooks were verified with
repo-local Ethan Zhang <ethan@okou.ai>, Lefthook 2.1.16 and pnpm 10.33.4; no
inherited disabling/identity/resource/hooksPath override. D6 has no types deferral
or hook exclusion: all normal applicable checks, full types, Knip and commit-msg
must succeed. Original D5/G1 OOM/glob/loader failures remain historical failures.

Actual three-file formatting, affected Oxlint including the ordinary 128 rule,
ESLint, type-aware Oxlint and whitespace checks exited 0. Actual source-extracted
baseline helper/new computed audit ran through installed public ESM/tsx and real
runtime schema exports: exact SQL/ordered bindings match, 17 projected columns
retain identical column encoder/decoder owners. No DB connection or SQL execution.
Complete code diff inspected: no new production import edge/back-edge; existing
route/auth/service/schema dependencies remain. This is not public timing proof.

Knip/full local types/complete hooks/commit-msg and natural exact-head CI remain
pending, not predeclared successful. Results or a fail-fast STOP will be handed
off separately. Responsibility-specific private query/auth factories avoid inlining
or compressing the 17-column query into the business command; only actual lint
can establish the ordinary 128 rule. No suppressions/config exceptions.

No local Vitest/devserver, pr-auto, forced history, resource changes, queue/merge,
production activation/release/deploy, issue closure or other-owner action. New
head requires fresh independent full review after natural CI; D4b is not a
functional prerequisite and receives no borrowed authority.

## Fail-fast STOP: original D6 normal commit

The sole normal commit attempt used no hook exclusion or disabling environment.
Hook Prettier and style-policy emitted successful output; Knip emitted 47 hints,
but no complete terminal hook summary was captured. The tool command exited 137.
Kernel evidence at 2026-10-05 10:58:07 records tsc OOM (anonymous RSS 3,443,544 kB)
and the same tool process-group kill including git, pre-commit, Lefthook and
Turbo. This is current kernel-confirmed OOM, not a diagnosis from exit 137 alone.

At the original STOP, HEAD remained
`caddf459b1af9dedd4ab9ecc99d96bf228b720b0`. No D6 commit, push, PR or CI existed. Full local types, complete pre-commit and commit-msg did not complete;
Knip hints are not terminal PASS. No retry, cache chase, resource change or old
D5/G1/D4b waiver transfer occurred. Three-file staged draft remains; this final
STOP evidence update was unstaged and retained for explicit resumption. No
formatting/check or restaging followed the original failure before new authority.

## Authorized latest-main integration

Ethan explicitly authorized resuming this existing three-file draft and creating
its first PR after normal latest-main integration and full checks. The original
combined draft SHA256 `9fd75fb3ff4b429f5cecadf42b65ecb3697d35d6990fff4696c35698f6e095ea`
was verified before changes. Original staged and unstaged content was preserved
through a normal stash/index restoration and fast-forward to
`4844ec7dd63b7854700dc2eb43f5fcf9ba9b41b3`, with no history force or overwrite.

Main's merged API typecheck implementation adds foundation/admission declaration
boundaries and three test partitions; those upstream scripts/configs remain
unchanged. This is not a D6-authored resource/checker/concurrency change or waiver.
Target owner/route, DB provider/columns and lockfile remained unchanged; the
previous actual source-derived SQL/17-column audit remains applicable and is not
rerun merely to pursue green checks. Updated API testing guidance was inspected.
Executable current hooks, Lefthook 2.1.16, pnpm 10.33.4, repo-local identity and
absence of disabling overrides were reverified; frozen install succeeded.

The original tsc OOM remains FAILED. Whether current main resolves the local
failure is determined by actual complete normal checks, not assumed from a main
commit or prior CI. No types deferral or exclusion is authorized; full types,
Knip, all applicable normal hooks and commit-msg remain required. Their results
and natural new-head CI will be reported separately, without predeclaring PASS.
