# user-config.bdd

## user-config.bdd-001

- Vitest: "AUTH-03 user model preference > defaults to canonical Auto and accepts a null selection"
- Mode: run
- Given: A workspace admin has completed limited-free onboarding and has never set a model preference.
- When: The admin reads `GET /api/user-model-preference`, sets `selectedModel: null` with `PUT /api/user-model-preference`, and reads it again.
- Then: The default and the updated preference are both `selectedModel: "auto"`, `serviceTier: null`, empty `modelSettings`, `selectedImageModel: null` and an `updatedAt` timestamp, and the re-read equals the update response.

## user-config.bdd-002

- Vitest: "AUTH-03 user model preference > stores independent model effort preferences without deleting prior entries"
- Mode: run
- Given: An onboarded workspace admin with a Pro entitlement and native subscription models configured.
- When: The admin calls `PUT /api/user-model-preference` to select `gpt-6-astra` with effort `high`, switch to `gpt-6-luna` without settings, set `gpt-6-luna` effort `low`, then `PATCH /api/user-model-preference` with image model `gpt-image-2`, then tries `gpt-6-luna` effort `ultra`, then selects `null` (Auto).
- Then: Astra stores `{ "gpt-6-astra": { "effort": "high" } }`, switching keeps it, and Luna adds `{ "gpt-6-luna": { "effort": "low" } }`. The image update keeps the model, tier and settings, sets `gpt-image-2`, and matches the read-back. The `ultra` request returns HTTP 400 "Reasoning effort is not available for this subscription" and leaves Luna and its settings unchanged. Selecting Auto stores `selectedModel: "auto"` and keeps both model settings.

## user-config.bdd-003

- Vitest: "AUTH-03 user model preference > rejects model preference access without authentication or an organization"
- Mode: run
- Given: An unauthenticated caller, and a signed-in user without an organization.
- When: Each calls `GET /api/user-model-preference`.
- Then: The unauthenticated call returns HTTP 401 `UNAUTHORIZED` "Not authenticated", and the user without an organization also receives HTTP 401 `UNAUTHORIZED`.

## user-config.bdd-004

- Vitest: "AUTH-01 public session identity > resolves clerk sessions and rejects missing or non-bearer credentials"
- Mode: run
- Given: A workspace admin, a workspace member and a user without an organization exist in Clerk; session cookies resolve to each in turn, or to no session.
- When: Callers request `GET /api/auth/me` with a session cookie, with no credentials, with a `Basic` header, with an empty `Bearer`, and with an unknown bearer format with and without a valid cookie.
- Then: Valid sessions return HTTP 200 with the user ID, email and organization ID (`null` for the user without an organization). An invalid session, no credentials, `Basic`, an empty bearer, and an unknown bearer without a cookie return HTTP 401 `UNAUTHORIZED`. An unknown bearer with a valid member cookie returns HTTP 200 with the member's identity.

## user-config.bdd-005

- Vitest: "AUTH-02 public CLI PAT identity > resolves CLI PAT bearers with organization membership from clerk"
- Mode: run
- Given: A workspace admin, a workspace member and a user whose Clerk membership list is empty each obtain a CLI token through device authorization.
- When: Each calls `GET /api/auth/me` with their CLI token as a bearer.
- Then: Each request returns HTTP 200 with the user ID and email; the admin and member get their organization ID, and the user without membership gets `orgId: null`.

## user-config.bdd-006

- Vitest: "AUTH-02 public CLI PAT identity > serves cached membership inside the ttl and drops stale rows through the api"
- Mode: run
- Given: A workspace admin has a CLI token issued through device authorization and Clerk reports the admin's membership.
- When: The admin calls `GET /api/auth/me` with the token, then again 30 seconds later after Clerk drops the membership, again at 120 seconds, and again at 125 seconds after Clerk restores the membership.
- Then: The first call returns the admin's identity with the organization ID. At 30 seconds the cached identity with the organization is still returned. At 120 seconds `orgId` is `null`. At 125 seconds the organization ID is returned again.

## user-config.bdd-007

- Vitest: "AUTH-02 public CLI PAT identity > rejects a tampered issued PAT and malformed pat bearers"
- Mode: run
- Given: A user has a CLI token issued through device authorization, and there is no session cookie.
- When: The caller calls `GET /api/auth/me` with the token's signature altered, and with the bearer `vm0_pat_garbage`.
- Then: Both requests return HTTP 401 `UNAUTHORIZED`.

## user-config.bdd-008

- Vitest: "AUTH-02 public CLI PAT identity > expires CLI PATs by their db expiry under mocked time"
- Mode: run
- Given: A workspace admin has a CLI token issued through device authorization.
- When: The admin calls `GET /api/auth/me` with the token, then again after the clock advances 91 days.
- Then: The first call returns HTTP 200 with the admin's user and organization IDs; after 91 days the request returns HTTP 401 `UNAUTHORIZED`.

## user-config.bdd-009

- Vitest: "AUTH-01 sandbox and agent bearers > reads identity with actual Runner-issued sandbox and agent credentials"
- Mode: run
- Given: An entitled member has a chat Run executing, so a Runner holds the Run's sandbox token and the execution's Okou agent token; there is no session cookie.
- When: The caller calls `GET /api/auth/me` with the sandbox token, with the Okou agent token, and with `Bearer vm0_sandbox_not-a-real-token`.
- Then: Both issued tokens return HTTP 200 with the member's user ID, organization ID and email. The fake sandbox token returns HTTP 401 `UNAUTHORIZED`.

## user-config.bdd-010

- Vitest: "AUTH-01 sandbox and agent bearers > rejects push registration with an execution token"
- Mode: run
- Given: A member's chat Run is executing and the execution has an Okou agent token.
- When: The agent token is used to register a push subscription with `POST /api/push-subscriptions`.
- Then: The API responds with HTTP 403 `FORBIDDEN` "This endpoint is not available for sandbox tokens".

## user-config.bdd-011

- Vitest: "AUTH-01 sandbox and agent bearers > drops the organization from execution agent identity after public member removal"
- Mode: run
- Given: A member's chat Run is executing with an Okou agent token, and a workspace admin then removes the member through `DELETE /api/org/members`; Clerk no longer reports the membership.
- When: The agent token calls `GET /api/auth/me`.
- Then: The response contains the member's user ID and email with `orgId: null`.

## user-config.bdd-012

- Vitest: "AUTH-01 sandbox and agent bearers > serves auth me from the fresh user cache and refreshes after the ttl"
- Mode: run
- Given: A signed-in workspace admin; Clerk later reports a rotated email for the admin.
- When: The admin calls `GET /api/auth/me`, again after the email rotation, and again after the clock advances 16 minutes.
- Then: The first call returns the admin's identity and fetches the user from Clerk once. The second call still returns the original email without another Clerk lookup. After 16 minutes the rotated email is returned and Clerk has been queried twice.
