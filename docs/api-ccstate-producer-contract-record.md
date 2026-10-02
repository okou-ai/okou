# Historical producer-contract increment — superseded by main cutover

Base: `9a36876ff31aa2b5bba1cd2f7ce8ac79c92f6461`, existing Draft PR #37525.
This is a record/reference increment, **not a patch to blindly cherry-pick onto
main**. Published main `311b1e0` deletes `agent-run-execution.service.ts` and
`claim-run-context.ts`; `thread-claim-run.service.ts` now owns the chat core.
Main's Pi Phase 2 worker uses `startMaintenanceRun$` from
`pi-memory-maintenance-execution.service.ts`. Do not restore the deleted legacy
execution paths or producer/callback hooks during integration.

## Evidence and historical changes

Before editing, repository-wide source search found `dispatchFailedCallbacks`
only in the optional command/run fields, the build-args forwarding assignment,
the failed writer's conditional dispatch and claim Omit types. No external
assignment or command implementation existed. `DispatchFailedRunCallbackInput`,
its db field, the injected `DispatchFailedRunCallbacks` command and forwarding/
conditional execution were removed. Ordinary persisted Run callback rows and
HTTP/internal callback contracts remain unchanged.

`PersistProducerRunBinding(tx, run)` had one implementation: Phase 2's closure
that called `credential.validate(tx)` and bound only pending maintenance runs.
The build-args wrapper additionally requested Stage 1 for pending thread runs.
It is replaced by private, non-persisted `RunProducerBinding` data containing an
optional Phase 2 binding/proof and a Stage 1 request flag. No schema migration,
coordination column, lock, retry, timeout or test hook is added.

Credential preparation still performs its original external refresh/decryption
before admission, but returns encrypted snapshot proof rather than a validator
capturing tx/signal. `run-producer-binding-plan.ts` constructs finite pure SQL
validation/binding steps. Pending launch executes them through its existing
owner-local tail loop; failed launch executes the same proof validation locally
but never binds the job or requests Stage 1. The class identity and error classes
used by the worker are preserved through imports from the defining contract
module, without re-export adapters.

The plan preserves storage/head ownership SHARE, unlocked exact connected-account
checks, API key/share validation and custom reference -> connection SHARE ->
secret SHARE -> surface SHARE order. Whole ciphertext/account/custom snapshots
and the sorted Codex encrypted quota pair remain exact comparison inputs.
Current feature flags are rechecked. Job binding retains tenant/user/storage,
lease+sandbox token, revision, base version, selection digest, null maintenance
Run and unexpired lease predicates. A lost bind throws to roll the launch back.
The pending core's final unique active Run insert remains unchanged and last.

`AtomicLaunchRunInput.db` is removed and the failed writer obtains
`set(writeDb$)` itself. Only the necessary lower input literal is adapted;
upper execution factories at 17000+, pick and queue were not edited. Parent's
concurrent lower snapshot cleanup must be preserved during semantic porting.

## Porting boundary and residuals

All edits to the deleted execution/claim files, the old injected contracts,
`buildCreateAgentRunArgs` wrapper and the old maintenance bind helper are
superseded on new main. The proof types, precise comparison conditions, finite
validation steps and lease-bind predicate are reference material only. Parent
must compare them with the new maintenance executor and avoid installing a
second executor or copying obsolete session/runner ownership into the new core.

This is not global terminal conformance. Broader Phase 2 preparation, quota,
maintenance-completion and storage helpers retain their existing handle-taking
interfaces outside this finite producer-contract scope. No broad memory or
billing governance was attempted. The new main architecture, its types and its
public behavior are not verified by this historical branch's checks.

## Verification and timing

Affected Prettier, ESLint and normal Oxlint pass, including unchanged complexity
and owner-size limits. The explicit execution-owner 128-line rule also passes.
No Vitest, dev server, whole types, Knip, type-aware whole API or CI was run.
The 45-minute delivery target was missed and was reported to the parent before
claiming the work ready. Integrated/main-cutover verification remains with the
parent. No parent branch push, PR, review, merge, queue or automation was created.
