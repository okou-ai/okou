# webhooks-agent-firewall-auth-custom-oauth

## webhooks-agent-firewall-auth-custom-oauth-001

- Vitest: "retains cimd authority across network-change during refresh discovery"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through CIMD whose issuer sits behind Cloudflare Access, the Cloudflare Access feature switch enabled, and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. While the API rediscovers the provider's resource metadata during the first refresh, the admin rotates the Cloudflare Access service-token credentials.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` and the Cloudflare Access network intent, the member lists the connector's accounts, and the firewall sends another forced request after the provider's authority is consistent again.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider` without a token request, and the account stays `connected` with no reconnect reason. The retry returns HTTP 200 after one refresh token request, no client registration, and the token request carries the rotated Access client secret.

## webhooks-agent-firewall-auth-custom-oauth-002

- Vitest: "retains dcr authority across network-change during refresh discovery"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through dynamic client registration (DCR) whose issuer sits behind Cloudflare Access, the Cloudflare Access feature switch enabled, and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. While the API rediscovers the provider's resource metadata during the first refresh, the admin rotates the Cloudflare Access service-token credentials.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` and the Cloudflare Access network intent, the member lists the connector's accounts, and the firewall sends another forced request after the provider's authority is consistent again.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider` without a token request, and the account stays `connected` with no reconnect reason. The retry returns HTTP 200 after one refresh token request, one client registration in total, and the token request carries the rotated Access client secret.

## webhooks-agent-firewall-auth-custom-oauth-003

- Vitest: "retains cimd authority across unattributed-authority during refresh discovery"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through CIMD whose issuer sits behind Cloudflare Access, the Cloudflare Access feature switch enabled, and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. During the first refresh the provider's resource metadata advertises a different, unrelated authorization server; it later advertises its own issuer again.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` and the Cloudflare Access network intent, the member lists the connector's accounts, and the firewall sends another forced request after the provider's authority is consistent again.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider` without a token request, and the account stays `connected` with no reconnect reason. The retry returns HTTP 200 after one refresh token request, no client registration, and the token request carries the original Access client secret.

## webhooks-agent-firewall-auth-custom-oauth-004

- Vitest: "retains dcr authority across unattributed-authority during refresh discovery"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through dynamic client registration (DCR) whose issuer sits behind Cloudflare Access, the Cloudflare Access feature switch enabled, and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. During the first refresh the provider's resource metadata advertises a different, unrelated authorization server; it later advertises its own issuer again.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` and the Cloudflare Access network intent, the member lists the connector's accounts, and the firewall sends another forced request after the provider's authority is consistent again.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider` without a token request, and the account stays `connected` with no reconnect reason. The retry returns HTTP 200 after one refresh token request, one client registration in total, and the token request carries the original Access client secret.

## webhooks-agent-firewall-auth-custom-oauth-005

- Vitest: "Access-protected configured cimd refresh > preserves the account and registration on an unattributed 401 (undefined, undefined)"
- Mode: run
- Given: A Pro organization admin has a custom HTTP connector with configured OAuth (client-secret post) whose token endpoint sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 401 with a plain-text body and no challenge; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes.

## webhooks-agent-firewall-auth-custom-oauth-006

- Vitest: "Access-protected configured cimd refresh > preserves the account and registration on an unattributed 403 (undefined, undefined)"
- Mode: run
- Given: A Pro organization admin has a custom HTTP connector with configured OAuth (client-secret post) whose token endpoint sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 403 with a plain-text body and no challenge; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes.

## webhooks-agent-firewall-auth-custom-oauth-007

- Vitest: "Access-protected configured cimd refresh > preserves the account and registration on an unattributed 401 (Bearer, undefined)"
- Mode: run
- Given: A Pro organization admin has a custom HTTP connector with configured OAuth (client-secret post) whose token endpoint sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 401 with a plain-text body and a `Bearer` challenge; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes.

## webhooks-agent-firewall-auth-custom-oauth-008

