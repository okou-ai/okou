# connectors-https-return

## connectors-https-return-001

- Vitest: "returns gmail to iOS only after completing its original backend grant"
- Mode: run
- Given: A signed-in workspace member connects the builtin `gmail` connector with its `oauth` method; the app runs at `https://app.okou.ai`. Google exchanges the code only when the token request uses the redirect URI `https://app.okou.ai/connectors/gmail/callback`, and Google userinfo returns `Native User`.
- When: The member starts `POST /api/connectors/gmail/oauth/start` with intent `add`, `callbackTarget: app` and `nativeCallback: ios-https`, checks the completion receipt, then the provider returns to `GET /api/connectors/gmail/callback` with a code and the state in JSON response mode.
- Then: The start returns `nativeCallbackUrl` `https://app.okou.ai/native/connector-authorization?attemptId=<oauthAttemptId>` and an authorization URL whose `redirect_uri` is `https://app.okou.ai/connectors/gmail/callback`. `GET /api/connector-accounts/oauth-completions/:attemptId` returns HTTP 404 before the callback. The callback returns `success` with `nativeAppReturn` `{ platform: ios, attemptId, httpsHost: app.okou.ai }`, after which the receipt returns HTTP 200 and `GET /api/connector-accounts/:connectionId` shows that connection as `connected`.

## connectors-https-return-002

- Vitest: "returns google-docs to iOS only after completing its original backend grant"
- Mode: run
- Given: A signed-in workspace member connects the builtin `google-docs` connector with its `oauth` method; the app runs at `https://app.okou.ai`. Google exchanges the code only when the token request uses the redirect URI `https://app.okou.ai/connectors/google-docs/callback`, and Google userinfo returns `Native User`.
- When: The member starts `POST /api/connectors/google-docs/oauth/start` with intent `add`, `callbackTarget: app` and `nativeCallback: ios-https`, checks the completion receipt, then the provider returns to `GET /api/connectors/google-docs/callback` with a code and the state in JSON response mode.
- Then: The start returns `nativeCallbackUrl` `https://app.okou.ai/native/connector-authorization?attemptId=<oauthAttemptId>` and an authorization URL whose `redirect_uri` is `https://app.okou.ai/connectors/google-docs/callback`. `GET /api/connector-accounts/oauth-completions/:attemptId` returns HTTP 404 before the callback. The callback returns `success` with `nativeAppReturn` `{ platform: ios, attemptId, httpsHost: app.okou.ai }`, after which the receipt returns HTTP 200 and `GET /api/connector-accounts/:connectionId` shows that connection as `connected`.

## connectors-https-return-003

- Vitest: "returns google-drive to iOS only after completing its original backend grant"
- Mode: run
- Given: A signed-in workspace member connects the builtin `google-drive` connector with its `oauth` method; the app runs at `https://app.okou.ai`. Google exchanges the code only when the token request uses the redirect URI `https://app.okou.ai/connectors/google-drive/callback`, and Google userinfo returns `Native User`.
- When: The member starts `POST /api/connectors/google-drive/oauth/start` with intent `add`, `callbackTarget: app` and `nativeCallback: ios-https`, checks the completion receipt, then the provider returns to `GET /api/connectors/google-drive/callback` with a code and the state in JSON response mode.
- Then: The start returns `nativeCallbackUrl` `https://app.okou.ai/native/connector-authorization?attemptId=<oauthAttemptId>` and an authorization URL whose `redirect_uri` is `https://app.okou.ai/connectors/google-drive/callback`. `GET /api/connector-accounts/oauth-completions/:attemptId` returns HTTP 404 before the callback. The callback returns `success` with `nativeAppReturn` `{ platform: ios, attemptId, httpsHost: app.okou.ai }`, after which the receipt returns HTTP 200 and `GET /api/connector-accounts/:connectionId` shows that connection as `connected`.

## connectors-https-return-004

- Vitest: "returns google-sheets to iOS only after completing its original backend grant"
- Mode: run
- Given: A signed-in workspace member connects the builtin `google-sheets` connector with its `oauth` method; the app runs at `https://app.okou.ai`. Google exchanges the code only when the token request uses the redirect URI `https://app.okou.ai/connectors/google-sheets/callback`, and Google userinfo returns `Native User`.
- When: The member starts `POST /api/connectors/google-sheets/oauth/start` with intent `add`, `callbackTarget: app` and `nativeCallback: ios-https`, checks the completion receipt, then the provider returns to `GET /api/connectors/google-sheets/callback` with a code and the state in JSON response mode.
- Then: The start returns `nativeCallbackUrl` `https://app.okou.ai/native/connector-authorization?attemptId=<oauthAttemptId>` and an authorization URL whose `redirect_uri` is `https://app.okou.ai/connectors/google-sheets/callback`. `GET /api/connector-accounts/oauth-completions/:attemptId` returns HTTP 404 before the callback. The callback returns `success` with `nativeAppReturn` `{ platform: ios, attemptId, httpsHost: app.okou.ai }`, after which the receipt returns HTTP 200 and `GET /api/connector-accounts/:connectionId` shows that connection as `connected`.

