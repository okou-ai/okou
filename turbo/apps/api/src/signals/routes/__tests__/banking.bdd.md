# banking

## banking-001

- Vitest: "/api/banking/* > rejects banking requests when the banking feature switch is disabled"
- Mode: run
- Given: Banking is enabled for a Pro member whose chat Run carries an Okou token. The member connected a Finicity customer through a connect session and signed `added`/`done` webhooks, the old savings account disappeared before `done` so only "Everyday Checking" (Example Bank) is connected, and the member saved a 7-day grant for it. The member then turns the banking feature switch off.
- When: The agent calls `POST /api/banking/accounts` with the Run's Okou token.
- Then: The response is HTTP 403 with exactly `{ error: { message: "Banking is not enabled", code: "FORBIDDEN" } }`, and Finicity authentication is never requested.

## banking-002

- Vitest: "/api/banking/* > filters the member’s accounts by their saved grant"
- Mode: run
- Given: Banking is enabled for a Pro member whose chat Run carries an Okou token. The member connected a Finicity customer through a connect session and signed `added`/`done` webhooks, the old savings account disappeared before `done` so only "Everyday Checking" (Example Bank) is connected, and the member saved a 7-day grant for it. Finicity now returns both the checking account ("Provider Checking", last4 6789, USD) and the disabled savings account.
- When: The agent calls `POST /api/banking/accounts` with the Run's Okou token.
- Then: Finicity is called with the app key and app token headers. The response is HTTP 200 with exactly operation `accounts`, provider `finicity`, and one account: the checking account's ID, name "Provider Checking", institution "Example Bank", type checking, last4 6789, status active, currency USD.

## banking-003

- Vitest: "/api/banking/* > denies balances for accounts not enabled by the member"
- Mode: run
- Given: Banking is enabled for a Pro member whose chat Run carries an Okou token. The member connected a Finicity customer through a connect session and signed `added`/`done` webhooks, the old savings account disappeared before `done` so only "Everyday Checking" (Example Bank) is connected, and the member saved a 7-day grant for it.
- When: The agent calls `POST /api/banking/balances` with the Run's Okou token for the disabled savings account.
- Then: The response is HTTP 403 with error code `BANKING_ACCESS_DENIED`, and Finicity's account listing is not called.

## banking-004

- Vitest: "/api/banking/* > reads balances through Finicity with only sanitized fields returned"
- Mode: run
- Given: Banking is enabled for a Pro member whose chat Run carries an Okou token. The member connected a Finicity customer through a connect session and signed `added`/`done` webhooks, the old savings account disappeared before `done` so only "Everyday Checking" (Example Bank) is connected, and the member saved a 7-day grant for it. Finicity returns the checking account with balance 1234.56, available balance 1200.34, USD, a balance date and an extra raw provider field.
- When: The agent calls `POST /api/banking/balances` with the Run's Okou token for the checking account.
- Then: The response is HTTP 200 with exactly operation `balances`, provider `finicity` and a balance with the account ID, name "Provider Checking", type checking, balance 1234.56, available balance 1200.34, currency USD and the balance date; the raw provider field is not returned.

## banking-005

- Vitest: "/api/banking/* > rejects agent tokens without banking capability before provider access"
- Mode: run
- Given: Banking is enabled for a Pro member whose chat Run carries an Okou token. The member connected a Finicity customer through a connect session and signed `added`/`done` webhooks, the old savings account disappeared before `done` so only "Everyday Checking" (Example Bank) is connected, and the member saved a 7-day grant for it. Banking was disabled when the Run launched, so the Run's Okou token lacks the `banking:read` capability.
- When: The agent calls `POST /api/banking/accounts` with that token.
- Then: The response is HTTP 403 with exactly `{ error: { message: "Missing required capability: banking:read", code: "FORBIDDEN" } }`, and Finicity authentication is never requested.

## banking-006

- Vitest: "/api/banking/* > denies automation-event runs unless the banking grant allows automations"
- Mode: run
- Given: Banking is enabled for a Team member whose Run was started by an event automation and carries an Okou token. The member connected Finicity and saved a 7-day grant for the checking account that does not allow automations.
- When: The automation Run calls `POST /api/banking/accounts` with its Okou token.
- Then: The response is HTTP 403 with message "Banking is not enabled for automation runs", and Finicity authentication is never requested.

## banking-007

- Vitest: "/api/banking/* > reads transactions through Finicity with only sanitized fields returned"
- Mode: run
- Given: Banking is enabled for a Pro member whose chat Run carries an Okou token. The member connected a Finicity customer through a connect session and signed `added`/`done` webhooks, the old savings account disappeared before `done` so only "Everyday Checking" (Example Bank) is connected, and the member saved a 7-day grant for it. Finicity returns one transaction for the checking account with an extra raw provider field.
- When: The agent calls `POST /api/banking/transactions` with the Run's Okou token for the checking account, from `2026-01-01` to `2026-01-31` with limit 25.
- Then: Finicity is queried with `fromDate` at the start of 2026-01-01 UTC, `toDate` at the end of 2026-01-31 UTC (epoch seconds), and limit 25. The response is HTTP 200 with exactly operation `transactions`, provider `finicity`, the account ID, and the transaction's ID, account ID, amount -42.5, description "Coffee", memo "latte", posted and transaction dates, status, categorization "Food & Dining" and merchant "Cafe"; the raw provider field is not returned.

## banking-008

