# Chat run pick

`createPickObjects(orgId, threadId?, prefetchedBootstrap?)` in
`turbo/apps/api/src/signals/services/pick-chat-run.service.ts` returns only
`{ pick$ }`. The parent owns organization capacity, thread selection, the lease,
overall control flow, the pending transaction, token-bound cleanup and activation.
`createClaimRunObjects(claim, prefetchedBootstrap?)` in `claim-run-context.ts` returns only
`{ pickedEvent$, prepareRunContext$, updatePresignedUrlCache$ }`. It owns selection
of the claimed thread's input, execution identity, pinned model, prompt,
connectors, storage, complete resource preparation and the deferred URL-cache
write. These are the two S2/S3 business-object boundaries.

Both factories accept ordinary business identities and an optional ordinary
prefetch object containing identity values and a Promise. The child claim contains
`orgId`, `chatThreadId` and `claimId`; the parent also keeps the claimed
`queuedAt`. No factory in this path receives a `State`,
`Computed`, `Command`, getter, setter, Store, signal or business callback, including
inside a dependency object. Nodes are defined directly in their owning closure.
The child exposes only the three signals needed by the parent; private state is not
forwarded into another factory. Plain conversion and decoding functions and
transaction-local consistency primitives may remain ordinary functions.

An organization traversal constructs the outer object once and calls the same
`pick$` sequentially. Each successful claim constructs one new child object, after
the lease is acquired. Its complete graph is built once for that claim. Resource
commands do not construct additional graphs. A subsequent claim receives fresh
query caches naturally; writes within one claim invalidate only that child's
relevant snapshots. The factories perform no I/O, create no Store and capture no
`AbortSignal`. All objects and `waitUntil` work use the one request-owned Store.

The pre-existing Pi background and test-fixture adapters keep their legitimate
non-chat entrypoints; they do not provide another chat ingress. Domain
infrastructure can remain shared, but S2/S3 does not call an asynchronous
preparation/helper chain or pass injected signals through the old execution
stages. Business reads belong directly in computed nodes; writes and orchestration
belong in explicit commands with the caller's signal as the final parameter.

The successful path has this ownership shape (business rejection and telemetry
are omitted):

```ts
const claim = await set(claim$, signal);
signal.throwIfAborted();
if (!claim) return null;

const claimed = createClaimRunObjects(claim);
const [hasCapacity, event] = await Promise.all([
  get(orgHasCapacity$),
  get(claimed.pickedEvent$),
]);
signal.throwIfAborted();
if (!hasCapacity) {
  await set(releaseClaim$, claim, signal);
  return null;
}
if (!event) {
  await set(deleteEmptyQueue$, claim, signal);
  return null;
}

const context = await set(claimed.prepareRunContext$, signal);
signal.throwIfAborted();
const pending = await set(createRun$, { claim, context }, signal);
waitUntil(set(claimed.updatePresignedUrlCache$, signal));
await set(releaseClaim$, claim, signal);
await set(activatePendingRun$, pending, signal);
return pending.runId;
```

After agent authorization,
member settings, paid-tool settings and persisted environment reads start beside
bootstrap preparation. Provider preparation and connector account/credential
reads depend on the metadata they consume, without waiting for unrelated
workflow or session results. The selected claim and input drive a fixed read
graph; downstream nodes consume their actual dependencies rather than results
copied between preparation commands. Independent reads use `Promise.all` and
propagate the first rejection. There is no prescribed priority among concurrent
infrastructure failures, no settled-result staging and no error fallback.

## S1 agent bootstrap prefetch

Web session-authenticated direct sends and verified MCP direct sends start
`get(createAgentBootstrap(userId, orgId, agentId))` before the enqueue transaction.
`agent-bootstrap.ts` owns this signal factory. The entry passes the ordinary
`{ userId, orgId, agentId, bootstrap: Promise<AgentBootstrap> }` object to its
post-commit pick. It does not await it before returning the accepted-input
response. Integration, automation, workflow-command, run-callback and other
non-Web direct-send entries keep the canonical claim-owned read.

