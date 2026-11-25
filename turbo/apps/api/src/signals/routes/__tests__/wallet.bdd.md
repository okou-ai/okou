# wallet

## wallet-001

- Vitest: "provides wallet access and purchase approval guidance to run tokens"
- Mode: run
- Given: A Pro workspace member has an interactive chat Run dispatched to a Runner, with Link OAuth configured on the server and no wallet connected.
- When: The Run's agent reads its system prompt and environment, then calls `GET /api/wallet/status` with the Run token.
- Then: The system prompt mentions `okou wallet guide` and states "Account consent is not purchase approval; approved is not paid". No `LINK_` environment variables reach the Run. The status reports the wallet as not connected.

## wallet-002

- Vitest: "accepts hosted PKCE consent after 20 minutes, binds the callback to the session owner, and consumes state once"
- Mode: run
- Given: A Pro workspace member has an interactive chat Run and Link OAuth configured. Link's token endpoint accepts the PKCE code exchange. A second user from another organization exists.
- When: The Run starts `POST /api/wallet/connect`; the member and the Run token read `POST /api/wallet/connect/status`; the peer reads status and calls `GET /api/connectors/link/callback`; after 20 minutes the member completes the callback, reads status twice and replays the callback; the Run reads `GET /api/wallet/status`.
- Then: The consent URL is on `https://login.link.com` with an S256 code challenge, a `/connectors/link/callback` redirect, the scope `payment_methods.agentic userinfo:read`, and no client secret. The member sees `pending`, the Run token gets HTTP 403, and the peer sees `unavailable` and its callback gets HTTP 400 with no `wallet:changed` publication. The member's late callback returns `{ status: "success", username: null }`, the code verifier matches the challenge, and `wallet:changed` is published once to the member's user channel with the organization ID. Status then is `authorized` with an authorization ID on repeated reads, the replayed callback returns HTTP 400, and the wallet reports connected with next action `create_spend` and checkout unavailable.

## wallet-003

- Vitest: "denies declined and expired OAuth requests and unrecognized scopes"
- Mode: run
- Given: A Pro workspace member has an interactive chat Run with Link OAuth configured. Link's token endpoint grants only the unrecognized scope `unrecognized:read`.
- When: The Run starts three consent flows through `POST /api/wallet/connect`: the first callback returns a code, the second callback returns `error=access_denied`, and the third is checked through `POST /api/wallet/connect/status` and called back after its expiry time.
- Then: The unrecognized-scope callback returns HTTP 403 and its status is `failed`. The declined callback returns HTTP 200 with status `error` and its status is `failed`. Each failure publishes `wallet:changed` to the member's user channel. The expired flow reports `expired` and its callback returns HTTP 400.

## wallet-004

- Vitest: "tracks the exact wallet consent instead of an older grant, including replacement and revocation"
- Mode: run
- Given: A Pro workspace member has an interactive chat Run and a connected Link wallet. Link's token and revoke endpoints succeed.
- When: The Run starts a second consent through `POST /api/wallet/connect`, the member completes it via `GET /api/connectors/link/callback`, and the Run then calls `POST /api/wallet/disconnect`, with the member checking `POST /api/wallet/connect/status` for each state.
- Then: The first state is `authorized` and the new state is `pending`. After the replacement callback the first state is `unavailable` and the new state is `authorized` with an authorization ID. After disconnect the new state is `unavailable`. `wallet:changed` is published four times to the member's user channel.

## wallet-005

- Vitest: "deduplicates immutable intent details, returns the exact approval URL, and never exposes credentials"
- Mode: run
- Given: A Pro workspace member has an interactive chat Run and a connected Link wallet. Link creates a $35.00 test spend request pending approval, and its response also contains card numbers, CVC, access token and shared payment token fields.
- When: The Run sends `POST /api/wallet/spend` with the purchase intent twice, then with a changed amount and with a changed merchant URL; Link then approves and the Run reads `GET /api/wallet/spend/:id`, tries `?include=card`, and reads again after Link changes the amount.
- Then: The first request returns `pending_approval` with an `https://app.link.com/activity/approve/` URL and the repeat returns the same spend ID. Both changed intents return HTTP 409. No response contains card, token or access-token values. After approval the spend shows next action `retrieve_credentials` and a null approval URL, the `include=card` query returns HTTP 400, and the read after Link changes the amount returns HTTP 409.

## wallet-006

- Vitest: "keeps purchase ownership scoped to the user, organization and agent"
- Mode: run
- Given: A Pro workspace member has a connected wallet and a pending spend request created by its Run. Another member in a different organization has their own Run.
- When: The peer Run calls `GET /api/wallet/spend/:id`, `POST /api/wallet/spend/:id/cancel`, `POST /api/wallet/spend/:id/credentials` for that spend, and `GET /api/wallet/status`.
- Then: All three spend requests return HTTP 404 and the peer's wallet status reports not connected.

## wallet-007

- Vitest: "reports denied without treating it as approval or retrying a payment"
- Mode: run
- Given: A Pro workspace member has a connected wallet and a pending $35.00 spend request created by its Run, and Link then reports the request as `denied`.
- When: The Run reads `GET /api/wallet/spend/:id`, then calls `POST /api/wallet/spend/:id/credentials` and `POST /api/wallet/spend/:id/cancel`.
- Then: The read returns HTTP 200 with next action `stop`. The credentials request returns HTTP 409 with `WALLET_SPEND_NOT_APPROVED` and the cancel returns HTTP 409.

## wallet-008

- Vitest: "reports expired without treating it as approval or retrying a payment"
- Mode: run
- Given: A Pro workspace member has a connected wallet and a pending $35.00 spend request created by its Run, and Link then reports the request as `expired`.
- When: The Run reads `GET /api/wallet/spend/:id`, then calls `POST /api/wallet/spend/:id/credentials` and `POST /api/wallet/spend/:id/cancel`.
- Then: The read returns HTTP 200 with next action `stop`. The credentials request returns HTTP 409 with `WALLET_SPEND_NOT_APPROVED` and the cancel returns HTTP 409.

## wallet-009

- Vitest: "reports submitted without treating it as approval or retrying a payment"
- Mode: run
- Given: A Pro workspace member has a connected wallet and a pending $35.00 spend request created by its Run, and Link then reports the request as `submitted`.
- When: The Run reads `GET /api/wallet/spend/:id`, then calls `POST /api/wallet/spend/:id/credentials` and `POST /api/wallet/spend/:id/cancel`.
- Then: The read returns HTTP 200 with next action `payment_pending`. The credentials request returns HTTP 409 with `WALLET_SPEND_NOT_APPROVED` and the cancel returns HTTP 409.

