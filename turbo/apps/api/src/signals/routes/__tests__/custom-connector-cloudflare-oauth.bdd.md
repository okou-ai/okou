# custom-connector-cloudflare-oauth

## custom-connector-cloudflare-oauth-001

- Vitest: "cloudflare OAuth setup preserves app authentication and current network authority: inside-basic"
- Mode: run
- Given: An authenticated organization actor has enabled the Cloudflare Access connector feature and bound a static HTTP OAuth connector to an organization Access configuration. The OAuth token endpoint is inside the configured HTTP prefix and uses client_secret_basic.
- When: The owner starts authorization via POST /api/custom-connectors/:id/oauth2/start with S256 PKCE and completes GET /api/custom-connectors/oauth2/callback in JSON mode.
- Then: The authorization URL exposes no Access secret. The callback returns HTTP 200 success and the account list shows connected without exposing the Access secret. The provider receives one code exchange with a code verifier, Basic application authorization without a client_secret form field, and both Cloudflare Access credential headers.

## custom-connector-cloudflare-oauth-002

- Vitest: "cloudflare OAuth setup preserves app authentication and current network authority: inside-post"
- Mode: run
- Given: An authenticated organization actor has enabled the Cloudflare Access connector feature and bound a static HTTP OAuth connector to an organization Access configuration. The OAuth token endpoint is inside the configured HTTP prefix and uses client_secret_post.
- When: The owner starts authorization via POST /api/custom-connectors/:id/oauth2/start with S256 PKCE and completes GET /api/custom-connectors/oauth2/callback in JSON mode.
- Then: The authorization URL exposes no Access secret. The callback returns HTTP 200 success and the account list shows connected without exposing the Access secret. The provider receives one code exchange with a code verifier, the application secret in the form, and both Cloudflare Access credential headers.

## custom-connector-cloudflare-oauth-003

- Vitest: "cloudflare OAuth setup preserves app authentication and current network authority: outside"
- Mode: run
- Given: An authenticated organization actor has enabled the Cloudflare Access connector feature and bound a static HTTP OAuth connector to an organization Access configuration. The OAuth token endpoint is outside the configured HTTP prefix and uses client_secret_post.
- When: The owner starts authorization via POST /api/custom-connectors/:id/oauth2/start with S256 PKCE and completes GET /api/custom-connectors/oauth2/callback in JSON mode.
- Then: The authorization URL exposes no Access secret. The callback returns HTTP 200 success and the account list shows connected without exposing the Access secret. The provider receives one code exchange with a code verifier, the application secret in the form, and neither Cloudflare Access credential header.

## custom-connector-cloudflare-oauth-004

- Vitest: "cloudflare OAuth setup preserves app authentication and current network authority: rotate"
- Mode: run
- Given: An authenticated organization actor has an enabled Access-bound static HTTP OAuth connector with S256 PKCE and an in-prefix token host. The actor rotates the Access credentials between contacting the provider for consent and completing the callback.
- When: The owner starts authorization via POST /api/custom-connectors/:id/oauth2/start and then requests GET /api/custom-connectors/oauth2/callback in JSON mode.
- Then: The authorization URL exposes no Access secret. The callback returns HTTP 200 with status error. The account list remains empty and the configured provider token endpoint receives zero exchange requests.

## custom-connector-cloudflare-oauth-005

- Vitest: "cloudflare OAuth setup preserves app authentication and current network authority: private-dns"
- Mode: run
- Given: An authenticated organization actor has an enabled Access-bound static HTTP OAuth connector with S256 PKCE and an in-prefix token host. The public token hostname changes to a loopback DNS resolution before the callback.
- When: The owner starts authorization via POST /api/custom-connectors/:id/oauth2/start and then requests GET /api/custom-connectors/oauth2/callback in JSON mode.
- Then: The authorization URL exposes no Access secret. The callback returns HTTP 200 with status error. The account list remains empty and the configured provider token endpoint receives zero exchange requests.

## custom-connector-cloudflare-oauth-006

- Vitest: "cloudflare OAuth setup preserves app authentication and current network authority: redirect"
- Mode: run
- Given: An authenticated organization actor has an enabled Access-bound static HTTP OAuth connector with S256 PKCE and an in-prefix token host. The provider token endpoint responds to the exchange with a redirect to another host.
- When: The owner starts authorization via POST /api/custom-connectors/:id/oauth2/start and then requests GET /api/custom-connectors/oauth2/callback in JSON mode.
- Then: The authorization URL exposes no Access secret. The callback returns HTTP 200 with status error. The account list remains empty and the configured provider token endpoint receives one exchange requests.

## custom-connector-cloudflare-oauth-007

