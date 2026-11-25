# agent-custom-connectors

## agent-custom-connectors-001

- Vitest: "GET /api/custom-connectors/:id/permissions > returns permission metadata for a custom connector with a bundle"
- Mode: run
- Given: An authenticated member has created a custom HTTP connector using the builtin:slack@1 permission bundle.
- When: The member sends GET /api/custom-connectors/:id/permissions.
- Then: The API returns HTTP 200 with bundle reference builtin:slack@1, permission chat:write and its default policy deny.

## agent-custom-connectors-002

- Vitest: "GET /api/custom-connectors/:id/permissions > returns 404 when the custom connector has no permission bundle"
- Mode: run
- Given: An authenticated member has created and connected a custom HTTP connector with no permission bundle.
- When: The member sends GET /api/custom-connectors/:id/permissions.
- Then: The API returns HTTP 404 with code NOT_FOUND and message Custom connector permission bundle not found.
