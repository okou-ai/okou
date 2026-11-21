# Chat run models

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-run-models.test.tsx](chat-run-models.test.tsx).

## chat-run-models-001

Original test `Render structured failure unknown with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails with an unknown structured failure reason.
- **When** The failed run is displayed.
- **Then** The error card says “This run couldn't finish,” hides the raw provider diagnostic, shows a nonempty description, and offers no recovery action or model picker.

## chat-run-models-002

Original test `Render structured failure session_history_limit with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the session history limit is reached.
- **When** The failed run is displayed.
- **Then** The error card says “This chat has reached its limit,” hides the raw provider diagnostic, shows a nonempty description, and offers “New chat” without a model picker.

## chat-run-models-003

Original test `Render structured failure guest_root_filesystem_full with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the guest root filesystem is full.
- **When** The failed run is displayed.
- **Then** The error card says “This run ran out of space,” hides the raw provider diagnostic, shows a nonempty description, and offers “Try again” without a model picker.

## chat-run-models-004

Original test `Render structured failure guest_home_filesystem_full with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the guest home filesystem is full.
- **When** The failed run is displayed.
- **Then** The error card says “This run ran out of space,” hides the raw provider diagnostic, shows a nonempty description, and offers “Try again” without a model picker.

## chat-run-models-005

Original test `Render structured failure execution_timeout with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails after reaching its execution time limit.
- **When** The failed run is displayed.
- **Then** The error card says “Time limit reached,” hides the raw provider diagnostic, shows a nonempty description, and offers “Continue” without a model picker.

## chat-run-models-006

Original test `Render structured failure guest_memory_oom_killed with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the guest process is killed for running out of memory.
- **When** The failed run is displayed.
- **Then** The error card says “This run couldn't finish,” hides the raw provider diagnostic, shows a nonempty description, and offers “Try again” without a model picker.

## chat-run-models-007

Original test `Render structured failure insufficient_credits with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** An organization admin on the limited-free plan has no credits, and a run fails for insufficient credits.
- **When** The failed run is displayed.
- **Then** The error card says “Upgrade to Pro to run,” hides the raw provider diagnostic, shows no description, and offers “Upgrade to Pro” without a model picker.

## chat-run-models-008

Original test `Render structured failure provider_insufficient_credits with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the provider subscription account has insufficient credit.
- **When** The failed run is displayed.
- **Then** The error card says “Your subscription account needs more credit,” hides the raw provider diagnostic, shows a nonempty description, and offers “Open model settings” without a model picker.

## chat-run-models-009

Original test `Render structured failure invalid_api_key with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because its API key is invalid.
- **When** The failed run is displayed.
- **Then** The error card says “Your subscription sign-in needs updating,” hides the raw provider diagnostic, shows a nonempty description, and offers “Open model settings” without a model picker.

## chat-run-models-010

Original test `Render structured failure invalid_credentials with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because its model credentials are invalid.
- **When** The failed run is displayed.
- **Then** The error card says “Your model connection needs attention,” hides the raw provider diagnostic, shows a nonempty description, and offers “Open model settings” without a model picker.

## chat-run-models-011

Original test `Render structured failure terms_acceptance_required with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because Claude terms have not been accepted.
- **When** The failed run is displayed.
- **Then** The error card says “Claude terms need acceptance,” hides the raw provider diagnostic, shows a nonempty description, and offers “Open Claude” without a model picker.

## chat-run-models-012

Original test `Render structured failure account_verification_required with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the Claude account requires verification.
- **When** The failed run is displayed.
- **Then** The error card says “Claude account verification required” and explains that the account cannot receive replies and directs the user to the Anthropic Verification Portal. It hides the raw provider diagnostic and offers no recovery action or model picker.

## chat-run-models-013