## connectors-https-return-005

- Vitest: "returns google-calendar to iOS only after completing its original backend grant"
- Mode: run
- Given: A signed-in workspace member connects the builtin `google-calendar` connector with its `oauth` method; the app runs at `https://app.okou.ai`. Google exchanges the code only when the token request uses the redirect URI `https://app.okou.ai/connectors/google-calendar/callback`, and Google userinfo returns `Native User`.
- When: The member starts `POST /api/connectors/google-calendar/oauth/start` with intent `add`, `callbackTarget: app` and `nativeCallback: ios-https`, checks the completion receipt, then the provider returns to `GET /api/connectors/google-calendar/callback` with a code and the state in JSON response mode.
- Then: The start returns `nativeCallbackUrl` `https://app.okou.ai/native/connector-authorization?attemptId=<oauthAttemptId>` and an authorization URL whose `redirect_uri` is `https://app.okou.ai/connectors/google-calendar/callback`. `GET /api/connector-accounts/oauth-completions/:attemptId` returns HTTP 404 before the callback. The callback returns `success` with `nativeAppReturn` `{ platform: ios, attemptId, httpsHost: app.okou.ai }`, after which the receipt returns HTTP 200 and `GET /api/connector-accounts/:connectionId` shows that connection as `connected`.

## connectors-https-return-006

- Vitest: "returns google-ads to iOS only after completing its original backend grant"
- Mode: run
- Given: A signed-in workspace member connects the builtin `google-ads` connector with its `oauth` method; the app runs at `https://app.okou.ai`. Google exchanges the code only when the token request uses the redirect URI `https://app.okou.ai/connectors/google-ads/callback`, and Google userinfo returns `Native User`.
- When: The member starts `POST /api/connectors/google-ads/oauth/start` with intent `add`, `callbackTarget: app` and `nativeCallback: ios-https`, checks the completion receipt, then the provider returns to `GET /api/connectors/google-ads/callback` with a code and the state in JSON response mode.
- Then: The start returns `nativeCallbackUrl` `https://app.okou.ai/native/connector-authorization?attemptId=<oauthAttemptId>` and an authorization URL whose `redirect_uri` is `https://app.okou.ai/connectors/google-ads/callback`. `GET /api/connector-accounts/oauth-completions/:attemptId` returns HTTP 404 before the callback. The callback returns `success` with `nativeAppReturn` `{ platform: ios, attemptId, httpsHost: app.okou.ai }`, after which the receipt returns HTTP 200 and `GET /api/connector-accounts/:connectionId` shows that connection as `connected`.

## connectors-https-return-007

- Vitest: "returns google-analytics to iOS only after completing its original backend grant"
- Mode: run
- Given: A signed-in workspace member connects the builtin `google-analytics` connector with its `oauth` method; the app runs at `https://app.okou.ai`. Google exchanges the code only when the token request uses the redirect URI `https://app.okou.ai/connectors/google-analytics/callback`, and Google userinfo returns `Native User`.
- When: The member starts `POST /api/connectors/google-analytics/oauth/start` with intent `add`, `callbackTarget: app` and `nativeCallback: ios-https`, checks the completion receipt, then the provider returns to `GET /api/connectors/google-analytics/callback` with a code and the state in JSON response mode.
- Then: The start returns `nativeCallbackUrl` `https://app.okou.ai/native/connector-authorization?attemptId=<oauthAttemptId>` and an authorization URL whose `redirect_uri` is `https://app.okou.ai/connectors/google-analytics/callback`. `GET /api/connector-accounts/oauth-completions/:attemptId` returns HTTP 404 before the callback. The callback returns `success` with `nativeAppReturn` `{ platform: ios, attemptId, httpsHost: app.okou.ai }`, after which the receipt returns HTTP 200 and `GET /api/connector-accounts/:connectionId` shows that connection as `connected`.

## connectors-https-return-008

