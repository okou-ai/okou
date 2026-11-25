# connectors-oauth-start

## connectors-oauth-start-001

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > allows auth-code OAuth start when the connector feature is disabled"
- Mode: run
- Given: A signed-in workspace member uses the builtin `test-oauth` connector without enabling its feature switch.
- When: The member sends `POST /api/connectors/test-oauth/oauth/start` with method `oauth` and intent `add`.
- Then: The response is HTTP 200 with an authorization URL that carries a 64-hex-character state.

## connectors-oauth-start-002

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > returns the future connection id for an unnamed account addition"
- Mode: run
- Given: A signed-in workspace member adds an unnamed `test-oauth` account.
- When: The member sends `POST /api/connectors/test-oauth/oauth/start` with method `oauth` and intent `add` without a display name.
- Then: The response is HTTP 200 with a non-empty future `connectionId` and an authorization URL that carries a 64-hex-character state.

## connectors-oauth-start-003

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `youtube`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Google OAuth is configured with client ID `google-test-client-id`.
- When: The member sends `POST https://api.okou.ai/api/connectors/youtube/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 with an authorization URL at `https://accounts.google.com/o/oauth2/v2/auth` with client ID `google-test-client-id`, redirect URI `https://www.okou.ai/api/connectors/youtube/callback`, the five YouTube and email scopes, `access_type=offline`, `prompt=consent` and a 64-hex-character state.

## connectors-oauth-start-004

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > returns the provider authorization URL without an API redirect"
- Mode: run
- Given: A signed-in workspace member connects `github` from the web site; GitHub OAuth is configured with client ID `test-client-id`.
- When: The member sends `POST https://www.okou.ai/api/connectors/github/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 with the provider URL itself, `https://github.com/login/oauth/authorize`, with client ID `test-client-id`, redirect URI `https://www.okou.ai/api/connectors/github/callback` and a 64-hex-character state.

## connectors-oauth-start-005

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the configured web origin for local OAuth callback URLs"
- Mode: run
- Given: A signed-in workspace member connects `github` from a local origin `http://localhost:3000`, and the configured web origin is `https://www.okou.ai:8443`.
- When: The member sends `POST http://localhost:3000/api/connectors/github/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is `https://www.okou.ai:8443/api/connectors/github/callback`, with a 64-hex-character state.

## connectors-oauth-start-006

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for a ready Google connector"
- Mode: run
- Given: A signed-in workspace member connects the ready Google connector `google-maps`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/google-maps/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is `https://app.okou.ai/connectors/google-maps/callback`, with a 64-hex-character state.

## connectors-oauth-start-007

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > returns google-maps App callback errors to the configured Okou app"
- Mode: run
- Given: A signed-in workspace member connects `google-maps` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/google-maps/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns `error=access_denied` with the state to `GET https://api.okou.ai/api/connectors/google-maps/callback`.
- Then: The start returns HTTP 200 with redirect URI `https://app.okou.ai/connectors/google-maps/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/error`.

## connectors-oauth-start-008

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > returns test-oauth App callback errors to the configured Okou app"
- Mode: run
- Given: A signed-in workspace member connects `test-oauth` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/test-oauth/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns `error=access_denied` with the state to `GET https://api.okou.ai/api/connectors/test-oauth/callback`.
- Then: The start returns HTTP 200 with redirect URI `https://app.okou.ai/connectors/test-oauth/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/error`.

## connectors-oauth-start-009

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for GitHub and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `github` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. GitHub grants scopes `repo,project,workflow` and identifies user `github-test-user`.
- When: The member sends `POST https://api.okou.ai/api/connectors/github/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/github/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://github.com/login/oauth/authorize` with client ID `test-client-id`, redirect URI `https://app.okou.ai/connectors/github/callback`, scopes `repo project workflow` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and GitHub receives exactly one token request whose `redirect_uri` equals the authorization redirect URI.

## connectors-oauth-start-010

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > returns github provider denial to the configured Okou app"
- Mode: run
- Given: A signed-in workspace member connects `github` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/github/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider denies access by returning `error=access_denied` with the state to `GET https://api.okou.ai/api/connectors/github/callback`.
- Then: The start returns HTTP 200 with a 64-hex-character state, and the callback redirects with HTTP 307 to `https://app.okou.ai/connector/error`.

