# banking-webhook

## banking-webhook-001

- Vitest: "Finicity webhook outcomes > notifies only the owner after connect, signed webhook updates, and grant changes"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member, Finicity authenticates the partner, creates a customer and generates connect links, and the member has started a connect session (`POST /api/banking/workspace/connect-sessions`). Finicity lists one healthy checking account for the customer, and webhook bodies are signed with the app secret.
- When: The member starts a new connect session; Finicity posts signed `added` and `done` events (and `done` again) to `POST /api/webhooks/finicity`; the member saves a 7-day grant for the account via `POST /api/banking/workspace/grant`, revokes it via `POST /api/banking/workspace/grant/revoke`, and saves it again while realtime publishing fails.
- Then: Starting, `added`, `done`, saving, revoking and re-saving each publish exactly one `bankingAccessChanged` notification on the owner's `user:<id>` channel. Status via `GET /api/banking/access-requests/current` shows the session pending, then one connected account, then `completed`; the replayed `done` returns HTTP 200 and publishes nothing. The grant is `active`, then `revoked`, and after the re-save with failing publishing it is `active`.

## banking-webhook-002

- Vitest: "Finicity webhook outcomes > notifies the owner after a connect session fails with unavailable"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member, Finicity authenticates the partner, creates a customer and generates connect links, and the member has started a connect session (`POST /api/banking/workspace/connect-sessions`), and Finicity's connect-link generation now responds with HTTP 503.
- When: The member starts another connect session via `POST /api/banking/workspace/connect-sessions` and reads `GET /api/banking/access-requests/current`.
- Then: The request returns HTTP 502 and the session status is `failed`. Exactly two `bankingAccessChanged` notifications are published, both on the owner's `user:<id>` channel.

## banking-webhook-003

- Vitest: "Finicity webhook outcomes > notifies the owner after a connect session fails with invalid-response"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member, Finicity authenticates the partner, creates a customer and generates connect links, and the member has started a connect session (`POST /api/banking/workspace/connect-sessions`), and Finicity's connect-link generation now returns an empty JSON body without a link.
- When: The member starts another connect session via `POST /api/banking/workspace/connect-sessions` and reads `GET /api/banking/access-requests/current`.
- Then: The request returns HTTP 502 and the session status is `failed`. Exactly two `bankingAccessChanged` notifications are published, both on the owner's `user:<id>` channel.

## banking-webhook-004

- Vitest: "Finicity webhook outcomes > preserves a replacement while an older connect provider response ends in success"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member, Finicity authenticates the partner, creates a customer and generates connect links, and the member has started a connect session (`POST /api/banking/workspace/connect-sessions`). A new connect request is held at Finicity's link generation and will eventually succeed.
- When: While the older request is held, the member starts a replacement session; the older request then finishes; Finicity posts a signed `added` event for the older session, then `added` and `done` for the replacement to `POST /api/webhooks/finicity`; the member starts another session.
- Then: The replacement gets a different session ID and status shows it `pending` in mode `connect`. The older request returns HTTP 200 with its own session ID. The older `added` event returns HTTP 200 but leaves the replacement pending with no accounts. After the replacement's events the session is `completed`, and the next start creates a new pending session.

## banking-webhook-005

- Vitest: "Finicity webhook outcomes > preserves a replacement while an older connect provider response ends in failure"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member, Finicity authenticates the partner, creates a customer and generates connect links, and the member has started a connect session (`POST /api/banking/workspace/connect-sessions`). A new connect request is held at Finicity's link generation and will eventually fail with HTTP 503.
- When: While the older request is held, the member starts a replacement session; the older request then finishes; Finicity posts a signed `added` event for the older session, then `added` and `done` for the replacement to `POST /api/webhooks/finicity`; the member starts another session.
- Then: The replacement gets a different session ID and status shows it `pending` in mode `connect`. The older request returns HTTP 502. The older `added` event returns HTTP 200 but leaves the replacement pending with no accounts. After the replacement's events the session is `completed`, and the next start creates a new pending session.

## banking-webhook-006

