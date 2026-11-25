# billing-redeem-code

## billing-redeem-code-001

- Vitest: "POST /api/billing/redeem-code > leaves a pro plan and the redeem code unchanged"
- Mode: run
- Given: The Atom redeem service URL and the machine secret key for Clerk M2M auth are configured, and Clerk issues an M2M token. A signed-in org admin's workspace has an active `pro` subscription (paid subscription invoice delivered, period ending in 30 days). Atom would accept any redeem. Parameter row: `pro`.
- When: The admin requests `POST /api/billing/redeem-code` with `code: "PRO-CAMPAIGN"`, then reads `GET /api/billing/status`.
- Then: The API responds with HTTP 200 `{ redeemed: false }`. Atom's consume endpoint is not called and no Clerk M2M token is created. Billing status still shows tier `pro` with `hasSubscription: true`.

## billing-redeem-code-002

- Vitest: "POST /api/billing/redeem-code > leaves a team plan and the redeem code unchanged"
- Mode: run
- Given: The Atom redeem service URL and the machine secret key for Clerk M2M auth are configured, and Clerk issues an M2M token. A signed-in org admin's workspace has an active `team` subscription (paid subscription invoice delivered, period ending in 30 days). Atom would accept any redeem. Parameter row: `team`.
- When: The admin requests `POST /api/billing/redeem-code` with `code: "PRO-CAMPAIGN"`, then reads `GET /api/billing/status`.
- Then: The API responds with HTTP 200 `{ redeemed: false }`. Atom's consume endpoint is not called and no Clerk M2M token is created. Billing status still shows tier `team` with `hasSubscription: true`.

## billing-redeem-code-003

- Vitest: "POST /api/billing/redeem-code > redeems for a free workspace after onboarding is complete"
- Mode: run
- Given: The Atom redeem service URL and the machine secret key for Clerk M2M auth are configured, and Clerk issues an M2M token. A signed-in org admin's free workspace has completed onboarding, and Atom accepts the code.
- When: The admin requests `POST /api/billing/redeem-code` with `code: "PRO-CAMPAIGN"`.
- Then: The API responds with HTTP 200 `{ redeemed: true }`, and Atom's consume endpoint receives the code `PRO-CAMPAIGN` with the workspace's `org_id` and the admin's `user_id`.

## billing-redeem-code-004

- Vitest: "POST /api/billing/redeem-code > returns 401 when not authenticated"
- Mode: run
- Given: The Atom redeem service URL and the machine secret key for Clerk M2M auth are configured, and Clerk issues an M2M token. The caller sends no authorization header.
- When: The caller requests `POST /api/billing/redeem-code` with `code: "YUMA-123"`.
- Then: The API responds with HTTP 401 and the error `{ message: "Not authenticated", code: "UNAUTHORIZED" }`.

## billing-redeem-code-005

- Vitest: "POST /api/billing/redeem-code > returns 403 for a non-admin org member"
- Mode: run
- Given: The Atom redeem service URL and the machine secret key for Clerk M2M auth are configured, and Clerk issues an M2M token. A signed-in user is an `org:member` (not an admin) of an organization.
- When: The member requests `POST /api/billing/redeem-code` with `code: "YUMA-123"`.
- Then: The API responds with HTTP 403 and the error `{ message: "Only org admins can manage billing", code: "FORBIDDEN" }`. Atom is not called and no Clerk M2M token is created.

## billing-redeem-code-006

- Vitest: "POST /api/billing/redeem-code > returns 503 when ATOM_URL is not configured"
- Mode: run
- Given: The environment is production and the Atom redeem service URL is not configured. A signed-in org admin has a provisioned free workspace, and Clerk returns the admin's user with a primary email.
- When: The admin requests `POST /api/billing/redeem-code` with `code: "YUMA-123"`.
- Then: The API responds with HTTP 503 and the error `{ message: "Redeem service not configured", code: "PROVIDER_UNAVAILABLE" }`, and no Clerk M2M token is created.

## billing-redeem-code-007

- Vitest: "POST /api/billing/redeem-code > returns 503 when Atom Clerk M2M auth is not configured"
- Mode: run
- Given: The Atom redeem service URL is configured but the machine secret key for Clerk M2M auth is not. A signed-in org admin has a provisioned free workspace, and Clerk returns the admin's user with a primary email.
- When: The admin requests `POST /api/billing/redeem-code` with `code: "YUMA-123"`.
- Then: The API responds with HTTP 503 and the error `{ message: "Redeem service not configured", code: "PROVIDER_UNAVAILABLE" }`, and no Clerk M2M token is created.

