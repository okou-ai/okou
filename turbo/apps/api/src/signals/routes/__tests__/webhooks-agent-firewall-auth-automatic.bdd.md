# webhooks-agent-firewall-auth-automatic

## webhooks-agent-firewall-auth-automatic-001

- Vitest: "builtin Automatic firewall credential destinations > refreshes labels for the same verified principal"
- Mode: run
- Given: A Pro workspace member connected a builtin Automatic MCP connector through CIMD OAuth as subject `builtin-refresh-user` with username `builtin-before-refresh` and a preserved e-mail. The provider publishes resource metadata only at its challenged URL, and its refresh grant returns the same subject with the username `builtin-after-refresh`. The member has a chat Run dispatched with the builtin firewall.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` for the matched connector account, and the member reads `GET /api/connector-accounts/:connectionId`.
- Then: The firewall request returns HTTP 200 with the header `Authorization: Bearer automatic-refreshed-access-token`. The account shows external ID `builtin-refresh-user`, username `builtin-after-refresh`, the preserved e-mail, status `connected` and no reconnect reason.

## webhooks-agent-firewall-auth-automatic-002

- Vitest: "builtin Automatic firewall credential destinations > updates a different verified principal without requiring reconnect"
- Mode: run
- Given: A Pro workspace member connected a builtin Automatic MCP connector through CIMD OAuth as subject `builtin-refresh-user` with username `builtin-before-refresh` and a preserved e-mail. The provider's refresh grant now verifies a different subject, `builtin-other-user`, with the username `builtin-after-refresh`. The member has a chat Run dispatched with the builtin firewall.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` for the matched connector account, and the member reads `GET /api/connector-accounts/:connectionId`.
- Then: The firewall request returns HTTP 200 with `Authorization: Bearer automatic-refreshed-access-token`. The account shows external ID `builtin-other-user`, username `builtin-after-refresh`, the preserved e-mail, status `connected` and no reconnect reason, so no reconnect is required.

## webhooks-agent-firewall-auth-automatic-003

- Vitest: "builtin Automatic firewall credential destinations > preserves a valid account after a plain token rejection"
- Mode: run
- Given: A Pro workspace member connected a builtin Automatic MCP connector through CIMD OAuth as subject `builtin-refresh-user` with username `builtin-before-refresh`. The provider's token endpoint rejects the refresh with HTTP 401 and a plain-text body. The member has a chat Run dispatched with the builtin firewall.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh`, and the member reads `GET /api/connector-accounts/:connectionId`.
- Then: The firewall request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`. The account keeps external ID `builtin-refresh-user`, username `builtin-before-refresh`, the preserved e-mail, status `connected` and no reconnect reason.

## webhooks-agent-firewall-auth-automatic-004

- Vitest: "builtin Automatic firewall credential destinations > preserves a valid account after an incompatible token response"
- Mode: run
- Given: A Pro workspace member connected a builtin Automatic MCP connector through CIMD OAuth as subject `builtin-refresh-user` with username `builtin-before-refresh`. The provider's token endpoint answers the refresh with HTTP 200 but a plain-text body that is not an OAuth token response. The member has a chat Run dispatched with the builtin firewall.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh`, and the member reads `GET /api/connector-accounts/:connectionId`.
- Then: The firewall request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`. The account keeps external ID `builtin-refresh-user`, username `builtin-before-refresh`, the preserved e-mail, status `connected` and no reconnect reason.

## webhooks-agent-firewall-auth-automatic-005

- Vitest: "builtin Automatic firewall credential destinations > rejects a DCR retired through public reconnect while refresh discovery is pending"
- Mode: run
- Given: A Pro workspace member connected a builtin Automatic MCP connector through dynamic client registration (DCR) and started a reconnect for that account. The provider's resource-metadata discovery is slow, and the provider rejects the reconnect's authorization code with `invalid_client`. The member has a chat Run dispatched with the builtin firewall.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh`; while discovery is pending the reconnect callback `GET /api/connectors/automatic/callback` completes, the member reads `GET /api/connector-accounts/:connectionId`, and discovery then finishes.
- Then: The reconnect callback returns status `error` and the account becomes `reconnect-required` with reason `authorization_expired_or_revoked`. The pending firewall request then returns HTTP 502 with `TOKEN_REFRESH_FAILED`, failure reason `reconnect_required` and the connector slug, and the account remains `reconnect-required`.

