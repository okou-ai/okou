# auth-device.bdd

## auth-device.bdd-001

- Vitest: "AUTH-02: CLI device authorization > starts, polls, approves, exchanges, and uses the issued bearer through public APIs"
- Mode: run
- Given: A signed-in user with an organization and an unauthenticated CLI client exist.
- When: The CLI calls `POST /api/cli/auth/device` and polls `POST /api/cli/auth/token`; the user approves via `POST /api/cli/auth/approve` with the lower-cased, space-padded user code; the CLI exchanges the device code, calls `GET /api/auth/me` with the issued bearer, and exchanges the device code again.
- Then: The device response has a `XXXX-XXXX` device code equal to the user code, verification path `/cli-auth`, `expires_in` 900 and `interval` 5. The first poll returns HTTP 202 with `authorization_pending`. Approval returns HTTP 200 `{ success: true }`. The exchange returns HTTP 200 with token type `Bearer` and a `vm0_pat_` access token, `/api/auth/me` returns exactly the user's ID, email and organization ID, and reusing the device code returns HTTP 400 `invalid_request`.

## auth-device.bdd-002

- Vitest: "AUTH-02: CLI device authorization > returns visible validation and auth errors for bad CLI device requests"
- Mode: run
- Given: A signed-in user exists and no device authorization has been started.
- When: The CLI calls `POST /api/cli/auth/token` with an empty device code; the user calls `POST /api/cli/auth/approve` with unknown code `ABCD-EFGH`; an unauthenticated caller calls the approval route with the same code.
- Then: The empty token request returns HTTP 400 `invalid_request` with a description containing "device_code is required". The unknown approval returns HTTP 400 with `success: false` and error "Invalid or expired device code". The unauthenticated approval returns HTTP 401 with error code `UNAUTHORIZED`.

## auth-device.bdd-003

- Vitest: "AUTH-02: platform realtime token > issues signed user and active-org token requests only for authenticated users"
- Mode: run
- Given: A signed-in user has an active organization, and the realtime provider signs token requests. An unauthenticated caller also exists.
- When: The unauthenticated caller and then the user call `GET /api/realtime/token`.
- Then: The unauthenticated request returns HTTP 401 with `UNAUTHORIZED`. The user's request returns HTTP 200 with exactly the signed token request, which is created for client ID = user ID with a one-hour TTL and capabilities to subscribe to `user:<user>`, `org:<org>`, `user-org:<user>:<org>`, `run-output:<user>:<org>:*`, `phone-use:<org>:<user>:*`, `computer-use-host:<user>:<org>:*`, and presence on `user-org-foreground:<user>:<org>`.

## auth-device.bdd-004

- Vitest: "AUTH-02: platform realtime token > keeps user realtime available without an active organization"
- Mode: run
- Given: A signed-in user has no active organization, and the realtime provider signs token requests.
- When: The user calls `GET /api/realtime/token`.
- Then: The response is HTTP 200 with exactly the signed token request, created for client ID = user ID with a one-hour TTL and only the `user:<user>` subscribe capability.

## auth-device.bdd-005

- Vitest: "AUTH-02: platform realtime token > issues a fresh signed request when the client renews its token"
- Mode: run
- Given: A signed-in user with an active organization exists, and the realtime provider returns a first and then a renewed signed token request with different nonces.
- When: The user calls `GET /api/realtime/token` twice.
- Then: Both requests return HTTP 200; the first body equals the first signed request and the second equals the renewed one.

## auth-device.bdd-006

- Vitest: "AUTH-02: platform realtime token > returns an error when a signed request cannot be created"
- Mode: run
- Given: A signed-in user exists, and the realtime provider fails to sign the token request.
- When: The user calls `GET /api/realtime/token`.
- Then: The response is HTTP 500 with exactly `{ error: "Internal server error" }`.

## auth-device.bdd-007

- Vitest: "MODEL-PROVIDER: device auth boundaries > starts, polls, and cancels a Codex device auth session through public APIs"
- Mode: run
- Given: A signed-in organization user and a second member of the same organization exist. OpenAI's device-code endpoint issues user code `CODEX-BDD` with interval 7, and its token poll reports authorization pending (403).
- When: The user starts a personal session with `POST /api/model-providers/codex/device-auth/sessions` and completes it with `POST /api/model-providers/codex/device-auth/sessions/complete`; the other member cancels it with `POST /api/model-providers/codex/device-auth/sessions/cancel`; the user cancels it and completes again.
- Then: The start returns HTTP 200 with type `codex`, status `pending`, scope `personal`, browser URL `https://auth.openai.com/codex/device`, verification code `CODEX-BDD`, interval 7 and a session token, after exactly one device-code request with the configured client ID. The first completion returns `{ status: "pending", errorMessage: null }` after one token poll with the device ID and user code. The other member's cancel returns HTTP 404 `NOT_FOUND`. The owner's cancel returns `{ status: "cancelled" }`, and completing afterwards returns status `pending` with error message "Codex device auth session was cancelled".

