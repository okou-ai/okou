# connector-device-auth-session-expiration

## connector-device-auth-session-expiration-001

- Vitest: "Builtin device-auth session expiration > expires an exact non-default reconnect only after its deadline and preserves both accounts through recovery"
- Mode: run
- Given: An authenticated owner has two device OAuth accounts. A reconnect to the non-default account has a 60-second lifetime and its provider remains pending.
- When: The owner polls through POST /api/connectors/:slug/oauth/device/sessions/:sessionId/poll at the exact deadline and one millisecond later, retries after the provider recovers, then starts and completes a new reconnect to the same ID and rechecks the original session.
- Then: The exact deadline returns HTTP 200 pending with interval 0. From one millisecond later, the original session consistently returns HTTP 200 with expired status, expired_token and message OAuth device authorization session expired. The recovery completes for the same non-default account and readback before and after recovery retains both IDs and the original default.

## connector-device-auth-session-expiration-002

- Vitest: "Builtin device-auth session expiration > preserves a fresh poll past expiry then expires at the freshness boundary without publishing its late successful account"
- Mode: run
- Given: An authenticated owner starts a one-second device OAuth session with interval zero. Its first poll reaches the provider and a successful response is delayed.
- When: The owner polls through POST /api/connectors/:slug/oauth/device/sessions/:sessionId/poll at T+29,999 ms and T+30,000 ms, then the provider releases the original response and the owner polls again.
- Then: At 29,999 ms the response is HTTP 200 pending with interval 0 despite the session deadline. At 30,000 ms and afterwards each poll and the delayed original request return HTTP 200 with expired status, expired_token and message OAuth device authorization session expired. The account list stays empty.