## wallet-010

- Vitest: "reports succeeded without treating it as approval or retrying a payment"
- Mode: run
- Given: A Pro workspace member has a connected wallet and a pending $35.00 spend request created by its Run, and Link then reports the request as `succeeded`.
- When: The Run reads `GET /api/wallet/spend/:id`, then calls `POST /api/wallet/spend/:id/credentials` and `POST /api/wallet/spend/:id/cancel`.
- Then: The read returns HTTP 200 with next action `verify_order`. The credentials request returns HTTP 409 with `WALLET_SPEND_NOT_APPROVED` and the cancel returns HTTP 409.

## wallet-011

- Vitest: "cancels unused requests and disables locally before a failed revocation, allowing explicit revocation retry"
- Mode: run
- Given: A Pro workspace member has a connected wallet and a pending spend request created by its Run. Link's revoke endpoint first fails with HTTP 503 and later succeeds.
- When: The Run cancels the spend with `POST /api/wallet/spend/:id/cancel`; the member calls `POST /api/wallet/connection/disconnect`, the Run checks status and tries a new `POST /api/wallet/spend`, and the member retries the disconnect.
- Then: The cancel returns status `canceled`. The first disconnect returns HTTP 502, yet the Run sees the wallet as not connected, settings at `GET /api/wallet/connection` show `connected: false` and `revocationPending: true`, and the new spend returns HTTP 409. The retried disconnect returns HTTP 200 and settings then show `revocationPending: false`.

## wallet-012

- Vitest: "refreshes rotating credentials only on the backend and isolates requests from a replaced authorization"
- Mode: run
- Given: A Pro workspace member connected a wallet with a 30-second access token. Link's refresh grant returns only the `payment_methods.agentic` scope. The Run created a spend request.
- When: The member reads `GET /api/wallet/connection`; the wallet is then re-authorized through a new consent; the Run reads `GET /api/wallet/spend/:id` and calls `POST /api/wallet/spend/:id/credentials` for the earlier spend.
- Then: Settings report connected, status `connected` and no scope change despite the narrower refreshed scopes. After re-authorization both the read and the credentials request return HTTP 409 with `WALLET_AUTHORIZATION_CHANGED`.

## wallet-013

- Vitest: "refreshes wallet settings before loading cards and transactions in parallel"
- Mode: run
- Given: A Pro workspace member connected a wallet with a 30-second access token. Link's refresh grant is slow to answer, then issues a new access token; Link's payment-details and transactions endpoints expect the new token and return empty lists.
- When: The member reads `GET /api/wallet/connection`, then loads `GET /api/wallet/connection/payment-methods` and `GET /api/wallet/connection/transactions` in parallel.
- Then: The settings read waits for the refresh to start before completing. It returns HTTP 200 with `Cache-Control: no-store`, connected status, and payment-methods and transactions capabilities. Both lists are empty, the provider calls use the new access token, and the refresh grant is called exactly once.

## wallet-014

- Vitest: "wallet settings report the permissions returned by a credential refresh"
- Mode: run
- Given: A Pro workspace member connected a wallet with a 30-second access token, and Link's refresh grant returns only `userinfo:read` with no source actions.
- When: The member reads `GET /api/wallet/connection` and then `GET /api/wallet/connection/transactions`.
- Then: Settings report connected with payments, payment-methods and transactions capabilities all false and an empty source-action list. The transactions read returns HTTP 403.

## wallet-015

- Vitest: "keeps the existing wallet usable when a reconnect is started and declined"
- Mode: run
- Given: A Pro workspace member has a connected wallet.
- When: The member starts `POST /api/wallet/connection/connect`, reads `GET /api/wallet/connection`, declines through `GET /api/connectors/link/callback` with `error=access_denied`, reads settings again, and the Run then sends `POST /api/wallet/spend`.
- Then: Settings show connected, status `connected` and no scope change both before and after the decline. The callback returns status `error`. The spend request returns HTTP 200.

## wallet-016

- Vitest: "prevents an in-flight OAuth callback from resurrecting a disconnected grant"
- Mode: run
- Given: A Pro workspace member's Run has started a wallet consent. Link's token exchange is slow and Link's revoke endpoint succeeds.
- When: The member's callback to `GET /api/connectors/link/callback` is still waiting for Link when the Run calls `POST /api/wallet/disconnect`, and the token exchange then completes.
- Then: The disconnect returns HTTP 200, the callback returns HTTP 409, and the Run's wallet status reports not connected.

## wallet-017

- Vitest: "shares purchase history and approved spends across runs of the same workspace member"
- Mode: run
- Given: A Pro workspace member has a connected wallet and an approved live spend whose virtual card Link can release. The same member starts a second chat Run. Link's revoke endpoint succeeds.
- When: The second Run reads status, the spend and its credentials, and creates another live purchase; the first Run creates a test purchase. The member pages `GET /api/wallet/purchases` (with the test request as cursor, with `limit=1`, after a newer purchase, with an unknown cursor), peers read it, the Run token reads it, and the member disconnects via `POST /api/wallet/connection/disconnect`.
- Then: The second Run sees the wallet connected and gets HTTP 200 for the spend and credentials. Test requests are hidden from history. The first page is `no-store` with only the second live purchase as `pending_approval` and a cursor; the next page holds only the approved first purchase with no further cursor despite the newer purchase. A same-organization peer and the same user in another organization see empty history, the Run token gets HTTP 403, and an unknown cursor returns an empty page. After disconnect history still lists 3 purchases, while both Runs see the wallet disconnected and new spends return HTTP 409.

## wallet-018

- Vitest: "denies unattended automation runs"
- Mode: run
- Given: A Team workspace member's event-triggered automation Run is executing without an interactive chat.
- When: The Run calls `GET /api/wallet/status`, `POST /api/wallet/connect`, `POST /api/wallet/spend/:id/credentials` and `POST /api/wallet/spend`.
- Then: All four requests return HTTP 403, and the status error code is `WALLET_INTERACTIVE_RUN_REQUIRED`.

## wallet-019

