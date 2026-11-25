# connectors-automatic

## connectors-automatic-001

- Vitest: "builtin MCP automatic authentication > returns a native Automatic OAuth attempt after consent or refusal (denied=false)"
- Mode: run
- Given: A signed-in workspace member uses the builtin `automatic-mcp-oauth` connector with its `smart-connect` method. The MCP server challenges for OAuth and its authorization server supports CIMD clients. The member consents at the provider (denied=false).
- When: The member starts `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add` and `nativeCallback: ios-https`, then the provider returns to `GET /api/connectors/automatic/callback` with the state, the issuer and an authorization code, and the callback is replayed afterwards.
- Then: The start response has `nativeCallbackUrl` `https://app.okou.ai/native/connector-authorization?attemptId=<oauthAttemptId>`. The callback returns status `success` with `nativeAppReturn` `{ platform: ios, attemptId, httpsHost: app.okou.ai }`, and `GET /api/connector-accounts/oauth-completions/:attemptId` returns HTTP 200. The replayed callback carries no `nativeAppReturn`.

## connectors-automatic-002

- Vitest: "builtin MCP automatic authentication > returns a native Automatic OAuth attempt after consent or refusal (denied=true)"
- Mode: run
- Given: A signed-in workspace member uses the builtin `automatic-mcp-oauth` connector with its `smart-connect` method. The MCP server challenges for OAuth and its authorization server supports CIMD clients. The member refuses consent at the provider (denied=true).
- When: The member starts `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add` and `nativeCallback: ios-https`, then the provider returns to `GET /api/connectors/automatic/callback` with the state, the issuer and `error=access_denied`, and a code callback for the same state is sent afterwards.
- Then: The start response has `nativeCallbackUrl` `https://app.okou.ai/native/connector-authorization?attemptId=<oauthAttemptId>`. The refusal callback returns status `error` with `nativeAppReturn` `{ platform: ios, attemptId, httpsHost: app.okou.ai }`, and `GET /api/connector-accounts/oauth-completions/:attemptId` returns HTTP 404. The later callback carries no `nativeAppReturn`.

## connectors-automatic-003

- Vitest: "builtin MCP automatic authentication > preserves a builtin endpoint query through cimd OAuth and account creation"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-query` connector whose catalog MCP endpoint includes a query string. The MCP server challenges for OAuth and the authorization server supports CIMD clients.
- When: The member starts `POST /api/connectors/automatic-mcp-query/automatic/start` with intent `add`, completes `GET /api/connectors/automatic/callback` with a code and the issuer, then reads the completion receipt and `GET /api/connector-accounts/:connectionId`.
- Then: The authorization URL has `resource` equal to the full endpoint including its query and `redirect_uri` `https://api.okou.ai/api/connectors/automatic/callback`. Every MCP endpoint request targets exactly that endpoint URL. The callback succeeds, the receipt returns HTTP 200, the account is `connected` with method `smart-connect`, and the token request sends the full endpoint as `resource`.

## connectors-automatic-004

- Vitest: "builtin MCP automatic authentication > preserves a builtin endpoint query through dcr OAuth and account creation"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-query` connector whose catalog MCP endpoint includes a query string. The MCP server challenges for OAuth and the authorization server supports dynamic client registration (DCR).
- When: The member starts `POST /api/connectors/automatic-mcp-query/automatic/start` with intent `add`, completes `GET /api/connectors/automatic/callback` with a code and the issuer, then reads the completion receipt and `GET /api/connector-accounts/:connectionId`.
- Then: The authorization URL has `resource` equal to the full endpoint including its query and `redirect_uri` `https://api.okou.ai/api/connectors/automatic/callback`. Every MCP endpoint request targets exactly that endpoint URL. The callback succeeds, the receipt returns HTTP 200, the account is `connected` with method `smart-connect`, and the token request sends the full endpoint as `resource`.

## connectors-automatic-005

