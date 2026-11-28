# workflow-queue

## workflow-queue-001

- Vitest: "workflow queue > does not promote an owned queued input while cleaning up a failed operation"
- Mode: run
- Intent: review
- Given: A signed-in workspace owner runs inside an owned operation that queues a chat input (model `claude-fable-5-1`) behind an executing blocker Run and then fails before launching the queued input.
- When: The failed operation is cleaned up, which cancels its Runs, and the owner then lists `GET /api/logs?limit=20` and reads `GET /api/runs/queue`.
- Then: The operation rejects with its own error. The log list contains exactly one Run with status `cancelled`, and the queue reports 0 active concurrency, so the queued input was never promoted.

## workflow-queue-002

- Vitest: "workflow queue > gives separate manual requests distinct stable identities at the same timestamp"
- Mode: run
- Given: A signed-in Team-tier workspace member owns Workflow `workflow-queue-workflow` with a loop schedule Automation (3600 seconds) and a Runner group; the clock is frozen at one instant.
- When: The member requests `POST /api/workflow-automations/:id/run`, the first Run is cancelled and completed, and the member requests Run now again at the same timestamp.
- Then: The second request creates a different Run. Both Run prompts carry an `Automation identity` block with the same `automationId` but distinct `automationEventId` values and the same `requestedAt` timestamp, and the first Run's prompt reads back unchanged.

## workflow-queue-003

- Vitest: "workflow queue > queues concurrent webhook events and drains each exactly once"
- Mode: run
- Given: A signed-in Team-tier workspace member owns Workflow `workflow-queue-workflow` with a Thread-bound `webhook-received` Automation, and a first signed webhook has launched a Run.
- When: Two more signed webhooks arrive concurrently at `POST /api/webhooks/workflow-automations/:token`, then each running Run completes through `POST /api/webhooks/run/complete`.
- Then: Both webhooks return HTTP 200 with `{ success: true, duplicate: false }`; the Thread holds 2 pending automation events and only the first Run. After the first completion there are 2 Runs and 1 pending event, after the second there are 3 Runs and none pending, and each pending event is claimed by exactly one launched prompt.

## workflow-queue-004

- Vitest: "workflow queue > omits the API clock for a promoted webhook run"
- Mode: run
- Given: A signed-in Team-tier workspace member's webhook Automation is running a first Run; a second signed webhook is queued 60 seconds later.
- When: Ten seconds after that the first Run completes through `POST /api/webhooks/run/complete`, and the Runner heartbeats and receives the promoted Run.
- Then: The Thread has 2 workflow Runs and the promoted Run's execution has no `apiStartTime`.

## workflow-queue-005

- Vitest: "workflow queue > keeps user-friendly automation prompts across queue drain"
- Mode: run
- Given: A signed-in Team-tier workspace member owns Workflow `workflow-queue-workflow` with a webhook Automation. A first signed webhook with a nested JSON body launches a Run and a second signed webhook with a different nested body is queued.
- When: The Runner receives the first Run, it completes through `POST /api/webhooks/run/complete`, and the queued event drains into a second Run.
- Then: Claimed and pending events both display "A signed webhook request was received.". Each Runner prompt contains `/workflow-queue-workflow` with `Type: webhook-received` and `Summary: signed workflow webhook received`, its own event text and the untrusted-input notice, and equals the public Run prompt; its event data reproduces the original body JSON with exact key order and omits the webhook secret. Each system prompt contains "Your name is Okou.", exactly one `# Current User Info` heading and the member's email.

## workflow-queue-006

- Vitest: "workflow queue > with an automation at the concurrency limit > keeps the successor automation event queued without a run at the org concurrency limit"
- Mode: run
- Given: A signed-in Team-tier workspace member's webhook Automation is running a first Run, the concurrent Run cap is 2, a separate chat Run occupies the second slot, and a successor webhook event is queued. The cap is then lowered to 1.
- When: The first Run completes through `POST /api/webhooks/run/complete`, the member reads `GET /api/runs/queue`, and later the blocking chat Run is cancelled and completed.
- Then: While the workspace is full, only the first workflow Run exists, the successor event stays pending, and the queue reports limit 1, active 1, available 0. Once the blocker ends, a second workflow Run starts and no events remain pending.

## workflow-queue-007

- Vitest: "workflow queue > executes an admitted automation event after the automation is paused"
- Mode: run
- Given: A signed-in Team-tier workspace member's webhook Automation is running a first Run and has one admitted event pending.
- When: The member pauses it via `POST /api/workflow-automations/:id/disable`, and the first Run then completes.
- Then: Pausing returns HTTP 200 with `enabled` false. The admitted event still launches a second workflow Run, nothing remains pending, and the Thread has no `output.error` event.