## connectors-oauth-start-011

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > returns quickbooks provider denial to the configured Okou app"
- Mode: run
- Given: A signed-in workspace member connects `quickbooks` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/quickbooks/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider denies access by returning `error=access_denied` with the state to `GET https://api.okou.ai/api/connectors/quickbooks/callback`.
- Then: The start returns HTTP 200 with a 64-hex-character state, and the callback redirects with HTTP 307 to `https://app.okou.ai/connector/error`.

## connectors-oauth-start-012

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > returns stripe provider denial to the configured Okou app"
- Mode: run
- Given: A signed-in workspace member connects `stripe` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/stripe/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider denies access by returning `error=access_denied` with the state to `GET https://api.okou.ai/api/connectors/stripe/callback`.
- Then: The start returns HTTP 200 with a 64-hex-character state, and the callback redirects with HTTP 307 to `https://app.okou.ai/connector/error`.

## connectors-oauth-start-013

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Airtable and reuses its exact PKCE redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `airtable` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Airtable issues tokens and identifies user `airtable-user-123`.
- When: The member sends `POST https://api.okou.ai/api/connectors/airtable/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/airtable/callback` with an authorization code and the state, and reads `GET /api/connector-accounts/:connectionId` for the returned connection ID.
- Then: The start returns a UUID `connectionId` and an authorization URL at `https://airtable.com/oauth2/v1/authorize` with client ID `airtable-test-client-id`, redirect URI `https://app.okou.ai/connectors/airtable/callback`, a base64url code challenge with method `S256` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai`. Airtable receives one token request with the same `redirect_uri` and a base64url `code_verifier`, and the account read shows that connection as a `connected` `airtable` account.

## connectors-oauth-start-014

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > reuses the direct Okou redirect URI for a Google token exchange"
- Mode: run
- Given: A signed-in workspace member connects `gmail` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Google issues tokens and returns user info.
- When: The member sends `POST https://api.okou.ai/api/connectors/gmail/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/gmail/callback` with an authorization code and the state.
- Then: The authorization URL's redirect URI is `https://app.okou.ai/connectors/gmail/callback` with a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Google receives exactly one token request with that same `redirect_uri`.

## connectors-oauth-start-015

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Box and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `box` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Box issues tokens and identifies the user.
- When: The member sends `POST https://api.okou.ai/api/connectors/box/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/box/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://account.box.com/api/oauth2/authorize` with client ID `box-test-client-id`, redirect URI `https://app.okou.ai/connectors/box/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Box receives exactly one token request whose `redirect_uri` equals that redirect URI.

## connectors-oauth-start-016

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for HubSpot and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `hubspot` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. HubSpot issues tokens and identifies the user.
- When: The member sends `POST https://api.okou.ai/api/connectors/hubspot/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/hubspot/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://app.hubspot.com/oauth/authorize` with client ID `hubspot-test-client-id`, redirect URI `https://app.okou.ai/connectors/hubspot/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and HubSpot receives exactly one token request whose `redirect_uri` equals that redirect URI.

## connectors-oauth-start-017

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Meta Ads and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `meta-ads` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Meta exchanges the code for a short-lived token, then a long-lived token, and returns the user.
- When: The member sends `POST https://api.okou.ai/api/connectors/meta-ads/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/meta-ads/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://www.facebook.com/v22.0/dialog/oauth` with client ID `meta-ads-test-client-id`, redirect URI `https://app.okou.ai/connectors/meta-ads/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Meta Ads receives exactly one token request whose `redirect_uri` equals that redirect URI.

## connectors-oauth-start-018

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for TikTok Ads without adding a token redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `tiktok-ads` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. TikTok returns an access token and advertiser IDs.
- When: The member sends `POST https://api.okou.ai/api/connectors/tiktok-ads/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then TikTok returns to `GET https://api.okou.ai/api/connectors/tiktok-ads/callback` with `auth_code` and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://business-api.tiktok.com/portal/auth` with `app_id` `tiktok-ads-test-client-id`, redirect URI `https://app.okou.ai/connectors/tiktok-ads/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and TikTok receives exactly one token request with only `app_id`, `secret` and `auth_code` (no redirect URI).

## connectors-oauth-start-019

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted box callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `box`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/box/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/box/callback`, with a 64-hex-character state.

## connectors-oauth-start-020

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted hubspot callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `hubspot`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/hubspot/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/hubspot/callback`, with a 64-hex-character state.