The package joins agent/organization definition, user information, feature
switches, built-in/custom connector grants, permissions, accessible workflows,
member settings, disabled paid tools, persisted variables/secrets, custom
connector definitions and catalog projections. Independent queries start together.
Environment secrets depend on the agent's execution configuration; custom
connector definitions and catalog projection rows depend on the connector list.
The catalog identity query depends only on global data and starts immediately.
The factories accept ordinary values only and obtain their database inside
computed nodes; no database handle or signal is passed through request state.
Canonical claims construct the same query graph. Its agent-only read remains
independent so authorization does not start automation metadata before its
existing preparation boundary.

The claim derives `{ userId, orgId, chatThreadId, agentId }` from its selected
execution identity and already-read queue head. All three prefetch key fields
must match both identities before any speculative result is consumed. A miss
or absent object reads the canonical graph. A matching Promise rejection
propagates through the existing rejection/lease boundary; it never triggers a
second query or retry. S1 tracks the original speculative work in `waitUntil`
with a separate error observer, including duplicate sends, active-run steer,
no-capacity and identity misses. Observing an unused rejection does not turn
the original Promise into a successful result or change the accepted S1 response.

Permission expiry remains checked against the claim's existing API start time,
not the earlier S1 read time. Existing observed feature-switch values retain
precedence. Model-provider feature switches use that observation directly,
without waiting for bootstrap. Session-based execution resolution starts beside
firewall/body construction, using the same authorized agent, canonical session
snapshot, reset policy and product execution configuration.

Catalog reuse has a separate key: current projection identity plus the sorted
connector list. The pick reads the current global identity; only a matching
projection set/version, capability identity and connector list reuse speculative
rows. A changed catalog reads current projection rows without discarding other
bootstrap data. Reusing speculative projection rows also joins a fresh identity
fence, even when those rows are complete, so replacement after the first pick
identity read cannot admit mixed catalog generations. Existing payload/digest
validation, count checks and immutable process caches remain in force. Thread
connector selection/accounts, stored connector snapshots, custom connector
values and session rows are not in the prefetch package.

`api_dispatch_pre_create_agent_load_bootstrap_snapshot_rows` measures remaining
package wait, with `bootstrap_prefetch=hit|miss` and a miss reason of
`not_provided|identity_mismatch`. `api_dispatch_connector_catalog_prefetch_selection`
records `bootstrap_catalog_prefetch=hit|miss` when uncached projection rows are
needed. These overlapping waits do not measure S1 query cost and must not be
summed. A process-cached catalog can avoid the projection selection altogether.

The identity lookups are primary-key/composite-index reads. Connector grants
use `(org_id, user_id, agent_id)` or `(agent_id, user_id)` indexes, workflows
use their agent/org indexes, member and paid-tool reads use organization/user
keys, environment rows use organization/user/type/name indexes, and catalog
identity/projection reads use source/schema and projection-set/slug keys. S1 may
perform unused reads for steer; this is accepted. Live masked metadata confirms
indexes on accessible tables, but MaskDB does not expose EXPLAIN and does not
expose every catalog/config table. Actual production plan choice and latency
remain deployment-verification work, not claims established by static checks.

Route tests observe accepted input while a real database read is held, claimable
Web/CLI runs, visible rejection after a one-shot PostgreSQL cancellation,
continued steer after an unused prefetch failure, and current-catalog behavior
when publication changes during prefetch. The database barrier/cancellation and
catalog publication fixtures are infrastructure-only exceptions: no production
user API can create those conditions. Assertions stay on chat and Runner APIs;
there are no database-row/log assertions, elapsed polling or production hooks.

## One pick and one organization pass