- Vitest: "Access-protected configured cimd refresh > preserves the account and registration on an unattributed 401 (Digest realm=\"gateway\", Bearer, undefined)"
- Mode: run
- Given: A Pro organization admin has a custom HTTP connector with configured OAuth (client-secret post) whose token endpoint sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 401 with a plain-text body and a `Digest realm="gateway", Bearer` challenge; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes.

## webhooks-agent-firewall-auth-custom-oauth-009

- Vitest: "Access-protected configured cimd refresh > preserves the account and registration on an unattributed 400 (undefined, invalid_grant)"
- Mode: run
- Given: A Pro organization admin has a custom HTTP connector with configured OAuth (client-secret post) whose token endpoint sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 400 with OAuth error `invalid_grant`; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes.

## webhooks-agent-firewall-auth-custom-oauth-010

- Vitest: "Access-protected configured cimd refresh > preserves the account and registration on an unattributed 404 (undefined, invalid_grant)"
- Mode: run
- Given: A Pro organization admin has a custom HTTP connector with configured OAuth (client-secret post) whose token endpoint sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 404 with OAuth error `invalid_grant`; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes.

## webhooks-agent-firewall-auth-custom-oauth-011

- Vitest: "Access-protected configured cimd refresh > preserves the account and registration on an unattributed 401 (Basic, invalid_client)"
- Mode: run
- Given: A Pro organization admin has a custom HTTP connector with configured OAuth (client-secret post) whose token endpoint sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 401 with a `Basic` challenge and OAuth error `invalid_client`; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes.

## webhooks-agent-firewall-auth-custom-oauth-012

- Vitest: "Access-protected configured cimd refresh > preserves the account and registration on an unattributed 503 (undefined, undefined)"
- Mode: run
- Given: A Pro organization admin has a custom HTTP connector with configured OAuth (client-secret post) whose token endpoint sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 503 with a plain-text body; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes.

## webhooks-agent-firewall-auth-custom-oauth-013

- Vitest: "Access-protected automatic cimd refresh > preserves the account and registration on an unattributed 401 (undefined, undefined)"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through CIMD whose issuer sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 401 with a plain-text body and no challenge; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The failed refresh carried the organization Access client secret. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes. The provider saw no client registration.

## webhooks-agent-firewall-auth-custom-oauth-014

- Vitest: "Access-protected automatic cimd refresh > preserves the account and registration on an unattributed 403 (undefined, undefined)"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through CIMD whose issuer sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 403 with a plain-text body and no challenge; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The failed refresh carried the organization Access client secret. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes. The provider saw no client registration.

## webhooks-agent-firewall-auth-custom-oauth-015

- Vitest: "Access-protected automatic cimd refresh > preserves the account and registration on an unattributed 401 (Bearer, undefined)"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through CIMD whose issuer sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 401 with a plain-text body and a `Bearer` challenge; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The failed refresh carried the organization Access client secret. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes. The provider saw no client registration.

## webhooks-agent-firewall-auth-custom-oauth-016

- Vitest: "Access-protected automatic cimd refresh > preserves the account and registration on an unattributed 401 (Digest realm=\"gateway\", Bearer, undefined)"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through CIMD whose issuer sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 401 with a plain-text body and a `Digest realm="gateway", Bearer` challenge; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The failed refresh carried the organization Access client secret. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes. The provider saw no client registration.

## webhooks-agent-firewall-auth-custom-oauth-017

- Vitest: "Access-protected automatic cimd refresh > preserves the account and registration on an unattributed 400 (undefined, invalid_grant)"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through CIMD whose issuer sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 400 with OAuth error `invalid_grant`; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The failed refresh carried the organization Access client secret. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes. The provider saw no client registration.

## webhooks-agent-firewall-auth-custom-oauth-018

- Vitest: "Access-protected automatic cimd refresh > preserves the account and registration on an unattributed 404 (undefined, invalid_grant)"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through CIMD whose issuer sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 404 with OAuth error `invalid_grant`; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The failed refresh carried the organization Access client secret. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes. The provider saw no client registration.