## webhooks-agent-firewall-auth-automatic-006

- Vitest: "builtin Automatic firewall credential destinations > publishes omitted fields and overlapping refreshes without resurrecting deleted cimd accounts"
- Mode: run
- Given: A Pro workspace member connected a builtin Automatic MCP connector through CIMD OAuth. The provider's refresh grant returns access tokens without a new refresh token; the first omits expiry and scope, later ones include an expiry of attempt × 3600 seconds and the scope `read write`, and the account is deleted during the fourth refresh. The member has a chat Run dispatched with the builtin firewall.
- When: The Run's firewall calls `POST /api/webhooks/run/firewall/auth` with `forceRefresh`, without it, twice concurrently with `forceRefresh`, without it again, and once more with `forceRefresh`; the member reads `GET /api/connector-accounts/:connectionId` between steps.
- Then: The first refresh returns `Bearer omitted-refresh-token-1` and the account keeps its identity with status `connected`, a null token expiry and scopes `read` and `write`; the non-forced request reuses that token. The concurrent refreshes return tokens 2 and 3, and the current credential and account expiry match whichever was published. All three refreshes sent the original stored refresh token. The refresh during deletion returns HTTP 502 with `TOKEN_REFRESH_FAILED` and `reconnect_required`, and the account then returns HTTP 404.

## webhooks-agent-firewall-auth-automatic-007

- Vitest: "builtin Automatic firewall credential destinations > publishes omitted fields and overlapping refreshes without resurrecting deleted dcr accounts"
- Mode: run
- Given: A Pro workspace member connected a builtin Automatic MCP connector through DCR OAuth. The provider's refresh grant returns access tokens without a new refresh token; the first omits expiry and scope, later ones include an expiry of attempt × 3600 seconds and the scope `read write`, and the account is deleted during the fourth refresh. The member has a chat Run dispatched with the builtin firewall.
- When: The Run's firewall calls `POST /api/webhooks/run/firewall/auth` with `forceRefresh`, without it, twice concurrently with `forceRefresh`, without it again, and once more with `forceRefresh`; the member reads `GET /api/connector-accounts/:connectionId` between steps.
- Then: The first refresh returns `Bearer omitted-refresh-token-1` and the account keeps its identity with status `connected`, a null token expiry and scopes `read` and `write`; the non-forced request reuses that token. The concurrent refreshes return tokens 2 and 3, and the current credential and account expiry match whichever was published. All three refreshes sent the original stored refresh token. The refresh during deletion returns HTTP 502 with `TOKEN_REFRESH_FAILED` and `reconnect_required`, and the account then returns HTTP 404.

## webhooks-agent-firewall-auth-automatic-008

- Vitest: "builtin Automatic firewall credential destinations > classifies Automatic refresh provider failure"
- Mode: run
- Given: A Pro workspace member connected a builtin Automatic MCP connector through CIMD OAuth, with the OAuth `resource` parameter bound to the endpoint origin. The provider's refresh grant always fails with HTTP 503 `temporarily_unavailable`. The member has a chat Run dispatched with the builtin firewall.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh`, and the member reads `GET /api/connector-accounts/:connectionId`.
- Then: The authorization URL and code exchange carried the bound resource. The firewall request returns HTTP 502 with `TOKEN_REFRESH_FAILED`, failure reason `upstream_provider` and the connector slug, and the account stays `connected` with no reconnect reason.

## webhooks-agent-firewall-auth-automatic-009

- Vitest: "builtin Automatic firewall credential destinations > classifies Automatic refresh recovery"
- Mode: run
- Given: A Pro workspace member connected a builtin Automatic MCP connector through CIMD OAuth, with the `resource` parameter bound to the endpoint origin. The provider's refresh grant fails with HTTP 503 on the first attempt and then returns `recovered-automatic-token`. The member has a chat Run dispatched with the builtin firewall.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` twice.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED`, failure reason `upstream_provider` and the connector slug. The second returns HTTP 200 with `Authorization: Bearer recovered-automatic-token`, and the latest refresh request carried the bound resource.

## webhooks-agent-firewall-auth-automatic-010

