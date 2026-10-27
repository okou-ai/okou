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

| Work                           | Owner and progress rule                                                                                                                                                                                                                    | Shutdown                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heartbeat                      | One independently scheduled task; triggers coalesce into at most one pending request. The next send uses live state and lifecycle mode. Shared immutable configuration is allocated once per controller.                                   | Natural drain flushes a Stopping snapshot. Common teardown joins the active send before provider shutdown. Abnormal controller drop aborts the task; dropping a client request does not retract a remote request, so snapshot generation/sequence fencing remains required.                                                                                                                         |
| Admission / claim / activation | Up to four independently scheduled transactions, including ordinary activation and failure recovery; authoritative budget and exclusive sandbox reservations remain stricter. Completed results retain a slot until Reactor consumes them. | Soft drain stops new admission and settles in-flight results before idle drain or natural completion. Common teardown joins all admissions before idle/provider shutdown. Dropping task handles does not abort pending remote requests; unconsumed successful results schedule tracked no-sandbox completion and rollback. Process/runtime termination remains an abnormal reconciliation boundary. |
| Status retry                   | One independently scheduled task. State generations, ordered persistence, and atomic-write continuation remain authoritative.                                                                                                              | Join the retry before final status publication. If the reactor itself is cancelled, the task retains ownership until it finishes.                                                                                                                                                                                                                                                                   |
| Routine home-cache GC          | One independently scheduled task, with a host-global routine flock owning inventory/entry cleanup and completion-marker cadence.                                                                                                           | Join before dependent teardown. Do not abort the task during normal shutdown: filesystem deletion may outlive a dropped async future. If the reactor itself is cancelled, the task retains its locks through completion rather than releasing them over unfinished I/O. Process/runtime termination remains an abnormal boundary.                                                                   |
| Poll wakeups                   | Short synchronous mutex sections protect only in-memory scheduling state. No I/O, await, or long nested work is permitted under this lock.                                                                                                 | Notification registration before state recheck, generation fencing, deferred-poll caps, and cancellation remain unchanged.                                                                                                                                                                                                                                                                          |

Required task join failures stop the reactor through its existing lifecycle and common
teardown path and are returned as terminal errors. Ordinary optional GC or status
retry errors remain warnings. Runtime task ownership does not make an individual
filesystem or network operation infinitely fast or cancellation-safe.

Memory-triggered idle maintenance has one independently scheduled observation or
cleanup at a time. It accepts selected cleanup with `IdleDestroyTracker` before
awaiting status publication, then observes the original backing's exit and reads
availability again after completion. Normal teardown joins this owner before
dependent idle/cache/factory teardown. Unknown observations suspend optional
preparation; an uncertain cleanup or lost maintenance producer fences further
pressure maintenance while foreground work continues. Returned uncertain cleanup
retains its full logical lease until owner teardown. These scheduling outcomes
provide no predicted physical-memory credit.

## Startup-fact delivery

Once preparation and replacement settle the actual resource, Executor starts an
owned `StartupReport` for `sandbox`, `home`, `blank`, or `cold`. The dedicated
`PUT /api/runners/runs/:runId/startup` uses the Run token; telemetry does not
persist this fact. `ExecuteOutcome` transfers the task to Supervisor, which
performs reuse handoff, completion and resource settlement before joining it
alongside deferred telemetry. Delivery cannot hold guest startup, execution
results, successor reuse or capacity release.

The existing job owner drains delivery during normal shutdown. Report-owner
drop aborts its task, and Run cancellation interrupts requests and backoff.
There are at most three attempts, each with a two-second request timeout and
two-second delays between retryable failures. Retrying failures log INFO;
terminal failure, including a report-task join failure, logs ERROR and leaves
the Run outcome unchanged. The report task owns only HTTP delivery state, never
a sandbox or capacity lease.

The nullable persisted field can arrive after Run completion. Missing, failed,
cancelled or older reports remain unknown; they are not inferred as `cold` from
legacy reuse diagnostics. Identical late reports are safe to replay, while a
different accepted path cannot be overwritten.

## Idle cleanup handoff

After removing or rejecting idle inventory, synchronously register each cleanup
with the shared `IdleDestroyTracker` before status publication or another await.
Its receiver observes completion and cannot abort accepted work. A dropped or
cancelled caller leaves cleanup independently scheduled; common teardown joins
the tracker before cache and factory shutdown. Keep each logical budget lease
with its payload through completion, except where admission deliberately performs
an atomic logical resource substitution.