- Vitest: "builtin MCP automatic authentication > uses cimd declared-scopes authorization policy on connection and exact-account reconnect"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-declared-scopes` connector, whose catalog declares scopes `read` and `write`, with CIMD registration. The MCP challenge carries no scope, resource metadata advertises `openid`, the authorization server supports `openid read write admin offline_access`, and both code exchanges grant `openid read write offline_access`.
- When: The member starts `POST /api/connectors/automatic-mcp-declared-scopes/automatic/start` with intent `add` and completes the callback, then starts again with intent `reconnect` for the new connection and completes that callback.
- Then: Both authorization URLs request scope `openid read write offline_access` with `prompt=consent`, the fixed callback `redirect_uri`, `resource` equal to the endpoint, `response_type=code`, `code_challenge_method=S256`, a 43-character code challenge and the attempt state. Both callbacks succeed, the reconnect receipt equals the original receipt, and the account reports `oauthScopes` `[openid, read, write, offline_access]`.

## connectors-automatic-006

- Vitest: "builtin MCP automatic authentication > uses cimd provider-prompt authorization policy on connection and exact-account reconnect"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-provider-prompt` connector, whose catalog declares scopes `read` and `write` and leaves the prompt to the provider, with CIMD registration. The MCP challenge carries no scope, resource metadata advertises `openid`, the authorization server supports `openid read write admin offline_access`, and both code exchanges grant `openid read write offline_access`.
- When: The member starts `POST /api/connectors/automatic-mcp-provider-prompt/automatic/start` with intent `add` and completes the callback, then starts again with intent `reconnect` for the new connection and completes that callback.
- Then: Both authorization URLs request scope `openid read write offline_access` with no `prompt` parameter, the fixed callback `redirect_uri`, `resource` equal to the endpoint, `response_type=code`, `code_challenge_method=S256`, a 43-character code challenge and the attempt state. Both callbacks succeed, the reconnect receipt equals the original receipt, and the account reports `oauthScopes` `[openid, read, write, offline_access]`.

## connectors-automatic-007

- Vitest: "builtin MCP automatic authentication > uses cimd explicit-prompt authorization policy on connection and exact-account reconnect"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-explicit-prompt` connector, whose catalog declares scopes `read` and `write` and prompt `login consent`, with CIMD registration. The MCP challenge carries no scope, resource metadata advertises `openid`, the authorization server supports `openid read write admin offline_access`, and both code exchanges grant `openid read write offline_access`.
- When: The member starts `POST /api/connectors/automatic-mcp-explicit-prompt/automatic/start` with intent `add` and completes the callback, then starts again with intent `reconnect` for the new connection and completes that callback.
- Then: Both authorization URLs request scope `openid read write offline_access` with `prompt=login consent`, the fixed callback `redirect_uri`, `resource` equal to the endpoint, `response_type=code`, `code_challenge_method=S256`, a 43-character code challenge and the attempt state. Both callbacks succeed, the reconnect receipt equals the original receipt, and the account reports `oauthScopes` `[openid, read, write, offline_access]`.

## connectors-automatic-008

- Vitest: "builtin MCP automatic authentication > uses dcr declared-scopes authorization policy on connection and exact-account reconnect"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-declared-scopes` connector, whose catalog declares scopes `read` and `write`, with dynamic client registration. The MCP challenge carries no scope, resource metadata advertises `openid`, the authorization server supports `openid read write admin offline_access`, and both code exchanges grant `openid read write offline_access`.
- When: The member starts `POST /api/connectors/automatic-mcp-declared-scopes/automatic/start` with intent `add` and completes the callback, then starts again with intent `reconnect` for the new connection and completes that callback.
- Then: Both authorization URLs request scope `openid read write offline_access` with `prompt=consent`, the fixed callback `redirect_uri`, `resource` equal to the endpoint, `response_type=code`, `code_challenge_method=S256`, a 43-character code challenge and the attempt state. Both callbacks succeed, the reconnect receipt equals the original receipt, and the account reports `oauthScopes` `[openid, read, write, offline_access]`. The provider receives exactly one client registration, with that scope.

## connectors-automatic-009

- Vitest: "builtin MCP automatic authentication > uses dcr provider-prompt authorization policy on connection and exact-account reconnect"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-provider-prompt` connector, whose catalog declares scopes `read` and `write` and leaves the prompt to the provider, with dynamic client registration. The MCP challenge carries no scope, resource metadata advertises `openid`, the authorization server supports `openid read write admin offline_access`, and both code exchanges grant `openid read write offline_access`.
- When: The member starts `POST /api/connectors/automatic-mcp-provider-prompt/automatic/start` with intent `add` and completes the callback, then starts again with intent `reconnect` for the new connection and completes that callback.
- Then: Both authorization URLs request scope `openid read write offline_access` with no `prompt` parameter, the fixed callback `redirect_uri`, `resource` equal to the endpoint, `response_type=code`, `code_challenge_method=S256`, a 43-character code challenge and the attempt state. Both callbacks succeed, the reconnect receipt equals the original receipt, and the account reports `oauthScopes` `[openid, read, write, offline_access]`. The provider receives exactly one client registration, with that scope.

## connectors-automatic-010

- Vitest: "builtin MCP automatic authentication > uses dcr explicit-prompt authorization policy on connection and exact-account reconnect"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-explicit-prompt` connector, whose catalog declares scopes `read` and `write` and prompt `login consent`, with dynamic client registration. The MCP challenge carries no scope, resource metadata advertises `openid`, the authorization server supports `openid read write admin offline_access`, and both code exchanges grant `openid read write offline_access`.
- When: The member starts `POST /api/connectors/automatic-mcp-explicit-prompt/automatic/start` with intent `add` and completes the callback, then starts again with intent `reconnect` for the new connection and completes that callback.
- Then: Both authorization URLs request scope `openid read write offline_access` with `prompt=login consent`, the fixed callback `redirect_uri`, `resource` equal to the endpoint, `response_type=code`, `code_challenge_method=S256`, a 43-character code challenge and the attempt state. Both callbacks succeed, the reconnect receipt equals the original receipt, and the account reports `oauthScopes` `[openid, read, write, offline_access]`. The provider receives exactly one client registration, with that scope.

