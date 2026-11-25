# chat-callbacks.bdd

## chat-callbacks.bdd-001

- Vitest: "CHAT-02: completed chat callback > persists assistant output, reorders threads, titles the thread, recommends follow-ups, notifies, and auto-sends the queued template message"
- Mode: run
- Given: A signed-in Pro member has started a Web chat run "How do I debug my Node app?", queued a second message containing a Playful Launch Presentation template part plus "queued next turn", and has a later cancelled sentinel thread. The title model returns "Debugging Node Apps", the follow-up model returns one long talk suggestion and one website generate suggestion, other generations return "Generated summary", and a browser push subscription is registered with VAPID enabled.
- When: The Runner picks up the first run and the Sandbox posts one assistant event "final answer" to `POST /api/webhooks/run/events`, then `POST /api/webhooks/run/complete` with exit code 0 and `lastEventSequence` 0.
- Then: The thread has exactly one output message "final answer", a completed marker with null content, and a follow-ups event with exactly the two suggestions; the follow-up model is called once with the answer but not the queued text, using a plain-text system prompt that lists supported generation types, and `desktopShellAuthorizationChanged` is published. No new title request is made and the title stays "Debugging Node Apps", the last thread-list event is `sort_touched` for this thread, and a Web push is sent with the prompt as title, "Generated summary" as body and the `/chats/<threadId>` URL. The queued message is auto-sent as a new `input.prompt` replacement with a new run that revokes the original (both rows listed, the original without a run), `chatThreadMessageCreated:<threadId>` is published, and the new run's context has the template-prefixed prompt, a Web integration and inline-template system prompt with the runbook pull command and `presentation-html` artifact kind, and a `CLAUDE_CODE_OAUTH_TOKEN` environment variable.

## chat-callbacks.bdd-002

- Vitest: "CHAT-02: completed chat callback > omits the API clock for a chat run picked from the queue"
- Mode: run
- Given: A signed-in Pro member has a running Web chat run, and a second message is queued in the same thread while the clock is set one minute ahead.
- When: The clock advances one more second and the Sandbox completes the first run through `POST /api/webhooks/run/complete` with exit code 0.
- Then: The queued message is auto-sent with a new run, and that run's execution input has no `apiStartTime`.

## chat-callbacks.bdd-003

- Vitest: "CHAT-02: completed chat callback > uses the optimized prompt and userMessage semantics for recommended follow-ups"
- Mode: run
- Given: A signed-in Pro member completed a first Web chat run whose structured user message holds an illustration template part and "first structured request" (with a different stale legacy prompt). The title model returns "Structured Context" and the follow-up model returns one talk suggestion.
- When: The member sends a second structured message "second structured request" (again with a stale legacy prompt) through `POST /api/chat/events`, and the Sandbox completes that run with the answer "second structured answer".
- Then: The thread title becomes "Structured Context" from exactly one title request that contains the template label and both structured texts but neither legacy prompt. The follow-up model is called exactly once with a system prompt containing the quick-reply, usefulness, single-intent, language-matching, no-filler and "exactly 3 suggestions" rules, and a user prompt containing both structured texts, the template label and the second answer but no legacy prompt.

## chat-callbacks.bdd-004

- Vitest: "CHAT-02: completed chat callback > recommends workflow and email follow-ups for ordinary members"
- Mode: run
- Given: A signed-in Pro member has a Web chat run asking to reconcile invoices and draft an email. The follow-up model returns two workflow, two email (one with a stray generation type) and one talk suggestion.
- When: The Sandbox completes the run through `POST /api/webhooks/run/complete` with a final answer.
- Then: The follow-up system prompt is requested once and offers both `"kind":"workflow"` and `"kind":"email"`. The stored recommendation resolves to exactly the first workflow suggestion, the first email suggestion (without generation type) and the talk suggestion.

## chat-callbacks.bdd-005

- Vitest: "CHAT-02: completed chat callback > accepts a retried recommended follow-up send as a duplicate"
- Mode: run
- Given: A signed-in Pro member has a completed Web chat run whose thread has a recommended follow-ups event with one talk suggestion.
- When: The member sends the follow-up through `POST /api/chat/events` with a client event ID and `revokesEventId` set to the follow-ups event, retries the identical request, and then sends a different prompt for the same follow-up with a new client event ID.
- Then: The first send and the retry both return HTTP 201 with identical bodies, and the retry stores no new events; exactly one event (the original client event ID, `input.prompt`) revokes the follow-up. The different input returns HTTP 409 with code `CONFLICT` and message "Recommended follow-up has already been used" and stores nothing new.

## chat-callbacks.bdd-006

- Vitest: "CHAT-02: completed chat callback > silently degrades all four callback features while delivering the generic notification"
- Mode: run
- Given: A signed-in Pro member has a Web chat run and a registered browser push subscription with VAPID enabled. The OpenRouter model answers every title, follow-up, notification-sentence and summary request with a `rate_limit_exceeded` error choice.
- When: The Sandbox completes the run through `POST /api/webhooks/run/complete` with the answer "The main answer survives".
- Then: The thread contains the answer, no `output.followups` event exists, the thread title stays null, and a Web push is sent with the fixed body "Your task is complete".

## chat-callbacks.bdd-007

- Vitest: "CHAT-02: completed chat callback > omits recommended follow-ups for an empty suggestion array"
- Mode: run
- Given: A signed-in Pro member has a Web chat run and a registered browser push subscription. The follow-up model returns an empty suggestion array, and the notification-sentence model returns "---".
- When: The Sandbox completes the run through `POST /api/webhooks/run/complete` with the answer "The main answer survives".
- Then: The thread contains the answer and no `output.followups` event, and a Web push is sent with the fallback body "Your task is complete".

## chat-callbacks.bdd-008

- Vitest: "CHAT-02: completed chat callback > omits recommended follow-ups for generated text that is not JSON"
- Mode: run
- Given: A signed-in Pro member has a Web chat run and a registered browser push subscription. The follow-up model returns plain text that is not JSON, and the notification-sentence model returns "---".
- When: The Sandbox completes the run through `POST /api/webhooks/run/complete` with the answer "The main answer survives".
- Then: The thread contains the answer and no `output.followups` event, and a Web push is sent with the fallback body "Your task is complete".

## chat-callbacks.bdd-009

- Vitest: "CHAT-02: completed chat callback > omits recommended follow-ups for generated JSON that is not an array"
- Mode: run
- Given: A signed-in Pro member has a Web chat run and a registered browser push subscription. The follow-up model returns a JSON object with a `followups` field instead of an array, and the notification-sentence model returns "---".
- When: The Sandbox completes the run through `POST /api/webhooks/run/complete` with the answer "The main answer survives".
- Then: The thread contains the answer and no `output.followups` event, and a Web push is sent with the fallback body "Your task is complete".

## chat-callbacks.bdd-010