Original test `Render structured failure context_window_exceeded with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the chat context window is exceeded.
- **When** The failed run is displayed.
- **Then** The error card says “This chat is too long,” hides the raw provider diagnostic, shows a nonempty description, and offers “New chat” without a model picker.

## chat-run-models-014

Original test `Render structured failure input_too_large with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the input is too large.
- **When** The failed run is displayed.
- **Then** The error card says “Your message is too large,” hides the raw provider diagnostic, shows a nonempty description, and offers no recovery action or model picker.

## chat-run-models-015

Original test `Render structured failure provider_image_too_large with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because a provider image is too large.
- **When** The failed run is displayed.
- **Then** The error card says “Your message is too large,” hides the raw provider diagnostic, shows a nonempty description, and offers no recovery action or model picker.

## chat-run-models-016

Original test `Render structured failure output_token_limit with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails after reaching the output token limit.
- **When** The failed run is displayed.
- **Then** The error card says “The response reached its length limit,” hides the raw provider diagnostic, shows a nonempty description, and offers “Continue” without a model picker.

## chat-run-models-017

Original test `Render structured failure provider_rate_limited with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the provider rate-limits requests.
- **When** The failed run is displayed.
- **Then** The error card says “Too many model requests right now,” hides the raw provider diagnostic, shows a nonempty description, and offers “Try again” with a model picker.

## chat-run-models-018

Original test `Render structured failure provider_overloaded with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the provider is overloaded.
- **When** The failed run is displayed.
- **Then** The error card says “This model is busy right now,” hides the raw provider diagnostic, shows a nonempty description, and offers “Try again” with a model picker.

## chat-run-models-019

Original test `Render structured failure provider_stream_timeout with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the provider response stream times out.
- **When** The failed run is displayed.
- **Then** The error card says “The model response timed out,” hides the raw provider diagnostic, shows a nonempty description, and offers “Try again” with a model picker.

## chat-run-models-020

Original test `Render structured failure provider_request_timeout with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the provider request times out.
- **When** The failed run is displayed.
- **Then** The error card says “The model response timed out,” hides the raw provider diagnostic, shows a nonempty description, and offers “Try again” with a model picker.

## chat-run-models-021

Original test `Render structured failure provider_queue_timeout with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the provider queue times out before the model starts.
- **When** The failed run is displayed.
- **Then** The error card says “The model didn't start in time,” hides the raw provider diagnostic, shows a nonempty description, and offers “Try again” with a model picker.

## chat-run-models-022

Original test `Render structured failure codex_access_program_unavailable with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because Codex access is temporarily unavailable.
- **When** The failed run is displayed.
- **Then** The error card says “Codex access is temporarily unavailable,” hides the raw provider diagnostic, shows a nonempty description, and offers “Try again” without a model picker.

## chat-run-models-023

Original test `Render structured failure provider_server_error with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the model provider has a server error.
- **When** The failed run is displayed.
- **Then** The error card says “The model provider had a temporary error,” hides the raw provider diagnostic, shows a nonempty description, and offers “Try again” with a model picker.

## chat-run-models-024

Original test `Render structured failure provider_bad_request with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the provider returns a bad request.
- **When** The failed run is displayed.
- **Then** The error card says “The model provider returned an error” and “Try again, or switch to another model to continue.” It hides the raw provider diagnostic and offers “Try again” with a model picker.

## chat-run-models-025

Original test `Render structured failure firewall_auth_failed with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because firewall authentication fails.
- **When** The failed run is displayed.
- **Then** The error card says “This run couldn't finish” and “Oops, something went wrong.” It hides the raw provider diagnostic and offers no recovery action or model picker.

## chat-run-models-026

Original test `Render structured failure response_connection_lost with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the response connection is lost.
- **When** The failed run is displayed.
- **Then** The error card says “The response was interrupted,” hides the raw provider diagnostic, shows a nonempty description, and offers “Try again” with a model picker.

## chat-run-models-027