## connectors-automatic-011

- Vitest: "builtin MCP automatic authentication > uses cimd OAuth for mixed public and protected tools"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-declared-scopes` connector with CIMD registration. The MCP server initializes without a challenge (mixed public and protected tools) but advertises OAuth; resource metadata lists `openid` and the authorization server supports `openid read write offline_access`, which the code exchange grants.
- When: The member starts `POST /api/connectors/automatic-mcp-declared-scopes/automatic/start` with intent `add`, completes `GET /api/connectors/automatic/callback`, and reads the receipt and the account.
- Then: The start returns an authorization handoff whose URL requests scope `openid read write offline_access`, the fixed callback `redirect_uri` and `code_challenge_method=S256`. The callback succeeds, the receipt returns HTTP 200, and the account is `connected` with `oauthScopes` `[openid, read, write, offline_access]`.

## connectors-automatic-012

- Vitest: "builtin MCP automatic authentication > uses dcr OAuth for mixed public and protected tools"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-declared-scopes` connector with dynamic client registration. The MCP server initializes without a challenge (mixed public and protected tools) but advertises OAuth; resource metadata lists `openid` and the authorization server supports `openid read write offline_access`, which the code exchange grants.
- When: The member starts `POST /api/connectors/automatic-mcp-declared-scopes/automatic/start` with intent `add`, completes `GET /api/connectors/automatic/callback`, and reads the receipt and the account.
- Then: The start returns an authorization handoff whose URL requests scope `openid read write offline_access`, the fixed callback `redirect_uri` and `code_challenge_method=S256`. The callback succeeds, the receipt returns HTTP 200, and the account is `connected` with `oauthScopes` `[openid, read, write, offline_access]`.

## connectors-automatic-013

- Vitest: "builtin MCP automatic authentication > connects and reconnects accepted no-auth with its exact catalog method"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector, and the MCP server accepts requests without authentication and publishes no OAuth metadata.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`, reads `GET /api/connector-accounts/:connectionId`, then calls the start route again with intent `reconnect` for that connection.
- Then: The add returns exactly `{ result: connected, connectionId }` without an authorization handoff. The account has `authMethod` `smart-connect`, status `connected`, `tokenExpiresAt` null and `reconnectReason` null. The reconnect returns the identical `connected` body for the same connection.

## connectors-automatic-014

- Vitest: "builtin MCP automatic authentication > upgrades a public account only after explicit mixed OAuth reconnect and consent"
- Mode: run
- Given: A signed-in member has a public (no-auth) `automatic-mcp-oauth` account. The MCP server then starts advertising OAuth for mixed public and protected tools with CIMD registration, resource metadata scope `read`, and a code exchange that grants `read`.
- When: The member starts `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `reconnect` for that account, reads the account before the callback, then completes `GET /api/connectors/automatic/callback` and reads the receipt and the account.
- Then: The account is unchanged while the authorization is pending. After the callback succeeds, the receipt returns HTTP 200 with the same connection ID, and the account is `connected` with `oauthScopes` `[read]`.

## connectors-automatic-015

- Vitest: "builtin MCP automatic authentication > preserves an OAuth account when reconnect metadata is unavailable"
- Mode: run
- Given: A signed-in member has an OAuth-connected `automatic-mcp-oauth` account created through CIMD OAuth on a mixed public/protected MCP server. The server's protected-resource metadata then returns HTTP 503.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `reconnect` for that account.
- Then: The start returns HTTP 503, and `GET /api/connector-accounts/:connectionId` returns exactly the same account as before the reconnect attempt.

## connectors-automatic-016

- Vitest: "builtin MCP automatic authentication > preserves OAuth accepted while an anonymous reconnect was discovering metadata"
- Mode: run
- Given: A signed-in member has a public (no-auth) `automatic-mcp-oauth` account. A reconnect request is in flight and blocked while it fetches protected-resource metadata, which will eventually return HTTP 503. Meanwhile the MCP server starts advertising OAuth for mixed tools with CIMD registration.
- When: While the first reconnect is blocked, the member starts a second `POST /api/connectors/automatic-mcp-oauth/automatic/start` reconnect for the same account and completes its OAuth callback; then the stalled metadata request is released.
- Then: After the OAuth callback the account reports `oauthScopes` `[read, write]`. The stalled reconnect finishes with HTTP 409, and the account read afterwards is identical to the upgraded OAuth account.

