# connectors.bdd

## connectors.bdd-001

- Vitest: "CONN-01 and CHAIN-CONNECTOR: connector discovery and manual grant lifecycle > keeps a manual-grant connection and authorization when realtime publishing fails"
- Mode: run
- Given: A signed-in workspace member is connecting OpenAI while the realtime publishing service rejects the next two publishes with a rate-limit error.
- When: The member connects OpenAI with the `api-token` manual grant via `POST /api/connectors/openai/manual-grant`, then reads `GET /api/connector-accounts/connections?kind=builtin&connectorSlug=openai`.
- Then: The manual grant still succeeds, and the default connection read back has the same ID, target `builtin`/`openai`, and `connectionStatus` `connected`.

## connectors.bdd-002

- Vitest: "CONN-01 and CHAIN-CONNECTOR: connector discovery and manual grant lifecycle > discovers, connects, reads, computes scope diff, and deletes a manual connector through APIs"
- Mode: run
- Given: A signed-in workspace member with no connectors, an unauthenticated caller, and a signed-in user without an organization.
- When: Callers list `GET /api/connectors`; the member searches `GET /api/connectors/search` for "OPENAI", reads the OpenAI connections, posts an invalid manual grant with an unknown field, posts a valid `api-token` grant with a whitespace-padded key, reads the account, list, and `GET /api/connector-accounts/:id/scope-diff`, then deletes the default account.
- Then: Unauthenticated and org-less list calls return HTTP 401 `UNAUTHORIZED`; the member's initial list is empty and search shows OpenAI with auth methods `["api-token"]` and no default connection. The bad grant returns HTTP 400 mentioning `apiKey` without echoing the unknown field or its value. The valid grant connects with `authMethod` `api-token`, `connected`, null scopes, no visible secret, appears in the connector list, has an all-empty scope diff, and after deletion the default connection is null.

## connectors.bdd-003

- Vitest: "CONN-02: OAuth start and callback > uses App callbacks for enabled connectors while returning structured callback results"
- Mode: run
- Given: A signed-in member and a second member, with GitHub OAuth available at the provider.
- When: Each member starts `POST /api/connectors/github/oauth/start` with the App callback target, then the first completes `GET /api/connectors/github/callback` with a success code and JSON response mode, and the second completes it with `error=access_denied`.
- Then: The authorization URL's `redirect_uri` path is `/connectors/github/callback`. The success callback returns HTTP 200 `{status: "success", username: "bdd-github-user"}` with `cache-control: no-store` and clears the three connector OAuth cookies, and the member's GitHub account is connected as `bdd-github-user`. The denied callback returns `{status: "error", message: "Provider denied access"}` and the second member has no default GitHub connection.

## connectors.bdd-004

- Vitest: "CONN-02: OAuth start and callback > starts GitHub OAuth, completes the callback, rejects replay visibly, and keeps safe connector state"
- Mode: run
- Given: A signed-in member and a second member, with GitHub OAuth available at the provider.
- When: The member starts `POST /api/connectors/github/oauth/start`, completes `GET /api/connectors/github/callback` with a code and the state, then replays the same state with another code; the second member starts OAuth and returns with `error=access_denied`.
- Then: The authorization URL targets `https://github.com/login/oauth/authorize` with client ID `github-client-id`. The connected account shows OAuth, external ID `42`, username `bdd-github-user`, email `bdd-github@example.test`, scopes `repo`, `project`, `workflow`, no visible access token, and a scope diff with no added or removed scopes. After the replay the same account ID and username remain, and the denied member has no default GitHub connection.

## connectors.bdd-005

- Vitest: "CONN-02: OAuth start and callback > supports exact reconnect and sibling adds across OAuth callbacks"
- Mode: run
- Given: A signed-in member has connected a GitHub account through OAuth; the provider later returns a different GitHub user ID for one authorization.
- When: The member starts `POST /api/connectors/github/oauth/start` with `intent: reconnect` for that connection and completes the callback; repeats the reconnect while GitHub returns a different user; then starts with `intent: add` and display name "Personal" and completes the callback.
- Then: The same-account reconnect keeps the default connection ID. The mismatched reconnect redirects to `/connector/error` for `github` with "Authorized account does not match the connector account" and leaves the original connection ID and external ID unchanged. The sibling add yields two GitHub accounts, including a non-default "Personal" account.

## connectors.bdd-006

- Vitest: "CONN-02: OAuth start and callback > persists the callback-selected Datadog site through the public OAuth flow"
- Mode: run
- Given: A signed-in member, with Datadog OAuth available at the provider.
- When: The member starts `POST /api/connectors/datadog/oauth/start` and completes `GET /api/connectors/datadog/callback` with a code, the state, and `domain=us3.datadoghq.com`, then reads the account, its scope diff, and `GET /api/connector-catalog/status`.
- Then: The authorization URL uses `code_challenge_method=S256` and the callback redirects to `/connector/success`. Datadog receives one token request with the code and a PKCE verifier of at least 43 characters. The account shows OAuth with external ID and username `us3.datadoghq.com`, the provider-granted scopes, and no visible access or refresh token; the scope diff lists the seven Datadog read scopes as both current and stored with nothing added or removed; the catalog status includes `datadog`.

## connectors.bdd-007

- Vitest: "CONN-02: OAuth device authorization > starts and completes a device authorization session, with state visible through connector APIs"
- Mode: run
- Given: A signed-in member with the test OAuth connector feature switch enabled; the device provider grants scope "read provider-added" and later an explicitly empty scope.
- When: The member searches for the device connector, starts `POST /api/connectors/test-oauth-device/oauth/device/sessions` with `intent: add`, a same-org peer polls the session, the member polls `.../sessions/:id/poll`, reconnects with empty provider scope and polls, then starts another reconnect, deletes the account, and polls it.
- Then: Search shows auth methods `oauth` and `api`; the session is `pending` with user code `TEST-DEVICE` and verification URI `https://oauth-device.test/device`, and the provider receives scope `read`. The peer's poll returns HTTP 404 `NOT_FOUND`. The member's poll completes with a connected OAuth account with scopes `read` and `provider-added` that matches the default account and connector list. The empty-scope reconnect keeps the same ID with scopes `[]`. Polling after the account is deleted returns `error` with `connector_account_rejected` and "Connector account not found".

## connectors.bdd-008

- Vitest: "CONN-02: OAuth device authorization > re-polls the exact non-default account added by a device authorization session"
- Mode: run
- Given: A signed-in member with the test OAuth connector feature switch enabled and a device-auth provider that completes immediately.
- When: The member completes two device authorization sessions with `intent: add` for `test-oauth-device`, then polls the second (sibling) session again.
- Then: The two polls return different connection IDs; the account list shows the first as default and the second as non-default. Re-polling the sibling session returns the same sibling connection ID and the provider token endpoint has been called only twice in total.

## connectors.bdd-009

- Vitest: "CONN-02: OAuth device authorization > starts and completes the Stripe CLI device authorization method"
- Mode: run
- Given: A signed-in member, with Stripe's CLI dashboard authorization available; the clock advances 2 seconds before polling.
- When: The member starts `POST /api/connectors/stripe/oauth/device/sessions` with auth method `cli` and `mode: live`, then polls the session and lists connectors.
- Then: The session is `pending` with user code `STRIPE-CLI`, the Stripe CLI confirm URL as both verification URIs, `expiresIn` 600 and `interval` 1; Stripe receives client version `1.42.1` and device name `vm0-stripe-connector`. The single provider poll completes with a connected `cli` account for `acct_bdd` / "BDD Stripe" with no email and empty scopes, without exposing the restricted key, and the connector list shows that connection.

## connectors.bdd-010

- Vitest: "CONN-02: OAuth device authorization > validates device-auth identity, grant, options, and session boundaries without using rollout as authorization"
- Mode: run
- Given: A signed-in member with the test OAuth connector feature switch enabled, a second member without the switch, and an unauthenticated caller.
- When: Callers send `POST /api/connectors/:slug/oauth/device/sessions` for: no credentials; `github` oauth; `cloudinary` oauth; `test-oauth-device` with `api-token`; `test-oauth-device` oauth with option `mode`; `test-oauth-device` api with `environment: production`, with private key `mode`, and with a prototype key `toString`; `stripe` cli with `mode: production`; and the switchless member starting `test-oauth-device` oauth.
- Then: The unauthenticated start returns HTTP 401 `UNAUTHORIZED`. Each invalid start returns HTTP 400 with the exact message: GitHub does not support a device-auth grant; Cloudinary uses neither auth-code nor device-auth grant; no `api-token` auth method; oauth start option `mode` not supported; `environment` must be one of `test, live`; options must use public IDs (`environment`) for both the private and prototype keys; Stripe cli `mode` must be one of `test, live`. The switchless member's start returns HTTP 200 `pending`, and the provider received exactly one device-code request.

## connectors.bdd-011

