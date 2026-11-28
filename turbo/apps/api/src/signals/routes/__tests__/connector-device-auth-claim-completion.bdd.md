# connector-device-auth-claim-completion

## connector-device-auth-claim-completion-001

- Vitest: "Builtin device-auth retained-claim completion > preserves the replacement's exact non-default account and scopes after an obsolete successful reconnect"
- Mode: run
- Given: An authenticated owner has a default and a different non-default OAuth device connector account, both with read and baseline scopes. A successful provider response with read and obsolete scopes is delayed for a reconnect to the sibling.
- When: The owner polls using POST /api/connectors/:slug/oauth/device/sessions/:sessionId/poll, starts and finishes a replacement reconnect with read and replacement scopes for the same account, releases the old response and polls both sessions again.
- Then: The replacement completes against the exact sibling and replays identically. The delayed request and old replay both return HTTP 200 with status error, code session_superseded and the message OAuth device authorization session was superseded. The listed default retains its original scopes and the sibling has only read and replacement scopes.

## connector-device-auth-claim-completion-002

- Vitest: "Builtin device-auth retained-claim completion > keeps the winning reclaimed reconnect pending without publishing the obsolete successful scopes"
- Mode: run
- Given: An authenticated owner has default and non-default accounts with read and baseline scopes. A reconnect to the sibling uses a three-second interval. Its first poll at three seconds has a delayed successful provider response with obsolete scopes.
- When: At 30,001 ms after the first poll the owner re-polls through POST /api/connectors/:slug/oauth/device/sessions/:sessionId/poll, and the provider holds the new response too. The old response is released first, then the newer response carrying read and winner scopes.
- Then: The old request and an interim poll return HTTP 200 pending with interval 3, and the account list still shows both accounts with baseline scopes. The newer poll completes the existing connected oauth sibling with read and winner scopes and replays identically. The default retains its original scopes and role.