## connectors-automatic-017

- Vitest: "builtin MCP automatic authentication > requires OAuth metadata for declared scopes even when initialization is public"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-declared-scopes` connector. The MCP server initializes publicly for mixed tools with CIMD registration, but its protected-resource metadata returns HTTP 404.
- When: The member calls `POST /api/connectors/automatic-mcp-declared-scopes/automatic/start` with intent `add`.
- Then: The start returns HTTP 409 and `GET /api/connector-accounts/connections` for the connector lists no connections.

## connectors-automatic-018

- Vitest: "builtin MCP automatic authentication > keeps public access when optional metadata returns 403 Forbidden"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector whose MCP server accepts unauthenticated requests, and its optional protected-resource metadata returns HTTP 403 Forbidden.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add` and reads the new account.
- Then: The start returns `result: connected` with a connection ID, and the account is `connected` with `oauthScopes` null.

## connectors-automatic-019

- Vitest: "builtin MCP automatic authentication > keeps public access when optional metadata returns 405 Method Not Allowed"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector whose MCP server accepts unauthenticated requests, and its optional protected-resource metadata returns HTTP 405 Method Not Allowed.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add` and reads the new account.
- Then: The start returns `result: connected` with a connection ID, and the account is `connected` with `oauthScopes` null.

## connectors-automatic-020

- Vitest: "builtin MCP automatic authentication > keeps public access when optional metadata returns 503 Service Unavailable"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector whose MCP server accepts unauthenticated requests, and its optional protected-resource metadata returns HTTP 503 Service Unavailable.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add` and reads the new account.
- Then: The start returns `result: connected` with a connection ID, and the account is `connected` with `oauthScopes` null.

## connectors-automatic-021

- Vitest: "builtin MCP automatic authentication > keeps public access when optional metadata returns an HTML page"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector whose MCP server accepts unauthenticated requests, and its optional protected-resource metadata URL returns an HTTP 200 HTML page.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add` and reads the new account.
- Then: The start returns `result: connected` with a connection ID, and the account is `connected` with `oauthScopes` null.

## connectors-automatic-022

- Vitest: "builtin MCP automatic authentication > keeps public access when optional metadata returns unrelated JSON"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector whose MCP server accepts unauthenticated requests, and its optional protected-resource metadata URL returns unrelated JSON `{ status: ok }`.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add` and reads the new account.
- Then: The start returns `result: connected` with a connection ID, and the account is `connected` with `oauthScopes` null.

## connectors-automatic-023

- Vitest: "builtin MCP automatic authentication > keeps public access when optional metadata returns no OAuth authority"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector whose MCP server accepts unauthenticated requests, and its optional protected-resource metadata names the endpoint as resource but lists no authorization server.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add` and reads the new account.
- Then: The start returns `result: connected` with a connection ID, and the account is `connected` with `oauthScopes` null.

## connectors-automatic-024

- Vitest: "builtin MCP automatic authentication > rejects required OAuth discovery failure after public initialization"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-declared-scopes` connector. The MCP server initializes publicly for mixed tools with CIMD registration, but its protected-resource metadata returns HTTP 503.
- When: The member calls `POST /api/connectors/automatic-mcp-declared-scopes/automatic/start` with intent `add`.
- Then: The start returns HTTP 503 and the connector's connection list is empty.

## connectors-automatic-025

- Vitest: "builtin MCP automatic authentication > rejects foreign resource metadata after public initialization"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector. The MCP server initializes publicly for mixed tools with CIMD registration, but its protected-resource metadata names a foreign resource `https://foreign-mcp.example.test/`.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`.
- Then: The start returns HTTP 409 and the connector's connection list is empty.

## connectors-automatic-026

- Vitest: "builtin MCP automatic authentication > handles optional discovery network failure for oauth"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector (no declared scopes). The MCP server initializes publicly for mixed tools, and the request for its protected-resource metadata fails with a network error.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`.
- Then: The start returns HTTP 200 with `result: connected`, and the connection list holds one account with status `connected` and `oauthScopes` null.

## connectors-automatic-027

- Vitest: "builtin MCP automatic authentication > handles optional discovery network failure for declared-scopes"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-declared-scopes` connector. The MCP server initializes publicly for mixed tools, and the request for its protected-resource metadata fails with a network error.
- When: The member calls `POST /api/connectors/automatic-mcp-declared-scopes/automatic/start` with intent `add`.
- Then: The start returns HTTP 409 and the connector's connection list is empty.

## connectors-automatic-028

- Vitest: "builtin MCP automatic authentication > requires OAuth after a challenge even when resource discovery is unavailable"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector. The MCP server answers with an OAuth challenge and its protected-resource metadata returns HTTP 503.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`.
- Then: The start returns HTTP 503 and the connector's connection list is empty.