- Vitest: "Finicity webhook outcomes > keeps unknown events pending and preserves added/done results on replay"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member who has a pending Finicity connect session, and Finicity initially lists one healthy account.
- When: Finicity posts a signed `institutionSelected` event twice to `POST /api/webhooks/finicity`; then an `added` event, and the same `added` event again after Finicity starts reporting the account as needing repair; then a `done` event with a long reason and ISO timestamp, and the same `done` again after Finicity lists no accounts. The member reads `GET /api/banking/access-requests/current` after each step.
- Then: Every webhook returns HTTP 200. After the unknown events the session is still `pending` with no accounts. After the replayed `added` the session is `pending` with one account and `repairRequired` false. After `done` the session is `completed`, and after the replayed `done` it remains `completed` with one account.

## banking-webhook-007

- Vitest: "Finicity webhook outcomes > updates account metadata, removes absent accounts and restores their identities"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member who has a pending Finicity connect session. Finicity first lists a repair-needed account at institution "bank" and a healthy one at "other".
- When: Finicity posts a signed `added` event to `POST /api/webhooks/finicity`; Finicity then lists only "other" renamed "Savings" (type savings) and posts another `added`; Finicity then lists "bank" renamed "Restored Checking" plus "Savings" and posts `done`. The member reads `GET /api/banking/access-requests/current` after each.
- Then: Initially the connection is `repair_required` and the "bank" account needs repair. After the second event the session is `pending`, the connection `active` with no repair institutions, and only the "other" account remains with the same ID, name "Savings", type savings and no repair. After `done` the session is `completed`, the connection `active` with no repair institutions and two accounts: "bank" restored under its original ID as "Restored Checking" without repair, and "Savings".

## banking-webhook-008

- Vitest: "Finicity webhook outcomes > clears an empty provider directory and restores the same account identity"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member who has a pending Finicity connect session, and Finicity lists one healthy account.
- When: Finicity posts a signed `added` event to `POST /api/webhooks/finicity`; then, while Finicity lists no accounts, another `added`; then, with the account listed again, a third `added`. The member reads `GET /api/banking/access-requests/current` after each.
- Then: Every webhook returns HTTP 200. With no accounts the connection is `active` with an empty account list and the session is `pending`. After the account returns, the list contains exactly one account with the original ID and `repairRequired` false.

## banking-webhook-009

- Vitest: "Finicity webhook outcomes > uses the last duplicate account with repairRequired=false"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member who has a pending Finicity connect session. Finicity lists two accounts with the same ID at "bank": first a repair-needed checking account, then a healthy "Latest savings" savings account.
- When: Finicity posts a signed `added` event to `POST /api/webhooks/finicity` and the member reads `GET /api/banking/access-requests/current`.
- Then: The webhook returns HTTP 200. The connection is `active` and has exactly one account: "Latest savings", type savings, `repairRequired` false.

## banking-webhook-010

- Vitest: "Finicity webhook outcomes > uses the last duplicate account with repairRequired=true"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member who has a pending Finicity connect session. Finicity lists two accounts with the same ID at "bank": first a healthy checking account, then a repair-needed "Latest savings" savings account.
- When: Finicity posts a signed `added` event to `POST /api/webhooks/finicity` and the member reads `GET /api/banking/access-requests/current`.
- Then: The webhook returns HTTP 200. The connection is `repair_required` and has exactly one account: "Latest savings", type savings, `repairRequired` true.

## banking-webhook-011

- Vitest: "Finicity webhook outcomes > rejects an invalid overwritten provider account without consuming the event"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member who has a pending Finicity connect session and one connected account from an earlier `added` event. Finicity now lists accounts where an overwritten duplicate has a 257-character name.
- When: Finicity posts a new signed `added` event to `POST /api/webhooks/finicity`; Finicity then lists only "Latest checking" and the same event is posted again. The member reads `GET /api/banking/access-requests/current` after each.
- Then: The first delivery returns HTTP 500 and the status body is unchanged. The retry returns HTTP 200 and the connection has exactly one account with the original ID, name "Latest checking" and no repair needed.

## banking-webhook-012

- Vitest: "Finicity webhook outcomes > keeps a grant revoked when an already captured account refresh finishes"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member who has a pending Finicity connect session, one connected account from an earlier signed `added` event, and an active 7-day grant for it. A later account refresh from Finicity is held until released.
- When: Finicity posts another `added` event to `POST /api/webhooks/finicity`; while its account read is held the member revokes the grant via `POST /api/banking/workspace/grant/revoke`; Finicity then returns the account renamed "Refreshed checking", and the member reads `GET /api/banking/access-requests/current`.
- Then: The revocation returns HTTP 200 with grant status `revoked`. The webhook returns HTTP 200. The status shows the same revoked grant, and the connection's single account keeps its ID with name "Refreshed checking".