- Vitest: "returns google-forms to iOS only after completing its original backend grant"
- Mode: run
- Given: A signed-in workspace member connects the builtin `google-forms` connector with its `oauth` method; the app runs at `https://app.okou.ai`. Google exchanges the code only when the token request uses the redirect URI `https://app.okou.ai/connectors/google-forms/callback`, and Google userinfo returns `Native User`.
- When: The member starts `POST /api/connectors/google-forms/oauth/start` with intent `add`, `callbackTarget: app` and `nativeCallback: ios-https`, checks the completion receipt, then the provider returns to `GET /api/connectors/google-forms/callback` with a code and the state in JSON response mode.
- Then: The start returns `nativeCallbackUrl` `https://app.okou.ai/native/connector-authorization?attemptId=<oauthAttemptId>` and an authorization URL whose `redirect_uri` is `https://app.okou.ai/connectors/google-forms/callback`. `GET /api/connector-accounts/oauth-completions/:attemptId` returns HTTP 404 before the callback. The callback returns `success` with `nativeAppReturn` `{ platform: ios, attemptId, httpsHost: app.okou.ai }`, after which the receipt returns HTTP 200 and `GET /api/connector-accounts/:connectionId` shows that connection as `connected`.

## connectors-https-return-009

- Vitest: "returns google-maps to iOS only after completing its original backend grant"
- Mode: run
- Given: A signed-in workspace member connects the builtin `google-maps` connector with its `oauth` method; the app runs at `https://app.okou.ai`. Google exchanges the code only when the token request uses the redirect URI `https://app.okou.ai/connectors/google-maps/callback`, and Google userinfo returns `Native User`.
- When: The member starts `POST /api/connectors/google-maps/oauth/start` with intent `add`, `callbackTarget: app` and `nativeCallback: ios-https`, checks the completion receipt, then the provider returns to `GET /api/connectors/google-maps/callback` with a code and the state in JSON response mode.
- Then: The start returns `nativeCallbackUrl` `https://app.okou.ai/native/connector-authorization?attemptId=<oauthAttemptId>` and an authorization URL whose `redirect_uri` is `https://app.okou.ai/connectors/google-maps/callback`. `GET /api/connector-accounts/oauth-completions/:attemptId` returns HTTP 404 before the callback. The callback returns `success` with `nativeAppReturn` `{ platform: ios, attemptId, httpsHost: app.okou.ai }`, after which the receipt returns HTTP 200 and `GET /api/connector-accounts/:connectionId` shows that connection as `connected`.

## connectors-https-return-010

- Vitest: "returns google-meet to iOS only after completing its original backend grant"
- Mode: run
- Given: A signed-in workspace member connects the builtin `google-meet` connector with its `oauth` method; the app runs at `https://app.okou.ai`. Google exchanges the code only when the token request uses the redirect URI `https://app.okou.ai/connectors/google-meet/callback`, and Google userinfo returns `Native User`.
- When: The member starts `POST /api/connectors/google-meet/oauth/start` with intent `add`, `callbackTarget: app` and `nativeCallback: ios-https`, checks the completion receipt, then the provider returns to `GET /api/connectors/google-meet/callback` with a code and the state in JSON response mode.
- Then: The start returns `nativeCallbackUrl` `https://app.okou.ai/native/connector-authorization?attemptId=<oauthAttemptId>` and an authorization URL whose `redirect_uri` is `https://app.okou.ai/connectors/google-meet/callback`. `GET /api/connector-accounts/oauth-completions/:attemptId` returns HTTP 404 before the callback. The callback returns `success` with `nativeAppReturn` `{ platform: ios, attemptId, httpsHost: app.okou.ai }`, after which the receipt returns HTTP 200 and `GET /api/connector-accounts/:connectionId` shows that connection as `connected`.

## connectors-https-return-011

- Vitest: "returns youtube to iOS only after completing its original backend grant"
- Mode: run
- Given: A signed-in workspace member connects the builtin `youtube` connector with its `oauth` method; the app runs at `https://app.okou.ai`. Google exchanges the code only when the token request uses the redirect URI `https://app.okou.ai/connectors/youtube/callback`, and Google userinfo returns `Native User`.
- When: The member starts `POST /api/connectors/youtube/oauth/start` with intent `add`, `callbackTarget: app` and `nativeCallback: ios-https`, checks the completion receipt, then the provider returns to `GET /api/connectors/youtube/callback` with a code and the state in JSON response mode.
- Then: The start returns `nativeCallbackUrl` `https://app.okou.ai/native/connector-authorization?attemptId=<oauthAttemptId>` and an authorization URL whose `redirect_uri` is `https://app.okou.ai/connectors/youtube/callback`. `GET /api/connector-accounts/oauth-completions/:attemptId` returns HTTP 404 before the callback. The callback returns `success` with `nativeAppReturn` `{ platform: ios, attemptId, httpsHost: app.okou.ai }`, after which the receipt returns HTTP 200 and `GET /api/connector-accounts/:connectionId` shows that connection as `connected`.

## connectors-https-return-012