- Vitest: "initializes MCP none with separate OAuth credentials (challenge: parameters, Access: true, protected issuer: false)"
- Mode: run
- Given: An authenticated organization actor enables the Access connector feature and creates an automatic streamable HTTP MCP connector using no provider authentication. The discovery response uses the default parameterized challenge flow. The connector is Access-bound. The provider issuer uses its ordinary origin.
- When: The owner calls POST /api/custom-connectors/:id/oauth2/start and reads the resulting accounts.
- Then: The start returns HTTP 200. The MCP endpoint is probed and each probe carries the configured Access secret header. The start directly reports connected. The resulting account is connected and its public representation omits the Access secret.

## custom-connector-cloudflare-oauth-008

- Vitest: "initializes MCP cimd with separate OAuth credentials (challenge: parameters, Access: true, protected issuer: false)"
- Mode: run
- Given: An authenticated organization actor enables the Access connector feature and creates an automatic streamable HTTP MCP connector using client ID metadata. The discovery response uses the default parameterized challenge flow. The connector is Access-bound. The provider issuer uses its ordinary origin.
- When: The owner calls POST /api/custom-connectors/:id/oauth2/start, completes provider consent through GET /api/custom-connectors/oauth2/callback, and reads the resulting accounts.
- Then: The start returns HTTP 200. The MCP endpoint is probed and each probe carries the configured Access secret header. The start reports authorization and callback reports success. The provider receives 0 dynamic registrations and one token request without an Access secret header. The resulting account is connected and its public representation omits the Access secret.

## custom-connector-cloudflare-oauth-009

- Vitest: "initializes MCP dcr with separate OAuth credentials (challenge: parameters, Access: true, protected issuer: false)"
- Mode: run
- Given: An authenticated organization actor enables the Access connector feature and creates an automatic streamable HTTP MCP connector using dynamic client registration. The discovery response uses the default parameterized challenge flow. The connector is Access-bound. The provider issuer uses its ordinary origin.
- When: The owner calls POST /api/custom-connectors/:id/oauth2/start, completes provider consent through GET /api/custom-connectors/oauth2/callback, and reads the resulting accounts.
- Then: The start returns HTTP 200. The MCP endpoint is probed and each probe carries the configured Access secret header. The start reports authorization and callback reports success. The provider receives 1 dynamic registrations and one token request without an Access secret header. The resulting account is connected and its public representation omits the Access secret.

## custom-connector-cloudflare-oauth-010

- Vitest: "initializes MCP cimd with separate OAuth credentials (challenge: bare, Access: true, protected issuer: false)"
- Mode: run
- Given: An authenticated organization actor enables the Access connector feature and creates an automatic streamable HTTP MCP connector using client ID metadata. The issuer is discovered through well-known OIDC with a bare challenge. The connector is Access-bound. The provider issuer uses its ordinary origin.
- When: The owner calls POST /api/custom-connectors/:id/oauth2/start, completes provider consent through GET /api/custom-connectors/oauth2/callback, and reads the resulting accounts.
- Then: The start returns HTTP 200. The MCP endpoint is probed and each probe carries the configured Access secret header. The start reports authorization and callback reports success. The provider receives 0 dynamic registrations and one token request without an Access secret header. The resulting account is connected and its public representation omits the Access secret.

## custom-connector-cloudflare-oauth-011

- Vitest: "initializes MCP dcr with separate OAuth credentials (challenge: bare, Access: true, protected issuer: false)"
- Mode: run
- Given: An authenticated organization actor enables the Access connector feature and creates an automatic streamable HTTP MCP connector using dynamic client registration. The issuer is discovered through well-known OIDC with a bare challenge. The connector is Access-bound. The provider issuer uses its ordinary origin.
- When: The owner calls POST /api/custom-connectors/:id/oauth2/start, completes provider consent through GET /api/custom-connectors/oauth2/callback, and reads the resulting accounts.
- Then: The start returns HTTP 200. The MCP endpoint is probed and each probe carries the configured Access secret header. The start reports authorization and callback reports success. The provider receives 1 dynamic registrations and one token request without an Access secret header. The resulting account is connected and its public representation omits the Access secret.

## custom-connector-cloudflare-oauth-012

- Vitest: "initializes MCP cimd with separate OAuth credentials (challenge: combined, Access: false, protected issuer: false)"
- Mode: run
- Given: An authenticated organization actor enables the Access connector feature and creates an automatic streamable HTTP MCP connector using client ID metadata. The issuer is discovered through well-known OIDC with Digest and a separate Bearer challenge. The connector is unbound. The provider issuer uses its ordinary origin.
- When: The owner calls POST /api/custom-connectors/:id/oauth2/start, completes provider consent through GET /api/custom-connectors/oauth2/callback, and reads the resulting accounts.
- Then: The start returns HTTP 200. The MCP endpoint is probed and each probe carries no Access secret header. The start reports authorization and callback reports success. The provider receives 0 dynamic registrations and one token request without an Access secret header. The resulting account is connected and its public representation omits the Access secret.

