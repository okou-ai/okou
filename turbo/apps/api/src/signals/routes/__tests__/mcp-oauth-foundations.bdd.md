# mcp-oauth-foundations

## mcp-oauth-foundations-001

- Vitest: "MCP OAuth foundations > adds AS-only offline access without oth…"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector using CIMD registration. The server's challenge asks for scope `graph:read`, the protected resource advertises `graph:read media:read`, the authorization server lists `graph:read media:read offline_access admin`, and it supports the refresh grant.
- When: The admin starts OAuth with `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The authorization URL's `scope` is exactly `graph:read offline_access`.

## mcp-oauth-foundations-002

- Vitest: "MCP OAuth foundations > uses resource scopes when the challenge…"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector using CIMD registration. The server's challenge has no scope, the protected resource advertises `graph:read media:read`, the authorization server lists `graph:read media:read offline_access`, and it supports the refresh grant.
- When: The admin starts OAuth with `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The authorization URL's `scope` is exactly `graph:read media:read offline_access`.

## mcp-oauth-foundations-003

- Vitest: "MCP OAuth foundations > does not duplicate offline access alrea…"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector using CIMD registration. The challenge asks for `graph:read offline_access graph:read`, the authorization server lists `graph:read offline_access`, and it supports the refresh grant.
- When: The admin starts OAuth with `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The authorization URL's `scope` is exactly `graph:read offline_access`, with no duplicates.

## mcp-oauth-foundations-004

- Vitest: "MCP OAuth foundations > does not add offline access without AS …"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector using CIMD registration. The challenge asks for `graph:read`, the authorization server lists only `graph:read admin` (no `offline_access`), and it supports the refresh grant.
- When: The admin starts OAuth with `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The authorization URL's `scope` is exactly `graph:read`.

## mcp-oauth-foundations-005

- Vitest: "MCP OAuth foundations > does not add offline access when AS sco…"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector using CIMD registration. The challenge asks for `graph:read`, the authorization server metadata omits its supported scopes, and it supports the refresh grant.
- When: The admin starts OAuth with `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The authorization URL's `scope` is exactly `graph:read`.

## mcp-oauth-foundations-006

- Vitest: "MCP OAuth foundations > does not add offline access without ref…"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector using CIMD registration. The challenge asks for `graph:read`, the authorization server lists `graph:read offline_access`, but supports only the `authorization_code` grant.
- When: The admin starts OAuth with `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The authorization URL's `scope` is exactly `graph:read`.

## mcp-oauth-foundations-007

- Vitest: "MCP OAuth foundations > respects the non-refresh default for om…"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector using CIMD registration. The challenge asks for `graph:read`, the authorization server lists `graph:read offline_access`, and its metadata omits supported grant types.
- When: The admin starts OAuth with `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The authorization URL's `scope` is exactly `graph:read`.

## mcp-oauth-foundations-008

- Vitest: "MCP OAuth foundations > requests offline access in DCR as well …"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector using dynamic client registration. The challenge asks for `graph:read`, the authorization server lists `graph:read offline_access admin`, and it supports the refresh grant.
- When: The admin starts OAuth with `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The authorization URL's `scope` is exactly `graph:read offline_access`, and exactly one client registration is sent with that same `scope`.

## mcp-oauth-foundations-009

- Vitest: "MCP OAuth foundations > preserves provider defaults when no resource scopes are advertised"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector whose challenge has no scope, whose protected resource advertises no scopes, and whose authorization server lists `offline_access admin`.
- When: The admin starts OAuth with `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The authorization URL has no `scope` parameter.

## mcp-oauth-foundations-010

- Vitest: "MCP OAuth foundations > authorizes mixed custom MCP through cimd despite public initialization"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector using CIMD registration whose server allows public initialization but requires OAuth for tools, advertising scopes `read write`.
- When: The admin starts OAuth with `POST /api/custom-connectors/:id/oauth2/start` and completes `GET /api/custom-connectors/oauth2/callback` with the issuer.
- Then: The authorization URL has scope `read write` and client ID `https://api.okou.ai/api/oauth/mcp/client-metadata/okou.json`. The callback reports `success`, and the connector's only account is `connected` with scopes `read`, `write`.

## mcp-oauth-foundations-011

