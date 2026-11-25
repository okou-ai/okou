# connectors-external-code.bdd

## connectors-external-code.bdd-001

- Vitest: "CONN-02: external-code session lifecycle > starts, completes, replays, and protects an AWS external-code session through public APIs"
- Mode: run
- Given: A signed-in workspace member connects the builtin `aws` connector with its `cli` method. AWS sign-in accepts the verification code `AWS-CODE` and returns credentials for account `123456789012`. A second member of another identity also exists.
- When: The member starts `POST /api/connectors/aws/external-code/sessions` with intent `add`; completion is then tried via `POST /api/connectors/aws/external-code/sessions/:sessionId/complete` with a wrong session token, by the other user, by the owner with the code padded by whitespace, and replayed; finally the member starts a reconnect session, deletes the account, and completes the reconnect.
- Then: The session is `pending` with `expiresIn` 600 and an authorization URL at `https://us-east-1.signin.aws.amazon.com/v1/authorize` with the AWS cross-device client ID, scope `openid` and the AWS confirmation redirect URI. The wrong token returns HTTP 404 `External-code authorization session not found` and the other user gets HTTP 404 `NOT_FOUND`, both without a token request. The owner's completion makes one `authorization_code` token request for `AWS-CODE` and creates a `cli` account with external ID `123456789012`, the IAM user ARN as username, scopes `[openid]`, a token expiry about 15 minutes ahead and no secret key, refresh token or session token in the response; it is the default account and appears in `GET /api/connectors`. The replay returns the same connection without a new token request. Completing the reconnect after deletion returns HTTP 409 `Connector account not found` and the connector has no default account.

## connectors-external-code.bdd-002

- Vitest: "CONN-02: external-code session lifecycle > replays the exact non-default account added by an external-code session"
- Mode: run
- Given: A signed-in member has a default `aws` account from one external-code session and then adds a second, non-default `aws` account (AWS account `222222222222`) through another session, and renames that sibling to `Renamed AWS sibling` via `PATCH /api/connector-accounts/:connectionId`.
- When: The member replays `POST /api/connectors/aws/external-code/sessions/:sessionId/complete` for the sibling session.
- Then: The sibling has a different connection ID, and the account list shows the first account as default and the sibling as non-default. The replay returns exactly the sibling account with the renamed display name and new `updatedAt`, and the provider has received only two token requests in total.

## connectors-external-code.bdd-003

- Vitest: "CONN-02: external-code session lifecycle > supersedes pending sessions and restores provider-rejected sessions to pending"
- Mode: run
- Given: A signed-in member starts two `aws` `cli` external-code sessions in a row. AWS sign-in rejects the code `AWS-BAD` and accepts the normal code.
- When: The member completes the first session, then completes the second session with `AWS-BAD`, then retries the second session with the valid code.
- Then: The first session returns HTTP 400 `External-code authorization session was superseded` without a token request. The bad code returns HTTP 400 `External-code authorization code was rejected. Check it and try again.` The retry succeeds with an `aws` `cli` account for external ID `123456789012`, the provider has received two token requests, and the new account is the default.

## connectors-external-code.bdd-004

- Vitest: "CONN-02: external-code session lifecycle > returns generic external-code copy when the PlayStation NPSSO token is rejected"
- Mode: run
- Given: A signed-in member uses the builtin `playstation` connector with its `api` method, and the PlayStation authorize endpoint rejects the NPSSO cookie `bad-npsso` with HTTP 401.
- When: The member starts `POST /api/connectors/playstation/external-code/sessions` and completes it with code `bad-npsso` (surrounding spaces).
- Then: The session authorization URL is `https://ca.account.sony.com/api/v1/ssocookie`. Completion returns HTTP 400 `External-code authorization code was rejected. Check it and try again.`, and the authorize endpoint was called once with cookie `npsso=bad-npsso`.

## connectors-external-code.bdd-005

