# me-model-providers-upsert

## me-model-providers-upsert-001

- Vitest: "POST /api/me/model-providers (upsert) > returns 401 when unauthenticated"
- Mode: run
- Given: The caller has no authenticated session.
- When: The caller supplies a Claude credential to POST /api/me/model-providers.
- Then: The API returns HTTP 401 UNAUTHORIZED.

## me-model-providers-upsert-002

- Vitest: "POST /api/me/model-providers (upsert) > returns 401 when authenticated session has no organization"
- Mode: run
- Given: The caller is authenticated but has no organization in the session.
- When: The caller supplies a Claude credential to POST /api/me/model-providers.
- Then: The API returns HTTP 401 UNAUTHORIZED.

## me-model-providers-upsert-003

- Vitest: "POST /api/me/model-providers (upsert) > creates a single-secret personal provider"
- Mode: run
- Given: An authenticated member belongs to a workspace and has a Claude Code OAuth credential.
- When: The member sends POST /api/me/model-providers with type claude-code-oauth-token and a single secret.
- Then: The API returns HTTP 201 with created true, provider type claude-code-oauth-token and framework claude-code.

## me-model-providers-upsert-004

- Vitest: "POST /api/me/model-providers (upsert) > names a Claude Max account on the default_claude_max_5x tier as max"
- Mode: run
- Given: An authenticated member supplies a Claude Code OAuth credential. The Anthropic profile identifies a Claude Max workspace with rate-limit tier default_claude_max_5x, and the usage endpoint responds successfully.
- When: The member uses POST /api/me/model-providers and then GET /api/me/model-providers.
- Then: Creation returns HTTP 201, and both that response and the HTTP 200 list expose planType max.

## me-model-providers-upsert-005

- Vitest: "POST /api/me/model-providers (upsert) > names a Claude Max account on the default_claude_max_20x tier as ultra"
- Mode: run
- Given: An authenticated member supplies a Claude Code OAuth credential. The Anthropic profile identifies a Claude Max workspace with rate-limit tier default_claude_max_20x, and the usage endpoint responds successfully.
- When: The member uses POST /api/me/model-providers and then GET /api/me/model-providers.
- Then: Creation returns HTTP 201, and both that response and the HTTP 200 list expose planType ultra.

## me-model-providers-upsert-006

- Vitest: "POST /api/me/model-providers (upsert) > reuses a legacy Claude account after recovering its uuid identity"
- Mode: run
- Given: An authenticated member added a Claude account while the profile endpoint was unavailable, leaving email and workspace name null. Provider profiles now link the old and replacement credentials by matching account and organization UUIDs even though display identity differs.
- When: The member sends a replacement credential through POST /api/me/model-providers and then reads GET /api/me/model-providers.
- Then: The request returns HTTP 200 with created false. Provider account ID, modelProviderId and creation time are preserved. The new update time, recovered email and workspace name, pro plan and active status are returned. The list contains only that updated account.

## me-model-providers-upsert-007

- Vitest: "POST /api/me/model-providers (upsert) > reuses a legacy Claude account after recovering its email-workspace identity"
- Mode: run
- Given: An authenticated member added a Claude account while the profile endpoint was unavailable, leaving email and workspace name null. Provider profiles now link the old and replacement credentials by matching email and workspace name with no UUIDs.
- When: The member sends a replacement credential through POST /api/me/model-providers and then reads GET /api/me/model-providers.
- Then: The request returns HTTP 200 with created false. Provider account ID, modelProviderId and creation time are preserved. The new update time, recovered email and workspace name, pro plan and active status are returned. The list contains only that updated account.

## me-model-providers-upsert-008

- Vitest: "POST /api/me/model-providers (upsert) > rejects codex auth methods other than auth_json and keeps the active account"
- Mode: run
- Given: An authenticated member already connected an active Codex account with auth_json and usage is available.
- When: The member sends POST /api/me/model-providers for codex-oauth-token using oauth_token instead, then lists providers.
- Then: The unsupported method returns HTTP 400 BAD_REQUEST. The HTTP 200 list still contains exactly the earlier Codex account with its provider email.

