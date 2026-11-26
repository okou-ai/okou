# antigravity-device-auth

## antigravity-device-auth-001

- Vitest: "Antigravity Google sign-in > is limited to staff members who opted in and needs client config"
- Mode: run
- Given: A signed-in member of a staff organization has not opted into the Gemini Antigravity feature switch; the Antigravity OAuth client is configured.
- When: The member calls `POST /api/model-providers/antigravity/device-auth/sessions`; then, after opting in with the client secret removed, calls it again; then a member of a non-staff organization calls it with the client configured.
- Then: The first request returns HTTP 404. The opted-in request without client secret returns HTTP 503 with error code `ANTIGRAVITY_DEVICE_AUTH_UNAVAILABLE`. The non-staff member's request returns HTTP 404.

## antigravity-device-auth-002

- Vitest: "Antigravity Google sign-in > connects the account from the pasted redirect address"
- Mode: run
- Given: An opted-in staff member, the Antigravity OAuth client is configured, and Google's token endpoint returns access and refresh tokens and user info for "Member@Gmail.com".
- When: The member starts a sign-in through `POST /api/model-providers/antigravity/device-auth/sessions`, pastes the redirect address (with surrounding whitespace) to `POST /api/model-providers/antigravity/device-auth/sessions/complete`, lists `GET /api/me/model-providers`, and pastes the same address again.
- Then: The browser URL is Google's OAuth endpoint with the client ID, localhost redirect URI, `response_type=code`, `access_type=offline`, `prompt=consent`, S256 PKCE, the cloud-platform scope and a state. Completion returns HTTP 200 with `status: complete`, `created: true` and an active `antigravity` provider for "member@gmail.com". Google receives one authorization-code exchange with the code, redirect URI, client credentials and a verifier matching the challenge, then one user-info lookup with the access token. The provider list contains that provider without the refresh token. The replay returns HTTP 400 "Sign-in is not pending" with no further exchange.

## antigravity-device-auth-003

- Vitest: "Antigravity Google sign-in > keeps the sign-in pending when an address from another sign-in is pasted"
- Mode: run
- Given: An opted-in staff member with the OAuth client configured has started an Antigravity sign-in.
- When: The member completes it through `POST /api/model-providers/antigravity/device-auth/sessions/complete` with a redirect address from another state, one without state, and one with `error=access_denied`, then with the correct redirect address.
- Then: The foreign and missing-state addresses each return HTTP 400 "The pasted address belongs to another sign-in", and the denied address returns HTTP 400 "Google sign-in was not approved: access_denied", with no Google token exchange. The correct address then returns HTTP 200 after exactly one exchange.

## antigravity-device-auth-004

- Vitest: "Antigravity Google sign-in > reports a rejected code exchange and ends that sign-in"
- Mode: run
- Given: An opted-in staff member with the OAuth client configured has started an Antigravity sign-in, and Google's token endpoint rejects the code with HTTP 400 `invalid_grant`.
- When: The member completes the sign-in with the correct redirect address, retries it, and lists `GET /api/me/model-providers`.
- Then: The first completion returns HTTP 503 with a message containing "Google token exchange failed with status 400" and no user-info lookup is made. The retry returns HTTP 400, and the provider list is empty.

## antigravity-device-auth-005

- Vitest: "Antigravity Google sign-in > requires offline access"
- Mode: run
- Given: An opted-in staff member with the OAuth client configured has started an Antigravity sign-in, and Google's token response contains an access token but no refresh token.
- When: The member completes the sign-in with the correct redirect address.
- Then: The request returns HTTP 503 with the message "Google did not grant offline access. Sign in again."

## antigravity-device-auth-006

- Vitest: "Antigravity Google sign-in > cancels the pending sign-in and supersedes an earlier one"
- Mode: run
- Given: An opted-in staff member with the OAuth client configured starts two Antigravity sign-ins in a row.
- When: The member completes the first sign-in, cancels the second through `POST /api/model-providers/antigravity/device-auth/sessions/cancel`, completes the cancelled second sign-in, and cancels an unknown session token.
- Then: Completing the superseded first sign-in returns HTTP 400, cancelling the second returns HTTP 200, completing it afterwards returns HTTP 400, and cancelling "not-a-session" returns HTTP 400. Google receives no token exchange.
