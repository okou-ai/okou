# billing-model-reporting

## billing-model-reporting-001

- Vitest: "Billing model reporting > settles the first Runner usage batch once when completion and duplicate reports overlap"
- Mode: run
- Given: A signed-in chat user has started a chat Run with model `auto` at a fixed time, and the Run's sandbox has posted assistant and result events to `POST /api/webhooks/run/events`. A usage batch contains three model `tokens.output` events (1000, 2000 and 7000) for provider `gpt-6-astra`, each with its own idempotency key. The clock advances one minute.
- When: The sandbox concurrently posts the successful completion (`exitCode: 0`) to `POST /api/webhooks/run/complete` and the same usage batch twice to `POST /api/webhooks/run/usage-event`; after the Run is `completed`, the user reads `POST /api/chat-threads/:id/usage` for the Run, then the sandbox posts the same usage batch a third time and the user reads usage again.
- Then: All three concurrent requests return HTTP 200. The usage report lists the Run with `version: 1`, `totalCredits: 10`, `settledAt` equal to the completion time, and a single `model` breakdown of 10 credits attributed to provider `@preset/okou-1-0`. After the third duplicate report the usage response is unchanged.

## billing-model-reporting-002

- Vitest: "Billing model reporting > returns settled usage and the captured completion time after a failed Run"
- Mode: run
- Given: A signed-in chat user has started a chat Run with model `auto` at a fixed time, and the sandbox has reported one model usage event of 10,000 output tokens for provider `gpt-6-astra` to `POST /api/webhooks/run/usage-event`. Parameter row: `failed`.
- When: The user reads `POST /api/chat-threads/:id/usage` for the Run; the clock advances one minute and the sandbox reports the Run complete with `exitCode: 1` and an error through `POST /api/webhooks/run/complete`; once the Run is `failed`, the user reads usage again.
- Then: Before completion the usage response has no runs. After the failure it lists the Run with `version: 1`, `totalCredits: 10`, `settledAt` equal to the failure time, and a `model` breakdown of 10 credits for provider `@preset/okou-1-0`.

## billing-model-reporting-003

- Vitest: "Billing model reporting > returns settled usage and the captured completion time after a cancelled Run"
- Mode: run
- Given: A signed-in chat user has started a chat Run with model `auto` at a fixed time, and the sandbox has reported one model usage event of 10,000 output tokens for provider `gpt-6-astra` to `POST /api/webhooks/run/usage-event`. Parameter row: `cancelled`.
- When: The user reads `POST /api/chat-threads/:id/usage` for the Run; the clock advances one minute, the user cancels the Run, and the sandbox then reports completion with `exitCode: 1` and "Run cancelled" through `POST /api/webhooks/run/complete`; once the Run is `cancelled`, the user reads usage again.
- Then: Before completion the usage response has no runs. After cancellation it lists the Run with `version: 1`, `totalCredits: 10`, `settledAt` equal to the cancellation time, and a `model` breakdown of 10 credits for provider `@preset/okou-1-0`.

## billing-model-reporting-004

- Vitest: "Billing model reporting > retains captured providers and settled totals after Thread deletion"
- Mode: run
- Given: A signed-in chat user has started a chat Run with model `auto` whose execution captures model usage provider `@preset/okou-1-0`. The sandbox reports 10,000 model output tokens for `gpt-6-astra` and 2 low-quality standard images for `gpt-image-1` to `POST /api/webhooks/run/usage-event`, and the clock advances one minute before the Run completes successfully.
- When: The user reads `GET /api/usage/record` and `GET /api/usage/members` (range `7d`, timezone UTC), `POST /api/chat-threads/:id/usage`, and the thread events; then deletes the thread and reads the usage record and members again, and reads the Run.
- Then: Before completion the chat usage has no runs. After completion the usage record totals 32 credits with a row for the thread showing 10,000 tokens, 32 credits and a breakdown of `model` 10 credits (`@preset/okou-1-0`) and `image` 22 credits (`gpt-image-1`); the members report shows 32 credits charged and 10,000 output tokens with the same breakdown. Chat usage lists the Run with `totalCredits: 32`, `settledAt` at completion, and image 22 and model 10 breakdowns, and the thread events contain a matching `usage.recorded` event. After deleting the thread, the usage record is identical except each row has `threadId: null` and title "Unavailable thread", the members report is unchanged, and reading the Run still returns HTTP 200.
