# webhooks-agent-firewall-auth-google-analytics

## webhooks-agent-firewall-auth-google-analytics-001

- Vitest: "Google Analytics quiet refresh recovery > retries authorization_expired_or_revoked and recovers the exact account"
- Mode: run
- Given: A Pro workspace member connected two Google Analytics accounts through Google OAuth, the first and a sibling, and has a chat Run dispatched with a firewall that injects the Analytics token. Google rejects refreshes of the first account's refresh token with HTTP 400 `invalid_grant` without a subtype; later Google accepts that same refresh token, and a reconnect issues a new refresh token.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` for the first account with `forceRefresh`, then (after the member makes the sibling the default) without and with `forceRefresh`, then for the sibling; after Google recovers it requests the first account without `forceRefresh`; the member reconnects that account through OAuth and the firewall requests it without and then with `forceRefresh`.
- Then: All three requests for the first account return HTTP 502 with `TOKEN_REFRESH_FAILED`, failure reason `reconnect_required` and connector `google-analytics`, each with one refresh attempt. The first account is `reconnect-required` with reason `authorization_expired_or_revoked`, while the sibling stays `connected` and returns its own access token without a refresh. The quiet retry with the same refresh token returns HTTP 200 with `analytics-recovered-without-reconnect` and the account is `connected`. After the reconnect (same account ID, `connected`, no reason) the firewall returns `analytics-reconnected`, and the forced refresh uses the new refresh token and returns `analytics-refreshed`.

## webhooks-agent-firewall-auth-google-analytics-002

- Vitest: "Google Analytics quiet refresh recovery > retries provider_session_expired and recovers the exact account"
- Mode: run
- Given: A Pro workspace member connected two Google Analytics accounts through Google OAuth, the first and a sibling, and has a chat Run dispatched with a firewall that injects the Analytics token. Google rejects refreshes of the first account's refresh token with HTTP 400 `invalid_grant` and subtype `invalid_rapt`; later Google accepts that same refresh token, and a reconnect issues a new refresh token.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` for the first account with `forceRefresh`, then (after the member makes the sibling the default) without and with `forceRefresh`, then for the sibling; after Google recovers it requests the first account without `forceRefresh`; the member reconnects that account through OAuth and the firewall requests it without and then with `forceRefresh`.
- Then: All three requests for the first account return HTTP 502 with `TOKEN_REFRESH_FAILED`, failure reason `reconnect_required` and connector `google-analytics`, each with one refresh attempt. The first account is `reconnect-required` with reason `provider_session_expired`, while the sibling stays `connected` and returns its own access token without a refresh. The quiet retry with the same refresh token returns HTTP 200 with `analytics-recovered-without-reconnect` and the account is `connected`. After the reconnect (same account ID, `connected`, no reason) the firewall returns `analytics-reconnected`, and the forced refresh uses the new refresh token and returns `analytics-refreshed`.

## webhooks-agent-firewall-auth-google-analytics-003

- Vitest: "Google Analytics quiet refresh recovery > keeps unknown subtype observable and recoverable"
- Mode: run
- Given: A Pro workspace member has a connected Google Analytics account and a chat Run with a firewall that injects the Analytics token. Google rejects refreshes with HTTP 400 `invalid_grant` and the unknown subtype `unknown_policy`, and later recovers.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` twice, the member lists the Analytics accounts, and the firewall sends another forced request after Google recovers.
- Then: Both requests return HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `reconnect_required`, with two refresh attempts in total. The account has no reconnect reason. After recovery the request returns HTTP 200 with `Authorization: Bearer analytics-recovered`.

## webhooks-agent-firewall-auth-google-analytics-004

- Vitest: "Google Analytics quiet refresh recovery > keeps unknown OAuth error observable and recoverable"
- Mode: run
- Given: A Pro workspace member has a connected Google Analytics account and a chat Run with a firewall that injects the Analytics token. Google rejects refreshes with HTTP 400 `invalid_client`, and later recovers.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` twice, the member lists the Analytics accounts, and the firewall sends another forced request after Google recovers.
- Then: Both requests return HTTP 502 with `TOKEN_REFRESH_FAILED` and no failure reason, with two refresh attempts in total. The account has no reconnect reason. After recovery the request returns HTTP 200 with `Authorization: Bearer analytics-recovered`.

## webhooks-agent-firewall-auth-google-analytics-005

- Vitest: "Google Analytics quiet refresh recovery > keeps provider outage observable and recoverable"
- Mode: run
- Given: A Pro workspace member has a connected Google Analytics account and a chat Run with a firewall that injects the Analytics token. Google rejects refreshes with HTTP 503 `server_error`, and later recovers.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` twice, the member lists the Analytics accounts, and the firewall sends another forced request after Google recovers.
- Then: Both requests return HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, with two refresh attempts in total. The account has no reconnect reason. After recovery the request returns HTTP 200 with `Authorization: Bearer analytics-recovered`.

## webhooks-agent-firewall-auth-google-analytics-006

- Vitest: "Google Analytics quiet refresh recovery > keeps rate limit observable and recoverable"
- Mode: run
- Given: A Pro workspace member has a connected Google Analytics account and a chat Run with a firewall that injects the Analytics token. Google rejects refreshes with HTTP 429 `temporarily_unavailable`, and later recovers.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` twice, the member lists the Analytics accounts, and the firewall sends another forced request after Google recovers.
- Then: Both requests return HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, with two refresh attempts in total. The account has no reconnect reason. After recovery the request returns HTTP 200 with `Authorization: Bearer analytics-recovered`.

## webhooks-agent-firewall-auth-google-analytics-007

- Vitest: "Google Analytics quiet refresh recovery > keeps unexpected invalid_grant status observable and recoverable"
- Mode: run
- Given: A Pro workspace member has a connected Google Analytics account and a chat Run with a firewall that injects the Analytics token. Google rejects refreshes with an unexpected HTTP 503 carrying `invalid_grant`, and later recovers.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` twice, the member lists the Analytics accounts, and the firewall sends another forced request after Google recovers.
- Then: Both requests return HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `reconnect_required`, with two refresh attempts in total. The account's reconnect reason is `authorization_expired_or_revoked`. After recovery the request returns HTTP 200 with `Authorization: Bearer analytics-recovered`.