- Vitest: "CHAT-02: completed chat callback > omits recommended follow-ups for an array whose every item fails validat…"
- Mode: run
- Given: A signed-in Pro member has a Web chat run and a registered browser push subscription. The follow-up model returns an array whose items all fail validation (an unknown kind and a missing prompt), and the notification-sentence model returns "---".
- When: The Sandbox completes the run through `POST /api/webhooks/run/complete` with the answer "The main answer survives".
- Then: The thread contains the answer and no `output.followups` event, and a Web push is sent with the fallback body "Your task is complete".

## chat-callbacks.bdd-011

- Vitest: "CHAT-02: completed chat callback > omits recommended follow-ups after rejected credentials"
- Mode: run
- Given: A signed-in Pro member has a Web chat run and a registered browser push subscription. The follow-up request to OpenRouter is rejected with HTTP 401 and a body containing a private credential detail.
- When: The Sandbox completes the run through `POST /api/webhooks/run/complete` with the answer "The main answer survives".
- Then: The thread contains the answer, has no `output.followups` event, and no thread event contains the provider's private detail.

## chat-callbacks.bdd-012

- Vitest: "CHAT-02: completed chat callback > omits recommended follow-ups after a response body that is not JSON"
- Mode: run
- Given: A signed-in Pro member has a Web chat run and a registered browser push subscription. The follow-up request to OpenRouter returns a JSON-typed body that is not JSON and contains a private detail.
- When: The Sandbox completes the run through `POST /api/webhooks/run/complete` with the answer "The main answer survives".
- Then: The thread contains the answer, has no `output.followups` event, and no thread event contains the provider's private detail.

## chat-callbacks.bdd-013

- Vitest: "CHAT-02: completed chat callback > omits recommended follow-ups after a response body that fails while stream…"
- Mode: run
- Given: A signed-in Pro member has a Web chat run and a registered browser push subscription. The follow-up response body from OpenRouter fails while streaming.
- When: The Sandbox completes the run through `POST /api/webhooks/run/complete` with the answer "The main answer survives".
- Then: The thread contains the answer, has no `output.followups` event, and no thread event contains the private provider detail.

## chat-callbacks.bdd-014

- Vitest: "CHAT-02: completed chat callback > absorbs title and summary storage failures without losing the round"
- Mode: run
- Given: A signed-in Pro member has a Web chat run. The title and run-summary models return text containing a NUL character that the database cannot store, and the follow-up model returns one talk suggestion.
- When: The Sandbox completes the run through `POST /api/webhooks/run/complete` with the answer "The main answer survives".
- Then: The thread title stays null, while the thread still contains the answer and an `output.followups` event.

## chat-callbacks.bdd-015

- Vitest: "CHAT-02: completed chat callback > completed Web push observes same-org foreground presence while native alerts are delivered"
- Mode: run
- Given: A signed-in Pro member has a registered iOS device and a browser push subscription, the AI generation provider returns 503, and the member's Web foreground presence is in the same organization. (Row: status `completed`, presence `same-org`.)
- When: The Sandbox completes the run with an answer through `POST /api/webhooks/run/complete`.
- Then: Presence is queried on `user-org-foreground:<userId>:<orgId>` with limit 1, no Web push is sent, and exactly one APNs request carries an alert body, default sound, badge 1 and the thread ID, run ID and `<runId>:completed` notification ID. The thread has exactly one completed marker.

## chat-callbacks.bdd-016

- Vitest: "CHAT-02: completed chat callback > failed Web push observes same-org foreground presence while native alerts are delivered"
- Mode: run
- Given: A signed-in Pro member has a registered iOS device and a browser push subscription, the AI generation provider returns 503, and the member's Web foreground presence is in the same organization. (Row: status `failed`, presence `same-org`.)
- When: The Sandbox fails the run with exit code 1 and error "Task failed" through `POST /api/webhooks/run/complete`.
- Then: Presence is queried on `user-org-foreground:<userId>:<orgId>` with limit 1, no Web push is sent, and exactly one APNs request carries an alert body, default sound, badge 1 and the thread ID, run ID and `<runId>:failed` notification ID. The thread has exactly one failed marker.

## chat-callbacks.bdd-017

- Vitest: "CHAT-02: completed chat callback > completed Web push observes other-org foreground presence while native alerts are delivered"
- Mode: run
- Given: A signed-in Pro member has a registered iOS device and a browser push subscription, the AI generation provider returns 503, and the member is in the foreground only in another organization. (Row: status `completed`, presence `other-org`.)
- When: The Sandbox completes the run with an answer through `POST /api/webhooks/run/complete`.
- Then: Presence is queried on the member's own org foreground channel with limit 1, exactly one Web push is sent, and exactly one APNs request carries badge 1, default sound and the `<runId>:completed` notification ID. The thread has exactly one completed marker.

## chat-callbacks.bdd-018

- Vitest: "CHAT-02: completed chat callback > failed Web push observes other-org foreground presence while native alerts are delivered"
- Mode: run
- Given: A signed-in Pro member has a registered iOS device and a browser push subscription, the AI generation provider returns 503, and the member is in the foreground only in another organization. (Row: status `failed`, presence `other-org`.)
- When: The Sandbox fails the run with exit code 1 through `POST /api/webhooks/run/complete`.
- Then: Presence is queried on the member's own org foreground channel with limit 1, exactly one Web push is sent, and exactly one APNs request carries badge 1, default sound and the `<runId>:failed` notification ID. The thread has exactly one failed marker.

## chat-callbacks.bdd-019

- Vitest: "CHAT-02: completed chat callback > completed Web push observes none foreground presence while native alerts are delivered"
- Mode: run
- Given: A signed-in Pro member has a registered iOS device and a browser push subscription, the AI generation provider returns 503, and the member has no foreground presence. (Row: status `completed`, presence `none`.)
- When: The Sandbox completes the run with an answer through `POST /api/webhooks/run/complete`.
- Then: Presence is queried on the member's own org foreground channel with limit 1, exactly one Web push is sent, and exactly one APNs request carries badge 1, default sound and the `<runId>:completed` notification ID. The thread has exactly one completed marker.

## chat-callbacks.bdd-020

- Vitest: "CHAT-02: completed chat callback > failed Web push observes none foreground presence while native alerts are delivered"
- Mode: run
- Given: A signed-in Pro member has a registered iOS device and a browser push subscription, the AI generation provider returns 503, and the member has no foreground presence. (Row: status `failed`, presence `none`.)
- When: The Sandbox fails the run with exit code 1 through `POST /api/webhooks/run/complete`.
- Then: Presence is queried on the member's own org foreground channel with limit 1, exactly one Web push is sent, and exactly one APNs request carries badge 1, default sound and the `<runId>:failed` notification ID. The thread has exactly one failed marker.

## chat-callbacks.bdd-021