- Vitest: "banking access request lifecycle > reuses each owner connection while keeping users and organizations separate"
- Mode: run
- Given: Banking is enabled for three owners: a member, a second user in the same organization, and the first user in another organization. For each owner, Finicity creates exactly one new customer (further customer creation fails with 503) and generates connect links that embed the customer ID.
- When: Each owner reads `GET /api/banking/access-requests/current`, starts a connect session via `POST /api/banking/workspace/connect-sessions`, reads status, starts another connect session, and reads status again.
- Then: Each owner initially has no connection. The first connect returns the link for that owner's new customer and creates a connection ID distinct from every earlier owner's. The second connect returns the same link with a new session ID, and the status keeps the same connection ID with the new session `pending`.

## banking-009

- Vitest: "banking access request lifecycle > leaves connect empty after customer creation fails and allows a later attempt"
- Mode: run
- Given: Banking is enabled for a signed-in member with no connection, and Finicity's customer creation responds with HTTP 503.
- When: The member calls `POST /api/banking/workspace/connect-sessions` and reads `GET /api/banking/access-requests/current`; after customer creation recovers, the member connects again and reads status.
- Then: The first attempt returns HTTP 502 with error code `FINICITY_ERROR`, and the status has a null connection and null session. The retry returns HTTP 200 with the link `https://connect.example.test/recovered-session`, and the status shows an `active` connection with no accounts and the new session `pending`.

## banking-010

- Vitest: "banking access request lifecycle > creates an expiring account-scoped grant and revokes it independently"
- Mode: run
- Given: Banking is enabled for a Pro member whose chat Run carries an Okou token. The member connected a Finicity customer through a connect session and signed `added`/`done` webhooks, so "Everyday Checking" is the only connected account, and saved a 7-day grant for it.
- When: The member saves a 7-day grant for the account via `POST /api/banking/workspace/grant` with purpose "Review recent household spending", reads `GET /api/banking/access-requests/current`, revokes via `POST /api/banking/workspace/grant/revoke`, and reads status again.
- Then: The save returns an `active` grant for exactly that account with the purpose and a non-null expiry, and an `active` connection; the status returns the same grant and connection. The revocation returns grant status `revoked` with the connection still `active`, and the status matches the revocation response.

## banking-011

- Vitest: "banking access request lifecycle > uses branded Mastercard redirect origins without changing the webhook origin"
- Mode: run
- Given: Banking is enabled for a Pro member whose chat Run carries an Okou token. The member connected a Finicity customer through a connect session and signed `added`/`done` webhooks, so "Everyday Checking" is the only connected account, and saved a 7-day grant for it. The app URL is `https://app.okou.ai` and the Finicity webhook base URL is `https://public-api-tunnel.example.test`.
- When: The member calls `POST /api/banking/workspace/connect-sessions` with the `Origin: https://app.okou.ai` header.
- Then: The request returns HTTP 200, and Finicity's connect-link request contains redirect URI `https://app.okou.ai/banking/connect/return` and webhook `https://public-api-tunnel.example.test/api/webhooks/finicity`.

## banking-012

- Vitest: "banking access request lifecycle > replaces concurrent connect sessions and ignores superseded callbacks"
- Mode: run
- Given: Banking is enabled for a signed-in member, and Finicity creates a customer, generates connect links and lists one healthy account.
- When: The member starts a connect session, then two concurrent ones, then a fourth via `POST /api/banking/workspace/connect-sessions`; Finicity posts signed `added` events to `POST /api/webhooks/finicity` for the three superseded sessions; the member reads `GET /api/banking/access-requests/current` before and after.
- Then: The concurrent sessions have different IDs. Status shows the fourth session `pending`. Each superseded callback returns HTTP 200, and afterwards the fourth session is still `pending` and the connection has no accounts.

## banking-013

- Vitest: "banking access request lifecycle > completes only after signed added and done webhooks"
- Mode: run
- Given: Banking is enabled for a Pro member whose chat Run carries an Okou token. The member connected a Finicity customer through a connect session and signed `added`/`done` webhooks, so "Everyday Checking" is the only connected account, and saved a 7-day grant for it. The app URL is `https://local-app.example.test` and the Finicity webhook base URL is `https://public-api-tunnel.example.test`; Finicity lists the healthy checking account.
- When: The member starts a connect session; Finicity posts to `POST /api/webhooks/finicity` a signed `added` event with a mismatched connection ID, the correct `added` event twice, and a `done` event (`userSubmit`); the member then starts another session and Finicity posts only a `done` event (`userExit`) for it. The member reads `GET /api/banking/access-requests/current` between steps.
- Then: The connect session returns link `https://connect.example.test/session`, and Finicity receives the partner ID, customer ID, JSON webhook content type, single-use URL, the connection and session IDs as webhook data, webhook `https://public-api-tunnel.example.test/api/webhooks/finicity` and redirect `https://local-app.example.test/banking/connect/return`. All webhooks return HTTP 200. Before `done` the session is `pending` with the account "Everyday Checking", "Example Bank", last4 6789, not needing repair. After `done` the session is `completed` in mode `connect`. The done-only session becomes `cancelled`.

## banking-014

- Vitest: "banking access request lifecycle > rejects invalid webhook signatures"
- Mode: run
- Given: Finicity webhook signing is configured.
- When: A caller posts a `ping` event to `POST /api/webhooks/finicity` with an all-zero `x-finicity-signature`.
- Then: The response is HTTP 401.

## banking-015

- Vitest: "banking access request lifecycle > serves the Okou Finicity browser return from the API"
- Mode: run
- Given: No authentication is required for the browser return page.
- When: A browser requests `GET /api/banking/connect/return?reason=complete&code=200&reportData=null`.
- Then: The response is HTTP 200 with content type `text/html; charset=utf-8`, and the HTML contains the title "Return to Okou" and the text "continue in Okou Chat.".