- Vitest: "releases only the approved purchase's card through the explicit uncached credentials endpoint"
- Mode: run
- Given: A Pro workspace member has a connected wallet and a pending spend request created by its Run. Link later approves it and can release a virtual card with billing address, along with OAuth and shared-payment tokens.
- When: The Run calls `POST /api/wallet/spend/:id/credentials` before approval, after approval, reads `GET /api/wallet/spend/:id`, calls credentials again when Link returns a card without CVC or address, cancels the spend, and calls credentials once more.
- Then: Before approval the request returns HTTP 409 with `WALLET_SPEND_NOT_APPROVED`. After approval it returns HTTP 200 as a `no-store`, `nosniff` `application/octet-stream` attachment containing exactly the approved spend (next action `retrieve_credentials`, null approval URL) and the card's brand, number, CVC, expiry, billing address and validity, without the OAuth or payment tokens. The ordinary spend read contains no card. The minimal card returns only brand, number and expiry. After cancellation the credentials request returns HTTP 409 with `WALLET_SPEND_NOT_APPROVED`.

## wallet-020

- Vitest: "withholds credentials for changed status in the expanded Link response"
- Mode: run
- Given: A Pro workspace member has a connected wallet and an approved spend, but Link's expanded card response reports the spend status as `canceled`.
- When: The Run calls `POST /api/wallet/spend/:id/credentials`.
- Then: The API responds with HTTP 409 and `WALLET_SPEND_NOT_APPROVED`, and the body contains no card number, card field or billing address.

## wallet-021

- Vitest: "withholds credentials for changed amount in the expanded Link response"
- Mode: run
- Given: A Pro workspace member has a connected wallet and an approved spend, but Link's expanded card response carries an amount one cent higher than approved.
- When: The Run calls `POST /api/wallet/spend/:id/credentials`.
- Then: The API responds with HTTP 409 and `WALLET_APPROVAL_MISMATCH`, and the body contains no card number, card field or billing address.

## wallet-022

- Vitest: "withholds credentials for changed merchant in the expanded Link response"
- Mode: run
- Given: A Pro workspace member has a connected wallet and an approved spend, but Link's expanded card response carries a different merchant URL.
- When: The Run calls `POST /api/wallet/spend/:id/credentials`.
- Then: The API responds with HTTP 409 and `WALLET_APPROVAL_MISMATCH`, and the body contains no card number, card field or billing address.

## wallet-023

- Vitest: "withholds credentials for missing card in the expanded Link response"
- Mode: run
- Given: A Pro workspace member has a connected wallet and an approved spend, but Link's expanded response contains no card.
- When: The Run calls `POST /api/wallet/spend/:id/credentials`.
- Then: The API responds with HTTP 409 and `WALLET_CREDENTIALS_UNAVAILABLE`, and the body contains no card number, card field or billing address.

## wallet-024

- Vitest: "withholds credentials for malformed card in the expanded Link response"
- Mode: run
- Given: A Pro workspace member has a connected wallet and an approved spend, but Link's expanded card has a malformed expiry month.
- When: The Run calls `POST /api/wallet/spend/:id/credentials`.
- Then: The API responds with HTTP 502 and `WALLET_INVALID_RESPONSE`, and the body contains no card number, malformed field value or billing address.

## wallet-025

- Vitest: "withholds credentials for expired card in the expanded Link response"
- Mode: run
- Given: A Pro workspace member has a connected wallet and an approved spend, but Link's expanded card's validity ended one second ago.
- When: The Run calls `POST /api/wallet/spend/:id/credentials`.
- Then: The API responds with HTTP 409 and `WALLET_CREDENTIALS_EXPIRED`, and the body contains no card number, card field or billing address.

## wallet-026

- Vitest: "withholds retrieved credentials when the wallet is disconnected during the Link request"
- Mode: run
- Given: A Pro workspace member has a connected wallet and a spend that Link reports as approved. Link's expanded card request is slow and Link's revoke endpoint succeeds.
- When: The Run calls `POST /api/wallet/spend/:id/credentials` and, while Link is still answering, calls `POST /api/wallet/disconnect`.
- Then: The disconnect returns HTTP 200 and the credentials request returns HTTP 409 with `WALLET_AUTHORIZATION_CHANGED` and no card number.

## wallet-027

- Vitest: "recovers a lost creation response with the same provider idempotency key and the same intent"
- Mode: run
- Given: A Pro workspace member has a connected wallet. Link's spend creation fails at the network level on the first call and answers the second with a 409 duplicate carrying the already-created request.
- When: The Run sends `POST /api/wallet/spend` with the same intent twice.
- Then: The first request returns HTTP 502 and the second returns HTTP 200 with the original intent ID. Both Link calls request approval and use the same idempotency key, `okou_wallet_<spend id>`.

## wallet-028

- Vitest: "fails closed for a non-Link action URL instead of exposing a phishing link"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link returns a new spend request whose approval URL points to a non-Link domain.
- When: The Run sends `POST /api/wallet/spend`.
- Then: The API responds with HTTP 502.

## wallet-029

- Vitest: "reports SDK response validation without exposing provider values and keeps the intent recoverable"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link first returns a spend request whose `created_at` is a private object instead of a timestamp, then a valid response.
- When: The Run sends `POST /api/wallet/spend` with the same intent twice.
- Then: The first request returns HTTP 502 with `WALLET_INVALID_RESPONSE`, a message naming stage `response_schema`, the issue `created_at:invalid_type` and a UUID reference, and no private provider value. The retry returns HTTP 200 with the same intent ID and status `pending_approval`.

## wallet-030

- Vitest: "obtains a separate hosted approval link and preserves its intent across refresh (initial approval failure: null)"
- Mode: run
- Given: A Pro workspace member connected a wallet with a 120-second access token. Link creates spend requests in `created` status without an approval URL and returns an exact hosted approval link from its separate request-approval endpoint.
- When: The Run sends `POST /api/wallet/spend`, then 70 seconds later, with a refreshed token and Link showing `pending_approval`, repeats the same intent.
- Then: The first request returns HTTP 200 with the intent ID, status `pending_approval`, the exact approval link and next action `wait_for_user`. The repeat returns the same spend ID, intent and approval link.

## wallet-031

- Vitest: "obtains a separate hosted approval link and preserves its intent across refresh (initial approval failure: 503)"
- Mode: run
- Given: A Pro workspace member connected a wallet with a 120-second access token. Link creates spend requests without an approval URL; its request-approval endpoint first fails with HTTP 503 `insufficient_scope` and then returns an exact hosted approval link.
- When: The Run sends `POST /api/wallet/spend` three times with the same intent, the third 70 seconds later with a refreshed token.
- Then: The first request returns HTTP 502 with `WALLET_PROVIDER_ERROR` and a message naming operation `spend_approval` and provider `insufficient_scope`. The second returns HTTP 200 with the intent ID, `pending_approval`, the exact approval link and next action `wait_for_user`. The third returns the same spend ID, intent and approval link.

