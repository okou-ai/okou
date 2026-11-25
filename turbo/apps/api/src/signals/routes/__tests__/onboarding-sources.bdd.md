# onboarding-sources

## onboarding-sources-001

- Vitest: "GET /api/onboarding/sources > returns 401 when not authenticated"
- Mode: run
- Given: The caller has no authenticated session.
- When: The caller sends `GET /api/onboarding/sources`.
- Then: The API returns HTTP 401 with code `UNAUTHORIZED`.

## onboarding-sources-002

- Vitest: "GET /api/onboarding/sources > returns the visible onboarding sources with the caller's connection status"
- Mode: run
- Given: An authenticated user has completed GitHub OAuth and can read the visible connector catalog.
- When: The user sends `GET /api/onboarding/sources` and reads catalog status.
- Then: Both return HTTP 200. The source slugs are exactly the visible onboarding recommendations, in recommendation order. GitHub identifies OAuth as its single auth-code method without a permission summary, and the public result omits private catalog fields.
