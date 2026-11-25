# auth-me

## auth-me-001

- Vitest: "reads the authenticated user directly and selects the primary email"
- Mode: run
- Given: An authenticated user has a primary email and a secondary email that appears first in their Clerk profile.
- When: The caller sends `GET /api/auth/me`.
- Then: HTTP 200 contains exactly user ID, organization ID and primary email. Clerk is called once for that user.

## auth-me-002

- Vitest: "returns the server-verified Clerk session on both fresh and cached profile reads"
- Mode: run
- Given: An authenticated Clerk session supplies a verified session ID and a primary email.
- When: The caller sends `GET /api/auth/me` twice.
- Then: Both responses return HTTP 200 with the same IDs, primary email and verified session ID. Clerk profile lookup occurs only once.

## auth-me-003

- Vitest: "preserves the auth error when Clerk no longer exposes the user"
- Mode: run
- Given: The session remains authenticated but Clerk no longer returns its user record.
- When: The caller sends `GET /api/auth/me`.
- Then: HTTP 500 returns exactly `{ "error": "Internal server error" }` after one upstream user lookup.

## auth-me-004

- Vitest: "does not substitute a secondary email when the primary email is unavailable"
- Mode: run
- Given: The authenticated Clerk profile references a missing primary email but contains a secondary email.
- When: The caller sends `GET /api/auth/me`.
- Then: HTTP 500 returns exactly `{ "error": "Internal server error" }`.
