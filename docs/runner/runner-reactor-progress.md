# Runner reactor progress

The runner reactor (`crates/runner-supervisor/src/reactor/mod.rs`) selects between
discovery, lifecycle changes, job completion, and maintenance. Some selected
branches await shared resources inline. Work that uses those same resources must
be able to progress independently of the reactor.

Runner's `cmd/start` remains the boot/configuration/lock composition root. It
subscribes lifecycle signals before slow work and passes owned streams and
concrete factory plans to Supervisor. Runtime entry preserves initial status,
prune binding, provider readiness, factory startup/rollback and ready publication
order. The root's image/base-dir locks and live registry span the full call.
Moving source ownership does not change the progress or cleanup rules below.

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

| Work                  | Owner and progress rule                                                                                                                                                                                  | Shutdown                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heartbeat             | One independently scheduled task; triggers coalesce into at most one pending request. The next send uses live state and lifecycle mode. Shared immutable configuration is allocated once per controller. | Natural drain flushes a Stopping snapshot. Common teardown joins the active send before provider shutdown. Abnormal controller drop aborts the task; dropping a client request does not retract a remote request, so snapshot generation/sequence fencing remains required.                                                                                                                         |
| Admission / claim     | Up to four independently scheduled transactions; authoritative budget and exclusive sandbox reservations remain stricter. Completed results retain a slot until Reactor consumes them.                   | Soft drain stops new admission and settles in-flight results before idle drain or natural completion. Common teardown joins all admissions before idle/provider shutdown. Dropping task handles does not abort pending remote requests; unconsumed successful results schedule tracked no-sandbox completion and rollback. Process/runtime termination remains an abnormal reconciliation boundary. |
| Status retry          | One independently scheduled task. State generations, ordered persistence, and atomic-write continuation remain authoritative.                                                                            | Join the retry before final status publication. If the reactor itself is cancelled, the task retains ownership until it finishes.                                                                                                                                                                                                                                                                   |
| Routine home-cache GC | One independently scheduled task, with a host-global routine flock owning inventory/entry cleanup; capacity protects completion cadence and budget collection.                                           | Join before dependent teardown. Do not abort the task during normal shutdown: filesystem deletion may outlive a dropped async future. If the reactor itself is cancelled, the task retains its locks through completion rather than releasing them over unfinished I/O. Process/runtime termination remains an abnormal boundary.                                                                   |
| Poll wakeups          | Short synchronous mutex sections protect only in-memory scheduling state. No I/O, await, or long nested work is permitted under this lock.                                                               | Notification registration before state recheck, generation fencing, deferred-poll caps, and cancellation remain unchanged.                                                                                                                                                                                                                                                                          |

Task join failures stop the reactor through its existing lifecycle and common
teardown path and are returned as terminal errors. Ordinary optional GC or status
retry errors remain warnings. Runtime task ownership does not make an individual
filesystem or network operation infinitely fast or cancellation-safe.

## Routine GC and promotion capacity

Updated runners serialize routine maintenance with
`home-image-cache-routine-gc.lock`. They briefly acquire capacity to check
its existing nonempty completion-file mtime, then release capacity during the
inventory and entry-local stale/temp cleanup. Every such mutation still requires
that entry's nonblocking exclusive flock, so active checkout, generation staging and
publication cannot be cleaned concurrently. No entry flock survives inventory.

Afterward routine GC attempts capacity nonblockingly, rechecks the completion
interval and reads fresh filesystem stats. Byte/count pressure observed in the
unlocked inventory, or current free-space pressure, invokes the existing full
collector with a **fresh inventory under capacity**. Unlocked candidates never
authorize budget eviction. Failed work or busy final capacity admission writes no
new completion marker and is eligible for a later retry.

Other processes using the same canonical home-cache domain can overlap the
unlocked pass. Shared entry flocks protect mutations, and the second interval
check observes another collector's intervening completion. Manual and
promotion-triggered pressure GC retain capacity ownership and can still contend
with promotion. This removes the routine inventory/entry-cleanup collision
window, not pressure contention. Retired workspace caches are a separate domain;
they are never probed or interpreted as home images. Cache byte/count targets
remain periodic GC policy, not a strict per-promotion whole-cache admission
bound. Profile-bound image eligibility, fresh allocation/reserve and cross-device
copy headroom remain mandatory.

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

