# model-catalog

## model-catalog-001

- Vitest: "GET /api/model-catalog > returns only fixed Auto without a personal subscription"
- Mode: run
- Given: A signed-in organization member with a Clerk session and no personal model subscription.
- When: The member requests `GET /api/model-catalog`.
- Then: The response is HTTP 200 with system default model `auto`, includes a model `auto` displayed as `Auto`, and its only built-in route is `auto` backed by `openrouter-codex` with upstream model `@preset/okou-1-0`.

## model-catalog-002

- Vitest: "GET /api/model-catalog > allows authenticated okou tokens to read the catalog"
- Mode: run
- Given: An organization member holds a valid Okou agent token issued for a Run execution (row `okou`).
- When: The caller requests `GET /api/model-catalog` with the Okou token as a bearer token.
- Then: The response is HTTP 200, the models include the system default model displayed as `Auto`, and at least one route is listed.

## model-catalog-003

- Vitest: "GET /api/model-catalog > allows authenticated sandbox tokens to read the catalog"
- Mode: run
- Given: An organization member holds a valid sandbox token issued for a Run execution (row `sandbox`).
- When: The caller requests `GET /api/model-catalog` with the sandbox token as a bearer token.
- Then: The response is HTTP 200, the models include the system default model displayed as `Auto`, and at least one route is listed.

## model-catalog-004

- Vitest: "GET /api/model-catalog > rejects an expired agent token"
- Mode: run
- Given: An organization member holds an Okou agent token, and the clock advances just over two hours past its issue time.
- When: The caller requests `GET /api/model-catalog` with the expired token.
- Then: The response is HTTP 401.

## model-catalog-005

- Vitest: "GET /api/model-catalog > rejects an agent token whose user is no longer an organization member"
- Mode: run
- Given: An Okou agent token was issued to a member who has since been removed from the organization.
- When: The caller requests `GET /api/model-catalog` with that token.
- Then: The response is HTTP 401.

## model-catalog-006

- Vitest: "GET /api/model-catalog > requires an authenticated organization session"
- Mode: run
- Given: One caller sends no credentials; another has a valid Clerk session with no active organization.
- When: Both request `GET /api/model-catalog`.
- Then: Both requests return HTTP 401.

## model-catalog-007

- Vitest: "public selections of replaced models > normalizes a requested retired model when creating a thread and runs its successor"
- Mode: run
- Given: An entitled member has a connected Claude Code subscription for `claude-fable-5-1`.
- When: The member creates a thread via `POST /api/chat-threads` with retired model `claude-fable-5`, reads the thread through the MCP `get_chat_thread_list` tool, sends a chat Run on that thread, and reads the Run, thread metadata and MCP thread list again.
- Then: The MCP creation event shows selected model `claude-fable-5-1`. The Run's source model is `claude-fable-5-1` with provider `claude-code-oauth-token`, the thread metadata shows `claude-fable-5-1`, and the MCP projection still shows `claude-fable-5-1`.

## model-catalog-008

- Vitest: "public selections of replaced models > rejects an explicitly requested replacement whose subscription was never connected"
- Mode: run
- Given: An entitled member with a Claude subscription but no Codex subscription has a thread created without a model.
- When: The member sends `POST /api/chat/events` on the thread requesting retired model `gpt-5.5`.
- Then: The request returns HTTP 400 with the message "GPT 5.5 was replaced by GPT 6 Luna, which requires a Codex subscription. Select Auto or connect your Codex subscription." The thread's events are unchanged and its metadata still shows selected model `auto`.

## model-catalog-009

- Vitest: "public selections of replaced models > accepts a pinned model whose retained subscription was disconnected and reports the reconnect error"
- Mode: run
- Given: An entitled member has a running Run on `claude-fable-5-1` through their Claude subscription and a separate thread pinned to `claude-fable-5-1`; the member then disconnects the subscription via `DELETE /api/me/model-providers/claude-code-oauth-token` (204).
- When: The member sends `POST /api/chat/events` on the pinned thread without naming a model, then the running Run is cancelled.
- Then: The send returns HTTP 201 and the thread metadata keeps `claude-fable-5-1`. The thread messages then include an `input.rejected` event revoking the client event ID with error `conflict`, and an `output.error` event with error `conflict` and content "The selected subscription account is unavailable. Reconnect it before starting another run."

## model-catalog-010

- Vitest: "public selections of replaced models > retains the persisted model in raw lifecycle events after its provider is disconnected"
- Mode: run
- Given: An entitled member created a thread on `claude-fable-5-1` and then disconnected their Claude subscription.
- When: The member reads the thread list through the MCP `get_chat_thread_list` tool.
- Then: The thread's creation event still reports selected model `claude-fable-5-1`.

## model-catalog-011

- Vitest: "public selections of replaced models > stores an explicitly requested replaced model as its successor on the thread and member preference"
- Mode: run
- Given: An entitled member with a connected Claude subscription has a thread created without a model.
- When: The member sends a chat Run on the thread explicitly requesting retired model `claude-fable-5`, and reads the Run execution, the Run, the thread, and `GET /api/user-model-preference`.
- Then: The execution's model usage provider and the Run's source model are `claude-fable-5-1`. The thread metadata shows `claude-fable-5-1` and its only `model_selection_updated` event names `claude-fable-5-1`, and the member's model preference is `claude-fable-5-1`.

## model-catalog-012

- Vitest: "public selections of replaced models > clears Fast when an explicitly requested replacement does not offer it"
- Mode: run
- Given: An entitled member with Claude and Codex subscriptions has a thread on `gpt-6-astra` with the Fast (`codexServiceTier: fast`) service tier selected.
- When: The member sends a chat Run on the thread explicitly requesting retired model `claude-fable-5`.
- Then: The Run's source model is `claude-fable-5-1`, the thread metadata shows `claude-fable-5-1` with service tier `null`, and the thread gains exactly one new `model_selection_updated` event for `claude-fable-5-1` and one new `service_tier_updated` event with service tier `null`.