## connectors-automatic-029

- Vitest: "builtin MCP automatic authentication > bounds stalled optional metadata without losing OAuth (reconnect: false)"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector whose MCP server accepts unauthenticated requests, has no existing account, and the optional protected-resource metadata request stalls (reconnect: false).
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`, and the 5-second metadata deadline expires while the metadata request is still pending.
- Then: The start returns HTTP 200, and the connection list holds one account with status `connected` and `oauthScopes` null.

## connectors-automatic-030

- Vitest: "builtin MCP automatic authentication > bounds stalled optional metadata without losing OAuth (reconnect: true)"
- Mode: run
- Given: A signed-in member has an OAuth-connected `automatic-mcp-oauth` account created through CIMD OAuth on a mixed public/protected MCP server, and the protected-resource metadata request then stalls (reconnect: true).
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `reconnect` for that account, and the 5-second metadata deadline expires while the metadata request is still pending.
- Then: The start returns HTTP 503, and `GET /api/connector-accounts/connections` returns exactly the same body as before the attempt.

## connectors-automatic-031

- Vitest: "builtin MCP automatic authentication > rejects unsafe optional metadata redirects after public initialization"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector whose MCP server accepts unauthenticated requests, and its protected-resource metadata responds with a 302 redirect to the insecure URL `http://metadata.example.test/metadata`.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`.
- Then: The start returns HTTP 400 and the connector's connection list is empty.

## connectors-automatic-032

- Vitest: "builtin MCP automatic authentication > does not downgrade an advertised OAuth authority when AS discovery fails"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector. The MCP server initializes publicly for mixed tools and advertises an OAuth authorization server, but both the authorization-server and OpenID configuration discovery documents return HTTP 503.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`.
- Then: The start returns HTTP 503 and the connector's connection list is empty.

## connectors-automatic-033

- Vitest: "builtin MCP automatic authentication > publishes two concurrent no-auth accounts with exactly one default"
- Mode: run
- Given: A signed-in member with no accounts uses the builtin `automatic-mcp-oauth` connector whose MCP server accepts unauthenticated requests.
- When: The member sends two concurrent `POST /api/connectors/automatic-mcp-oauth/automatic/start` requests with intent `add`.
- Then: Both return `result: connected` with two distinct connection IDs. `GET /api/connector-accounts/connections` lists exactly those two accounts, exactly one is the default, and both have `authMethod` `smart-connect` and status `connected`.

## connectors-automatic-034

- Vitest: "builtin MCP automatic authentication > rejects discovery metadata whose issuer differs from the requested issuer"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector whose MCP server challenges for OAuth with CIMD registration, but the authorization-server metadata reports issuer `https://different-issuer.example.test` instead of the requested issuer.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`.
- Then: The start returns HTTP 409, the provider receives no token request, and the connector's connection list is empty.

## connectors-automatic-035

- Vitest: "builtin MCP automatic authentication > completes parent-resource CIMD OAuth through the fixed callback and exact receipt"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector whose MCP server challenges for OAuth with CIMD registration, and whose protected-resource metadata names the endpoint's parent origin as the resource.
- When: The member starts `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`, reads the receipt before and after `GET /api/connectors/automatic/callback`, reads the account, replays the callback, and finally reads the receipt as another user in the same organization.
- Then: The authorization URL uses the origin as `resource`, the fixed callback `redirect_uri` and S256. The receipt returns HTTP 404 before the callback; the callback returns exactly `{ status: success, username: null }` and the receipt then returns HTTP 200. The account is `connected` with `smart-connect`, null external ID, username and email, and `oauthScopes` `[read, write]`. The token request sends the fixed `redirect_uri` and the origin `resource`. The replayed callback returns `error`, and the other user's receipt read returns HTTP 404.

## connectors-automatic-036

- Vitest: "builtin MCP automatic authentication > notifies account readers when OAuth completes an account"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector whose MCP server challenges for OAuth with CIMD registration.
- When: The member starts `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add` and the provider completes `GET /api/connectors/automatic/callback` with a code.
- Then: The callback returns exactly `{ status: success, username: null }`. A realtime `connector:changed` event with `{ connectorSlug }` is published on the member's `user:<userId>` channel. The connection list has one `connected` `smart-connect` account, and the receipt returns HTTP 200 with that account's ID.

## connectors-automatic-037