## auth-device.bdd-008

- Vitest: "MODEL-PROVIDER: device auth boundaries > starts and cancels a Claude Code device auth session through public APIs"
- Mode: run
- Given: A signed-in organization user and a second member of the same organization exist.
- When: The user starts a personal Claude Code session with `POST /api/model-providers/claude-code/device-auth/sessions`, completes it with code `claude-code-bdd#wrong-state` via `POST /api/model-providers/claude-code/device-auth/sessions/complete`; the other member cancels with `POST /api/model-providers/claude-code/device-auth/sessions/cancel`; the user cancels and completes again with `claude-code-bdd`.
- Then: The start returns HTTP 200 with type `claude-code`, status `pending`, scope `personal`, an expiry and a session token, and a browser URL at `https://claude.com/cai/oauth/authorize` with the configured client ID, `response_type=code` and scope `user:profile user:inference`. The wrong-state completion returns HTTP 400 "Claude Code authorization code belongs to another session". The other member's cancel returns HTTP 404 `NOT_FOUND`; the owner's cancel returns `{ status: "cancelled" }`, and the later completion returns HTTP 400 "Claude Code device auth session is not ready".

## auth-device.bdd-009

- Vitest: "MODEL-PROVIDER: device auth boundaries > keeps a newer Codex authorization when an earlier setup returns late"
- Mode: run
- Given: A signed-in user exists. While OpenAI is processing the first device-code request, the user starts a newer personal Codex session that succeeds.
- When: The first `POST /api/model-providers/codex/device-auth/sessions` request returns late; the user then cancels the newer session with `POST /api/model-providers/codex/device-auth/sessions/cancel` and completes it with `POST /api/model-providers/codex/device-auth/sessions/complete`.
- Then: The earlier start returns HTTP 503 with error code `CODEX_DEVICE_AUTH_UNAVAILABLE`. Cancelling the newer session returns `{ status: "cancelled" }`, and its completion returns status `pending` with "Codex device auth session was cancelled".

## auth-device.bdd-010

- Vitest: "MODEL-PROVIDER: device auth boundaries > does not publish personal Codex credentials after cancellation during token exchange"
- Mode: run
- Given: A signed-in user has started a personal Codex device session, and the user cancels the session while OpenAI is responding to the token exchange.
- When: The user calls `POST /api/model-providers/codex/device-auth/sessions/complete`, lists personal model providers, and calls `POST /api/model-providers/codex/device-auth/sessions/complete` again.
- Then: The cancel returns `{ status: "cancelled" }` and the completion returns HTTP 503 with message "Device authorization was cancelled or expired". The personal provider list (HTTP 200) has no `codex-oauth-token` provider. The repeated completion returns HTTP 200 with status `pending` and "Codex device auth session was cancelled".

## auth-device.bdd-011

- Vitest: "MODEL-PROVIDER: device auth boundaries > does not publish personal Claude credentials after cancellation during token exchange"
- Mode: run
- Given: A signed-in user has started a personal Claude Code device session, and the user cancels the session while Anthropic's token endpoint is responding to the code exchange.
- When: The user calls `POST /api/model-providers/claude-code/device-auth/sessions/complete` with `auth_code_test#<state>`, lists personal model providers, and completes again.
- Then: The cancel returns `{ status: "cancelled" }` and the completion returns HTTP 503 with message "Device authorization was cancelled or expired". The personal provider list (HTTP 200) has no `claude-code-oauth-token` provider. The repeated completion returns HTTP 400 "Claude Code device auth session is not ready".

## auth-device.bdd-012

- Vitest: "MODEL-PROVIDER: device auth boundaries > completes personal Codex device auth for an administrator"
- Mode: run
- Given: A signed-in organization administrator exists, and OpenAI's device-auth endpoints issue code `ABCD-EFGH`, approve the device and exchange the authorization code for tokens of a Plus account in workspace "Personal Acme".
- When: The user calls `POST /api/model-providers/codex/device-auth/sessions` with scope `personal`, completes it with `POST /api/model-providers/codex/device-auth/sessions/complete`, lists `GET /api/me/model-providers`, completes the same session again, and deletes the provider with `DELETE /api/me/model-providers/codex-oauth-token`.
- Then: The start returns status `pending`, browser URL `https://auth.openai.com/codex/device`, verification code `ABCD-EFGH` and interval 5 after one device-code request with the configured client ID. The completion returns status `complete`, `created: true` and a `codex-oauth-token` provider for "Personal Acme" with plan `plus`; OpenAI receives one device-token poll and one `authorization_code` exchange with code `auth_code_test`, redirect URI `https://auth.openai.com/deviceauth/callback`, the client ID and the code verifier. The list includes the provider. The repeated completion returns `{ status: "pending", errorMessage: null }` with no new poll, and the delete returns HTTP 204.

