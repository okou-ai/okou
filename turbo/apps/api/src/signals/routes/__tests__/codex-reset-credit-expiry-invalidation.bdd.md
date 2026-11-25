# codex-reset-credit-expiry-invalidation

## codex-reset-credit-expiry-invalidation-001

- Vitest: "Codex expiry invalidation and identity isolation > invalidates on ambiguous consume failure, account route=false"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription and a first `GET /api/me/model-providers` read has returned the upstream reset-credit expiry. The ChatGPT consume endpoint fails with a network error (row: provider-type route, account route=false).
- When: The user consumes a reset credit with `POST /api/me/model-providers/codex-oauth-token/subscription-reset`, the upstream expiry changes to two hours ahead, and the user lists providers again.
- Then: The consume request reaches upstream once with the user's ChatGPT account ID header and a `redeem_request_id` body, and the API returns HTTP 500. The next list returns the new two-hour expiry, with the details endpoint requested three times in total, so the cached expiry was invalidated.

## codex-reset-credit-expiry-invalidation-002

- Vitest: "Codex expiry invalidation and identity isolation > invalidates on ambiguous consume failure, account route=true"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription and a first `GET /api/me/model-providers` read has returned the upstream reset-credit expiry. The ChatGPT consume endpoint fails with a network error (row: account route=true).
- When: The user consumes a reset credit with `POST /api/me/model-provider-accounts/:id/subscription-reset`, the upstream expiry changes to two hours ahead, and the user lists providers again.
- Then: The consume request reaches upstream once with the user's ChatGPT account ID header and a `redeem_request_id` body, and the API returns HTTP 500. The next list returns the new two-hour expiry, with the details endpoint requested three times in total, so the cached expiry was invalidated.

## codex-reset-credit-expiry-invalidation-003

- Vitest: "Codex expiry invalidation and identity isolation > fences an in-flight expiry across consume"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription and a `GET /api/me/model-providers` read is waiting on a stalled reset-credit details request. Upstream consume succeeds (row: consume).
- When: The user consumes a reset credit with `POST /api/me/model-providers/codex-oauth-token/subscription-reset`; then the upstream serves a fresh two-hour expiry, the user lists again, the stalled request completes with the old expiry, and the user lists once more.
- Then: The consume returns HTTP 200 and the pending read returns a null expiry instead of the in-flight value. Both later reads return the fresh two-hour expiry, so the late old response is never adopted.

## codex-reset-credit-expiry-invalidation-004

- Vitest: "Codex expiry invalidation and identity isolation > fences an in-flight expiry across reconnect"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription and a `GET /api/me/model-providers` read is waiting on a stalled reset-credit details request (row: reconnect).
- When: The user reconnects the same Codex credentials with `POST /api/me/model-providers`; then the upstream serves a fresh two-hour expiry, the user lists again, the stalled request completes with the old expiry, and the user lists once more.
- Then: The pending read returns a null expiry instead of the in-flight value. Both later reads return the fresh two-hour expiry, so the late old response is never adopted.

## codex-reset-credit-expiry-invalidation-005

- Vitest: "Codex expiry invalidation and identity isolation > fences an in-flight expiry across replace-account"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription and a `GET /api/me/model-providers` read is waiting on a stalled reset-credit details request (row: replace-account).
- When: The user connects credentials for a different ChatGPT account with `POST /api/me/model-providers`; then the upstream serves a fresh two-hour expiry, the user lists again, the stalled request completes with the old expiry, and the user lists once more.
- Then: The pending read returns a null expiry instead of the in-flight value. Both later reads return the fresh two-hour expiry, so the late old response is never adopted.

## codex-reset-credit-expiry-invalidation-006

- Vitest: "Codex expiry invalidation and identity isolation > rechecks invalidation after expiry settled while the main usage read is pending"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription and already read its reset-credit expiry. A new `GET /api/me/model-providers` read is waiting on a stalled ChatGPT usage request, and upstream consume succeeds.
- When: The user consumes a reset credit with `POST /api/me/model-providers/codex-oauth-token/subscription-reset`, then the stalled usage request returns an available count of 7.
- Then: The consume returns HTTP 200 and the pending read returns a null next expiry with a reset-credit count of 7.