## workflow-queue-008

- Vitest: "workflow queue > keeps automation events queued until cancellation recovery completes"
- Mode: run
- Given: A signed-in Team-tier workspace member's webhook Automation is running a first Run on a Runner, and a second signed webhook event is queued.
- When: The member cancels the first Run via `POST /api/runs/:id/cancel`, then the sandbox reports failure (exit 1, "Run cancelled") through `POST /api/webhooks/run/complete`.
- Then: Cancellation returns HTTP 200 and the Thread still has only the first Run. The sandbox completion returns HTTP 200, after which the queued event launches a second Run.

## workflow-queue-009

- Vitest: "workflow queue > keeps a dispatched automation Run's public context after the automation is deleted"
- Mode: run
- Given: A signed-in Team-tier workspace member's webhook Automation has launched a Run that the Runner has received. The claimed event carries automation context `{ type: "automation", workflowName: "workflow-queue-workflow", workflowId }` and the Run prompt names the Workflow, `Type: webhook-received` and the Automation ID.
- When: The member deletes the Automation via `DELETE /api/workflow-automations/:id`.
- Then: Deletion returns HTTP 204. The Thread still contains the identical claimed event, the Runner prompt still carries the Workflow name, event type and `automationId`, and the public Run prompt is unchanged.

## workflow-queue-010

- Vitest: "workflow queue > revokes a deleted automation's queued event and drains the next automation"
- Mode: run
- Given: A signed-in Team-tier workspace member's webhook Automation is running a Run with a second webhook event queued. A schedule Automation for the same Workflow shares the Thread, and the clock is frozen.
- When: The member requests `POST /api/workflow-automations/:id/run` for the schedule Automation, deletes the webhook Automation via `DELETE /api/workflow-automations/:id`, and the running Run then completes.
- Then: Run now returns `{ runId: null, chatThreadId }` and queues a manual event ("A manual run of this workflow was requested.") after the webhook event. Deletion returns HTTP 204, adds a `control.revoke` for the webhook event, its input status reads `revoked` with null `runId` and `terminal`, and only the manual event remains. After completion there is no `output.error` and a second Run claims the manual event with the same display text; its prompt has `Type: manual`, `Summary: manual run requested at <time>.`, the event data `{ automationId, trigger: "manual", requestedAt }` and the Automation identity with that event ID.

## workflow-queue-011

- Vitest: "workflow queue > revokes queued automation input without interrupting its admitted Run"
- Mode: run
- Given: A signed-in Team-tier workspace member's schedule Automation has an admitted Run executing on the Runner and a second Run now request queued behind it.
- When: The member deletes the Automation via `DELETE /api/workflow-automations/:id`; later cancels the admitted Run, the sandbox reports exit 137, and a new schedule Automation for the same Workflow is run now.
- Then: Deletion returns HTTP 204, the admitted Run still reads `running`, the queued input status is `revoked` with null `runId` and `terminal`, and there is no `output.error`. The successor Automation binds to the same Thread and starts a second workflow Run after the admitted one.

## workflow-queue-012

- Vitest: "workflow queue > revokes queued automation input while an admitted Run prepares dispatch"
- Mode: run
- Given: A signed-in Team-tier workspace member has saved personal Instructions and owns a schedule Automation. Download-URL signing is held so the first Run now stays in dispatch preparation, and a second Run now request is queued behind it.
- When: The member deletes the Automation via `DELETE /api/workflow-automations/:id`, signing is released, and later the admitted Run is cancelled and a successor schedule Automation is run now.
- Then: Deletion returns HTTP 204. The admitted Run reads `running` with exactly one dispatch to the Runner group, the queued input status is `revoked` with null `runId` and `terminal`, and no `input.rejected` event revokes it. The successor binds to the same Thread and starts a second workflow Run after the admitted one.

## workflow-queue-013

- Vitest: "workflow queue > revokes an orphaned queued input after its workflow is deleted"
- Mode: run
- Given: A signed-in Team-tier workspace member's webhook Automation is running a Run on the Runner with one queued webhook event.
- When: The member deletes the Workflow via `DELETE /api/workflows/:workflowId`, and the running Run completes through `POST /api/webhooks/run/complete`.
- Then: Deletion returns HTTP 204. The queued input status reads `revoked` with null `runId` and `terminal`, the Thread contains `run.completed` for the running Run, and there is no `output.error`.