Each call invalidates organization capacity/candidate reads. There is no shared
`internalClaim$`; the acquired claim is a local immutable value. The candidate query and conditional claim update both exclude
threads with an active run. That slot also covers cancellation recovery until
Runner completion or the existing stale-run cleanup releases it. A claim contains
the organization, thread and a random token, with a fixed 10-second lease. Capacity and the FIFO head are read
in parallel after claim. The active count and capacity are independent reads;
capacity retains the existing soft admission limit, including zero/unlimited
and the paid-subscription payment grace policy.

A pick handles at most one input. Normal no-capacity, empty-queue and completed
paths explicitly release or delete using the captured thread/token pair.
A picked input always ends terminal. When preparation or commit throws after
the head was read, the head is rejected through the same rejection path as a
business rejection (`input.rejected` plus a visible `internal_error` message,
the usual schedule settlement for an automation tick, the realtime event, and
the unexpected-failure reply to the source integration). The only difference
is the lease: the rejection and the release on this claim's token commit in one
transaction, and if the lease is no longer ours the transaction rolls back and
nothing changes. The original error is then rethrown: there is no retry or
fallback. Transient failures (KMS, a brief database outage) are handled the
same way and the user sends again. The no-capacity exit never does this. If the
marking write itself fails, the lease simply expires; there is no other
catch/finally cleanup, so the thread waits at most about 10 seconds.
Every lease comparison (claim and organization candidates) uses
the application clock `nowDate()`, never database `now()`, so tests move the
clock instead of waiting. There is no claim heartbeat, session preparation
retry, or active-run conflict retry.

`active_agent_runs` is written only by the last statement of the pending
transaction, so from claim to commit the lease is the only mutual exclusion.
Only the holder or expiry ends a lease: enqueue never touches it and only
advances `queuedAt` (strictly, by at least 1 ms). The claim captures the
`queuedAt` it observed.

- The pending transaction fences the lease before its run writes: it clears the
  lease only while `claimId` is still this pick's token and throws, rolling back,
  when no row matches (the lease expired and was taken). It runs after the
  admission locks that enqueue also takes before its queue upsert. Before the
  fence, the pending transaction's input claim appends a chat event, which
  locks the thread's `chat_event_sequences` row; every enqueue appends its
  input first and takes the same row before it updates `chat_threads` or
  upserts the queue row. That shared first lock orders the two transactions,
  so the fence taking the queue row before the pending `chat_threads` update
  cannot deadlock with an enqueue. The success path has no separate
  release; the active run protects the thread afterwards.
- Empty queue: the delete also requires an unchanged `queuedAt`. When it misses
  while the lease is still ours, input arrived under the lease, so the picker
  releases it and schedules one fresh fixed-thread pick.
- Rejected head and `passed` preparation: release with the token only. The
  rejection is a business result inside `pick$`; the organization pass
  continues with the next thread, and the thread's remaining input waits for
  the next enqueue, slot release or cron pass.
- No capacity: release with the token; the organization pick after a slot
  frees handles the thread.

Scheduling a pick happens only after an empty-queue delete misses. It
discovers new work; it is not a retry, and `pick$` never loops. A slow picker past the 10-second lease is rejected by the fence.

Integration wait notices (S1) do not use the enqueuer's `pick$` result, because
another picker may hold the lease. After this enqueue's pick finishes (run,
none or error), the sidebar touch and realtime publish run, then S1 reads the
chat event this enqueue created. An input already handled (a run claimed it,
or `input.rejected` or a recall consumed it) sends no notice; otherwise a
thread in `active_agent_runs` sends no notice, because the input steers into
the running run; any other case sends the org-full notice. No lease or
capacity read is made, and rare false org-full notices (for example after an
earlier queued input is rejected ahead of this one) are an accepted gap. A rescheduled pick only picks; it sends
no notice, running-run notification, sidebar touch or realtime event.