- Vitest: "MCP OAuth foundations > authorizes mixed custom MCP through dcr despite public initialization"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector using dynamic client registration whose server allows public initialization but requires OAuth for tools, advertising scopes `read write`.
- When: The admin starts OAuth with `POST /api/custom-connectors/:id/oauth2/start` and completes `GET /api/custom-connectors/oauth2/callback` with the issuer.
- Then: The authorization URL has scope `read write` and client ID `automatic-dcr-client`. The callback reports `success`, and the connector's only account is `connected` with scopes `read`, `write`.

## mcp-oauth-foundations-012

- Vitest: "MCP OAuth foundations > preserves a custom OAuth account when reconnect metadata is unavailable"
- Mode: run
- Given: An organization admin connected an Automatic MCP custom connector through OAuth. The server's protected-resource metadata then returns HTTP 503.
- When: The admin starts a reconnect for that account with `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The reconnect returns HTTP 502, and the connector's account list is exactly unchanged.

## mcp-oauth-foundations-013

- Vitest: "MCP OAuth foundations > preserves custom OAuth accepted while an anonymous reconnect was discovering metadata"
- Mode: run
- Given: An organization admin connected a public (no-auth) Automatic MCP custom connector. A reconnect is in flight and its metadata discovery is held, then will answer 503.
- When: While discovery is held, the server switches to OAuth and the admin starts and completes a reconnect OAuth flow for the same account; then the held reconnect finishes.
- Then: After the OAuth callback the account has scopes `read`, `write`. The held reconnect returns HTTP 409, and the account list is exactly unchanged from the upgraded state.

## mcp-oauth-foundations-014

- Vitest: "MCP OAuth foundations > connects a public custom MCP when optional metadata is an HTML page"
- Mode: run
- Given: An organization admin has a public (no-auth) Automatic MCP custom connector whose optional `/.well-known/oauth-protected-resource` returns an HTML page.
- When: The admin calls `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 200 with result `connected`, and the connector's account is `connected` with `oauthScopes` null.

## mcp-oauth-foundations-015

- Vitest: "MCP OAuth foundations > publishes exact public Okou client metadata from configured origins"
- Mode: run
- Given: The API backend URL is `https://api.okou.ai`, the web URL is `https://www.okou.ai`, and the app URL is `https://app.okou.ai`.
- When: Anyone requests `GET /api/oauth/mcp/client-metadata/okou.json`.
- Then: The response is HTTP 200 with exactly client ID `https://api.okou.ai/api/oauth/mcp/client-metadata/okou.json`, name `Okou`, client URI `https://app.okou.ai/`, the two redirect URIs (app custom callback and API automatic callback), grant types `authorization_code` and `refresh_token`, response type `code`, application type `web` and token auth method `none`.

## mcp-oauth-foundations-016

- Vitest: "MCP OAuth foundations > does not let the request host change the Okou client identity"
- Mode: run
- Given: The API backend, web and app URLs are configured as the `okou.ai` origins.
- When: A request with host `attacker.example.com` calls `GET /api/oauth/mcp/client-metadata/okou.json`.
- Then: The client ID, client URI and redirect URIs still use the configured `okou.ai` origins.

## mcp-oauth-foundations-017