- Vitest: "builtin Automatic firewall credential destinations > classifies Automatic refresh DCR rejection"
- Mode: run
- Given: A Pro workspace member connected a builtin Automatic MCP connector through DCR OAuth, and the provider rejects every refresh with HTTP 400 `invalid_client`. The member has a chat Run dispatched with the builtin firewall.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh`, and the member reads `GET /api/connector-accounts/:connectionId`.
- Then: The firewall request returns HTTP 502 with `TOKEN_REFRESH_FAILED`, failure reason `reconnect_required` and the connector slug. The account becomes `reconnect-required` with reason `authorization_expired_or_revoked`.

## webhooks-agent-firewall-auth-automatic-011

- Vitest: "builtin Automatic firewall credential destinations > classifies Automatic refresh DCR expiry"
- Mode: run
- Given: A Pro workspace member connected a builtin Automatic MCP connector through DCR OAuth whose client secret expires 60 seconds after connection, and the clock then advances 61 seconds. The member has a chat Run dispatched with the builtin firewall.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh`, and the member reads `GET /api/connector-accounts/:connectionId`.
- Then: The firewall request returns HTTP 502 with `TOKEN_REFRESH_FAILED`, failure reason `reconnect_required` and the connector slug. The account becomes `reconnect-required` with reason `authorization_expired_or_revoked`.

## webhooks-agent-firewall-auth-automatic-012

- Vitest: "builtin Automatic firewall credential destinations > classifies Automatic refresh resource drift"
- Mode: run
- Given: A Pro workspace member connected a builtin Automatic MCP connector through CIMD OAuth bound to the endpoint origin as its resource. The provider's metadata is then rediscovered with the full endpoint URL as the resource. The member has a chat Run dispatched with the builtin firewall.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh`, and the member reads `GET /api/connector-accounts/:connectionId`.
- Then: The firewall request returns HTTP 502 with `TOKEN_REFRESH_FAILED`, failure reason `reconnect_required` and the connector slug, and no token request reaches the rediscovered authority. The account becomes `reconnect-required` with reason `authorization_expired_or_revoked`.

## webhooks-agent-firewall-auth-automatic-013

- Vitest: "builtin Automatic firewall credential destinations > classifies Automatic refresh issuer drift"
- Mode: run
- Given: A Pro workspace member connected a builtin Automatic MCP connector through CIMD OAuth. The provider's metadata is then rediscovered with a replacement issuer. The member has a chat Run dispatched with the builtin firewall.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh`, and the member reads `GET /api/connector-accounts/:connectionId`.
- Then: The firewall request returns HTTP 502 with `TOKEN_REFRESH_FAILED`, failure reason `reconnect_required` and the connector slug, and no token request reaches the rediscovered authority. The account becomes `reconnect-required` with reason `authorization_expired_or_revoked`.

## webhooks-agent-firewall-auth-automatic-014

- Vitest: "builtin Automatic firewall credential destinations > classifies Automatic refresh token endpoint drift"
- Mode: run
- Given: A Pro workspace member connected a builtin Automatic MCP connector through CIMD OAuth. The provider's metadata is then rediscovered with a rotated token endpoint under the same issuer. The member has a chat Run dispatched with the builtin firewall.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh`, and the member reads `GET /api/connector-accounts/:connectionId`.
- Then: The firewall request returns HTTP 502 with `TOKEN_REFRESH_FAILED`, failure reason `reconnect_required` and the connector slug, and no token request reaches the rotated token endpoint. The account becomes `reconnect-required` with reason `authorization_expired_or_revoked`.

## webhooks-agent-firewall-auth-automatic-015

- Vitest: "builtin Automatic firewall credential destinations > classifies Automatic refresh resource spelling"
- Mode: run
- Given: A Pro workspace member connected a builtin Automatic MCP connector through CIMD OAuth whose bound resource is the endpoint origin with a trailing slash. The provider's metadata is then rediscovered with the same origin spelled without the slash and the same issuer. The member has a chat Run dispatched with the builtin firewall.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh`.
- Then: The authorization URL and code exchange carried the slash-terminated resource. The firewall request returns HTTP 200 with `Authorization: Bearer automatic-refreshed-access-token`, and the refresh request sends the originally bound resource.