## auth-device.bdd-013

- Vitest: "MODEL-PROVIDER: device auth boundaries > completes personal-scope Codex device auth for an org member"
- Mode: run
- Given: A signed-in organization member (role `org:member`) exists, and OpenAI's device-auth endpoints approve the device for workspace "Personal Acme".
- When: The member starts a personal Codex session with `POST /api/model-providers/codex/device-auth/sessions`, completes it with `POST /api/model-providers/codex/device-auth/sessions/complete`, lists `GET /api/me/model-providers`, and deletes `codex-oauth-token`.
- Then: The completion returns status `complete` with a `codex-oauth-token` provider for "Personal Acme" after one device-token poll. The personal list contains a `codex-oauth-token` provider, and the delete returns HTTP 204.

## auth-device.bdd-014

- Vitest: "MODEL-PROVIDER: device auth boundaries > adds, switches, reconnects, deduplicates, and deletes concrete Codex accounts"
- Mode: run
- Given: A signed-in organization member connects Codex accounts through device authorization, with OpenAI returning accounts A, B, C and D in turn.
- When: The member adds account A and B (mode `add`), activates B via `POST /api/me/model-provider-accounts/:id/activate`, reconnects account A while OpenAI returns account B, adds account C, requests a subscription reset for A, deletes B with `DELETE /api/me/model-provider-accounts/:id`, adds account D, deletes all Codex accounts with `DELETE /api/me/model-providers/codex-oauth-token`, and repeats that delete.
- Then: A is the first active account and B is added inactive. After the reconnect the list has one account: B, active, with workspace "Account B reconnected". Resetting A returns HTTP 404. After deleting B, only C remains and is active. With D added there are two accounts; deleting all returns HTTP 204 and an empty list, and the repeated delete returns HTTP 404.

## auth-device.bdd-015

- Vitest: "MODEL-PROVIDER: device auth boundaries > refreshes and resets the requested inactive Codex account"
- Mode: run
- Given: A signed-in organization member has two connected Codex accounts: the requested one has an expired access token and the other is active. OpenAI refreshes the requested account's token and accepts a reset-credit redemption.
- When: The member calls `POST /api/me/model-provider-accounts/:id/subscription-reset` for the inactive requested account with an idempotency key, then deletes the Codex providers.
- Then: The reset returns HTTP 200 with exactly `{ outcome: "reset" }`. OpenAI receives one refresh with the requested account's refresh token and one consume request using the refreshed access token, the requested ChatGPT account ID, and the idempotency key as `redeem_request_id`. The delete returns HTTP 204.

## auth-device.bdd-016

- Vitest: "MODEL-PROVIDER: device auth boundaries > isolates terminal Codex refresh state between concrete accounts"
- Mode: run
- Given: A signed-in organization member has two Codex accounts: A has an expired token and OpenAI rejects its refresh with `refresh_token_invalidated` (401); B has a valid token and its usage shows 20% of the five-hour window used.
- When: The member calls `GET /api/me/model-providers` twice, then deletes the Codex providers.
- Then: Both lists show A with `needsReconnect: true` and `lastRefreshErrorCode: refresh_token_invalidated`, and B with `needsReconnect: false` and five-hour usage of 20%. OpenAI receives exactly one refresh attempt, and usage is read twice, only for account B. The delete returns HTTP 204.

## auth-device.bdd-017

- Vitest: "MODEL-PROVIDER: device auth boundaries > adds, switches, and deduplicates concrete Claude Code accounts by email and workspace"
- Mode: run
- Given: A signed-in organization member connects Claude Code accounts through device authorization, with Anthropic returning first@example.com in "First Workspace", then second@example.com in "Second Workspace", then FIRST@example.com in "First Workspace".
- When: The member completes three add-mode sessions via `POST /api/model-providers/claude-code/device-auth/sessions` and `POST /api/model-providers/claude-code/device-auth/sessions/complete` with the browser state, activates the second account with `POST /api/me/model-provider-accounts/:id/activate` before the third, lists `GET /api/me/model-providers`, and deletes the Claude Code providers.
- Then: The first account is active and the second is added inactive. After activation the list has two accounts with the second first, active, with its email and workspace. The third connect returns the first account's ID with `created` false, and the list still has two accounts, the first with email `first@example.com`, "First Workspace" and inactive. The delete returns HTTP 204.

## auth-device.bdd-018

