# custom-connectors-automatic-dcr

## custom-connectors-automatic-dcr-001

- Vitest: "Custom Automatic OAuth DCR retirement > replaces expired registrations with no linked accounts across repeated authorizations"
- Mode: run
- Given: An authenticated admin has an automatic streamable MCP connector whose provider performs dynamic client registration. Initial and replacement client secrets have finite lifetimes and the first two attempts create no connected accounts.
- When: The admin starts authorization with POST /api/custom-connectors/:id/oauth2/start, repeats after the first registration expires, then starts and completes authorization after the second registration expires.
- Then: Each expired registration is replaced with one provider registration call. After the first two starts the account list remains empty. The third completes with a connected account and a null reconnect reason.

## custom-connectors-automatic-dcr-002

- Vitest: "Custom Automatic OAuth DCR retirement > marks only the expired registration's owners for reconnect and restores the selected account"
- Mode: run
- Given: An admin and a member have accounts on an automatic MCP connector that shares an expiring registration. The same issuer has independent registrations for another connector in the workspace and another organization's connector.
- When: After expiration, an admin from the other organization tries POST /api/custom-connectors/:id/oauth2/start for the first connector, and the owning admin requests a reconnect targeting their exact account, then completes the provider callback.
- Then: The foreign request returns HTTP 404 with no new provider registration. The authorized request registers once and both linked accounts become reconnect-required with authorization_expired_or_revoked, their original creation times and the current update time. Accounts on both independent registrations stay unchanged. Completing the callback restores only the selected owner's account to connected with null reconnect reason.

## custom-connectors-automatic-dcr-003

- Vitest: "Custom Automatic OAuth DCR retirement > preserves connected accounts when replacement registration fails before retirement"
- Mode: run
- Given: An authenticated admin has a connected account on an automatic MCP connector whose registration expires. The provider returns HTTP 503 for replacement registration.
- When: The admin sends POST /api/custom-connectors/:id/oauth2/start after expiry and reads the account, then retries a targeted reconnect once provider registration is available.
- Then: The failed start returns HTTP 502 with MCP_OAUTH_PROVIDER_UNAVAILABLE and the stored account remains exactly as read before. The retry registers a replacement once and completes for the selected account.