## me-model-providers-upsert-009

- Vitest: "POST /api/me/model-providers (upsert) > paste valid auth.json persists derived secrets + metadata"
- Mode: run
- Given: An authenticated member supplies Codex auth.json whose ID token identifies an account and workspace different from the plain account ID field. The provider reports a pro plan, 25 percent five-hour usage, 40 percent weekly usage and three available reset credits, plus a redeemed credit and mixed expiration times.
- When: The member imports it via POST /api/me/model-providers using auth_json and reads GET /api/me/model-providers.
- Then: The usage request carries the ID-token account ID. Creation returns HTTP 201 with Codex type, Personal Acme workspace, pro plan, weekly reset period, next reset at the reported weekly deadline and needsReconnect false. The HTTP 200 list has one account with its email, three credits, the earliest expiry of an available timed credit, and both usage windows with matching reset times, percentages and durations.

## me-model-providers-upsert-010

- Vitest: "POST /api/me/model-providers (upsert) > keeps reset credits when the expiry read fails"
- Mode: run
- Given: An authenticated member imports a Codex account. Upstream usage reports two reset credits while the separate credit-expiry endpoint returns HTTP 500.
- When: The member calls POST /api/me/model-providers and then GET /api/me/model-providers.
- Then: Creation returns HTTP 201. The HTTP 200 list reports two reset credits and null for the next expiry.

## me-model-providers-upsert-011

- Vitest: "POST /api/me/model-providers (upsert) > consumes a Codex subscription reset credit"
- Mode: run
- Given: An authenticated member has a connected Codex account whose provider reports two reset credits.
- When: The member sends POST /api/me/model-providers/codex-oauth-token/subscription-reset with an idempotency key.
- Then: The provider consume request uses the ID-token account ID and sends the same key as redeem_request_id. The API returns HTTP 200 with outcome reset.

## me-model-providers-upsert-012

- Vitest: "POST /api/me/model-providers (upsert) > refreshes an expired Codex token before consuming a reset credit"
- Mode: run
- Given: An authenticated member has a Codex account whose one-hour access token has expired. The provider returns a fresh access token and rotated refresh token.
- When: Two hours after connection the member sends POST /api/me/model-providers/codex-oauth-token/subscription-reset with an idempotency key.
- Then: The API refreshes once with the stored refresh credential and makes one provider consume request using the new Bearer token, the exact account ID and the key as redeem_request_id. The API returns HTTP 200 with outcome reset.

## me-model-providers-upsert-013

- Vitest: "POST /api/me/model-providers (upsert) > does not consume a reset credit after terminal Codex refresh failure"
- Mode: run
- Given: An authenticated member has a Codex account whose access token has expired. A refresh request receives HTTP 401 refresh_token_expired.
- When: The member requests POST /api/me/model-provider-accounts/:id/subscription-reset for the exact saved account and reads GET /api/me/model-providers.
- Then: The reset returns HTTP 500. The API attempts one refresh and never calls consume. Readback returns the same provider ID with needsReconnect true and lastRefreshErrorCode refresh_token_expired.

## me-model-providers-upsert-014

- Vitest: "POST /api/me/model-providers (upsert) > retries reset after transient Codex refresh failure"
- Mode: run
- Given: An authenticated member has an exact Codex account with an expired access token. Its first refresh returns a transient HTTP 503 and the next refresh succeeds.
- When: The member sends the same POST /api/me/model-provider-accounts/:id/subscription-reset request twice with the same idempotency key.
- Then: The first request returns HTTP 500. The retry returns HTTP 200 with outcome reset. There are two refresh attempts and one provider consume request, which uses the recovered access token.

## me-model-providers-upsert-015

