# chat-connector-execution

## chat-connector-execution-001

- Vitest: "Chat connector execution > uses live member eligibility without replacing the saved Chat account on expiry"
- Mode: run
- Given: A Pro member owns a Chat with two manual MCP accounts, "Fallback" and "Selected"; the Chat selects "Selected" as current and overrides "Fallback" off. The member-connector-account-access feature switch is initially off, and another member also exists in the organization.
- When: The member sets "Selected" to `allow-1h` through `PUT /api/connector-account-access/:connectionId/policy` before and after enabling the feature switch (the other member also tries), the clock advances one hour, a Run starts, the Run reads `GET /api/run/connector-accounts` and tries `POST /api/chat-threads/:threadId/member-connector-account-approval`, the member tries `POST /api/chat-threads/:threadId/connector-account-approval`, and the member sets the policy again.
- Then: The policy update returns HTTP 404 with the switch off and for the other member, whose policy list is empty. With the switch on it returns allowed, enabled and an expiry one hour later, and the Chat's current account is "Selected" until expiry, then "Fallback"; the policy list shows "Selected" as allowed but not enabled and selecting it returns HTTP 400. The Run's runtime targets use "Fallback"; the inventory lists "Selected" disabled and not current and "Fallback" enabled and current, and includes `approvalScope: "member"` only when requested. The Run's member approval returns HTTP 403 and the Chat approval HTTP 404, and renewing the policy makes "Selected" current again.

## chat-connector-execution-002

- Vitest: "Chat connector execution > approves the exact account member-wide and selects it only in the requesting Chat"
- Mode: run
- Given: A Pro member owns a Chat, a sibling Chat whose current account is "Fallback", and manual MCP accounts "Fallback" and "Requested"; another member owns a different Chat.
- When: The member calls `POST /api/chat-threads/:threadId/member-connector-account-approval` for "Requested" before enabling the member-access feature switch, then after denying "Requested" via `PUT /api/connector-account-access/:connectionId/policy` approves it for the other member's Chat, for a mismatched custom target, and for their own Chat; then sets `allow-24h` and approves again.
- Then: Approval returns HTTP 404 with the switch off, for the other member's Chat and for the mismatched target; the denied policy shows not allowed, not enabled, no expiry. The valid approval returns HTTP 200 echoing the selection, makes "Requested" current only in the requesting Chat (the sibling stays on "Fallback" but lists "Requested" as enabled), and the policy shows allowed and enabled with a one-hour expiry. After the 24-hour policy, a further approval leaves the policy equal to the 24-hour policy response.

## chat-connector-execution-003

- Vitest: "Chat connector execution > applies member eligibility on the existing Run refresh and MCP reads"
- Mode: run
- Given: A Pro member has manual MCP accounts "Selected" and "Fallback" with the member-access feature switch on, and sets "Selected" to `allow-1h`; a Run starts using "Selected".
- When: The clock advances one hour and the Runner syncs connector runtime through `POST /api/runners/runs/:runId/connector-runtime/sync`; the Run reads `GET /api/mcp-connectors` and calls `POST /api/mcp-connectors/oauth2/reauthorize`; then the member denies "Fallback" and the Runner syncs again.
- Then: The first sync reports the target available with an account binding to "Fallback", the MCP list contains only "Fallback", and reauthorization returns a reconnect for "Fallback". After "Fallback" is denied, the sync reports the target absent with reason `connector-unavailable`.

## chat-connector-execution-004

- Vitest: "Chat connector execution > resolves the Chat's selected native credentials alongside a registered MCP account"
- Mode: run
- Given: A Pro member has a default and a selected "runtime" API-token account and a registered manual MCP account, and the Chat selects the selected native account and the MCP account as current.
- When: A Run starts in the Chat and the Sandbox resolves credentials through `POST /api/webhooks/run/firewall/auth` with a `RUNTIME_API_KEY` secret template.
- Then: The execution input has a `RUNTIME_API_KEY` environment variable mapped to the selected native account, never contains the raw selected key, and includes the MCP runtime target for the registered account. Firewall auth returns the `Authorization: Bearer selected-native-key` header.

## chat-connector-execution-005