An organization pass captures a finite count of currently pickable threads and
uses one factory with an oldest-first `(queuedAt, threadId)` cursor and a set of
visited thread IDs. Enqueue retains its existing queue-time refresh; a concurrent
enqueue cannot make the same thread eligible twice in that pass. It advances
to another thread after an empty queue, lost claim, revoked input or permanent
business rejection. A null result is not proof that the organization has no
work. The pass stops when capacity is exhausted or its captured candidate budget
is visited. Remaining inputs and newly enqueued threads are handled by enqueue,
slot-release or cron entrypoints. A rejected first input does not cause a second
attempt at the same thread in that pass.

## Preparation and explicit writes

Read nodes are grouped by their real dependencies: selected event, selected
thread/user, organization, agent and system resources. They cover pinned model
routing, provider credentials, session/history, integration inputs, templates,
computer host, environment, connectors, workflow metadata and storage planning.
The chosen model comes from the input event. Member account metadata and the
canonical session snapshot are shared; ciphertext bundles and pending admission
retain the necessary current-account validation. Existing multi-row reads remain
batched. The internal `runPlan$` is a thin `Promise.all` of pure read branches.
The pure `RunPlan` never escapes as a commit-ready context.
`prepareRunContext$` starts it alongside the pure storage-mount read graph,
callback preparation and stored-context preparation. Each branch waits only for
its actual dependencies. Its final `RunContext` contains selected mounts,
versions and URLs, encrypted callback rows, the final stored execution context
and the final pending-persistence encoding. Runner payload construction, run
metadata and diagnostic-payload validation finish before the child returns.
There is no storage plan, cache request or intermediate context draft in this
result. It returns ordinary prepared data, not commands or business callbacks,
and never submits the pending run.

Explicit commands initialize or repair model policy facts when needed, refresh
an expired usage allowance when required and reconcile an official automation.
The parent separately submits the pending transaction and activates the committed
run. Official reconciliation starts alongside independent resource work. Only
reads of its actual results wait: the final automation target, launch prompt and
event policy, autonomy budget, and automation callback definitions. Reconciliation
invalidates those snapshots before their final read. Session, model, member,
connector and storage preparation, including runtime-secret KMS encryption, use
the claim's captured execution identity and start without that barrier. Official
executable content still comes from the accepted catalog revision and storage
version; reconciliation does not rewrite it. Ordinary Web inputs start both
sets of work immediately and do not reconcile official workflows.
Storage selection and local URL signing perform no database writes. Discord access, rejection
delivery and typing notifications receive the request dispatcher instead of
creating a Store inside the pick's work.

Storage plan, request, presigned-cache and mount nodes are constructed with the
claim factory. A valid cached URL is reused; a miss or expired row is signed in
memory using local credentials, without an R2 request. Final URLs enter the
runner payload directly. Fresh cache rows remain private to the child. Only a
successfully committed pending run schedules `updatePresignedUrlCache$` through
the existing request's `waitUntil`; rejected inputs and lost commits do not.
The cache write does not delay activation. Its failure is logged without retry
or changing the admitted run. This is the one explicit exception to preparation's
fail-fast rule; the runner never needs the cache write to finish.

Callback KMS encryption starts when callback definitions are ready, and runtime
secret encryption starts when its resolved secrets are ready. They overlap
independent reads and storage assembly through `Promise.all`, but both must
finish before `createRun$`: the runner may claim the queue row immediately after
commit. Pending run, runner job and encrypted callbacks remain one atomic write
boundary. There is no pending-only commit followed by a later encrypted payload,
no compensation and no KMS key caching change. Preparation failures propagate
without selecting a preferred error; already-started branches retain the request
signal. No lease cleanup or retry is added.