- Vitest: "CONN-02: OAuth device authorization > supersedes, completes, and idempotently re-reads device authorization sessions per auth method"
- Mode: run
- Given: A signed-in member with the test OAuth connector feature switch enabled; the device provider grants scope "read granted".
- When: The member starts `api`-method device sessions with `environment: live` and with no options, starts two `oauth` sessions, polls the first (superseded) oauth session and the api session, deletes the default account, polls the second oauth session, and polls it again.
- Then: The provider receives the api client ID with `mode=live` and then `mode=test` by default. The oauth session is `pending` with user code `TEST-DEVICE`, verification URIs, `expiresIn` 600, `interval` 0, and no device code exposed. Polling the first oauth session returns `error` / `session_superseded` while the api session completes with auth method `api` using a test-mode device code. The second oauth session completes with a connected OAuth account with scopes `read` and `granted`, no visible access token, matching the default account and connector list; re-polling returns the same connection ID without another provider token request.

## connectors.bdd-012

- Vitest: "CONN-02: OAuth device authorization > walks pending, slow-down, interval, terminal, and expiry poll states through the API"
- Mode: run
- Given: A signed-in member with the test OAuth connector feature switch enabled; the device provider is configured per session to require a 5-second interval, keep returning pending, request slow-down, deny, expire, fail with an error, or not recognize the code, and finally to issue a session that expires immediately before the clock advances 2 seconds.
- When: For each provider behavior the member starts `POST /api/connectors/test-oauth-device/oauth/device/sessions` and polls the session twice via `.../poll`.
- Then: The interval-gated session returns `{status: "pending", interval: 5}` without contacting the provider token endpoint. Pending returns `pending` with interval 0 on both polls with two token requests; slow-down returns `pending` with interval 5 twice with one token request. Denied, expired, error and not-issued return `denied`/`access_denied`, `expired`/`expired_token`, `error`/`invalid_request`, and `error`/`invalid_grant` respectively, identically on re-poll, with one token request each. The locally expired session returns `expired`/`expired_token` "OAuth device authorization session expired" on both polls.

## connectors.bdd-013

- Vitest: "CONN-02: OAuth device authorization > serializes concurrent device polls when a session is superseded"
- Mode: run
- Given: A signed-in member with the test OAuth connector feature switch enabled; the device provider's token endpoint holds its first response.
- When: The member starts a `test-oauth-device` oauth device session and polls it; while the provider call is in flight the member polls the same session again, starts a new oauth session that supersedes the first, and then the held provider response is released.
- Then: The concurrent poll returns `{status: "pending", interval: 0}` without a second provider call. The original in-flight poll returns `error` / `session_superseded` "OAuth device authorization session was superseded", the provider was called exactly once, and the member has no default `test-oauth-device` connection.

## connectors.bdd-014

- Vitest: "CONN-02: OAuth device authorization > restores a device poll claim after a provider failure"
- Mode: run
- Given: A signed-in member with the test OAuth connector feature switch enabled; the device provider's token endpoint first returns an empty JSON body and is then restored to a pending response.
- When: The member starts a `test-oauth-device` oauth device session and polls it, then polls it again after the provider recovers.
- Then: The first poll returns HTTP 500 `{error: "Internal server error"}`. The second poll returns `{status: "pending", interval: 0}` and the restored provider receives exactly one token request.

## connectors.bdd-015

- Vitest: "CONN-02: OAuth device authorization > keeps the completed reclaimed device account when its stale poll returns"
- Mode: run
- Given: A signed-in member with the test OAuth connector feature switch enabled; the first provider token response is held, then the clock advances 31 seconds and the provider grants scope "read reclaimed".
- When: The member polls a `test-oauth-device` session (held in flight), polls the same session again after the claim expires, then the held stale poll returns, and the member polls once more and lists accounts.
- Then: The reclaiming poll completes with scopes `read` and `reclaimed` after one provider token request. The stale poll returns `{status: "pending", interval: 0}`, the later re-poll returns the same completed result, and the member has exactly one account with the reclaimed connection ID and scopes; the held endpoint was called once and the new provider once.

## connectors.bdd-016

- Vitest: "CONN-02: OAuth device authorization > does not publish a device account when its poll is reclaimed during token encryption"
- Mode: run
- Given: A signed-in member with the test OAuth connector feature switch enabled and a device provider granting scope "read stale"; the first token-encryption step is held, the clock advances 31 seconds, and the next provider token response is held.
- When: The member polls the session (stalled during token encryption), polls again after the claim expires, the stalled encryption is released, then the reclaiming provider response is released, and the member lists accounts and polls once more.
- Then: The stale poll returns `{status: "pending", interval: 0}` and no account exists at that point. The reclaiming poll completes with scopes `["read"]`, the account list contains exactly that connection with `read` scope, and a further poll returns the identical completed result.

## connectors.bdd-017

- Vitest: "CONN-02: OAuth device authorization > settles device connector facts once across concurrent connections and reconnects"
- Mode: run
- Given: A signed-in member, with Base44 and Slock device OAuth available at the providers and an external marketing rewards consumer receiving connector events.
- When: The member concurrently completes device authorization for `base44` and `slock` via `POST /api/connectors/:slug/oauth/device/sessions` and `.../poll`, then concurrently reconnects both; each received `connector.oauth-authorized` fact is settled as a 100-credit "connector" quest reward keyed per user and connector, and the member reads `GET /api/billing/usage-pack-credits`.
- Then: Each reconnect completes with the original connection ID. The consumer receives four `connector.oauth-authorized` facts, and after settlement the balance shows 200 bonus credits from exactly two bonus grants of 100 with 100 remaining each.

## connectors.bdd-018

- Vitest: "CONN-02: OAuth device authorization > completes Base44 and Slock device sessions with provider metadata visible through connector reads"
- Mode: run
- Given: A signed-in member, with Base44 and Slock device OAuth available at the providers; later Slock's user-info lookup fails after token issuance.
- When: The member starts and polls device sessions for `base44` and then `slock` via `POST /api/connectors/:slug/oauth/device/sessions` and `.../poll`, reads each default account, deletes it, and finally starts and polls a Slock session twice while user-info fails.
- Then: Base44 starts `pending` with user code `BASE-44`, its verification URIs, `expiresIn` 600 and `interval` 0, without exposing the device code; Base44 receives client `base44_cli` and scope `apps:read apps:write offline`, one token request with that device code, and one user-info call with the access token. The Base44 account is connected with the provider's ID, name, email and scopes, without tokens. Slock starts `pending` with user code `SLOCK-1` and its account is connected with Slock metadata, empty scopes, and a token expiry 850–900 seconds ahead, without tokens. The failing Slock session returns `error` / `post_token_lookup_failed` "Unable to load Slock account metadata after authorization." on both polls.

## connectors.bdd-019

- Vitest: "CONN-02: OAuth device authorization > continues polls after the connector feature switch is disabled"
- Mode: run
- Given: A signed-in member enabled the test OAuth connector feature switch, started a pending `test-oauth-device` oauth device session, and then disabled the switch.
- When: The member polls `POST /api/connectors/test-oauth-device/oauth/device/sessions/:sessionId/poll`.
- Then: The poll returns HTTP 200 `{status: "pending", interval: 0}`.

## connectors.bdd-020

- Vitest: "CONN-02: external-code authorization > validates external-code auth, grant, and session boundaries without using rollout as authorization"
- Mode: run
- Given: A signed-in member without any connector feature switch, and an unauthenticated caller.
- When: Callers send `POST /api/connectors/:slug/external-code/sessions`: unauthenticated for `aws` cli, the member for `openai` `api-token`, and the member for `aws` cli.
- Then: The unauthenticated start returns HTTP 401 `UNAUTHORIZED`. The OpenAI start returns HTTP 400 with a message containing "openai api-token auth method does not use an external-code grant". The member's AWS start returns HTTP 200 with `connectorSlug` `aws` and status `pending`.

## connectors.bdd-021

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects credentialless manual auth across definition write boundaries"
- Mode: run
- Given: A signed-in organization admin.
- When: The admin sends `POST /api/custom-connectors` for a manual connector whose only header injection is a literal value, creates a valid manual connector whose header references `{{secrets.api_key}}`, sends `PUT /api/custom-connectors/:id` switching it to the literal-only injection, and posts a create proposal with the literal-only injection to `POST /api/custom-connectors/proposals/save`.
- Then: The literal-only create, update and proposal each return HTTP 400 with "Manual custom connector injections must reference a declared secret or variable field". The valid connector is created without a connected default account, and after the rejected update it still has its original display name and header injections.

## connectors.bdd-022

- Vitest: "CONN-03: custom connectors and connector-owned secrets > requires an explicit member connection for optional manual fields"
- Mode: run
- Given: A signed-in organization admin creates a manual custom connector whose only field is an optional secret `api_key`.
- When: The admin reads the connector and its accounts, sends `PUT /api/custom-connectors/:id/values` with an empty value list, reads again, deletes the default custom account, and reads again.
- Then: Before the values write there is no connected account (no configured fields, no missing required fields). After the empty values write the default account is connected with no configured or missing fields, and the connector read reports that connection ID and an update timestamp. After the account is deleted the connector is not ready again.

## connectors.bdd-023

- Vitest: "CONN-03: custom connectors and connector-owned secrets > connects HTTP and MCP no-auth definitions with local credential-free accounts"
- Mode: run
- Given: A signed-in organization admin with storage writes accepted.
- When: The admin creates a no-auth HTTP custom connector with a required `region` variable in its prefix and a no-auth MCP connector, sets values via `PUT /api/custom-connectors/:id/values` (`region=us`, then empty for MCP, then `region=eu`), updates the HTTP connector to manual auth with a required secret, and then restores the no-auth definition.
- Then: Both definitions are created with `authMode` `none` and are not connected (HTTP missing `region`, MCP missing nothing). After the values writes both are connected (HTTP configured `region`, MCP no fields) and remain `none`; re-reading and changing the region keeps the HTTP connector connected. Switching to manual returns `storageVersion` 2 and the account is no longer ready; restoring no-auth returns `storageVersion` 3 and the account is still not ready.

