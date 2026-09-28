# Active Input Delivery

Active input delivery steers a queued `input.prompt` into a running sandbox run
without losing it or letting pick launch it a second time. It is one of the two
consumers of queued chat input; pick is the other. Both consume an input the
same way: they append a replacement event that carries the consuming `runId`
and sets `revokesEventId` to the input. The unique revoke edge is the only
mutual exclusion. Steering takes no locks and writes no delivery state.

## Lifecycle

The delivery ID that the Runner and Guest carry is the source `chat_events` ID.
Steering keeps no delivery state of its own; release 4 dropped the former
delivery tables (migration `1273_drop_active_input_delivery_tables`).

- **Reserve** reads the thread's earliest run-less, unrevoked `input.prompt`,
  or an `input.budget` that targets the current run, and returns its event ID as
  the delivery ID with the materialized prompt. It writes nothing. A run that is
  no longer running gets `run_not_running`. Retrying the reservation returns the
  same source until something consumes it.
- **Receipt** confirms that the Guest accepted the input. Without locks, it
  checks that the run is still running and belongs to the source's thread, then
  appends the replacement carrying this `runId`. On a revoke-edge conflict it
  rereads the revoker: a replacement by this run counts as delivered and a
  repeated receipt is idempotent; any other revoker (pick, recall, another run)
  rejects the receipt. Template usage is logged here, not at reserve.
- **Completion** (`/api/webhooks/agent/complete`) consumes the source IDs in
  `activeInputDeliveryIds` the same way as receipt, before the terminal
  transition releases the run's slot, so the pick that release triggers cannot
  launch them again. After commit, an `input.budget` targeting the run that was
  not delivered is revoked with `control.revoke`. An undelivered
  `input.prompt` is left as is; the next pick launches it in a new run.

The Runner sends the delivery ID with the Guest control payload. The Guest
deduplicates that identity, persists it after the CLI backend accepts the
follow-up, and attempts the direct receipt asynchronously. A delivered or
acknowledgement-uncertain input is not sent again while the API keeps returning
the same reservation. An explicit pre-write failure or a Guest capacity status
leaves the input unforwarded; the Runner does not retry it, and the next read
offers the same identity again.

After the Guest process exits, the Runner reads the bounded run-scoped receipt
journal while it still owns the sandbox. It attempts those receipts within one
total five-second budget and includes unresolved IDs in the normal completion
request. This uses completion's existing retry and idempotency boundary as the
final recovery path. A successful receipt reuses the existing Runner
notification channel when another prompt is queued. The Runner has no periodic
poll: it reads when the run starts, on the run's notification, and once for
every active run after its Ably subscription reconnects. A failed read is logged
and not retried; an input no read reaches stays queued and the thread's next
pick launches it.

Pi runs execute in the Sandbox from their first turn, so the Runner steers
them under the rules above. The retired API-first turn never steered.

## Steering Without Delivery IDs

Two further sandbox-token endpoints steer without a delivery ID. The Runner does
not call them yet; reserve, receipt and `activeInputDeliveryIds` stay unchanged
until it switches.

- **Next steerable input** (`GET /api/runners/runs/:runId/steerable-inputs/next`)
  reads, within the run's thread, the first run-less, unrevoked `input.prompt`
  positioned after the queue input the run consumed last, and returns `{ input: { eventId, prompt } }` with the prompt materialized as
  reserve does, or `{ input: null }`. It writes nothing. Automation and budget
  inputs are never returned. A run that is not running, a prompt whose Discord
  binding is gone, and a prompt that exceeds the control payload all return
  `null`; the prompt stays queued for the next pick, and later prompts do not
  overtake it. The anchor is the run's latest `input.prompt` or
  `input.automation` event carrying its `runId`, located at the position of the
  source it revoked: the replacement itself is appended after prompts queued in
  the meantime, so anchoring on it would skip them. A run's budget input is not
  an anchor because it is appended at an arbitrary position.
- **Declare steered**
  (`POST /api/runners/runs/:runId/steerable-inputs/:eventId/steered`) consumes
  the prompt exactly like receipt: one replacement insert on the revoke edge,
  and on a conflict the revoker decides. A replacement by this run returns
  `200 { outcome: "steered" }`, so a repeat is idempotent. Any other revoker
  returns `409` with `INPUT_ALREADY_CONSUMED`, or `RUN_NOT_RUNNING` when the run
  has left `running`; the Runner ignores both. An event that is missing, in
  another thread, or not an `input.prompt` returns `404`.

## Terminal Status and Quiescence

A terminal run status does not by itself prove that the old consumer is gone.
Cancellation is visible immediately. Heartbeat timeout records an unknown
consumer state and consumes no input; after commit, the API sends a
best-effort hard cancellation to the owning Runner group. A receipt that
arrives after the run left `running` is rejected, so its source stays queued
for the next pick. Pending-run timeout performs no Runner cancellation because
no consumer has claimed the run.

### Post-timeout Webhook Admission

