# connectors-oauth-reconnect-start

## connectors-oauth-reconnect-start-001

- Vitest: "rejects a reconnect start for an account in other-user scope"
- Mode: run
- Given: A workspace member owns a `github` OAuth account created through `POST /api/connectors/github/oauth/start` and the GitHub callback. A different user in the same organization is signed in (other-user scope).
- When: The other user calls `POST /api/connectors/github/oauth/start` with method `oauth` and intent `reconnect` for the owner's connection ID.
- Then: The response is HTTP 404 with exactly `{ error: { code: NOT_FOUND, message: Connector account not found } }`. The owner's `github` account list is unchanged and the other user's list is empty.

## connectors-oauth-reconnect-start-002

- Vitest: "rejects a reconnect start for an account in other-org scope"
- Mode: run
- Given: A workspace member owns a `github` OAuth account created through `POST /api/connectors/github/oauth/start` and the GitHub callback. The same user is signed in to a different organization (other-org scope).
- When: The user, acting in the other organization, calls `POST /api/connectors/github/oauth/start` with method `oauth` and intent `reconnect` for the owner's connection ID.
- Then: The response is HTTP 404 with exactly `{ error: { code: NOT_FOUND, message: Connector account not found } }`. The owner's `github` account list is unchanged and the list in the other organization is empty.

## connectors-oauth-reconnect-start-003

- Vitest: "rejects a reconnect start for an account under another builtin target"
- Mode: run
- Given: A signed-in member owns a `github` OAuth account.
- When: The member calls `POST /api/connectors/test-oauth/oauth/start` with method `oauth` and intent `reconnect` for the `github` connection ID.
- Then: The response is HTTP 404 with exactly `{ error: { code: NOT_FOUND, message: Connector account not found } }`. The `github` account list is unchanged and the `test-oauth` account list is empty.

## connectors-oauth-reconnect-start-004

- Vitest: "starts and completes a reconnect for the exact owned account"
- Mode: run
- Given: A signed-in member owns a `github` OAuth account, and GitHub identifies the user as ID 39076.
- When: The member calls `POST /api/connectors/github/oauth/start` with intent `reconnect` for that account, and GitHub returns to `GET /api/connectors/github/callback` with a code and the state.
- Then: The start returns no `connectionId` and a UUID `oauthAttemptId`, and the account list is unchanged while consent is pending. The callback returns `success`, and the list then holds only that account with external ID `39076`, marked default.

## connectors-oauth-reconnect-start-005

- Vitest: "rejects reconnect completion after the account is deleted during consent"
- Mode: run
- Given: A signed-in member owns a `github` OAuth account and has started a reconnect for it, then deletes the account through `DELETE /api/connector-accounts/:connectionId` while consent is pending.
- When: GitHub returns to `GET /api/connectors/github/callback` with a code and the reconnect state.
- Then: The callback returns exactly `{ status: error, message: Connector account not found }`, and the `github` account list stays empty.