- Vitest: "POST /api/me/model-providers (upsert) > refreshes an expired Codex account once and reuses the rotated token"
- Mode: run
- Given: An authenticated member imports Codex auth.json with an already expired access token. The usage endpoint rejects that token and the refresh endpoint returns rotated credentials.
- When: The member sends POST /api/me/model-providers, then reads GET /api/me/model-providers twice.
- Then: Creation returns HTTP 201 with a provider ID and needsReconnect false. Both HTTP 200 lists retain the same account and expose five-hour usedPercent 25 and weekly usedPercent 40. The provider sees one refresh and three usage requests, first with the original token and then twice with the fresh token, using the account ID from auth.json.

## me-model-providers-upsert-016

- Vitest: "POST /api/me/model-providers (upsert) > returns and short-circuits terminal Codex reconnect state"
- Mode: run
- Given: An authenticated member imports Codex auth.json with an already expired access token. Usage rejects the token and refresh fails terminally with refresh_token_expired.
- When: The member sends POST /api/me/model-providers and lists providers twice.
- Then: Creation returns HTTP 201 and both HTTP 200 lists retain the same account with needsReconnect true and lastRefreshErrorCode refresh_token_expired. The provider sees just one usage request and one refresh across all operations.

## me-model-providers-upsert-017

- Vitest: "POST /api/me/model-providers (upsert) > retries transient Codex refresh failure without false reconnect"
- Mode: run
- Given: An authenticated member imports an expired Codex access token. Usage rejects the original token. OpenAI's first refresh fails with HTTP 503 and a later one rotates the credentials.
- When: The member sends POST /api/me/model-providers then calls GET /api/me/model-providers twice.
- Then: Creation returns HTTP 201. The initial HTTP 200 list omits usage with needsReconnect false and lastRefreshErrorCode null. The second list adds five-hour 25 percent and weekly 40 percent usage without requiring reconnect. Across the flow the provider receives two refresh attempts and two usage requests.

## me-model-providers-upsert-018

- Vitest: "POST /api/me/model-providers (upsert) > isolates Codex usage response failures to account enrichment"
- Mode: run
- Given: An authenticated member imports Codex auth.json with a still-valid access token. The usage provider returns valid data at creation, HTTP 401 on the next usage read and an unrecognized usage body on the following request.
- When: The member sends POST /api/me/model-providers and then requests GET /api/me/model-providers twice.
- Then: Creation returns HTTP 201. Both list requests return HTTP 200 with the stored account ID and needsReconnect false but no usage enrichment. There are three usage calls and no refresh.

## me-model-providers-upsert-019

- Vitest: "POST /api/me/model-providers (upsert) > keeps the stored Codex provider on an upstream usage outage"
- Mode: run
- Given: An authenticated member imports Codex auth.json while the upstream usage service returns HTTP 503 for the first two reads and recovers on the third.
- When: The member sends POST /api/me/model-providers and then calls GET /api/me/model-providers twice.
- Then: Creation returns HTTP 201. The first list returns the same account with needsReconnect false, null refresh error and no usage. The API does not refresh for the outage. The recovered list has the same ID with five-hour 25 percent and weekly 40 percent usage after three usage reads in total.

## me-model-providers-upsert-020

- Vitest: "POST /api/me/model-providers (upsert) > returns 400 CODEX_AUTH_JSON_SHAPE_INVALID when tokens.refresh_token missing"
- Mode: run
- Given: An authenticated member submits Codex auth.json containing access and ID tokens but no refresh token.
- When: The member posts the credential to POST /api/me/model-providers.
- Then: The API returns HTTP 400 CODEX_AUTH_JSON_SHAPE_INVALID.

## me-model-providers-upsert-021

- Vitest: "POST /api/me/model-providers (upsert) > returns 400 CODEX_FREE_PLAN_REJECTED for free-plan accounts"
- Mode: run
- Given: An authenticated member submits Codex auth.json whose plan is free.
- When: The member posts the credential to POST /api/me/model-providers.
- Then: The API returns HTTP 400 CODEX_FREE_PLAN_REJECTED.