## connectors-oauth-start-021

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted meta-ads callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `meta-ads`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/meta-ads/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/meta-ads/callback`, with a 64-hex-character state.

## connectors-oauth-start-022

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted tiktok-ads callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `tiktok-ads`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/tiktok-ads/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/tiktok-ads/callback`, with a 64-hex-character state.

## connectors-oauth-start-023

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Asana and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `asana` (Asana) with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Asana issues tokens and identifies the user.
- When: The member sends `POST https://api.okou.ai/api/connectors/asana/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/asana/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://app.asana.com/-/oauth_authorize` with client ID `asana-test-client-id`, redirect URI `https://app.okou.ai/connectors/asana/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Asana receives exactly one token request whose `redirect_uri` equals that redirect URI.

## connectors-oauth-start-024

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Gumroad and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `gumroad` (Gumroad) with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Gumroad issues tokens and identifies the user.
- When: The member sends `POST https://api.okou.ai/api/connectors/gumroad/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/gumroad/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://gumroad.com/oauth/authorize` with client ID `gumroad-test-client-id`, redirect URI `https://app.okou.ai/connectors/gumroad/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Gumroad receives exactly one token request whose `redirect_uri` equals that redirect URI.

## connectors-oauth-start-025

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Linear and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `linear` (Linear) with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Linear issues tokens and identifies the user.
- When: The member sends `POST https://api.okou.ai/api/connectors/linear/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/linear/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://linear.app/oauth/authorize` with client ID `linear-test-client-id`, redirect URI `https://app.okou.ai/connectors/linear/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Linear receives exactly one token request whose `redirect_uri` equals that redirect URI.

## connectors-oauth-start-026

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Monday.com and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `monday` (Monday.com) with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Monday.com issues tokens and identifies the user.
- When: The member sends `POST https://api.okou.ai/api/connectors/monday/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/monday/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://auth.monday.com/oauth2/authorize` with client ID `monday-test-client-id`, redirect URI `https://app.okou.ai/connectors/monday/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Monday.com receives exactly one token request whose `redirect_uri` equals that redirect URI.

## connectors-oauth-start-027

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for QuickBooks and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `quickbooks` (QuickBooks) with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. QuickBooks issues tokens and identifies the user.
- When: The member sends `POST https://api.okou.ai/api/connectors/quickbooks/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/quickbooks/callback` with an authorization code and `realmId` `quickbooks-realm-123` and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://appcenter.intuit.com/connect/oauth2` with client ID `quickbooks-test-client-id`, redirect URI `https://app.okou.ai/connectors/quickbooks/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and QuickBooks receives exactly one token request whose `redirect_uri` equals that redirect URI.

## connectors-oauth-start-028

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Sentry and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `sentry` (Sentry) with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Sentry issues tokens and identifies the user.
- When: The member sends `POST https://api.okou.ai/api/connectors/sentry/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/sentry/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://sentry.io/oauth/authorize/` with client ID `sentry-test-client-id`, redirect URI `https://app.okou.ai/connectors/sentry/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Sentry receives exactly one token request whose `redirect_uri` equals that redirect URI.

## connectors-oauth-start-029

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Todoist and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `todoist` (Todoist) with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Todoist issues tokens and identifies the user.
- When: The member sends `POST https://api.okou.ai/api/connectors/todoist/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/todoist/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://todoist.com/oauth/authorize` with client ID `todoist-test-client-id`, redirect URI `https://app.okou.ai/connectors/todoist/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Todoist receives exactly one token request whose `redirect_uri` equals that redirect URI.

## connectors-oauth-start-030

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Xero and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `xero` (Xero) with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Xero issues tokens and identifies the user.
- When: The member sends `POST https://api.okou.ai/api/connectors/xero/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/xero/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://login.xero.com/identity/connect/authorize` with client ID `xero-test-client-id`, redirect URI `https://app.okou.ai/connectors/xero/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Xero receives exactly one token request whose `redirect_uri` equals that redirect URI.

## connectors-oauth-start-031

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Stripe Marketplace OAuth"
- Mode: run
- Given: A signed-in workspace member connects `stripe` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Stripe Marketplace issues tokens for account `acct_stripe_test`.
- When: The member sends `POST https://api.okou.ai/api/connectors/stripe/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/stripe/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://marketplace.stripe.com/oauth/v2/authorize` with client ID `stripe-test-client-id`, redirect URI `https://app.okou.ai/connectors/stripe/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Stripe receives exactly one token request whose body is exactly `code=stripe-authorization-code` and `grant_type=authorization_code`.