Run creation does not initialize artifact storage, empty versions, heads or file
indexes. A missing memory root is a prerequisite error and fails directly.
Prerequisite [PR #37381](https://github.com/okou-ai/okou/pull/37381) provides idempotent memory initialization per
`(orgId, userId)` through `onboarding-complete` and Clerk
`organizationMembership.created`. Existing members are not backfilled, in data
or in a migration. `GET /api/user-preferences` stays read-only and reports
`memoryInitialized`; when it is false the Web App calls the idempotent
`POST /api/user-preferences/initialize`, which reuses the #37381 initializer to
create only missing memory or an empty HEAD and never rewrites existing
content. CLI, Slack and other non-Web entries reaching an uninitialized member
fail at run creation; that gap is accepted.

Pi memory summary projection selection is read-only. Missing or corrupt summary
records log a warning and use the existing not-ready state; creation does not
enqueue or repair a projection. Version writes enqueue summary work, and the existing background worker backfills
missing projections. A pre-existing `ready` row whose content fails validation is
not automatically selected by that worker: it remains not ready for run recall
until a separately authorized repair policy schedules it. This PR does not add
a background scan or repair policy. Frozen recall, flag-off and captured-epoch
behavior remain intact.

Admission, model-policy initialization and allowance refresh are explicit
nodes within the claim object. Final admission deliberately captures a fresh plan, credit/expiry and
usage-pack snapshot. Their independent read nodes join with `Promise.all`; an
allowance refresh is requested only when admission needs it. Policy repair and
allowance refresh commands retain their existing locked transaction semantics.
Initial model preparation shares the claim object's already-read snapshots,
while final admission owns its later snapshot. Commit-time locks and
credit revalidation remain transaction-local.

After authorization, runtime-secret KMS, credit admission, storage mounts and
the launch reads (runner input, callbacks, assembly, identity, member,
paid-tool and environment snapshots) start together in one `Promise.all`.
Credit admission does not gate the pure storage reads; its failure is checked
with the prepared resources, in plan, admission, storage and stored-context
order, before anything is committed. Automation launch arguments, which depend
on official reconciliation, are the only write-derived prerequisite of the
launch reads; storage mounts and KMS do not wait for them.

Preparation writes no claim state once these reads have started. The token-free
launch arguments are a computed join of the plan, run identity and resource
admission, so Pi launch resources start from them immediately; the runner input
that carries the run token is produced by its command and passed on as a plain
value to storage and stored-context preparation. An automation's independent
Get Started reward is recorded alongside the launch reads, not ahead of them.

Dispatch timing collectors are created by the parent `pick$` after its claim
and passed as plain arguments to `prepareRunContext$` and `createRun$`;
`RunContext` does not carry them.

Configured connector account fallback is selection among different authorized
accounts; it does not retry failed queries. Runtime catalog selection uses fixed
identity, requested-slug, projection-row, count, fresh-identity and complete-
snapshot computed nodes with typed SQL. Identity and requested slugs are joined
with `Promise.all`; each uncached connector is read once in the existing batch.
Only missing projection rows trigger the count and fresh-identity queries, which
run in parallel. The fresh identity uses a separate query rather than rereading
a memoized node. A changed generation fails preparation and is never adopted by
a second attempt. Explicitly absent, incomplete or incompatible projections can
use a complete snapshot only at the captured source, schema, catalog
version/digest and capability digest; query errors never select that branch.

The full payload node retains immutable accepted-snapshot caching plus artifact
and compatibility validation. The same initial identity also binds the full read
when no usable projection was present. A missing captured payload fails directly.
The discovery/slug readers, runner firewall catalog and legacy complete runtime
snapshot callers retain their existing `loadAcceptedConnectorCatalogSnapshot`
compatibility behavior. Catalog publication locks remain unchanged.

## Pending atomic boundary

The parent's `createRun$` receives `{ claim, context }` after resource preparation
has completed. It directly owns the database transaction, rather than delegating
to an asynchronous launch helper. It consumes the child's completed persistence
encoding; commit timestamps, account validation, credit admission and returned-ID
bindings remain transaction-local. Producer binding and post-commit bookkeeping
are ordinary data in the context; their owning parent commands perform the
writes. The transaction keeps input consumption, the necessary session/run and thread
binding, the runner job, callbacks, producer binding and accounting together.
`active_agent_runs` is inserted last. Its uniqueness violation escapes and rolls
back the transaction. It is never converted to a busy/skipped result.

The organization plan/admission lock and official catalog validation keep their
existing ordering. Session snapshot validation and the canonical-session row
lock protect the prepared checkpoint; the thread binding update compares the
captured run identity. A changed snapshot throws and rolls back without rebuilding
preparation. The queue's final FIFO/unique-revocation validation remains necessary
because a user may revoke a captured input before commit. Activation and runner
notification are explicit post-commit work; pending does not mean executing.

## Session and rollout

A valid owned thread session keeps its application ID when the agent, framework
or model changes. An incompatible native checkpoint is reset in the pending
transaction, and the subsequent completion establishes the new checkpoint. Pi
reads only the canonical checkpoint rather than scanning historical runs for an
older compatible session. `chat_threads.agent_session_id` has a unique index;
old detached sessions remain historical records. See
[deployment compatibility](deployment-compatibility.md#canonical-chat-application-sessions)
for the migration preflight and mixed-version boundary.

Removing memory initialization from run creation relies on the account
initialization entries of #37381 and the Web App's on-demand initialization
above; there is no backfill.

## Measurement and verification

`api_dispatch_enqueue_commit_to_consume_start` measures from the request's
observation of a successful enqueue commit to consumption start, only when the
same Store has the receipt for that exact input event. Its
`capture_scope=request_observed_commit` dimension makes the boundary explicit.
Older queue heads and later cron requests have no receipt and emit no substitute
measurement. Concurrent preparation spans overlap; their durations must not be added as sequential stages. The context span measures the joined preparation work, and the pre-create/context completion checkpoints no longer imply a serial query pipeline. The existing input-created-to-consume duration remains queue age;
it overlaps enqueue time and must not be added to S1.

Storage planning finishes before the final mount assembly. The nested
`api_dispatch_prepare_storage_manifest_resolve_plan` span measures the read
plan, while storage preparation covers version selection, URL-cache reads, local
signing and assembly. Cache writes occur after pending commit. Compare cache
read/write cost with direct in-memory signing before claiming this cache improves
latency. Nested spans must not be added to their enclosing duration.

Storage cache tests distinguish production from cache consumption. Chat tests
use enqueue/pick and Runner claim to verify cache creation and reuse. A scoped
PostgreSQL fault rejects only the selected cache write after a pending run and
job exist; the run must still be claimable with a complete URL. Deferred external
KMS and signing observations verify that both start before either completes,
while the input remains unconsumed and no runner job is available until KMS
finishes. An Official automation test holds the real Gmail label lookup during
reconciliation: the accepted workflow archive signing and runtime KMS still
start, with no run, job or callback rows committed. After release, completing the
run verifies the result-email callback from the updated automation configuration.
Internal callbacks do not have HTTP secrets and need no KMS encryption.
Synthetic non-chat mounts have no equivalent chat input, so their
existing fixture tests explicitly seed cache entries and retain exact URL reuse,
52-mount completeness, hard-expiry and owned/primary selection assertions. They
no longer expect resource preparation to persist a new cache entry.

Route coverage includes FIFO and multi-thread traversal, rejection followed by
another thread, token/lease recovery, unchanged model pins, stable application
session IDs with native-history reset, and stale-session transaction rollback
without retries. Successful-run fixtures await the tracked enqueue/pick work
before inspecting admission. Tests that intentionally hold a branch observe an
explicit intermediate boundary; elapsed polling time does not establish that
background work has completed. Local static validation cannot establish
production latency or replace the database-backed PR test pipeline. No P50/P95 improvement is asserted
by this refactor.
