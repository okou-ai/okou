# cloudflare-access-custom-connector-erasure

## cloudflare-access-custom-connector-erasure-001

- Vitest: "manual organization erasure rejects a create already preparing its network binding"
- Mode: run
- Given: A workspace owner with the custom-connector Cloudflare Access switch enabled has an organization Cloudflare Access configuration bound to an HTTP and an MCP custom connector; a separate surviving workspace has its own configuration and bound connector. While the API prepares the encrypted connector secrets, the owner deletes the organization via `POST /api/org/delete` with confirmation (manual erasure).
- When: The departing owner creates a new OAuth HTTP custom connector bound to the configuration via `POST /api/custom-connectors` with an application client secret (create).
- Then: The request returns HTTP 400 after exactly one data-key request, and the response does not contain the client secret. The surviving workspace can then create a configuration reusing the erased configuration's ID, and its own connector's network binding still points to its configuration with status `available`.

## cloudflare-access-custom-connector-erasure-002

- Vitest: "manual organization erasure rejects a update already preparing its network binding"
- Mode: run
- Given: A workspace owner with the custom-connector Cloudflare Access switch enabled has an organization Cloudflare Access configuration bound to an HTTP and an MCP custom connector; a separate surviving workspace has its own configuration and bound connector. While the API prepares the encrypted connector secrets, the owner deletes the organization via `POST /api/org/delete` with confirmation (manual erasure).
- When: The departing owner updates the existing HTTP connector to OAuth via `PUT /api/custom-connectors/:id` with its storage version with an application client secret (update).
- Then: The request returns HTTP 400 after exactly one data-key request, and the response does not contain the client secret. The surviving workspace can then create a configuration reusing the erased configuration's ID, and its own connector's network binding still points to its configuration with status `available`.

## cloudflare-access-custom-connector-erasure-003

- Vitest: "webhook organization erasure rejects a create already preparing its network binding"
- Mode: run
- Given: A workspace owner with the custom-connector Cloudflare Access switch enabled has an organization Cloudflare Access configuration bound to an HTTP and an MCP custom connector; a separate surviving workspace has its own configuration and bound connector. While the API prepares the encrypted connector secrets, a signed Clerk `organization.deleted` webhook for the organization arrives at `POST /api/webhooks/clerk` (webhook erasure).
- When: The departing owner creates a new OAuth HTTP custom connector bound to the configuration via `POST /api/custom-connectors` with an application client secret (create).
- Then: The request returns HTTP 400 after exactly one data-key request, and the response does not contain the client secret. The surviving workspace can then create a configuration reusing the erased configuration's ID, and its own connector's network binding still points to its configuration with status `available`.

## cloudflare-access-custom-connector-erasure-004

- Vitest: "webhook organization erasure rejects a update already preparing its network binding"
- Mode: run
- Given: A workspace owner with the custom-connector Cloudflare Access switch enabled has an organization Cloudflare Access configuration bound to an HTTP and an MCP custom connector; a separate surviving workspace has its own configuration and bound connector. While the API prepares the encrypted connector secrets, a signed Clerk `organization.deleted` webhook for the organization arrives at `POST /api/webhooks/clerk` (webhook erasure).
- When: The departing owner updates the existing HTTP connector to OAuth via `PUT /api/custom-connectors/:id` with its storage version with an application client secret (update).
- Then: The request returns HTTP 400 after exactly one data-key request, and the response does not contain the client secret. The surviving workspace can then create a configuration reusing the erased configuration's ID, and its own connector's network binding still points to its configuration with status `available`.