- Vitest: "CHAT-02: completed chat callback > delivers native alerts when the Web foreground query fails"
- Mode: run
- Given: A signed-in Pro member has a registered iOS device and a browser push subscription, the AI generation provider returns 503, and the Ably presence query fails.
- When: The Sandbox completes the run with "Completed answer" through `POST /api/webhooks/run/complete`.
- Then: Presence is queried on the member's own org foreground channel, no Web push is sent, and exactly one APNs request carries an alert body, default sound and the `<runId>:completed` notification ID. The thread contains "Completed answer".

## chat-callbacks.bdd-022

- Vitest: "CHAT-02: completed chat callback > keeps the completed output after a push delivery failure"
- Mode: run
- Given: A signed-in Pro member has a Web chat run and a registered browser push subscription, the AI generation provider returns 503, and Web push delivery fails.
- When: The Sandbox completes the run with "Completed answer" through `POST /api/webhooks/run/complete`.
- Then: A Web push with body "Your task is complete" is attempted, and the thread still contains "Completed answer".

## chat-callbacks.bdd-023

- Vitest: "CHAT-02: completed chat callback > offers billing recovery for a Slack run without changing the Web marker"
- Mode: run
- Given: A Pro member has installed the Slack app in a workspace and mentioned the bot in a channel, which dispatched a Slack chat run.
- When: The Sandbox fails the run with exit code 1, error "insufficient_credits" and failure reason `insufficient_credits` through `POST /api/webhooks/run/complete`.
- Then: Slack receives a message whose text contains the `/?settings=billing` link, and the Web thread has a `run.failed` event with failure reason `insufficient_credits` and content "insufficient_credits".

## chat-callbacks.bdd-024

- Vitest: "CHAT-02: completed chat callback > consumes the whole thread's unread state without push or unarchive for a Slack completed run"
- Mode: run
- Given: A Pro member installed Slack, completed a first Slack run, then ran a Web run in the same thread with a registered browser push subscription, leaving the thread unread after one Web push, and then archived the thread. (Row: `completed`.)
- When: The member mentions the bot again in the Slack thread, and the Sandbox completes that second Slack run through `POST /api/webhooks/run/complete`.
- Then: The second run uses the same chat thread. Afterwards `GET /api/indicators` shows no thread state and no unread timestamp for the thread, still only one Web push exists, the thread stays archived and unmuted, and its `lastReadAt` is at or after both the completed marker and the follow-ups event of the Slack run. No `unarchived` thread event is recorded.

## chat-callbacks.bdd-025

- Vitest: "CHAT-02: completed chat callback > consumes the whole thread's unread state without push or unarchive for a Slack failed run"
- Mode: run
- Given: A Pro member installed Slack, completed a first Slack run, then ran a Web run in the same thread with a registered browser push subscription, leaving the thread unread after one Web push, and then archived the thread. (Row: `failed`.)
- When: The member mentions the bot again in the Slack thread, and the Sandbox fails that second Slack run through `POST /api/webhooks/run/complete`.
- Then: The second run uses the same chat thread. Afterwards `GET /api/indicators` shows no thread state and no unread timestamp for the thread, still only one Web push exists, the thread stays archived and unmuted, and its `lastReadAt` is at or after the failed marker. No `unarchived` thread event is recorded.

## chat-callbacks.bdd-026

- Vitest: "CHAT-02: completed chat callback > keeps muted runs active but suppresses terminal unread, push and automatic unarchive"
- Mode: run
- Given: A signed-in Pro member with a registered browser push subscription starts a Web run, then mutes and archives its thread after admission; this is repeated for a completed and a failed run.
- When: The Sandbox completes (or fails) each run through `POST /api/webhooks/run/complete`, and afterwards the member marks all threads read and unmutes the thread.
- Then: While running the indicator shows the thread as `active`. After the terminal callback the thread has no indicator state or unread timestamp, no Web push is sent, it stays archived and muted, and no `unarchived` event is recorded. After unmuting, the indicator shows `unread` and the thread stays archived and unmuted.

## chat-callbacks.bdd-027

- Vitest: "CHAT-02: completed chat callback > unarchives the thread when a completed or failed run makes it unread, but not on cancellation"
- Mode: run
- Given: A signed-in Pro member has four Web runs, each in a thread archived after the run started.
- When: The Sandbox completes the first run, fails the second, the member cancels the third through `POST /api/runs/:id/cancel`, and the Sandbox fails the fourth with the error text "Run cancelled".
- Then: The completed and failed threads are unarchived with exactly one `unarchived` event each. The cancelled thread has one cancelled marker and stays archived with no `unarchived` event. The fourth run gets a failed marker and its thread is unarchived with one `unarchived` event.

## chat-callbacks.bdd-028

- Vitest: "CHAT-02: completed chat callback > pins the model, reasoning effort, and token budget of every fast-path completion"
- Mode: run
- Given: A signed-in Pro member has a Web chat run, and the OpenRouter model answers the title, follow-up, notification-sentence and run-summary requests successfully.
- When: The Sandbox completes the run through `POST /api/webhooks/run/complete` with a final answer.
- Then: The thread is titled "Budget Pinning" and has an `output.followups` event. The title, notification and run-summary requests each use model `gemini-3.1-flash-lite` with 2048 max output tokens, `MINIMAL` thinking and temperature 0.3, and the follow-up request uses `gemini-3.8-flash` with 2048 max output tokens and `LOW` thinking and no temperature.

## chat-callbacks.bdd-029

- Vitest: "CHAT-02: completed chat callback > pushes a token-limited notification summary instead of discarding it"
- Mode: run
- Given: A signed-in Pro member has a Web chat run and a registered browser push subscription. The notification-sentence model returns a truncated sentence with finish reason `length`.
- When: The Sandbox completes the run through `POST /api/webhooks/run/complete` with a final answer.
- Then: The notification sentence is requested exactly once, and a Web push is sent with the prompt as title and the truncated sentence as body.

## chat-callbacks.bdd-030

- Vitest: "CHAT-02: completed chat callback > falls back to the fixed notification copy when the token-limited summary strips to nothing"
- Mode: run
- Given: A signed-in Pro member has a Web chat run and a registered browser push subscription. The notification-sentence model returns only "---" with finish reason `length`.
- When: The Sandbox completes the run through `POST /api/webhooks/run/complete` with a final answer.
- Then: A Web push is sent with the prompt as title and the fallback body "Your task is complete", and no push has an empty body.

## chat-callbacks.bdd-031

- Vitest: "CHAT-02: completed chat callback > leaves the thread untitled when the title completion is token-limited"
- Mode: run
- Given: A signed-in Pro member, and the title model returns a title with finish reason `length`.
- When: The member starts a chat run through `POST /api/chat/events`.
- Then: The title is requested exactly once and the thread title stays null. The run can then be cancelled.

## chat-callbacks.bdd-032