## connectors-oauth-start-032

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for X and reuses its exact PKCE redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `x` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. X issues tokens and identifies user `x-test-user`.
- When: The member sends `POST https://api.okou.ai/api/connectors/x/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/x/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://x.com/i/oauth2/authorize` with client ID `x-test-client-id`, redirect URI `https://app.okou.ai/connectors/x/callback`, a base64url code challenge with method `S256` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and X receives exactly one token request with the same `redirect_uri` and a base64url `code_verifier`.

## connectors-oauth-start-033

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Intervals.icu without adding a token redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `intervals-icu` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Intervals.icu issues a token and returns the athlete.
- When: The member sends `POST https://api.okou.ai/api/connectors/intervals-icu/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/intervals-icu/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://intervals.icu/oauth/authorize` with client ID `intervals-icu-test-client-id`, redirect URI `https://app.okou.ai/connectors/intervals-icu/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Intervals.icu receives exactly one token request with code `intervals-icu-authorization-code` and no `redirect_uri`.

## connectors-oauth-start-034

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Strava without adding a token redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `strava` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Strava issues a token and returns the athlete.
- When: The member sends `POST https://api.okou.ai/api/connectors/strava/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/strava/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://www.strava.com/oauth/authorize` with client ID `strava-test-client-id`, redirect URI `https://app.okou.ai/connectors/strava/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Strava receives exactly one token request with code `strava-authorization-code` and no `redirect_uri`.

## connectors-oauth-start-035

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > propagates the direct Okou App callback through the Vercel token exchange"
- Mode: run
- Given: A signed-in workspace member connects `vercel` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Vercel issues a token and identifies the user.
- When: The member sends `POST https://api.okou.ai/api/connectors/vercel/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/vercel/callback` with an authorization code and the state.
- Then: The authorization URL is the Vercel Integration URL `https://vercel.com/integrations/okou-test-integration/new` with no `redirect_uri` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Vercel receives exactly one token request with `redirect_uri` `https://app.okou.ai/connectors/vercel/callback`.

## connectors-oauth-start-036

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > propagates the existing Web callback through the Vercel token exchange"
- Mode: run
- Given: A signed-in workspace member connects `vercel` without a callback target. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Vercel issues a token and identifies the user.
- When: The member sends `POST https://api.okou.ai/api/connectors/vercel/oauth/start` with method `oauth` and intent `add` without a callback target, then the provider returns to `GET https://api.okou.ai/api/connectors/vercel/callback` with an authorization code and the state.
- Then: The authorization URL is the Vercel Integration URL `https://vercel.com/integrations/okou-test-integration/new` with no `redirect_uri` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Vercel receives exactly one token request with `redirect_uri` `https://www.okou.ai/api/connectors/vercel/callback`.

## connectors-oauth-start-037

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted airtable callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `airtable`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/airtable/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/airtable/callback`, with a 64-hex-character state.

## connectors-oauth-start-038

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted asana callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `asana`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/asana/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/asana/callback`, with a 64-hex-character state.

## connectors-oauth-start-039

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted gumroad callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `gumroad`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/gumroad/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/gumroad/callback`, with a 64-hex-character state.

## connectors-oauth-start-040

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted intervals-icu callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `intervals-icu`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/intervals-icu/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/intervals-icu/callback`, with a 64-hex-character state.

## connectors-oauth-start-041

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted linear callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `linear`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/linear/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/linear/callback`, with a 64-hex-character state.

## connectors-oauth-start-042

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted monday callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `monday`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/monday/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/monday/callback`, with a 64-hex-character state.

## connectors-oauth-start-043

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted quickbooks callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `quickbooks`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/quickbooks/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/quickbooks/callback`, with a 64-hex-character state.

## connectors-oauth-start-044

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted sentry callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `sentry`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/sentry/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/sentry/callback`, with a 64-hex-character state.

## connectors-oauth-start-045

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted strava callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `strava`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/strava/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/strava/callback`, with a 64-hex-character state.

## connectors-oauth-start-046

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted stripe callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `stripe`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/stripe/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/stripe/callback`, with a 64-hex-character state.

## connectors-oauth-start-047

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted todoist callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `todoist`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/todoist/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/todoist/callback`, with a 64-hex-character state.

## connectors-oauth-start-048

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted x callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `x`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/x/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/x/callback`, with a 64-hex-character state.