Original test `Render structured failure safety_policy_refusal with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the model refuses under a safety policy.
- **When** The failed run is displayed.
- **Then** The error card says “The model couldn't help with this request,” hides the raw provider diagnostic, shows a nonempty description, and offers “Try again” with a model picker.

## chat-run-models-028

Original test `Render structured failure reconnect_required with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the model account needs to be reconnected.
- **When** The failed run is displayed.
- **Then** The error card says “Reconnect your model account,” hides the raw provider diagnostic, shows a nonempty description, and offers “Open model settings” without a model picker.

## chat-run-models-029

Original test `Render structured failure unsupported_model with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the selected model is unsupported.
- **When** The failed run is displayed.
- **Then** The error card says “Selected model isn't available,” hides the raw provider diagnostic, shows a nonempty description, and offers “Try again” with a model picker.

## chat-run-models-030

Original test `Render structured failure provider_model_restricted with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the selected model is restricted by the provider; the selected model is Auto.
- **When** The failed run is displayed.
- **Then** The error card says “Selected model isn't available” and “The current model is unavailable.” It hides the raw provider diagnostic and offers “Try again” with a model picker.

## chat-run-models-031

Original test `Render structured failure usage_limit with its available recovery actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L346).

- **Given** A chat run fails because the model provider usage limit is reached.
- **When** The failed run is displayed.
- **Then** The error card says “Model provider limit reached,” hides the raw provider diagnostic, shows a nonempty description, and offers “Try again” and “View details” with a model picker.

## chat-run-models-032

Original test `Offer Auto once, ahead of subscription models`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L405).

- **Given** A connected subscription model, GPT 5.6 Luna, is available and selected in a chat.
- **When** The user opens the chat model panel.
- **Then** Auto appears first and exactly once, and GPT 5.6 Luna is also listed.

## chat-run-models-033

Original test `Keep a next-run model choice through active-run steering (normal delivery)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L431).

- **Given** A run using GPT 5.6 Sol is active while GPT 5.6 Luna is selected for the next run.
- **When** The user sends a steering message and it is delivered normally, the active run completes, and the user sends a new task.
- **Then** The next-run choice remains GPT 5.6 Luna through steering, is not reported as a model change during steering, and the new run uses GPT 5.6 Luna with a model-change notice.

## chat-run-models-034

Original test `Keep a next-run model choice through active-run steering (completion before steering delivery)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L431).

- **Given** A run using GPT 5.6 Sol is active while GPT 5.6 Luna is selected for the next run.
- **When** The user sends a steering message, the active run completes before the persisted steering result is delivered to the browser, and the user sends a new task.
- **Then** The next-run choice remains GPT 5.6 Luna through steering, is not reported as a model change during steering, and the new run uses GPT 5.6 Luna with a model-change notice.

## chat-run-models-035

Original test `Preserve the current execution mode for an active-run follow-up`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L531).

- **Given** A GPT 5.6 Sol run using Fast execution mode is active.
- **When** The user sends a follow-up message during the active run.
- **Then** The follow-up retains Fast mode, does not specify a separate model choice, and shows no model-change notice.

## chat-run-models-036

Original test `Preserve which model a message was sent with`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L581).

- **Given** A new chat is set to Claude Sonnet 5.
- **When** The user sends “Preserve this model attribution.”
- **Then** The visible message is sent with the Claude Sonnet 5 model attribution.

## chat-run-models-037

Original test `Keep mixed Auto history continuous (okou-1.0 to auto)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L614).

- **Given** A thread has completed runs using Auto with models in this order: okou-1.0, then auto, followed by an explicit GPT 5.6 Luna run.
- **When** The user opens the thread history.
- **Then** The history shows one “Model changed to GPT 5.6 Luna” transition, not a transition between the two Auto runs.

## chat-run-models-038

Original test `Keep mixed Auto history continuous (auto to okou-1.0)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L614).

- **Given** A thread has completed runs using Auto with models in this order: auto, then okou-1.0, followed by an explicit GPT 5.6 Luna run.
- **When** The user opens the thread history.
- **Then** The history shows one “Model changed to GPT 5.6 Luna” transition, not a transition between the two Auto runs.

## chat-run-models-039

Original test `Mark model and speed transitions between runs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L669).