## billing-redeem-code-008

- Vitest: "POST /api/billing/redeem-code > returns 503 when Atom Clerk M2M auth fails"
- Mode: run
- Given: The Atom redeem service URL and machine secret key are configured, but Clerk fails to create the M2M token. A signed-in org admin has a provisioned free workspace, and Clerk returns the admin's user with a primary email.
- When: The admin requests `POST /api/billing/redeem-code` with `code: "YUMA-123"`.
- Then: The API responds with HTTP 503 and the error `{ message: "Redeem service authentication unavailable", code: "PROVIDER_UNAVAILABLE" }`, and Atom is not called.

## billing-redeem-code-009

- Vitest: "POST /api/billing/redeem-code > returns 503 when Atom cannot be reached"
- Mode: run
- Given: The Atom redeem service URL and the machine secret key for Clerk M2M auth are configured, and Clerk issues an M2M token. A signed-in org admin has a provisioned free workspace, and Clerk returns the admin's user with a primary email. Atom's consume endpoint fails with a network error.
- When: The admin requests `POST /api/billing/redeem-code` with `code: "YUMA-123"`.
- Then: The API responds with HTTP 503 and the error `{ message: "Redeem service unavailable", code: "PROVIDER_UNAVAILABLE" }`.

## billing-redeem-code-010

- Vitest: "POST /api/billing/redeem-code > returns 400 when Atom rejects the redeem code"
- Mode: run
- Given: The Atom redeem service URL and the machine secret key for Clerk M2M auth are configured, and Clerk issues an M2M token. A signed-in org admin has a provisioned free workspace, and Clerk returns the admin's user with a primary email. Atom's consume endpoint responds with HTTP 404 `{ error: "invalid code" }`.
- When: The admin requests `POST /api/billing/redeem-code` with `code: "YUMA-123"`.
- Then: The API responds with HTTP 400 and the error `{ message: "Invalid redeem code", code: "BAD_REQUEST" }`.

## billing-redeem-code-011

- Vitest: "POST /api/billing/redeem-code > returns a stable message when Atom reports already used"
- Mode: run
- Given: The Atom redeem service URL and the machine secret key for Clerk M2M auth are configured, and Clerk issues an M2M token. A signed-in org admin has a provisioned free workspace, and Clerk returns the admin's user with a primary email. Atom's consume endpoint responds with HTTP 409 and body `{ error: { code: "already_used" } }`. Parameter row: already used.
- When: The admin requests `POST /api/billing/redeem-code` with `code: "YUMA-123"`.
- Then: The API responds with HTTP 400 and the error `{ message: "This redeem code has already been used", code: "BAD_REQUEST" }`.

## billing-redeem-code-012

- Vitest: "POST /api/billing/redeem-code > returns a stable message when Atom reports expired"
- Mode: run
- Given: The Atom redeem service URL and the machine secret key for Clerk M2M auth are configured, and Clerk issues an M2M token. A signed-in org admin has a provisioned free workspace, and Clerk returns the admin's user with a primary email. Atom's consume endpoint responds with HTTP 410 and body `{ error_code: "code_expired" }`. Parameter row: expired.
- When: The admin requests `POST /api/billing/redeem-code` with `code: "YUMA-123"`.
- Then: The API responds with HTTP 400 and the error `{ message: "This redeem code has expired", code: "BAD_REQUEST" }`.

## billing-redeem-code-013

- Vitest: "POST /api/billing/redeem-code > returns a stable message when Atom reports not eligible"
- Mode: run
- Given: The Atom redeem service URL and the machine secret key for Clerk M2M auth are configured, and Clerk issues an M2M token. A signed-in org admin has a provisioned free workspace, and Clerk returns the admin's user with a primary email. Atom's consume endpoint responds with HTTP 403 and body `{ code: "org_mismatch" }`. Parameter row: not eligible.
- When: The admin requests `POST /api/billing/redeem-code` with `code: "YUMA-123"`.
- Then: The API responds with HTTP 400 and the error `{ message: "This code is not eligible for this workspace", code: "BAD_REQUEST" }`.

## billing-redeem-code-014