## wallet-032

- Vitest: "obtains a separate hosted approval link and preserves its intent across refresh (initial approval failure: 401)"
- Mode: run
- Given: A Pro workspace member connected a wallet with a 120-second access token. Link creates spend requests without an approval URL; its request-approval endpoint first fails with HTTP 401 `insufficient_scope` and then returns an exact hosted approval link.
- When: The Run sends `POST /api/wallet/spend` three times with the same intent, the third 70 seconds later with a refreshed token.
- Then: The first request returns HTTP 409 with `WALLET_PROVIDER_AUTH_REJECTED` and a message naming operation `spend_approval` and provider `insufficient_scope`. The second returns HTTP 200 with the intent ID, `pending_approval`, the exact approval link and next action `wait_for_user`. The third returns the same spend ID, intent and approval link.

## wallet-033

- Vitest: "reports Link action resolution auto_resume without treating it as approval"
- Mode: run
- Given: A Pro workspace member has a pending spend request. Link then reports it as `requires_action` with an authentication action of resolution `auto_resume` and a Stripe action URL, plus card and payment-token values.
- When: The Run reads `GET /api/wallet/spend/:id`.
- Then: The read returns HTTP 200 with status `requires_action`, next action `wait_for_user`, a null approval URL and the authentication action with its resolution and exact URL. The body contains no card number or payment token.

## wallet-034

- Vitest: "reports Link action resolution create_new_spend_request without treating it as approval"
- Mode: run
- Given: A Pro workspace member has a pending spend request. Link then reports it as `requires_action` with an authentication action of resolution `create_new_spend_request` and a Stripe action URL, plus card and payment-token values.
- When: The Run reads `GET /api/wallet/spend/:id`.
- Then: The read returns HTTP 200 with status `requires_action`, next action `new_approval_required`, a null approval URL and the authentication action with its resolution and exact URL. The body contains no card number or payment token.

## wallet-035

- Vitest: "reports Link action resolution create_new_spend_request_after_completion without treating it as approval"
- Mode: run
- Given: A Pro workspace member has a pending spend request. Link then reports it as `requires_action` with an authentication action of resolution `create_new_spend_request_after_completion` and a Stripe action URL, plus card and payment-token values.
- When: The Run reads `GET /api/wallet/spend/:id`.
- Then: The read returns HTTP 200 with status `requires_action`, next action `new_approval_required`, a null approval URL and the authentication action with its resolution and exact URL. The body contains no card number or payment token.

## wallet-036

- Vitest: "revokes a delayed refresh after disconnect from spend (cleanup retry: false)"
- Mode: run
- Given: A Pro workspace member connected a wallet with a 30-second access token. Link's refresh grant is slow and then rotates the refresh token, and Link's revoke endpoint succeeds.
- When: The Run sends `POST /api/wallet/spend`, which triggers a refresh; while the refresh is in flight the Run calls `POST /api/wallet/disconnect`. The member then reads `GET /api/wallet/connection`, and the Run disconnects again.
- Then: The spend request returns HTTP 409. Settings show not connected and no pending revocation. Link receives revocations for the original and the rotated refresh tokens, and the second disconnect revokes nothing more.

## wallet-037

- Vitest: "revokes a delayed refresh after disconnect from settings (cleanup retry: true)"
- Mode: run
- Given: A Pro workspace member connected a wallet with a 30-second access token. Link's refresh grant is slow and then rotates the refresh token, and Link's revoke endpoint fails with HTTP 503 for the rotated token the first time.
- When: The member reads `GET /api/wallet/connection`, which triggers a refresh; while it is in flight the Run calls `POST /api/wallet/disconnect`. The member reads settings, the Run disconnects again, and the member reads settings once more.
- Then: The in-flight settings read returns HTTP 502. Settings then show not connected with a pending revocation, after the original and rotated refresh tokens were both sent for revocation. The second disconnect revokes the rotated token again and settings then show no pending revocation.

## wallet-038

- Vitest: "cannot attest approval when Link omits the bound amount, currency or merchant"
- Mode: run
- Given: A Pro workspace member has a spend request that Link reports as approved, but Link omits in turn the amount, the currency, the merchant name and the merchant URL.
- When: The Run reads `GET /api/wallet/spend/:id` once for each omission.
- Then: Each read returns HTTP 502 with `WALLET_INVALID_RESPONSE`.

## wallet-039

- Vitest: "returns a configuration error without exposing secrets or requiring disabled environments to configure Link"
- Mode: run
- Given: A Pro workspace member has an interactive chat Run, and the server has no Link OAuth client secret configured.
- When: The Run calls `POST /api/wallet/connect`.
- Then: The API responds with HTTP 503 and `WALLET_NOT_CONFIGURED`.

## wallet-040

- Vitest: "keeps a rejected spend intent recoverable without prescribing repeated wallet consent"
- Mode: run
- Given: A Pro workspace member has a connected wallet. Link rejects the first spend creation with HTTP 401 `unauthorized_client` and a request ID, then accepts it.
- When: The Run sends `POST /api/wallet/spend`, reads `GET /api/wallet/status`, and repeats the same intent.
- Then: The first request returns HTTP 409 with `WALLET_PROVIDER_AUTH_REJECTED` and a message naming operation `spend_create`, provider `unauthorized_client` and a UUID reference. The wallet stays connected, and the retry returns HTTP 200 with the same intent ID and status `pending_approval`.

## wallet-041

- Vitest: "reports safe message diagnostics for invalid_access_token without changing consent or retrying"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link rejects spend creation with HTTP 401 whose `error.message` reports an invalid access token that embeds a private token value.
- When: The Run sends `POST /api/wallet/spend` and then reads `GET /api/wallet/status`.
- Then: The request returns HTTP 409 with `WALLET_PROVIDER_AUTH_REJECTED` and a message naming message source `error.message` and reason `invalid_access_token`, with no private token, client secret, e-mail or scope name. Link is called once and the wallet stays connected.

## wallet-042

- Vitest: "reports safe message diagnostics for access_token_expired without changing consent or retrying"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link rejects spend creation with HTTP 401 whose `error.message` is "Access token has expired.".
- When: The Run sends `POST /api/wallet/spend` and then reads `GET /api/wallet/status`.
- Then: The request returns HTTP 409 with `WALLET_PROVIDER_AUTH_REJECTED` and a message naming message source `error.message` and reason `access_token_expired`. Link is called once and the wallet stays connected.

