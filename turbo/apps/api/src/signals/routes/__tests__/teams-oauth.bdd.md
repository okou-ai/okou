# teams-oauth

## teams-oauth-001

- Vitest: "Teams OAuth API routes > requires sign-in before accepting a legacy caller-supplied identity"
- Mode: run
- Given: A signed-out browser holds the legacy Teams OAuth start URL naming a user and workspace.
- When: The browser opens `GET /api/teams/oauth/connect`.
- Then: HTTP 307 directs it to `/sign-in` with `Cache-Control: no-store`.

## teams-oauth-002

- Vitest: "Teams OAuth API routes > rejects a different authenticated actor naming an existing member"
- Mode: run
- Given: A workspace admin is signed in, but a Teams OAuth start URL names a different existing member in the workspace.
- When: The admin opens the legacy connect URL under their own session.
- Then: The redirect error reports a different account or organization.

## teams-oauth-003

- Vitest: "Teams OAuth API routes > rejects caller-authored callback state without creating a binding"
- Mode: run
- Given: An existing workspace member is named in caller-authored Teams callback state and the provider would accept the code.
- When: The browser sends the OAuth code and state to `GET /api/integrations/teams/oauth/callback`.
- Then: The redirect reports `Invalid connect state.` The initiating member's authenticated Teams status remains without linked accounts or a pending installation.

## teams-oauth-004

- Vitest: "Teams OAuth API routes > opens a settings entry link without credentials and consumes authenticated completion once"
- Mode: run
- Given: An authenticated workspace member obtains a generated Teams settings connect URL from status.
- When: The browser opens it without passing credentials, then follows the Microsoft authorization callback. The browser repeats the callback and reopens the original entry link.
- Then: The link opens Microsoft authorization. The first callback redirects with `status=connected`; callback replay reports `Invalid connect state.`, and the entry replay reports the link was already used. Status shows exactly one linked account.

## teams-oauth-005

- Vitest: "Teams OAuth API routes > expires an abandoned callback without binding the provider identity"
- Mode: run
- Given: A member obtains legitimate Teams OAuth state and leaves it unused for 15 minutes.
- When: The browser sends the OAuth code and state to `GET /api/integrations/teams/oauth/callback`.
- Then: The redirect reports `Invalid connect state.` The initiating member's authenticated Teams status remains without linked accounts or a pending installation.

## teams-oauth-006

- Vitest: "Teams OAuth API routes > rejects a callback after the authenticated Okou actor switches"
- Mode: run
- Given: An existing member starts Teams OAuth, then the workspace's session switches to a different signed-in user before Microsoft returns.
- When: The browser sends the OAuth code and state to `GET /api/integrations/teams/oauth/callback`.
- Then: The redirect reports that the active account or organization changed. The initiating member's authenticated Teams status remains without linked accounts or a pending installation.

## teams-oauth-007

- Vitest: "Teams OAuth API routes > keeps API-host connect requests on the API callback origin"
- Mode: run
- Given: A workspace admin is signed in and requests Teams OAuth through the configured API host.
- When: The browser opens `GET /api/teams/oauth/connect` for its own user and workspace.
- Then: HTTP 307 redirects to Microsoft's common OAuth authorize endpoint, with the OAuth redirect URI on that API host at `/api/integrations/teams/oauth/callback`.

## teams-oauth-008

- Vitest: "Teams OAuth API routes > rejects malformed callback state using the configured app"
- Mode: run
- Given: The application origin is configured and an OAuth result arrives at the API host with a code and malformed state.
- When: The browser sends the OAuth code and state to `GET /api/integrations/teams/oauth/callback`.
- Then: HTTP 307 redirects to the configured app's `/settings/teams` with `Invalid connect state.`.

## teams-oauth-009

- Vitest: "Teams OAuth API routes > uses the configured app for provider errors with malformed state"
- Mode: run
- Given: The application origin is configured and Microsoft returns `access_denied` along with malformed state.
- When: The browser opens the Teams OAuth callback with the provider error.
- Then: HTTP 307 directs it to the configured app's `/settings/teams` and retains `access_denied` in the query.

## teams-oauth-010

- Vitest: "Teams OAuth API routes > exchanges the code with the redirect URI recorded in the connect state"
- Mode: run
- Given: The signed-in admin's Teams OAuth attempt recorded a callback URI on a different API origin from this request. Microsoft recognizes the member and accepts exchange with the recorded URI.
- When: The browser sends the OAuth code and state to `GET /api/integrations/teams/oauth/callback`.
- Then: Token exchange uses the recorded redirect URI. HTTP 307 sends the caller to the application Teams settings page with `status=connected` and bot name `Okou`.

## teams-oauth-011

- Vitest: "Teams OAuth API routes > rejects callback state when the internal user is not an org member"
- Mode: run
- Given: A valid issued attempt names a user whose Clerk membership list no longer includes the workspace.
- When: The browser sends the OAuth code and state to `GET /api/integrations/teams/oauth/callback`.
- Then: HTTP 307 redirects to the application's Teams settings with `Invalid connect state.`.

## teams-oauth-012

- Vitest: "Teams OAuth API routes > rejects callback state when the Clerk identity no longer exists"
- Mode: run
- Given: A valid issued attempt names an identity that Clerk now reports as not found.
- When: The browser sends the OAuth code and state to `GET /api/integrations/teams/oauth/callback`.
- Then: HTTP 307 redirects to the application's Teams settings with `Invalid connect state.`.

## teams-oauth-013