## connectors-oauth-start-049

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted xero callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `xero`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/xero/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/xero/callback`, with a 64-hex-character state.

## connectors-oauth-start-050

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Notion and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `notion` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Notion issues tokens and returns the owner user.
- When: The member sends `POST https://api.okou.ai/api/connectors/notion/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/notion/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://api.notion.com/v1/oauth/authorize` with client ID `notion-test-client-id`, redirect URI `https://app.okou.ai/connectors/notion/callback` and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Notion receives exactly one JSON token request `{ grant_type: authorization_code, code: notion-authorization-code, redirect_uri }` with that redirect URI.

## connectors-oauth-start-051

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted Notion callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects `notion`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/notion/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/notion/callback`, with a 64-hex-character state.

## connectors-oauth-start-052

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Cal.com and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `cal-com` (Cal.com) connector with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Cal.com issues tokens and identifies the account.
- When: The member sends `POST https://api.okou.ai/api/connectors/cal-com/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/cal-com/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://app.cal.com/auth/oauth2/authorize` with client ID `cal-com-test-client-id`, redirect URI `https://app.okou.ai/connectors/cal-com/callback` and a 64-hex-character state, and no code challenge or challenge method. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Cal.com receives exactly one token request whose `redirect_uri` equals that redirect URI and that has no `code_verifier`.

## connectors-oauth-start-053

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Calendly and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `calendly` (Calendly) connector with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Calendly issues tokens and identifies the account. Calendly receives its token request as JSON.
- When: The member sends `POST https://api.okou.ai/api/connectors/calendly/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/calendly/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://auth.calendly.com/oauth/authorize` with client ID `calendly-test-client-id`, redirect URI `https://app.okou.ai/connectors/calendly/callback` and a 64-hex-character state, plus a base64url code challenge with method `S256`. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Calendly receives exactly one token request whose `redirect_uri` equals that redirect URI and whose `code_verifier` hashes (SHA-256, base64url) to the code challenge.

## connectors-oauth-start-054

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Close and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `close` (Close) connector with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Close issues tokens and identifies the account.
- When: The member sends `POST https://api.okou.ai/api/connectors/close/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/close/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://app.close.com/oauth2/authorize/` with client ID `close-test-client-id`, redirect URI `https://app.okou.ai/connectors/close/callback` and a 64-hex-character state, and no code challenge or challenge method. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Close receives exactly one token request whose `redirect_uri` equals that redirect URI and that has no `code_verifier`.

## connectors-oauth-start-055

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Copper and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `copper` (Copper) connector with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Copper issues tokens and identifies the account.
- When: The member sends `POST https://api.okou.ai/api/connectors/copper/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/copper/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://app.copper.com/oauth/authorize` with client ID `copper-test-client-id`, redirect URI `https://app.okou.ai/connectors/copper/callback` and a 64-hex-character state, and no code challenge or challenge method. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Copper receives exactly one token request whose `redirect_uri` equals that redirect URI and that has no `code_verifier`.

## connectors-oauth-start-056

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Datadog and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `datadog` (Datadog) connector with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Datadog issues tokens.
- When: The member sends `POST https://api.okou.ai/api/connectors/datadog/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/datadog/callback` with an authorization code and `domain` `datadoghq.com` and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://app.datadoghq.com/oauth2/v1/authorize` with client ID `datadog-test-client-id`, redirect URI `https://app.okou.ai/connectors/datadog/callback` and a 64-hex-character state, plus a base64url code challenge with method `S256`. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Datadog receives exactly one token request whose `redirect_uri` equals that redirect URI and whose `code_verifier` hashes (SHA-256, base64url) to the code challenge.

## connectors-oauth-start-057

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for DocuSign and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `docusign` (DocuSign) connector with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. DocuSign issues tokens and identifies the account.
- When: The member sends `POST https://api.okou.ai/api/connectors/docusign/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/docusign/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://account-d.docusign.com/oauth/auth` with client ID `docusign-test-client-id`, redirect URI `https://app.okou.ai/connectors/docusign/callback` and a 64-hex-character state, plus a base64url code challenge with method `S256`. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and DocuSign receives exactly one token request whose `redirect_uri` equals that redirect URI and whose `code_verifier` hashes (SHA-256, base64url) to the code challenge.

## connectors-oauth-start-058

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Dropbox and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `dropbox` (Dropbox) connector with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Dropbox issues tokens and identifies the account.
- When: The member sends `POST https://api.okou.ai/api/connectors/dropbox/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/dropbox/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://www.dropbox.com/oauth2/authorize` with client ID `dropbox-test-client-id`, redirect URI `https://app.okou.ai/connectors/dropbox/callback` and a 64-hex-character state, and no code challenge or challenge method. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Dropbox receives exactly one token request whose `redirect_uri` equals that redirect URI and that has no `code_verifier`.

