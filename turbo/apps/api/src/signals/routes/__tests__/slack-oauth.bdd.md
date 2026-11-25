# slack-oauth

## slack-oauth-001

- Vitest: "Slack authorization entry > returns the authenticated settings entry for a named install link"
- Mode: run
- Given: The web URL is `https://www.okou.ai`, the App URL is `https://app.okou.ai`, and Slack OAuth client credentials are configured.
- When: A browser requests `GET /api/slack/oauth/install?orgId=org_from_link&userId=user_from_link` (row `install`).
- Then: The response is HTTP 307 to `https://app.okou.ai/settings/slack` with `cache-control: no-store`.

## slack-oauth-002

- Vitest: "Slack authorization entry > returns the authenticated settings entry for a named connect link"
- Mode: run
- Given: The web URL is `https://www.okou.ai`, the App URL is `https://app.okou.ai`, and Slack OAuth client credentials are configured.
- When: A browser requests `GET /api/slack/oauth/connect?orgId=org_from_link&userId=user_from_link` (row `connect`).
- Then: The response is HTTP 307 to `https://app.okou.ai/settings/slack` with `cache-control: no-store`.

## slack-oauth-003

- Vitest: "Slack authorization entry > returns settings for an incomplete identity link containing orgId="
- Mode: run
- Given: The App URL is `https://app.okou.ai` and Slack OAuth client credentials are configured.
- When: A browser requests `GET /api/slack/oauth/install?orgId=` with an empty organization ID (row `orgId=`).
- Then: The response redirects to `https://app.okou.ai/settings/slack`.

## slack-oauth-004

- Vitest: "Slack authorization entry > returns settings for an incomplete identity link containing userId="
- Mode: run
- Given: The App URL is `https://app.okou.ai` and Slack OAuth client credentials are configured.
- When: A browser requests `GET /api/slack/oauth/install?userId=` with an empty user ID (row `userId=`).
- Then: The response redirects to `https://app.okou.ai/settings/slack`.

## slack-oauth-005

- Vitest: "GET /api/slack/oauth/install > redirects to Slack OAuth with bot scopes and callback URI"
- Mode: run
- Given: The web URL is `https://www.okou.ai` and the Slack OAuth client ID is `test-slack-client-id`.
- When: A browser requests `GET /api/slack/oauth/install` without identity parameters.
- Then: The response is HTTP 307 to `https://slack.com/oauth/v2/authorize` with the client ID, `redirect_uri` `https://api.okou.ai/api/integrations/slack/oauth/callback`, and bot scopes including `app_mentions:read`, `chat:write`, `assistant:write`, `channels:history`, `im:history`, `im:read`, `commands`, `users:read`, `files:read`, `files:write`, `links:read` and `links:write`. The signed state carries flow `install` and that redirect URI, and the response has `cache-control: no-store`.

## slack-oauth-006

- Vitest: "GET /api/slack/oauth/install > uses the configured API origin with production web baselines"
- Mode: run
- Given: Slack OAuth is configured with production web origin `https://www.okou.ai`.
- When: `GET /api/slack/oauth/install` is requested on `https://api.okou.ai` with `x-okou-web-origin: https://www.okou.ai`.
- Then: The response is HTTP 307 with `redirect_uri` `https://api.okou.ai/api/integrations/slack/oauth/callback`.

## slack-oauth-007

- Vitest: "GET /api/slack/oauth/install > accepts the exact okou.ai web origin for a shared Okou start"
- Mode: run
- Given: Slack OAuth is configured with production web origin `https://www.okou.ai`.
- When: `GET /api/slack/oauth/install` is requested on `https://api.okou.ai` with `x-okou-web-origin: https://okou.ai`.
- Then: The response is HTTP 307 to `https://slack.com` with `redirect_uri` `https://api.okou.ai/api/integrations/slack/oauth/callback`.

## slack-oauth-008

- Vitest: "GET /api/slack/oauth/install > trusts okou.ai subdomains for shared Okou starts"
- Mode: run
- Given: Slack OAuth is configured with production web origin `https://www.okou.ai`.
- When: `GET /api/slack/oauth/install` is requested on `https://api.okou.ai` with `x-okou-web-origin: https://console.okou.ai`.
- Then: The response is HTTP 307 to `https://slack.com` with `redirect_uri` `https://api.okou.ai/api/integrations/slack/oauth/callback`.

## slack-oauth-009

- Vitest: "GET /api/slack/oauth/install > does not accept a callback host from untrusted request headers"
- Mode: run
- Given: Slack OAuth is configured with production web origin `https://www.okou.ai`.
- When: `GET /api/slack/oauth/install` is requested on `https://api.okou.ai` with `x-okou-web-origin: https://evil.example`.
- Then: The response is HTTP 307 to `https://slack.com` with `redirect_uri` still `https://api.okou.ai/api/integrations/slack/oauth/callback`.

## slack-oauth-010

- Vitest: "GET /api/slack/oauth/install > does not trust lookalike okou.ai web origins"
- Mode: run
- Given: Slack OAuth is configured with production web origin `https://www.okou.ai`.
- When: `GET /api/slack/oauth/install` is requested on `https://api.okou.ai` with `x-okou-web-origin: https://okou.ai.evil.example`.
- Then: The response is HTTP 307 to `https://slack.com` with `redirect_uri` still `https://api.okou.ai/api/integrations/slack/oauth/callback`.

## slack-oauth-011