- Vitest: "returns github to iOS only after completing its original backend grant"
- Mode: run
- Given: A signed-in workspace member connects the builtin `github` connector with its `oauth` method; the app runs at `https://app.okou.ai`. GitHub exchanges the code and identifies the user as `native-oauth`.
- When: The member starts `POST /api/connectors/github/oauth/start` with intent `add`, `callbackTarget: app` and `nativeCallback: ios-https`, checks the completion receipt, then the provider returns to `GET /api/connectors/github/callback` with a code and the state in JSON response mode.
- Then: The start returns `nativeCallbackUrl` `https://app.okou.ai/native/connector-authorization?attemptId=<oauthAttemptId>` and an authorization URL whose `redirect_uri` is `https://app.okou.ai/connectors/github/callback`. `GET /api/connector-accounts/oauth-completions/:attemptId` returns HTTP 404 before the callback. The callback returns `success` with `nativeAppReturn` `{ platform: ios, attemptId, httpsHost: app.okou.ai }`, after which the receipt returns HTTP 200 and `GET /api/connector-accounts/:connectionId` shows that connection as `connected`.

## connectors-https-return-013

- Vitest: "returns notion to iOS only after completing its original backend grant"
- Mode: run
- Given: A signed-in workspace member connects the builtin `notion` connector with its `oauth` method; the app runs at `https://app.okou.ai`. Notion exchanges the code only when the token request uses the redirect URI `https://app.okou.ai/connectors/notion/callback` and returns owner `Native User`.
- When: The member starts `POST /api/connectors/notion/oauth/start` with intent `add`, `callbackTarget: app` and `nativeCallback: ios-https`, checks the completion receipt, then the provider returns to `GET /api/connectors/notion/callback` with a code and the state in JSON response mode.
- Then: The start returns `nativeCallbackUrl` `https://app.okou.ai/native/connector-authorization?attemptId=<oauthAttemptId>` and an authorization URL whose `redirect_uri` is `https://app.okou.ai/connectors/notion/callback`. `GET /api/connector-accounts/oauth-completions/:attemptId` returns HTTP 404 before the callback. The callback returns `success` with `nativeAppReturn` `{ platform: ios, attemptId, httpsHost: app.okou.ai }`, after which the receipt returns HTTP 200 and `GET /api/connector-accounts/:connectionId` shows that connection as `connected`.

## connectors-https-return-014

- Vitest: "returns provider refusal to iOS without creating a connection or allowing state replay"
- Mode: run
- Given: A signed-in member has started a `github` OAuth add with `nativeCallback: ios-https`.
- When: GitHub returns to `GET /api/connectors/github/callback` with the state and `error=access_denied` in JSON response mode, and then the same state is replayed with code `replayed`.
- Then: The refusal returns `error` with `nativeAppReturn` `{ platform: ios, attemptId, httpsHost: app.okou.ai }`, and the completion receipt returns HTTP 404. The replay returns `error` without any `nativeAppReturn`.

## connectors-https-return-015

- Vitest: "uses the HTTPS return for direct callbacks and ignores unclaimed native-looking state"
- Mode: run
- Given: A signed-in member has started a `github` OAuth add with `nativeCallback: ios-https`.
- When: The browser hits `GET https://api.okou.ai/api/connectors/github/callback` directly (header `x-okou-web-origin: https://okou.ai`) with the state and `error=access_denied`, and then with an unclaimed state `ios-https-v1:<random>`.
- Then: The first request redirects with HTTP 307 to the attempt's `nativeCallbackUrl`. The request with the unclaimed native-looking state redirects to the `/connector/error` page.

## connectors-https-return-016

- Vitest: "keeps web grants unchanged and returns connectors outside the original whitelist"
- Mode: run
- Given: A signed-in member starts a web `github` OAuth add without a native callback and a native (`ios-https`) add for the `test-oauth` connector, which is outside the original list of connectors.
- When: The provider returns `error=access_denied` to `GET /api/connectors/test-oauth/callback` and to `GET /api/connectors/github/callback` for the respective states, in JSON response mode.
- Then: The web start has no `nativeCallbackUrl`, while the `test-oauth` start has `https://app.okou.ai/native/connector-authorization?attemptId=<oauthAttemptId>`. The `test-oauth` refusal returns `nativeAppReturn` with that attempt ID and host `app.okou.ai`. The `github` web refusal returns `error` without `nativeAppReturn`.

## connectors-https-return-017

- Vitest: "keeps staging returns on their associated domain and omits HTTPS mode on arbitrary previews"
- Mode: run
- Given: A signed-in member starts native `github` OAuth adds (`nativeCallback: ios-https`), first with the app at `https://staging-app.omby.ai` and then at the arbitrary preview `https://pr-123-app-okou-app-preview.vm0.workers.dev`.
- When: The member calls `POST /api/connectors/github/oauth/start` with intent `add` under each app URL.
- Then: The staging start returns `nativeCallbackUrl` `https://staging-app.omby.ai/native/connector-authorization?attemptId=<oauthAttemptId>`, and the preview start returns no `nativeCallbackUrl`.