## codex-reset-credit-expiry-invalidation-007

- Vitest: "Codex expiry invalidation and identity isolation > isolates identical upstream credentials by user"
- Mode: run
- Given: A user connected Codex credentials and the details endpoint returned 429 on their first read. Another user in the same workspace (row: user) connects identical upstream credentials after the details endpoint recovers.
- When: The second user and then the first user call `GET /api/me/model-providers`.
- Then: The second user receives the upstream expiry, while the first user still receives a null expiry. The details endpoint is requested four times in total.

## codex-reset-credit-expiry-invalidation-008

- Vitest: "Codex expiry invalidation and identity isolation > isolates identical upstream credentials by org"
- Mode: run
- Given: A user connected Codex credentials and the details endpoint returned 429 on their first read. The same user in a different workspace (row: org) connects identical upstream credentials after the details endpoint recovers.
- When: The caller in the second workspace and then the original caller call `GET /api/me/model-providers`.
- Then: The second-workspace caller receives the upstream expiry, while the original caller still receives a null expiry. The details endpoint is requested four times in total.

## codex-reset-credit-expiry-invalidation-009

- Vitest: "Codex expiry invalidation and identity isolation > preserves another concrete account's cooldown across connect and reconnect"
- Mode: run
- Given: A signed-in user has a Codex account whose details read returned 429 with `Retry-After: 120`. The details endpoint then recovers for other accounts, and the Codex device authorization provider authorizes a second ChatGPT account.
- When: The user adds the second account via `POST /api/model-providers/codex/device-auth/sessions` and `.../sessions/complete` (mode `add`), reconnects it the same way (mode `reconnect`), then lists `GET /api/me/model-providers` twice.
- Then: The first list shows the original account with a null expiry and the second account with the upstream expiry, making exactly one new details request, which is never for the cooled-down account. The second list returns both providers without any further details request.

## codex-reset-credit-expiry-invalidation-010

- Vitest: "Codex expiry invalidation and identity isolation > isolates another member's connect metadata from the personal cooldown"
- Mode: run
- Given: A signed-in user's Codex details read returned 429, then another member of the same workspace connects their own Codex account after the details endpoint recovers.
- When: The other member and then the original user call `GET /api/me/model-providers`.
- Then: The other member receives the upstream expiry. The original user still receives a null expiry and no additional details request is made for them.

## codex-reset-credit-expiry-invalidation-011

- Vitest: "Codex expiry invalidation and identity isolation > does not reuse expiry after changing credential"
- Mode: run
- Given: A signed-in user's Codex subscription expiry has been read once. The user reconnects new credentials for the same ChatGPT account (row: credential) and the upstream expiry changes to two hours ahead.
- When: The user calls `POST /api/me/model-providers` with the new credentials and then `GET /api/me/model-providers`.
- Then: The list returns the new two-hour expiry, with four details requests in total, so the previous expiry is not reused.

## codex-reset-credit-expiry-invalidation-012

- Vitest: "Codex expiry invalidation and identity isolation > does not reuse expiry after changing account"
- Mode: run
- Given: A signed-in user's Codex subscription expiry has been read once. The user connects credentials for a different ChatGPT account (row: account) and the upstream expiry changes to two hours ahead.
- When: The user calls `POST /api/me/model-providers` with the new credentials and then `GET /api/me/model-providers`.
- Then: The list returns the new two-hour expiry, with four details requests in total, so the previous expiry is not reused.

## codex-reset-credit-expiry-invalidation-013

- Vitest: "Codex expiry invalidation and identity isolation > fences an old flight when current credentials rotate without reconnect"
- Mode: run
- Given: A signed-in user's Codex account read is waiting on a stalled details request. The clock advances past the access token's expiry and the OpenAI token endpoint returns a fresh access token.
- When: The user calls `GET /api/me/model-providers` again (which refreshes the credentials), then the stalled old request completes with the old expiry, and the user lists once more.
- Then: The new read sends the details request with the fresh bearer token and returns the fresh expiry. The original pending read returns a null expiry, the final read still returns the fresh expiry, and the details endpoint is requested three times in total.