- Vitest: "POST /api/billing/redeem-code > returns a stable message when Atom reports unknown"
- Mode: run
- Given: The Atom redeem service URL and the machine secret key for Clerk M2M auth are configured, and Clerk issues an M2M token. A signed-in org admin has a provisioned free workspace, and Clerk returns the admin's user with a primary email. Atom's consume endpoint responds with HTTP 400 and body `{ error: { code: "atom_internal_business_error" } }`. Parameter row: unknown.
- When: The admin requests `POST /api/billing/redeem-code` with `code: "YUMA-123"`.
- Then: The API responds with HTTP 400 and the error `{ message: "Redeem code could not be redeemed", code: "BAD_REQUEST" }`.

## billing-redeem-code-015

- Vitest: "POST /api/billing/redeem-code > preserves the unavailable response for missing user"
- Mode: run
- Given: The Atom redeem service URL and the machine secret key for Clerk M2M auth are configured, and Clerk issues an M2M token. A signed-in org admin has a provisioned free workspace, but looking up the user in Clerk fails (Clerk reports the user is not found). Parameter row: missing user.
- When: The admin requests `POST /api/billing/redeem-code` with `code: "YUMA-123"`.
- Then: The API responds with HTTP 503 and the error `{ code: "PROVIDER_UNAVAILABLE", message: "Redeem service user unavailable" }`. Clerk's user lookup is called exactly once with the admin's user ID, no M2M token is created, and Atom is not called.

## billing-redeem-code-016

- Vitest: "POST /api/billing/redeem-code > preserves the unavailable response for provider failure"
- Mode: run
- Given: The Atom redeem service URL and the machine secret key for Clerk M2M auth are configured, and Clerk issues an M2M token. A signed-in org admin has a provisioned free workspace, but looking up the user in Clerk fails (Clerk is unavailable). Parameter row: provider failure.
- When: The admin requests `POST /api/billing/redeem-code` with `code: "YUMA-123"`.
- Then: The API responds with HTTP 503 and the error `{ code: "PROVIDER_UNAVAILABLE", message: "Redeem service user unavailable" }`. Clerk's user lookup is called exactly once with the admin's user ID, no M2M token is created, and Atom is not called.

## billing-redeem-code-017

- Vitest: "POST /api/billing/redeem-code > redeems a code with a primary-email match of true"
- Mode: run
- Given: The Atom redeem service URL and the machine secret key for Clerk M2M auth are configured, and Clerk issues an M2M token. A signed-in org admin has a provisioned free workspace. Clerk returns the user with a secondary email and a primary email matching `primaryEmailAddressId`. Atom accepts the code. Parameter row: primary-email match `true`.
- When: The admin requests `POST /api/billing/redeem-code` with `code: " YUMA-123 "` (surrounding whitespace).
- Then: The API responds with HTTP 200 `{ redeemed: true }`. Clerk's user lookup is called exactly once with the admin's user ID, and an M2M token is created with the machine secret key, 3600 seconds expiration and 300 seconds minimum remaining TTL. Atom receives `Authorization: Bearer <M2M token>` and the body `{ code: "YUMA-123", email, org_id, user_id }` with the primary email. Neither the response nor the upstream request contains the machine secret key (raw, SHA-256 or JSON-quoted).

## billing-redeem-code-018

- Vitest: "POST /api/billing/redeem-code > redeems a code with a primary-email match of false"
- Mode: run
- Given: The Atom redeem service URL and the machine secret key for Clerk M2M auth are configured, and Clerk issues an M2M token. A signed-in org admin has a provisioned free workspace. Clerk returns the user whose `primaryEmailAddressId` matches none of its email addresses, with a single remaining email. Atom accepts the code. Parameter row: primary-email match `false`.
- When: The admin requests `POST /api/billing/redeem-code` with `code: " YUMA-123 "` (surrounding whitespace).
- Then: The API responds with HTTP 200 `{ redeemed: true }`. Clerk's user lookup is called exactly once with the admin's user ID, and an M2M token is created with the machine secret key, 3600 seconds expiration and 300 seconds minimum remaining TTL. Atom receives `Authorization: Bearer <M2M token>` and the body `{ code: "YUMA-123", email, org_id, user_id }` with the remaining email. Neither the response nor the upstream request contains the machine secret key (raw, SHA-256 or JSON-quoted).
