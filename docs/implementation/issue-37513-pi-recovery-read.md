# Pi Phase 2 recovery read ownership

Related to #37513. This is the G1 recovery READ slice, not completion of the
Pi worker, callback target, or parent issue.

## Baseline and scope

The original draft starts at main `8caba6bb173c6390afff8a215678ae19909cfd69`.
The resumed responsibility repair fast-forwards normally to
`eee341aeb89028f2670ff390fb1b8a997af7caeb`, and the authorized types-to-CI
resumption normally integrates main
`6b9ecd1a3c299773cfa7452431180df7cef1a9af`. The audited worker, cron, providers,
three direct service-test consumers and applicable lint/hook configuration are
unchanged; newer unrelated test and Runner changes are retained without edits.

The scope is six files: the worker, production cron, three service-test
consumer migrations, and this acceptance record. No job, launch, callback,
completion, checkpoint, publication, schema, configuration, or test-surface
implementation changes are included.

## Graph and work-unit ownership

Before this slice, the cron calls the exported `executePiMemoryPhase2Work$` with
`{ scope, currentTime }`. It obtains a write handle and passes it into
`recoverMaintenanceRun$`, which owns both recovery SELECTs and the recovery
action. Only an absent or invalid recovery candidate falls through to claim.

`createPiMemoryPhase2Worker(scope?)` now exposes only `execute$`, called with
plain `currentTime: Date` and the caller-owned final `AbortSignal`. The factory
captures only the optional complete owner scope: memoryStorageId, orgId, userId.
Three plain-scope factories construct the graph before execution. The private
candidate factory returns only its leased-job computed. The private recovery
factory constructs that candidate once, captures its node lexically, and returns
only its business recovery command. The public worker factory captures that
command lexically and returns only execute$. No factory receives a node,
accessor, Db/Tx, executor, or signal; no public node bundle is introduced.
The resulting graph contains two private computeds and two private commands:

- `leasedJob$` owns the candidate SELECT and obtains `get(db$)` itself.
- `recoveryRun$` obtains `get(db$)` and derives its run identity from the same
  private leased-job fact. Reading that dependency reuses this work unit's
  already resolved candidate, not another SELECT.
- `recoverMaintenanceRun$` consumes those facts lazily and owns the unchanged
  recovery action. It accepts only currentTime and signal; each write branch
  obtains its own local `set(writeDb$)`.
- `execute$` retains its initial write-handle acquisition, cancellation check,
  awaited recovery action, outer cancellation check, and claim/start/fail order.

The production cron constructs the graph outside its command. The production
scope remains undefined. `honoSignalHandler` creates a Store per request and
invokes the handler once. An admitted handler invokes execute once; failed auth
or the disabled breaker invokes it zero times. The contract is one work unit
per graph and Store, not one global execution. No runtime consumed flag exists.

All direct tests construct a new graph before each Store action. The shared
ordinary `work()` helper constructs one outside its clock callback, preserving
its captured Store. Direct argument expressions also construct their graph
before `store.set` executes; none runs inside a ccstate command. Existing Store
creation sites, clocks, signals, assertions, loops, and concurrent batches are
unchanged. There is no compatibility command, parameter state, node injection,
manual cache, reload/reset counter, signal capture in a computed, or dynamic
Run-ID factory.

## Statement order and cancellation

1. Execute obtains writeDb and checks cancellation, as before.
2. Recovery awaits the candidate, then checks cancellation.
3. The original truthiness check runs. No candidate or an invalid candidate
   returns undefined without consuming recoveryRun; the original claim follows.
4. Only a valid candidate consumes recoveryRun, then checks cancellation.
5. Missing Run: the existing fenced fail helper runs, followed by the existing
   cancellation check; the outcome remains failed even if transition returns
   false, not stale.
6. Active Run: the unchanged lease UPDATE runs, followed by its existing check.
7. Terminal Run: the unchanged generic callback dispatcher runs.
8. Execute retains the outer post-recovery check before returning or claiming.

Recovery reads total one SELECT for absent/invalid candidates and two for valid
missing/active/terminal candidates. This count excludes conditional claim/fail
transactions and the generic dispatcher's own independent reads. Construction
performs no query, action, clock read, or write. There is no pre-UPDATE guard.

Both db$ and writeDb$ call the same singleton `db()`, wrapping the same singleton
Postgres Pool. They are not primary/replica or transaction-specific providers.
Provider acquisition does not itself execute SQL. Teardown resets remain owned
by the existing provider; no cross-reset identity guarantee is added.

## Preserved database and action contract

The candidate projection remains the same eight schema columns. Its conditions
are leased status, non-null maintenanceRunId, and the optional three exact owner
identities; ordering remains leaseExpiresAt ASC, LIMIT 1. There is no expiry
filter, tie-breaker, second-candidate scan, lock, or transaction. Revision zero
remains invalid under the historical truthiness check, along with the existing
run/token/base checks and sandbox-token equality.