## Other retained work

- Discovery remains pinned across reactor turns: restarting it on each tick
  would reset polling timers and discard provider-local state. Candidate
  consumption is gated by available admission slots as well as existing resource
  policy. After submission, discovery waits for local reservation readiness (or
  an early admission rejection) before re-evaluating capacity; remote claims
  remain concurrent. This prevents discovery from outrunning resource reservation.
  The direct inbox releases its batch lock before returning a candidate;
  ready batches submit bounded admission tasks rather than awaiting each claim.
  In-flight Run IDs are deduplicated; original resource/cancellation authorities
  still reject duplicate or ineligible ownership. Claim cooldown updates have no
  shared retained lock holder that depends on the reactor to resume. PollWakeups
  stays synchronous and provider defer/generation rules are unchanged.
- API claim requests own temporary poll exclusions until they settle. Poll uses
  the existing `excludedRunIds` field, prioritizes in-flight claims within its
  contract limit, and preserves the full cooldown inventory for local filtering.
  An empty excluded response, or an API returning an in-flight Run despite the
  exclusions, does not rearm immediate backlog polling. Settlement retires only
  that request's registration and wakes the existing scheduler. This avoids
  repeatedly rediscovering a still-queued claim while unrelated work is waiting;
  no API schema or failure-cooldown policy changes.
- Admission/claim tasks are independent, but post-claim activation and executor
  dispatch remain Reactor-owned. Completed claims may therefore retain bounded
  reservations while activation waits on shared resources. Finalizing reuse
  wakeups observed with all admission slots occupied are retained until a slot
  opens; original preference deadlines remain authoritative. Ordinary shutdown
  never aborts an uncertain claim HTTP request. A completed result lost before
  activation uses the existing completion/rollback policy, including exact
  speculative resources; it does not fabricate a remote result for a failed or
  uncertain request.
- Home-cache watcher work remains retained with ownership of its watcher
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

## Pending-cleanup diagnostics

Helper reaping, session accepted-write flush and teardown phases emit
`required cleanup still pending` every 30 seconds while unfinished. Warnings
contain component, phase, elapsed milliseconds and a PID or run ID as direct
event fields (Axiom does not inherit span fields). These observers stop when their
scope ends; they never cancel cleanup, discharge pending counts or declare
success. Existing phase-start/completion events remain available. A phase
completion says that its function returned, not that an earlier reported error
was repaired.

Producer drain request/acknowledgement waits have bounded, explicit unavailable
or timeout outcomes. They do not discharge accepted writes or guarantee data
still buffered in the producer or kernel. Required appends and filesystem scans
can still wait on the OS: a warning timer does not cancel physical I/O or release
its ownership.

Physical guest park and final host idle publication are separate phases. A guest
park marker does not prove completed host publication; keep both finalization and
park regression coverage. Ownership fixes and diagnostics alone do not establish
a production incident's cause or a new kernel/runtime progress guarantee.

## Coverage

`runner-supervisor/src/reactor/tests/main_loop/shared_resource_progress.rs` drives the real `run()`
entry point under forced pool, status-state, and persistence-ordering contention.
It also checks heartbeat-owner failure and GC progress/completion ownership.
Existing heartbeat tests cover coalescing, monotonic sequences, live-mode
follow-ups, and no overlapping heartbeat requests; provider tests cover wakeup
scheduling and generation/defer semantics. `main_loop/parallel_claim.rs` uses
provider-boundary gates through real `run()` to check claim overlap, a fast
execution completing behind an earlier blocked claim, finite backpressure,
resource/duplicate protection, rejection rollback, soft/hard lifecycle settlement,
and recovery of pending or completed-but-unconsumed claims on Reactor drop.
These tests establish ordering and ownership, not production startup savings.

Helper ownership and lifecycle tests run through `run()` with real
pipe-controlled children and gated child waits. Proxy recovery tests also check
old-launch cleanup before replacement. NetworkLogManager tests exercise real
files, shard panic/cancellation, append errors and pending flush observers,
including queued rows, multiple paths, concurrent waiters and active blocking I/O.