## webhooks-agent-firewall-auth-custom-oauth-019

- Vitest: "Access-protected automatic cimd refresh > preserves the account and registration on an unattributed 401 (Basic, invalid_client)"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through CIMD whose issuer sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 401 with a `Basic` challenge and OAuth error `invalid_client`; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The failed refresh carried the organization Access client secret. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes. The provider saw no client registration.

## webhooks-agent-firewall-auth-custom-oauth-020

- Vitest: "Access-protected automatic cimd refresh > preserves the account and registration on an unattributed 503 (undefined, undefined)"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through CIMD whose issuer sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 503 with a plain-text body; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The failed refresh carried the organization Access client secret. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes. The provider saw no client registration.

## webhooks-agent-firewall-auth-custom-oauth-021

- Vitest: "Access-protected automatic dcr refresh > preserves the account and registration on an unattributed 401 (undefined, undefined)"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through DCR whose issuer sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 401 with a plain-text body and no challenge; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The failed refresh carried the organization Access client secret. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes. The provider saw one client registration in total.

## webhooks-agent-firewall-auth-custom-oauth-022

- Vitest: "Access-protected automatic dcr refresh > preserves the account and registration on an unattributed 403 (undefined, undefined)"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through DCR whose issuer sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 403 with a plain-text body and no challenge; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The failed refresh carried the organization Access client secret. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes. The provider saw one client registration in total.

## webhooks-agent-firewall-auth-custom-oauth-023

- Vitest: "Access-protected automatic dcr refresh > preserves the account and registration on an unattributed 401 (Bearer, undefined)"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through DCR whose issuer sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 401 with a plain-text body and a `Bearer` challenge; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The failed refresh carried the organization Access client secret. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes. The provider saw one client registration in total.

## webhooks-agent-firewall-auth-custom-oauth-024

- Vitest: "Access-protected automatic dcr refresh > preserves the account and registration on an unattributed 401 (Digest realm=\"gateway\", Bearer, undefined)"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through DCR whose issuer sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 401 with a plain-text body and a `Digest realm="gateway", Bearer` challenge; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The failed refresh carried the organization Access client secret. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes. The provider saw one client registration in total.

## webhooks-agent-firewall-auth-custom-oauth-025

- Vitest: "Access-protected automatic dcr refresh > preserves the account and registration on an unattributed 400 (undefined, invalid_grant)"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through DCR whose issuer sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 400 with OAuth error `invalid_grant`; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The failed refresh carried the organization Access client secret. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes. The provider saw one client registration in total.

## webhooks-agent-firewall-auth-custom-oauth-026

- Vitest: "Access-protected automatic dcr refresh > preserves the account and registration on an unattributed 404 (undefined, invalid_grant)"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through DCR whose issuer sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 404 with OAuth error `invalid_grant`; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The failed refresh carried the organization Access client secret. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes. The provider saw one client registration in total.

## webhooks-agent-firewall-auth-custom-oauth-027

- Vitest: "Access-protected automatic dcr refresh > preserves the account and registration on an unattributed 401 (Basic, invalid_client)"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through DCR whose issuer sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 401 with a `Basic` challenge and OAuth error `invalid_client`; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The failed refresh carried the organization Access client secret. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes. The provider saw one client registration in total.

## webhooks-agent-firewall-auth-custom-oauth-028

- Vitest: "Access-protected automatic dcr refresh > preserves the account and registration on an unattributed 503 (undefined, undefined)"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through DCR whose issuer sits behind Cloudflare Access, with the Cloudflare Access feature switch enabled and the connector bound to an organization Access service token. A chat Run is dispatched with the connector's firewall. The first refresh through Access is rejected with HTTP 503 with a plain-text body; later refreshes return `explicitly-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the Access network intent and `forceRefresh`, the member lists the connector's accounts, and the firewall sends one request without and one with `forceRefresh`.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and its body does not contain the Access secret. The account stays `connected` with no reconnect reason. The failed refresh carried the organization Access client secret. The non-forced request returns HTTP 200 without another refresh, and the forced request returns HTTP 200 with `Authorization: Bearer explicitly-recovered` after exactly two refreshes. The provider saw one client registration in total.

