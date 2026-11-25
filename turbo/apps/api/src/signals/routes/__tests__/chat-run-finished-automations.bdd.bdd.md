# chat-run-finished-automations.bdd

## chat-run-finished-automations.bdd-001

- Vitest: "chat-run-finished workflow automations > shares one created destination across concurrent creates and rebinds after deletion"
- Mode: run
- Given: A signed-in Pro member has a workflow and a chat thread to watch.
- When: The member creates two `chat-run-finished` automations for the thread concurrently with `POST /api/workflows/:workflowId/automations`, lists automations for the destination thread, deletes the destination chat thread, reads both automations, and creates another automation.
- Then: Both creates return HTTP 201 with the same destination chat thread, `GET /api/chat-threads/:threadId/workflow-automations` lists exactly both automations, and the thread events contain exactly one `created` event for the destination. After deletion both automations read `enabled: false` and `chatThreadId: null`; the new automation gets a different destination thread with exactly one `created` event.

## chat-run-finished-automations.bdd-002

- Vitest: "chat-run-finished workflow automations > requires the watched chat thread to belong to the automation owner"
- Mode: run
- Given: A signed-in Pro member has a workflow, and another member of the same organization owns a chat thread.
- When: The member creates `chat-run-finished` automations with `POST /api/workflows/:workflowId/automations` watching an unknown thread ID and watching the other member's thread.
- Then: Both requests return HTTP 400 with an error message containing "Chat thread not found".

## chat-run-finished-automations.bdd-003

- Vitest: "chat-run-finished workflow automations > prevents a workflow from watching its own chat thread"
- Mode: run
- Given: A signed-in Pro member has a workflow bound to one of the member's chat threads.
- When: The member creates a `chat-run-finished` automation on that workflow watching the workflow's own chat thread.
- Then: The request returns HTTP 400 with the message "A workflow cannot watch run-finished events from its own chat thread".

## chat-run-finished-automations.bdd-004

- Vitest: "chat-run-finished workflow automations > fires claimable matching automations when a watched run completes"
- Mode: run
- Given: A signed-in Pro member with a personal Claude subscription has a running watched chat Run titled "Watched chat run" and four enabled `chat-run-finished` automations on separate workflows: always, `failed` only, `completed` with pattern `*deploy failed*`, and pattern `*all systems nominal*`.
- When: The Run emits the assistant text "Alert: Deploy FAILED on prod" and completes successfully via `POST /api/webhooks/run/complete`.
- Then: The always and case-insensitive pattern-match automations record a `lastRunAt`, while the failed-only and pattern-miss automations stay `null`. The always automation's thread has exactly one launched input with only a `chat_thread` reference to the source Run, thread and title, displayed as "A run in the watched chat thread completed.". `GET /api/logs?status=running` lists exactly two Runs, and the triggered Run's prompt contains `"failureReason": null`.

## chat-run-finished-automations.bdd-005

- Vitest: "chat-run-finished workflow automations > fires failed-status automations without matching patterns on errors"
- Mode: run
- Given: A signed-in Pro member has a running watched chat Run and four enabled `chat-run-finished` automations: `failed` only, `completed` only, `failed` with pattern `*boom*`, and `failed` with pattern `*provider_rate_limited*`.
- When: The sandbox reports the Run failed with exit code 1, error "boom: sandbox exploded" and failure reason `provider_rate_limited`.
- Then: Only the failed-only automation records a `lastRunAt`, and its thread has exactly one launched input referencing the source Run and thread with the watched title; the completed-only and both pattern automations keep `lastRunAt` `null`.

## chat-run-finished-automations.bdd-006

- Vitest: "chat-run-finished workflow automations > passes the recorded provider rate limit to the recovery Agent"
- Mode: run
- Given: A signed-in Pro member with a personal Claude subscription has a watched chat thread whose Run was started with model `claude-fable-5-1`, and a workflow with an enabled `chat-run-finished` automation for that thread limited to `failed` runs (row "provider rate limit").
- When: The sandbox reports the Run failed with exit code 1 and "The provider could not finish the request" and failure reason `provider_rate_limited` via `POST /api/webhooks/run/complete`, then reports a second failure with `failureReason: "provider_overloaded"`.
- Then: The automation's `lastRunAt` is set. The source thread's `run.failed` event keeps failure reason `provider_rate_limited`, the automation thread has exactly one launched input referencing the source Run and thread with the watched title, and the recovery Run's execution prompt contains `"runStatus": "failed"` and `"failureReason": "provider_rate_limited"`.