- **Given** A thread has completed runs first with GPT 5.6 Sol, then GPT 5.6 Luna, then GPT 5.6 Luna in priority mode, and finally GPT 5.6 Luna without priority mode.
- **When** The user views the run history.
- **Then** The history marks one model change to GPT 5.6 Luna and marks Fast mode on and off, for three transition markers total.

## chat-run-models-040

Original test `A structured capacity failure offers recovery despite generic provider text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L756).

- **Given** A run failed with the structured provider-overloaded reason and generic provider error text.
- **When** The user views the failed run.
- **Then** The recovery card says “This model is busy right now” and offers “Try again”; it does not display the generic provider error text.

## chat-run-models-041

Original test `A structured provider failure (Provider balance) shows concise inline recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L788).

- **Given** A run failed with the structured provider-insufficient-credits reason and a provider balance error message.
- **When** The user views the failure.
- **Then** The status card says “Your subscription account needs more credit” and offers “Open model settings.” It has no “View details” or “Upgrade to Pro” action.

## chat-run-models-042

Original test `Keep the error card's rows during delayed structured limit classification`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L808).

- **Given** A run failed with a structured usage-limit reason, and subscription-account details are initially unavailable.
- **When** The user views the card while account classification is pending, then the account details load for current@example.com.
- **Then** The pending and classified cards each retain two rows, and classification updates the same card. It shows “Model provider limit reached,” the personal subscription account, and “Try again.”

## chat-run-models-043

Original test `Recover from a personal model account limit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L856).

- **Given** A run on a personal subscription account failed with a usage limit. The account has five-hour and weekly limits at 100%, reset times of August 2, 2026 at 12:00 UTC and August 8, 2026 at 12:00 UTC, and two reset credits.
- **When** The user views the recovery details, dismisses and reopens them with the keyboard, selects GPT 5.6 Luna, and uses one reset credit.
- **Then** The recovery card and details show the five-hour and weekly reset information, and the details dialog identifies the personal subscription account. Dismissing the dialog restores focus to its trigger; the card offers “Try again” both before and after the model change, and using “Reset · 2 left” starts a continuation run.

## chat-run-models-044

Original test `Show the reset time for a limit reached while the thread is open`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L946).

- **Given** A thread is open on a personal subscription account, with its five-hour usage limit at 100% and a reset time of August 1, 2026 at 12:00 UTC.
- **When** The user sends a message and the run then fails with a usage limit.
- **Then** The recovery card shows a reset time and identifies the personal subscription account current@example.com.

## chat-run-models-045

Original test `Recover when a model is at capacity (current model offered: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L990).

- **Given** A run on GPT 5.6 Luna failed because the model was overloaded. The current model is included among the offered models.
- **When** The user opens the recovery model picker, selects GPT 5.6 Sol, and chooses “Try again.”
- **Then** The picker includes Auto and the configured models, initially focuses GPT 5.6 Luna, and allows GPT 5.6 Sol to be selected. Retrying starts a continuation run.

## chat-run-models-046

Original test `Recover when a model is at capacity (current model offered: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L990).

- **Given** A run on GPT 5.6 Luna failed because the model was overloaded. The current model is not included among the offered models.
- **When** The user opens the recovery model picker, selects GPT 5.6 Sol, and chooses “Try again.”
- **Then** The picker includes Auto and the offered models, initially focuses Auto, and allows GPT 5.6 Sol to be selected. Retrying starts a continuation run.

## chat-run-models-047

Original test `Reset the current route's active subscription account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L1053).

- **Given** A run on the active current subscription account failed with a usage limit and has one reset credit remaining.
- **When** The user views the account details and selects “Reset · 1 left.”
- **Then** No run is sent before the reset. The reset targets the current subscription account, then starts a continuation run.