- Vitest: "CHAT-02: completed chat callback > keeps an auto-sent follow-up pending until org concurrency frees a slot"
- Mode: run
- Given: A signed-in Pro member has two running Web chat runs under an org concurrency cap of 2 and queues a message behind the first run; the cap is then lowered to 1.
- When: The Sandbox completes the first run, and later the member cancels the second (blocking) run through `POST /api/runs/:id/cancel` and its Sandbox acknowledges the cancellation.
- Then: After the first run completes, the queued message stays pending with no replacement run. After the blocker is cancelled, the queued message gets exactly one replacement with a new run that reaches `running`.

## chat-callbacks.bdd-033

- Vitest: "CHAT-02/RUN-03: cancellation recovery barrier > redrives lifecycle-first recovery after a partial side-effect failure"
- Mode: run
- Given: A signed-in Pro member has a running Web chat run with a queued message, and the realtime publish of the first `chatThreadMessageCreated` signal for the thread fails.
- When: The member cancels the run through `POST /api/runs/:id/cancel`, then the Sandbox posts `POST /api/webhooks/run/complete` with exit code 1 and error "Run cancelled"; afterwards the Sandbox repeats the completion and the member repeats the cancel.
- Then: After the cancel the thread has one cancelled marker, the queued message has no replacement yet, `cancellationRecoveryPending` is true and `chatThreadDetailChanged:<threadId>` is published. The completion returns `{ success: true, status: "failed" }`, the run status stays `cancelled`, `chatThreadMessageCreated`, `desktopShellAuthorizationChanged` and `chatThreadDetailChanged` are published, recovery is no longer pending, and the queued message gets a replacement run. The duplicate completion and cancel leave exactly one replacement.

## chat-callbacks.bdd-034

- Vitest: "CHAT-02/RUN-03: cancellation recovery barrier > records recovery when completion with native history follows cancellation"
- Mode: run
- Given: A signed-in Pro member has a running Web chat run with a queued message.
- When: The member cancels the run through `POST /api/runs/:id/cancel`, then the Sandbox posts a successful `POST /api/webhooks/run/complete` with native session history.
- Then: The completion returns `{ success: true, status: "failed" }`, the run status is `cancelled`, and the queued message gets exactly one replacement run.

## chat-callbacks.bdd-035

- Vitest: "CHAT-02: chat output extraction and terminal callbacks > uses durable assistant output for queued auto-send"
- Mode: run
- Given: A signed-in Pro member has a running Web chat run with a queued message.
- When: The Sandbox posts an assistant event "DB-complete streamed answer" and a system event to `POST /api/webhooks/run/events`, then completes the run with `lastEventSequence` 1.
- Then: The thread has exactly one output message "DB-complete streamed answer" and one completed marker for the run, and the queued message is auto-sent with a different run.

## chat-callbacks.bdd-036

- Vitest: "CHAT-02: chat output extraction and terminal callbacks > uses every acknowledged DB assistant event"
- Mode: run
- Given: A signed-in Pro member has a running Web chat run.
- When: The Sandbox posts two separate assistant event batches ("Partial streamed answer" at sequence 0 and "Terminal DB answer" at sequence 1) to `POST /api/webhooks/run/events`, then completes the run with `lastEventSequence` 1.
- Then: The thread contains two output messages for the run, "Partial streamed answer" and "Terminal DB answer".

## chat-callbacks.bdd-037

- Vitest: "CHAT-02: chat output extraction and terminal callbacks > keeps repeated DB event batches idempotent"
- Mode: run
- Given: A signed-in Pro member has a running Web chat run.
- When: The Sandbox posts the same assistant event "Stored once" at sequence 0 twice to `POST /api/webhooks/run/events`, then completes the run with `lastEventSequence` 0.
- Then: The thread contains exactly one output message, "Stored once".

## chat-callbacks.bdd-038

- Vitest: "CHAT-02: chat output extraction and terminal callbacks > persists normalized Claude text blocks independently across tool-only sequences"
- Mode: run
- Given: A signed-in Pro member has a running Web chat run.
- When: The Sandbox posts, twice, a batch of four assistant events sharing one message ID (text A, a tool-only Read call, text B, text C at sequences 0–3) to `POST /api/webhooks/run/events`, then completes with `lastEventSequence` 3.
- Then: The thread has exactly three output messages with distinct IDs: "text A" (`event:0`, sequence 0), "text B" (`event:2`, sequence 2) and "text C" (`event:3`, sequence 3).

## chat-callbacks.bdd-039

- Vitest: "CHAT-02: chat output extraction and terminal callbacks > persists concurrent event batches instead of skipping output projection"
- Mode: run
- Given: A signed-in Pro member has a running Web chat run.
- When: The Sandbox concurrently posts six single-event assistant batches (sequences 0–5) to `POST /api/webhooks/run/events`.
- Then: All six requests return HTTP 200 and the thread immediately lists six output messages for the run.

## chat-callbacks.bdd-040

- Vitest: "CHAT-02: chat output extraction and terminal callbacks > keeps rejected event reservations as sequence gaps"
- Mode: run
- Given: A signed-in Pro member has a running Web chat run.
- When: The Sandbox posts assistant batches to `POST /api/webhooks/run/events` in this order: sequence 1; sequences 0 and 1; sequence 0 again; sequences 1 and 2; then sequence 3.
- Then: The thread lists output messages for exactly run sequences 0–3. The sequence-0 row's thread sequence ID is higher than the sequence-1 row's, the sequence-2 row's is more than two above the sequence-0 row's (rejected reservations leave gaps), and the sequence-3 row's is higher than the sequence-2 row's.

## chat-callbacks.bdd-041

- Vitest: "CHAT-02: chat output extraction and terminal callbacks > completes no-output runs and preserves the newest result-only output across retries"
- Mode: run
- Given: A signed-in Pro member has a running Web chat run.
- When: The Sandbox posts only a `user` event to `POST /api/webhooks/run/events` and completes the run; then, in a second run in the same thread, posts a result event "DB result fallback answer" at sequence 2 twice and an older result at sequence 1, and completes with `lastEventSequence` 2.
- Then: The first run gets a completed marker and no output message. The second run has exactly one output message, "DB result fallback answer".

## chat-callbacks.bdd-042

- Vitest: "CHAT-02: chat output extraction and terminal callbacks > excludes stored result output above the terminal event boundary"
- Mode: run
- Given: A signed-in Pro member has a running Web chat run.
- When: The Sandbox posts a result event at sequence 1 to `POST /api/webhooks/run/events`, then completes the run with `lastEventSequence` 0.
- Then: The run gets a completed marker and no output message.

## chat-callbacks.bdd-043

- Vitest: "CHAT-02: chat output extraction and terminal callbacks > completes when no output materialization exists"
- Mode: run
- Given: A signed-in Pro member has a running Web chat run with no posted output events.
- When: The Sandbox completes the run through `POST /api/webhooks/run/complete` with `lastEventSequence` 0.
- Then: The run gets a completed marker and no output message.