Soft drain captures its current idle batch and runs cleanup and the final status
snapshot independently. The reactor continues handling job completion, resume,
and stopping while that batch waits. A resume invalidates the old batch's right
to satisfy a later drain; newly parked inventory needs its own batch. Lost drain
producers stop the reactor through common teardown rather than proving drain
completion. Provider panic remains an uncertain destroy result, not confirmed
physical memory relief. Process/runtime termination is an abnormal boundary;
tracked async ownership alone does not prove completion of a detached physical
I/O operation.

The supplied-policy ordinary activation component borrows an `IdleActivationOwner`
through activation and cleanup admission. A failed or cancelled unpark leaves an
exclusive uncertain owner; it cannot be restored as parked inventory or activated
for another business run. Both positive live/tail allowances and exact backing
are required before accepting terminal work. Required readiness, private/home
preparation and freeze errors retain the promotion and full logical lease rather
than using best-effort abandonment. Accepted work progresses independently of its
result receiver. Supervisor retains no-progress capsules separately, joins work
through `close_and_wait`, and exposes those capsules through
`take_retained_activation_owners` afterward. They remain unresolved ownership,
not physical memory credit. Even successful physical cleanup keeps the full
logical lease until its original caller takes it for reuse or release. Dropping
a completion observer cannot release that lease. Accepting runtimes must retain
these owners through their explicit reconciliation boundary before dependent
teardown.

Supplied-policy ordinary pool batches, replacement and aged retirement adopt
the same mandatory cleanup owner before yielding. A completed result alone does
not release its original full lease: batches claim and release it explicitly,
while aged replenishment claims it for new preparation. Dropped observers and
required saving failures retain the original resources, home context and lease
in the joined activation registry. Aged preemption releases CPU admission while
joining required saving; it releases the logical lease only after proven cleanup,
independently of a held status publication.

Required saving keeps its home-reclamation CPU permit when pre-exit work fails.
Other required cleanups wait while healthy holders can finish. If every permit
is instead held by retained failed owners, waiting cleanup returns no progress
with its original resource, data and lease intact. Joined shutdown can then
expose all retained owners; neither a timeout nor false exit proof releases CPU
custody to obtain progress. Explicit owner reconciliation releases the retained
permit and makes that capacity available again.

Logical eviction still transfers full-profile leases synchronously through atomic
substitution, without waiting for old backing exit. Its accepted resource owner
records that explicit transfer and uses the same mandatory saving engine. Only
completed physical custody is released; failed saving stays recoverable through
the activation registry without retaining or releasing the replacement lease.
This transfer grants no physical memory credit.

The supplied-policy speculative component keeps a
`GuardedSpeculativeAdmission` outside preparation/rollback observation futures.
Its actual provider claim is accepted by the joined Supervisor tracker before
guest preparation; dropping observation cannot cancel that claim or discard a
returned completion authorization. Rollback waits for the provider's returned
result; a lost producer is uncertainty, not rejection. The existing
`JobProvider` contract returns `None` for both an unavailable job and a request
error. That is no returned executable claim, not proof that the remote job was
never claimed; production reconciliation must preserve that provider boundary.
Unpark, fixed Executor guest
restore and rollback repark borrow the original owner. They preserve the full
lease, required home/private context, original history generation and parked
timestamp. Returned failures, provider panic and cancelled waits cannot restore
uncertain state as generic parked inventory.

The committed prepared-guest marker requires a usable predicted timezone that
matches the returned claim. A changed or unknown intent clears that marker so
the existing Executor performs guest preparation against the actual context
before business execution. Original idle metadata remains available to rollback.

A successful rollback uses real reuse preparation against the original runtime
directory and guarded pool insertion. The incoming original backing generation
is validated outside the pool lock after admission/lock waits, followed by
synchronous fenced acceptance or refusal. A replacement blank retains its
separate physical allowance until actual cleanup; restoring the exact owner does
not wait for the old blank's exit. Rejected incoming ownership remains caller
owned for an explicit retry or conversion to shared required cleanup. Accepted
replacement/required cleanup is adopted before status publication. Production
assembly must supply the same host authority and measured preparation/cleanup
coverage; these component APIs alone do not activate a production policy.

