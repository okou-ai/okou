# Issue #37513: deleted-Thread inline callback write ownership (D2)

Related to [#37513](https://github.com/okou-ai/okou/issues/37513).
This is one bounded write slice, not completion of the callback or threadless
cleanup modules or of the overall architecture target.

## Baseline and actual call graph

Current baseline: `cf155ac9e19c1ce08a1a55fa43f97ff5da358d7f`.
The original uncommitted draft was based on
`1261224f046ba759c162f5e35b9aebdc65334023`; a normal fast-forward preserved it.
The affected production files and routed practices are unchanged between these
baselines. Paths below are relative to `turbo/apps/api/src/signals/`.

Before:

- `cleanupThreadlessRuns$` in `services/threadless-run-cleanup.service.ts`
  calls private `redriveTerminalLifecycle$({ db, candidate }, signal)`.
- Redrive performs the existing cancellation/completion effects and then calls
  `failPendingInlineOnlyDeliveryCallbacksForDeletedThread(db, candidate.runId)`
  in `services/agent-run-callback.service.ts`. This is its only caller. Redrive
  needs the passed handle only for this final callback UPDATE.

After:

- Cleanup calls private `redriveTerminalLifecycle$(candidate, signal)`.
- Redrive calls the module-scope
  `failPendingInlineOnlyDeliveryCallbacksForDeletedThread$(runId, signal)`.
- The callback command locally obtains `set(writeDb$)` and executes the original
  UPDATE. The command returns `Promise<void>`; it adds no state or result slot.

Three capability edges are removed: the handle-taking callback API, the
`redriveTerminalLifecycle$` handle argument/destructure, and cleanup's handle
injection into redrive. No accessor, node, adapter, compatibility wrapper,
closure input, dynamic import or command-time graph replaces these edges.
The new command is defined once at module scope. Redrive remains private.

## SQL, encoding and clock contract

The statement remains one UPDATE with no SELECT or RETURNING:

- SET `status = failed` and `lastError =
Chat thread was deleted before inline callback delivery`.
- WHERE `run_id = runId AND status = pending AND internal_kind IN (...)`.
- The six values retain their exact order: `slack:chat`, `feishu:chat`,
  `teams:chat`, `telegram:chat`, `github:chat`, `slack:org`.

The retired GitHub/Slack kinds still recognize historical rows and remain
excluded from ordinary HTTP dispatch. Null/HTTP kinds and existing
failed/delivered rows are not newly eligible. No attempts, lastAttemptAt,
deliveredAt or createdAt value is reset. The schema has no updatedAt column.

There are ten bindings: two SET values, runId, pending, and six kinds. The UUID,
varchar and text schema-column encoders remain unchanged. There is no returned
row or raw selected expression, so no new result decoder boundary. Neither the
original statement nor the new command reads a clock; createdAt's INSERT default
is not invoked by this UPDATE. No explicit transaction, lock, CAS, retry,
query-plan rewrite or extra SQL round trip is introduced.

An offline source-derived builder comparison can establish SQL text and ordered
bindings/encoder parity without executing SQL. It is supplemental evidence, not
proof that historical production rows were exercised or that every plan and
concurrent schedule was measured.

## Signal and orchestration ownership

The cleanup caller's AbortSignal stays the final positional argument throughout.
The sequence remains cancellation/completion side effects, the existing abort
check, callback termination, the post-write abort boundary, and then
`deleteIfStillEligible`. Existing checks in redrive and cleanup remain.

The new command checks immediately after its non-signal-aware UPDATE. There is
no additional pre-UPDATE guard: cancellation during that statement still allows
the already-started write to finish before rejection, as before. The existing
caller post-write check remains at the same business boundary; the command's
local check owns its database await. No signal is passed into a factory or
captured in a computed, and no new independent cancellation owner is created.

Quiet-window comparison and its exact boundary, protected Pi rules, existing
locks, Run deletion, external resource receipts and recovery remain unchanged.
External I/O stays outside the deletion transaction. Callback termination is
not newly coupled atomically to Run deletion; the existing cleanup owner can
revisit an eligible surviving Run through its existing lifecycle.

## Transaction ledger and residual scope

For this callback-write slice: removed **0**, combined **0**, retained **0**,
moved **0** explicit transactions. It remains one standalone UPDATE.

The existing transaction inside `deleteIfStillEligible` is unchanged and outside
D2: it revalidates/locks the Run and protection state and owns conversation/Run
removal and reference receipts. This document does not claim that its helper/tx
capability chain meets the complete target.

Deferred: `loadThreadlessRunCandidates`, `deleteIfStillEligible`, protection
callbacks/Pi, ordinary HTTP/internal callback dispatch and READ/undelivered
helpers, and D1's private callback bookkeeping. Cleanup still obtains its own
write handle for these unchanged read/delete chains. No whole-module database
ownership completion is claimed. D1's shared-file overlap is not a merge-order
reservation or an authorization to change its work.

## Public coverage and verification boundary

`routes/__tests__/cron-cleanup-sandboxes.test.ts` retains real API scenarios:
publicly launch a Run, complete it through Runner callbacks, delete its web
Thread, invoke owned-ID-scoped cleanup, and read the Run through the public API.
Existing cases cover threadless processing, waiting immediately before the
quiet-window boundary, deletion at that boundary, and unresolved cancellation
recovery. Existing protection cases and callback/lifecycle assertions remain
unchanged.

These scenarios do not contain fixtures for all six inline callback kinds and
must not be described as proving historical-row UPDATE matches. No DB-row,
log, internal-mock assertion, production test hook, forced interleaving or
retired-behavior negative test is added. No new externally observable behavior
was introduced that requires a duplicate public case.

### Local failures and explicitly deferred resource checks

The initial author-identity preflight failed with exit 128 before any commit.
After explicitly authorized local identity setup, the normal Git commit attempt
triggered pre-commit and was terminated with exit 137. Kernel evidence records
OOM killing the compiler and the hook/shell process group. No commit or push
occurred. Full local types and the complete hook chain remain incomplete; the
Knip output alone does not establish a separately captured successful exit.
These historical failures are not reclassified as passes.

Ethan subsequently explicitly directed D2's resource-intensive types/Knip
validation to the PR CI environment. Only this D2 commit uses the installed
lefthook 2.1.16 single-name mechanism,
`LEFTHOOK_EXCLUDE=knip,check-types`, scoped to that command invocation. Its merged
configuration contains exactly these two exclusions. The configured jobs have
no matching inherited tags; commitlint and all other applicable lightweight
jobs remain enabled. No tracked/global hook configuration, CI definition,
timeout, compiler budget or suppression is changed. This is not a permanent
exception or authority for D1 or any other PR.

Local affected ESLint, Oxlint, type-aware lint, formatting and source-derived
SQL comparison are reported separately from the actual lightweight Git hooks
and commit-msg results in the PR handoff. No local Vitest or dev server is run.
Full local types/Knip are explicitly deferred, not local passes. The new head's
natural CI must actually pass shared/app/API aggregate type/lint checks, Knip,
eight API shards and four required gates. No baseline result or skipped job
substitutes for those checks. There is no blind rerun or protection bypass.
Independent review and any eventual protected merge require separate
authorization.