## wallet-043

- Vitest: "reports safe message diagnostics for token_expired without changing consent or retrying"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link rejects spend creation with HTTP 401 whose `error` field is the string `expired_token`.
- When: The Run sends `POST /api/wallet/spend` and then reads `GET /api/wallet/status`.
- Then: The request returns HTTP 409 with `WALLET_PROVIDER_AUTH_REJECTED` and a message naming message source `error` and reason `token_expired`. Link is called once and the wallet stays connected.

## wallet-044

- Vitest: "reports safe message diagnostics for insufficient_scope without changing consent or retrying"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link rejects spend creation with HTTP 401 whose `error.message` says the token is missing the scope `balances:read`.
- When: The Run sends `POST /api/wallet/spend` and then reads `GET /api/wallet/status`.
- Then: The request returns HTTP 409 with `WALLET_PROVIDER_AUTH_REJECTED` and a message naming message source `error.message` and reason `insufficient_scope`, without the scope name. Link is called once and the wallet stays connected.

## wallet-045

- Vitest: "reports safe message diagnostics for missing_authorization without changing consent or retrying"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link rejects spend creation with HTTP 401 whose top-level `message` is "Missing authorization header".
- When: The Run sends `POST /api/wallet/spend` and then reads `GET /api/wallet/status`.
- Then: The request returns HTTP 409 with `WALLET_PROVIDER_AUTH_REJECTED` and a message naming message source `message` and reason `missing_authorization`. Link is called once and the wallet stays connected.

## wallet-046

- Vitest: "reports safe message diagnostics for invalid_refresh_token without changing consent or retrying"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link rejects spend creation with HTTP 401 whose `error_description` is "refresh_token is invalid".
- When: The Run sends `POST /api/wallet/spend` and then reads `GET /api/wallet/status`.
- Then: The request returns HTTP 409 with `WALLET_PROVIDER_AUTH_REJECTED` and a message naming message source `error_description` and reason `invalid_refresh_token`. Link is called once and the wallet stays connected.

## wallet-047

- Vitest: "reports safe message diagnostics for invalid_client_secret without changing consent or retrying"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link rejects spend creation with HTTP 401 whose `error.message` reports an invalid client secret that embeds a private value.
- When: The Run sends `POST /api/wallet/spend` and then reads `GET /api/wallet/status`.
- Then: The request returns HTTP 409 with `WALLET_PROVIDER_AUTH_REJECTED` and a message naming message source `error.message` and reason `invalid_client_secret`, without the private value. Link is called once and the wallet stays connected.

## wallet-048

- Vitest: "reports safe message diagnostics for unrecognized without changing consent or retrying"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link rejects spend creation with HTTP 401 whose `error.message` is an unrecognized text containing a private e-mail address.
- When: The Run sends `POST /api/wallet/spend` and then reads `GET /api/wallet/status`.
- Then: The request returns HTTP 409 with `WALLET_PROVIDER_AUTH_REJECTED` and a message naming message source `error.message` and reason `unrecognized`, without the e-mail address. Link is called once and the wallet stays connected.

## wallet-049

- Vitest: "preserves a structured token error when its optional message is malformed"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link rejects spend creation with HTTP 401 carrying error code `invalid_token` and a null message.
- When: The Run sends `POST /api/wallet/spend`.
- Then: The API responds with HTTP 409, `WALLET_RECONNECT_REQUIRED`, and a message naming provider `invalid_token`.

## wallet-050

- Vitest: "identifies OAuth client rejection separately from a wallet needing consent"
- Mode: run
- Given: A Pro workspace member's Run has started a wallet consent, and Link's token endpoint rejects the code exchange with HTTP 401 `invalid_client`.
- When: The member completes `GET /api/connectors/link/callback` with the code and JSON response mode.
- Then: The callback returns HTTP 409 with `WALLET_PROVIDER_AUTH_REJECTED` and a message naming operation `oauth_exchange` and provider `invalid_client`.

## wallet-051

- Vitest: "requires reconnecting when Link explicitly rejects a rotating refresh grant from spend"
- Mode: run
- Given: A Pro workspace member connected a wallet with a 30-second access token, and Link's refresh grant now fails with HTTP 400 `invalid_grant`.
- When: The Run sends `POST /api/wallet/spend`, then reads `GET /api/wallet/status`; the member reads `GET /api/wallet/connection`.
- Then: The spend request returns HTTP 409 with `WALLET_RECONNECT_REQUIRED` and a message naming operation `oauth_refresh` and provider `invalid_grant`. The Run sees the wallet as not connected, settings show `connected: false`, `connectionStatus: "reconnect-required"` and no scope change, and one more `wallet:changed` is published to the member's user channel.

## wallet-052

- Vitest: "requires reconnecting when Link explicitly rejects a rotating refresh grant from settings"
- Mode: run
- Given: A Pro workspace member connected a wallet with a 30-second access token, and Link's refresh grant now fails with HTTP 400 `invalid_grant`.
- When: The member reads `GET /api/wallet/connection`, the Run reads `GET /api/wallet/status`, and the member reads settings again.
- Then: The first settings read returns HTTP 409 with `WALLET_RECONNECT_REQUIRED` and a message naming operation `oauth_refresh` and provider `invalid_grant`. The Run sees the wallet as not connected, settings then show `connected: false`, `connectionStatus: "reconnect-required"` and no scope change, and one more `wallet:changed` is published to the member's user channel.

## wallet-053

- Vitest: "keeps Link credentials and provider free text out of diagnostic responses"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link rejects spend creation with HTTP 401 whose code, message, request-ID and `WWW-Authenticate` headers echo wallet tokens, secrets, an address and card values.
- When: The Run sends `POST /api/wallet/spend`.
- Then: The API responds with HTTP 409, `WALLET_PROVIDER_AUTH_REJECTED`, and a message naming provider `unrecognized`. The response contains none of the access, refresh or secret values, the address, card number or CVC.

## wallet-054

- Vitest: "preserves authentication rejection when Link returns an oversized error document"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link rejects spend creation with HTTP 401 and a 20 KiB HTML body.
- When: The Run sends `POST /api/wallet/spend`.
- Then: The API responds with HTTP 409, `WALLET_PROVIDER_AUTH_REJECTED`, and a message naming operation `spend_create` and provider `unavailable`.

## wallet-055

