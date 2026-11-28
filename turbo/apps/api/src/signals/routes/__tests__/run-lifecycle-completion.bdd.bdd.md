# run-lifecycle-completion.bdd

## run-lifecycle-completion.bdd-001

- Vitest: "RUN-03: cancellation of dispatched and terminal runs > cancels a running Run and treats repeat cancellation as settled"
- Mode: run
- Given: A chat-ready member with `claude-fable-5-1` selected has a dispatched, running chat Run.
- When: The member cancels it with `POST /api/runs/:id/cancel`, then cancels it again.
- Then: The Run reads `running` before and `cancelled` after the first cancellation, and a realtime `cancel` message with the Run ID and `mode: cooperative` is published. The repeat cancellation returns HTTP 200.

## run-lifecycle-completion.bdd-002

- Vitest: "RUN-03: user-runner protocol and runner authentication > keeps Preview bypass outside Guest dispatch"
- Mode: run
- Given: An entitled member sends chat messages in a Preview environment with a valid Vercel bypass in a header, with a valid bypass in a cookie, and in development with an untrusted bypass header; the bypass secret is rotated before execution.
- When: For each case the member sends `POST /api/chat/events`, reads the projected conversation events, and the Runner reads the launched Run's execution input.
- Then: Each send returns HTTP 201 and launches a Run. No execution exposes `VERCEL_AUTOMATION_BYPASS_SECRET` in its platform environment or environment, and neither the original nor the rotated bypass value appears in its secret values.

## run-lifecycle-completion.bdd-003

- Vitest: "RUN-03: user-runner protocol and runner authentication > dispatches native continuation without reading history object metadata"
- Mode: run
- Given: An entitled member on the native Runner route completed a Run with a native-only session, and session history object metadata cannot be read from storage.
- When: The member continues the conversation and the Runner reads the execution input.
- Then: The execution's native continuation resumes the source Run's CLI session with the source Run as generation Run.

## run-lifecycle-completion.bdd-004

- Vitest: "RUN-03: user-runner protocol and runner authentication > scopes CLI PAT realtime access to allowed Runner groups"
- Mode: run
- Given: An entitled member has a CLI personal access token and a registered Runner group.
- When: Using the token, the member requests `POST /api/runners/realtime/token` for its Runner group and for `wrong-org/default`.
- Then: The allowed group returns HTTP 200 with exactly the issued token request. The other group returns HTTP 403 with message `Only vm0/* runner groups are supported`.

## run-lifecycle-completion.bdd-005

- Vitest: "RUN-03: user-runner protocol and runner authentication > rejects runner calls with malformed or wrong runner credentials"
- Mode: run
- Given: Runner callers present a Basic credential, a non-Runner bearer token, an invalid PAT, a too-short official Runner token, and a well-formed but wrong official Runner token.
- When: Each caller sends `POST /api/runners/heartbeat`.
- Then: Every request returns HTTP 401 with code `UNAUTHORIZED` and message `Not authenticated`.

## run-lifecycle-completion.bdd-006

- Vitest: "HOOK-01/RUN-03: terminal run callbacks dispatch on cancellation > delivers chat run callbacks through cancellation side effects"
- Mode: run
- Given: An entitled member has a conversation.
- When: The member sends three chat messages in turn and cancels each Run via `POST /api/runs/:id/cancel`; the first two sandboxes report cancelled completion, the third does not.
- Then: Each Run reads `cancelled`, and the conversation receives a `run.cancelled` event for each Run with `runLifecycleEvent` `cancelled`; the third one has text content.

## run-lifecycle-completion.bdd-007

- Vitest: "RUN-03: terminal run webhook admission > rejects heartbeats after ordinary terminal transitions"
- Mode: run
- Given: A chat-ready member has three dispatched Runs.
- When: The sandbox completes one with exit code 0 and another with exit code 1 via `POST /api/webhooks/run/complete`, the member cancels the third, and each sandbox then sends `POST /api/webhooks/run/heartbeat`.
- Then: All three heartbeats return HTTP 404.

## run-lifecycle-completion.bdd-008

