# Runner reactor progress

The runner reactor (`crates/runner/src/cmd/start/mod.rs`) selects between
discovery, lifecycle changes, job completion, and maintenance. Some selected
branches await shared resources inline. Work that uses those same resources must
be able to progress independently of the reactor.

## A retained future is not an independent task

Keeping a future outside `tokio::select!` preserves its progress when another
branch wins, but only the reactor polls that future. This can deadlock even when
no mutex guard crosses an await:

1. A retained heartbeat future queues for the idle-pool mutex.
2. Another branch wins. Inline admission or drain queues for that mutex too.
3. The current holder releases the mutex. Tokio's FIFO mutex reserves progress
   for the heartbeat waiter.
4. The reactor is awaiting its own lock request, so it cannot poll the heartbeat
   waiter ahead of it. Other waiters, including finalizers, also stop progressing.

Status retry has the same dependency through the status-state mutex and ordered
persistence. The state-lock case does not require an earlier failed file write.
Persistence timeouts do not bound a wait that happens before persistence starts.

## Ownership and shutdown

| Work                       | Owner and progress rule                                                                                                                                                                                  | Shutdown                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heartbeat                  | One independently scheduled task; triggers coalesce into at most one pending request. The next send uses live state and lifecycle mode. Shared immutable configuration is allocated once per controller. | Natural drain flushes a Stopping snapshot. Common teardown joins the active send before provider shutdown. Abnormal controller drop aborts the task; dropping a client request does not retract a remote request, so snapshot generation/sequence fencing remains required.                                                       |
| Status retry               | One independently scheduled task. State generations, ordered persistence, and atomic-write continuation remain authoritative.                                                                            | Join the retry before final status publication. If the reactor itself is cancelled, the task retains ownership until it finishes.                                                                                                                                                                                                 |
| Routine workspace-cache GC | One independently scheduled task, with a host-global routine flock owning inventory/entry cleanup; capacity protects completion cadence and budget collection.                                           | Join before dependent teardown. Do not abort the task during normal shutdown: filesystem deletion may outlive a dropped async future. If the reactor itself is cancelled, the task retains its locks through completion rather than releasing them over unfinished I/O. Process/runtime termination remains an abnormal boundary. |
| Poll wakeups               | Short synchronous mutex sections protect only in-memory scheduling state. No I/O, await, or long nested work is permitted under this lock.                                                               | Notification registration before state recheck, generation fencing, deferred-poll caps, and cancellation remain unchanged.                                                                                                                                                                                                        |

Task join failures stop the reactor through its existing lifecycle and common
teardown path and are returned as terminal errors. Ordinary optional GC or status
retry errors remain warnings. Runtime task ownership does not make an individual
filesystem or network operation infinitely fast or cancellation-safe.

## Routine GC and promotion capacity

Updated runners serialize routine maintenance with
`workspace-image-cache-routine-gc.lock`. They briefly acquire capacity to check
its existing nonempty completion-file mtime, then release capacity during the
inventory and entry-local stale/temp cleanup. Every such mutation still requires
that entry's nonblocking exclusive flock, so active checkout, sidecar staging and
publication cannot be cleaned concurrently. No entry flock survives inventory.

Afterward routine GC attempts capacity nonblockingly, rechecks the completion
interval and reads fresh filesystem stats. Byte/count pressure observed in the
unlocked inventory, or current free-space pressure, invokes the existing full
collector with a **fresh inventory under capacity**. Unlocked candidates never
authorize budget eviction. Failed work or busy final capacity admission writes no
new completion marker and is eligible for a later retry.

Old runners still use capacity throughout their scans and preserve the original
opaque completion marker. They can overlap an updated runner's unlocked pass;
shared entry flocks protect mutations, and the second interval check observes an
old runner's intervening completion. Manual and promotion-triggered pressure GC
retain their existing capacity ownership. Those collectors can still contend
with promotion; this change removes the updated routine inventory/entry-cleanup
collision window, not contention under genuine pressure or mixed-version scans.
Cache byte/count targets remain periodic GC policy, not a strict per-promotion
whole-cache admission bound. Promotion's free-space/copy and image checks are
unchanged.

Successful routine completion emits `entry_count` (the unlocked candidate
count), `inventory_us`, cumulative `capacity_lock_held_us` (both held phases,
excluding acquisition waits), `budget_gc` and `freed_bytes`. Deferred final
admission reports the inventory and initial held durations. Pressure collection
includes its fresh scan in the held duration. These are phase observations, not
production cold-start savings or wall-clock performance guarantees. The ignored
`measure_routine_gc_inventory_and_capacity_hold` owner test prints representative
local measurements without latency thresholds. It uses temporary files and the
owner tests' injected filesystem budget, so it does not measure production
`statvfs` latency or pressure collection.

## Other retained-work audit

- Discovery remains pinned across reactor turns: restarting it on each tick
  would reset polling timers and discard provider-local state. The direct inbox
  releases its batch lock before returning a candidate; inline batch updates
  follow a completed discovery. Claim cooldown updates have no shared retained
  lock holder that depends on the reactor to resume. PollWakeups is synchronous
  because both retained discovery and inline callbacks access its state.
- Workspace-cache watcher work remains retained with ownership of its watcher
  and drained filesystem events. Its classification does not own an idle-pool or
  status waiter needed by an inline reactor branch.
- Active-run and budget locks protect short synchronous state updates.
- Active/idle transfers and cancellation retain their existing ownership gates:
  contested gates are not awaited while holding the idle pool.

New branches must be checked against both lock holders and queued waiters. Do not
spawn discovery unconditionally or change admission/reuse policy to work around
resource ownership problems.

## Helper recovery and required cleanup

