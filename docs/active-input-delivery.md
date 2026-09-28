# Active Input Delivery

Active input delivery steers a queued `input.prompt` or a run-targeted
`input.budget` into a running sandbox run without losing it or letting pick
launch it a second time. Steering and pick both consume queued chat prompts;
only steering consumes the current run's budget warning. Both consume an input the
same way: they append a replacement event that carries the consuming `runId`
and sets `revokesEventId` to the input. The unique revoke edge is the only
mutual exclusion. Steering takes no locks and writes no delivery state.

## Lifecycle

Steering carries the source `chat_events` ID and keeps no delivery state of its
own; release 4 dropped the former delivery tables (migration
`1273_drop_active_input_delivery_tables`), and release 7 removed the reserve and
receipt endpoints and the `activeInputDeliveryIds` completion settlement. Two
sandbox-token endpoints remain:

- **Next steerable input** (`GET /api/runners/runs/:runId/steerable-inputs/next`)
  reads, within the run's thread, the first run-less, unrevoked `input.prompt`
  positioned after the queue input the run consumed last, together with an
  unconsumed `input.budget` whose context is `agent_run:<runId>`. It returns
  the earliest eligible input by sequence as `{ input: { eventId, prompt } }`,
  or `{ input: null }`. It writes nothing. Automation inputs and budgets for
  other runs are never returned. A run that is not running, a prompt whose Discord binding is gone,
  and a prompt that exceeds the control payload all return `null`; the prompt
  stays queued for the next pick, and later prompts do not overtake it. The
  anchor is the run's latest `input.prompt` or `input.automation` event
  carrying its `runId`, located at the position of the source it revoked: the
  replacement itself is appended after prompts queued in the meantime, so
  anchoring on it would skip them. A run's budget input neither advances nor
  is filtered by this anchor, because it may arrive before a later prompt is
  declared steered.
- **Declare steered**
  (`POST /api/runners/runs/:runId/steerable-inputs/:eventId/steered`) consumes
  the prompt or current run's budget with one replacement insert on the revoke
  edge. The replacement retains `input.prompt` or `input.budget`, preserves
  the source context, and carries the consuming `runId`. On a conflict the
  revoker decides. A replacement by this run returns
  `200 { outcome: "steered" }`, so a repeat is idempotent. Any other revoker
  returns `409` with `INPUT_ALREADY_CONSUMED`, or `RUN_NOT_RUNNING` when the run
  has left `running`; the Runner ignores both. An event that is missing, in
  another thread, or neither a prompt nor a budget targeting this run returns
  `404`. Template usage for prompts is logged here.

The Runner reads the next input when the run starts, after an `active-input`
notification for that run, and once for every active run after Ably reconnects.
There is no periodic poll or read/forward retry. It forwards at most one input
at a time to the Guest, which declares it steered once the CLI backend accepts it. A declaration that
fails without a `409` is not retried: the input stays queued, remains the next
steerable input for the rest of the run. An undeclared prompt is picked after
the run ends, so the model may see it again; an undeclared budget expires.

Completion (`/api/webhooks/agent/complete`) consumes no input. After commit, an
unconsumed `input.budget` targeting the run is revoked with `control.revoke`;
a steered budget keeps its replacement bound to that run. Every
undeclared `input.prompt` stays queued; the pick triggered by the slot release
launches it in a new run.

Pi runs execute in the Sandbox from their first turn, so the Runner steers
them under the rules above.

## Terminal Status and Quiescence

A terminal run status does not by itself prove that the old consumer is gone.
Cancellation is visible immediately. Heartbeat timeout records an unknown
consumer state and consumes no input; after commit, the API sends a
best-effort hard cancellation to the owning Runner group. A steered
declaration that arrives after the run left `running` is rejected with
`RUN_NOT_RUNNING` unless this run already consumed the input, so its source
stays queued for the next pick when it is a prompt; an unconsumed budget is
revoked. Pending-run timeout performs no Runner cancellation because no
consumer has claimed the run.

### Post-timeout Webhook Admission

While timeout still represents an uncertain consumer state, runtime mutation
webhooks stop creating new canonical work for that run. Heartbeat returns `404`,
event batches retain their existing sequence acknowledgement but are ignored,
and new checkpoint or checkpoint-history preparation requests return `400`.
Late completion returns the existing `200` failed acknowledgement without
persisting checkpoint, event watermark, reuse metadata, or a different terminal
status. The existing completed Pi checkpoint exact-retry
behavior is unchanged.

Usage events and telemetry remain accepted after timeout because they report
work that may already have happened. Storage and firewall admission remain
separate rollout stages.

Codex execution timeout and cancellation first allow an in-flight `turn/steer`
to settle within the bounded sink window. If the response remains pending,
Guest drops the non-reusable JSON-RPC request, terminates and waits for the
owned app-server process, and only then closes the local sink operation. A
prompt that was never declared steered stays queued for the next pick; an
unconsumed budget is revoked when its run ends.

Reading the next input holds nothing. Until a replacement revokes it, the
prompt is an ordinary queued input in its original FIFO position, and the pick
triggered by the run's slot release may launch it in the successor run. A budget
belongs only to its target run and never launches a successor.

## Transaction Boundary

Both steer endpoints run without locks or transactions: next is a bounded
read, and declare steered ends with one replacement insert on the revoke edge.
Input committed after a read uses the realtime notification path; an Ably
reconnect wakes every active run once to cover a lost notification.

A run's time budget steer that nothing consumed is revoked after the completion
commit rather than inside it. Steering appends only while the run is running,
so the committed terminal state guarantees no later budget input. The budget
event ID is derived from the run, so expiry is one primary-key read and one
`control.revoke` append; the unique revoke edge decides a race with another
consumer. An already steered budget wins that edge and remains bound to its
run. Expiry is best effort: a failed expiry leaves an unconsumed budget for a
terminal run, which no later run may steer and the queue picker never consumes.

Realtime publication, callbacks, usage work, and the slot hand-off pick run only
after commit.

### Final Checkpoint Completion

The bundled Guest prepares final checkpoint metadata and sends it in
`/api/webhooks/agent/complete`. Session history and artifact bytes are uploaded
before that request; completion carries their validated identities and storage
snapshots together with the event watermark and sandbox reuse metadata. The API then persists the checkpoint, promotes the
eligible canonical AgentSession conversation, and applies the terminal run
state in the same database transaction.

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

Runner and Guest ship in the same artifact, so their internal control payload
does not require cross-version negotiation. Release 6 and later Runners call
only the two steer endpoints, so the API rollback floor for this release is
recorded in [deployment compatibility](./deployment-compatibility.md).

The browser remains event-oriented: optimistic input is reconciled by its chat
event ID, and steered replacements use the existing realtime chat event
projection, so steering introduces no frontend protocol or deployment
dependency.