- Vitest: "CHAIN-RUN: sandbox snapshot and telemetry reporting through run webhooks > reports snapshots and telemetry HTTP outcomes through authenticated sandbox webhooks"
- Mode: run
- Given: A chat-ready member has a dispatched chat Run with a Memory mount; telemetry ingest is configured.
- When: The sandbox posts network logs and sandbox operations via `POST /api/webhooks/run/telemetry`, posts telemetry again while telemetry ingest is unconfigured, prepares and commits a new Memory version, completes the Run with that storage output via `POST /api/webhooks/run/complete`, replays the same completion, and then posts a failing completion with exit code 1.
- Then: Both telemetry posts return HTTP 200 and the committed version differs from the original. Completion returns exactly `{ success: true, status: "completed" }`; the Run is `completed` with the exact storage outputs and `GET /api/logs/:id` shows `completed` with framework `claude-code`. The replay returns the same body and leaves the Run unchanged, and the late failing completion also returns `completed` with no failure reason recorded.

## run-lifecycle-completion.bdd-009

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes unknown as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, no error message, and failure reason `unknown`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `unknown` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `unknown`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-010

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes guest_memory_oom_killed as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `guest_memory_oom_killed`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `guest_memory_oom_killed` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `guest_memory_oom_killed`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-011

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes provider_bad_request as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `provider_bad_request`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `provider_bad_request` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `provider_bad_request`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-012

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes provider_image_too_large as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `provider_image_too_large`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `provider_image_too_large` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `provider_image_too_large`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-013

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes insufficient_credits as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `insufficient_credits`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `insufficient_credits` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `insufficient_credits`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-014

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes invalid_api_key as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `invalid_api_key`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `invalid_api_key` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `invalid_api_key`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-015

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes invalid_credentials as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `invalid_credentials`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `invalid_credentials` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `invalid_credentials`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-016

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes terms_acceptance_required as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `terms_acceptance_required`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `terms_acceptance_required` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `terms_acceptance_required`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-017

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes account_verification_required as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `account_verification_required`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `account_verification_required` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `account_verification_required`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-018

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes context_window_exceeded as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `context_window_exceeded`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `context_window_exceeded` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `context_window_exceeded`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-019

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes output_token_limit as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `output_token_limit`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `output_token_limit` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `output_token_limit`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-020

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes provider_rate_limited as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `provider_rate_limited`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `provider_rate_limited` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `provider_rate_limited`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-021

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes provider_overloaded as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `provider_overloaded`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `provider_overloaded` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `provider_overloaded`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-022

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes provider_stream_timeout as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `provider_stream_timeout`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `provider_stream_timeout` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `provider_stream_timeout`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-023

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes provider_request_timeout as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `provider_request_timeout`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `provider_request_timeout` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `provider_request_timeout`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-024

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes provider_server_error as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `provider_server_error`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `provider_server_error` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `provider_server_error`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-025

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes firewall_auth_failed as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `firewall_auth_failed`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `firewall_auth_failed` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `firewall_auth_failed`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-026

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes response_connection_lost as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `response_connection_lost`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `response_connection_lost` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `response_connection_lost`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-027

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes safety_policy_refusal as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `safety_policy_refusal`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `safety_policy_refusal` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `safety_policy_refusal`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-028

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes reconnect_required as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `reconnect_required`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `reconnect_required` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `reconnect_required`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-029

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > publishes usage_limit as the terminal failure reason"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, an error message, and failure reason `usage_limit`.
- Then: The completion returns exactly `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `usage_limit` and source `claude-code-oauth-token`/`claude-fable-5-1`, and the conversation has exactly one `run.failed` event for the Run with `usage_limit`, both in the projected and the raw event list.

## run-lifecycle-completion.bdd-030

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > normalizes a future reason and ignores contradictory legacy cancellation diagnostics"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1`.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1, the unrecognized failure reason `future_reason`, and a legacy error saying the Run was cancelled and mentioning a usage limit and a private URL.
- Then: The completion returns `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `unknown`, and the conversation has exactly one `run.failed` event with `unknown` whose content is the generic transient chat error message.

## run-lifecycle-completion.bdd-031

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completion failure reasons > preserves failed completion when sandbox root storage fills on claude-code-oauth-token"
- Mode: run
- Given: An entitled member has a dispatched chat Run on `claude-fable-5-1` with a Claude Code OAuth subscription.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1 and failure reason `guest_root_filesystem_full`.
- Then: The completion returns `{ success: true, status: "failed" }`. The Run is `failed` with failure reason `guest_root_filesystem_full`, and the conversation has exactly one `run.failed` event for it with that reason.

## run-lifecycle-completion.bdd-032

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > preserves exact native recovery outputs after a failed Runner fallback"
- Mode: run
- Given: An entitled member on the native Runner route has a dispatched Run that is already `failed` because the sandbox reports a failed completion.
- When: The sandbox posts a late completion with a native-only session via `POST /api/webhooks/run/complete`, replays it, posts a conflicting session ID, and the member continues the conversation.
- Then: The recovery completion returns `{ success: true, status: "failed" }` and the Run stays `failed` with a framework session ID and storage outputs. The replay leaves the result unchanged; the conflicting completion returns HTTP 400 with `[RUN_OUTPUT_ALREADY_COMMITTED]` and the result stays unchanged. In the continuation, the next Run gets no session to resume and instead a recovery prompt pointing to `okou chat messages --output-dir /tmp/okou-chat-history`.

## run-lifecycle-completion.bdd-033

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > preserves exact native recovery outputs after a cancelled Runner fallback"
- Mode: run
- Given: An entitled member on the native Runner route has a dispatched Run that is already `cancelled` because the member cancels it.
- When: The sandbox posts a late completion with a native-only session via `POST /api/webhooks/run/complete`, replays it, posts a conflicting session ID, and the member continues the conversation.
- Then: The recovery completion returns `{ success: true, status: "failed" }` and the Run stays `cancelled` with a framework session ID and storage outputs. The replay leaves the result unchanged; the conflicting completion returns HTTP 400 with `[RUN_OUTPUT_ALREADY_COMMITTED]` and the result stays unchanged. In the continuation, the next Run resumes the recovered CLI session with the original Run as generation Run.

## run-lifecycle-completion.bdd-034

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completes and resumes a run with claude-code native history"
- Mode: run
- Given: An entitled member on the native Runner route uses native subscription models with the native Claude model selected and has a dispatched Run using the `claude-code` agent.
- When: The sandbox completes with exit code 0, failure reason `provider_overloaded` and a native-only `claude-code` session via `POST /api/webhooks/run/complete`; it then replays the completion, replays it with exit code 1, sends a conflicting session ID, and sends a late Runner failure. The member continues the conversation, that Run completes with a successor session, the original completion is replayed again, and the member continues once more.
- Then: Completion returns exactly `{ success: true, status: "completed" }` and the Run is `completed` with framework `claude-code` and a session ID. The replay, the exit-code-1 replay and the late Runner failure all return the same body, while the conflicting session returns HTTP 400 with `Final output does not exactly match`; the result stays unchanged with no failure reason. The first continuation resumes the original session, the successor's framework session ID is recorded, the late replay still returns the same body, and the next continuation resumes the successor session.

## run-lifecycle-completion.bdd-035

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > completes and resumes a run with codex native history"
- Mode: run
- Given: An entitled member on the native Runner route uses native subscription models with `gpt-6-astra` selected and has a dispatched Run using the `codex` agent.
- When: The sandbox completes with exit code 0, failure reason `provider_overloaded` and a native-only `codex` session via `POST /api/webhooks/run/complete`; it then replays the completion, replays it with exit code 1, sends a conflicting session ID, and sends a late Runner failure. The member continues the conversation, that Run completes with a successor session, the original completion is replayed again, and the member continues once more.
- Then: Completion returns exactly `{ success: true, status: "completed" }` and the Run is `completed` with framework `codex` and a session ID. The replay, the exit-code-1 replay and the late Runner failure all return the same body, while the conflicting session returns HTTP 400 with `Final output does not exactly match`; the result stays unchanged with no failure reason. The first continuation resumes the original session, the successor's framework session ID is recorded, the late replay still returns the same body, and the next continuation resumes the successor session.

## run-lifecycle-completion.bdd-036

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > preserves generic cancellation recovery in a combined request"
- Mode: run
- Given: An entitled member on the native Runner route has a dispatched Run that the member cancels.
- When: The sandbox then posts a completion with exit code 1 and a native-only session via `POST /api/webhooks/run/complete`, and the member continues the conversation.
- Then: The recovery completion returns `{ success: true, status: "failed" }`, the Run stays `cancelled`, and the continuation resumes the recovered CLI session.

## run-lifecycle-completion.bdd-037

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > keeps execution auth valid through timeout completion and final telemetry"
- Mode: run
- Given: An entitled member has a dispatched Run whose sandbox token was issued at a fixed time.
- When: Two hours and one minute later the sandbox reports exit code 124 (`runner job timed out`); the member reads the Run and `GET /api/runs/:id/runner`; the sandbox posts telemetry, and again just over three hours after issue.
- Then: Completion returns `{ success: true, status: "failed" }` and the Run is `failed` with reason `unknown`. The Runner read returns exactly a null startup path and version, a `runner-*.okou.app` hostname, a Runner ID and heartbeat generation 1. The first telemetry post returns `{ success: true, id: <runId> }`; the later one returns HTTP 401 `UNAUTHORIZED`.

## run-lifecycle-completion.bdd-038

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > preserves initialized native binding through timeout and late recovery outputs"
- Mode: run
- Given: An entitled member on the native Runner route has a dispatched Run. The sandbox first reports a `system` `init` event carrying the CLI session ID.
- When: The sandbox reports a timeout completion (exit code 124) via `POST /api/webhooks/run/complete`, then posts late native-only session outputs, and the member continues the conversation.
- Then: The timeout completion returns `{ success: true, status: "failed" }` and the Run is `failed` with reason `unknown`. After the late outputs the Run result has a framework session ID and storage outputs, and the continuation resumes that CLI session with the source Run as generation Run.

## run-lifecycle-completion.bdd-039

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > preserves uninitialized native binding through timeout and late recovery outputs"
- Mode: run
- Given: An entitled member on the native Runner route has a dispatched Run. The sandbox never reported a session init event.
- When: The sandbox reports a timeout completion (exit code 124) via `POST /api/webhooks/run/complete`, then posts late native-only session outputs, and the member continues the conversation.
- Then: The timeout completion returns `{ success: true, status: "failed" }` and the Run is `failed` with reason `unknown`. After the late outputs the Run result has a framework session ID and storage outputs, and the continuation gets no session to resume and a recovery prompt pointing to `okou chat messages --output-dir /tmp/okou-chat-history`.

## run-lifecycle-completion.bdd-040

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > acknowledges a clean exit whose missing outputs fails the run"
- Mode: run
- Given: A chat-ready member has a dispatched chat Run with an assigned Runner.
- When: The sandbox posts a clean exit (code 0) without native session outputs via `POST /api/webhooks/run/complete`, and the member reads the Run and `GET /api/runs/:id/runner`.
- Then: The completion is acknowledged with `{ success: true, status: "failed" }`, the Run is `failed` with reason `unknown`, and the Runner metadata is unchanged.

## run-lifecycle-completion.bdd-041

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > reports the settled status when a metadata-free completion races a cancellation"
- Mode: run
- Given: A chat-ready member has a dispatched chat Run with an assigned Runner, and the member cancels it.
- When: The sandbox posts a clean completion without metadata via `POST /api/webhooks/run/complete`, then posts it again.
- Then: The completion returns `{ success: true, status: "failed" }`, the Run stays `cancelled`, and `GET /api/runs/:id/runner` returns the same Runner metadata before and after the repeat.

## run-lifecycle-completion.bdd-042

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > keeps a cancelled run settled when its finalized completion arrives late"
- Mode: run
- Given: A chat-ready member on the native Runner route has a dispatched chat Run, and the member cancels it.
- When: The sandbox then posts a clean completion with a native-only session via `POST /api/webhooks/run/complete`.
- Then: The completion returns `{ success: true, status: "failed" }` and the Run stays `cancelled`.

## run-lifecycle-completion.bdd-043

- Vitest: "RUN-03: sandbox completion reports against missing completion outputs and settled runs > persists native history and outputs atomically on completion"
- Mode: run
- Given: A chat-ready member on the native Runner route has a dispatched chat Run.
- When: The sandbox posts a clean completion with a native-only Claude session via `POST /api/webhooks/run/complete`.
- Then: The Run is `completed` and its result includes a framework session ID.