## connectors-oauth-start-059

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Figma and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `figma` (Figma) connector with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Figma issues tokens and identifies the account.
- When: The member sends `POST https://api.okou.ai/api/connectors/figma/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/figma/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://www.figma.com/oauth` with client ID `figma-test-client-id`, redirect URI `https://app.okou.ai/connectors/figma/callback` and a 64-hex-character state, and no code challenge or challenge method. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Figma receives exactly one token request whose `redirect_uri` equals that redirect URI and that has no `code_verifier`.

## connectors-oauth-start-060

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Mailchimp and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `mailchimp` (Mailchimp) connector with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Mailchimp issues tokens and identifies the account.
- When: The member sends `POST https://api.okou.ai/api/connectors/mailchimp/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/mailchimp/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://login.mailchimp.com/oauth2/authorize` with client ID `mailchimp-test-client-id`, redirect URI `https://app.okou.ai/connectors/mailchimp/callback` and a 64-hex-character state, and no code challenge or challenge method. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Mailchimp receives exactly one token request whose `redirect_uri` equals that redirect URI and that has no `code_verifier`.

## connectors-oauth-start-061

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Mercury and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `mercury` (Mercury) connector with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Mercury issues tokens and identifies the account.
- When: The member sends `POST https://api.okou.ai/api/connectors/mercury/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/mercury/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://oauth2.mercury.com/oauth2/auth` with client ID `mercury-test-client-id`, redirect URI `https://app.okou.ai/connectors/mercury/callback` and a 64-hex-character state, plus a base64url code challenge with method `S256`. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Mercury receives exactly one token request whose `redirect_uri` equals that redirect URI and whose `code_verifier` hashes (SHA-256, base64url) to the code challenge.

## connectors-oauth-start-062

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for PostHog and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `posthog` (PostHog) connector with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. PostHog issues tokens and identifies the account. PostHog uses the public client metadata ID `https://app.okou.ai/connectors/posthog/metadata.json` without a client secret.
- When: The member sends `POST https://api.okou.ai/api/connectors/posthog/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/posthog/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://oauth.posthog.com/oauth/authorize/` with client ID `https://app.okou.ai/connectors/posthog/metadata.json`, redirect URI `https://app.okou.ai/connectors/posthog/callback` and a 64-hex-character state, plus a base64url code challenge with method `S256`. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and PostHog receives exactly one token request whose `redirect_uri` equals that redirect URI and whose `code_verifier` hashes (SHA-256, base64url) to the code challenge; the request has no authorization header, client ID equal to the metadata URL and no client secret.

## connectors-oauth-start-063

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Spotify and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `spotify` (Spotify) connector with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Spotify issues tokens and identifies the account.
- When: The member sends `POST https://api.okou.ai/api/connectors/spotify/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/spotify/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://accounts.spotify.com/authorize` with client ID `spotify-test-client-id`, redirect URI `https://app.okou.ai/connectors/spotify/callback` and a 64-hex-character state, and no code challenge or challenge method. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Spotify receives exactly one token request whose `redirect_uri` equals that redirect URI and that has no `code_verifier`.

## connectors-oauth-start-064

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Webflow and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `webflow` (Webflow) connector with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Webflow issues tokens and identifies the account. Webflow receives its token request as JSON.
- When: The member sends `POST https://api.okou.ai/api/connectors/webflow/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/webflow/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://webflow.com/oauth/authorize` with client ID `webflow-test-client-id`, redirect URI `https://app.okou.ai/connectors/webflow/callback` and a 64-hex-character state, and no code challenge or challenge method. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Webflow receives exactly one token request whose `redirect_uri` equals that redirect URI and that has no `code_verifier`.

## connectors-oauth-start-065

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Zoom and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `zoom` (Zoom) connector with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Zoom issues tokens and identifies the account.
- When: The member sends `POST https://api.okou.ai/api/connectors/zoom/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/zoom/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://zoom.us/oauth/authorize` with client ID `zoom-test-client-id`, redirect URI `https://app.okou.ai/connectors/zoom/callback` and a 64-hex-character state, and no code challenge or challenge method. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Zoom receives exactly one token request whose `redirect_uri` equals that redirect URI and that has no `code_verifier`.