- Vitest: "explains an unfamiliar Link validation failure and preserves the intent for recovery"
- Mode: run
- Given: A Pro workspace member has a connected wallet. Link rejects the first spend creation with HTTP 400 `invalid_request_error` for parameter `expires_at`, then accepts it.
- When: The Run sends `POST /api/wallet/spend` twice with the same intent.
- Then: The first request returns HTTP 502 with `WALLET_PROVIDER_ERROR` and a message containing `HTTP 400`, parameter `expires_at`, the provider detail with quotes normalized, and a UUID reference. The retry returns HTTP 200 with the same intent ID.

## wallet-056

- Vitest: "preserves the explanation for Link HTTP 403 without reconnecting"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link rejects spend creation with HTTP 403 "Test mode is not enabled for this client.".
- When: The Run sends `POST /api/wallet/spend` and then reads `GET /api/wallet/status`.
- Then: The request returns HTTP 502 with a message containing `HTTP 403` and that detail. The wallet stays connected.

## wallet-057

- Vitest: "preserves the explanation for Link HTTP 429 without reconnecting"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link rejects spend creation with HTTP 429 "Too many pending spend requests. Try again later.".
- When: The Run sends `POST /api/wallet/spend` and then reads `GET /api/wallet/status`.
- Then: The request returns HTTP 502 with a message containing `HTTP 429` and that detail. The wallet stays connected.

## wallet-058

- Vitest: "preserves the explanation for Link HTTP 503 without reconnecting"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link rejects spend creation with HTTP 503 "The wallet service is temporarily unavailable.".
- When: The Run sends `POST /api/wallet/spend` and then reads `GET /api/wallet/status`.
- Then: The request returns HTTP 502 with a message containing `HTTP 503` and that detail. The wallet stays connected.

## wallet-059

- Vitest: "returns a diagnostic reference for network"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link's spend creation fails at the network level.
- When: The Run sends `POST /api/wallet/spend`.
- Then: The API responds with HTTP 502 and a message containing `stage: transport`, `transport: network` and a UUID reference.

## wallet-060

- Vitest: "returns a diagnostic reference for invalid JSON"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link answers spend creation with a JSON content type but a body that is not JSON.
- When: The Run sends `POST /api/wallet/spend`.
- Then: The API responds with HTTP 502 and a message containing `stage: response_body`, `body: invalid_json` and a UUID reference.

## wallet-061

- Vitest: "returns a diagnostic reference for oversized JSON"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link answers spend creation with a 130 KiB body.
- When: The Run sends `POST /api/wallet/spend`.
- Then: The API responds with HTTP 502 and a message containing `stage: response_body`, `body: too_large` and a UUID reference.

## wallet-062

- Vitest: "redacts provider echoes in returned diagnostics"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link rejects spend creation with HTTP 400 whose code, parameter and message echo the access token in plain, URL-encoded and base64 forms, the purchase context, merchant, an e-mail, an address, card number and CVC, a person's name and a private approval-link query.
- When: The Run sends `POST /api/wallet/spend`.
- Then: The API responds with HTTP 502. The message still starts with "Request rejected for" but contains none of the echoed private values, card fields or parameter value.

## wallet-063

- Vitest: "keeps independent diagnostics when one optional provider field is malformed"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link rejects spend creation with HTTP 400 carrying code `invalid_request_error`, parameter `totals[0].amount`, a null message and a top-level `detail`.
- When: The Run sends `POST /api/wallet/spend`.
- Then: The API responds with HTTP 502 and a message containing provider `invalid_request_error`, parameter `totals.[].amount`, message source `detail` and the detail text.

## wallet-064

- Vitest: "retains a bounded plain-text provider rejection without exposing its identifiers"
- Mode: run
- Given: A Pro workspace member has a connected wallet, and Link rejects spend creation with HTTP 400 and the plain text "Account verification is required for customer@example.test.".
- When: The Run sends `POST /api/wallet/spend`.
- Then: The API responds with HTTP 502 and a message containing message source `response.text` and "Account verification is required", without the e-mail address.

## wallet-065

- Vitest: "manages a personal workspace wallet from a member session without an agent or run"
- Mode: run
- Given: A signed-in workspace member (role `org:member`) has no wallet and no agent Run. Link's token and revoke endpoints succeed. A same-organization peer and the same user in another organization also exist.
- When: The member reads `GET /api/wallet/connection`, starts `POST /api/wallet/connection/connect`, completes `GET /api/connectors/link/callback`, checks `POST /api/wallet/connect/status`, and tries `POST /api/wallet/spend` with the session. Each peer reads settings and the connect status and calls `POST /api/wallet/connection/disconnect`; the member then reads settings, disconnects and reads again.
- Then: The wallet starts disconnected, the consent becomes `authorized` and settings report connected. The session spend request returns HTTP 403. Each peer sees not connected and status `unavailable`, and their disconnects return HTTP 200 without affecting the member, whose wallet stays connected until the member's own disconnect, after which it reports not connected.

## wallet-066

- Vitest: "rejects run tokens on settings endpoints"
- Mode: run
- Given: A Pro workspace member has an interactive chat Run.
- When: The Run token calls the settings endpoints `GET /api/wallet/connection`, `POST /api/wallet/connection/connect`, `POST /api/wallet/connection/disconnect`, `GET /api/wallet/purchases` and `GET /api/wallet/connection/payment-methods`.
- Then: Every request returns HTTP 403.

## wallet-067

- Vitest: "reads Link transactions with explicit financial consent and keeps a grant without payment access unable to spend"
- Mode: run
- Given: A Pro workspace member connected a wallet whose granted scope is `userinfo:read financial_insights.transactions.read` with the `read_link_transactions` source action. Link returns one posted transaction with private card and token fields and more pages, and later returns a bare empty array. A same-organization peer exists.
- When: The Run reads `GET /api/wallet/status`, sends `POST /api/wallet/spend`, lists payment methods with the Run and session, reads `GET /api/wallet/transactions` with dates, limit, cursor and category, the member reads `GET /api/wallet/connection/transactions` with the same query, the Run token and peer read session activity, and the Run reads transactions again and with invalid query parameters.
- Then: The consent requested `payment_methods.agentic userinfo:read` with `read_link_transactions` details and settings show no scope change. Status shows connected, next action `connect`, checkout unavailable, and capabilities for user info and transactions only. The spend returns HTTP 403 `WALLET_SCOPE_REQUIRED` and both payment-method lists return HTTP 403. Link receives the mapped `origin=link` query, and the Run and session both get the projected transaction with `hasMore: true` and next cursor `txn_first` under `no-store`. The Run token gets HTTP 403 and the peer HTTP 409 on session activity. The empty-array response yields `{ data: [], hasMore: null, nextCursor: null }`, and an external origin, reversed dates or `include=card` return HTTP 400.