The supplied-policy finalizing component preserves actual broker delivery
bindings in `GuardedFinalizingOffer` and keeps the original provider
`ClaimedJob` in `GuardedFinalizingAdmission`. Both capsules remain outside
borrowed observation/activation futures. Producer capture precedes broker
transfer; receipt and post-unpark validation use that original process
generation. A parked candidate and a fenced running handoff remain distinct;
uncertain or running ownership cannot become generic pool inventory. Activation
checks the actual successor, predecessor and claimed reuse key, then transfers
the original sandbox, factory, full logical lease and completion authorization
without another await.

Cancelled receive observations preserve the actual request. Explicit
cancellation and capsule drop synchronously recover queued delivery before
dropping the receiver. Refused offers, lost producers, stale backing and failed
or cancelled activation retain their resources and original claim. Required
cleanup reuses the ordinary mandatory live/tail engine; no-headroom, unknown
observation and cancelled grant waits do not abandon home or release the lease.
Capsule drop only moves custody into the Supervisor registry, with no provider
callback, I/O or physical cleanup. Retained records hold no tracker handle and
cannot create a registry Arc cycle.

Callers must settle or drop their finalizing capsules before dependent teardown.
`close_and_wait` joins accepted work, while
`take_retained_finalizing_owners` retrieves dropped caller-owned resources and
claims afterward. Successful cleanup leases and accepted uncertainty remain in
the separate activation registry. Recovery is an explicit reconciliation
boundary, not completion proof or memory credit. The production root still
owns its admission policy. Native finalizing fixtures do not by themselves
establish full session/history restoration or calibrate production host limits.

## Routine GC and promotion capacity

Runners serialize routine, manual, demand and publication-triggered collection
with `home-image-cache-routine-gc.lock`. Collector and victim entry acquisition
are nonblocking; contention defers collection. Routine maintenance reads the
nonempty collector-file mtime through its held lock descriptor. Only a completed,
active routine pass writes the marker. Manual and pressure collection acquire the
same file without changing routine completion cadence. A yielded routine turn
rechecks cadence through its newly acquired collector descriptor. Interrupted
maintenance never advances the marker.

Publishers can overlap collection while exclusive entry flocks protect each
mutation. No entry flock survives inventory. Victim operations revalidate
generation, inode and last-use; cooperative continuations try the collector owner
again. Count limits and observed free-space targets are independent. Unlocked
candidates alone never authorize eviction.

Cheap pressure probes and completed invalid/temp maintenance have independent
cadences. A probe or cooperative reclaim turn never advances the maintenance
completion marker. Pressure discovery retains the collector owner; each bounded
mutation turn reacquires that owner and tries entries, revalidates generation,
inode and last-use authority, and retains its LRU continuation between turns.
Only actual available space establishes recovery: an unlinked image can remain
allocated while another descriptor is open.

Background maintenance and pressure requests bind to the current Running
lifecycle generation. Drain stops new admission and expires queued work and
continuations, even when a rapid drain/resume leaves the latest mode Running.
Resume admits fresh requests. A selected entry cleanup or victim operation keeps
its physical I/O and locks until completion; later units stop cooperatively.
Interrupted maintenance does not advance its completion marker, and teardown
still joins accepted work.

Shared pressure work retains foreground demand separately from background
watermarks. An interrupted pressure inventory is discarded; later accepted
demand restarts complete discovery. Expiring a background request removes only that target; accepted
foreground demand keeps its own required free-space target and physical owner.
Explicit manual and publication collection retain their caller authority. These
are per-Runner lifecycle boundaries; other host collectors remain independent.

Stopped publishers share four process-local physical IO slots, separate from
Guest reclamation admission. Accepted attempts retain entry ownership, pinned
source and exact staged/candidate/uncertain-commit progress in the existing IO
tracker. Observer loss cannot release a physical tail's locks; shutdown joins it.
Recovery revalidates the retained generation at its actual location and completes
an uncertain metadata commit before retiring old data. Failed required saving
retains its capsule while releasing physical IO admission.

Fresh storage archives retain their existing runner-wide body admission through
fetch, atomic cache publication and Guest staging. Each admitted capability also
retains a shared completion witness, including every split of a grouped
reservation. Normal per-job cancellation drains publication; unexpected owner
loss lets an accepted fsync/rename transaction finish under that shared witness.
After jobs and producers stop, Runner teardown closes further archive admission
and positively joins those retained bodies before dependent cache/runtime
teardown and final stopped publication. Closing admission does not cancel an
atomic write or count cancellation as completed IO.