## connectors-oauth-start-066

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted Cal.com callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `cal-com` (Cal.com) connector. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/cal-com/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/cal-com/callback`, with a 64-hex-character state.

## connectors-oauth-start-067

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted Calendly callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `calendly` (Calendly) connector. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/calendly/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/calendly/callback`, with a 64-hex-character state.

## connectors-oauth-start-068

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted Close callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `close` (Close) connector. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/close/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/close/callback`, with a 64-hex-character state.

## connectors-oauth-start-069

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted Copper callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `copper` (Copper) connector. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/copper/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/copper/callback`, with a 64-hex-character state.

## connectors-oauth-start-070

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted Datadog callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `datadog` (Datadog) connector. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/datadog/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/datadog/callback`, with a 64-hex-character state.

## connectors-oauth-start-071

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted DocuSign callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `docusign` (DocuSign) connector. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/docusign/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/docusign/callback`, with a 64-hex-character state.

## connectors-oauth-start-072

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted Dropbox callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `dropbox` (Dropbox) connector. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/dropbox/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/dropbox/callback`, with a 64-hex-character state.

## connectors-oauth-start-073

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted Figma callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `figma` (Figma) connector. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/figma/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/figma/callback`, with a 64-hex-character state.

## connectors-oauth-start-074

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted Mailchimp callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `mailchimp` (Mailchimp) connector. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/mailchimp/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/mailchimp/callback`, with a 64-hex-character state.

## connectors-oauth-start-075

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted Mercury callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `mercury` (Mercury) connector. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/mercury/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/mercury/callback`, with a 64-hex-character state.

## connectors-oauth-start-076

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted PostHog callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `posthog` (PostHog) connector. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/posthog/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/posthog/callback`, with a 64-hex-character state.

## connectors-oauth-start-077

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted Spotify callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `spotify` (Spotify) connector. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/spotify/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/spotify/callback`, with a 64-hex-character state.

## connectors-oauth-start-078

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted Webflow callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `webflow` (Webflow) connector. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/webflow/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/webflow/callback`, with a 64-hex-character state.

## connectors-oauth-start-079

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted Zoom callback target on the existing Web callback"
- Mode: run
- Given: A signed-in workspace member connects the launch-gated `zoom` (Zoom) connector. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/zoom/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the web callback `https://www.okou.ai/api/connectors/zoom/callback`, with a 64-hex-character state.

## connectors-oauth-start-080

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the configured App callback for a catalog OAuth connector"
- Mode: run
- Given: A signed-in workspace member connects the catalog OAuth connector `test-oauth` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/test-oauth/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is `https://app.okou.ai/connectors/test-oauth/callback`, with a 64-hex-character state.

## connectors-oauth-start-081

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Cloudflare and reuses its exact redirect URI"
- Mode: run
- Given: A signed-in workspace member connects `cloudflare` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`. Cloudflare issues tokens and returns user info.
- When: The member sends `POST https://api.okou.ai/api/connectors/cloudflare/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`, then the provider returns to `GET https://api.okou.ai/api/connectors/cloudflare/callback` with an authorization code and the state.
- Then: The start returns HTTP 200 with an authorization URL at `https://dash.cloudflare.com/oauth2/auth` with client ID `cloudflare-test-client-id`, redirect URI `https://app.okou.ai/connectors/cloudflare/callback`, exactly the catalog's Cloudflare OAuth scopes (including `offline_access`) and a 64-hex-character state. The callback redirects with HTTP 307 to `https://app.okou.ai/connector/success`, and Cloudflare receives exactly one token request whose `redirect_uri` equals that redirect URI.

## connectors-oauth-start-082

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps an omitted Cloudflare callback target on the existing API callback"
- Mode: run
- Given: A signed-in workspace member connects `cloudflare`. The API runs at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/cloudflare/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is the API callback `https://api.okou.ai/api/connectors/cloudflare/callback`, with exactly the catalog's Cloudflare scopes (including `offline_access`) and a 64-hex-character state.

## connectors-oauth-start-083

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the direct Okou App callback for Slack"
- Mode: run
- Given: A signed-in workspace member connects `slack` with `callbackTarget: app`. The app runs at `https://app.okou.ai`, the API at `https://api.okou.ai` and the web site at `https://www.okou.ai`.
- When: The member sends `POST https://api.okou.ai/api/connectors/slack/oauth/start` with method `oauth` and intent `add` and `callbackTarget: app`.
- Then: The response is HTTP 200 and the authorization URL's redirect URI is `https://app.okou.ai/connectors/slack/callback`, with a 64-hex-character state.

