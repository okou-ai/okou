# provider-console-paths

## provider-console-paths-001

- Vitest: "provider console paths > GET /api/integrations/teams/oauth/callback > builds the failure redirect for a denied authorization"
- Mode: run
- Given: Microsoft Teams OAuth is configured and the app is served at `https://app.okou.test`. The user denied authorization at Microsoft.
- When: The browser is redirected to `GET /api/integrations/teams/oauth/callback?error=access_denied`.
- Then: The response is HTTP 307 with an empty body and `location` `https://app.okou.test/settings/teams?error=access_denied`.

## provider-console-paths-002

- Vitest: "provider console paths > GET /api/integrations/feishu/oauth/callback > rejects a callback without connect state"
- Mode: run
- Given: An unauthenticated browser arrives without any Feishu connect state.
- When: The browser requests `GET /api/integrations/feishu/oauth/callback` with no query parameters.
- Then: The response is HTTP 400 with no redirect and body `{"error":"Invalid or expired connect state"}`.

## provider-console-paths-003

- Vitest: "provider console paths > POST /api/webhooks/slack/commands > rejects an unsigned request"
- Mode: run
- Given: Slack request signing is configured, and a caller sends a form-encoded `/okou help` command without Slack signature headers.
- When: The caller sends `POST /api/webhooks/slack/commands`.
- Then: The response is HTTP 401 with no redirect and body `{"error":"Missing Slack signature headers"}`.

## provider-console-paths-004

- Vitest: "provider console paths > POST /api/webhooks/slack/interactive > rejects an unsigned request"
- Mode: run
- Given: Slack request signing is configured, and a caller sends a form-encoded body without Slack signature headers or a payload.
- When: The caller sends `POST /api/webhooks/slack/interactive`.
- Then: The response is HTTP 401 with no redirect and body `{"error":"Missing Slack signature headers"}`.