Publication orders entry/source, then local IO admission.
Move and exceptional Copy share that same bounded IO admission. Copy checks
actual destination headroom before transfer and metadata headroom before commit;
when the observed margin cannot cover four Copy-plus-metadata peaks, Copy
releases partial admission and atomically takes all four existing IO permits.
This serializes pressured Copy within one Runner without another lock or
semaphore. Each Runner owns its local admission independently.
Concurrent allocation by other publishers or processes can race those observations.
Unexpected EXDEV and pressure reclamation release IO admission before
retrying with Copy demand or waiting for GC; the original 30-second pre-IO budget
covers coalesced foreground reclaim observation and admission reentry after a
successful result. No-progress/contention refuses safely; accepted reclamation
remains joined by the existing pressure owner even if an observer expires.
These admission deadlines never abort accepted transfer or sync. Sync runs in
owned blocking work, while the accepted parent retains the relevant guards.
Checkout never joins the publication queue. Proven
guest exit releases healthy reclamation CPU permits before publication, but the
entry and applicable logical lease remain owned until their cleanup contract
completes. Waiting can therefore affect same-key checkout, resource-limited blank
refill and joined shutdown; its contention deadline does not bound filesystem I/O.

Checkout protects and examines the requested entry before considering disk
pressure, with the existing short entry wait or immediate fallback. Cache
selection never runs a whole-cache GC. A valid Move
seed can be consumed by same-filesystem rename even below the reserve. Provider
Fresh/Copy preparation may offer low-space demand to the cache's independently
owned reclaimer when both use the same receiving device. Healthy preparation
does not join a global allocation queue. Its bounded observation deadline never
cancels accepted physical work; shutdown joins that work after producers and
factory-owned creation tails stop.

Selection retains the immutable selecting commit under its entry guard until
fallible storage/history preparation finishes. Factory handoff revalidates the
commit and image pins, then revokes the commit before exposing Move. Accepted
revocation owns its guards through physical completion and is joined after jobs
drain, before factory teardown. Unused release preserves the commit and requests
bounded advisory key revalidation; a notification alone cannot advertise a home.
Rejected handoff uses the existing bounded fresh replacement, which rebuilds
image-derived storage/history preparation before creating the replacement.

Runtime home configurations carry the same max(10% capacity, 50 GiB) reserve as
cache publication. Firecracker queries the actual destination filesystem before
fresh creation, Copy or EXDEV copy. Copy demand includes rounded logical data
extents and per-extent allocation metadata, with a full-logical bound when
observation is unavailable;
source physical block counts alone are not a destination allocation bound.
Fresh images conservatively need their logical size, and both need metadata
headroom. A reclaim result never grants allocation: the provider rereads actual
destination space before proceeding or returning insufficient headroom.
Refusal precedes image truncation, copying and source removal. Pristine retries
retain the reserve policy. This is an observed allocation check, not a reservation
against other writers or a guarantee about future guest growth. Same-filesystem
rename still performs ordinary filesystem I/O and can fail.

Successful routine completion emits `entry_count` (the inventory candidate
count), `inventory_us`, `budget_gc` and `freed_bytes`. These observations are not
production cold-start savings or wall-clock
guarantees. Isolated temporary-file trials and injected filesystem budgets do
not establish production pressure, IO or startup performance.

## Optional preparation

Optional preparation uses the pressure controller's current
observation state and global cadence through a restricted capability bound to
its original physical-memory authority. Notifications carry no cached
permission. Revalidate an opportunity after outside-lock admission waits;
Critical/Unknown/stale/wave/stop transitions revoke the original offer even
after a later recovery. No pressure-state lock survives IO or provider work.

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
- Ordinary and home-preferred admission secure local capacity before claiming.
  They transfer the revisioned eviction snapshot to an independent status task owned
  by the joined cleanup tracker before another await. Claim proceeds through
  cancellation registration and lifecycle checks without waiting for status
  state, ordered persistence or old sandbox cleanup. Claim loss cannot cancel
  accepted publication; snapshot revisions and status generations fence delayed
  writes. Already-claimed finalizing fallback retains its awaited publication.
- Ordinary blank refill accepts aged-retirement and completed-blank inventory
  publication through the joined cleanup tracker before another await.
  Preparation, diagnostics and later discovery can progress while advisory status
  waits. Revision/generation fences reject stale inventory; shutdown joins these
  accepted writers. Initial resource/preference admission and required durable
  Preparing before physical reuse remain authoritative.
