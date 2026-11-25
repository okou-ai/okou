# run-lifecycle-admission.bdd

## run-lifecycle-admission.bdd-001

- Vitest: "RUN-01: admission boundaries beyond request validation > rejects runs for onboarded organizations with suspended entitlements"
- Mode: run
- Given: An onboarded workspace on an active plan uses a personal subscription model with `claude-fable-5-1` selected; the plan is then canceled.
- When: The member sends a chat message on the default subscription route and another with Auto (`model: null`) via `POST /api/chat/events`, then lists `GET /api/logs` and reads `GET /api/runs/queue`.
- Then: Both sends are rejected with `insufficient_credits`. No Run with either prompt appears in the logs, and the queue shows 0 active Runs.

## run-lifecycle-admission.bdd-002

- Vitest: "RUN-01: admission boundaries beyond request validation > timestamps a pending launch when its queued input is consumed"
- Mode: run
- Given: A chat-ready member has a conversation busy with a Run started at a fixed time, and a further input queued behind it.
- When: Six minutes later the blocking Run is cancelled via `POST /api/runs/:id/cancel` and finishes, and the queued input launches its Run.
- Then: The launched Run is `running` and its `createdAt` equals the time the input was consumed (six minutes after the first request), not the original send time.

## run-lifecycle-admission.bdd-003

- Vitest: "RUN-01: agent run authorization and session boundaries > accepts session and PAT cancellation while rejecting run-scoped tokens"
- Mode: run
- Given: A chat-ready member has three running chat Runs; one Run's execution provides a sandbox token and an Okou Run token. The member also creates a CLI personal access token.
- When: The member cancels the first Run with the browser session, then tries to cancel the second Run with the other Run's sandbox token and Okou token, and finally with the personal access token, via `POST /api/runs/:id/cancel`.
- Then: Session cancellation returns HTTP 200 and the Run becomes `cancelled`. Both Run-scoped tokens are rejected with HTTP 403 and the target Run stays `running`. The personal access token cancellation returns 200 and the Run becomes `cancelled`.

## run-lifecycle-admission.bdd-004

- Vitest: "RUN-01: agent run authorization and session boundaries > prevents another member from continuing an owned thread"
- Mode: run
- Given: An entitled member using the native Runner route owns a conversation with a running Run; another member of the same organization exists.
- When: The other member sends a message into that conversation via `POST /api/chat/events`.
- Then: The request returns HTTP 404 with code `NOT_FOUND`. After the owner cancels the Run, the queue shows 0 active Runs.

## run-lifecycle-admission.bdd-005

- Vitest: "RUN-02: model provider selection and built-in admission > gates built-in model runs on billing state and on unexpired credit grants"
- Mode: run
- Given: One workspace has never completed onboarding and has no billing state; another has a Pro entitlement whose billing period ended 60 days ago, so its credits have expired.
- When: Each member sends a chat message for a built-in model Run via `POST /api/chat/events`.
- Then: Both sends are rejected with `insufficient_credits`.

## run-lifecycle-admission.bdd-006

- Vitest: "RUN-02: model provider selection and built-in admission > enforces Stripe subscription status at final run admission"
- Mode: run
- Given: An onboarded workspace on an active plan uses a personal subscription model with `claude-fable-5-1` selected and has a Runner group.
- When: The member starts a chat Run and the Runner reads its execution input; after cancelling it the plan is canceled, and the member sends messages on the subscription route and with Auto, then lists logs and the queue.
- Then: The active-plan Run's system prompt mentions `okou chat send` and `okou chat cancel`. After cancellation of the plan, both sends are rejected with `insufficient_credits`, neither prompt appears in `GET /api/logs`, and the queue shows 0 active Runs.

## run-lifecycle-admission.bdd-007

- Vitest: "RUN-02: model provider selection and built-in admission > exposes limited-free Auto selection and rejects unavailable model pins"
- Mode: run
- Given: A newly provisioned and onboarded workspace is on the limited free tier with 0 credits and a 1,000-credit bonus usage pack.
- When: The member reads billing status and usage pack credits, lists Run models, creates a conversation with no model, and for each of `gpt-6-astra`, `claude-fable-5-1` and `gpt-5.6-sol` sends a message pinned to it and tries to pin the conversation to it.
- Then: Billing shows tier `limited-free-1`, 0 credits, no grants and no pending onboarding payment; usage packs show 1,000 total and bonus credits. The only Run model is `auto` and the new conversation selects `auto`. Each pinned send either returns HTTP 400 `BAD_REQUEST` or is recorded as `input.rejected` with `pro_required` and no Run; the queue stays at 0 active, and each conversation pin returns HTTP 400 `BAD_REQUEST`.

## run-lifecycle-admission.bdd-008

- Vitest: "RUN-02: model provider selection and built-in admission > dispatches managed Auto runs without delivering the managed provider key"
- Mode: run
- Given: A Pro member has no personal subscription and has image generation disabled; the platform holds a managed model provider key.
- When: The member starts an Auto Run (`model: null`) and the Runner reads the execution input; the member reads the Run, the conversation events and the logs.
- Then: The execution includes the `model-provider:openrouter-codex` firewall and no framework image-generation flag, and the Run's source is `built-in`. The managed provider key appears in none of the dispatch, execution input, Run read, conversation events or logs.

## run-lifecycle-admission.bdd-009

- Vitest: "RUN-02: model provider selection and built-in admission > dispatches personal Codex GPT 6 chat runs through Pi without platform model billing"
- Mode: run
- Given: An entitled member has native subscription models configured with `gpt-6-sol` selected and image generation disabled.
- When: The member sends a chat message with `gpt-6-sol` and the Runner reads the execution input.
- Then: The Run's source is `gpt-6-sol` via `codex-oauth-token`. The execution runs the `pi` agent with Pi model config `openai-codex`/`gpt-6-sol`, includes the `model-provider:codex-oauth-token` firewall, has no billable firewalls and no image-generation flag, and reports `gpt-6-sol` as the model usage provider.

## run-lifecycle-admission.bdd-010

- Vitest: "RUN-02: model provider selection and built-in admission > does not add Codex image upload guidance to a Claude web chat run"
- Mode: run
- Given: An entitled member uses the native Runner route with a Claude model.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The execution uses the `claude-code` agent and its system prompt does not contain the Codex web image upload guidance.

## run-lifecycle-admission.bdd-011

- Vitest: "RUN-02: model provider selection and built-in admission > runs a sent Codex model on the personal subscription and mounts codex workflows"
- Mode: run
- Given: An entitled member has saved a personal Codex `auth_json` subscription, keeps `claude-fable-5-1` as the selected model, and has created workflows `bdd-codex-kit` and `bdd-codex-research`.
- When: The member sends a message with `gpt-6-astra` in a Claude conversation, the Runner reads the execution input, and the member cancels the Run.
- Then: The execution uses the `codex` agent with `OPENAI_MODEL` `gpt-6-astra`, placeholder values for `CHATGPT_ACCESS_TOKEN` and `CHATGPT_ACCOUNT_ID`, `CODEX_OAUTH_ACCOUNT_ID` taken from the ID-token claim, and no refresh token; the access token's metadata names the member's model-provider credential. Both workflows mount under `/home/user/.codex/skills/` and none under `.claude/skills`. The Run is `cancelled` after cancellation.