## chat-callbacks.bdd-044

- Vitest: "CHAT-02: chat output extraction and terminal callbacks > extracts assistant output from Codex items and result fallbacks, skips non-events, and handles heartbeats without reading events"
- Mode: run
- Given: A signed-in Pro member has a running Web chat run in one thread; later runs in the same thread use Codex items, already-streamed output and a failing title model.
- When: The Sandbox posts `POST /api/webhooks/run/heartbeat`, then completes four runs in turn through `POST /api/webhooks/run/events` and `POST /api/webhooks/run/complete`: one with blank text, tool items, a result fallback and a later result beyond `lastEventSequence`; one with a Codex `agent_message` item; one that streamed "Already streamed." and ends with a result "Unknown command: /aaa"; and one with a result while title generation fails.
- Then: `chatThreadMessageCreated:<threadId>` is published at launch, and after the heartbeat the thread lists two user messages: the original without a run and a replacement linked to the run. The first run's only output is "final fallback answer", the second's is "Codex answer", and the third's is "Already streamed.". The fourth run's status is `completed`, it gets a completed marker, and the thread title stays null.

## chat-callbacks.bdd-045

- Vitest: "CHAT-02: failed chat callbacks > presents personal subscription balance using persisted ownership across chat and detail reads"
- Mode: run
- Given: A signed-in Pro member runs a Web chat on their personal Claude subscription model, then clears the default model preference after the run starts. (Row: personal subscription balance.)
- When: The Sandbox fails the run with error "Credit balance is too low" and failure reason `provider_insufficient_credits` through `POST /api/webhooks/run/complete`.
- Then: The thread's failed marker has content "Your connected subscription account has insufficient balance." and failure reason `provider_insufficient_credits`. `GET /api/runs/:id` and `GET /api/logs/:id` both report `failed` with that failure reason, and exactly one user message is linked to a run.

## chat-callbacks.bdd-046

- Vitest: "CHAT-02: failed chat callbacks > presents vm0 credits during personal subscriptio… using persisted ownership across chat and detail reads"
- Mode: run
- Given: A signed-in Pro member runs a Web chat on their personal Claude subscription model, then clears the default model preference after the run starts. (Row: vm0 credits during personal subscription run.)
- When: The Sandbox fails the run with the insufficient-credits error text and failure reason `insufficient_credits` through `POST /api/webhooks/run/complete`.
- Then: The thread's failed marker has content "insufficient_credits" and failure reason `insufficient_credits`. `GET /api/runs/:id` and `GET /api/logs/:id` both report `failed` with that failure reason, and exactly one user message is linked to a run.

## chat-callbacks.bdd-047

- Vitest: "CHAT-02: failed chat callbacks > protects built-in=false multi-block=false billing events and network exports while preserving ordinary output"
- Mode: run
- Given: A signed-in Pro member runs a Web chat on the personal Claude subscription model (built-in false, a single text block in the provider billing error). Telemetry returns the run's agent events and nine network log entries for billable and non-billable upstream responses.
- When: The Sandbox posts 13 events to `POST /api/webhooks/run/events` (error and normal results, an ordinary assistant message, user and tool-result events, a `billing_error` assistant API error, `response.failed` and `error` events, and results with provider and vm0 credit failure reasons), fails the run with `provider_insufficient_credits`, and the member reads `GET /api/runs/:id/telemetry/events` and `GET /api/runs/:id/network`.
- Then: The thread has exactly one output message "Credit balance is too low" and one `output.error` "Your connected subscription account has insufficient balance.". The telemetry events are returned unchanged, and the network export returns every response body unchanged with statuses 400, 200, 400, 200, 200, 402, 402, 400, 400.

## chat-callbacks.bdd-048

- Vitest: "CHAT-02: failed chat callbacks > protects built-in=false multi-block=true billing events and network exports while preserving ordinary output"
- Mode: run
- Given: A signed-in Pro member runs a Web chat on the personal Claude subscription model (built-in false, the provider billing error has a second text block). Telemetry returns the run's agent events and nine network log entries for billable and non-billable upstream responses.
- When: The Sandbox posts 13 events to `POST /api/webhooks/run/events` (error and normal results, an ordinary assistant message, user and tool-result events, a multi-block `billing_error` assistant API error, `response.failed` and `error` events, and results with provider and vm0 credit failure reasons), fails the run with `provider_insufficient_credits`, and the member reads `GET /api/runs/:id/telemetry/events` and `GET /api/runs/:id/network`.
- Then: The thread has exactly one output message "Credit balance is too low" and one `output.error` "Your connected subscription account has insufficient balance.". The telemetry events are returned unchanged including both billing-error text blocks, and the network export returns every response body unchanged with statuses 400, 200, 400, 200, 200, 402, 402, 400, 400.

## chat-callbacks.bdd-049

- Vitest: "CHAT-02: failed chat callbacks > keeps subscription recovery on slack for ChatGPT (Codex) (structured=true)"
- Mode: run
- Given: A Pro member with native subscription models installed Slack and mentioned the bot, dispatching a Slack run on `gpt-6-astra` (ChatGPT Codex); the default model is then switched to Claude. (Row: Slack, ChatGPT (Codex), structured.)
- When: The Sandbox fails the run with the native Codex usage-limit message and failure reason `usage_limit` through `POST /api/webhooks/run/complete`.
- Then: The thread's `run.failed` event has the usage-limit message and failure reason `usage_limit`. Slack receives messages containing "Your ChatGPT (Codex) subscription", `?settings=model` and `reply "continue"`, and no Slack message contains the native provider text.

## chat-callbacks.bdd-050

- Vitest: "CHAT-02: failed chat callbacks > keeps subscription recovery on slack for Claude (structured=true)"
- Mode: run
- Given: A Pro member with native subscription models installed Slack and mentioned the bot, dispatching a Slack run on `claude-fable-5-1` (Claude); the default model is then switched to Codex. (Row: Slack, Claude, structured.)
- When: The Sandbox fails the run with the native Claude weekly-limit message and failure reason `usage_limit` through `POST /api/webhooks/run/complete`.
- Then: The thread's `run.failed` event has the usage-limit message and failure reason `usage_limit`. Slack receives messages containing "Your Claude subscription", `?settings=model` and `reply "continue"`, and no Slack message contains the native provider text.

## chat-callbacks.bdd-051

- Vitest: "CHAT-02: failed chat callbacks > keeps subscription recovery on slack for ChatGPT (Codex) (structured=false)"
- Mode: run
- Given: A Pro member with native subscription models installed Slack and mentioned the bot, dispatching a Slack run on `gpt-6-astra` (ChatGPT Codex); the default model is then switched to Claude. (Row: Slack, ChatGPT (Codex), unstructured.)
- When: The Sandbox fails the run with the native Codex usage-limit message and no failure reason through `POST /api/webhooks/run/complete`.
- Then: The thread's `run.failed` event has the transient-error message and failure reason `unknown`, and no Slack message contains the native provider text.