## connectors.bdd-024

- Vitest: "CONN-03: custom connectors and connector-owned secrets > uses exact reconnect semantics for HTTP and MCP custom connectors"
- Mode: run
- Given: A signed-in organization admin creates, in turn, a manual HTTP custom connector and a manual MCP custom connector, each with a required `secret` field.
- When: For each connector the admin sends `PUT /api/custom-connectors/:id/values` with a secret and `intent: add`, again with a replacement secret and `intent: reconnect` for the returned connection ID, and again with `intent: add` and display name "Personal", then reads the connector.
- Then: The first add returns a connected default account with a connection ID; the reconnect returns the same connection ID and stays connected; the sibling add is connected, and the connector read still reports a connected default account, for both HTTP and MCP.

## connectors.bdd-025

- Vitest: "CONN-03: custom connectors and connector-owned secrets > stores an OAuth app config and lets members authorize"
- Mode: run
- Given: An organization admin and a member of the same organization; a custom OAuth provider is reachable and the App URL is `https://app.okou.test`.
- When: The admin creates an OAuth custom connector via `POST /api/custom-connectors` without and then with a client secret; the member starts `POST /api/custom-connectors/:id/oauth2/start` with `intent: add`, the admin updates the runtime prefix, the member completes `GET /api/custom-connectors/oauth2/callback` (JSON mode), reconnects the same account, starts another reconnect, deletes the account before completing it, and then authorizes again.
- Then: Creating without a secret returns HTTP 400 containing "client secret is required"; the created connector has `authMode` `oauth`, `storageVersion` 1, the client ID and scopes, and no visible secret. The authorization URL targets the provider with `response_type=code`, the client ID, scope `read write`, and redirect URI `https://app.okou.test/connectors/custom/callback`. The callback returns `{status: "success", username: null}` with `no-store`, the provider receives one `authorization_code` exchange with the client secret in the body, and the member's account is connected with no secrets or tokens visible. Reconnect keeps the same connection ID; completing a reconnect after deletion returns `{status: "error", message: "Connector account not found"}` and leaves no accounts (`reconnect-required`, `configuration_invalid`); a fresh authorization makes the connector ready again after four token exchanges in total.

## connectors.bdd-026

- Vitest: "CONN-03: custom connectors and connector-owned secrets > persists the reported subset for a standard custom OAuth connection"
- Mode: run
- Given: Row "reported subset": a signed-in organization admin has a standard OAuth custom connector requesting scopes `read` and `write`, and the provider's token response reports scope `read`.
- When: The admin starts `POST /api/custom-connectors/:id/oauth2/start` and completes `GET /api/custom-connectors/oauth2/callback` with the code and state, then lists the connector's accounts.
- Then: There is exactly one account and its `oauthScopes` are `["read"]`.

## connectors.bdd-027

- Vitest: "CONN-03: custom connectors and connector-owned secrets > persists the reported supplemental grant for a standard custom OAuth connection"
- Mode: run
- Given: Row "reported supplemental grant": a signed-in organization admin has a standard OAuth custom connector requesting scopes `read` and `write`, and the provider's token response reports scope `read write admin`.
- When: The admin starts `POST /api/custom-connectors/:id/oauth2/start` and completes `GET /api/custom-connectors/oauth2/callback` with the code and state, then lists the connector's accounts.
- Then: There is exactly one account and its `oauthScopes` are `["read", "write", "admin"]`.

## connectors.bdd-028

- Vitest: "CONN-03: custom connectors and connector-owned secrets > persists the omitted token scope for a standard custom OAuth connection"
- Mode: run
- Given: Row "omitted token scope": a signed-in organization admin has a standard OAuth custom connector requesting scopes `read` and `write`, and the provider's token response omits the scope.
- When: The admin starts `POST /api/custom-connectors/:id/oauth2/start` and completes `GET /api/custom-connectors/oauth2/callback` with the code and state, then lists the connector's accounts.
- Then: There is exactly one account and its `oauthScopes` are the requested `["read", "write"]`.

## connectors.bdd-029

- Vitest: "CONN-03: custom connectors and connector-owned secrets > requires fresh OAuth authorization after replacing manual credentials"
- Mode: run
- Given: A signed-in organization admin who can start chat runs has a custom OAuth connector (scope `read`) with a connected OAuth account; the provider issues tokens expiring in one hour.
- When: The admin updates the definition to manual auth with a required `api_key` secret via `PUT /api/custom-connectors/:id`, reconnects the existing account with `PUT /api/custom-connectors/:id/values`, starts a chat run whose sandbox requests credentials from `POST /api/webhooks/run/firewall/auth`, cancels the run, restores the OAuth definition, and reconnects the account through `POST /api/custom-connectors/:id/oauth2/start` and the OAuth callback.
- Then: The OAuth definition starts at `storageVersion` 1 and is ready; the manual update returns `storageVersion` 2 and is not ready until values are set. The run's firewall authorization resolves `Authorization: Bearer manual-api-key` for the custom connector. Restoring OAuth returns `storageVersion` 3 and the account is `reconnect-required` with reason `configuration_invalid` and no missing fields; after the OAuth reconnect the same account ID is connected with auth method `oauth`.

## connectors.bdd-030

- Vitest: "CONN-03: custom connectors and connector-owned secrets > keeps OAuth state target-scoped and aligns Custom lifecycle with Builtin"
- Mode: run
- Given: An organization admin created a custom OAuth connector (scope `read`); two members of the same organization (owner and peer) are signed in; GitHub OAuth and the custom provider are reachable.
- When: The owner starts custom OAuth and its state is replayed against `GET /api/connectors/github/callback`, then used on `GET /api/custom-connectors/oauth2/callback` without a code, with a code, and replayed; the owner starts again and returns `access_denied`, then replays that state; the peer starts GitHub OAuth and sends its state to the custom callback, completes GitHub, and starts custom OAuth whose callback arrives after the clock advances 16 minutes.
- Then: The custom state on the GitHub callback redirects to `/connector/error` with "Invalid state - please try again". The custom callback without a code returns "Missing authorization code" with no token exchange; with a code it returns `{status: "success", username: null}` after one exchange, making the owner (not the peer) connected. Replay, denied-state replay, GitHub state on the custom callback, and both expired callbacks return "Invalid OAuth state - please try again"; the denied callback returns "Provider denied access". The GitHub callback redirects to `/connector/success` and the peer's GitHub account is connected; the provider saw only one token exchange and the peer's custom connector stays not ready.

## connectors.bdd-031

- Vitest: "CONN-03: custom connectors and connector-owned secrets > reuses confidential OAuth for MCP and connects the agent"
- Mode: run
- Given: An organization admin and a member of the same organization with storage writes accepted; a confidential OAuth provider is reachable for an MCP server.
- When: The admin creates an OAuth MCP custom connector via `POST /api/custom-connectors` without and then with a client secret; the member starts `POST /api/custom-connectors/:id/oauth2/start`; the admin moves the MCP endpoint to `/v2/server` without resending the secret; the member completes `GET /api/custom-connectors/oauth2/callback` and reads the connector.
- Then: Creating without a secret returns HTTP 400 containing "client secret is required". The created connector is `mcp`/`oauth` at `storageVersion` 1, not yet ready, without a visible secret. The endpoint move keeps the same ID and `storageVersion` 1. The callback returns `{status: "success", username: null}`, the provider receives one token exchange carrying the stored client secret, and the member's connector is ready with no secret visible.

## connectors.bdd-032

- Vitest: "CONN-03: custom connectors and connector-owned secrets > connects an Automatic MCP OAuth account through Okou CIMD"
- Mode: run
- Given: A signed-in organization admin with Okou's API, web and App URLs configured; an Automatic MCP OAuth server supports client ID metadata documents (CIMD) and returns identity claims and user info.
- When: The admin creates an `automatic` MCP custom connector, starts `POST /api/custom-connectors/:id/oauth2/start`, and completes `GET /api/custom-connectors/oauth2/callback` with the code, state and issuer, then reads the connector and its accounts.
- Then: The authorization URL targets the issuer's `/authorize` with the Okou CIMD client ID URL, redirect URI `https://app.okou.ai/connectors/custom/callback`, the MCP endpoint as `resource`, scope `read write`, and S256 PKCE. The callback returns `{status: "success", username: null}`; no dynamic client registration occurs and one token exchange carries the resource and CIMD client ID. The connector stays `automatic` and ready, with one account showing the subject as external ID, the user-info username and email, and scopes `read` and `write`.

## connectors.bdd-033

- Vitest: "CONN-03: custom connectors and connector-owned secrets > keeps an Automatic MCP OAuth account unnamed for an invalid ID token"
- Mode: run
- Given: A signed-in organization admin has an `automatic` MCP custom connector whose CIMD OAuth server returns an invalid ID token with untrusted identity claims.
- When: The admin starts `POST /api/custom-connectors/:id/oauth2/start` and completes the OAuth callback with the code, state and issuer, then lists the connector's accounts.
- Then: The single account has null external ID, username and email, and scopes `read` and `write`.

