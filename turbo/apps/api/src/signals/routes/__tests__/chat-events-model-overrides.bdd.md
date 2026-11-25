# chat-events-model-overrides

## chat-events-model-overrides-001

- Vitest: "CHAT-02: run-level model overrides > describes raw chat history sync by default"
- Mode: run
- Given: An entitled workspace member can launch a Chat Run.
- When: The member sends a prompt in a fresh thread and the Runner receives its dispatch.
- Then: The system guidance gives the raw Chat history synchronization command with that thread ID and a sequence-ID search against the resulting history directory.

## chat-events-model-overrides-002

- Vitest: "CHAT-02: run-level model overrides > persists a send model selection on the thread while preserving same-family sessions"
- Mode: run
- Given: An authenticated member has a personal Claude subscription linking Opus and Sonnet through Claude Code.
- When: The member selects Opus for a first turn and completes it, switches to Sonnet on the same thread and completes it, then continues without a model field.
- Then: Dispatch starts with Opus, the first completion records its native session, and the Sonnet Run resumes that session without injecting the prior answer. Its dispatch retains the thread ID and history command. Metadata and a model-selection event report Sonnet. The omitted-model turn uses Sonnet and resumes the immediately preceding session.

## chat-events-model-overrides-003

- Vitest: "CHAT-02: run-level model overrides > rejects a disconnected personal thread model even when the member default is Auto"
- Mode: run
- Given: An authenticated member's default is Auto, but their thread explicitly selects personal Sonnet and the related subscription has been disconnected.
- When: The member submits a prompt without a model field on the thread.
- Then: The accepted input produces an `input.rejected` conflict without a Run ID. Metadata still reports Sonnet and the input does not fall through to Auto.

## chat-events-model-overrides-004

- Vitest: "CHAT-02: run-level model overrides > hands native standard subscription gpt-6-luna runs to a generation-2 Sandbox with completed outcome and no built-in billing"
- Mode: run
- Given: An entitled workspace member has a personal GPT-6 Luna Codex account with an expired access token and a refreshable OAuth session.
- When: The member sends a Standard prompt, a Sandbox claims it and requests its provider headers. The Sandbox completes and retries completion, then the member starts a follow-up on that thread.
- Then: Pi uses the thread ID, schema generation 2, GPT-6 Luna with xhigh thinking, no fast service tier, and the Codex Responses SSE endpoint. The dispatch exposes credential placeholders tied to that account without its raw account ID or refresh token. Its provider firewall allows Codex API requests, denies unknown permissions and has no billable firewalls. Authorized resolution calls OAuth refresh once and returns the account ID and refreshed bearer token. Both terminal callbacks return HTTP 200, final readback remains completed and thread model credits remain zero. A follow-up resumes the completed Run generation on the same session and service tier with no model credits.

## chat-events-model-overrides-005

- Vitest: "CHAT-02: run-level model overrides > hands native Fast subscription gpt-6-luna runs to a generation-3 Sandbox with completed outcome and no built-in billing"
- Mode: run
- Given: An entitled workspace member has a personal GPT-6 Luna Codex account with an expired access token and a refreshable OAuth session.
- When: The member sends a Fast prompt, a Sandbox claims it and requests its provider headers. The Sandbox completes and retries completion, then the member starts a follow-up on that thread.
- Then: Pi uses the thread ID, schema generation 3, GPT-6 Luna with xhigh thinking, the fast service tier, and the Codex Responses SSE endpoint. The dispatch exposes credential placeholders tied to that account without its raw account ID or refresh token. Its provider firewall allows Codex API requests, denies unknown permissions and has no billable firewalls. Authorized resolution calls OAuth refresh once and returns the account ID and refreshed bearer token. Both terminal callbacks return HTTP 200, final readback remains completed and thread model credits remain zero. A follow-up resumes the completed Run generation on the same session and service tier with no model credits.

## chat-events-model-overrides-006