## chat-callbacks.bdd-052

- Vitest: "CHAT-02: failed chat callbacks > keeps subscription recovery on slack for Claude (structured=false)"
- Mode: run
- Given: A Pro member with native subscription models installed Slack and mentioned the bot, dispatching a Slack run on `claude-fable-5-1` (Claude); the default model is then switched to Codex. (Row: Slack, Claude, unstructured.)
- When: The Sandbox fails the run with the native Claude weekly-limit message and no failure reason through `POST /api/webhooks/run/complete`.
- Then: The thread's `run.failed` event has the transient-error message and failure reason `unknown`, and no Slack message contains the native provider text.

## chat-callbacks.bdd-053

- Vitest: "CHAT-02: failed chat callbacks > keeps subscription recovery on web for ChatGPT (Codex) (structured=true)"
- Mode: run
- Given: A signed-in Pro member with native subscription models and `gpt-6-astra` (ChatGPT Codex) as default starts a Web chat run; the default is then switched to Claude. (Row: Web, ChatGPT (Codex), structured.)
- When: The Sandbox fails the run with the native Codex usage-limit message and failure reason `usage_limit` through `POST /api/webhooks/run/complete`.
- Then: The thread's `run.failed` event has the usage-limit message and failure reason `usage_limit`.

## chat-callbacks.bdd-054

- Vitest: "CHAT-02: failed chat callbacks > keeps subscription recovery on web for Claude (structured=true)"
- Mode: run
- Given: A signed-in Pro member with native subscription models and `claude-fable-5-1` (Claude) as default starts a Web chat run; the default is then switched to Codex. (Row: Web, Claude, structured.)
- When: The Sandbox fails the run with the native Claude weekly-limit message and failure reason `usage_limit` through `POST /api/webhooks/run/complete`.
- Then: The thread's `run.failed` event has the usage-limit message and failure reason `usage_limit`.

## chat-callbacks.bdd-055

- Vitest: "CHAT-02: failed chat callbacks > formats failed-run errors and notifies, without auto-sending"
- Mode: run
- Given: A signed-in Pro member with native subscription models and a registered browser push subscription runs twelve rounds in one Web thread, some with a selected model (Claude Fable 5.1 or `gpt-6-astra`).
- When: For each round the Sandbox fails the run through `POST /api/webhooks/run/complete` with a specific error and optional failure reason (none, an unknown `future_reason`, `execution_timeout`, `provider_rate_limited`, `usage_limit`, `insufficient_credits`, `provider_overloaded`, `safety_policy_refusal`, `codex_access_program_unavailable`); rounds with a reason then receive a late conflicting `provider_overloaded` failure.
- Then: Each failure publishes `chatThreadMessageCreated:<threadId>`. The thread has twelve original user messages and twelve run-linked replacements, and each failed marker shows the presented message for its reason (transient error for no reason or overload, generic "Oops, something went wrong. Please try again later." for unknown or rate-limit reasons, execution-timeout, usage-limit, `insufficient_credits`, content-policy and Codex access-program messages), never the late conflicting failure. Failure reasons are the round's reason or `unknown` in both the projected events and raw event rows, the `future_reason` row payload is only the generic content, the Codex run reads back as `failed` with `codex_access_program_unavailable`, exactly twelve Web pushes are sent, and the second and fifth pushes carry "Task failed: …" bodies and the thread URL.

## chat-callbacks.bdd-056

- Vitest: "CHAT-02: failed chat callbacks > stores insufficient credits failures as the billing recovery marker"
- Mode: run
- Given: A signed-in Pro member has a running Web chat run.
- When: The Sandbox fails the run with an `INSUFFICIENT_CREDITS` error text and failure reason `insufficient_credits` through `POST /api/webhooks/run/complete`.
- Then: The thread's failed marker has failure reason `insufficient_credits` and content "insufficient_credits".

## chat-callbacks.bdd-057

- Vitest: "CHAT-02: failed chat callbacks > presents overload from its reason without forwarding the raw run error"
- Mode: run
- Given: A signed-in Pro member has a running Web chat run on Claude Fable 5.1.
- When: The Sandbox fails the run with a raw "API Error: 529 Overloaded" message and failure reason `provider_overloaded` through `POST /api/webhooks/run/complete`.
- Then: The thread's failed marker shows the transient-error message instead of the raw error, and `GET /api/runs/:id` reports failure reason `provider_overloaded`.

## chat-callbacks.bdd-058

- Vitest: "CHAT-02: failed chat callbacks > preserves credential recovery state for legacy diagnostic without parsing diagnostic text"
- Mode: run
- Given: A signed-in Pro member has a personal Claude Code OAuth subscription provider and a Web chat run on `claude-opus-5-5`. (Row: legacy diagnostic, no failure reason.)
- When: The Sandbox fails the run with a "401 OAuth access token has been revoked" error and no failure reason through `POST /api/webhooks/run/complete`.
- Then: The thread's failed marker has failure reason `unknown` and the transient-error message, and `GET /api/runs/:id` reports `failed`, `unknown` and provider type `claude-code-oauth-token`.

## chat-callbacks.bdd-059

- Vitest: "CHAT-02: failed chat callbacks > preserves credential recovery state for invalid credentials without parsing diagnostic text"
- Mode: run
- Given: A signed-in Pro member has a personal Claude Code OAuth subscription provider and a Web chat run on `claude-opus-5-5`. (Row: invalid credentials.)
- When: The Sandbox fails the run with a "401 OAuth access token has been revoked" error and failure reason `invalid_credentials` through `POST /api/webhooks/run/complete`.
- Then: The thread's failed marker has failure reason `invalid_credentials` and the transient-error message, and `GET /api/runs/:id` reports `failed`, `invalid_credentials` and provider type `claude-code-oauth-token`.

## chat-callbacks.bdd-060

- Vitest: "CHAT-02: failed chat callbacks > preserves credential recovery state for reconnection required without parsing diagnostic text"
- Mode: run
- Given: A signed-in Pro member has a personal Claude Code OAuth subscription provider and a Web chat run on `claude-opus-5-5`. (Row: reconnection required.)
- When: The Sandbox fails the run with a "401 OAuth access token has been revoked" error and failure reason `reconnect_required`; the member then replaces the subscription token and retries in the same thread, and the retry completes.
- Then: The thread's failed marker has failure reason `reconnect_required` and the transient-error message, and `GET /api/runs/:id` reports `failed`, `reconnect_required` and provider type `claude-code-oauth-token`. The token update returns HTTP 200 and the retry run reads back as `completed`.

## chat-callbacks.bdd-061

