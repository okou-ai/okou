# custom-connectors-oauth2

## custom-connectors-oauth2-001

- Vitest: "Custom connector OAuth callbacks > returns a custom OAuth attempt to iOS after consent or refusal (denied=false)"
- Mode: run
- Given: An authenticated organization admin owns a static custom OAuth connector, uses an iOS native return flow, and the app origin is https://app.okou.ai.
- When: The caller uses POST /api/custom-connectors/:id/oauth2/start with x-okou-native-connector-callback ios-https to add an account, the provider grants consent through GET /api/custom-connectors/oauth2/callback in JSON response mode and iOS reads the resulting receipt.
- Then: The start returns HTTP 200 with the app's native connector authorization URL containing the attempt ID. The callback returns HTTP 200 with status success and an iOS return descriptor containing the attempt ID and app.okou.ai host. The receipt returns HTTP 200.

## custom-connectors-oauth2-002

- Vitest: "Custom connector OAuth callbacks > returns a custom OAuth attempt to iOS after consent or refusal (denied=true)"
- Mode: run
- Given: An authenticated organization admin owns a static custom OAuth connector, uses an iOS native return flow, and the app origin is https://app.okou.ai.
- When: The caller uses POST /api/custom-connectors/:id/oauth2/start with x-okou-native-connector-callback ios-https to add an account, the provider declines consent with access_denied through GET /api/custom-connectors/oauth2/callback in JSON response mode and iOS reads the resulting receipt.
- Then: The start returns HTTP 200 with the app's native connector authorization URL containing the attempt ID. The callback returns HTTP 200 with status error and an iOS return descriptor containing the attempt ID and app.okou.ai host. The receipt returns HTTP 404.

## custom-connectors-oauth2-003

- Vitest: "Custom connector OAuth callbacks > preserves editable OAuth configuration in the list without exposing the client secret"
- Mode: run
- Given: An authenticated admin creates a static custom OAuth definition with a client secret, requested scopes, audience and prompt.
- When: The admin compares GET /api/custom-connectors with GET /api/custom-connectors/:id for that definition.
- Then: The list entry is identical to detail and retains adapter, client ID, authorization and token URLs, token authentication method, PKCE, scopes and additional authorization parameters. The client secret is absent.

## custom-connectors-oauth2-004

- Vitest: "Custom connector OAuth callbacks > uses the configured Okou App callback for authorization and token exchange"
- Mode: run
- Given: An authenticated admin has a static OAuth connector and the API and app use distinct canonical origins.
- When: The caller starts authorization through POST /api/custom-connectors/:id/oauth2/start on the API origin and completes through GET /api/custom-connectors/oauth2/callback.
- Then: The provider authorization URL identifies https://app.okou.ai/connectors/custom/callback as redirect_uri and has a 64-character lowercase hex state. The callback returns HTTP 307 to the app callback success URL and the one provider token request uses the same redirect_uri. The list contains a connected custom OAuth account with null external identity fields.

## custom-connectors-oauth2-005

- Vitest: "Custom connector OAuth callbacks > persists verified OIDC identity for a static custom OAuth grant"
- Mode: run
- Given: An authenticated admin has a static OAuth connector requesting read. The provider offers a verified subject and distinct token and UserInfo display identities.
- When: The admin requests authorization via POST /api/custom-connectors/:id/oauth2/start, completes through GET /api/custom-connectors/oauth2/callback and lists the accounts.
- Then: The provider authorization URL requests read. The account has the verified subject as external ID, the UserInfo username and email, and stored read scope.

## custom-connectors-oauth2-006

- Vitest: "Custom connector OAuth callbacks > does not derive the provider callback from an untrusted API host"
- Mode: run
- Given: An authenticated admin has a static OAuth connector and the configured app origin is https://app.okou.ai. The API receives requests via an untrusted lookalike host.
- When: The admin starts authorization through POST /api/custom-connectors/:id/oauth2/start and completes through GET /api/custom-connectors/oauth2/callback.
- Then: The authorization URL and the one token exchange use the configured https://app.okou.ai/connectors/custom/callback redirect URI. The authorization state is a 64-character lowercase hex nonce.

## custom-connectors-oauth2-007

- Vitest: "Custom connector OAuth callbacks > completes a canonical custom OAuth state callback"
- Mode: run
- Given: An authenticated custom connector owner has configured the canonical app and API origins and a static OAuth connector.
- When: The owner starts authorization via POST /api/custom-connectors/:id/oauth2/start and completes the returned state through GET /api/custom-connectors/oauth2/callback.
- Then: The state is 64 lowercase hex characters. The callback returns HTTP 307 to https://app.okou.ai/connectors/custom/callback/success and the one provider token exchange uses https://app.okou.ai/connectors/custom/callback.

## custom-connectors-oauth2-008

- Vitest: "Custom connector OAuth callbacks > completes an in-flight OAuth authorization and uses a new plain nonce on reconnect"
- Mode: run
- Given: An authenticated custom connector owner has an in-flight static OAuth authorization using the canonical configured app origin.
- When: The owner completes the first callback, reads the connected account, starts a reconnect for that exact account and completes it.
- Then: The initial state and reconnect state each have the format of a 64-character lowercase hex nonce. The first callback redirects with HTTP 307 to https://app.okou.ai/connectors/custom/callback/success. Both token exchanges and the reconnect authorization use https://app.okou.ai/connectors/custom/callback.