- Vitest: "GET /api/integrations/slack/oauth/callback > rejects a tampered signed redirect URI"
- Mode: run
- Given: An install flow was started and its signed state payload is altered to redirect to `https://evil.example/api/integrations/slack/oauth/callback` while keeping the original signature.
- When: Slack's redirect calls `GET /api/integrations/slack/oauth/callback` with a code and the tampered state.
- Then: The response is HTTP 307 to `/settings/slack`, and no Slack OAuth code exchange happens.

## slack-oauth-012

- Vitest: "GET /api/integrations/slack/oauth/callback > rejects an expired signed OAuth state"
- Mode: run
- Given: An install flow was started and the clock then advances 15 minutes and 1 second.
- When: Slack's redirect calls `GET /api/integrations/slack/oauth/callback` with a code and the original state.
- Then: The response is HTTP 307 to `/settings/slack` with error "Invalid OAuth state. Please reconnect Slack from settings.", and no Slack OAuth code exchange happens.

## slack-oauth-013

- Vitest: "GET /api/integrations/slack/oauth/callback > rejects missing state"
- Mode: run
- Given: Slack OAuth is configured and the App URL is `https://app.okou.ai`.
- When: `GET /api/integrations/slack/oauth/callback` is requested on `https://okou.ai` with a code and no state (row `missing`).
- Then: The response is HTTP 307 to `https://app.okou.ai/settings/slack` with error "Invalid OAuth state. Please reconnect Slack from settings.", and no code exchange happens.

## slack-oauth-014

- Vitest: "GET /api/integrations/slack/oauth/callback > rejects malformed state"
- Mode: run
- Given: Slack OAuth is configured and the App URL is `https://app.okou.ai`.
- When: `GET /api/integrations/slack/oauth/callback` is requested on `https://okou.ai` with a code and state `not-json` (row `malformed`).
- Then: The response is HTTP 307 to `https://app.okou.ai/settings/slack` with error "Invalid OAuth state. Please reconnect Slack from settings.", and no code exchange happens.

## slack-oauth-015

- Vitest: "GET /api/integrations/slack/oauth/callback > uses the configured app for provider errors with malformed state"
- Mode: run
- Given: Slack OAuth is configured and the App URL is `https://app.okou.ai`.
- When: `GET /api/integrations/slack/oauth/callback` is requested on `https://okou.ai` with `error=access_denied` and state `not-json`.
- Then: The response is HTTP 307 to `https://app.okou.ai/settings/slack` with error `access_denied`, and no code exchange happens.

## slack-oauth-016

- Vitest: "GET /api/integrations/slack/oauth/callback > keeps preview OAuth start and callback handling on the preview API"
- Mode: run
- Given: A preview deployment uses API origin `https://pr-22539-api.vm6.ai` and App origin `https://pr-22539-app.omby.ai`, and Slack's code exchange returns `invalid_code`.
- When: The install flow starts with `GET /api/slack/oauth/install` on the preview API and Slack redirects to `GET /api/integrations/slack/oauth/callback` there with the issued state.
- Then: The start redirects HTTP 307 to `https://slack.com` with the preview API's callback as `redirect_uri`. The callback redirects HTTP 307 to the preview App's `/settings/slack`, and the code exchange used the preview callback as `redirect_uri`.

## slack-oauth-017

- Vitest: "GET /api/integrations/slack/oauth/callback > creates an unbound installation from an unscoped install state"
- Mode: run
- Given: An unscoped install flow was started, and Slack's code exchange succeeds for a new workspace and Slack user.
- When: Slack redirects to `GET /api/integrations/slack/oauth/callback` with a code and the install state.
- Then: The response is HTTP 307 to `https://app.okou.ai/settings/slack` with `w` set to the workspace ID and `u` set to the Slack user ID.

## slack-oauth-018

- Vitest: "GET /api/integrations/slack/oauth/callback > redirects to the failed page when the install OAuth exchange fails"
- Mode: run
- Given: An unscoped install flow was started, and Slack's code exchange fails with `invalid_code`.
- When: Slack redirects to `GET /api/integrations/slack/oauth/callback` with an expired code and the install state.
- Then: The response is HTTP 307 to `https://app.okou.ai/settings/slack` with a message containing "Failed to complete Slack installation".

## slack-oauth-019

- Vitest: "GET /api/integrations/slack/oauth/callback > rejects an install OAuth response without a workspace ID"
- Mode: run
- Given: An unscoped install flow was started, and Slack's code exchange succeeds without a workspace ID.
- When: Slack redirects to `GET /api/integrations/slack/oauth/callback` with a code and the install state.
- Then: The response is HTTP 307 to `https://app.okou.ai/settings/slack` with a message containing "Failed to complete Slack installation".

## slack-oauth-020

- Vitest: "GET /api/integrations/slack/oauth/callback > rejects an install OAuth response without an authenticated user ID"
- Mode: run
- Given: An unscoped install flow was started, and Slack's code exchange succeeds for workspace `T_MISSING_AUTHENTICATED_USER` without an authenticated user.
- When: Slack redirects to `GET /api/integrations/slack/oauth/callback` with a code and the install state.
- Then: The response is HTTP 307 to `https://app.okou.ai/settings/slack` with a message containing "Failed to complete Slack installation".

## slack-oauth-021

- Vitest: "GET /api/integrations/slack/oauth/callback > redirects Slack errors"
- Mode: run
- Given: Slack OAuth is configured and the App URL is `https://app.okou.ai`.
- When: Slack redirects to `GET /api/integrations/slack/oauth/callback?error=access_denied` without state.
- Then: The response is HTTP 307 to exactly `https://app.okou.ai/settings/slack?error=access_denied`.
