# Active Input Delivery

Active input delivery prevents a prompt accepted by a running Guest from being
lost or executed twice when run completion, cancellation, and queue scheduling
overlap.

## Lifecycle

The Runner reserves the oldest active-input event before sending it to the
Guest. New reservations contain one source event so each user message reaches
the CLI as a separate input with its own delivery identity. Reservation creates
one `active_input_deliveries` row and one `active_input_delivery_items` row, but
it does not revoke or copy the source chat event. Retrying the reservation
returns the same delivery ID, event ID, and materialized prompt while that
delivery remains open.

The Runner sends the delivery UUID with the Guest control payload. The Guest
deduplicates that identity, persists it after the CLI backend accepts the
follow-up, and attempts the direct receipt asynchronously. A delivered or
acknowledgement-uncertain batch is not sent again while the API keeps returning
the same reservation. Explicit pre-write failures and retryable Guest capacity
statuses retry the same identity.

The delivery becomes settled through one of two proof-bearing paths:

- A direct receipt confirms that the Guest accepted the input. Its source is
  replaced by a run-attributed event and the item becomes `delivered`.
- `/api/webhooks/agent/complete` proves that the Guest has quiesced, or that the
  Runner observed process exit, stopped forwarding, and recovered the receipt
  journal. Completion may overlap sandbox finalization after that boundary.
  Delivery IDs in `activeInputDeliveryIds` become `delivered`. If the open
  delivery ID is not present, prompt items become `released` and their original
  source events stay pending; run-scoped budget items become `expired` and
  receive a `control.revoke` event.

All item and delivery transitions are monotonic. A late receipt for a released
or expired delivery is rejected, while a repeated receipt for an already
delivered delivery is idempotent. Duplicate completion still processes an open
delivery even when the run is already terminal.

After the Guest process exits, the Runner reads the bounded run-scoped receipt
journal while it still owns the sandbox. It attempts those receipts within one
total five-second budget and includes unresolved IDs in the normal completion
request. This uses completion's existing retry and idempotency boundary as the
final recovery path. A successful direct receipt also reuses the existing
Runner notification channel when settlement exposes another queued prompt; the
30-second poll remains notification-loss recovery rather than normal steering
latency.

## Terminal Status and Quiescence

A terminal run status does not by itself prove that the old consumer is gone.
Cancellation is visible immediately. Heartbeat timeout still records an unknown
consumer state, but its transaction now settles any running chat delivery with
an empty receipt set before committing `timeout`. After commit, the API sends a
best-effort hard cancellation to the owning Runner group. Pending-run timeout
does not perform delivery settlement or Runner cancellation because no consumer
has claimed the run.

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
unconfirmed delivery ID remains absent from completion, so the existing
completion transaction releases or expires it only after consumer-stop proof.

Until completion or timeout cleanup settles it, an open delivery is a
non-expiring thread-ordering barrier. The queue scheduler cannot skip its source
events or launch later input on the same thread, even after cancellation
recovery becomes stale. Released prompts return to their original FIFO position
and the post-commit scheduler may create the successor run.

## Transaction Boundary

A running recheck first reads pending input without locks. If that read is
empty, a fresh non-locking query confirms that the run is still running and no
committed open delivery exists. It then returns `empty` without entering the
serialized transaction. Input committed after the pending-input snapshot uses
the realtime notification path, with the 30-second poll as notification-loss
recovery.

Pending reservations, open-delivery retrieval, and direct receipt serialize
database state in this order:

1. chat thread;
2. agent run;
3. delivery and delivery items;
4. source and revoking chat events.

Completion and heartbeat-timeout finalization take the run's checkpoint
lifecycle advisory lock before the same thread, run, delivery, and event order.
They finalize the delivery and apply or observe the terminal run state in one
short transaction. The shared lock order decides whether direct receipt or
terminal finalization committed first.

A run's time budget steer that no delivery consumed is revoked after that
commit rather than inside it. Steering appends only while the run is running,
so the committed terminal state guarantees no later budget input. The budget
event ID is derived from the run, so expiry is one primary-key read and one
`control.revoke` append; the unique revoke edge decides a race with receipt or
settlement. Expiry is best effort: a lost race or failure leaves an inert
pending budget row that no later run reserves.

Realtime publication, callbacks, usage work, and queue drain run only after
commit. A first late finalization drains the thread without replaying the run's
ordinary terminal callbacks or billing work.

### Final Checkpoint Completion

The bundled Guest prepares final checkpoint metadata and sends it in
`/api/webhooks/agent/complete`. Session history and artifact bytes are uploaded
before that request; completion carries their validated identities and storage
snapshots together with the event watermark, active-input delivery IDs, and
sandbox reuse metadata. The API then persists the checkpoint, promotes the
eligible canonical AgentSession conversation, settles active-input delivery,
and applies the terminal run state in the same database transaction.

The nested checkpoint omits `runId`; the completion request's outer `runId` and
sandbox authorization remain authoritative. Invalid checkpoint metadata rejects
the combined request without partially finalizing delivery or changing the run
status. Repeating a committed combined request is idempotent, and a later
checkpoint-less Runner completion observes the first terminal result.

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

The browser remains event-oriented: optimistic input is reconciled by its chat
event ID, and receipt/completion replacements use the existing realtime chat
event projection. Delivery IDs remain internal to API, Runner, and Guest, so
activation does not introduce a frontend protocol or deployment dependency.

Deleting a thread or run cascades its delivery state, so an abandoned delivery
cannot block an unrelated thread.