## workflow-queue-014

- Vitest: "workflow queue > rejects only the failed webhook trigger and accepts the next event"
- Mode: run
- Given: A signed-in Team-tier workspace member's webhook Automation is running a Run, the clock is 2026-07-25T12:00Z, and a second signed webhook event is queued. The member then removes the Claude Code subscription via `DELETE /api/me/model-providers/claude-code-oauth-token` (HTTP 204).
- When: The busy Run is cancelled and completed; the member reconnects the subscription model and another signed webhook arrives.
- Then: No events remain pending. An `input.rejected` event with a string error revokes the admitted `input.automation` event, carries the same user message and automation context (`workflow-queue-workflow` and its ID), and displays "A signed webhook request was received.". The next webhook returns HTTP 200 with `{ success: true, duplicate: false }` and launches a Run after the busy one, whose prompt has `Type: webhook-received`, the Automation ID and "Summary: signed workflow webhook received an HTTP POST at 2026-07-25T12:00:00.000Z (delivery ".

## workflow-queue-015

- Vitest: "workflow queue > drains chat and automation input in admission order in one canonical session"
- Mode: run
- Given: A signed-in Team-tier workspace member's webhook Automation is running a first Run with a second webhook event queued; the agent produces an assistant reply "done".
- When: The member sends "user interjection" to the same Thread via `POST /api/chat/events` (HTTP 201), then each Run completes in turn through `POST /api/webhooks/run/complete`.
- Then: After the first Run, the queued automation event starts the second workflow Run and the user message has no Run yet. That workflow Run resumes native session `workflow-queue-cli-<first run>`, and the user message then starts a Run resuming `workflow-queue-cli-<second workflow run>`. The completed Runs report their own session IDs.

## workflow-queue-016

- Vitest: "workflow queue > revokes one pending automation event with the caller's client event id"
- Mode: run
- Given: A signed-in Team-tier workspace member's webhook Automation is running a Run with two queued webhook events.
- When: The member sends `POST /api/chat/events` with the Thread ID, `revokesEventId` of the first pending event and a `clientEventId`, then the running Runs complete.
- Then: The send returns HTTP 201, one event remains pending, and the Thread contains a `control.revoke` event with the caller's `clientEventId` revoking the target. Only the remaining event drains, leaving 2 workflow Runs total.

## workflow-queue-017

- Vitest: "workflow queue > queues manual Run now behind the active run and existing backlog"
- Mode: run
- Given: A signed-in Team-tier workspace member's webhook Automation is running a Run with one webhook event already pending, and a schedule Automation for the same Workflow shares the Thread.
- When: The member requests `POST /api/workflow-automations/:id/run` for the schedule Automation, then the Runs complete in turn.
- Then: Run now returns `{ runId: null, chatThreadId }`; pending events display the webhook text then "A manual run of this workflow was requested.", with only the running Run present. The backlog webhook event starts the second Run (prompt `webhook-received` with the webhook Automation ID) and the manual request starts the third (prompt `manual` with the schedule Automation ID).

## workflow-queue-018

- Vitest: "workflow queue > keeps manual Run now behind the user message launched by the cancellation pick"
- Mode: run
- Given: A signed-in Team-tier workspace member owns a schedule Automation with no Thread yet; a first Run now creates a Thread and Run, and the member queues a user message on that Thread via `POST /api/chat/events`.
- When: The first Run is cancelled and completed, the member requests Run now again, the user's Run completes, and a paid Stripe concurrency invoice then wakes the queue.
- Then: The first Run reads `cancelled`, and the second Run now returns `{ runId: null, chatThreadId }` with only the manual event pending. Exactly one Run claims the user message, so Runs are [first, user]. After the user Run reads `completed` and the queue wakes, nothing is pending and Runs are [first, user, manual], with the manual Run prompt carrying `manual` and the Automation ID.

## workflow-queue-019

- Vitest: "workflow queue > queues concurrent schedule Run now requests and drains each exactly once"
- Mode: run
- Given: A signed-in Team-tier workspace member owns a schedule Automation with no Thread yet, and a first Run now has created a Thread and Run.
- When: Two concurrent `POST /api/workflow-automations/:id/run` requests arrive, then each Run completes in turn.
- Then: Both return `runId` null with the same Thread and create 2 pending manual events. After the first Run there are 2 Runs and 1 pending event, after the second there are 3 Runs and none pending, each pending event is claimed by exactly one launched prompt, and no further Run starts after the third.