- Vitest: "MCP OAuth foundations > rejects unsafe OAuth URL http://oauth.example.com/metadata"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector whose 401 challenge points `resource_metadata` at `http://oauth.example.com/metadata`.
- When: The admin calls `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 400 with code `MCP_OAUTH_UNSAFE_URL` and the generic Automatic MCP OAuth setup failure message, and no token request is made.

## mcp-oauth-foundations-018

- Vitest: "MCP OAuth foundations > rejects unsafe OAuth URL https://user:password@oauth.example.com/metadata"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector whose 401 challenge points `resource_metadata` at `https://user:password@oauth.example.com/metadata`.
- When: The admin calls `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 400 with code `MCP_OAUTH_DISCOVERY_INVALID` and the generic Automatic MCP OAuth setup failure message, and no token request is made.

## mcp-oauth-foundations-019

- Vitest: "MCP OAuth foundations > rejects unsafe OAuth URL https://oauth.example.com/metadata#fragment"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector whose 401 challenge points `resource_metadata` at `https://oauth.example.com/metadata#fragment`.
- When: The admin calls `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 400 with code `MCP_OAUTH_UNSAFE_URL` and the generic Automatic MCP OAuth setup failure message, and no token request is made.

## mcp-oauth-foundations-020

- Vitest: "MCP OAuth foundations > follows three metadata redirects from https://oauth.example.com"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector whose resource metadata URL is `https://oauth.example.com/redirect/0`, which redirects three times on the same origin before returning the metadata.
- When: The admin calls `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 200 with result `authorization`, an authorization URL at the issuer's `/authorize`, a connection ID and an OAuth attempt ID. Metadata steps 0 through 3 are fetched, and no token request is made.

## mcp-oauth-foundations-021

- Vitest: "MCP OAuth foundations > follows three metadata redirects from https://localhost"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector whose resource metadata URL is `https://localhost/redirect/0`, which redirects three times on the same origin before returning the metadata.
- When: The admin calls `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 200 with result `authorization`, an authorization URL at the issuer's `/authorize`, a connection ID and an OAuth attempt ID. Metadata steps 0 through 3 are fetched, and no token request is made.

## mcp-oauth-foundations-022

- Vitest: "MCP OAuth foundations > follows three metadata redirects from https://10.0.0.1"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector whose resource metadata URL is `https://10.0.0.1/redirect/0`, which redirects three times on the same origin before returning the metadata.
- When: The admin calls `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 200 with result `authorization`, an authorization URL at the issuer's `/authorize`, a connection ID and an OAuth attempt ID. Metadata steps 0 through 3 are fetched, and no token request is made.

## mcp-oauth-foundations-023

- Vitest: "MCP OAuth foundations > follows three metadata redirects from https://[fd00::1]"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector whose resource metadata URL is `https://[fd00::1]/redirect/0`, which redirects three times on the same origin before returning the metadata.
- When: The admin calls `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 200 with result `authorization`, an authorization URL at the issuer's `/authorize`, a connection ID and an OAuth attempt ID. Metadata steps 0 through 3 are fetched, and no token request is made.

## mcp-oauth-foundations-024

- Vitest: "MCP OAuth foundations > rejects a fourth metadata redirect"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector whose resource metadata URL `https://oauth.example.com/redirect/0` would need four redirects before returning the metadata.
- When: The admin calls `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 400 with code `MCP_OAUTH_DISCOVERY_INVALID`. Only steps 0 through 3 are fetched, and no token request is made.

## mcp-oauth-foundations-025

- Vitest: "MCP OAuth foundations > revalidates a metadata redirect target before fetching it"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector whose resource metadata URL `https://oauth.example.com/redirect` redirects to `http://oauth.example.com/metadata`.
- When: The admin calls `POST /api/custom-connectors/:id/oauth2/start`.
- Then: The response is HTTP 400 with code `MCP_OAUTH_UNSAFE_URL`. The downgraded `http` URL is never fetched, and no token request is made.

## mcp-oauth-foundations-026

- Vitest: "MCP OAuth foundations > removes authorization before a metadata redirect"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector whose token response gives access token `secret`. Its userinfo endpoint `https://oauth.example.com/redirect` redirects authorized requests to `https://metadata.example.com/document`, which returns subject `redirect-user` and preferred username `redirect-userinfo-name`.
- When: The admin starts OAuth and completes `GET /api/custom-connectors/oauth2/callback` with the issuer.
- Then: The callback returns HTTP 200 with `{ status: "success", username: null }`. The first userinfo request carries `Bearer secret` and the redirected request carries no authorization. The single account has external ID `redirect-user`, username `redirect-userinfo-name` and no email.

## mcp-oauth-foundations-027

- Vitest: "MCP OAuth foundations > rejects token and DCR POST redirects without replay"
- Mode: run
- Given: A Pro organization admin connected a standard OAuth custom connector (client `redirect-client`, `client_secret_basic`) with refresh token `secret`, and has a running run. The provider answers refresh requests with a 307 redirect to another token path.
- When: The run's firewall calls `POST /api/webhooks/run/firewall/auth` for the connector account with `forceRefresh` true.
- Then: The response is HTTP 502 with code `TOKEN_REFRESH_FAILED`, the message naming the connector, `connectors` [connector ID] and failure reason `upstream_provider`. Exactly one refresh request was sent (form-encoded `grant_type=refresh_token&refresh_token=secret` with Basic client credentials), and the redirect target was never called.

## mcp-oauth-foundations-028

- Vitest: "MCP OAuth foundations > enforces header and response body size limits"
- Mode: run
- Given: An organization admin has an Automatic MCP custom connector. One metadata URL returns valid metadata with a 17 KiB response header, and another returns a JSON body of 64 KiB plus one byte.
- When: The admin calls `POST /api/custom-connectors/:id/oauth2/start` with each metadata URL in the challenge.
- Then: Both requests return HTTP 400 with code `MCP_OAUTH_DISCOVERY_INVALID`, and no token request is made.