## chat-run-models-048

Original test `Show a disconnected subscription on the current route`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L1100).

- **Given** A run on a personal subscription account failed with a usage limit, and the account needs reconnection.
- **When** The user views the recovery card.
- **Then** The card identifies the personal subscription as disconnected, offers no reset action, and keeps “Try again” enabled.

## chat-run-models-049

Original test `Leave a usage limit neutral once the thread leaves the subscription`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L1127).

- **Given** A run failed with a usage limit, but the thread has no selected model even though a personal subscription account is available.
- **When** The user views the recovery card.
- **Then** The card says “Model provider limit reached” without identifying a personal subscription or offering a reset action; “Try again” is enabled.

## chat-run-models-050

Original test `A failed subscription reset keeps the thread idle`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L1151).

- **Given** A run failed with a usage limit and has one reset credit remaining; resetting the subscription account returns a not-found error.
- **When** The user selects “Reset · 1 left.”
- **Then** The subscription-unavailable error is displayed, no continuation run is sent, and the message composer remains enabled.

## chat-run-models-051

Original test `Continue a run that reached its execution time limit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L1192).

- **Given** A run failed with the execution time limit on GPT 5.6 Sol.
- **When** The user selects “Continue” on the recovery card.
- **Then** The card offers no model picker or reset action. A continuation run is sent with the text “continue” and GPT 5.6 Sol attribution.

## chat-run-models-052

Original test `Confirm continuation after an automatic run limit (AUTONOMY_BUDGET_EXHAUSTED)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L1243).

- **Given** A run produced an AUTONOMY_BUDGET_EXHAUSTED automatic run-limit error on GPT 5.6 Sol.
- **When** The user selects “Continue.”
- **Then** The recovery card offers no model picker or reset action, and the app sends a continuation message with GPT 5.6 Sol attribution.

## chat-run-models-053

Original test `Render unclassified Run failures without deriving actions from provider prose`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L1296).

- **Given** A run failed without a structured reason, and its provider error text mentions model capacity.
- **When** The user views the failure.
- **Then** The failure is shown as “This run couldn't finish.” The provider text is hidden, and no busy-model message or model-switch picker is offered.

## chat-run-models-054

Original test `Continue on a replacement model after an unsupported model`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L1350).

- **Given** A run failed because the selected model is unsupported.
- **When** The user chooses GPT 5.6 Luna in the recovery picker and then retries after the selection is saved.
- **Then** The recovery card says “Selected model isn't available,” and retry sends a continuation using GPT 5.6 Luna. The retry action remains disabled while the model change is saving.

## chat-run-models-055

Original test `Continue on a replacement model after an opaque provider rejection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L1350).

- **Given** A run failed with an opaque provider rejection represented by a Bad Request JSON error.
- **When** The user chooses GPT 5.6 Luna in the recovery picker and then retries after the selection is saved.
- **Then** The recovery card says “The model provider returned an error,” and retry sends a continuation using GPT 5.6 Luna. The retry action remains disabled while the model change is saving.

## chat-run-models-056

Original test `Keep a missing-text failed Run visible with reason undefined`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L1409).

- **Given** A failed run has empty error text and no failure reason.
- **When** The user views the failed run.
- **Then** The failure remains visible as “This run couldn't finish,” with no “Continue” or reset action.

## chat-run-models-057

Original test `Keep a missing-text failed Run visible with reason unknown`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L1409).

- **Given** A failed run has empty error text and the failure reason unknown.
- **When** The user views the failed run.
- **Then** The failure remains visible as “This run couldn't finish,” with no “Continue” or reset action.

## chat-run-models-058

Original test `Keep a missing-text failed Run visible with reason future_reason`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.test.tsx#L1409).

- **Given** A failed run has empty error text and the failure reason future_reason.
- **When** The user views the failed run.
- **Then** The failure remains visible as “This run couldn't finish,” with no “Continue” or reset action.
