# feishu-oauth-state

## feishu-oauth-state-001

- Vitest: "Feishu OAuth state > preserves the 10-minute expiration boundary"
- Mode: run
- Given: A Feishu OAuth connect state carries a valid signature for this deployment and names an app callback and an installation that does not exist.
- When: The browser requests `GET /api/feishu/oauth/connect` using state issued exactly 10 minutes earlier, then using state issued 10 minutes and 1 second earlier.
- Then: Both requests return HTTP 400. At exactly 10 minutes the message is `Feishu bot not found`. One second later it is `Invalid or expired connect state`.

## feishu-oauth-state-002

- Vitest: "Feishu OAuth state > rejects a state signed with a different secret"
- Mode: run
- Given: The browser holds a current Feishu app-connect state signed with a key different from the deployment's configured key.
- When: The browser sends the state to `GET /api/feishu/oauth/connect`.
- Then: The API returns HTTP 400 with `Invalid or expired connect state`.
