# me-model-providers-delete

## me-model-providers-delete-001

- Vitest: "DELETE /api/me/model-providers/:type > returns 401 when unauthenticated"
- Mode: run
- Given: The caller has no authentication.
- When: The caller sends DELETE /api/me/model-providers/claude-code-oauth-token.
- Then: The API returns HTTP 401 UNAUTHORIZED.

## me-model-providers-delete-002

- Vitest: "DELETE /api/me/model-providers/:type > returns 401 when authenticated session has no organization"
- Mode: run
- Given: The caller has an authenticated user session with no organization.
- When: The user sends DELETE /api/me/model-providers/claude-code-oauth-token.
- Then: The API returns HTTP 401 UNAUTHORIZED.

## me-model-providers-delete-003

- Vitest: "DELETE /api/me/model-providers/:type > deletes the user's personal provider"
- Mode: run
- Given: An authenticated member has a connected personal Claude provider.
- When: The member sends DELETE /api/me/model-providers/claude-code-oauth-token twice.
- Then: The first returns HTTP 204. The repeat returns HTTP 404 NOT_FOUND with message Resource not found.

## me-model-providers-delete-004

- Vitest: "DELETE /api/me/model-providers/:type > disconnects a legacy Claude account when profile preparation returns 200"
- Mode: run
- Given: An authenticated member added a Claude provider while the profile endpoint was unavailable. The created account has null email and workspace name. The provider profile subsequently responds with HTTP 200.
- When: The member sends DELETE /api/me/model-providers/claude-code-oauth-token, lists their personal providers and repeats the delete.
- Then: The delete returns HTTP 204, GET /api/me/model-providers returns HTTP 200 with an empty list, and repeat returns HTTP 404 NOT_FOUND with message Resource not found.

## me-model-providers-delete-005

- Vitest: "DELETE /api/me/model-providers/:type > disconnects a legacy Claude account when profile preparation returns 503"
- Mode: run
- Given: An authenticated member added a Claude provider while the profile endpoint was unavailable. The created account has null email and workspace name. The provider profile subsequently responds with HTTP 503.
- When: The member sends DELETE /api/me/model-providers/claude-code-oauth-token, lists their personal providers and repeats the delete.
- Then: The delete returns HTTP 204, GET /api/me/model-providers returns HTTP 200 with an empty list, and repeat returns HTTP 404 NOT_FOUND with message Resource not found.

## me-model-providers-delete-006

- Vitest: "DELETE /api/me/model-providers/:type > does not delete another user's provider in the same organization"
- Mode: run
- Given: Two authenticated members share an organization. One has a personal Claude provider and the other has none.
- When: Each member sends DELETE /api/me/model-providers/claude-code-oauth-token, with the non-owner first.
- Then: The non-owner receives HTTP 404 NOT_FOUND with message Resource not found. The owner can still delete their provider with HTTP 204.