## connectors.bdd-034

- Vitest: "CONN-03: custom connectors and connector-owned secrets > resolves Automatic MCP auth and reconnects the exact account across none and OAuth"
- Mode: run
- Given: A signed-in organization admin has an `automatic` MCP custom connector whose server first requires no authentication, then requires CIMD OAuth, then again requires no authentication.
- When: The admin calls `POST /api/custom-connectors/:id/oauth2/start` with no intent, then with `intent: reconnect` for the resulting account (completing the OAuth callback), then reconnects again after the server drops authentication, and finally starts with `intent: add` and display name "No-auth sibling".
- Then: The first start returns `result: connected` with the connector (`automatic`) ready and an account with auth method `none`. The OAuth reconnect returns an authorization URL while the account stays `none` until the callback, after which the same account ID is `oauth`, connected, with null external identity. The no-auth reconnect returns `connected` with the same ID and auth method `none`. The add creates a different connection, leaving two accounts.

## connectors.bdd-035

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects Automatic OAuth callback authority drift before token exchange"
- Mode: run
- Given: A signed-in organization admin has an `automatic` MCP custom connector backed by a CIMD OAuth server.
- When: The admin starts `POST /api/custom-connectors/:id/oauth2/start` three times and completes `GET /api/custom-connectors/oauth2/callback` with no `iss`, with a different issuer, and after updating the connector's endpoint via `PUT /api/custom-connectors/:id` (with the correct issuer).
- Then: The missing and wrong issuer callbacks return `{status: "error", message: "OAuth authorization issuer did not match - please try again"}`. The endpoint update returns `storageVersion` 2 and the later callback returns "Custom connector OAuth configuration changed - please try again". The provider receives no token exchange.

## connectors.bdd-036

- Vitest: "CONN-03: custom connectors and connector-owned secrets > reuses one DCR client across Automatic MCP OAuth accounts"
- Mode: run
- Given: A signed-in organization admin has an `automatic` MCP custom connector whose OAuth server requires dynamic client registration (DCR).
- When: The admin starts `POST /api/custom-connectors/:id/oauth2/start` and completes the callback, then starts with `intent: add` and display name "Second" and completes that callback.
- Then: The authorization URL uses client ID `automatic-dcr-client`. The provider receives exactly one registration with redirect URI `https://app.okou.ai/connectors/custom/callback` and scope `read write`, and two token exchanges each authenticated with HTTP Basic credentials of the registered client ID and secret. The connector has two accounts.

## connectors.bdd-037

- Vitest: "CONN-03: custom connectors and connector-owned secrets > accepts Automatic DCR seconds issuance and seconds expiry"
- Mode: run
- Given: Row issued=seconds, expiry=seconds: a signed-in organization admin has an `automatic` MCP custom connector whose OAuth server uses dynamic client registration, reports the client-ID issuance time (one second ago) in seconds, and reports the client-secret expiry (one hour ahead) in seconds.
- When: The admin starts `POST /api/custom-connectors/:id/oauth2/start` and completes the OAuth callback, then starts again with `intent: add` and display name "Second" and completes that callback.
- Then: The provider receives exactly one client registration and the connector has two accounts.

## connectors.bdd-038

- Vitest: "CONN-03: custom connectors and connector-owned secrets > accepts Automatic DCR milliseconds issuance and milliseconds expiry"
- Mode: run
- Given: Row issued=milliseconds, expiry=milliseconds: a signed-in organization admin has an `automatic` MCP custom connector whose OAuth server uses dynamic client registration, reports the client-ID issuance time (one second ago) in milliseconds, and reports the client-secret expiry (one hour ahead) in milliseconds.
- When: The admin starts `POST /api/custom-connectors/:id/oauth2/start` and completes the OAuth callback, then starts again with `intent: add` and display name "Second" and completes that callback.
- Then: The provider receives exactly one client registration and the connector has two accounts.

## connectors.bdd-039

- Vitest: "CONN-03: custom connectors and connector-owned secrets > accepts Automatic DCR milliseconds issuance and absent expiry"
- Mode: run
- Given: Row issued=milliseconds, expiry=absent: a signed-in organization admin has an `automatic` MCP custom connector whose OAuth server uses dynamic client registration, reports the client-ID issuance time (one second ago) in milliseconds, and omits the client-secret expiry.
- When: The admin starts `POST /api/custom-connectors/:id/oauth2/start` and completes the OAuth callback, then starts again with `intent: add` and display name "Second" and completes that callback.
- Then: The provider receives exactly one client registration and the connector has two accounts.

## connectors.bdd-040

- Vitest: "CONN-03: custom connectors and connector-owned secrets > accepts Automatic DCR milliseconds issuance and seconds expiry"
- Mode: run
- Given: Row issued=milliseconds, expiry=seconds: a signed-in organization admin has an `automatic` MCP custom connector whose OAuth server uses dynamic client registration, reports the client-ID issuance time (one second ago) in milliseconds, and reports the client-secret expiry (one hour ahead) in seconds.
- When: The admin starts `POST /api/custom-connectors/:id/oauth2/start` and completes the OAuth callback, then starts again with `intent: add` and display name "Second" and completes that callback.
- Then: The provider receives exactly one client registration and the connector has two accounts.

## connectors.bdd-041

- Vitest: "CONN-03: custom connectors and connector-owned secrets > accepts Automatic DCR seconds issuance and milliseconds expiry"
- Mode: run
- Given: Row issued=seconds, expiry=milliseconds: a signed-in organization admin has an `automatic` MCP custom connector whose OAuth server uses dynamic client registration, reports the client-ID issuance time (one second ago) in seconds, and reports the client-secret expiry (one hour ahead) in milliseconds.
- When: The admin starts `POST /api/custom-connectors/:id/oauth2/start` and completes the OAuth callback, then starts again with `intent: add` and display name "Second" and completes that callback.
- Then: The provider receives exactly one client registration and the connector has two accounts.

## connectors.bdd-042

- Vitest: "CONN-03: custom connectors and connector-owned secrets > accepts absent issuance and zero non-expiring DCR secret"
- Mode: run
- Given: A signed-in organization admin has an `automatic` MCP custom connector whose DCR response has no client-ID issuance time and a client-secret expiry of 0 (non-expiring).
- When: The admin starts `POST /api/custom-connectors/:id/oauth2/start` and completes the OAuth callback with the code, state and issuer.
- Then: The authorization succeeds and the provider receives exactly one client registration.

## connectors.bdd-043

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects stale issuance in Automatic DCR milliseconds before persistence"
- Mode: run
- Given: Row "stale issuance": a signed-in organization admin has an `automatic` MCP custom connector whose DCR response reports a client-ID issuance time 30 days in the past, in milliseconds.
- When: The admin sends `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 400 with error code `MCP_OAUTH_CLIENT_REGISTRATION_INVALID` and the provider receives no token request.

## connectors.bdd-044

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects expired secret in Automatic DCR milliseconds before persistence"
- Mode: run
- Given: Row "expired secret": a signed-in organization admin has an `automatic` MCP custom connector whose DCR response reports a client-secret expiry one minute in the past, in milliseconds.
- When: The admin sends `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 400 with error code `MCP_OAUTH_CLIENT_REGISTRATION_INVALID` and the provider receives no token request.

## connectors.bdd-045

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects unbounded secret lifetime in Automatic DCR milliseconds before persistence"
- Mode: run
- Given: Row "unbounded secret lifetime": a signed-in organization admin has an `automatic` MCP custom connector whose DCR response reports a client-secret expiry about 200 years ahead, in milliseconds.
- When: The admin sends `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 400 with error code `MCP_OAUTH_CLIENT_REGISTRATION_INVALID` and the provider receives no token request.

## connectors.bdd-046

- Vitest: "CONN-03: custom connectors and connector-owned secrets > connects an Automatic DCR client using none"
- Mode: run
- Given: Row `none`: a signed-in organization admin has an `automatic` MCP custom connector whose DCR client is registered with token endpoint auth method `none`.
- When: The admin starts `POST /api/custom-connectors/:id/oauth2/start` and completes the OAuth callback with the code, state and issuer.
- Then: The provider receives one registration; the token request has no Authorization header, client ID `automatic-dcr-client`, and no `client_secret`.

## connectors.bdd-047

- Vitest: "CONN-03: custom connectors and connector-owned secrets > connects an Automatic DCR client using client_secret_post"
- Mode: run
- Given: Row `client_secret_post`: a signed-in organization admin has an `automatic` MCP custom connector whose DCR client is registered with token endpoint auth method `client_secret_post`.
- When: The admin starts `POST /api/custom-connectors/:id/oauth2/start` and completes the OAuth callback with the code, state and issuer.
- Then: The provider receives one registration; the token request has no Authorization header, client ID `automatic-dcr-client`, and `client_secret` `automatic-dcr-secret` in the body.

## connectors.bdd-048

- Vitest: "CONN-03: custom connectors and connector-owned secrets > discovers Automatic OAuth through RFC 9728 and OIDC fallbacks"
- Mode: run
- Given: A signed-in organization admin has an `automatic` MCP custom connector whose server is discovered only through well-known OIDC fallback, issues no scope challenge, advertises metadata scopes `metadata-read` and `metadata-write`, and does not support the issuer callback parameter.
- When: The admin starts `POST /api/custom-connectors/:id/oauth2/start` and completes the OAuth callback without an `iss` parameter.
- Then: The authorization URL requests scope `metadata-read metadata-write` and the provider receives exactly one token exchange.

## connectors.bdd-049

- Vitest: "CONN-03: custom connectors and connector-owned secrets > maps temporary Automatic OAuth discovery and DCR failures to 502"
- Mode: run
- Given: A signed-in organization admin creates `automatic` MCP custom connectors; first the server's protected-resource metadata returns HTTP 503, then dynamic client registration fails temporarily with HTTP 429 and with HTTP 503.
- When: For each connector the admin sends `POST /api/custom-connectors/:id/oauth2/start`.
- Then: Every start returns HTTP 502 with error code `MCP_OAUTH_PROVIDER_UNAVAILABLE`; in each DCR case the provider received exactly one registration attempt.

## connectors.bdd-050

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects Automatic OAuth with an invalid MCP authentication response"
- Mode: run
- Given: Row "an invalid MCP authentication response": a signed-in organization admin has an `automatic` MCP custom connector where the MCP server returns an invalid authentication challenge.
- When: The admin sends `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 400 with exactly error code `MCP_OAUTH_AUTHENTICATION_RESPONSE_INVALID` and message "Automatic MCP OAuth setup failed. Check the server's OAuth configuration or choose another authentication method."

