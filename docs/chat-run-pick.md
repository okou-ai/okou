# Chat run pick

`pickChatThread$` in
`turbo/apps/api/src/signals/services/pick-chat-run.service.ts` is a stable command
constructed at module scope. It accepts ordinary organization/thread/cursor data
and optional `prefetchedBootstrap`, returning `{ result, cursor }`. The outer
picker owns organization capacity, thread selection, the lease, scheduling and
token-bound cleanup for no-capacity, empty or passed work.
`createThreadClaimRunObjects(claim, prefetchedBootstrap?)` in
`thread-claim-run.service.ts` returns only
`{ hasFirstPickableChatEvent$, startRun$ }`. The Thread owner now owns selection
of the claimed thread's input, execution identity, pinned model, prompt,
connectors, storage, private preparation, final admission, the pending
transaction, selected-input rejection, post-commit activation and deferred
URL-cache writes. No prepared execution context or selected raw event crosses
this public boundary. The deleted `claim-run-context.ts` and
`agent-run-execution.service.ts` are not compatibility entrypoints.

Only actual successful lease-write receipts drive the claim graph. The outer
receipt retains `orgId`, `chatThreadId`, `claimId`, `queuedAt` and its optional
plain prefetch object containing identity values and an already-created Promise.
The child receives only `{ orgId, chatThreadId, claimId }` and that prefetch
object; it owns its pick-start timing. No factory in this path receives a `State`,
`Computed`, `Command`, getter, setter, Store, signal or business callback, including
inside a dependency object. Nodes are defined directly in their owning closure.
The child exposes only its boolean observation and start command; private state is not
forwarded into another factory. Plain conversion and decoding functions and
connection-free SQL builders may remain ordinary functions; transaction handles
never leave their owning command callback.

An organization traversal calls the stable pick command with an invocation-local
cursor. Only successful conditional lease writes append immutable receipts to
private request-Store state. A predeclared computed derives child graphs from
those receipts; a request-local weak memo keeps one graph per receipt identity.
Each pick captures its graph once by its unique claim token, never a shared
"latest claim" slot. Concurrent claims cannot replace each other's source
snapshots. Failed claims add no receipt, and candidate cursors are returned as
ordinary data even when another picker wins the claim.

Receipts live only for the request Store, including its tracked background work;
no receipt cleanup can invalidate an in-flight URL-cache update. Factories perform
no I/O, create no Store and capture no `AbortSignal`. Resource commands and the
fixed-thread repick scheduler invoke already-declared commands; they do not
construct additional graphs.

Pi memory maintenance keeps its own non-chat entrypoint (`startMaintenanceRun$`,
driven by the Phase 2 worker); it does not provide another chat ingress. Domain
infrastructure can remain shared, but S2/S3 does not call an asynchronous
preparation/helper chain or pass injected signals through the old execution
stages. Business reads belong directly in computed nodes; writes and orchestration
belong in explicit commands with the caller's signal as the final parameter.

The successful path has this ownership shape (business rejection and telemetry
are omitted):