- Vitest: "Teams OAuth API routes > rejects another OAuth owner without changing account metadata (installed=false)"
- Mode: run
- Given: Two distinct members share a workspace with no Teams bot installation. The first already linked a Teams tenant and Entra identity. Microsoft returns the same tenant and identity with different profile metadata to the second member.
- When: The second member completes their own valid Teams OAuth attempt and both members read connection status.
- Then: The redirect instructs the second member to disconnect their current Teams account. The original account and its metadata stay the same, while the second member remains disconnected with no linked accounts or pending installation.

## teams-oauth-014

- Vitest: "Teams OAuth API routes > rejects another OAuth owner without changing account metadata (installed=true)"
- Mode: run
- Given: Two distinct members share a workspace with Teams bot installed. The first already linked a Teams tenant and Entra identity. Microsoft returns the same tenant and identity with different profile metadata to the second member.
- When: The second member completes their own valid Teams OAuth attempt and both members read connection status.
- Then: The redirect instructs the second member to disconnect their current Teams account. The original account and its metadata stay the same, while the second member remains disconnected with no linked accounts or pending installation.

## teams-oauth-015

- Vitest: "Teams OAuth API routes > arbitrates concurrent OAuth account connections (different org=false)"
- Mode: run
- Given: Two distinct Okou members in one workspace have valid Teams OAuth attempts for the same Microsoft Entra identity and tenant. No bot has been installed.
- When: The two callbacks arrive concurrently. Both members then read their own Teams connection status.
- Then: One callback redirect says connected and the other contains an error. The winner alone sees a connected status and one linked account. Neither status has a bot installation or pending installation.

## teams-oauth-016

- Vitest: "Teams OAuth API routes > arbitrates concurrent OAuth account connections (different org=true)"
- Mode: run
- Given: Two distinct Okou members in different workspaces have valid Teams OAuth attempts for the same Microsoft Entra identity and tenant. No bot has been installed.
- When: The two callbacks arrive concurrently. Both members then read their own Teams connection status.
- Then: One callback redirect says connected and the other contains an error. The winner alone sees a connected status and one linked account. Neither status has a bot installation or pending installation.

## teams-oauth-017

- Vitest: "Teams OAuth API routes > authenticates before claiming a Teams tenant (missing)"
- Mode: run
- Given: A signed-in member initiates a Teams connection and Microsoft returns a tenant and Entra identity. The browser callback arrives without credentials.
- When: The browser first hits the redirect callback and then requests the JSON completion with the given credentials. If prompted to sign in, the initiating member completes the callback with their authenticated session.
- Then: The initial redirect is HTTP 307 with `integration=teams` and creates no binding. JSON completion returns HTTP 401 with no linked accounts. Resuming under the initiating session connects the expected tenant and Entra identity.

## teams-oauth-018

- Vitest: "Teams OAuth API routes > authenticates before claiming a Teams tenant (expired-cookie)"
- Mode: run
- Given: A signed-in member initiates a Teams connection and Microsoft returns a tenant and Entra identity. The browser callback arrives with an expired session cookie.
- When: The browser first hits the redirect callback and then requests the JSON completion with the given credentials. If prompted to sign in, the initiating member completes the callback with their authenticated session.
- Then: The initial redirect is HTTP 307 with `integration=teams` and creates no binding. JSON completion returns HTTP 401 with no linked accounts. Resuming under the initiating session connects the expected tenant and Entra identity.

## teams-oauth-019

- Vitest: "Teams OAuth API routes > authenticates before claiming a Teams tenant (matching-cookie)"
- Mode: run
- Given: A signed-in member initiates a Teams connection and Microsoft returns a tenant and Entra identity. The browser callback arrives with the initiating user's matching session cookie.
- When: The browser first hits the redirect callback and then requests the JSON completion with the given credentials. If prompted to sign in, the initiating member completes the callback with their authenticated session.
- Then: The initial redirect is HTTP 307 with `integration=teams` and creates no binding. JSON completion returns HTTP 200 with a connected redirect target, and status shows exactly one linked account.

## teams-oauth-020

- Vitest: "Teams OAuth API routes > authenticates before claiming a Teams tenant (different-user)"
- Mode: run
- Given: A signed-in member initiates a Teams connection and Microsoft returns a tenant and Entra identity. The browser callback arrives with a different signed-in user.
- When: The browser first hits the redirect callback and then requests the JSON completion with the given credentials. If prompted to sign in, the initiating member completes the callback with their authenticated session.
- Then: The initial redirect is HTTP 307 with `integration=teams` and creates no binding. JSON completion returns HTTP 200 with a redirect target saying the active account or organization changed, and the initiator remains unlinked.

## teams-oauth-021

- Vitest: "Teams OAuth API routes > authenticates before claiming a Teams tenant (different-org)"
- Mode: run
- Given: A signed-in member initiates a Teams connection and Microsoft returns a tenant and Entra identity. The browser callback arrives with a different active organization.
- When: The browser first hits the redirect callback and then requests the JSON completion with the given credentials. If prompted to sign in, the initiating member completes the callback with their authenticated session.
- Then: The initial redirect is HTTP 307 with `integration=teams` and creates no binding. JSON completion returns HTTP 200 with a redirect target saying the active account or organization changed, and the initiator remains unlinked.

## teams-oauth-022

- Vitest: "Teams OAuth API routes > authenticates before claiming a Teams tenant (invalid-bearer)"
- Mode: run
- Given: A signed-in member initiates a Teams connection and Microsoft returns a tenant and Entra identity. The browser callback arrives with an invalid bearer token.
- When: The browser first hits the redirect callback and then requests the JSON completion with the given credentials. If prompted to sign in, the initiating member completes the callback with their authenticated session.
- Then: The initial redirect is HTTP 307 with `integration=teams` and creates no binding. JSON completion returns HTTP 401 with no linked accounts. Resuming under the initiating session connects the expected tenant and Entra identity.