## webhooks-agent-firewall-auth-custom-oauth-029

- Vitest: "custom network admission is explicitly opted in and leaves installed Runner responses unchanged"
- Mode: run
- Given: A Pro organization admin has a custom HTTP connector with configured OAuth and a connected account, and a chat Run dispatched with the connector's firewall. The Cloudflare Access feature switch is initially off.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` without network admission, again after the admin enables the Cloudflare Access feature switch, and then with network admission for a direct request.
- Then: The first request returns HTTP 200 with no `networkAdmission` field, and the request after enabling the switch returns the identical response. The network-admission request returns HTTP 200 with a null expiry and `networkAdmission: { kind: "direct" }`.

## webhooks-agent-firewall-auth-custom-oauth-030

- Vitest: "run network admission uses current bindings and rotation independently of application OAuth"
- Mode: run
- Given: A Pro organization admin has a custom HTTP connector with configured OAuth and a connected account, a chat Run dispatched on a Runner group with the connector's firewall, and the Cloudflare Access feature switch enabled. The admin creates an organization Access service token (`first-id`/`first-secret`) and binds the connector to it.
- When: The Run's firewall requests network admission through `POST /api/webhooks/run/firewall/auth` with a direct intent and with the Access intent; the admin rotates the token to `next-id`/`next-secret`; the Runner syncs connector runtime; the firewall requests admission again, with the thread's account disabled and re-enabled, for a new no-auth connector bound to the same token before and after it is connected, for a mismatched connector, and after the binding is removed.
- Then: The direct intent returns HTTP 403 and the Access intent returns HTTP 200 with no application headers, a null expiry and generation 1 Access headers. The rotation publishes one `connector-runtime-sync` message to the Runner group for the Run and connector, the runtime sync reports the connector available with generation 2, and admission then returns the `next-id`/`next-secret` headers without the old secret. A disabled thread account gets HTTP 403. The no-auth connector gets HTTP 403 until connected and then HTTP 200 with generation 2 headers, a mismatched connector gets HTTP 403, and after unbinding the Access intent gets HTTP 403 while the direct intent returns HTTP 200 and the account stays `connected`.

## webhooks-agent-firewall-auth-custom-oauth-031

- Vitest: "Custom Automatic DCR credential retirement > requires all linked accounts to reconnect after invalid_client and recovers one account"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through DCR with two linked accounts, and a chat Run dispatched with the connector's firewall. The provider rejects every refresh with HTTP 400 `invalid_client`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` for each account, the member lists the accounts, reconnects the first account through a provider that issues a new registration, and the firewall requests a forced refresh for it again.
- Then: Both requests return HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `reconnect_required`, and both accounts become `reconnect-required` with reason `authorization_expired_or_revoked`. The reconnect performs one new client registration, the next forced refresh returns HTTP 200 with `Authorization: Bearer automatic-refreshed-access-token`, and only the reconnected account becomes `connected` while the sibling stays `reconnect-required`.

## webhooks-agent-firewall-auth-custom-oauth-032

- Vitest: "Custom Automatic DCR credential retirement > requires all linked accounts to reconnect after expired registration and recovers one account"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through DCR whose client secret expires 60 seconds after connection, with two linked accounts and a chat Run dispatched with the connector's firewall. The clock advances 120 seconds.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` for each account, the member lists the accounts, reconnects the first account through a provider that issues a new registration, and the firewall requests a forced refresh for it again.
- Then: Both requests return HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `reconnect_required`, and both accounts become `reconnect-required` with reason `authorization_expired_or_revoked`. The reconnect performs one new client registration, the next forced refresh returns HTTP 200 with `Authorization: Bearer automatic-refreshed-access-token`, and only the reconnected account becomes `connected` while the sibling stays `reconnect-required`.

## webhooks-agent-firewall-auth-custom-oauth-033