## connectors.bdd-051

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects Automatic OAuth with a mismatched protected resource"
- Mode: run
- Given: Row "a mismatched protected resource": a signed-in organization admin has an `automatic` MCP custom connector where the protected-resource metadata names a different resource URL.
- When: The admin sends `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 400 with exactly error code `MCP_OAUTH_DISCOVERY_INVALID` and message "Automatic MCP OAuth setup failed. Check the server's OAuth configuration or choose another authentication method."

## connectors.bdd-052

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects Automatic OAuth with an unsafe authorization endpoint"
- Mode: run
- Given: Row "an unsafe authorization endpoint": a signed-in organization admin has an `automatic` MCP custom connector where the authorization endpoint URL contains a fragment.
- When: The admin sends `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 400 with exactly error code `MCP_OAUTH_UNSAFE_URL` and message "Automatic MCP OAuth setup failed. Check the server's OAuth configuration or choose another authentication method."

## connectors.bdd-053

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects Automatic OAuth with a mismatched metadata issuer"
- Mode: run
- Given: Row "a mismatched metadata issuer": a signed-in organization admin has an `automatic` MCP custom connector where the authorization-server metadata reports a different issuer.
- When: The admin sends `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 400 with exactly error code `MCP_OAUTH_DISCOVERY_INVALID` and message "Automatic MCP OAuth setup failed. Check the server's OAuth configuration or choose another authentication method."

## connectors.bdd-054

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects Automatic OAuth with unsupported authorization code"
- Mode: run
- Given: Row "unsupported authorization code": a signed-in organization admin has an `automatic` MCP custom connector where the authorization server does not support the authorization-code grant.
- When: The admin sends `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 400 with exactly error code `MCP_OAUTH_AUTHORIZATION_UNSUPPORTED` and message "Automatic MCP OAuth setup failed. Check the server's OAuth configuration or choose another authentication method."

## connectors.bdd-055

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects Automatic OAuth with unsupported PKCE"
- Mode: run
- Given: Row "unsupported PKCE": a signed-in organization admin has an `automatic` MCP custom connector where the authorization server does not support S256 PKCE.
- When: The admin sends `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 400 with exactly error code `MCP_OAUTH_AUTHORIZATION_UNSUPPORTED` and message "Automatic MCP OAuth setup failed. Check the server's OAuth configuration or choose another authentication method."

## connectors.bdd-056

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects Automatic OAuth with no automatic client registration"
- Mode: run
- Given: Row "no automatic client registration": a signed-in organization admin has an `automatic` MCP custom connector where the server offers neither CIMD nor dynamic client registration.
- When: The admin sends `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 400 with exactly error code `MCP_OAUTH_CLIENT_REGISTRATION_UNAVAILABLE` and message "Automatic MCP OAuth setup failed. Check the server's OAuth configuration or choose another authentication method."

## connectors.bdd-057

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects Automatic OAuth with rejected client registration"
- Mode: run
- Given: Row "rejected client registration": a signed-in organization admin has an `automatic` MCP custom connector where dynamic client registration fails with HTTP 400 and a private error description.
- When: The admin sends `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 400 with exactly error code `MCP_OAUTH_CLIENT_REGISTRATION_REJECTED` and message "Automatic MCP OAuth setup failed. Check the server's OAuth configuration or choose another authentication method."

## connectors.bdd-058

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects Automatic OAuth with invalid client registration details"
- Mode: run
- Given: Row "invalid client registration details": a signed-in organization admin has an `automatic` MCP custom connector where dynamic client registration returns an invalid response.
- When: The admin sends `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 400 with exactly error code `MCP_OAUTH_CLIENT_REGISTRATION_INVALID` and message "Automatic MCP OAuth setup failed. Check the server's OAuth configuration or choose another authentication method."

## connectors.bdd-059

- Vitest: "CONN-03: custom connectors and connector-owned secrets > returns a distinct code when connected accounts hold an incompatible DCR client"
- Mode: run
- Given: A signed-in organization admin has an `automatic` MCP custom connector with one account authorized through a DCR client registered for challenge scope `read`; the server then challenges for `read write`.
- When: The admin sends `POST /api/custom-connectors/:id/oauth2/start` with `intent: add`.
- Then: The response is HTTP 400 with error code `MCP_OAUTH_CLIENT_REGISTRATION_CONFLICT`, and the provider still has only one client registration.

## connectors.bdd-060

- Vitest: "CONN-03: custom connectors and connector-owned secrets > authorizes Automatic OAuth through DCR and CIMD and requires reauthorization after definition changes"
- Mode: run
- Given: A signed-in organization admin; one MCP server uses dynamic client registration and fails the second authorization-code exchange with `invalid_grant`, and another MCP server supports CIMD.
- When: The admin creates an `automatic` MCP connector, starts `POST /api/custom-connectors/:id/oauth2/start` and completes the callback, reconnects the account and completes the failing callback, creates and authorizes a second `automatic` connector on the CIMD server, then updates the first connector to static `oauth` settings and back to `automatic` via `PUT /api/custom-connectors/:id`.
- Then: The DCR connector registers one client, becomes ready with an `oauth` connected account, and its read has no `oauthConfig` and no visible DCR secret. The failing reconnect callback returns `{status: "error", message: "OAuth token exchange failed - please try again"}`. The CIMD connector connects an `oauth` account without any client registration. Switching to static OAuth returns `storageVersion` 2 and the account is no longer ready; switching back returns `authMode` `automatic` with `storageVersion` 3.

## connectors.bdd-061

- Vitest: "CONN-03: custom connectors and connector-owned secrets > requires member reauthorization after incompatible OAuth settings changes"
- Mode: run
- Given: An organization admin created a standard OAuth custom connector with scope `read`, and a member of the organization connected an account through OAuth.
- When: The member and then the admin send `PUT /api/custom-connectors/:id` changing the name, prefix to `/v2/`, and scopes to `read write` without resending the secret; the member then reconnects through `POST /api/custom-connectors/:id/oauth2/start` with `intent: reconnect` and completes the callback.
- Then: The member's update returns HTTP 403 with a message containing "Only org admins". The admin's update returns the new name, prefix, `storageVersion` 2, the client ID and new scopes, without the secret; the member's account becomes `reconnect-required` with `configuration_invalid` and no missing fields. The reconnect authorization URL uses the same client ID and scope `read write`, and afterward the connector (still `storageVersion` 2) is ready.

## connectors.bdd-062

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects API definition updates for an OAuth-only connector without changing it"
- Mode: run
- Given: A signed-in organization admin has an OAuth-only custom connector with no fields.
- When: The admin posts an update proposal to `POST /api/custom-connectors/proposals/save` that adds a required `api_key` secret field, a header referencing it, a new prefix, and a secret value, then lists `GET /api/custom-connectors`.
- Then: The proposal returns HTTP 400 "OAuth custom connectors cannot declare fields; remove all fields and their template references". The list still contains the original connector unchanged and never shows the submitted secret value.

## connectors.bdd-063

- Vitest: "CONN-03: custom connectors and connector-owned secrets > persists canonical manual template references unchanged on create and update"
- Mode: run
- Given: A signed-in organization admin.
- When: The admin creates a manual custom connector with `secret`, `api_key` and `region` fields whose header and query templates reuse `{{secrets.secret}}`, `{{secrets.api_key}}` and `{{variables.region}}`, reads it, updates the templates to a different arrangement via `PUT /api/custom-connectors/:id`, and reads it again.
- Then: The create response and readback contain the header and query templates exactly as submitted. The update keeps the same `storageVersion`, and the update response and readback contain the new templates exactly as submitted.

## connectors.bdd-064

