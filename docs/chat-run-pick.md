# Chat run pick

`createPickObjects(orgId, threadId?)` in
`turbo/apps/api/src/signals/services/pick-chat-run.service.ts` constructs the
S2/S3 graph once and returns only `pick$`. It does not create a Store, query a
database, or write resources. Request commands and their `waitUntil` work use
the same request Store and application-lifetime signal. The pre-existing direct
run and test-fixture adapters use the shared preparation graph; they do not
provide a second chat-run ingress.

The picker exports no other runtime entry. It owns the claim, queue head,
selected input identity, captured model policy and chat-specific orchestration.
`agent-run-execution.service.ts` contains the genuinely shared selected-agent
and execution signals factories: their typed query nodes are constructed once,
and preparation, storage materialization and pending commit remain explicit
commands. Pick, the Pi background entry in `background-agent-run.service.ts`,
and the test-only adapter in `test-agent-run-fixture.service.ts` compose those
capabilities with their own lifecycle rules. Connector runtime preparation is
also shared with runtime synchronization in its own domain module. S1 automation
enqueue writers and shared contracts have separate boundaries.

The same-service rule keeps queue-specific reads and orchestration visible in
Pick. It does not require duplicating execution capabilities used by non-chat
production callers. Shared factories expose the read nodes and commands; they
do not wrap the former asynchronous S3 helper chain. After agent authorization,
member settings, paid-tool settings and persisted environment reads start beside
bootstrap preparation. Provider preparation and connector account/credential
reads depend on the metadata they consume, without waiting for unrelated
workflow or session results. The selected claim and input drive a fixed read
graph; downstream nodes consume their actual dependencies rather than results
copied between preparation commands. Independent reads use `Promise.all` and
propagate the first rejection. There is no prescribed priority among concurrent
infrastructure failures, no settled-result staging and no error fallback.

## One pick and one organization pass

Each call invalidates organization capacity/candidate reads and clears the
previous claim. The candidate query and conditional claim update both exclude
threads with an active run. That slot also covers cancellation recovery until
Runner completion or the existing stale-run cleanup releases it. A claim contains
the organization, thread and a random token, with a fixed 60-second lease. Capacity and the FIFO head are read
in parallel after claim. The active count and capacity are independent reads;
capacity retains the existing soft admission limit, including zero/unlimited
and the paid-subscription payment grace policy.

A pick handles at most one input. Normal no-capacity, empty-queue and completed
paths explicitly release or delete using the captured thread/token pair.
Concurrent enqueue can invalidate that token, so stale cleanup affects zero
rows. Unexpected errors leave the lease to expire. There is no claim heartbeat,
session preparation retry, or active-run conflict retry.

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
batched. The final context node joins prepared branches and performs pure
projection/validation.

Explicit commands initialize or repair model policy facts when needed, refresh
an expired usage allowance when required, reconcile an official automation,
materialize storage, submit the pending transaction, and activate the committed
run. Official reconciliation invalidates the final automation target read before
launch preparation. Non-official inputs do not reconcile official workflows.
Missing storage roots and presigned-URL cache writes happen before the pending
transaction. Existing roots take the read path. Discord access, rejection
delivery and typing notifications receive the request dispatcher instead of
creating a Store inside the pick's work.

Storage planning is part of the read graph. After authorization and admission,
callback preparation, storage materialization and stored-context encryption start
from their own required inputs and join with `Promise.all`. The first failure
propagates without waiting for unrelated branches or selecting a preferred error.
Already-started branches keep the request's signal and remain owned by the join;
`Promise.all` itself does not cancel them. No lease cleanup or retry is added.

Storage plan, request and presigned-cache nodes are constructed with the factory.
Initializing a missing root records the actual created root in private state;
downstream storage reads update from that result without reloading the pick or
selecting another thread. Each new pick clears those initialization results.
Pi memory summary resolution stays in the resource command because it can enqueue
or requeue a missing/invalid projection, and a missing memory root's final identity
is available only after initialization.

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

The transaction keeps input consumption, the necessary session/run and thread
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

## Measurement and verification

`api_dispatch_enqueue_commit_to_consume_start` measures from the request's
observation of a successful enqueue commit to consumption start, only when the
same Store has the receipt for that exact input event. Its
`capture_scope=request_observed_commit` dimension makes the boundary explicit.
Older queue heads and later cron requests have no receipt and emit no substitute
measurement. Concurrent preparation spans overlap; their durations must not be added as sequential stages. The context span measures the joined preparation work, and the pre-create/context completion checkpoints no longer imply a serial query pipeline. The existing input-created-to-consume duration remains queue age;
it overlaps enqueue time and must not be added to S1.

Storage planning finishes before the materialization command. The nested
`api_dispatch_prepare_storage_manifest_resolve_plan` span measures the read
plan, while `api_dispatch_prepare_storage_manifest` now measures materialization
of that prepared plan. The enclosing launch-preparation span still covers both;
the nested spans must not be added to that enclosing duration.

Route coverage includes FIFO and multi-thread traversal, rejection followed by
another thread, token/lease recovery, unchanged model pins, stable application
session IDs with native-history reset, and stale-session transaction rollback
without retries. Local static validation cannot establish production latency or
replace the database-backed PR test pipeline. No P50/P95 improvement is asserted
by this refactor.
