# route-registration

## route-registration-001

- Vitest: "API route registrations > registers the hosted MCP endpoint and resource metadata"
- Mode: run
- Intent: review
- Given: The hosted MCP server defines its endpoint and resource metadata registrations.
- When: The production API route registry is inspected.
- Then: Every hosted MCP registration is present.

## route-registration-002

- Vitest: "API route registrations > mounts the native client compatibility inventories on its owning routes"
- Mode: run
- Intent: review
- Given: Desktop, iOS and Android each define response transforms keyed by HTTP method and path.
- When: The production API route registry is matched against the combined native client inventory.
- Then: Every transform belongs to its matching route, and each route has exactly the transforms listed for that method and path.

## route-registration-003

- Vitest: "API route registrations > keeps the production route table free of colliding registrations"
- Mode: run
- Intent: review
- Given: The complete production API route table is available.
- When: The table is checked for route registration collisions.
- Then: The uniqueness check completes without throwing.
