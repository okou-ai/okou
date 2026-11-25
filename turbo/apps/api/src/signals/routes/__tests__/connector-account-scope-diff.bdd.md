# connector-account-scope-diff

## connector-account-scope-diff-001

- Vitest: "GET /api/connector-accounts/:connectionId/scope-diff > returns 401 when not authenticated"
- Mode: run
- Given: A caller has no authenticated session.
- When: The caller sends GET /api/connector-accounts/:connectionId/scope-diff for a GitHub account ID.
- Then: The API returns HTTP 401 UNAUTHORIZED.

## connector-account-scope-diff-002

- Vitest: "GET /api/connector-accounts/:connectionId/scope-diff > returns 401 when the authenticated session has no organization"
- Mode: run
- Given: The user is authenticated but the session has no organization.
- When: The user sends GET /api/connector-accounts/:connectionId/scope-diff for a GitHub account ID.
- Then: The API returns HTTP 401 UNAUTHORIZED.

## connector-account-scope-diff-003

- Vitest: "GET /api/connector-accounts/:connectionId/scope-diff > returns an empty diff when stored scopes match current scopes exactly"
- Mode: run
- Given: An authenticated owner has a GitHub OAuth connection whose stored scopes match the current catalog's repo, project and workflow requirements.
- When: The owner reads the default diff and sends GET /api/connector-accounts/:connectionId/scope-diff for the exact ID before and after attempts with an unknown ID, wrong connector slug, another user and another organization.
- Then: Valid reads return HTTP 200 with equal current and stored scope lists and no added or removed scopes. Invalid identity choices all return HTTP 404 with the same body as an unknown ID.

## connector-account-scope-diff-004

- Vitest: "GET /api/connector-accounts/:connectionId/scope-diff > reads the current default and exact accounts after default switching and deletion"
- Mode: run
- Given: An authenticated owner initially has no GitHub accounts, then connects two distinct GitHub OAuth accounts using current catalog scopes.
- When: The owner requests the missing diff, reads the default and both exact IDs via GET /api/connector-accounts/:connectionId/scope-diff before and after default switching, deletes the new default, and then deletes the survivor.
- Then: Existing exact and default comparisons return HTTP 200 with equal repo, project and workflow lists and no changes. The default switch returns the second ID as default. After deletion its diff returns HTTP 404, the first is promoted and still returns its diff, and after deleting it the same HTTP 404 body as the original missing read is returned.

## connector-account-scope-diff-005

- Vitest: "GET /api/connector-accounts/:connectionId/scope-diff > returns an empty diff for manual auth connectors"
- Mode: run
- Given: An authenticated owner has an OpenAI API-token connection.
- When: The owner reads the default and exact account scope diffs.
- Then: Each successful read returns HTTP 200 with empty added, removed, current and stored scope arrays.
