# connector-device-auth-session-claim

## connector-device-auth-session-claim-001

- Vitest: "Builtin device-auth initial poll claims > recovers a failed reconnect into the exact non-default account without changing its sibling"
- Mode: run
- Given: An authenticated owner has default and non-default device OAuth accounts. The provider returns an empty JSON success body on the first reconnect attempt for the sibling, then begins returning a usable grant.
- When: The owner starts a reconnect for the sibling, polls via POST /api/connectors/:slug/oauth/device/sessions/:sessionId/poll, reads the accounts, and retries and replays the same session.
- Then: The first poll returns HTTP 500 Internal server error. Account IDs and default designation stay intact. Once the provider recovers, the same session completes and replays over HTTP 200 for the connected non-default oauth account, without exposing credentials or the session token.

## connector-device-auth-session-claim-002

- Vitest: "Builtin device-auth initial poll claims > enforces identity and the strict stale boundary before preserving the winning reclaimed account"
- Mode: run
- Given: An authenticated owner starts a device OAuth add session and holds its first provider token response. A different user in the same workspace and the same user in another workspace are also available.
- When: Callers poll using POST /api/connectors/:slug/oauth/device/sessions/:sessionId/poll with the wrong user, organization, connector or token. The owner polls with the exact identity at 30,000 and 30,001 ms after the first request, with the later provider response granting read and reclaimed scopes. The original response is then released.
- Then: The wrong identities return HTTP 404 NOT_FOUND with the device session not found message. The exact poll at 30,000 ms reports HTTP 200 pending with interval 0 and no account is stored. The later poll completes with the reclaimed scopes. The original poll returns pending with interval 0 and later valid replay returns the winning result. The one listed account is the connected default OAuth account with the reclaimed scopes.
