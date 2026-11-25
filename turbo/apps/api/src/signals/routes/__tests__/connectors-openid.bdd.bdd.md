# connectors-openid.bdd

## connectors-openid.bdd-001

- Vitest: "Steam OpenID connector > returns the initiating native OpenID attempt after provider verification"
- Mode: run
- Given: A signed-in workspace member connects the builtin `steam` connector with its `openid` method; the app runs at `https://app.okou.ai`, and Steam confirms the OpenID assertion as valid.
- When: The member starts `POST /api/connectors/steam/openid/start` with intent `add` and `nativeCallback: ios-https`, then Steam returns a signed `id_res` assertion for SteamID `76561198000000000` to `GET /api/connectors/steam/callback` with the state in JSON response mode.
- Then: The start returns `nativeCallbackUrl` `https://app.okou.ai/native/connector-authorization?attemptId=<oauthAttemptId>`, and the callback returns `success` with `nativeAppReturn` `{ platform: ios, attemptId, httpsHost: app.okou.ai }`.

## connectors-openid.bdd-002

- Vitest: "Steam OpenID connector > exposes Steam in the connector catalog by default"
- Mode: run
- Given: A signed-in workspace member has no feature switch overrides.
- When: The member calls `GET /api/connector-catalog/status`.
- Then: The response is HTTP 200 and the catalog includes `steam` with a single `openid` auth method whose grant kind is `openid-auth`.

## connectors-openid.bdd-003

- Vitest: "Steam OpenID connector > starts Steam OpenID auth and stores the verified SteamID on callback"
- Mode: run
- Given: A signed-in member connects `steam`; the API runs at `https://api.okou.ai`, and Steam confirms the OpenID assertion as valid.
- When: The member starts `POST /api/connectors/steam/openid/start` with intent `add`, Steam returns a signed assertion for SteamID `76561198000000000` to `GET /api/connectors/steam/callback`, and the member reads the default account and `GET /api/connector-accounts/oauth-completions/:attemptId`.
- Then: The authorization URL is `https://steamcommunity.com/openid/login` with `openid.realm` `https://api.okou.ai/` and `openid.return_to` `https://api.okou.ai/api/connectors/steam/callback?state=<64 hex>`. The callback redirects with HTTP 307. The completion is exactly `{ connectionId }` of the default account, which is a `connected` `openid` `steam` account with external ID and username `76561198000000000` and empty `oauthScopes`.

## connectors-openid.bdd-004

- Vitest: "Steam OpenID connector > keeps the active Steam connection until a verified replacement succeeds"
- Mode: run
- Given: A signed-in member has a connected `steam` account. The member starts another `openid` add, and Steam then reports that assertion as invalid; later Steam confirms assertions as valid again.
- When: The invalid assertion arrives at `GET /api/connectors/steam/callback`; then the member starts `POST /api/connectors/steam/openid/start` with intent `reconnect` for the account and Steam returns a valid assertion for it.
- Then: While the second add is pending its completion returns HTTP 404 and the account is unchanged. The invalid callback redirects with HTTP 307 to `/connector/error` with `connectorSlug=steam` and message `OpenID authorization failed. Please try again.`, and the account stays unchanged. During the reconnect the completion returns HTTP 404 `OAuth completion not found` and the account is unchanged. After the valid callback the default account keeps the same ID and SteamID, and the reconnect completion returns exactly `{ connectionId }` of that account.

## connectors-openid.bdd-005

- Vitest: "Steam OpenID connector > rejects a other-user reconnect target without changing its account"
- Mode: run
- Given: A workspace member owns a connected `steam` OpenID account. A different user in the same organization is signed in (other-user scenario).
- When: The other user calls `POST /api/connectors/steam/openid/start` with method `openid` and intent `reconnect` for the owner's connection ID.
- Then: The response is HTTP 404 with exactly `{ error: { code: NOT_FOUND, message: Connector account not found } }`, and the owner's `steam` account list is unchanged.

## connectors-openid.bdd-006

- Vitest: "Steam OpenID connector > rejects a other-org reconnect target without changing its account"
- Mode: run
- Given: A workspace member owns a connected `steam` OpenID account. The same user is signed in to a different organization (other-org scenario).
- When: The user, acting in the other organization, calls `POST /api/connectors/steam/openid/start` with method `openid` and intent `reconnect` for the owner's connection ID.
- Then: The response is HTTP 404 with exactly `{ error: { code: NOT_FOUND, message: Connector account not found } }`, and the owner's `steam` account list is unchanged.

## connectors-openid.bdd-007

- Vitest: "Steam OpenID connector > rejects a wrong-target reconnect target without changing its account"
- Mode: run
- Given: A signed-in member owns a connected `github` OAuth account (wrong-target scenario).
- When: The member calls `POST /api/connectors/steam/openid/start` with method `openid` and intent `reconnect` for the `github` connection ID.
- Then: The response is HTTP 404 with exactly `{ error: { code: NOT_FOUND, message: Connector account not found } }`, and the member's `github` account list is unchanged.

## connectors-openid.bdd-008

- Vitest: "Steam OpenID connector > rejects OpenID start requests for non-OpenID connector methods"
- Mode: run
- Given: A signed-in member targets `github`, whose `oauth` method is not an OpenID method.
- When: The member calls `POST /api/connectors/github/openid/start` with method `oauth` and intent `add`.
- Then: The response is HTTP 400 and the error message mentions both `auth grant` and `OpenID`.