## wallet-068

- Vitest: "does not infer financial actions from a scope or from a pending consent upgrade"
- Mode: run
- Given: A Pro workspace member connected a wallet whose token lists `payment_methods.agentic userinfo:read financial_insights.transactions.read` scopes but no source actions.
- When: The Run reads `GET /api/wallet/transactions`, the member reads `GET /api/wallet/connection/transactions` and settings, the Run starts an upgrade consent with `POST /api/wallet/connect`, reads transactions and status, and the member declines the upgrade via `GET /api/connectors/link/callback`.
- Then: Both transaction reads return HTTP 403. Settings show connected with `scope-mismatch` and an added `read_link_transactions` scope. The upgrade consent URL includes `payment_methods.agentic`, transactions still return HTTP 403 while it is pending, and the payments capability stays true both before and after the declined callback (status `error`).

## wallet-069

- Vitest: "projects saved-card summaries and user limits without exposing credential or address fields"
- Mode: run
- Given: A Pro workspace member connected a wallet with payment and profile scopes. Link returns one eligible default Visa card with private number, CVC, address and token fields, returns 404 for an unknown card, and returns user info with spend limits, a private address and an identity-verification step-up URL. A same-organization peer and an outsider exist.
- When: The Run lists `GET /api/wallet/payment-methods` and reads `GET /api/wallet/payment-methods/pm_fixture`; the member lists `GET /api/wallet/connection/payment-methods`; the Run token, peer and outsider list the session endpoint; the Run reads the unknown card and `GET /api/wallet/user-info`; Link then returns no cards.
- Then: The list contains exactly the retrieved card, the session list matches under `no-store`, and the card summary is `visa` ending `4242`. The Run token gets HTTP 403 and the peer and outsider HTTP 409. The unknown card returns HTTP 404. User info shows the daily limit 10,000, used 3,500, remaining 6,500 and the exact verification action URL. No response contains the private card, token or address values, and the empty Link list returns `{ data: [] }`.

## wallet-070

- Vitest: "paginates owner-isolated recorded spend history and retains it after reauthorization"
- Mode: run
- Given: A Pro workspace member has a connected wallet with an approved test spend whose Link record reports a successful $30.00 payment, a $5.00 refund and an earlier declined attempt, plus a second pending live spend.
- When: The Run reads `GET /api/wallet/spend/:id`, pages `GET /api/wallet/spend` with `limit=1`, filters with `mode=test&status=approved`, a second Run of the same member connects and lists, and the wallet is re-authorized with only `userinfo:read` before listing again.
- Then: The spend shows payment amount 3000 with outcome `success`, a 500 refund, a history decline code `insufficient_funds` and the original amount 3500. The two pages together contain exactly both spends, the first with more pages and `recorded` status source that can refresh. The filter returns only the approved test spend. The second Run lists both spends and accepts a cursor. After re-authorization the history still has 2 entries, none refreshable.

## wallet-071

- Vitest: "withholds wallet data if consent is revoked while a read is in flight"
- Mode: run
- Given: A Pro workspace member connected a wallet with the `userinfo:read` scope. Link's user-info endpoint is slow and returns a private profile, and Link's revoke endpoint succeeds.
- When: The Run reads `GET /api/wallet/user-info` and, while Link is still answering, calls `POST /api/wallet/disconnect`.
- Then: The disconnect returns HTTP 200 and the read returns HTTP 409 with `WALLET_AUTHORIZATION_CHANGED` and no private profile data.

## wallet-072

- Vitest: "refreshing a grant without payment access retains financial reads"
- Mode: run
- Given: A Pro workspace member connected a wallet with `userinfo:read` and the `read_link_transactions` action and a one-second token. The refresh grant returns `userinfo:read financial_insights.transactions.read` with the `read_link_transactions` action.
- When: The Run reads `GET /api/wallet/transactions` and then `GET /api/wallet/status`.
- Then: The transactions read returns HTTP 200 after calling Link. The status shows no payments capability and a transactions capability.

## wallet-073

- Vitest: "refreshing a grant without payment access removes ungranted financial actions"
- Mode: run
- Given: A Pro workspace member connected a wallet with `userinfo:read` and the `read_link_transactions` action and a one-second token. The refresh grant returns only `userinfo:read` with no source actions.
- When: The Run reads `GET /api/wallet/transactions` and then `GET /api/wallet/status`.
- Then: The transactions read returns HTTP 403 without calling Link. The status shows neither payments nor transactions capability.

## wallet-074

- Vitest: "reading a recorded request never sends an approval request; retrying its original purchase can recover"
- Mode: run
- Given: A Pro workspace member has a connected wallet. Link creates the spend in `created` status without an approval URL and its request-approval endpoint first fails with HTTP 503, later returning an approval link.
- When: The Run sends `POST /api/wallet/spend`, lists `GET /api/wallet/spend`, reads the recorded spend with `GET /api/wallet/spend/:id`, and retries the original purchase.
- Then: The creation returns HTTP 502 but the spend is recorded in history. The read returns status `created` with a null approval URL and sends no approval request. The retry returns HTTP 200 with the same spend ID and the approval link after exactly one approval request.

## wallet-075

- Vitest: "requests payment, profile and transaction consent from both CLI and settings"
- Mode: run
- Given: A Pro workspace member has an interactive chat Run, and Link grants payment, profile and transaction scopes with the `read_link_transactions` action.
- When: The Run starts consent with `POST /api/wallet/connect` and, separately, the member starts it with `POST /api/wallet/connection/connect`; each is completed via `GET /api/connectors/link/callback` and followed by `GET /api/wallet/connection`.
- Then: Both consent URLs request the `payment_methods.agentic` and `userinfo:read` scopes and `read_link_transactions` authorization details. After each callback, settings show status `connected`, no scope change, and payments, user-info and transactions capabilities.

## wallet-076

