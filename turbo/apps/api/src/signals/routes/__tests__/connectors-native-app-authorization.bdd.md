# connectors-native-app-authorization

## connectors-native-app-authorization-001

- Vitest: "retains web authorization without both native capability and app callback: app / undefined"
- Mode: run
- Given: A signed-in workspace member connects the builtin `strava` connector with its `oauth` method; the request sets `callbackTarget: app` but no `nativeAppAuthorization`.
- When: The member calls `POST /api/connectors/strava/oauth/start` with intent `add`.
- Then: The response is HTTP 200 without `nativeAppAuthorization`, and the authorization URL path is the web `/oauth/authorize`.

## connectors-native-app-authorization-002

- Vitest: "retains web authorization without both native capability and app callback: undefined / ios"
- Mode: run
- Given: A signed-in workspace member connects the builtin `strava` connector with its `oauth` method; the request sets `nativeAppAuthorization: ios` but no `callbackTarget`.
- When: The member calls `POST /api/connectors/strava/oauth/start` with intent `add`.
- Then: The response is HTTP 200 without `nativeAppAuthorization`, and the authorization URL path is the web `/oauth/authorize`.

## connectors-native-app-authorization-003

- Vitest: "binds mobile authorization to the registered HTTPS callback and confirms the exact account"
- Mode: run
- Given: A signed-in member connects `strava` from iOS (`callbackTarget: app`, `nativeAppAuthorization: ios`). Strava exchanges code `mobile-code` using the client secret and no redirect URI, returns a rotating refresh token and athlete 42.
- When: The member starts `POST /api/connectors/strava/oauth/start` with intent `add`, Strava returns to `GET /api/connectors/strava/callback` with the code and scope `read,activity:read_all,profile:read_all`, the member then reconnects the new account the same way, and finally the first callback is replayed.
- Then: The start returns `nativeAppAuthorization` `{ provider: strava }` and an authorization URL at `https://www.strava.com/oauth/mobile/authorize` with redirect URI `https://app.okou.ai/connectors/strava/callback`, the required scope and no client secret. The receipt returns HTTP 404 before the callback; the callback returns `success` with `nativeAppReturn` for iOS and the attempt; the receipt then returns HTTP 200 and the account is a `connected` `oauth` `strava` account with scopes `[read, activity:read_all, profile:read_all]` that does not expose the refresh token. The reconnect receipt is exactly `{ connectionId }` of the same account. The replayed first callback returns `error` without `nativeAppReturn`.

## connectors-native-app-authorization-004

- Vitest: "returns a denied attempt to iOS without a completion or a second authorization"
- Mode: run
- Given: A signed-in member has started an iOS `strava` OAuth add (`callbackTarget: app`, `nativeAppAuthorization: ios`).
- When: Strava returns to `GET /api/connectors/strava/callback` with the state and `error=access_denied`.
- Then: The callback returns `error` with `nativeAppReturn` for platform `ios` and the attempt ID, and the completion receipt returns HTTP 404.

## connectors-native-app-authorization-005

- Vitest: "does not declare background access with missing scopes or refresh credentials: read / refresh"
- Mode: run
- Given: A signed-in member has started an iOS `strava` OAuth add, and Strava's token exchange returns a refresh token.
- When: Strava returns to `GET /api/connectors/strava/callback` with the code but only scope `read`.
- Then: The callback returns `error` with `nativeAppReturn` for the attempt, and the completion receipt returns HTTP 404.

## connectors-native-app-authorization-006

- Vitest: "does not declare background access with missing scopes or refresh credentials: read,activity:read_all,profile:read_all / null"
- Mode: run
- Given: A signed-in member has started an iOS `strava` OAuth add, and Strava's token exchange returns no refresh token.
- When: Strava returns to `GET /api/connectors/strava/callback` with the code and the full scope `read,activity:read_all,profile:read_all`.
- Then: The callback returns `error` with `nativeAppReturn` for the attempt, and the completion receipt returns HTTP 404.

## connectors-native-app-authorization-007

- Vitest: "does not issue an app return for expired, foreign or fabricated state"
- Mode: run
- Given: A signed-in member has two pending iOS `strava` OAuth attempts.
- When: The first attempt's callback arrives after the clock advances 16 minutes; the second attempt's state is sent to `GET /api/connectors/dropbox/callback` with `error=access_denied` and then to the `strava` callback with `error=access_denied`; finally a random fabricated state is sent to the `strava` callback.
- Then: The expired callback returns `error` without `nativeAppReturn`. The wrong-connector callback returns `error` without `nativeAppReturn`, while the correct `strava` refusal returns `nativeAppReturn` for the second attempt. The fabricated state returns `error` without `nativeAppReturn`.