## banking-webhook-013

- Vitest: "Finicity webhook outcomes > cancels connect when added and done return only unhealthy accounts"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member who has a pending Finicity connect session, and Finicity lists only a repair-needed account.
- When: Finicity posts signed `added` and then `done` events to `POST /api/webhooks/finicity`, and the member reads `GET /api/banking/access-requests/current`.
- Then: Both webhooks return HTTP 200. The session is `cancelled` and the connection lists one account with `repairRequired` true. The `done` event publishes exactly one `bankingAccessChanged` notification on the owner's `user:<id>` channel.

## banking-webhook-014

- Vitest: "Finicity webhook outcomes > allows retry after provider failure without consuming the event"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member who has a pending Finicity connect session, and Finicity's account listing responds with HTTP 503.
- When: Finicity posts a signed `added` event to `POST /api/webhooks/finicity`; after the account listing recovers, the same event is posted again, followed by `done`.
- Then: The first delivery returns HTTP 500, the session stays `pending` with no accounts, and no notification is published. The retry and `done` return HTTP 200 and the session becomes `completed`.

## banking-webhook-015

- Vitest: "Finicity webhook outcomes > completes a done request captured before added when its provider response arrives later"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member who has a pending Finicity connect session, and Finicity's first account listing response is held until released.
- When: Finicity posts a signed `done` event to `POST /api/webhooks/finicity` whose account read is held; meanwhile an `added` event is posted; the held response is then released.
- Then: The `added` webhook returns HTTP 200 and the session is still `pending`. The `done` webhook then returns HTTP 200 and the session is `completed`.

## banking-webhook-016

- Vitest: "Finicity webhook outcomes > does not revive a session when a captured added request arrives after done-only cancellation"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member who has a pending Finicity connect session, and Finicity's first account listing response is held until released.
- When: Finicity posts a signed `added` event to `POST /api/webhooks/finicity` whose account read is held; meanwhile a `done` event is posted; the held response is then released and the same `added` event is posted again.
- Then: The `done` webhook returns HTTP 200 and the session becomes `cancelled`. The held `added` and its replay both return HTTP 200, and the session remains `cancelled`.

## banking-webhook-017

- Vitest: "Finicity webhook outcomes > keeps concurrent duplicate added callbacks pending until done"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member who has a pending Finicity connect session, and Finicity lists one healthy account.
- When: Finicity posts the same signed `added` event twice concurrently to `POST /api/webhooks/finicity`, then posts `done`.
- Then: Both `added` deliveries return HTTP 200 and the session is `pending` with one account. After `done` (HTTP 200) the session is `completed`.

## banking-webhook-018

- Vitest: "Finicity webhook outcomes > completes fix only for a healthy account at its requested institution without requiring added"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member who has a pending Finicity connect session. Finicity lists a repair-needed account at institution "bank" and a healthy one at "other", and signed `added` and `done` events have completed the connect, leaving "bank" listed as a repair institution.
- When: The member starts a fix session for `bank` via `POST /api/banking/workspace/connect-sessions` and Finicity posts `done` while "bank" is still unhealthy; the member starts another fix session, Finicity reports both accounts healthy, and posts `done` for it without an `added` event.
- Then: The repair institutions are exactly `bank`. The first fix session ends `cancelled` in mode `fix`. The second fix session is `completed` in mode `fix` with no repair institutions, and exactly one `bankingAccessChanged` notification is published on the owner's `user:<id>` channel.

## banking-webhook-019

- Vitest: "Finicity webhook outcomes > rejects malformed signed events and ignores wrong customer correlation"
- Mode: run
- Given: Banking is enabled for a signed-in workspace member who has a pending Finicity connect session, and Finicity lists one healthy account.
- When: Finicity posts a signed `added` event to `POST /api/webhooks/finicity` whose customer ID differs from the session's customer.
- Then: The webhook returns HTTP 200, and the session stays `pending` with no accounts.
