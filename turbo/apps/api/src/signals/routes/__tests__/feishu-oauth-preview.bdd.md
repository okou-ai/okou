# feishu-oauth-preview

## feishu-oauth-preview-001

- Vitest: "Custom OAuth state preview > preserves a standard OAuth nonce rejected by the Feishu callback until its own completion"
- Mode: run
- Given: A signed-in organization admin created a custom connector with standard OAuth, a provider token exchange, and read scope. OAuth start returned a 64-character hexadecimal nonce. The connector has no accounts.
- When: A browser submits that nonce and a code to `GET /api/integrations/feishu/oauth/callback` in JSON mode. The caller then completes the standard custom-connector callback with the original nonce and retries the Feishu callback.
- Then: The first Feishu callback returns HTTP 400 with `Invalid or expired connect state`, exchanges no token, and leaves the accounts list empty. The standard callback returns `status: success` and `username: null`, exchanges one token, and creates one connected OAuth account for that custom connector. The Feishu replay again returns HTTP 400 without another exchange or any account change.