While timeout still represents an uncertain consumer state, runtime mutation
webhooks stop creating new canonical work for that run. Heartbeat returns `404`,
event batches retain their existing sequence acknowledgement but are ignored,
and new checkpoint or checkpoint-history preparation requests return `400`.
Late completion returns the existing `200` failed acknowledgement without
persisting checkpoint, event watermark, reuse metadata, delivery receipts, or a
different terminal status. The existing completed Pi checkpoint exact-retry
behavior is unchanged.

Usage events and telemetry remain accepted after timeout because they report
work that may already have happened. Storage and firewall admission remain
separate rollout stages.

Codex execution timeout and cancellation first allow an in-flight `turn/steer`
to settle within the bounded sink window. A successful response still persists
its receipt. If the response remains pending, Guest drops the non-reusable
JSON-RPC request, terminates and waits for the owned app-server process, and
only then closes the local sink operation and finalizes receipts. The
unconfirmed delivery ID remains absent from completion, so its prompt stays
queued for the next pick and its budget input is revoked.

A reservation holds nothing. Until a replacement revokes it, the source is an
ordinary queued input in its original FIFO position, and the pick triggered by
the run's slot release may launch it in the successor run.

## Transaction Boundary

Reserve and receipt run without locks or transactions: reserve is a bounded
read, and receipt ends with one replacement insert on the revoke edge. Input
committed after a reserve read uses the realtime notification path; an Ably
reconnect wakes every active run once to cover a lost notification.

A run's time budget steer that nothing consumed is revoked after the completion
commit rather than inside it. Steering appends only while the run is running,
so the committed terminal state guarantees no later budget input. The budget
event ID is derived from the run, so expiry is one primary-key read and one
`control.revoke` append; the unique revoke edge decides a race with receipt or
completion. Expiry is best effort: a lost race or failure leaves an inert
pending budget row that no later run reserves.

Realtime publication, callbacks, usage work, and the slot hand-off pick run only
after commit.

### Final Checkpoint Completion

The bundled Guest prepares final checkpoint metadata and sends it in
`/api/webhooks/agent/complete`. Session history and artifact bytes are uploaded
before that request; completion carries their validated identities and storage
snapshots together with the event watermark, active-input delivery IDs, and
sandbox reuse metadata. The API then persists the checkpoint, promotes the
eligible canonical AgentSession conversation, and applies the terminal run
state in the same database transaction. Delivered sources are consumed before
that transaction, as described under Lifecycle.

The nested checkpoint omits `runId`; the completion request's outer `runId` and
sandbox authorization remain authoritative. Invalid checkpoint metadata rejects
the combined request without changing the run status. Repeating a committed
combined request is idempotent, and a later checkpoint-less Runner completion
observes the first terminal result.

Successful execution and successful recovery send one combined completion and
do not post the prepared checkpoint to the standalone route. Combined reporting
uses the checkpoint retry budget. Mandatory success-path failure produces a
nonzero Guest result, while recovery remains best-effort. Explicit cancellation
still sends one checkpoint-less completion when checkpoint preparation or the
combined request is not acknowledged. Local session-history reconciliation
happens only after the combined request is acknowledged.

The standalone checkpoint route rejects `queued`, `pending`, and `running` runs.
It accepts an exact retry of a completed final checkpoint and retains the
existing bounded recovery behavior for failed or cancelled runs. Checkpoint-less
completion remains supported for the unchanged Runner fallback; a clean success
without a checkpoint still follows the missing-checkpoint failure path.

After the combined Guest/Runner artifact reaches production, record its traffic
promotion boundary, stop the outgoing Runner target from claiming new work, and
wait for its existing Guest runs to drain. This immutable-timeout API release
must not merge until the recorded cutover is at least 7,200 seconds old and no
pre-cutover `pending` or `running` cohort remains. That gate ensures no outgoing
Guest still depends on active standalone checkpoint persistence when the new
admission rule reaches production.

## Compatibility

`activeInputDeliveryIds` is optional, contains at most 1,024 unique canonical
UUIDs, and carries no prompt content. A Guest or Runner omits it when the run
accepted no active input. The API normalizes omission to an empty set, so the
immediately preceding Runner remains compatible during an adjacent deployment.
No protocol version or feature discriminator is persisted.

The Runner always calls the reserve endpoint. A `404` or transport failure is
an ordinary retryable API error and cannot select another delivery path. Both
API and local Runner inputs send a stable `deliveryId`; the Guest rejects a
payload without a canonical delivery ID before queue admission.

Runner and Guest ship in the same artifact, so their internal control payload
does not require cross-version negotiation. Independently deployed API and
Runner versions remain compatible through the stable reserve response shape:
`eventIds` is a one-element array, and empty completion receipts may be omitted.

Because the delivery ID is now the source event ID, a Runner does not see a
format change. During the release 3 rollout, a reservation made by one API
version and settled by the other may be steered and later picked again; see
[deployment compatibility](./deployment-compatibility.md#unified-chat-queue-release-3).

The browser remains event-oriented: optimistic input is reconciled by its chat
event ID, and receipt/completion replacements use the existing realtime chat
event projection. Delivery IDs remain internal to API, Runner, and Guest, so
steering introduces no frontend protocol or deployment dependency.