Run lookup selects only status, with run ID, org ID, user ID, LIMIT 1. The
statements remain separate; no JOIN, stronger snapshot, or revalidation is added.
Columns still own their runtime decoders and predicate encoders.

Active extension still changes leaseExpiresAt to currentTime plus one hour and
updatedAt to currentTime. Its four predicates are storage identity, exact run,
lease token, and sandbox token. No status/tenant/revision/expiry predicate or
RETURNING is introduced.

Missing failure retains the exact three owners, tokens, claimed revision/base,
currentTime, exact maintenance run, allowExpiredLease true, and
maintenance_run_missing error class. Terminal dispatch still maps completed to
completed and every other terminal status to failed with `Run ended as ...`.
It still rereads Run, feature-switch context, and callbacks, selecting pending
or failed callbacks with the original null/internal-kind exclusions and no new
ordering. Callback payloads, HMAC, delivery updates, and idempotency are untouched.

The cron's nowDate remains after auth/breaker and its check. Dispatch-failure
nowDate sites remain after the existing settle result. Factories/computeds do
not advance clocks. Existing external I/O stays outside its original SQL
transactions. No frontend, Runner, payload, persisted shape, deployment floor,
or old/new wire compatibility boundary changes.

## Exact remaining capability edges

Removed: execute's Db argument into private recoverMaintenanceRun, including
its use as the recovery candidate and Run READ capability.

Retained, not declared architecturally closed:

- recovery's locally obtained Db into failPiMemoryPhase2Job;
- recovery's locally obtained Db in dispatchRunCallbacks input, including that
  dispatcher's own Run/context/callback READ and delivery paths;
- execute's Db into claimPiMemoryPhase2Job;
- execute's Db into failClaim and onward into failPiMemoryPhase2Job;
- startMaintenanceRun's existing preparation, failed-launch persistence, commit,
  activation, checkpoint/completion/publication and credential capabilities.

The active UPDATE remains inline; no separate active-lease public command is
introduced. D1/D2/D3 and HTTP/internal dispatch contracts are not migrated.
The AgentRunContextSignals exception is neither used nor extended.

## Explicit transaction ledger

Recovery READ and active UPDATE: zero explicit transactions before and after.
Removed: 0. Combined: 0. Moved: 0. All existing downstream owners are retained:

| Owner                                                        | Conditional execution and retained boundary                                                                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| claimPiMemoryPhase2Job, job service                          | Only after no recovery; existing storage/candidate/job locks, selection and lease transaction                              |
| failPiMemoryPhase2Job, job service                           | Missing recovery Run or existing failed claim paths; exact-fence SELECT FOR UPDATE and UPDATE RETURNING transaction        |
| failMaintenanceLaunch, maintenance execution service         | Launch preparation failure after admission; failed-run/callback persistence and credential validation transaction          |
| commitMaintenanceRun, maintenance execution service          | Successful launch path; atomic Run, Runner job and binding commit transaction                                              |
| handlePiMemoryPhase2MaintenanceCallback, maintenance service | Eligible terminal callback observation after original payload/selection validation; Run/job/checkpoint/receipt transaction |

This is a static owner ledger, not a claim that all transactions execute on every
action. Existing downstream publication transactions and external-I/O boundaries
are unchanged; none is removed by moving the recovery reads.

## Consumers and coverage boundary

The only production action consumer is the phase2 cron. Route registration and
the Vercel cron contract test consume its route array, not execute directly.
Direct service-test call sites on the baseline:

- pi-memory-phase2-worker.service.test.ts: 164, 211, 302, 332, 377, 389, 464,
  512, 610, 728, 918, and shared work helper 1063.
- pi-memory-phase2-usage.service.test.ts: 165 and 573.
- pi-memory-maintenance.boundary.test.ts: 295, 477, and 1079.

Same-Store scenarios include switch-off/due retry, repeated dispatch recovery,
cross-lease recovery, three hourly credential attempts, quota retry/no-work/
committed recovery, post-commit abort recovery, and quota exhaustion. Their
existing clocks, action counts and provider HTTP-count assertions are retained.
No assertions are deleted, weakened, or added. These historical service/DB
assertions are not promoted to target public acceptance evidence.

The public cron test only covers invalid auth 401 and disabled all-zero 200.
It sets the background-worker breaker false. Enabled recovery is not covered.
The existing stage1 suite has an owner-scoped cron test surface; phase2 has no
corresponding existing exported scoped route or phase2 test-state surface. A
global enabled phase2 cron may consume another concurrent test's rows; isolation
cannot be replaced by clock partitions, locks, direct DB setup or cleanup.

Minimal public-evidence proposal for a separately approved coverage slice:
identify an approved owner-addressed existing test-surface boundary, create
normal demand through real owner/storage/run/Stage1 endpoints, and exercise
repeated admitted HTTP requests with observable responses and existing Run
reads. This requires scope/test-surface decisions beyond these six files; it
must not silently export a new production hook or add historical-row setup
controls. Invalid legacy candidates and missing historical Runs remain separate
unconstructible-state gaps. No sufficient enabled recovery public acceptance
is claimed here, and CI green alone would not establish it.