- Vitest: "CONN-03: custom connectors and connector-owned secrets > creates, patches, connects, and deletes a custom connector through APIs"
- Mode: run
- Given: A signed-in organization admin and a member in the same organization, a second admin in another organization, and storage writes accepted.
- When: The member tries `POST /api/custom-connectors`; the admin creates a manual HTTP connector, sets its secret via `PUT /api/custom-connectors/:id/values`, updates its name and prefix twice, disconnects the default account, sets a new secret, and deletes the connector; the other admin creates its own connector.
- Then: The member's create returns HTTP 403 `FORBIDDEN`. The admin's list shows the slug, display name, prefix and `Bearer {{secrets.secret}}` header; after the secret write the single account is connected and the secret is never visible. The first update returns the new name and `/v2/` prefix and stays ready. After disconnect the connector is not ready with no configured fields; a new secret makes it ready again; after deletion it is absent from the admin's list.

## connectors.bdd-065

- Vitest: "CONN-03: custom connectors and connector-owned secrets > lets an admin agent with an okou-scoped token create a manual definition that Connect can configure"
- Mode: run
- Given: An organization admin runs a chat agent whose execution receives an Okou-scoped token, and the admin's organization membership is `org:admin`.
- When: The agent uses that token to call `POST /api/custom-connectors` with a manual definition requiring a `secret` field; the admin then sets the secret via `PUT /api/custom-connectors/:id/values` and lists `GET /api/custom-connectors`.
- Then: The agent's create returns HTTP 201 with an ID and `authMode` `manual`, not ready, with `secret` missing and no configured fields. After the admin sets the secret the connector is ready with `secret` configured and the secret value is not visible in the list.

## connectors.bdd-066

- Vitest: "CONN-03: custom connectors and connector-owned secrets > sets all manual custom connector values through the values endpoint"
- Mode: run
- Given: An organization admin who can run chat agents creates a manual custom connector with a required `api_key` secret and a required `subdomain` variable used in the prefix.
- When: The admin sends `PUT /api/custom-connectors/:id/values` with both values, reconnects the account with only an updated secret, starts a chat run whose sandbox calls `POST /api/webhooks/run/firewall/auth`, disconnects the default account, sets new values, and runs again.
- Then: The connector starts at `storageVersion` 1; the first write connects it with both fields configured and none missing, generating one KMS data key, and the second write generates a second data key; secrets are never visible. The run's firewall authorization returns `Authorization: Bearer updated-secret` with routing variable `subdomain=acme`. After disconnect the connector is not ready with both fields missing; after the new write it is ready and the next run resolves `Bearer reconnected-secret` with `subdomain=reconnected`.

## connectors.bdd-067

- Vitest: "CONN-03: custom connectors and connector-owned secrets > revokes usable custom credentials when the member disconnects"
- Mode: run
- Given: An organization admin who can run chat agents has a manual custom connector with `api_key` and `subdomain` values set, and a running chat run that claimed it.
- When: The sandbox requests credentials from `POST /api/webhooks/run/firewall/auth`, the admin disconnects the default custom account, and the sandbox repeats the same request.
- Then: The first authorization returns HTTP 200 with `Authorization: Bearer shared-secret`. After disconnect the same request returns HTTP 424, and the connector is not ready with no configured fields and both `api_key` and `subdomain` missing.

## connectors.bdd-068

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects an incomplete first manual value write without connecting an account"
- Mode: run
- Given: A signed-in organization admin has a manual custom connector with a required `api_key` secret and a required `account` variable, and no account.
- When: The admin sends `PUT /api/custom-connectors/:id/values` with only `api_key`.
- Then: The response is HTTP 400 with a message containing "All required fields must be provided when connecting or restoring". The connector has no accounts and is not ready, with no configured fields and both `api_key` and `account` missing.

## connectors.bdd-069

- Vitest: "CONN-03: custom connectors and connector-owned secrets > isolates identical manual variable names by Custom connection"
- Mode: run
- Given: An organization admin who can run chat agents has two manual custom connectors, each with a required `region` variable injected as a `region` query parameter.
- When: The admin sets `region=east` on the first and `region=west` on the second via `PUT /api/custom-connectors/:id/values`, starts a chat run, and its sandbox requests `POST /api/webhooks/run/firewall/auth` for each connector.
- Then: The two connectors have distinct accounts. The first connector's authorization returns query `region=east` and the second's returns `region=west`.

## connectors.bdd-070

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rolls back Custom values when a shared write fails"
- Mode: run
- Given: An organization admin who can run chat agents has a manual custom connector with a required `api_key` secret set to `rollback-original` and an optional `note` variable, and a running chat run that claimed it.
- When: The sandbox requests `POST /api/webhooks/run/firewall/auth`; the admin then reconnects the account via `PUT /api/custom-connectors/:id/values` with a replacement secret and a `note` value containing a NUL character; the sandbox repeats the request.
- Then: The first authorization returns `Authorization: Bearer rollback-original` with `expiresAt` null. The failing write returns HTTP 500, the connector read is identical to before the write, and the repeated authorization returns exactly the original response with `Bearer rollback-original`.

## connectors.bdd-071

- Vitest: "CONN-03: custom connectors and connector-owned secrets > authors storage versions and requires complete stale manual recovery"
- Mode: run
- Given: A signed-in organization admin creates a manual custom connector with explicit `storageVersion` 3, a required `api_key` secret and an optional `legacy_optional` variable, and connects an account with both values.
- When: The admin sends `PUT /api/custom-connectors/:id` with a rename at version 3, with a changed credential contract (adds a required `replacement` secret) still at version 3, and with the changed contract without a version; then reconnects via `PUT /api/custom-connectors/:id/values` with only `replacement`, then with both secrets; then updates with version 5 and with version 4.
- Then: The rename keeps `storageVersion` 3. The changed contract at version 3 returns HTTP 400 containing "must increase when the credential contract changes"; without a version it is inferred as 4 and the account becomes not ready with `api_key` and `replacement` missing. The partial reconnect returns HTTP 400 containing "All required fields must be provided"; the full reconnect makes it ready with both fields configured. Version 5 is accepted, and the later version 4 returns HTTP 400 containing "cannot decrease".

## connectors.bdd-072

- Vitest: "CONN-03: custom connectors and connector-owned secrets > saves a connector proposal with values"
- Mode: run
- Given: A signed-in organization admin.
- When: The admin posts a create proposal to `POST /api/custom-connectors/proposals/save` with a `{{variables.subdomain}}` host prefix, required `api_key` secret and `subdomain` variable, a bearer header and a `tenant` query injection, plus values for both fields, then lists `GET /api/custom-connectors`.
- Then: The saved connector has the submitted name, prefix template and header injection and is ready with both fields configured and none missing. The listed connector is ready with both fields configured and the secret value is not visible.

## connectors.bdd-073

- Vitest: "CONN-03: custom connectors and connector-owned secrets > saves a connector proposal before required values are configured"
- Mode: run
- Given: A signed-in organization admin with storage writes accepted.
- When: The admin saves a create proposal via `POST /api/custom-connectors/proposals/save` with a required `api_key` field and no values, then another with an optional `api_key` field and no values, and lists the second connector's accounts.
- Then: The first connector is not ready with `api_key` missing and nothing configured. The second is ready with nothing missing or configured, and its only account is the returned default connection with no configured or missing fields.

## connectors.bdd-074

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects connector proposal host variables that change URL structure"
- Mode: run
- Given: A signed-in organization admin with no custom connectors.
- When: The admin posts a create proposal to `POST /api/custom-connectors/proposals/save` with a `{{variables.subdomain}}` host prefix and the `subdomain` value `evil.test/path`.
- Then: The response is HTTP 400 with a message containing "not safe in custom connector host templates", and the admin's custom connector list remains empty.

## connectors.bdd-075

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects runtime-dependent custom connector hostnames at API boundaries"
- Mode: run
- Given: A signed-in organization admin with no custom connectors.
- When: For the hosts `࢏.example` and `xn--7xb.example`, the admin sends `POST /api/custom-connectors` with that host in the prefix and posts a create proposal whose `subdomain` variable value is that host.
- Then: Each create returns HTTP 400 mentioning `vm0-uts46-16.0-v1`; each proposal returns HTTP 400 containing "not a valid custom connector hostname" without echoing the secret value. The custom connector list stays empty.

## connectors.bdd-076

- Vitest: "CONN-03: custom connectors and connector-owned secrets > preserves valid Unicode prefixes while deriving a canonical default slug"
- Mode: run
- Given: A signed-in organization admin.
- When: The admin creates a manual HTTP custom connector with prefix `https://münich.example/v1/` via `POST /api/custom-connectors`, then deletes it.
- Then: The connector keeps the raw Unicode prefix and gets a slug matching `_xn-mnich-kva-example-` followed by six lowercase alphanumerics; after deletion the custom connector list is empty.

## connectors.bdd-077

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects invalid hostname updates without changing the connector"
- Mode: run
- Given: A signed-in organization admin has a manual HTTP custom connector.
- When: The admin posts an update proposal to `POST /api/custom-connectors/proposals/save` changing the prefix to `https://࢏.example/v2/`.
- Then: The response is HTTP 400 mentioning `vm0-uts46-16.0-v1`, and the list still contains the original connector unchanged.

## connectors.bdd-078

- Vitest: "CONN-03: custom connectors and connector-owned secrets > disconnects a variable-only connection through the stable endpoint"
- Mode: run
- Given: A signed-in organization admin saved a proposal for a custom connector whose only field is a required `subdomain` variable used in the host and a `tenant` query injection, with value `acme`.
- When: The admin disconnects the default custom connector account through the connector-accounts delete endpoint (`DELETE /api/connector-accounts/:connectionId`) and lists `GET /api/custom-connectors`.
- Then: The saved connector has no header injections, the `tenant` query injection, and is ready with `subdomain` configured. After disconnect it is not ready, with no configured fields and `subdomain` missing.