- Vitest: "CHAT-02: auto-send after failures > preserves dense completed output and continuation across event pages"
- Mode: run
- Given: A signed-in Pro member has a completed anchor run and then a run in the same thread that streamed 205 assistant outputs. (Row: `completed`.)
- When: The Sandbox completes the dense run with `lastEventSequence` 204, and the member sends a probe message in the same thread.
- Then: The thread lists all 205 outputs and one completed marker. The probe run's context prompt is the probe text, its execution input continues the native session of the dense run, and it completes.

## chat-callbacks.bdd-062

- Vitest: "CHAT-02: auto-send after failures > preserves dense failed output and continuation across event pages"
- Mode: run
- Given: A signed-in Pro member has a completed anchor run and then a run in the same thread that streamed 205 assistant outputs. (Row: `failed`.)
- When: The Sandbox fails the dense run, and the member sends a probe message in the same thread.
- Then: The thread lists all 205 outputs and one failed marker. The probe run's context prompt is the probe text, and its appended system prompt contains "# Incomplete Rounds Context", the dense prompt, exactly one `RUN_STATUS: failed` line and all 205 outputs as "Assistant (partial): …" lines in order.

## chat-callbacks.bdd-063

- Vitest: "CHAT-02: auto-send after failures > uses structured failed messages for normal and queued incomplete-round context"
- Mode: run
- Given: A signed-in Pro member has a completed anchor run, then runs a structured message (illustration template part, text "structured failed request" and a feedback quote with note) with a stale legacy prompt, which fails; later another identical structured run is running with a queued probe.
- When: The member sends a normal probe through `POST /api/chat/events` after the first failure; then the Sandbox fails the second structured run through `POST /api/webhooks/run/complete`, which auto-sends the queued probe.
- Then: Both the normal probe's and the auto-sent probe's run contexts (`GET /api/runs/:id/context`) include in the appended system prompt the template label and the rendered feedback text ("The user quoted this part of your reply: … Name the responsible owner").

## chat-callbacks.bdd-064

- Vitest: "CHAT-02: auto-send after failures > preserves a failed request and its attachment in the public direct run context"
- Mode: run
- Given: A signed-in Pro member has a completed anchor run, then a run with an uploaded text file and the text "preserve this request and its attachment" that the Sandbox fails. (Row: `direct`.)
- When: The member sends a probe message directly through `POST /api/chat/events`.
- Then: The probe's run context has the probe text as prompt, a null session ID, and an appended system prompt with "# Incomplete Rounds Context", exactly one `RUN_STATUS: failed` line, the failed prompt and the `[Web file] <filename> (<type>)` line with the file ID.

## chat-callbacks.bdd-065

- Vitest: "CHAT-02: auto-send after failures > preserves a failed request and its attachment in the public queued run context"
- Mode: run
- Given: A signed-in Pro member has a completed anchor run, then a run with an uploaded text file and the text "preserve this request and its attachment" that the Sandbox fails. (Row: `queued`.)
- When: The member starts a blocker run, queues the probe message behind it, and the Sandbox fails the blocker so the probe is auto-sent.
- Then: The auto-sent probe's run context has the probe text as prompt, a null session ID, and an appended system prompt with "# Incomplete Rounds Context", exactly two `RUN_STATUS: failed` lines, the failed prompt and the `[Web file] <filename> (<type>)` line with the file ID.

## chat-callbacks.bdd-066

- Vitest: "CHAT-02: auto-send after failures > preserves the successful round boundary when a published follow-up is revoked"
- Mode: run
- Given: A signed-in Pro member has an anchor run that completes and produces a delayed recommended follow-up (requested exactly once), followed by a failed run in the same thread.
- When: The member sends a message that revokes the late follow-up, its run fails, and the member then sends a probe message.
- Then: The probe's run context appended system prompt still contains the first failed run's prompt.

## chat-callbacks.bdd-067

- Vitest: "CHAT-02: auto-send after failures > auto-sends the queued message after a failure with attachments, incomplete-round context, and fresh native intent"
- Mode: run
- Given: A signed-in Pro member has a completed first run on Claude Fable 5.1 (its framework session ID is recorded), then a second run with an uploaded file and a 4,200+ character prompt; a message with another uploaded file is queued and a browser push subscription is registered.
- When: The Sandbox fails the second run with "boom"; later the member queues another message and the Sandbox repeats the same failure callback.
- Then: The queued message is auto-sent with a new run and its file part. The new run's context prompt contains the queued text, the `[Web file] queued-notes.txt (text/plain)` line and file ID; the appended prompt contains "# Incomplete Rounds Context", "RUN_STATUS: failed", "...[truncated]" and the context file line, and the session ID is null. Exactly one Web push is sent, and the duplicate failure sends no new push and leaves the second queued message pending without a run.

## chat-callbacks.bdd-068

- Vitest: "CHAT-02: auto-send after failures > keeps only the newest 20 incomplete rounds despite late older output for normal and queued callback sends"
- Mode: run
- Given: A signed-in Pro member has a completed anchor run followed by 21 incomplete rounds in the same thread: the oldest failed, the other 20 cancelled. The oldest run then posts 33 late assistant outputs.
- When: The member sends a normal probe through `POST /api/chat/events`, queues another probe, and the Sandbox fails the normal probe so the queued probe is auto-sent.
- Then: The 33 late outputs are listed in order after the newest input. The normal probe's context contains "# Incomplete Rounds Context" with exactly 20 `RUN_STATUS` lines whose user prompts are rounds 2–21. The auto-sent probe's context has 20 `RUN_STATUS` lines (19 cancelled, 1 failed) with user prompts for rounds 3–21 plus the normal probe.

## chat-callbacks.bdd-069

- Vitest: "CHAT-02: auto-send across a model switch > rejects a queued message whose model the workspace no longer offers"
- Mode: run
- Given: A signed-in Pro member with a personal Claude Code OAuth subscription completed a first Opus run with a long prompt, has a second run running, and queued a message; the title model returns "Working with JSON".
- When: The member deletes the Claude Code subscription provider (HTTP 204), and the Sandbox completes the second run through `POST /api/webhooks/run/complete`.
- Then: The queued message becomes an `input.rejected` event with error `conflict`, and no run-linked copy of it exists. Exactly one title request was made, containing "How do I parse JSON?" but not the second answer.

## chat-callbacks.bdd-070

- Vitest: "CHAT-02: auto-send across a model switch > resumes the CLI session by default when the queued model stays within the same family"
- Mode: run
- Given: A signed-in Pro member with a personal Claude Code OAuth subscription completed a first Opus run; a second run in the same thread is running, after which the thread model selection is changed to Claude Fable 5.1 and a message is queued.
- When: The Sandbox completes the second run through `POST /api/webhooks/run/complete`.
- Then: The queued message is auto-sent with a new run whose context resumes session `bdd-cli-<secondRunId>` and has `ANTHROPIC_MODEL` set to `claude-fable-5-1`.

## chat-callbacks.bdd-071