- Vitest: "builtin MCP automatic authentication > persists a verified OIDC identity without expanding scopes"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with CIMD OAuth. The provider supports OpenID identity: the ID token has subject `automatic-user-123` with token username and email, and userinfo returns username `userinfo-user` and email `userinfo-user@example.test`.
- When: The member starts `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`, completes the callback, and reads the account.
- Then: The authorization URL requests scope `read write` only (no `openid` added). The callback succeeds and the account has `externalId` `automatic-user-123`, `externalUsername` `userinfo-user` and `externalEmail` `userinfo-user@example.test`.

## connectors-automatic-038

- Vitest: "builtin MCP automatic authentication > keeps verified identity when an optional ID-token label is oversized"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with CIMD OAuth. The provider's valid ID token has subject `automatic-bounded-label-user`, a 256-character username and email `bounded-label-user@example.test`.
- When: The member starts `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`, completes the callback, and reads the account.
- Then: The callback succeeds and the account has `externalId` `automatic-bounded-label-user`, with both `externalUsername` and `externalEmail` set to `bounded-label-user@example.test`.

## connectors-automatic-039

- Vitest: "builtin MCP automatic authentication > keeps a successful connection unnamed for a future-issued ID token"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with CIMD OAuth, and the provider's ID token is issued 300 seconds in the future.
- When: The member starts `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`, completes the callback, and reads the account.
- Then: The callback succeeds and the account has null `externalId`, `externalUsername` and `externalEmail`.

## connectors-automatic-040

- Vitest: "builtin MCP automatic authentication > keeps a successful connection unnamed when its ID token is invalid"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with CIMD OAuth, and the provider returns an invalid ID token claiming subject `untrusted-user` with a username and email.
- When: The member starts `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`, completes the callback, and reads the account.
- Then: The callback succeeds and the account has null `externalId`, `externalUsername` and `externalEmail`.

## connectors-automatic-041

- Vitest: "builtin MCP automatic authentication > connects and reuses a public-only DCR client with a long opaque ID and issuer binding"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration. The provider issues a client ID over 1,000 characters long. Row public-only: discovery advertises `[none]` and the registration returns method `none`.
- When: The member starts an add attempt and sends its callback with a foreign issuer `https://other.example.test`, then starts another add attempt and completes it with the real issuer, then reconnects that account and completes the callback.
- Then: The foreign-issuer callback returns `error` and its receipt returns HTTP 404. The second callback succeeds, the reconnect callback succeeds and its receipt equals the original receipt. The provider receives exactly one registration, requesting `token_endpoint_auth_method` `none`.

## connectors-automatic-042

- Vitest: "builtin MCP automatic authentication > connects and reuses a public with an unsupported alternative DCR client with a long opaque ID and issuer binding"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration. The provider issues a client ID over 1,000 characters long. Row public with an unsupported alternative: discovery advertises `[private_key_jwt, none]` and the registration returns method `none`.
- When: The member starts an add attempt and sends its callback with a foreign issuer `https://other.example.test`, then starts another add attempt and completes it with the real issuer, then reconnects that account and completes the callback.
- Then: The foreign-issuer callback returns `error` and its receipt returns HTTP 404. The second callback succeeds, the reconnect callback succeeds and its receipt equals the original receipt. The provider receives exactly one registration, requesting `token_endpoint_auth_method` `none`.

## connectors-automatic-043

- Vitest: "builtin MCP automatic authentication > connects and reuses a public and confidential basic DCR client with a long opaque ID and issuer binding"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration. The provider issues a client ID over 1,000 characters long. Row public and confidential basic: discovery advertises `[none, client_secret_basic]` and the registration returns method `client_secret_basic`.
- When: The member starts an add attempt and sends its callback with a foreign issuer `https://other.example.test`, then starts another add attempt and completes it with the real issuer, then reconnects that account and completes the callback.
- Then: The foreign-issuer callback returns `error` and its receipt returns HTTP 404. The second callback succeeds, the reconnect callback succeeds and its receipt equals the original receipt. The provider receives exactly one registration, requesting `token_endpoint_auth_method` `client_secret_basic`.

## connectors-automatic-044

- Vitest: "builtin MCP automatic authentication > connects and reuses a public and confidential post DCR client with a long opaque ID and issuer binding"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration. The provider issues a client ID over 1,000 characters long. Row public and confidential post: discovery advertises `[none, client_secret_post]` and the registration returns method `client_secret_post`.
- When: The member starts an add attempt and sends its callback with a foreign issuer `https://other.example.test`, then starts another add attempt and completes it with the real issuer, then reconnects that account and completes the callback.
- Then: The foreign-issuer callback returns `error` and its receipt returns HTTP 404. The second callback succeeds, the reconnect callback succeeds and its receipt equals the original receipt. The provider receives exactly one registration, requesting `token_endpoint_auth_method` `client_secret_post`.

## connectors-automatic-045