## custom-connector-cloudflare-oauth-013

- Vitest: "initializes MCP cimd with separate OAuth credentials (challenge: combined, Access: true, protected issuer: false)"
- Mode: run
- Given: An authenticated organization actor enables the Access connector feature and creates an automatic streamable HTTP MCP connector using client ID metadata. The issuer is discovered through well-known OIDC with Digest and a separate Bearer challenge. The connector is Access-bound. The provider issuer uses its ordinary origin.
- When: The owner calls POST /api/custom-connectors/:id/oauth2/start, completes provider consent through GET /api/custom-connectors/oauth2/callback, and reads the resulting accounts.
- Then: The start returns HTTP 200. The MCP endpoint is probed and each probe carries the configured Access secret header. The start reports authorization and callback reports success. The provider receives 0 dynamic registrations and one token request without an Access secret header. The resulting account is connected and its public representation omits the Access secret.

## custom-connector-cloudflare-oauth-014

- Vitest: "initializes MCP dcr with separate OAuth credentials (challenge: combined, Access: false, protected issuer: false)"
- Mode: run
- Given: An authenticated organization actor enables the Access connector feature and creates an automatic streamable HTTP MCP connector using dynamic client registration. The issuer is discovered through well-known OIDC with Digest and a separate Bearer challenge. The connector is unbound. The provider issuer uses its ordinary origin.
- When: The owner calls POST /api/custom-connectors/:id/oauth2/start, completes provider consent through GET /api/custom-connectors/oauth2/callback, and reads the resulting accounts.
- Then: The start returns HTTP 200. The MCP endpoint is probed and each probe carries no Access secret header. The start reports authorization and callback reports success. The provider receives 1 dynamic registrations and one token request without an Access secret header. The resulting account is connected and its public representation omits the Access secret.

## custom-connector-cloudflare-oauth-015

- Vitest: "initializes MCP dcr with separate OAuth credentials (challenge: combined, Access: true, protected issuer: false)"
- Mode: run
- Given: An authenticated organization actor enables the Access connector feature and creates an automatic streamable HTTP MCP connector using dynamic client registration. The issuer is discovered through well-known OIDC with Digest and a separate Bearer challenge. The connector is Access-bound. The provider issuer uses its ordinary origin.
- When: The owner calls POST /api/custom-connectors/:id/oauth2/start, completes provider consent through GET /api/custom-connectors/oauth2/callback, and reads the resulting accounts.
- Then: The start returns HTTP 200. The MCP endpoint is probed and each probe carries the configured Access secret header. The start reports authorization and callback reports success. The provider receives 1 dynamic registrations and one token request without an Access secret header. The resulting account is connected and its public representation omits the Access secret.

## custom-connector-cloudflare-oauth-016

- Vitest: "initializes MCP cimd with separate OAuth credentials (challenge: quoted, Access: true, protected issuer: false)"
- Mode: run
- Given: An authenticated organization actor enables the Access connector feature and creates an automatic streamable HTTP MCP connector using client ID metadata. Well-known OIDC discovery accompanies a Digest challenge with Bearer inside a quoted realm. The connector is Access-bound. The provider issuer uses its ordinary origin.
- When: The owner calls POST /api/custom-connectors/:id/oauth2/start, completes provider consent through GET /api/custom-connectors/oauth2/callback, and reads the resulting accounts.
- Then: The start returns HTTP 200. The MCP endpoint is probed and each probe carries the configured Access secret header. The start reports authorization and callback reports success. The provider receives 0 dynamic registrations and one token request without an Access secret header. The resulting account is connected and its public representation omits the Access secret.

## custom-connector-cloudflare-oauth-017

- Vitest: "initializes MCP cimd with separate OAuth credentials (challenge: quoted-escape, Access: true, protected issuer: false)"
- Mode: run
- Given: An authenticated organization actor enables the Access connector feature and creates an automatic streamable HTTP MCP connector using client ID metadata. Well-known OIDC discovery accompanies a Digest challenge with a quoted and escaped realm. The connector is Access-bound. The provider issuer uses its ordinary origin.
- When: The owner calls POST /api/custom-connectors/:id/oauth2/start, completes provider consent through GET /api/custom-connectors/oauth2/callback, and reads the resulting accounts.
- Then: The start returns HTTP 200. The MCP endpoint is probed and each probe carries the configured Access secret header. The start reports authorization and callback reports success. The provider receives 0 dynamic registrations and one token request without an Access secret header. The resulting account is connected and its public representation omits the Access secret.