## chat-run-finished-automations.bdd-007

- Vitest: "chat-run-finished workflow automations > passes the recorded personal provider balance to the recovery Agent"
- Mode: run
- Given: A signed-in Pro member with a personal Claude subscription has a watched chat thread whose Run was started with model `claude-fable-5-1`, and a workflow with an enabled `chat-run-finished` automation for that thread limited to `failed` runs (row "personal provider balance").
- When: The sandbox reports the Run failed with exit code 1 and "The provider could not finish the request" and failure reason `provider_insufficient_credits` via `POST /api/webhooks/run/complete`, then reports a second failure with `failureReason: "provider_overloaded"`.
- Then: The automation's `lastRunAt` is set. The source thread's `run.failed` event keeps failure reason `provider_insufficient_credits`, the automation thread has exactly one launched input referencing the source Run and thread with the watched title, and the recovery Run's execution prompt contains `"runStatus": "failed"` and `"failureReason": "provider_insufficient_credits"`.

## chat-run-finished-automations.bdd-008

- Vitest: "chat-run-finished workflow automations > passes the recorded redacted platform provider balance to the recovery Agent"
- Mode: run
- Given: A signed-in Pro member with a personal Claude subscription has a watched chat thread whose Run was started on the built-in platform model (no model preference, platform OpenRouter key configured), and a workflow with an enabled `chat-run-finished` automation for that thread limited to `failed` runs (row "redacted platform provider balance").
- When: The sandbox reports the Run failed with exit code 1 and "The provider could not finish the request" and failure reason `provider_insufficient_credits` via `POST /api/webhooks/run/complete`, then reports a second failure with `failureReason: "provider_overloaded"`.
- Then: The automation's `lastRunAt` is set. The source thread's `run.failed` event keeps failure reason `unknown`, the automation thread has exactly one launched input referencing the source Run and thread with the watched title, and the recovery Run's execution prompt contains `"runStatus": "failed"` and `"failureReason": "unknown"`.

## chat-run-finished-automations.bdd-009

- Vitest: "chat-run-finished workflow automations > passes the recorded future failure reason to the recovery Agent"
- Mode: run
- Given: A signed-in Pro member with a personal Claude subscription has a watched chat thread whose Run was started with model `claude-fable-5-1`, and a workflow with an enabled `chat-run-finished` automation for that thread limited to `failed` runs (row "future failure reason").
- When: The sandbox reports the Run failed with exit code 1 and "The provider could not finish the request" and unrecognized failure reason `future_reason` via `POST /api/webhooks/run/complete`, then reports a second failure with `failureReason: "provider_overloaded"`.
- Then: The automation's `lastRunAt` is set. The source thread's `run.failed` event keeps failure reason `unknown`, the automation thread has exactly one launched input referencing the source Run and thread with the watched title, and the recovery Run's execution prompt contains `"runStatus": "failed"` and `"failureReason": "unknown"`.

## chat-run-finished-automations.bdd-010

- Vitest: "chat-run-finished workflow automations > passes the recorded unclassified failure to the recovery Agent"
- Mode: run
- Given: A signed-in Pro member with a personal Claude subscription has a watched chat thread whose Run was started with model `claude-fable-5-1`, and a workflow with an enabled `chat-run-finished` automation for that thread limited to `failed` runs (row "unclassified failure").
- When: The sandbox reports the Run failed with exit code 1 and "The provider could not finish the request" and no failure reason via `POST /api/webhooks/run/complete`, then reports a second failure with `failureReason: "provider_overloaded"`.
- Then: The automation's `lastRunAt` is set. The source thread's `run.failed` event keeps failure reason `unknown`, the automation thread has exactly one launched input referencing the source Run and thread with the watched title, and the recovery Run's execution prompt contains `"runStatus": "failed"` and `"failureReason": "unknown"`.

## chat-run-finished-automations.bdd-011

- Vitest: "chat-run-finished workflow automations > reports no failure reason when a cancelled run triggers recovery"
- Mode: run
- Given: A signed-in Pro member has a running watched chat Run and an enabled `chat-run-finished` automation limited to `cancelled` runs.
- When: The member cancels the Run (HTTP 200) and the sandbox reports exit code 1 with "Run cancelled" via `POST /api/webhooks/run/complete`.
- Then: The automation records a `lastRunAt`, its thread has exactly one launched input referencing the source Run and thread with the watched title, and the recovery Run's execution prompt contains `"runStatus": "cancelled"` and `"failureReason": null`.