- Vitest: "builtin MCP automatic authentication > connects and reuses a all implemented methods in reverse pref… DCR client with a long opaque ID and issuer binding"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration. The provider issues a client ID over 1,000 characters long. Row all implemented methods in reverse preference order: discovery advertises `[none, client_secret_post, client_secret_basic]` and the registration returns method `client_secret_basic`.
- When: The member starts an add attempt and sends its callback with a foreign issuer `https://other.example.test`, then starts another add attempt and completes it with the real issuer, then reconnects that account and completes the callback.
- Then: The foreign-issuer callback returns `error` and its receipt returns HTTP 404. The second callback succeeds, the reconnect callback succeeds and its receipt equals the original receipt. The provider receives exactly one registration, requesting `token_endpoint_auth_method` `client_secret_basic`.

## connectors-automatic-046

- Vitest: "builtin MCP automatic authentication > connects and reuses a provider-selected public authentication DCR client with a long opaque ID and issuer binding"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration. The provider issues a client ID over 1,000 characters long. Row provider-selected public authentication: discovery advertises `[client_secret_basic, none]` and the provider registers the client with method `none`.
- When: The member starts an add attempt and sends its callback with a foreign issuer `https://other.example.test`, then starts another add attempt and completes it with the real issuer, then reconnects that account and completes the callback.
- Then: The foreign-issuer callback returns `error` and its receipt returns HTTP 404. The second callback succeeds, the reconnect callback succeeds and its receipt equals the original receipt. The provider receives exactly one registration, requesting `token_endpoint_auth_method` `client_secret_basic`.

## connectors-automatic-047

- Vitest: "builtin MCP automatic authentication > connects and reuses a provider-selected confidential post aut… DCR client with a long opaque ID and issuer binding"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration. The provider issues a client ID over 1,000 characters long. Row provider-selected confidential post authentication: discovery advertises `[client_secret_basic, client_secret_post]` and the provider registers the client with method `client_secret_post`.
- When: The member starts an add attempt and sends its callback with a foreign issuer `https://other.example.test`, then starts another add attempt and completes it with the real issuer, then reconnects that account and completes the callback.
- Then: The foreign-issuer callback returns `error` and its receipt returns HTTP 404. The second callback succeeds, the reconnect callback succeeds and its receipt equals the original receipt. The provider receives exactly one registration, requesting `token_endpoint_auth_method` `client_secret_basic`.

## connectors-automatic-048

- Vitest: "builtin MCP automatic authentication > connects and reuses a provider-selected public authentication… DCR client with a long opaque ID and issuer binding"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration. The provider issues a client ID over 1,000 characters long. Row provider-selected public authentication omitted from discovery: discovery advertises `[client_secret_basic, client_secret_post]` and the provider registers the client with method `none`.
- When: The member starts an add attempt and sends its callback with a foreign issuer `https://other.example.test`, then starts another add attempt and completes it with the real issuer, then reconnects that account and completes the callback.
- Then: The foreign-issuer callback returns `error` and its receipt returns HTTP 404. The second callback succeeds, the reconnect callback succeeds and its receipt equals the original receipt. The provider receives exactly one registration, requesting `token_endpoint_auth_method` `client_secret_basic`.

## connectors-automatic-049

- Vitest: "builtin MCP automatic authentication > connects and reuses a provider-selected confidential post omi… DCR client with a long opaque ID and issuer binding"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration. The provider issues a client ID over 1,000 characters long. Row provider-selected confidential post omitted from discovery: discovery advertises `[client_secret_basic]` and the provider registers the client with method `client_secret_post`.
- When: The member starts an add attempt and sends its callback with a foreign issuer `https://other.example.test`, then starts another add attempt and completes it with the real issuer, then reconnects that account and completes the callback.
- Then: The foreign-issuer callback returns `error` and its receipt returns HTTP 404. The second callback succeeds, the reconnect callback succeeds and its receipt equals the original receipt. The provider receives exactly one registration, requesting `token_endpoint_auth_method` `client_secret_basic`.

## connectors-automatic-050

- Vitest: "builtin MCP automatic authentication > connects and reuses a provider-selected confidential basic om… DCR client with a long opaque ID and issuer binding"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration. The provider issues a client ID over 1,000 characters long. Row provider-selected confidential basic omitted from discovery: discovery advertises `[client_secret_post]` and the provider registers the client with method `client_secret_basic`.
- When: The member starts an add attempt and sends its callback with a foreign issuer `https://other.example.test`, then starts another add attempt and completes it with the real issuer, then reconnects that account and completes the callback.
- Then: The foreign-issuer callback returns `error` and its receipt returns HTTP 404. The second callback succeeds, the reconnect callback succeeds and its receipt equals the original receipt. The provider receives exactly one registration, requesting `token_endpoint_auth_method` `client_secret_post`.