- Vitest: "Custom configured OAuth quiet refresh recovery > retries invalid_grant (undefined) and recovers the exact account"
- Mode: run
- Given: A Pro organization admin has a custom HTTP connector with configured OAuth with two connected accounts, the first and a sibling, and a chat Run dispatched with the connector's firewall. The provider rejects refreshes with HTTP 400 `invalid_grant` without a subtype; later a recovered provider accepts refreshes and issues the new refresh token `replacement-custom-refresh` on reconnect.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` for the first account with `forceRefresh`, then (after the member makes the sibling the default via `POST /api/connector-accounts/:connectionId/default`) without and with `forceRefresh`, then for the sibling; after the provider recovers it requests the first account without `forceRefresh`, and after the member reconnects that account it requests a forced refresh.
- Then: All three requests for the first account return HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `reconnect_required`, each after one refresh attempt (3 in total). The first account is `reconnect-required` with reason `authorization_expired_or_revoked` while the sibling stays `connected` and returns HTTP 200 without a refresh. After recovery the quiet retry returns HTTP 200 with `Authorization: Bearer custom-oauth-refreshed-access-token` using the original refresh token `custom-oauth-refresh-token`, and the account is `connected` again. Reconnecting keeps the account ID, and the forced refresh returns HTTP 200 using `replacement-custom-refresh`.

## webhooks-agent-firewall-auth-custom-oauth-034

- Vitest: "Custom configured OAuth quiet refresh recovery > retries invalid_grant (invalid_rapt) and recovers the exact account"
- Mode: run
- Given: A Pro organization admin has a custom HTTP connector with configured OAuth with two connected accounts, the first and a sibling, and a chat Run dispatched with the connector's firewall. The provider rejects refreshes with HTTP 400 `invalid_grant` with error subtype `invalid_rapt`; later a recovered provider accepts refreshes and issues the new refresh token `replacement-custom-refresh` on reconnect.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` for the first account with `forceRefresh`, then (after the member makes the sibling the default via `POST /api/connector-accounts/:connectionId/default`) without and with `forceRefresh`, then for the sibling; after the provider recovers it requests the first account without `forceRefresh`, and after the member reconnects that account it requests a forced refresh.
- Then: All three requests for the first account return HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `reconnect_required`, each after one refresh attempt (3 in total). The first account is `reconnect-required` with reason `authorization_expired_or_revoked` while the sibling stays `connected` and returns HTTP 200 without a refresh. After recovery the quiet retry returns HTTP 200 with `Authorization: Bearer custom-oauth-refreshed-access-token` using the original refresh token `custom-oauth-refresh-token`, and the account is `connected` again. Reconnecting keeps the account ID, and the forced refresh returns HTTP 200 using `replacement-custom-refresh`.

## webhooks-agent-firewall-auth-custom-oauth-035

- Vitest: "Custom configured OAuth quiet refresh recovery > keeps provider outage observable and recoverable"
- Mode: run
- Given: A Pro organization admin has a custom HTTP connector with configured OAuth with a connected account and a chat Run dispatched with the connector's firewall. The provider answers the first two refreshes with HTTP 503 `server_error` (provider outage) and then returns `custom-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` three times, and the member lists the connector's accounts after the first two.
- Then: The first two requests return HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, after which the provider has received three token requests including the initial code exchange. The account stays `connected` with no reconnect reason. The third request returns HTTP 200 with `Authorization: Bearer custom-recovered`.

## webhooks-agent-firewall-auth-custom-oauth-036

- Vitest: "Custom configured OAuth quiet refresh recovery > keeps rate limit observable and recoverable"
- Mode: run
- Given: A Pro organization admin has a custom HTTP connector with configured OAuth with a connected account and a chat Run dispatched with the connector's firewall. The provider answers the first two refreshes with HTTP 429 `temporarily_unavailable` (rate limit) and then returns `custom-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` three times, and the member lists the connector's accounts after the first two.
- Then: The first two requests return HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, after which the provider has received three token requests including the initial code exchange. The account stays `connected` with no reconnect reason. The third request returns HTTP 200 with `Authorization: Bearer custom-recovered`.