## Verification status

Normal frozen dependency installation succeeded with pnpm 10.33.4. Installed
lefthook 2.1.16 has executable pre-commit and commit-msg hooks; their contents and
effective configuration were inspected, with no exclusions/disable overrides.
Repo-local author identity is Ethan Zhang <ethan@okou.ai>. Tool-discovery and
source-search failures are not successful checks.

The original draft stopped correctly on Oxlint exit 1: the single worker
factory counted 165 lines against the ordinary 128-line maximum. That historical
failure is not retroactively a pass. The previously reported autonomy-budget
refusal remains a refusal, not evidence of execution or a permission to change
the budget. Explicit subsequent authorization permits only the three-factory
responsibility repair and normal G1 verification; D4b's types-to-CI deferral
and the earlier D2-only heavy-check deferral do not apply.

The current repair does not change the line rule or its configuration. Existing
signal-owner exceptions still name only pick-chat-run and thread-claim.
For the three-factory repair, affected-file formatting, Oxlint (including the
ordinary 128-line rule), ESLint and type-aware Oxlint completed successfully.
The temporary CommonJS SQL audit subsequently failed with exit 1 and
ERR_PACKAGE_PATH_NOT_EXPORTED before comparing SQL: the real DB package exports
runtime/schema subpaths only under import/types, not require. That failure
triggered STOP and remains a historical tool failure, not a SQL discrepancy.

Explicit user resumption permits fixing only the temporary tool loader. The
corrected ESM audit uses the project's installed tsx with static imports through
those real package exports, without package/config/dependency changes or deep
imports. Executed once from the worktree root:

```sh
./turbo/node_modules/.bin/tsx /home/user/workspace/g1-esm-audit/audit.mjs
```

It passed exact source-derived old/new Drizzle serialization for both SELECTs
and the active UPDATE under global and complete owner scope, using fixed
synthetic time/identities. SQL text and ordered bindings matched in all six
comparisons; the selected column/decoder owners matched. Drizzle's offline mock
builder serializes the real schemas; it executes no SQL, queries no database,
and provides no behavior or cancellation acceptance evidence.

The subsequent normal `git commit -F` attempt executed the installed
pre-commit hook without exclusions. Hook Prettier and style-policy passed;
Knip emitted configuration hints, but the final hook status was not captured.
The tool command then terminated with exit 137. Kernel evidence at
2026-10-05 07:18:31 shows the tsc process in this tool's process group selected
by the OOM killer (anonymous RSS 3,487,588 kB), followed by group termination
of git, pre-commit, lefthook and Turbo. This is observed OOM evidence, not an
inference from exit 137 alone; it does not establish which API type subproject
completed or passed.

At that stop, HEAD remained `eee341aeb89028f2670ff390fb1b8a997af7caeb`:
no commit, push, PR or natural CI was created. Full types, complete pre-commit
and commit-msg did not complete; Knip was not declared a pass from hint output
alone. The six-file staged draft was retained, with the final evidence update
left uncommitted. No rerun, exclusion, resource/budget adjustment, or D4b/D2
deferral was used before that stop.

### Separately authorized G1 types-to-CI resumption

Ethan subsequently authorizes only `check-types` deferral for this small G1 PR
and its current normal commit. This is new G1 authority, not a transferred D2
or D4b exception. Full natural new-head CI types, Knip, eight API shards and the
four required gates remain mandatory. No CI configuration is changed.

The first official v2.1.16 documentation lookup returned HTTP 404; the decoding
pipeline exited 1. Work stopped without a commit or retry. This remains a
historical tool failure, not a project check failure or an exclusion proof.
A separately authorized single lookup of the coordinator-confirmed official
version path then succeeded and decoded real content:

https://github.com/evilmartians/lefthook/blob/v2.1.16/docs/usage/envs/LEFTHOOK_EXCLUDE.md

It documents exact command-name exclusions. The effective local binary remains
2.1.16; executable pre-commit/commit-msg contents and configuration were
reinspected. Repo-local identity remains Ethan Zhang <ethan@okou.ai>; no
inherited disable, identity override, or hooksPath override is present.
The existing source-derived ESM SQL audit is retained, not rerun.

The normal commit uses only `LEFTHOOK_EXCLUDE=check-types`. This does not
exclude the turbo group, Knip, commitlint, or another command/tag. Its actual
skip and terminal results must be recorded from the normal commit hook log,
not inferred from this documentation or the earlier Knip hints. All applicable
remaining pre-commit checks and commit-msg must succeed before push/PR;
non-applicable file-glob skips are distinct from successful checks. No forced
commit, hook/config exception, resource change, local Vitest/devserver, CI
rerun, protected-queue request, merge, deployment, or issue closure is authorized.

At commit preparation, the normal hooks and natural new-head CI are still
pending; their eventual evidence belongs in the PR handoff. Historical lint,
loader, OOM and documentation-lookup failures are not retroactive passes.
Enabled public recovery acceptance remains unproven regardless of CI green;
the exact retained capability and coverage boundaries above still apply.