- Vitest: "an approval Workflow continues the original web chat once and retains interactive wallet access"
- Mode: run
- Given: A Pro workspace member's chat Run created a $35.00 spend with automatic continuation, and the Link approval Worker was started with the spend ID and its deadline.
- When: The member checks the approval card through `POST /api/wallet/spend/status` for the original thread and for an unknown thread; the Worker polls the signed `POST /api/internal/link-approval/poll` before and after Link approves; the Run completes; the Worker polls twice concurrently; the member reads the thread events; and the continuation Run reads `GET /api/wallet/spend/:id`, followed by a final poll.
- Then: The card is `pending` for the original thread and `unavailable` for another. Polls return `waiting` before and right after approval while the original Run is active, and the card shows `approved`. After the Run completes both concurrent polls return HTTP 200 `done`, the card shows `continued`, and the thread has exactly one input event for the spend with the Chinese approval message for Example Books up to 35.00 USD and no tokens or card numbers. The continuation Run can read the spend, and a later poll still returns `done`.

## wallet-077

- Vitest: "manual approved-status inspection consumes the purchase continuation before a Workflow can enqueue it"
- Mode: run
- Given: A Pro workspace member's chat Run created a tracked spend with automatic continuation, and Link approves it.
- When: The Run reads `GET /api/wallet/spend/:id`, the Run completes, the Worker polls `POST /api/internal/link-approval/poll`, and the member reads the thread events.
- Then: The poll returns `done`. The thread contains a `control.revoke` event for the spend's continuation and no approval-continuation message.

## wallet-078

- Vitest: "pending manual inspection does not stop the watch and a cancelled purchase never continues"
- Mode: run
- Given: A Pro workspace member's chat Run created a tracked spend that is still pending approval at Link.
- When: The Run reads `GET /api/wallet/spend/:id`, the Worker polls `POST /api/internal/link-approval/poll`, the Run cancels with `POST /api/wallet/spend/:id/cancel` and completes, and the Worker polls again.
- Then: The first poll returns `waiting`, the cancel returns HTTP 200, and the second poll returns `done`.

## wallet-079

- Vitest: "cancelling a watched purchase from another chat fails before contacting Link"
- Mode: run
- Given: A Pro workspace member's first chat Run created a tracked spend and completed. A second chat Run of the same member is active in another thread, and Link's cancel endpoint would fail.
- When: The second Run reads `GET /api/wallet/spend/:id` and calls `POST /api/wallet/spend/:id/cancel`, and the Worker then polls `POST /api/internal/link-approval/poll`.
- Then: The read returns HTTP 200. The cancel returns HTTP 409 with `WALLET_ORIGINAL_THREAD_REQUIRED` without contacting Link. The poll still returns `waiting`.

## wallet-080

- Vitest: "a final approval observation uses the original deadline and timeout never invents a denial"
- Mode: run
- Given: A Pro workspace member's chat Run created a tracked spend, and the clock reaches the spend's expiry while Link still reports it pending.
- When: The Worker polls `POST /api/internal/link-approval/poll`; the Run reads the spend and the member checks `POST /api/wallet/spend/status`; Link then approves, the Run completes, and the Worker polls again 120,001 ms after expiry before the member reads the thread events.
- Then: The first poll returns `done`, the spend remains `pending_approval` with automatic continuation off, and the card shows `stopped`. The late poll returns `done` and the thread contains no continuation event for the spend.

## wallet-081

- Vitest: "an approved purchase waiting for its active chat notifies the card when automatic waiting expires"
- Mode: run
- Given: A Pro workspace member's chat Run created a tracked spend that Link approves while the original Run is still active.
- When: The Worker polls `POST /api/internal/link-approval/poll` and the member checks `POST /api/wallet/spend/status`; the clock then reaches the spend's expiry and the Worker polls again before the member checks the card.
- Then: The first poll returns `waiting` and the card shows `approved`. At expiry the poll returns `waiting`, `wallet:changed` is published with the organization ID, and the card shows `stopped`.

## wallet-082

- Vitest: "approval callbacks authenticate exact bodies"
- Mode: run
- Given: A Pro workspace member's chat Run created a tracked spend with automatic continuation.
- When: The Worker calls `POST /api/internal/link-approval/poll` once with an all-zero signature and once with a timestamp 301 seconds old.
- Then: Both requests return HTTP 401.

## wallet-083

- Vitest: "cron recovers a failed approval Workflow without another purchase request and continues the original chat once"
- Mode: run
- Given: A Pro workspace member's chat Run created a tracked spend, but the initial request to start the Link approval Worker failed with HTTP 503. Any further Link spend creation would be unexpected.
- When: The cron calls `GET /api/cron/process-background-jobs` with the cron secret; the Run reads `GET /api/wallet/spend/:id`; Link approves, the Run completes, and the Worker polls `POST /api/internal/link-approval/poll` twice concurrently before the member checks the card and the thread events.
- Then: The cron returns HTTP 200 and restarts the Worker with the same spend ID and deadline. The spend keeps its ID, expiry and approval URL with automatic continuation on. Both polls return `done`, the card shows `continued`, the thread has exactly one input event for the spend, and Link receives no new spend creation.

## wallet-084

- Vitest: "approval polling distinguishes resumable Link actions from actions requiring a new approval"
- Mode: run
- Given: A Pro workspace member's chat Run created a tracked spend, and Link first reports `requires_action` with a payment-method update that resolves with `auto_resume`, later with `create_new_spend_request`.
- When: The Worker polls `POST /api/internal/link-approval/poll` and the member checks `POST /api/wallet/spend/status` after each Link state.
- Then: With `auto_resume` the poll returns `waiting` and the card shows `pending`. With `create_new_spend_request` the poll returns `done` and the card shows `stopped`.

## wallet-085

- Vitest: "a provider outage remains retryable and cannot manufacture approval or denial"
- Mode: run
- Given: A Pro workspace member's chat Run created a tracked spend, and Link's spend lookup returns HTTP 503.
- When: The Worker polls `POST /api/internal/link-approval/poll` and the member checks `POST /api/wallet/spend/status`; the clock then reaches the spend's expiry and the Worker polls again before the card is checked.
- Then: The first poll returns HTTP 500 and the card stays `pending`. At expiry the poll returns HTTP 500, `wallet:changed` is published with the organization ID, and the card shows `stopped`.

## wallet-086

- Vitest: "a disconnected grant stops the approval watch and cannot start a purchase run"
- Mode: run
- Given: A Pro workspace member's chat Run created a tracked spend, and Link's revoke endpoint succeeds.
- When: The Run calls `POST /api/wallet/disconnect`, Link approves the spend, the Run completes, the Worker polls `POST /api/internal/link-approval/poll`, and the member reads the thread events.
- Then: The poll returns `done` and the thread contains no continuation event for the spend.