## webhooks-agent-firewall-auth-custom-oauth-037

- Vitest: "Custom automatic OAuth quiet refresh recovery > retries invalid_grant (undefined) and recovers the exact account"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through CIMD with two connected accounts, the first and a sibling, and a chat Run dispatched with the connector's firewall. The provider rejects refreshes with HTTP 400 `invalid_grant` without a subtype; later a recovered provider accepts refreshes and issues the new refresh token `replacement-custom-refresh` on reconnect.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` for the first account with `forceRefresh`, then (after the member makes the sibling the default via `POST /api/connector-accounts/:connectionId/default`) without and with `forceRefresh`, then for the sibling; after the provider recovers it requests the first account without `forceRefresh`, and after the member reconnects that account it requests a forced refresh.
- Then: All three requests for the first account return HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `reconnect_required`, each after one refresh attempt (3 in total). The first account is `reconnect-required` with reason `authorization_expired_or_revoked` while the sibling stays `connected` and returns HTTP 200 without a refresh. After recovery the quiet retry returns HTTP 200 with `Authorization: Bearer automatic-refreshed-access-token` using the original refresh token `automatic-refresh-token`, and the account is `connected` again. Reconnecting keeps the account ID, and the forced refresh returns HTTP 200 using `replacement-custom-refresh`.

## webhooks-agent-firewall-auth-custom-oauth-038

- Vitest: "Custom automatic OAuth quiet refresh recovery > retries invalid_grant (invalid_rapt) and recovers the exact account"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through CIMD with two connected accounts, the first and a sibling, and a chat Run dispatched with the connector's firewall. The provider rejects refreshes with HTTP 400 `invalid_grant` with error subtype `invalid_rapt`; later a recovered provider accepts refreshes and issues the new refresh token `replacement-custom-refresh` on reconnect.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` for the first account with `forceRefresh`, then (after the member makes the sibling the default via `POST /api/connector-accounts/:connectionId/default`) without and with `forceRefresh`, then for the sibling; after the provider recovers it requests the first account without `forceRefresh`, and after the member reconnects that account it requests a forced refresh.
- Then: All three requests for the first account return HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `reconnect_required`, each after one refresh attempt (3 in total). The first account is `reconnect-required` with reason `authorization_expired_or_revoked` while the sibling stays `connected` and returns HTTP 200 without a refresh. After recovery the quiet retry returns HTTP 200 with `Authorization: Bearer automatic-refreshed-access-token` using the original refresh token `automatic-refresh-token`, and the account is `connected` again. Reconnecting keeps the account ID, and the forced refresh returns HTTP 200 using `replacement-custom-refresh`.

## webhooks-agent-firewall-auth-custom-oauth-039

- Vitest: "Custom automatic OAuth quiet refresh recovery > keeps provider outage observable and recoverable"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through CIMD with a connected account and a chat Run dispatched with the connector's firewall. The provider answers the first two refreshes with HTTP 503 `server_error` (provider outage) and then returns `custom-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` three times, and the member lists the connector's accounts after the first two.
- Then: The first two requests return HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, after which the provider has received three token requests including the initial code exchange. The account stays `connected` with no reconnect reason. The third request returns HTTP 200 with `Authorization: Bearer custom-recovered`.

## webhooks-agent-firewall-auth-custom-oauth-040

- Vitest: "Custom automatic OAuth quiet refresh recovery > keeps rate limit observable and recoverable"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through CIMD with a connected account and a chat Run dispatched with the connector's firewall. The provider answers the first two refreshes with HTTP 429 `temporarily_unavailable` (rate limit) and then returns `custom-recovered`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` three times, and the member lists the connector's accounts after the first two.
- Then: The first two requests return HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, after which the provider has received three token requests including the initial code exchange. The account stays `connected` with no reconnect reason. The third request returns HTTP 200 with `Authorization: Bearer custom-recovered`.