- Vitest: "CHAT-02: run-level model overrides > hands native Fast subscription gpt-6-sol runs to a generation-3 Sandbox with completed outcome and no built-in billing"
- Mode: run
- Given: An entitled workspace member has a personal GPT-6 Sol Codex account with an expired access token and a refreshable OAuth session.
- When: The member sends a Fast prompt, a Sandbox claims it and requests its provider headers. The Sandbox completes and retries completion, then the member starts a follow-up on that thread.
- Then: Pi uses the thread ID, schema generation 3, GPT-6 Sol with max thinking, the fast service tier, and the Codex Responses SSE endpoint. The dispatch exposes credential placeholders tied to that account without its raw account ID or refresh token. Its provider firewall allows Codex API requests, denies unknown permissions and has no billable firewalls. Authorized resolution calls OAuth refresh once and returns the account ID and refreshed bearer token. Both terminal callbacks return HTTP 200, final readback remains completed and thread model credits remain zero. A follow-up resumes the completed Run generation on the same session and service tier with no model credits.

## chat-events-model-overrides-007

- Vitest: "CHAT-02: run-level model overrides > hands native Fast subscription gpt-6.1-sol runs to a generation-3 Sandbox with completed outcome and no built-in billing"
- Mode: run
- Given: An entitled workspace member has a personal GPT-6.1 Sol Codex account with an expired access token and a refreshable OAuth session.
- When: The member sends a Fast prompt, a Sandbox claims it and requests its provider headers. The Sandbox completes and retries completion, then the member starts a follow-up on that thread.
- Then: Pi uses the thread ID, schema generation 3, GPT-6.1 Sol with medium thinking, the fast service tier, and the Codex Responses SSE endpoint. The dispatch exposes credential placeholders tied to that account without its raw account ID or refresh token. Its provider firewall allows Codex API requests, denies unknown permissions and has no billable firewalls. Authorized resolution calls OAuth refresh once and returns the account ID and refreshed bearer token. Both terminal callbacks return HTTP 200, final readback remains completed and thread model credits remain zero. A follow-up resumes the completed Run generation on the same session and service tier with no model credits.

## chat-events-model-overrides-008

- Vitest: "CHAT-02: run-level model overrides > hands native Fast subscription gpt-6-sol runs to a generation-3 Sandbox with failed outcome and no built-in billing"
- Mode: run
- Given: An entitled workspace member has a personal GPT-6 Sol Codex account with an expired access token and a refreshable OAuth session.
- When: The member sends a Fast prompt, a Sandbox claims it and requests its provider headers. The Sandbox delivers a nonzero terminal result and then retries with a successful exit code.
- Then: Pi uses the thread ID, schema generation 3, GPT-6 Sol with max thinking, the fast service tier, and the Codex Responses SSE endpoint. The dispatch exposes credential placeholders tied to that account without its raw account ID or refresh token. Its provider firewall allows Codex API requests, denies unknown permissions and has no billable firewalls. Authorized resolution calls OAuth refresh once and returns the account ID and refreshed bearer token. Both terminal callbacks return HTTP 200, final readback remains failed and thread model credits remain zero.

## chat-events-model-overrides-009

- Vitest: "CHAT-02: run-level model overrides > hands native Fast subscription gpt-6.1-sol runs to a generation-3 Sandbox with cancelled outcome and no built-in billing"
- Mode: run
- Given: An entitled workspace member has a personal GPT-6.1 Sol Codex account with an expired access token and a refreshable OAuth session.
- When: The member sends a Fast prompt, a Sandbox claims it and requests its provider headers. The member cancels the Run before the Sandbox sends and retries completion.
- Then: Pi uses the thread ID, schema generation 3, GPT-6.1 Sol with medium thinking, the fast service tier, and the Codex Responses SSE endpoint. The dispatch exposes credential placeholders tied to that account without its raw account ID or refresh token. Its provider firewall allows Codex API requests, denies unknown permissions and has no billable firewalls. Authorized resolution calls OAuth refresh once and returns the account ID and refreshed bearer token. Both terminal callbacks return HTTP 200, final readback remains cancelled and thread model credits remain zero.