- Vitest: "CONN-02: external-code session lifecycle > starts and completes a Nintendo Store external-code session through public APIs"
- Mode: run
- Given: A signed-in member uses the builtin `nintendo-store` connector with its `api` method. The Nintendo account service exchanges session token codes and access tokens for the player `bdd-nintendo-player`.
- When: The member starts `POST /api/connectors/nintendo-store/external-code/sessions` and completes it with the pasted redirect `npf5c38e31cd085304b://auth#session_token_code=bdd-nintendo-session-token-code&state=<state>`.
- Then: The session is `pending` with `expiresIn` 600 and an authorization URL at the Nintendo authorize endpoint with client ID `5c38e31cd085304b`, the `npf5c38e31cd085304b://auth` redirect, `response_type=session_token_code`, scope `openid user user.mii user.email user.links[].id` and a state. Nintendo receives one session-token request with that client ID, the code and a code verifier, and one JWT-bearer session-token exchange. The account is an `api` account with external ID `bdd-nintendo-account-id`, username `bdd-nintendo-player`, the five scopes and a token expiry; neither the session token nor the access token appears in the response.

## connectors-external-code.bdd-006

- Vitest: "CONN-02: external-code session lifecycle > replaces the remote Nintendo registration and keeps local deletion resilient"
- Mode: run
- Given: A signed-in member uses the builtin `nintendo-switch-parental-controls` connector with its `api` method. Nintendo exchanges two different session token codes for an initial and a replacement parent account, and smart-device federation returns owned devices with a serial number and unlock code.
- When: The member completes one external-code session, completes a second session for the replacement account, deletes the first account via `DELETE /api/connector-accounts/:connectionId`, then makes the Nintendo logout endpoint fail with HTTP 503 and deletes the replacement account.
- Then: The first session is `pending` with `expiresIn` 600 and an authorization URL using client ID `54789befb391a838`, the `npf54789befb391a838://auth` redirect and the 13 parental-controls scopes. Completion sends one session-token request and one session-token exchange, federates one smart device with bundle `com.nintendo.znma`, and creates an account with external ID `bdd-switch-parental-controls-account-id` and username `bdd-nintendo-parent`; no token, serial number or unlock code is exposed. The replacement federates a different smart device, creates a different connection and logs nothing out. Each deletion re-exchanges that account's session token and logs out its own smart device with its own ID token, and the second deletion still succeeds despite the logout failure, leaving no default account.

## connectors-external-code.bdd-007

- Vitest: "CONN-02: external-code session lifecycle > keeps an in-flight completion exclusive without superseding it"
- Mode: run
- Given: A signed-in member has an `aws` `cli` external-code session whose completion is in progress because the AWS token exchange has not answered yet.
- When: The member completes the same session again, starts a second session, then the AWS token response is released, and the member completes the second session.
- Then: The duplicate completion returns HTTP 400 `External-code authorization session is already completing`. The second session starts as `pending`. The held completion then succeeds with an `aws` `cli` account for external ID `123456789012` after one token request, and the second session also completes for `aws`, for two token requests in total.

## connectors-external-code.bdd-008

- Vitest: "CONN-02: external-code session lifecycle > expires external-code sessions past their deadline, including stale completing claims"
- Mode: run
- Given: A signed-in member starts an `aws` `cli` external-code session and the clock advances 601 seconds. Later the member starts another session whose completion holds while AWS has not answered the token request, and the clock then advances 31 minutes.
- When: The member completes the first session twice after the deadline, then completes the stale completing session again, after which the held AWS token response is released.
- Then: Both completions of the first session return HTTP 400 `External-code authorization session expired` without any token request. The stale completing session also returns HTTP 400 `External-code authorization session expired`. The held completion ends with HTTP 500 `{ error: Internal server error }`, and only one token request was made for it.

## connectors-external-code.bdd-009

- Vitest: "CONN-02: external-code session lifecycle > marks a session failed when the provider identity lookup fails after token exchange"
- Mode: run
- Given: A signed-in member starts an `aws` `cli` external-code session. AWS sign-in exchanges the code, but the AWS STS identity lookup fails.
- When: The member completes the session via `POST /api/connectors/aws/external-code/sessions/:sessionId/complete` and then completes it again.
- Then: The first completion returns HTTP 500 `{ error: Internal server error }` after one token request. The second returns HTTP 400 with an error message that mentions `STS`, without another token request, and the connector has no default account.