- Vitest: "Chat connector execution > switches HTTP identity and persists the Chat's current account for the next Run"
- Mode: run
- Given: A Pro member has manual MCP accounts "A" and "B", the Chat selects "B" as current, and a Run is started.
- When: The member denies unknown permissions via `PUT /api/connector-permissions`; the Run switches to "A" through `PUT /api/run/connector-accounts/current`, the Runner syncs connector runtime, the Sandbox calls firewall auth for "A", the Run lists MCP connectors and reauthorizes, then the Run completes and a new Run starts in the Chat.
- Then: The first Run targets "B"; its inventory shows "B" enabled, current and not default without exposing its key, with approval scope `chat`, and the MCP list contains "B". After switching, sync binds "A" with an unknown-deny network policy, firewall auth returns "Bearer key-A", the MCP list contains "A", reauthorization reconnects "A" with a `/reconnect/<A>` URL, and the Chat's current account is "A". The next Run targets "A".

## chat-connector-execution-006

- Vitest: "Chat connector execution > applies a Chat access revocation after startup to the running Run"
- Mode: run
- Given: A Pro member has a manual MCP account "Revocable" and a running Run that targets it.
- When: The member overrides the account off for the Chat through `PUT /api/chat-threads/:threadId/connector-access/:connectionId`, and the Runner syncs connector runtime.
- Then: The sync reports the target absent with reason `connector-unavailable`.

## chat-connector-execution-007

- Vitest: "Chat connector execution > shows denied accounts, rejects self-grants and foreign ownership, and accepts exact owner confirmation only in that Chat"
- Mode: run
- Given: A Pro member has manual MCP accounts "A" and "B", B is overridden off in the Chat, another Chat exists, a Run is running in the Chat, and a foreign user owns another account.
- When: The Run lists accounts, tries to select B and the foreign account through `PUT /api/run/connector-accounts/current` and to approve B through `POST /api/chat-threads/:threadId/connector-account-approval`; the foreign user tries to approve their account for the Chat; then the member approves B with a session.
- Then: The inventory shows B disabled and not current, and the Run targets A. Selecting B or the foreign account returns HTTP 400, the Run's approval returns HTTP 403, and the foreign approval returns HTTP 404. The member's approval returns HTTP 200, making B current (enabled, default-enabled, not default) in that Chat while the other Chat stays on A.

## chat-connector-execution-008

- Vitest: "Chat connector execution > rebinds custom http accounts and retains shared permission expiry"
- Mode: run
- Given: A Pro member has a custom HTTP connector with accounts "A" and "B" and grants `conversations:read` for one hour while denying `chat:write`; a Run starts using "A". (Row: `http`.)
- When: The Run switches to "B" through `PUT /api/run/connector-accounts/current`, the Runner syncs connector runtime, and the Sandbox calls firewall auth for the published route.
- Then: The Run initially targets "A". The sync reports the target available, bound to "B" with a firewall for "B", next sync at the grant's expiry and a network policy allowing `conversations:read` and denying `chat:write`. Firewall auth returns "Bearer secret-B".

## chat-connector-execution-009

- Vitest: "Chat connector execution > rebinds custom mcp accounts and retains shared permission expiry"
- Mode: run
- Given: A Pro member has a custom MCP connector with accounts "A" and "B"; a Run starts using "A". (Row: `mcp`.)
- When: The Run lists `GET /api/mcp-connectors`, switches to "B" through `PUT /api/run/connector-accounts/current`, the Runner syncs connector runtime, the Sandbox calls firewall auth for the published route, and the Run lists MCP connectors again.
- Then: The Run initially targets "A" and the MCP list contains "A". The sync reports the target available, bound to "B" with a firewall for "B"; firewall auth returns "Bearer secret-B", and the MCP list then contains "B".

## chat-connector-execution-010

- Vitest: "Chat connector execution > does not substitute a healthy default for the Chat's current account when its credentials need reconnecting"
- Mode: run
- Given: A Pro member has a custom HTTP connector with accounts "A" and "B"; the connector definition moves to storage version 2 and only "A" is reconnected, and the Chat selects "B" as current.
- When: A Run starts in the Chat and reads `GET /api/run/connector-accounts`.
- Then: The Run has no runtime target for the custom connector, and the inventory still lists "B" as the current account.