- Vitest: "MODEL-PROVIDER: device auth boundaries > enforces the tenth personal account boundary for sequential connects"
- Mode: run
- Given: A signed-in organization member has no personal model provider accounts, and the providers return a distinct account identity for every connect.
- When: The member connects eleven Codex accounts in sequence via `POST /api/model-providers/codex/device-auth/sessions` (mode `add`) and `POST /api/model-providers/codex/device-auth/sessions/complete`, then eleven Claude Code accounts via `POST /api/model-providers/claude-code/device-auth/sessions` and `POST /api/model-providers/claude-code/device-auth/sessions/complete`, lists `GET /api/me/model-providers`, and deletes both provider types.
- Then: The first ten Codex completions return HTTP 200 and the eleventh returns HTTP 400 `BAD_REQUEST` "A maximum of 10 codex-oauth-token accounts can be connected". The first ten Claude Code completions return HTTP 200 and the eleventh returns HTTP 400 "A maximum of 10 claude-code-oauth-token accounts can be connected". The list has exactly ten Claude Code accounts including the tenth, and both deletes return HTTP 204.

## auth-device.bdd-019

- Vitest: "MODEL-PROVIDER: device auth boundaries > completes personal Claude Code device auth with a pasted code fragment"
- Mode: run
- Given: A signed-in organization administrator exists, and Anthropic's token, profile and usage endpoints describe a Pro account in "Claude User's Organization" with a weekly reset on 2030-01-07.
- When: The user starts a personal session via `POST /api/model-providers/claude-code/device-auth/sessions`, completes it via `POST /api/model-providers/claude-code/device-auth/sessions/complete` with the pasted fragment `auth_code_test#<state>`, lists `GET /api/me/model-providers`, completes again, and deletes the Claude Code provider.
- Then: The browser URL scope is `user:profile user:inference`. The completion returns status `complete`, `created: true` and a `claude-code-oauth-token` provider with that workspace, plan `pro`, weekly reset period and next reset `2030-01-07T00:00:00.000Z`. Anthropic receives one token exchange (`authorization_code`, code `auth_code_test`, redirect `https://platform.claude.com/oauth/code/callback`, the client ID, the state, `expires_in` 31,536,000 and a code verifier), one profile read with `anthropic-beta: oauth-2025-04-20`, and one usage read with user agent `claude-code/2.1.161`. The list shows the provider; the repeated completion returns HTTP 400 "Claude Code device auth session is not ready", and the delete returns HTTP 204.

## auth-device.bdd-020

- Vitest: "MODEL-PROVIDER: device auth boundaries > completes personal-scope Claude Code device auth from a full callback URL"
- Mode: run
- Given: A signed-in organization member exists, and Anthropic describes a Pro account in "Claude User's Organization" with 12% five-hour usage and 24% weekly usage.
- When: The member starts a personal session via `POST /api/model-providers/claude-code/device-auth/sessions`, completes it via `POST /api/model-providers/claude-code/device-auth/sessions/complete` with the full callback URL `https://platform.claude.com/oauth/code/callback?code=member_code&state=<state>`, lists `GET /api/me/model-providers`, and deletes the Claude Code provider.
- Then: The completion returns status `complete` with a `claude-code-oauth-token` provider for that workspace with plan `pro`. The list shows subscription usage: five-hour 12% used, 88% remaining, reset `2030-01-01T05:00:00.000Z`, 18,000-second window; weekly 24% used, 76% remaining, reset `2030-01-07T00:00:00.000Z`, 604,800-second window. The delete returns HTTP 204.

## auth-device.bdd-021

- Vitest: "MODEL-PROVIDER: device auth boundaries > enforces authentication and active organization for personal authorization"
- Mode: run
- Given: One caller is unauthenticated and one is a signed-in user without an active organization.
- When: Each caller calls `POST /api/model-providers/codex/device-auth/sessions` and `POST /api/model-providers/claude-code/device-auth/sessions` with scope `personal`.
- Then: All four requests return HTTP 401 with error code `UNAUTHORIZED`.

## auth-device.bdd-022

- Vitest: "MODEL-PROVIDER: device auth boundaries > rejects invalid model-provider device session tokens without importing provider state"
- Mode: run
- Given: A signed-in organization administrator exists.
- When: The user calls `POST /api/model-providers/codex/device-auth/sessions/complete`, `POST /api/model-providers/codex/device-auth/sessions/cancel`, `POST /api/model-providers/claude-code/device-auth/sessions/complete` (with code `authorization-code#state`) and `POST /api/model-providers/claude-code/device-auth/sessions/cancel` with session token `not-a-session-token`.
- Then: All four requests return HTTP 400; the Codex requests report "Invalid Codex device auth session token" and the Claude Code requests report "Invalid Claude Code device auth session token".
