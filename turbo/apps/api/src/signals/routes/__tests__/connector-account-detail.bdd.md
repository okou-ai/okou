# connector-account-detail

## connector-account-detail-001

- Vitest: "GET /api/connector-accounts/:connectionId > returns 401 when not authenticated"
- Mode: run
- Given: A caller has no authenticated session.
- When: The caller sends GET /api/connector-accounts/:connectionId for a GitHub account ID.
- Then: The API returns HTTP 401 UNAUTHORIZED.

## connector-account-detail-002

- Vitest: "GET /api/connector-accounts/:connectionId > returns 401 when the authenticated session has no organization"
- Mode: run
- Given: The user is authenticated with no organization.
- When: The user sends GET /api/connector-accounts/:connectionId for a GitHub account ID.
- Then: The API returns HTTP 401 UNAUTHORIZED.

## connector-account-detail-003

- Vitest: "GET /api/connector-accounts/:connectionId > returns a connector created through the connector API"
- Mode: run
- Given: An authenticated owner uses a manual grant to connect OpenAI.
- When: The owner sends GET /api/connector-accounts/:connectionId with the returned ID and the OpenAI target.
- Then: HTTP 200 returns the exact ID and built-in OpenAI target, auth method api-token and connected status.

## connector-account-detail-004

- Vitest: "GET /api/connector-accounts/:connectionId > allows an exact account read with a dispatched Runner credential"
- Mode: run
- Given: An authenticated member has obtained a normal dispatched Run credential. They save an OpenAI account after the Run credential is issued.
- When: The caller sends GET /api/connector-accounts/:connectionId using the Run credential for the new exact account and OpenAI target.
- Then: HTTP 200 returns the built-in OpenAI target.

## connector-account-detail-005

- Vitest: "GET /api/connector-accounts/:connectionId > keeps stored connector details scoped to the user, organization, and slug"
- Mode: run
- Given: An authenticated owner has an OpenAI connection in one organization.
- When: Callers send GET /api/connector-accounts/:connectionId with the exact original target, a GitHub target instead, a different user in the same organization, and the same owner in another organization, and finally the owner retries with the original scope.
- Then: The valid owner requests return HTTP 200 and the same exact detail. The other three requests receive HTTP 404 with identical bodies.

## connector-account-detail-006

- Vitest: "GET /api/connector-accounts/:connectionId > reads current account details after rename, deletion, and a new connection"
- Mode: run
- Given: An authenticated owner has a connected OpenAI account.
- When: The owner reads it using GET /api/connector-accounts/:connectionId, renames via PATCH, re-reads, deletes the account, reads it again and creates and reads a new connection.
- Then: The rename returns HTTP 200 and detail readback retains the account data with the new display name and the updatedAt from the rename response. After delete, the old ID returns HTTP 404 NOT_FOUND. The replacement uses a distinct ID and returns HTTP 200 with the same target, api-token method and connected status.