```ts
const { claim, cursor } = await set(claim$, input, signal);
if (!claim) return { result: { kind: "none" }, cursor };

// The predeclared computed preserves one child graph per SQL receipt.
const claimed = get(capturedClaims$).get(claim.claimId);
if (!claimed) throw new Error("Missing captured claim graph");
const [hasCapacity, hasInput] = await Promise.all([
  get(claimed.orgHasCapacity$),
  get(claimed.hasFirstPickableChatEvent$),
]);
signal.throwIfAborted();
if (!hasCapacity) {
  if (await set(releaseClaim$, claim, signal)) {
    // This independent predeclared observation is first read after release.
    const freed = await get(claimed.orgHasCapacityAfterRelease$);
    signal.throwIfAborted();
    if (freed) set(scheduleThreadPick$, claim, signal);
  }
  return { result: { kind: "org-full" }, cursor };
}
if (!hasInput) {
  await set(deleteEmptyQueue$, claim, signal);
  return { result: { kind: "none" }, cursor };
}

const runId = await set(claimed.startRun$, signal);
if (runId === null) {
  await set(releaseClaim$, claim, signal);
  return { result: { kind: "none" }, cursor };
}
// The child has fenced the lease, scheduled URL-cache work and activated.
return { result: { kind: "launched", runId }, cursor };
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
`agent-bootstrap.service.ts` owns this signal factory. The entry passes the ordinary
`{ userId, orgId, agentId, bootstrap: Promise<AgentBootstrap> }` object to its
post-commit pick. `pickEnqueuedChatThread$` forwards it unchanged to the stable
picker, which attaches it to only that successful claim's immutable receipt;
`createThreadClaimRunObjects` receives the same Promise without an outer await.
It does not await it before returning the accepted-input response. Integration, automation, workflow-command, run-callback and other
non-Web direct-send entries keep the canonical claim-owned read.

The package composes normalized member metadata, scoped connector selection,
effective permission grants, workflow winners and feature-switch context. Four
read-only factories own those definitions; no metadata UNION rows or workflow
candidate rows cross the bootstrap boundary. It also retains Agent facts, disabled
paid-tool IDs, environment source values, execution-only custom definitions and
normalized catalog identity/projection data. Custom definitions omit enabled/audit
fields and OAuth audit identities after existing validation. Agent facts remain
independently readable for authorization, without joining unrelated bootstrap work.
Independent queries start together.
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

Permission overrides are filtered by application time when their read evaluates.
The small prefetch-to-use expiry window is accepted; no use-time re-read or timer
is added. Existing Runner permission refresh remains intact. Existing observed
feature-switch values retain precedence. Model-provider feature switches use that observation directly,
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
Normalized bootstrap telemetry reports workflow-winner and permission-grant count
buckets instead of raw SQL-row/candidate counts. Member profile/preferences and
built-in/custom selection each retain a single UNION read. Splitting permission
and feature-switch readers gives five independent reads across these four resource
factories and feature overrides, versus the previous three metadata/member/workflow
queries. This is a round-trip increase, not a demonstrated performance gain;
production SQL cost and S1/S3 latency still require measurement.

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

Each invocation reads a fresh candidate and, after a successful claim, fresh
claim-owned organization capacity. The actual conditional-write receipt is
appended before the post-SQL abort check. There is no shared parameter or
latest-claim slot. The predeclared `capturedClaims$` and per-Store weak memo
preserve the graph of every immutable receipt, including concurrent claims and
in-flight background URL-cache writes. The candidate query and conditional
claim update both exclude
threads with an active run. That slot also covers cancellation recovery until
Runner completion or the existing stale-run cleanup releases it. A claim contains
the organization, thread and a random token, with a fixed 10-second lease. Capacity and the FIFO head are read
in parallel after claim. The active count and capacity are independent reads;
capacity retains the existing soft admission limit, including zero/unlimited
and the paid-subscription payment grace policy.

A pick handles at most one input. The outer no-capacity, empty-queue and
`startRun$ === null` paths release or delete using the captured thread/token pair.
A successful start returns the run ID; the child's pending commit has already
fenced and cleared the lease, so there is no outer success-path release.
When preparation or commit throws after the head was read but before a durable
run commit, the Thread owner rejects the head through the same path as a
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
The child records its actual committed run ID before later telemetry or abort
checks. A failure after durable creation must not reject the consumed input.
Deferred URL-cache writes and post-commit activation live outside that
creation-failure boundary; their errors propagate without an outer retry,
second rejection or compensating lease release.

### Org-full release and wakeup

A slot release (run completion, cancellation, cleanup) schedules one
organization pick, and that pick counts and claims only _unleased_ queued
threads. If a thread's own pick holds its lease at that moment and has
already read the organization as full, the slot release skips the thread
and the thread's pick then releases its lease without launching. Without a
follow-up, the input waits with a free slot until some unrelated later pick.
This race is pre-existing: main's pick has the same claim → capacity read →
release ordering. This PR's change made the window wide enough for main's
single-read `chat-events-pi-preparation` scenario to hit it on CI.

After an org-full release that still owned the lease, the pick first evaluates
its independent `orgHasCapacityAfterRelease$` observation. This graph is declared
with the initial observation when the receipt graph is constructed, but is not
read before release. It therefore reads capacity afresh without a shared reload
counter or mutation of the initial snapshot. If a slot is free, the pick
schedules one new fixed-thread invocation of the same stable `pickChatThread$`
through `scheduleThreadPick$`, without forwarding the old S1 prefetch. This is
the same `waitUntil`-owned path used when input arrives under a lease. The
scheduled pick runs with the pick's own signal, which is the background-work
signal and not a request-response signal. Its failure is reported through
`waitUntil`'s detached-promise handling, never as a floating rejection.
Boundaries:

- No retry and no loop. The follow-up is one new pick. It stops at its own
  next org-full observation, and its own release re-reads capacity only once.
  Capacity has to have changed again for another pick to be scheduled.
- A release that no longer owned the lease (a lost lease) does nothing more.
  The current lease holder owns the thread.
- Ordinary capacity bookkeeping is unchanged; this only closes the
  claim-held window.

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
uses the stable command with an invocation-local oldest-first
`(queuedAt, threadId)` cursor and a set of visited thread IDs. Enqueue retains its existing queue-time refresh; a concurrent
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
its actual dependencies. Its private `ThreadRunContext` contains selected mounts,
versions and URLs, encrypted callback rows, the final stored execution context
and the final pending-persistence encoding. Runner payload construction, run
metadata and diagnostic-payload validation finish before the private preparation returns.
There is no storage plan, cache request or intermediate context draft in this
result. It returns ordinary prepared data, not commands or business callbacks,
and never submits the pending run.

Explicit commands initialize or repair model policy facts when needed, refresh
an expired usage allowance when required and reconcile an official automation.
The Thread owner separately submits the pending transaction and activates the committed
run; the parent receives only its run ID or null. Official reconciliation starts alongside independent resource work. Only
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

Thread owns HEAD/prefix resolution, session/Official selection and display/persisted
mount projections. It derives one `createExecutionStorageObjects(exactMounts)`
instance from the selected ordinary identities. The resource exposes only the
read-only `preparedMounts$`: it batches exact-version reads,
verifies actual owner/name/storage/version membership, validates mount configuration,
and prepares URLs in request order. It does not select HEAD, initialize storage,
repair versions, update a session or write a cache during preparation. Empty
writeback versions remain empty mounts; read-only/archive mounts retain the actual
archive metadata. Thread privately adapts the results to the existing Runner wire
shape, including omission of unknown/zero archive sizes and optional default-fail
root policy.

A valid cached URL is reused; a miss or expired row is signed locally, without an
R2 request. Existing system/workflow/readonly namespaces, cache keys and TTLs are
reused; workflow-cache classification follows the reserved organization skill
storage namespace, not a supplied business context. A freshly signed URL travels
on its prepared mount as `presignedUrlCacheWrite`. The cache write is the
module-level command `updateExecutionStoragePresignedUrlCache$(mounts, prepared,
signal)` (interface #4 as revised by Ethan, 2026-10-02): only a successfully
committed run passes it its requests and prepared mounts through request-owned
`waitUntil`; rejected inputs and lost commits do not. Pi maintenance calls the
same command after its commit and activation. The write does not delay activation. Failure is
logged without retry or changing the admitted run: the existing explicit exception
to preparation fail-fast remains intact.

Resource preparation adds a batched exact-version membership read after the
business selection snapshot. This is an explicit round-trip change, not a latency
claim. Thread measures the resource wait with `storage_manifest_signing_owner=execution_storage`; its former private per-scope cache/pool/signing stages are
retired rather than exposed through an injected timing/context API.

`execution-callbacks.service.ts:prepareCallbacks$` encrypts ordinary callback
definitions and returns no run ID or persistence row. The Thread owner preserves
existing JSONB payload serialization and adds the run ID only for its atomic
write. Internal callbacks carry no HTTP secret. Callback preparation no longer
waits for bootstrap merely to supply an unused encryption feature context.
`execution-secrets.service.ts:encryptExecutionSecrets$` encrypts the final secret
namespace with the existing versioned envelope; null remains null and an empty
object remains encrypted. Neither resource selects secrets, writes rows or sends
notifications. Callback KMS encryption starts when callback definitions are ready,
and runtime secret encryption starts when its resolved secrets are ready. They overlap
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

Dispatch timing collectors are private to the Thread `startRun$` owner.
The child's first pickable-input observation captures its timing origin; preparation
and commit share those collectors without exposing them or a run context to pick.
The durable run/job commit is recorded before post-transaction telemetry and
cancellation checks. Failures after that boundary propagate without rejecting the
consumed input, compensating, retrying or creating a replacement execution.

Shared `activatePendingRun$` receives ordinary `notification`, `timing` and
`activationScheduledAt` values and returns the actual publication boolean. It
has no Thread identity, API-start time or first-output marker responsibility.
Thread records first-assistant eligibility and the persisted-job/marker-complete
milestones before invoking it. The same cumulative marker-complete action remains
observable with its real earlier boundary; generic activation no longer emits
an artificial no-op Thread-marker milestone or Thread-marker dimensions.
Commit/context/dispatch/scheduling/activation-entry/database-ready notification
attribution remains in the shared notifier. False keeps the existing admitted-run
policy; an exception remains post-commit and cannot create a replacement run.

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

## Selected model source migration (in progress)

Gateway Thread execution now consumes `createModelSourceSnapshot` for the exact
selected surface. Configuration, mappings and encrypted credentials share one
read snapshot. KMS decryption and the exact managed-key read have no side
effects, so (Ethan, 2026-10-02) the prepared runtime is the computed
`preparedConfiguredEnvironment$`: it decrypts once per claim graph and calls
synchronous `compileModelRuntime`, and downstream model reads get it directly.
Side effects (OAuth refresh, encryption with database writes, Stripe and cache
writes) stay in commands. Official reconciliation and independent reads are not
serialized behind it.

The pure converter has no query, KMS or provider call. Thread privately assembles
supplementary firewall and Codex protocol from the same configuration snapshot;
no hidden configuration query is added. Existing framework/model availability
checks remain caller-owned. Org and member-owned single-secret provider records now use the same source,
effect and pure-conversion path for Anthropic/OpenAI keys and the OpenRouter/
Vercel protocol twins. `member-provider` explicitly identifies a user-owned
`modelProviders` record, unlike `member` subscription-account identity. The
reader applies exact owner scope without trying another source table or account.
Thread retains deferred firewall alias metadata, conditional Pi credential capture
and Codex protocol assembly. Non-Pi Codex subscription-account/org auth-json execution now also consumes the
same source/effect/pure-conversion boundary. Account-source IDs remain distinct
from member-provider IDs; required fields and server-only refresh/ID-token policy
are selected from the existing auth-method registry. Thread retains deferred
source IDs and real nonsecret Codex routing identity. Claude OAuth and Pi
Codex account/org execution also consume the owned source/runtime boundary;
member subscription accounts no longer fall back to a separate legacy
personal-account snapshot after the exact source has been prepared. A
registered provider pin without a stored credential scope passes an explicit
`unscoped-provider` identity; the source reader resolves the member/workspace
owner and credentials in one statement (no separate owner pre-query); the
legacy regular-provider snapshot fallback is gone from Thread now that
DeepSeek also uses the pure runtime contract.
Specialized DeepSeek and full legacy retirement remain unfinished. Builtin paths now consume the approved managed-key
credential variant: source reads nonsecret exact-key facts/reference, an effect
explicitly resolves that same key, and the converter checks source/route/vendor/key
binding without I/O. No ciphertext is fabricated, no default key is selected and
no credential storage migration occurs. Thread retains its private US-routing,
firewall and Codex projection from those same already-resolved values. This is
real source execution progress, not complete model-source or fifteen-interface parity.

## Selected connector source migration (in progress)

Builtin Thread accounts are still selected by the existing catalog/source/default
rules. Their exact IDs then drive `createConnectorSourceSnapshots`, which batches
saved variables and encrypted credentials with actual org/user/target checks and
returns an available/unavailable result per requested source in input order. It
does not select another account, decrypt, refresh OAuth or compile policies.
The normalized selected builtin context consumes those snapshot variables and
credential names; eager decryption consumes the snapshot's credential values.

The existing catalog-declared-name and captured connection-revision authority
condition is retained in a caller-owned names/identity query. It reads no credential
values a second time. Builtin decryption is the side-effect-free computed
`decryptedSecrets$`, resolved once per claim graph, as on main.
Unready input exits before either new effect reads full preparation context.
Thread custom connectors now read every candidate account through the same
reader. Custom results unfold the structured connection facts (auth method,
storage version, reconnect state, token expiry), credential row IDs, the
custom definition revision observed in the same statement, and the automatic
OAuth binding. Thread derives its existing credential-access rows from those
facts, keeps the same compatible/current-version value filter and still picks
the first admissible candidate. Custom OAuth reconnect state is returned rather
than hidden as unavailable because runtime refresh owns it. Custom secrets stay
runtime template references, so no preparation decryption is added. This adds
explicit source/authority reads, without claiming a latency improvement or full
connector-source parity.

## Pending atomic boundary

The Thread child's private `createRun$` receives its privately prepared context.
It directly owns the database transaction, rather than delegating to an
asynchronous launch helper or passing context to pick. It consumes the child's completed persistence
encoding; commit timestamps, account validation, credit admission and returned-ID
bindings remain transaction-local. Producer binding and post-commit bookkeeping
are ordinary data in the context; their owning Thread commands perform the
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

### Workflow pending-tick replacement attribution

Workflow ingress retains the inclusive
`api_dispatch_workflow_enqueue_replace_pending_ticks` span. Its start is the
pending-tick lookup boundary and its end is the next source-stage mark, or the
existing transaction-settlement boundary on failure. Two nested observations
partition the work without changing that parent:

- `api_dispatch_workflow_enqueue_pending_tick_lookup`: the existing candidate
  SELECT, including query construction, driver/network wait and result delivery.
  It is not measured server execution, scanned-row count or pool acquisition.
- `api_dispatch_workflow_enqueue_pending_tick_revocation_append`: construction of
  the canonical revocation rows/statement and the existing append await. It exists
  only when a non-empty lookup result enters that write, not for zero targets.

Each child ends when its query/write promise settles, including rejection,
without including subsequent transaction rollback. Plain numeric observations
are recorded through the existing best-effort collector only after the
transaction settles; synchronous capture callbacks do not emit telemetry or
receive a database handle. Observation/recording failure cannot replace the
original admission, SQL error or cancellation. Missing capture remains missing.
The inclusive parent and its children overlap; do not add their percentiles or
interpret their difference as directly measured database overhead.

A returned lookup result adds `workflow_pending_tick_target_count_bucket` to the
parent and applicable children, using only `0`, `1`, `2_4`, `5_16`, `17_plus`.
This counts returned candidate targets, not scanned rows, successfully committed
revocations or launched Runs. A failed lookup has no count, never a fabricated
zero. A failed append can still have a known target count. The existing anonymous
flush's `success`, `schedule_path` and `admission_outcome` describe the admission,
not each SQL statement: a later transaction failure does not mean every earlier
query failed.

Non-schedule/manual, idempotent no-insert and unavailable-claim paths that never
reach replacement emit neither child nor target count. Empty lookup emits the
lookup and bucket `0`, with no append record. Earlier APIs have no child spans;
absence is a coverage limit, not zero latency or proof of failure. The change adds
at most two timing records per replacement attempt and constant-size numeric
observations per admission, with five count buckets. It adds no SQL, transport in the transaction,
persisted field, public/Runner contract or new identifier/content/error dimension.

After separately authorized deployment, report lookup/known-count/append coverage
and missing records for a fixed event-time window, grouped by exact API marker,
schedule path, admission outcome and count bucket. Keep optional/error branches
separate and use per-cohort nearest-rank distributions with denominators. These
spans remain anonymous: neither their parents nor children can be paired to
arbitrary Runs, and this pre-pick cost is not a duration to subtract from
`api_to_spawn`. A returned-target bucket cannot establish an index miss; an actual
query-plan/critical-path owner and independent failure, retry, cancellation,
resource and tail guards are needed before any behavior optimization. The
production analysis/no-change-or-follow-up decision remains in #37066.

Existing route coverage in `workflow-queue.test.ts` exercises zero/nonzero target
replacement, newest-only drain and preservation/FIFO of manual inputs. Scheduler
and official schedule-claim routes protect competing/unavailable claims and
rollback/rejection. API tests do not assert these diagnostic logs or intercept
telemetry; static boundary/privacy review and post-deployment emission coverage
verify the observations.

### Storage and route verification

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