- Vitest: "CHAT-02: thread deletion while a run is active > skips terminal processing when the thread is gone"
- Mode: run
- Given: A signed-in Pro member has a Web chat run that the Runner has picked up; `chatThreadMessageCreated:<threadId>` was published at launch.
- When: The member deletes the thread through `DELETE /api/chat-threads/:id`.
- Then: The run status becomes `cancelled`, and reading the thread through `GET /api/chat-threads/:id` returns HTTP 404.

## chat-callbacks.bdd-072

- Vitest: "CHAT-02: push notification gating > reuses the native signing token until its fifty-minute lifetime ends"
- Mode: run
- Given: A signed-in Pro member has a registered iOS device and the APNs provider accepts requests.
- When: The member completes one chat run at minute 0, minute 49 and minute 50 (the clock advances between runs), each through `POST /api/webhooks/run/complete`.
- Then: APNs receives three requests. The minute-49 request reuses the minute-0 bearer token, the minute-50 request uses a new token, and every token verifies against the provider key with issuer `TESTTEAM01`.

## chat-callbacks.bdd-073

- Vitest: "CHAT-02: push notification gating > delivers native completion without VAPID, uses a versioned envelope, and retires only invalid tokens"
- Mode: run
- Given: A signed-in Pro member has a production and a sandbox iOS registration, no VAPID keys, and the first APNs response is a delayed 410 Unregistered; while it is pending the device registration advances to revision 2 with a new device token.
- When: The member completes a first run, then fails a second run and completes a third, each through `POST /api/webhooks/run/complete`; APNs answers the second request with 410 Unregistered.
- Then: The first APNs request goes to `https://api.push.apple.com` at `/3/device/<token>` with topic `ai.okou.ios`, push type `alert`, priority 10 and collapse ID `<runId>:completed`, an ES256 JWT with key ID `TESTKEY001` verifying with issuer `TESTTEAM01`, and a payload with content-available, mutable-content, badge 1 and a version 1 `okou` envelope with user, workspace, thread, run and notification IDs; no Web push is sent. The failed run's alert goes to the new token with body "Task failed: Oops, something went wrong. Please try again later." and notification ID `<runId>:failed`. After that 410, the third run sends no APNs request (two requests in total).

## chat-callbacks.bdd-074

- Vitest: "CHAT-02: push notification gating > keeps legacy alerts and retires notification-state support when registration advances"
- Mode: run
- Given: A signed-in Pro member has an iOS registration that does not support notification state, and the Web foreground presence query returns the member as present.
- When: The member completes a run, marks the thread read, reconciles notifications through `POST /api/ios-notifications/reconcile`, advances the registration to a new legacy revision, reconciles again with the old registration, and completes another run.
- Then: The first run sends one APNs alert with content-available, mutable-content, default sound and the thread and run IDs but no badge, and marking the thread read sends no further request. The later run sends a second alert for its run ID, again without a badge.

## chat-callbacks.bdd-075

- Vitest: "CHAT-02: push notification gating > updates the icon badge after reads, unread changes, muting, and bulk reads without another alert"
- Mode: run
- Given: A signed-in Pro member has a registered iOS device that supports notification state.
- When: The member completes a run, then marks the thread read, marks it unread, mutes it, unmutes it and marks all threads read.
- Then: The completion alert carries badge 1, and each later change sends a badge-only APNs payload: badge 0 after read, 1 after unread, 0 after mute, 1 after unmute and 0 after the bulk read.

## chat-callbacks.bdd-076

- Vitest: "CHAT-02: push notification gating > keeps acknowledged chats out of later alert and badge-only pushes on that device"
- Mode: run
- Given: A signed-in Pro member has a phone and a tablet iOS registration and an unread completed chat.
- When: The phone reconciles through `POST /api/ios-notifications/reconcile` with `badgeClearSequence` 1, the member marks that chat unread, completes another run one second later, and then marks the new chat read.
- Then: The reconcile returns `unreadCount` 1 and `badgeCount` 0 and the chat stays in the unread list. After marking unread, the phone's latest payload is badge 0 and the tablet's badge 1. The new completion alerts the phone with badge 1 and the tablet with badge 2, and after reading the new chat the phone gets badge 0 and the tablet badge 1.

## chat-callbacks.bdd-077

- Vitest: "CHAT-02: push notification gating > uses sandbox credentials and the sandbox APNs destination independently of production"
- Mode: run
- Given: A signed-in Pro member has a production and a sandbox iOS registration, and only sandbox APNs credentials are configured.
- When: The member completes a run through `POST /api/webhooks/run/complete`.
- Then: Exactly one APNs request is sent, to `https://api.sandbox.push.apple.com`, with a JWT key ID `TESTKEY002` that verifies with issuer `TESTTEAM01`.

## chat-callbacks.bdd-078

- Vitest: "CHAT-02: push notification gating > withholds native run alerts for revoked eligibility"
- Mode: run
- Given: A signed-in Pro member has a registered iOS device and a Web chat run, and Clerk reports the member's session as revoked. (Row: `revoked`.)
- When: The Sandbox completes the run through `POST /api/webhooks/run/complete`.
- Then: No APNs request is sent.

## chat-callbacks.bdd-079

- Vitest: "CHAT-02: push notification gating > withholds native run alerts for muted eligibility"
- Mode: run
- Given: A signed-in Pro member has a registered iOS device and a Web chat run whose thread the member mutes. (Row: `muted`.)
- When: The Sandbox completes the run through `POST /api/webhooks/run/complete`.
- Then: The only APNs request is a badge-only payload with badge 0; no alert is sent.

## chat-callbacks.bdd-080

- Vitest: "CHAT-02: push notification gating > withholds native run alerts for membership eligibility"
- Mode: run
- Given: A signed-in Pro member has a registered iOS device and a Web chat run, and Clerk returns no organization memberships for the member. (Row: `membership`.)
- When: The Sandbox completes the run through `POST /api/webhooks/run/complete`.
- Then: No APNs request is sent.

## chat-callbacks.bdd-081

- Vitest: "CHAT-02: push notification gating > uses the Okou VAPID contact identity for every subscription"
- Mode: run
- Given: A signed-in Pro member has VAPID keys configured and two registered browser push subscriptions.
- When: The Sandbox completes a chat run through `POST /api/webhooks/run/complete`.
- Then: Two Web pushes are sent, one per subscription endpoint, each with VAPID subject `mailto:contact@okou.ai` and the configured public and private keys.

## chat-callbacks.bdd-082

- Vitest: "CHAT-02: push notification gating > withholds pushes without VAPID keys and deletes stale subscriptions after gone responses"
- Mode: run
- Given: A signed-in Pro member has a registered browser push subscription and VAPID keys are not configured.
- When: The Sandbox completes a first run; VAPID is then enabled and the push service answers the next push with 410 Gone; a second and third run in the same thread complete.
- Then: The first run completes with no output and no Web push. The second run sends exactly one push with title "now with vapid", body "Your task is complete" and the thread URL. The third run sends no further push (one push in total).
