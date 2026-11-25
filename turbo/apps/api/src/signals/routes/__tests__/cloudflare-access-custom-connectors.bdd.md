# cloudflare-access-custom-connectors

## cloudflare-access-custom-connectors-001

- Vitest: "http binds atomically and requires explicit dependency removal"
- Mode: run
- Given: A workspace admin with the custom-connector Cloudflare Access switch enabled has an organization Cloudflare Access configuration (kind `http`).
- When: The admin creates an HTTP connector with an API prefix bound to the configuration via `POST /api/custom-connectors`, renames it via `PUT /api/custom-connectors/:id` without a binding field, previews and attempts deletion and conversion of the configuration with `includeCustomConnectors=true`, then disables the switch, clears the binding with `networkBinding: null`, previews again and deletes the configuration.
- Then: The created connector's binding is `available` for the configuration; the rename keeps the binding and storage version. Delete and convert previews list the connector, and both requests return HTTP 409 with a message mentioning the connector. Clearing returns HTTP 200 with no binding and the same storage version, the new preview lists no connectors, and the deletion returns HTTP 204.

## cloudflare-access-custom-connectors-002

- Vitest: "mcp binds atomically and requires explicit dependency removal"
- Mode: run
- Given: A workspace admin with the custom-connector Cloudflare Access switch enabled has an organization Cloudflare Access configuration (kind `mcp`).
- When: The admin creates an MCP connector with a streamable-HTTP endpoint bound to the configuration via `POST /api/custom-connectors`, renames it via `PUT /api/custom-connectors/:id` without a binding field, previews and attempts deletion and conversion of the configuration with `includeCustomConnectors=true`, then disables the switch, clears the binding with `networkBinding: null`, previews again and deletes the configuration.
- Then: The created connector's binding is `available` for the configuration; the rename keeps the binding and storage version. Delete and convert previews list the connector, and both requests return HTTP 409 with a message mentioning the connector. Clearing returns HTTP 200 with no binding and the same storage version, the new preview lists no connectors, and the deletion returns HTTP 204.

## cloudflare-access-custom-connectors-003

- Vitest: "http unbound connectors preserve legacy Direct behavior and safe Cloudflare metadata"
- Mode: run
- Given: A workspace admin without the custom-connector Cloudflare Access switch has an organization Cloudflare Access configuration (kind `http`).
- When: The admin creates an HTTP connector without a network binding, reads and renames it, lists configurations with and without `includeCustomConnectors=true`, previews conversion with connectors included, converts the configuration to personal, and deletes the connector.
- Then: The connector read and the rename (HTTP 200, new display name) have no `networkBinding` property. The default configuration list omits `customConnectors`, the opted-in list shows an empty `customConnectors` array and no client secret, and the conversion preview lists no connectors. The conversion returns HTTP 200 and the connector deletion HTTP 204.

## cloudflare-access-custom-connectors-004

- Vitest: "mcp unbound connectors preserve legacy Direct behavior and safe Cloudflare metadata"
- Mode: run
- Given: A workspace admin without the custom-connector Cloudflare Access switch has an organization Cloudflare Access configuration (kind `mcp`).
- When: The admin creates an MCP connector without a network binding, reads and renames it, lists configurations with and without `includeCustomConnectors=true`, previews conversion with connectors included, converts the configuration to personal, and deletes the connector.
- Then: The connector read and the rename (HTTP 200, new display name) have no `networkBinding` property. The default configuration list omits `customConnectors`, the opted-in list shows an empty `customConnectors` array and no client secret, and the conversion preview lists no connectors. The conversion returns HTTP 200 and the connector deletion HTTP 204.

## cloudflare-access-custom-connectors-005

- Vitest: "a disabled feature rejects a new binding without dropping it: {\"type\":\"cloudflare_access\",\"configId\":\"40d86fd2-d809-478d-a129-3f9b6546cca1\"}"
- Mode: run
- Given: A workspace admin without the custom-connector Cloudflare Access switch; the requested binding is `{"type":"cloudflare_access","configId":<random ID>}`.
- When: The admin creates an HTTP connector with that binding via `POST /api/custom-connectors`, saves a create proposal with it via `POST /api/custom-connectors/proposals/save`, creates a connector without a binding, and then updates that connector to add the binding via `PUT /api/custom-connectors/:id`.
- Then: The bound create and the proposal save return HTTP 400 and no connectors exist. The unbound create returns HTTP 201, the bound update returns HTTP 400, and the connector still has no `networkBinding` property.