- Exact speculative reuse joins claim with journal-gated Guest preparation.
  The exclusive reservation and cancellation/lifecycle checks precede claim;
  its idle snapshot must persist before speculative unpark. If a newer in-memory
  revision supersedes it, current status durability is still required. A journal error
  retains the parked reservation for ordinary claimed activation or rejection
  rollback, preserving the persisted Preparing gate before physical reuse.
- API claim requests own temporary poll exclusions until they settle. Poll uses
  the existing `excludedRunIds` field, prioritizes in-flight claims within its
  contract limit, and preserves the full cooldown inventory for local filtering.
  An empty excluded response, or an API returning an in-flight Run despite the
  exclusions, does not rearm immediate backlog polling. Settlement retires only
  that request's registration and wakes the existing scheduler. This avoids
  repeatedly rediscovering a still-queued claim while unrelated work is waiting;
  no API schema or failure-cooldown policy changes.
- Admission tasks independently own ordinary claim, activation and recovery.
  The same four slots include activation waits and completed unconsumed results;
  saturated activation slots do not permit more claims. Prepared results retain
  ClaimedActivationGuard until Reactor synchronously dispatches the executor.
  Required Preparing-before-unpark and status publication remain authoritative.
  Release the per-run cancellation transfer lock after accepting guarded readiness,
  before returning a result: hard stop must not need Reactor consumption to unlock.
  Lost prepared results retain tracked completion and resource recovery.
  Activation panics retain recovery and propagation to Reactor. Finalizing reuse
  wakeups observed with all admission slots occupied are retained until a slot
  opens; original preference deadlines remain authoritative. Ordinary shutdown
  never aborts an uncertain claim HTTP request. A completed result lost before
  executor handoff uses its actual admission or prepared-activation recovery owner;
  it does not fabricate a remote result for a failed or uncertain request.
- Home-cache watcher work remains retained with ownership of its watcher
  and drained filesystem events. Committed snapshots broadcast to independent
  startup waiters after validation. Subscribe before checking readiness; local
  readiness must remain independent of advertised active-key suppression.
  A resource-backed claimed startup wait belongs to owned jobs, with its claim,
  cancellation registration and ordinary lease guarded through executor handoff.
  It releases the claim-RPC slot while retaining capacity through bounded wait
  and ordinary startup. Soft drain joins this already owned work; result loss
  schedules tracked recovery before releasing resources.
  Missing peer readiness also receives a bounded, nonblocking observation of
  its one demanded physical key, owned by that claimed job under the original
  deadline and cancellation. Snapshot notifications remain the fast path;
  ordinary admission does not probe disk. Readiness grants no checkout custody:
  source-bound metadata and image identity are revalidated under the entry lock.
  Watcher classification does not own an idle-pool or
  status waiter needed by an inline reactor branch. The observation owner admits
  one independent inventory refresh with bounded coalesced dirty keys. Ordinary
  heartbeat delivery reads the committed snapshot while validation or scanning
  waits; shutdown joins accepted refresh work before dependent teardown.
  Physical-key revisions include negative observations, preventing an older scan
  from restoring a removed entry or replacing a newer publication. Lost bounded
  revision history rejects the stale result and requests reconciliation. Named
  complete changes validate only their keys; overflow, lost watches and removals
  from truncated projections require a full refill. The physical view retains
  at most `MAX_HELD_HOME_STATES` groups with `MAX_HOME_CACHES_PER_REUSE_KEY`
  profiles each before heartbeat projection caps.
  Group completion maxima survive omitted profiles; if a root scan omits groups,
  it revisits the final selected groups to recover profiles seen before eviction.
  Coalescing preserves the original observation time. Inventory rounds probe
  entries without waiting for external lock holders; the observer retains
  unresolved keys with independent backoff and a bounded aggregate retry budget.
  Only unresolved work arms a retry wakeup, and cancelling an observation wait
  cannot renew its stored deadline. None of these hints grants disk authority.
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
`main_loop/activation_progress.rs` gates real status publication, reserved Guest
unpark, and failed-activation completion to check later-claim progress before
release. `main_loop/activation_custody.rs` checks the shared four-slot bound,
guarded activation without Reactor polling, result-loss recovery, and hard stop
after a reserved activation publishes its result.
These tests establish ordering and ownership, not production startup savings.

Helper ownership and lifecycle tests run through `run()` with real
pipe-controlled children and gated child waits. Proxy recovery tests also check
old-launch cleanup before replacement. NetworkLogManager tests exercise real
files, shard panic/cancellation, append errors and pending flush observers,
including queued rows, multiple paths, concurrent waiters and active blocking I/O.
