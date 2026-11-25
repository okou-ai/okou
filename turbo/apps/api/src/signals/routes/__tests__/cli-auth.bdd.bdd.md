# cli-auth.bdd

## cli-auth.bdd-001

- Vitest: "AUTH-02: CLI device code expiry > expires unexchanged device codes for both token polling and browser approval"
- Mode: run
- Given: A signed-in member and two CLI device codes started via `POST /api/cli/auth/device`; the clock then advances 16 minutes past their creation.
- When: The CLI polls `POST /api/cli/auth/token` with the first code and the member approves the second via `POST /api/cli/auth/approve`.
- Then: The two device codes differ. The token poll returns HTTP 400 with `expired_token` and "The device code has expired"; the approval returns HTTP 400 with "Device code has expired".

## cli-auth.bdd-002

- Vitest: "AUTH-02: approval transitions and timezone > approves a code only once and writes timezone only when valid and unset"
- Mode: run
- Given: A signed-in member with no initialized preferences, and a second fresh member.
- When: The member approves one device code twice via `POST /api/cli/auth/approve`, approves a second code with timezone `America/Los_Angeles`, initializes preferences via `POST /api/user-preferences/initialize`, approves a third code with `Asia/Tokyo`, and the fresh member approves a code with timezone `Not/AZone`; preferences are read via `GET /api/user-preferences`.
- Then: The first approval returns `{ success: true }` and the repeat returns HTTP 400 "Invalid or expired device code". Preferences stay `USER_PREFERENCES_UNINITIALIZED` until initialized, after which the timezone is `America/Los_Angeles` with locale `en-US`. The later `Asia/Tokyo` approval does not change the timezone, and the fresh member's invalid timezone leaves preferences uninitialized.

## cli-auth.bdd-003

- Vitest: "AUTH-02: no-org approval cannot issue a PAT > reports missing authenticated identity instead of issuing an unusable token"
- Mode: run
- Given: A signed-in user without an organization approves a pending device code with a timezone.
- When: The CLI exchanges the code via `POST /api/cli/auth/token`.
- Then: The approval returns `{ success: true }`, but the exchange returns HTTP 500 with `server_error` "Authenticated device code is missing user or organization identity".

## cli-auth.bdd-004

- Vitest: "AUTH-02: approve credential-type boundaries > rejects pat and sandbox bearers on approve while the code stays pending"
- Mode: run
- Given: A member holds a device-issued personal access token and a sandbox token, and a new device code is pending.
- When: Each bearer calls `POST /api/cli/auth/approve` for the pending code, and the CLI then polls `POST /api/cli/auth/token`.
- Then: The PAT approval returns HTTP 403 `FORBIDDEN`; the sandbox approval returns HTTP 403 `FORBIDDEN` "This endpoint is not available for sandbox tokens". The poll returns HTTP 202 `authorization_pending`.

## cli-auth.bdd-005

- Vitest: "CLI credentials acquired through normal user flows > uses a device-approved PAT for me and reads a normally activated Pro subscription"
- Mode: run
- Given: An onboarded member whose Pro subscription was activated through the normal plan lifecycle.
- When: The member obtains a token through the device flow (start, approve, exchange) and calls `GET /api/auth/me` with it, and reads the billing status.
- Then: The token starts with `vm0_pat_`, has type `Bearer` and expires in 90 days. `GET /api/auth/me` returns HTTP 200 with exactly the member's user ID, email and organization ID, and the billing tier is `pro`.

## cli-auth.bdd-006

- Vitest: "CLI credentials acquired through normal user flows > reads normally connected OAuth and API-method accounts with their expiry"
- Mode: run
- Given: An onboarded member with the test OAuth connector feature switch enabled connects the test OAuth connector through OAuth with a token that already expired 60 seconds ago, and then connects it again through the API method.
- When: The member reads the default connector account and lists the connector accounts.
- Then: The default account uses `oauth` with external username `e2e-test-oauth` and a token expiry in the past. The account list contains both the OAuth account and an `api` account.

## cli-auth.bdd-007

- Vitest: "Codex auth.json through the personal model-provider API > reads pasted Codex metadata and rejects malformed JSON and free subscriptions"
- Mode: run
- Given: A signed-in member.
- When: The member pastes a Codex `auth.json` through `POST /api/me/model-providers`, pastes an updated one, then pastes invalid JSON and a free-plan `auth.json`, reading `GET /api/me/model-providers` after each success.
- Then: The provider reads workspace `Acme`, plan `plus`, then `Acme Updated`, `business`, both without reconnect or refresh errors. Invalid JSON returns HTTP 400 `CODEX_AUTH_JSON_SHAPE_INVALID` "auth.json is not valid JSON"; the free plan returns HTTP 400 `CODEX_FREE_PLAN_REJECTED` "ChatGPT free plan is not supported — upgrade to Plus or higher."

## cli-auth.bdd-008

- Vitest: "Codex auth.json through the personal model-provider API > accepts all pasted auth.json workspace claim variants"
- Mode: run
- Given: A signed-in member.
- When: The member pastes Codex `auth.json` files via `POST /api/me/model-providers` that include an API key, use the `workspace.name` claim, use the legacy `chatgpt_workspace_name` claim, and have no workspace name.
- Then: Every paste is accepted with plan `plus`; the listed workspace name is `Acme`, "Workspace Claim", "Legacy Workspace Claim", and null respectively.

## cli-auth.bdd-009

- Vitest: "Codex auth.json through the personal model-provider API > derives pasted auth.json expiry from access tokens and the id-token fallback"
- Mode: run
- Given: An onboarded Pro member has a running tool Run with a firewall token.
- When: The member pastes a Codex `auth.json` whose access token carries an `exp` two hours ahead, and then one with an opaque access token and an ID token expiring three hours ahead; after each paste the Runner resolves the credential via `POST /api/webhooks/run/firewall/auth`.
- Then: Each resolution returns HTTP 200 with no refreshed connectors. The cached expiry is the access token `exp` minus 60 seconds for the first paste and the ID token expiry minus 60 seconds for the fallback.

## cli-auth.bdd-010

- Vitest: "Codex auth.json through the personal model-provider API > maps all malformed pasted auth.json inputs to endpoint errors"
- Mode: run
- Given: A signed-in member.
- When: The member pastes malformed Codex `auth.json` inputs via `POST /api/me/model-providers`: only an `OPENAI_API_KEY`, a non-JWT ID token, an ID token missing the account ID, an access token without `exp` and no ID token expiry, and a payload padded beyond 17 KiB.
- Then: Each returns HTTP 400 `CODEX_AUTH_JSON_SHAPE_INVALID` with, respectively, "auth.json shape unrecognized — your codex CLI may need updating", "auth.json id_token claims unparsable", "auth.json id_token missing required claims", "auth.json access_token has no exp claim", and "auth.json is unexpectedly large — paste only the contents of ~/.codex/auth.json".