## custom-connector-cloudflare-oauth-018

- Vitest: "initializes MCP cimd with separate OAuth credentials (challenge: auth-param, Access: true, protected issuer: false)"
- Mode: run
- Given: An authenticated organization actor enables the Access connector feature and creates an automatic streamable HTTP MCP connector using client ID metadata. Well-known OIDC discovery accompanies a Digest challenge with a bearer-named authorization parameter. The connector is Access-bound. The provider issuer uses its ordinary origin.
- When: The owner calls POST /api/custom-connectors/:id/oauth2/start, completes provider consent through GET /api/custom-connectors/oauth2/callback, and reads the resulting accounts.
- Then: The start returns HTTP 200. The MCP endpoint is probed and each probe carries the configured Access secret header. The start reports authorization and callback reports success. The provider receives 0 dynamic registrations and one token request without an Access secret header. The resulting account is connected and its public representation omits the Access secret.

## custom-connector-cloudflare-oauth-019

- Vitest: "initializes MCP cimd with separate OAuth credentials (challenge: bare, Access: true, protected issuer: true)"
- Mode: run
- Given: An authenticated organization actor enables the Access connector feature and creates an automatic streamable HTTP MCP connector using client ID metadata. The issuer is discovered through well-known OIDC with a bare challenge. The connector is Access-bound. The token endpoint shares the protected MCP origin.
- When: The owner calls POST /api/custom-connectors/:id/oauth2/start, completes provider consent through GET /api/custom-connectors/oauth2/callback, and reads the resulting accounts.
- Then: The start returns HTTP 200. The MCP endpoint is probed and each probe carries the configured Access secret header. The start reports authorization and callback reports success. The provider receives 0 dynamic registrations and one token request with an Access secret header. The resulting account is connected and its public representation omits the Access secret.

## custom-connector-cloudflare-oauth-020

- Vitest: "initializes MCP dcr with separate OAuth credentials (challenge: bare, Access: true, protected issuer: true)"
- Mode: run
- Given: An authenticated organization actor enables the Access connector feature and creates an automatic streamable HTTP MCP connector using dynamic client registration. The issuer is discovered through well-known OIDC with a bare challenge. The connector is Access-bound. The token endpoint shares the protected MCP origin.
- When: The owner calls POST /api/custom-connectors/:id/oauth2/start, completes provider consent through GET /api/custom-connectors/oauth2/callback, and reads the resulting accounts.
- Then: The start returns HTTP 200. The MCP endpoint is probed and each probe carries the configured Access secret header. The start reports authorization and callback reports success. The provider receives 1 dynamic registrations and one token request with an Access secret header. The resulting account is connected and its public representation omits the Access secret.

## custom-connector-cloudflare-oauth-021

- Vitest: "initializes MCP cimd with separate OAuth credentials (challenge: bare, Access: false, protected issuer: true)"
- Mode: run
- Given: An authenticated organization actor enables the Access connector feature and creates an automatic streamable HTTP MCP connector using client ID metadata. The issuer is discovered through well-known OIDC with a bare challenge. The connector is unbound. The token endpoint shares the protected MCP origin.
- When: The owner calls POST /api/custom-connectors/:id/oauth2/start, completes provider consent through GET /api/custom-connectors/oauth2/callback, and reads the resulting accounts.
- Then: The start returns HTTP 200. The MCP endpoint is probed and each probe carries no Access secret header. The start reports authorization and callback reports success. The provider receives 0 dynamic registrations and one token request without an Access secret header. The resulting account is connected and its public representation omits the Access secret.

## custom-connector-cloudflare-oauth-022

- Vitest: "initializes MCP dcr with separate OAuth credentials (challenge: bare, Access: false, protected issuer: true)"
- Mode: run
- Given: An authenticated organization actor enables the Access connector feature and creates an automatic streamable HTTP MCP connector using dynamic client registration. The issuer is discovered through well-known OIDC with a bare challenge. The connector is unbound. The token endpoint shares the protected MCP origin.
- When: The owner calls POST /api/custom-connectors/:id/oauth2/start, completes provider consent through GET /api/custom-connectors/oauth2/callback, and reads the resulting accounts.
- Then: The start returns HTTP 200. The MCP endpoint is probed and each probe carries no Access secret header. The start reports authorization and callback reports success. The provider receives 1 dynamic registrations and one token request without an Access secret header. The resulting account is connected and its public representation omits the Access secret.