## connectors-oauth-start-084

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps API-origin OAuth callbacks on the PR API when WWW uses Omby staging"
- Mode: run
- Given: A signed-in workspace member connects `cloudflare` on a PR deployment whose API is `https://pr-19337-api.vm6.ai` while the web site is the Omby staging `https://staging-www.omby.ai`.
- When: The member sends `POST https://pr-19337-api.vm6.ai/api/connectors/cloudflare/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the redirect URI stays on the PR API, `https://pr-19337-api.vm6.ai/api/connectors/cloudflare/callback`, with the catalog's Cloudflare scopes and a 64-hex-character state.

## connectors-oauth-start-085

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > uses the canonical API origin when OKOU_API_BACKEND_URL is localhost"
- Mode: run
- Given: A signed-in workspace member connects `cloudflare` while the configured API backend URL is `http://localhost:3000` and the web site is `https://www.okou.ai`.
- When: The member sends `POST http://localhost:3000/api/connectors/cloudflare/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the redirect URI uses the canonical API origin, `https://api.okou.ai/api/connectors/cloudflare/callback`, with the catalog's Cloudflare scopes and a 64-hex-character state.

## connectors-oauth-start-086

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > keeps Cloudflare OAuth callbacks on the canonical API origin when OKOU_API_BACKEND_URL is a tunnel"
- Mode: run
- Given: A signed-in workspace member connects `cloudflare` while the configured API backend URL is the tunnel `https://tunnel-liangyou-vm2-www.vm7.ai` and the web site is `https://www.vm7.ai:8443`.
- When: The member sends `POST https://www.vm7.ai:8443/api/connectors/cloudflare/oauth/start` with method `oauth` and intent `add` without a callback target.
- Then: The response is HTTP 200 and the redirect URI uses the canonical API origin `https://api.vm7.ai:8443/api/connectors/cloudflare/callback`, with the catalog's Cloudflare scopes and a 64-hex-character state.

## connectors-oauth-start-087

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > returns 401 instead of relying on browser cookies when unauthenticated"
- Mode: run
- Given: The caller is unauthenticated and sends no authorization header.
- When: The caller sends `POST /api/connectors/github/oauth/start` with method `oauth` and intent `add`.
- Then: The response is HTTP 401 with exactly `{ error: { message: Not authenticated, code: UNAUTHORIZED } }`.

## connectors-oauth-start-088

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > returns 400 when starting OAuth for a connector without an auth-code grant"
- Mode: run
- Given: A signed-in workspace member targets `serpapi`, whose `oauth` selection has no auth-code grant.
- When: The member sends `POST /api/connectors/serpapi/oauth/start` with method `oauth` and intent `add`.
- Then: The response is HTTP 400 with exactly `{ error: { message: serpapi connector does not use an auth-code grant, code: BAD_REQUEST } }`.

## connectors-oauth-start-089

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > returns 400 when starting browser OAuth for a device authorization connector"
- Mode: run
- Given: A signed-in workspace member targets `test-oauth-device`, which uses device authorization instead of an auth-code grant.
- When: The member sends `POST /api/connectors/test-oauth-device/oauth/start` with method `oauth` and intent `add`.
- Then: The response is HTTP 400 with exactly `{ error: { message: test-oauth-device connector does not use an auth-code grant, code: BAD_REQUEST } }`.

## connectors-oauth-start-090

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > returns 400 when starting OAuth with a missing selected auth method"
- Mode: run
- Given: A signed-in workspace member targets `github`, which has no `api-token` method.
- When: The member sends `POST /api/connectors/github/oauth/start` with method `api-token` and intent `add`.
- Then: The response is HTTP 400 with exactly `{ error: { message: github connector does not have api-token auth method, code: BAD_REQUEST } }`.

## connectors-oauth-start-091

- Vitest: "POST /api/connectors/:connectorSlug/oauth/start > returns 403 when the auth method lacks executable platform configuration"
- Mode: run
- Given: A signed-in workspace member targets `github`, but the deployment has no GitHub OAuth client ID configured.
- When: The member sends `POST /api/connectors/github/oauth/start` with method `oauth` and intent `add`.
- Then: The response is HTTP 403 with exactly `{ error: { message: github connector is not available, code: FORBIDDEN } }`.