MITM recovery transfers the old child synchronously into one independently
scheduled restart task. That task finishes old-child reaping and launch-directory
cleanup **before** starting a replacement. Each child retains its own stopping
flag and usage identity. Normal shutdown joins in-flight recovery, adopts any
replacement, and then uses the existing usage-flush/proxy-stop sequence. Ordinary
startup failures retain backoff; unknown old-child cleanup failures or recovery
task panics stop the runner and disable further retries. Managed-child Drop
remains the abnormal process/launch reconciliation fallback.
Late crash notifications may retain a follow-up retry, but its timer is not
polled while recovery is in flight: an already expired timer must not spin the
reactor while it cannot yet spawn another attempt.

DNS/kmsg monitor completion starts independently scheduled child cleanup, then
the reactor cancels admission and active runs and publishes Stopping. Each
network-log process retains its cleanup handle for normal shutdown to join;
dropping the reactor does not abort that reaper. DNS cleanup still precedes
runtime/filter removal. Cleanup errors are reported instead of logging a
successful helper stop. Public process/protocol/status schemas are unchanged.

The common teardown entry also publishes Stopping: discovery can return `None`
on cancellation before the mode-change branch wins. Required cleanup must not
leave the persisted mode at Running merely because that branch won the race.
This publication does not turn ordinary discovery exhaustion into hard
cancellation: active jobs still drain normally unless lifecycle signaling stops
them.

## Accepted network-log writes

An accepted row owns its pending completion through its bounded shard queue,
per-path batch and physical blocking append. Normal batch completion still uses
one accounting lock. Registry/accounting critical sections are synchronous and
contain no I/O or await; source-generation checks and Notify registration before
pending-state recheck remain authoritative.

If an outer shard terminates, queued or batched rows that it drops settle as
**failed**, with a warning and a per-session write-failure observation. Guards
inside a started blocking append remain there until the real append finishes:
dropping its async waiter cannot release pending ownership early. Session close
waits for all accepted writes to settle and reports observed write failures even
after source attribution has been removed. It does not claim every row was
persisted when an append failed. Existing best-effort upload and execution-result
semantics are unchanged; potentially partial batches are not replayed.

## Pending-cleanup diagnostics and candidate disposition

Helper reaping, session accepted-write flush and teardown phases emit
`required cleanup still pending` every 30 seconds while unfinished. Warnings
contain component, phase, elapsed milliseconds and a PID or run ID as direct
event fields (Axiom does not inherit span fields). These observers stop when their
scope ends; they never cancel cleanup, discharge pending counts or declare
success. Existing phase-start/completion events remain available. A phase
completion says that its function returned, not that an earlier reported error
was repaired.

| Candidate                                     | Verified disposition                                                                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retained heartbeat/status/GC and PollWakeups  | Independently progressing owners / bounded synchronous state remove the shared-reactor dependency described above.                                                                                         |
| Inline MITM old-child cleanup                 | Moved into the single-flight restart owner; replacement waits for confirmed old-child cleanup.                                                                                                             |
| DNS/kmsg monitor failure and reap             | Cancellation and lifecycle publication no longer wait for child cleanup; normal shutdown retains the join.                                                                                                 |
| Producer drain barriers                       | Request/acknowledgement waits already have bounded, explicit unavailable/timeout outcomes. They do not discharge accepted writes or guarantee data still buffered in the producer/kernel.                  |
| Pending accounting / outer writer termination | Accepted-write guards settle abandoned work as failed. Regression coverage includes queued rows, multiple paths, concurrent waiters and active blocking I/O.                                               |
| Ordinary append failure / blocking-task panic | Settles pending with failure evidence, not persistence success. Files remain available for existing best-effort upload/debugging.                                                                          |
| Genuinely stalled append or filesystem scan   | Required I/O can still wait on the OS. Flush/teardown warnings identify the wait; no timer cancels physical I/O or releases its ownership. Cache scans still depend on filesystem completion.              |
| Physical park / final host idle publication   | Separate phases. A guest park marker is not proof of completed host publication; the later pool dependency was addressed by the reactor slice. Existing finalization and park regressions remain required. |
| OS/runtime starvation                         | The incident samples did not establish OOM, sustained CPU starvation or blocked disk writes. No new kernel/runtime guarantee or incident attribution is claimed.                                           |
| Natural teardown                              | Publishes Stopping before required waits, preserves joins and reports prolonged phases. Real cleanup completion is still required before normal shutdown returns.                                          |

## Coverage and remaining incident work

`cmd/start/tests/main_loop/shared_resource_progress.rs` drives the real `run()`
entry point under forced pool, status-state, and persistence-ordering contention.
It also checks heartbeat-owner failure and GC progress/completion ownership.
Existing heartbeat tests cover coalescing, monotonic sequences, live-mode
follow-ups, and no overlapping requests; provider tests cover wakeup scheduling
and generation/defer semantics.

Helper ownership and lifecycle tests run through `run()` with real
pipe-controlled children and gated child waits. Proxy recovery tests also check
old-launch cleanup before replacement. NetworkLogManager tests exercise real
files, shard panic/cancellation, append errors and pending flush observers.

These are the reactor-progress [#32050](https://github.com/vm0-ai/vm0/issues/32050)
and helper-cleanup [#32051](https://github.com/vm0-ai/vm0/issues/32051) slices
of [#32040](https://github.com/vm0-ai/vm0/issues/32040). Separate slices track
[warn-only promotion drain diagnostics](https://github.com/vm0-ai/vm0/issues/32052),
and [live-runner metric filtering](https://github.com/vm0-ai/vm0/issues/32053).
Neither is replaced by runtime ownership fixes. No matching helper-restart or
writer-shard-failure marker was found in the two original incidents, so these
conditional cleanup defects are not presented as their proven production cause.
