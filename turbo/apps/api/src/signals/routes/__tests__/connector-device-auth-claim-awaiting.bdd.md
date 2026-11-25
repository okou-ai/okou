# connector-device-auth-claim-awaiting

## connector-device-auth-claim-awaiting-001

- Vitest: "Builtin device-auth awaiting restoration > preserves strict pending, slow-down and failed-poll intervals while recovering the exact non-default account"
- Mode: run
- Given: An authenticated owner has a default and non-default OAuth device account. A reconnect for the sibling starts with provider interval two seconds. The provider responds in order with authorization_pending, slow_down, malformed success, then a valid credential.
- When: The owner uses POST /api/connectors/:slug/oauth/device/sessions/:sessionId/poll at T+2, T+3.999, T+4, T+10.999, T+11, T+17.999 and T+18 seconds, then replays.
- Then: HTTP 200 pending carries interval 2 at 2 and 3.999 seconds, then interval 7 at 4 and 10.999 seconds. The due request at 11 seconds returns HTTP 500 Internal server error. Account identities and default role stay unchanged. At 17.999 seconds it is still HTTP 200 pending with interval 7. At 18 seconds the session completes for the same non-default account and replays identically, without exposing credentials.

## connector-device-auth-claim-awaiting-002

- Vitest: "Builtin device-auth awaiting restoration > does not restore a superseded claim after its old pending provider response or disturb the replacement account"
- Mode: run
- Given: An authenticated owner starts a device OAuth session. Its first poll is waiting on a provider response of HTTP 400 authorization_pending.
- When: The owner starts and completes a replacement session with read and replacement scopes, then receives the old response and checks both sessions via POST /api/connectors/:slug/oauth/device/sessions/:sessionId/poll.
- Then: Both the original request and old replay return HTTP 200 with status error, code session_superseded and the message OAuth device authorization session was superseded. The replacement replays identically with read and replacement scopes, and its account is the only saved default.

## connector-device-auth-claim-awaiting-003

- Vitest: "Builtin device-auth awaiting restoration > does not restore a superseded claim after its old malformed provider response or disturb the replacement account"
- Mode: run
- Given: An authenticated owner starts a device OAuth session. Its first poll is waiting on a provider response of HTTP 200 with empty JSON.
- When: The owner starts and completes a replacement session with read and replacement scopes, then receives the old response and checks both sessions via POST /api/connectors/:slug/oauth/device/sessions/:sessionId/poll.
- Then: Both the original request and old replay return HTTP 200 with status error, code session_superseded and the message OAuth device authorization session was superseded. The replacement replays identically with read and replacement scopes, and its account is the only saved default.