## webhooks-agent-firewall-auth-custom-oauth-041

- Vitest: "Custom configured OAuth identity refresh > populates a previously unnamed account from verified refresh identity"
- Mode: run
- Given: A Pro organization admin has a custom HTTP connector with configured OAuth with an account connected without identity information, and a chat Run dispatched with the connector's firewall. The refresh returns a verified identity with subject `configured-refresh-user`, username `configured-refresh-name` and e-mail `configured-refresh@example.test`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh`, and the member lists the connector's accounts.
- Then: The request returns HTTP 200 with `Authorization: Bearer custom-oauth-refreshed-access-token`. The account shows external ID `configured-refresh-user`, username `configured-refresh-name`, e-mail `configured-refresh@example.test`, status `connected` and no reconnect reason.

## webhooks-agent-firewall-auth-custom-oauth-042

- Vitest: "Custom configured OAuth identity refresh > updates verified principal metadata during refresh without requiring reconnect"
- Mode: run
- Given: A Pro organization admin has a custom HTTP connector with configured OAuth with an account connected as subject `configured-original-user` (username `configured-original-name`, e-mail `configured-original@example.test`), and a chat Run dispatched with the connector's firewall. The refresh returns a verified identity for a different subject, `configured-other-user`, with username `configured-other-name` and e-mail `configured-other@example.test`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh`, and the member lists the connector's accounts.
- Then: The request returns HTTP 200 with `Authorization: Bearer custom-oauth-refreshed-access-token`. The account shows external ID `configured-other-user`, username `configured-other-name`, e-mail `configured-other@example.test`, status `connected` and no reconnect reason, so no reconnect is required.

## webhooks-agent-firewall-auth-custom-oauth-043

- Vitest: "Custom automatic OAuth identity refresh > populates a previously unnamed account from verified refresh identity"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through CIMD with an account connected without identity information, and a chat Run dispatched with the connector's firewall. The refresh returns a verified identity with subject `automatic-refresh-user`, username `automatic-refresh-name` and e-mail `automatic-refresh@example.test`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh`, and the member lists the connector's accounts.
- Then: The request returns HTTP 200 with `Authorization: Bearer automatic-refreshed-access-token`. The account shows external ID `automatic-refresh-user`, username `automatic-refresh-name`, e-mail `automatic-refresh@example.test`, status `connected` and no reconnect reason.

## webhooks-agent-firewall-auth-custom-oauth-044

- Vitest: "Custom automatic OAuth identity refresh > updates verified principal metadata during refresh without requiring reconnect"
- Mode: run
- Given: A Pro organization admin has a custom Automatic MCP connector authorized through CIMD with an account connected as subject `automatic-original-user` (username `automatic-original-name`, e-mail `automatic-original@example.test`), and a chat Run dispatched with the connector's firewall. The refresh returns a verified identity for a different subject, `automatic-other-user`, with username `automatic-other-name` and e-mail `automatic-other@example.test`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh`, and the member lists the connector's accounts.
- Then: The request returns HTTP 200 with `Authorization: Bearer automatic-refreshed-access-token`. The account shows external ID `automatic-other-user`, username `automatic-other-name`, e-mail `automatic-other@example.test`, status `connected` and no reconnect reason, so no reconnect is required.

## webhooks-agent-firewall-auth-custom-oauth-045

- Vitest: "preserves static OAuth identity when refreshed identity is unusable"
- Mode: run
- Given: A Pro organization admin has a custom HTTP connector with configured OAuth whose account was connected as subject `static-preserved-user` with username `static-preserved-name` and e-mail `static-preserved@example.test`, and a chat Run dispatched with the connector's firewall. The refresh returns an invalid ID token claiming subject `static-untrusted-user`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh`, and the member lists the connector's accounts.
- Then: The request returns HTTP 200 with `Authorization: Bearer custom-oauth-refreshed-access-token`. The account keeps external ID `static-preserved-user`, username `static-preserved-name`, e-mail `static-preserved@example.test`, status `connected` and no reconnect reason.