## connectors.bdd-079

- Vitest: "CONN-03: custom connectors and connector-owned secrets > preserves authentication boundaries across custom connector routes"
- Mode: run
- Given: An unauthenticated caller and a signed-in user without an organization; a random custom connector ID.
- When: Each caller calls `GET /api/custom-connectors`, `POST /api/custom-connectors`, `DELETE /api/custom-connectors/:id`, `PUT /api/custom-connectors/:id/values` with a secret, and `POST /api/custom-connectors/:id/oauth2/start`.
- Then: Every request returns HTTP 401 with error code `UNAUTHORIZED`.

## connectors.bdd-080

- Vitest: "CONN-03: custom connectors and connector-owned secrets > validates and normalises custom connector creation through visible create and list responses"
- Mode: run
- Given: A signed-in organization admin with no custom connectors.
- When: The admin creates manual HTTP custom connectors via `POST /api/custom-connectors` with prefixes `https://api.<host>/v1` (twice), `https://*.<host>/v1`, `https://api.github.com/v3/`, and `https://api.github.com./v3/`, lists them, and deletes them all.
- Then: The first connector gets a slug derived from the host (`_api-<host-with-dashes>-` plus six characters), keeps the prefix unchanged, and has no accounts. The duplicate prefix creates a distinct ID and slug with the same prefix. The wildcard prefix gets a slug without the `api` label and keeps the wildcard. The GitHub-overlapping prefix is accepted as is, and the trailing-dot variant gets a distinct ID and slug. The list contains exactly the five IDs and is empty after deletion.

## connectors.bdd-081

- Vitest: "CONN-03: custom connectors and connector-owned secrets > preserves custom HTTP prefix trailing slashes through edits and readback"
- Mode: run
- Given: A signed-in organization admin.
- When: The admin creates a manual HTTP connector with prefixes `.../systemone/` and `.../events`, renames it keeping the prefixes, updates the prefixes to `.../systemone` and `.../events/` via `PUT /api/custom-connectors/:id`, then tries an update with `.../systemone` and `.../systemone/` together.
- Then: Create, readback and rename keep the exact prefix spellings including trailing slashes; the edited prefixes are returned and listed exactly as submitted. The duplicate pair returns HTTP 400 containing "Duplicate prefix template" and the connector keeps the edited prefixes.

## connectors.bdd-082

- Vitest: "CONN-03: custom connectors and connector-owned secrets > manages MCP definitions and credentials"
- Mode: run
- Given: A signed-in organization admin with storage writes accepted.
- When: The admin tries to create a manual MCP connector whose only header is a literal `X-Public-Mode`, creates a manual MCP connector with a required `secret` field, sets the secret via `PUT /api/custom-connectors/:id/values`, moves its endpoint to `/v2/server`, tries to convert it to an HTTP connector, renames it, and disconnects the default account.
- Then: The literal-only MCP create returns HTTP 400 "Manual custom connector injections must reference a declared secret or variable field". The MCP connector is created with its endpoint, `streamable-http` transport, no prefixes, no permission bundle and `storageVersion` 1, not ready until the secret is set; the secret is never visible. The endpoint move keeps the ID, `storageVersion` 1 and readiness. The HTTP conversion returns HTTP 400 "Custom connector protocol kind cannot be changed" and the connector remains MCP at the moved endpoint. The rename keeps the endpoint and version, and after disconnect the connector is not ready.

## connectors.bdd-083

- Vitest: "CONN-03: custom connectors and connector-owned secrets > rejects unsafe MCP endpoints and protected transport headers"
- Mode: run
- Given: A signed-in organization admin.
- When: The admin sends `POST /api/custom-connectors` for manual MCP connectors with unsafe endpoints (plain HTTP, user info, fragment, template host, `127.0.0.1`, `[::1]`, malformed port) and with protected headers (`Host`, `Content-Type`, `Last-Event-ID`, `MCP-Protocol-Version`, `X-Okou-Connector-Intent`); creates two connectors on a shared endpoint, one on a root endpoint, and one with a query string; and tries to convert an HTTP connector to MCP.
- Then: Each unsafe endpoint returns HTTP 400 and each protected header returns HTTP 400 mentioning "protected header". Both shared-endpoint MCP connectors are created; the root endpoint connector gets slug `_root-mcp-example-test-` plus six hex characters; the query endpoint is kept exactly, `manual`, not ready with `secret` missing. The HTTP-to-MCP update returns HTTP 400 "Custom connector protocol kind cannot be changed".

## connectors.bdd-084

- Vitest: "CONN-03: custom connectors and connector-owned secrets > does not activate a custom connector when skill publication fails"
- Mode: run
- Given: A signed-in organization admin; object storage rejects every upload.
- When: The admin sends `POST /api/custom-connectors` with a manual connector and skill markdown, then lists custom connectors.
- Then: The create returns HTTP 500 and no connector with that slug appears in the list.

## connectors.bdd-085

- Vitest: "CONN-03: custom connectors and connector-owned secrets > keeps the active definition and skill HEAD when an update upload fails"
- Mode: run
- Given: An organization admin who can run chat agents has a manual connector with skill markdown "Keep these active instructions." and a connected secret, and an agent run observes the published skill mount; object storage then rejects uploads.
- When: The admin sends `PUT /api/custom-connectors/:id` with a new name and new skill markdown; storage recovers; the admin reads the connector and another run observes the skill mount.
- Then: The update returns HTTP 500. The connector keeps its original display name and skill markdown, and the next run's skill mount has the same SHA-256 as before.

## connectors.bdd-086

- Vitest: "CONN-03: custom connectors and connector-owned secrets > does not let a stale skill update move the winning definition or HEAD"
- Mode: run
- Given: An organization admin who can run chat agents has a manual connector with skill markdown "Initial active instructions." and a connected secret; skill bundles are not yet in storage, and the upload of a stale writer's skill is held.
- When: The admin starts a `PUT /api/custom-connectors/:id` with "Stale writer instructions." (held during upload), then completes another update named "Winning Writer" with "Winning writer instructions.", a run observes the skill mount, and the stale upload is released.
- Then: The stale update returns HTTP 400 containing "changed while the definition was being saved". The winning skill mount's SHA-256 differs from the initial one; the connector shows "Winning Writer" with the winning markdown, and a later run still mounts the winning SHA-256.

## connectors.bdd-087

- Vitest: "CONN-03: custom connectors and connector-owned secrets > publishes exact skill versions and removes fresh mounts after clearing and deletion"
- Mode: run
- Given: An organization admin who can run chat agents creates a manual connector with permission bundle `builtin:slack@1` and skill markdown, and connects a secret.
- When: The admin updates the skill markdown, clears the permission bundle, tries to create another connector with `builtin:not-a-connector@1`, clears the skill markdown, restores the updated markdown, and deletes the connector, while chat runs observe the skill mount after each step.
- Then: The create and skill update echo the bundle and markdown, and the updated mount's SHA-256 differs from the original. Clearing the bundle returns `permissionBundleRef` null with the markdown kept. The unknown bundle create returns HTTP 400 containing "Unknown custom connector permission bundle". Clearing the skill returns null markdown and no skill mount; restoring it mounts the same SHA-256 as the updated version. After deletion no skill is mounted and the connector is absent from the list.

## connectors.bdd-088

- Vitest: "CONN-03: custom connectors and connector-owned secrets > allows an edited definition to share a prefix without changing identity"
- Mode: run
- Given: A signed-in organization admin has two manual HTTP custom connectors with different prefixes.
- When: The admin sends `PUT /api/custom-connectors/:id` for the second connector setting its prefix to the first connector's prefix without the trailing slash.
- Then: The update returns HTTP 200 with the second connector's unchanged ID and slug, and the list shows its prefix as the shared prefix without the trailing slash.

## connectors.bdd-089

- Vitest: "CONN-03: custom connectors and connector-owned secrets > publishes independent identities for concurrent equivalent prefixes"
- Mode: run
- Given: A signed-in organization admin.
- When: The admin concurrently sends two `POST /api/custom-connectors` requests whose prefixes differ only by a trailing slash.
- Then: Both return HTTP 201 with distinct IDs and distinct slugs, and each keeps its own prefix spelling.

## connectors.bdd-090

- Vitest: "CONN-03: custom connectors and connector-owned secrets > scopes custom connector deletion to org admins and same-org ids"
- Mode: run
- Given: An organization admin and a member of the same organization, and an admin of another organization; each admin owns a custom connector.
- When: The member sends `DELETE /api/custom-connectors/:id` for the first admin's connector; the first admin sends `DELETE` for the other organization's connector; then the other admin stores a secret on its connector and each admin deletes its own connector.
- Then: The member's delete returns HTTP 403 "Only org admins can delete custom connectors" and the connector remains with display name "Original". The cross-organization delete returns HTTP 404 `NOT_FOUND` and the foreign connector remains as "OtherOrg". Both owner deletes return HTTP 204, and the other organization's connector no longer appears in its organization's list.

## connectors.bdd-091