## connectors-automatic-051

- Vitest: "builtin MCP automatic authentication > connects and reuses a unspecified authentication DCR client with a long opaque ID and issuer binding"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration. The provider issues a client ID over 1,000 characters long. Row unspecified authentication: discovery advertises no token endpoint authentication methods and the provider registers the client with method `client_secret_basic`.
- When: The member starts an add attempt and sends its callback with a foreign issuer `https://other.example.test`, then starts another add attempt and completes it with the real issuer, then reconnects that account and completes the callback.
- Then: The foreign-issuer callback returns `error` and its receipt returns HTTP 404. The second callback succeeds, the reconnect callback succeeds and its receipt equals the original receipt. The provider receives exactly one registration, which requests no `token_endpoint_auth_method`.

## connectors-automatic-052

- Vitest: "builtin MCP automatic authentication > connects and reuses a DCR client with millisecond issuance and expiry"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration, and the provider reports the client issuance and secret expiry times in milliseconds (issued 1 second ago, secret expiring in 1 hour).
- When: The member starts an add attempt and completes its callback, then reconnects the new account and completes that callback.
- Then: Both callbacks return `success` and the provider receives exactly one client registration.

## connectors-automatic-053

- Vitest: "builtin MCP automatic authentication > infers none authentication when registration omits the method"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration. The registration response omits `token_endpoint_auth_method` and returns only a client ID with no client secret (method `none` row).
- When: The member starts `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`, completes the callback, and reads the account.
- Then: The callback returns `success` and the account is `connected`.

## connectors-automatic-054

- Vitest: "builtin MCP automatic authentication > infers client_secret_basic authentication when registration omits the method"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration. The registration response omits `token_endpoint_auth_method` and returns a client ID with a client secret (method `client_secret_basic` row).
- When: The member starts `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`, completes the callback, and reads the account.
- Then: The callback returns `success` and the account is `connected`.

## connectors-automatic-055

- Vitest: "builtin MCP automatic authentication > rejects DCR unsupported authentication without creating an account"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration; discovery advertises `client_secret_basic` and `client_secret_post`. The registration response declares unsupported method `private_key_jwt`.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`.
- Then: The start returns HTTP 409 with error code `CONFLICT`, and the connector's connection list is empty.

## connectors-automatic-056

- Vitest: "builtin MCP automatic authentication > rejects DCR public authentication with a client sec… without creating an account"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration; discovery advertises `client_secret_basic` and `client_secret_post`. The registration response declares public method `none` but also returns a client secret.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`.
- Then: The start returns HTTP 409 with error code `CONFLICT`, and the connector's connection list is empty.

## connectors-automatic-057

- Vitest: "builtin MCP automatic authentication > rejects DCR confidential authentication without a c… without creating an account"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration; discovery advertises `client_secret_basic` and `client_secret_post`. The registration response declares `client_secret_basic` but returns no client secret.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`.
- Then: The start returns HTTP 409 with error code `CONFLICT`, and the connector's connection list is empty.

## connectors-automatic-058

- Vitest: "builtin MCP automatic authentication > rejects DCR no declared method or compatible creden… without creating an account"
- Mode: run
- Given: A signed-in member uses the builtin `automatic-mcp-oauth` connector with dynamic client registration; discovery advertises only `client_secret_basic` and `client_secret_post`. The registration response declares no method and returns no client secret.
- When: The member calls `POST /api/connectors/automatic-mcp-oauth/automatic/start` with intent `add`.
- Then: The start returns HTTP 409 with error code `CONFLICT`, and the connector's connection list is empty.

## connectors-automatic-059

- Vitest: "builtin MCP automatic authentication > does not resurrect an account deleted during its reconnect token exchange"
- Mode: run
- Given: A signed-in member has an OAuth-connected `automatic-mcp-oauth` account created through CIMD OAuth and has started a reconnect for it. While the provider handles the reconnect token exchange, the member deletes the account through `DELETE /api/connector-accounts/:connectionId`, and the provider then returns new tokens.
- When: The provider returns to `GET /api/connectors/automatic/callback` with the reconnect state and a code.
- Then: The callback returns `error`, the reconnect receipt returns HTTP 404, and the connector's connection list stays empty.

## connectors-automatic-060

- Vitest: "builtin MCP automatic authentication > consumes cancellation without accepting a subsequent authorization code"
- Mode: run
- Given: A signed-in member has started an `automatic-mcp-oauth` CIMD OAuth attempt.
- When: The provider returns to `GET /api/connectors/automatic/callback` with `error=access_denied` and no issuer, and then a code callback with the same state and the real issuer is sent.
- Then: The cancellation callback returns `error`, the later code callback also returns `error`, and the attempt receipt returns HTTP 404.