- Vitest: "CONN-03: custom connectors and connector-owned secrets > keeps custom connector secrets scoped per user and per organization"
- Mode: run
- Given: An organization admin and a member share a custom connector; the same admin user also belongs to another organization with its own custom connector.
- When: The admin sets a secret for a random connector ID; the member and then the admin set secrets on the shared connector via `PUT /api/custom-connectors/:id/values`; the admin rotates the secret with `intent: reconnect`; the admin in the other organization sets its secret; the admin then disconnects the shared connector's default account.
- Then: The unknown connector returns HTTP 404 "Custom connector not found". The member's secret connects only the member's account, not the admin's. After the admin's write and rotation the admin has exactly one connected account and neither the admin's nor the member's secret is visible in the list. The other organization's connector is connected for that identity. After the admin disconnects, the admin is not connected while the member and the other-organization connection stay connected; deleted connectors disappear from both lists.

## connectors.bdd-092

- Vitest: "CONN-02: OAuth callback validation and state claiming > rejects malformed and unclaimable callbacks through visible redirects"
- Mode: run
- Given: A signed-in member, with GitHub OAuth available at the provider.
- When: Callers hit `GET /api/connectors/:slug/callback` for an unknown slug, `cloudinary`, `test-oauth-device`, `github` with a never-stored state, and `github` without state; then the member starts GitHub OAuth, sends that state to the `linear` callback, and completes the `github` callback.
- Then: Each failure is an HTTP 307 redirect to `/connector/error` with the connector slug and message: "Unknown connector slug"; Cloudinary and test-oauth-device "does not use an auth-code grant"; "Invalid state - please try again" (with the three connector OAuth cookies cleared); "Missing state parameter"; and "Invalid state - please try again" for the cross-connector state. The GitHub callback redirects to `/connector/success` with `connectorSlug=github` and `username=bdd-github-user`, the member's GitHub account is connected via OAuth, and there is no Linear connection.

## connectors.bdd-093

- Vitest: "CONN-02: OAuth callback validation and state claiming > claims, preserves, and invalidates stored OAuth state across code-less, error, and expired callbacks"
- Mode: run
- Given: A signed-in member, with GitHub OAuth available at the provider.
- When: The member starts GitHub OAuth and calls `GET /api/connectors/github/callback` without a code, then with a code; starts again and returns without a code; starts again and returns `access_denied`; replays the consumed first state without a code and with a provider error; and finally starts OAuth and returns after the clock advances 15 minutes.
- Then: The code-less callback redirects to `/connector/error` with "Missing authorization code" and clears the OAuth cookies, yet the same state then succeeds and redirects to `/connector/success` with `username=bdd-github-user`. The later code-less and denied callbacks redirect with "Missing authorization code" and "Provider denied access" without changing the account. Replays of the consumed state and the expired callback redirect with "Invalid state - please try again", and the GitHub account remains identical to the one first connected.

## connectors.bdd-094

- Vitest: "CONN-02: OAuth callback validation and state claiming > routes callbacks through canonical and trusted web origins"
- Mode: run
- Given: Okou's web URL is `https://app.okou.test`.
- When: GitHub OAuth callbacks arrive at `GET /api/connectors/github/callback` on the API origin `https://api.okou.ai` (with code and state), on the API origin with header `x-okou-web-origin: https://www.okou.ai` and only a code, and on the web origin `https://app.okou.test` with only a code.
- Then: The canonical API-origin request returns HTTP 307 to `https://www.okou.ai/api/connectors/github/callback?code=code-123&state=state-123`. The trusted-header and web-origin requests each return HTTP 307 to `/connector/error` on `https://app.okou.test` for `github` with "Missing state parameter".

## connectors.bdd-095

- Vitest: "CONN-02: test-oauth auth-code journey > persists reported and normalized effective scopes through auth-code callbacks"
- Mode: run
- Given: A signed-in organization admin with the test OAuth connector feature switch enabled; the auth-code provider first grants scope "read provider-added" and later omits the scope.
- When: The admin starts `POST /api/connectors/test-oauth/oauth/start` and completes `GET /api/connectors/test-oauth/callback`, reads the account and its scope diff, then reconnects that account and completes the callback with the scope omitted.
- Then: The first callback redirects to `/connector/success` after one token exchange, and the account is connected with scopes `read` and `provider-added`; the scope diff shows current and stored scopes `read` with nothing added or removed. The reconnect authorization URL requests scope `read`, the callback succeeds after one token exchange, and the same account is connected with scopes `["read"]`.

## connectors.bdd-096

- Vitest: "CONN-02: test-oauth auth-code journey > replaces a manual-grant connection through the auth-code callback with method-scoped state cleanup"
- Mode: run
- Given: A signed-in member with the test OAuth connector feature switch enabled has a `test-oauth` connection made through the `api-token` manual grant; the auth-code provider is available.
- When: The member reconnects that connection with `POST /api/connectors/test-oauth/oauth/start` (auth method `oauth`) and completes the callback, then reconnects again with auth method `api` and completes that callback.
- Then: The authorization URL targets the local test provider's `/authorize` with client `test-oauth-client`. The callback redirects to `/connector/success` with `connectorSlug=test-oauth` and `username=bdd-test-oauth`; the provider receives one `authorization_code` exchange with the client ID, client secret, code, and redirect URI `https://api.okou.ai/api/connectors/test-oauth/callback`. The account is now OAuth with the provider's ID, username, email and scope `read`, no visible manual or access tokens, and an unchanged scope diff of `read`. The `api` reconnect exchanges one token and the account's auth method becomes `api`, without exposing that token.

## connectors.bdd-097

- Vitest: "CONN-02: test-oauth auth-code journey > rolls back failed OAuth-to-manual credential replacement before a successful retry"
- Mode: run
- Given: A signed-in user who can run chat agents, with the test OAuth connector feature switch enabled, connected `test-oauth` through the `api-token` manual grant and then reconnected it through OAuth; a running chat run claims the account's `TEST_OAUTH_TOKEN` secret.
- When: The run's sandbox resolves the token through `POST /api/webhooks/run/firewall/auth`; the user reconnects the account with a manual grant whose input variable contains a NUL character, then with a valid manual grant; the live run resolves the new `TEST_OAUTH_API_TOKEN` alias, and a new run resolves both aliases.
- Then: The OAuth account keeps the same ID with external ID `bdd-test-oauth-user` and scope `read`, and the firewall returns `Bearer bdd-test-oauth-access-token`. The failing grant returns HTTP 500, the account is unchanged, and the firewall response is identical. The valid grant keeps the ID with `api-token` and null external identity, scopes and expiry. The live run's alias source points to that account and both runs resolve `Bearer fresh-test-oauth-api-token:bdd-successful-replacement-token:bdd-successful-replacement-input` for both aliases; the new run's environment carries the placeholder tokens and tenant `bdd-successful-replacement-tenant`.

## connectors.bdd-098

- Vitest: "CONN-02: test-oauth auth-code journey > stores token expiry variants and surfaces provider failures"
- Mode: run
- Given: A signed-in user who can run chat agents, with the test OAuth connector feature switch enabled; the auth-code provider returns tokens expiring in 7200 seconds, then tokens without an expiry; Slack OAuth is available; later the provider fails the token exchange, then fails the user-info lookup, and finally returns a different user.
- When: The user connects `test-oauth` through `POST /api/connectors/test-oauth/oauth/start` and the callback, reconnects it without expiry, has a running chat run resolve `TEST_OAUTH_TOKEN` through `POST /api/webhooks/run/firewall/auth`, connects Slack, attempts two failing reconnects, and then starts a fresh (non-reconnect) authorization for the different user.
- Then: The first token expiry is stored 7200 seconds after the callback, and the reconnect keeps the same account with a default expiry 15 minutes ahead; the run resolves `Bearer bdd-test-oauth-access-token`. Slack is connected as `U012AB3CD` / "BDD Slack User" with no token expiry and no visible token. Both failing reconnects redirect to `/connector/error` with "OAuth authorization failed. Please try again." (the token failure also clears the OAuth cookies), leaving the account and the run's resolved credential unchanged. The fresh authorization adds a separate account with the replacement user's ID, username and email.

## connectors.bdd-099

- Vitest: "CONN-02: device-auth method switching > switches device-auth methods without deleting the connector"
- Mode: run
- Given: A signed-in member with the test OAuth connector feature switch enabled and a device provider that completes immediately.
- When: The member completes a `test-oauth-device` device session with auth method `api`, then reconnects that connection with a device session using auth method `oauth` and polls it.
- Then: The first poll completes with auth method `api`, the reconnect completes with `oauth`, and the default account keeps the original connection ID with auth method `oauth`.

## connectors.bdd-100

- Vitest: "CONN-02: GitHub installation link after connector OAuth > links the org GitHub installation when the GitHub connector completes OAuth"
- Mode: run
- Given: An organization admin installed the GitHub App for the organization through the public install and setup routes; GitHub OAuth is available at the provider.
- When: The admin reads `GET /api/integrations/github`, starts `POST /api/connectors/github/oauth/start`, completes `GET /api/connectors/github/callback`, and reads the integration again.
- Then: Before linking, the installation is active for organization `bdd-github-org` with admin access and is not connected to a GitHub user. The callback redirects to `/connector/success`; afterward the integration is connected to GitHub user ID `42` / `bdd-github-user`, and a realtime `github:changed` event is published.
