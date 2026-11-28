# builtin-mcp-run

## builtin-mcp-run-001

- Vitest: "builtin MCP Run admission > pins execution input, refreshes discovery and keeps MCP credentials behind firewall auth"
- Mode: run
- Given: An authenticated Pro Chat member has a usable personal model, a public MCP account and a manual MCP account. After the member starts a run, they add another manual MCP account and make it the default.
- When: A Runner claims execution, the run calls GET /api/mcp-connectors, and the Runner calls POST /api/webhooks/run/firewall/auth for the admitted manual MCP account. The caller repeats authorization with an unrelated connector mapping and again after the member deletes the admitted account.
- Then: Execution retains firewall references for the public account and the originally admitted manual account. It exposes neither manual credential, its alias mapping nor connector-specific skill mounts, and its system prompt lists both MCP connectors. The manual MCP network policy allows unmatched requests. Discovery returns HTTP 200 with the newer default and public accounts marked runtime available. Firewall auth returns HTTP 200 with the original admitted credential and a 30-second expiry, still uses that credential despite the unrelated mapping, and returns HTTP 424 CONNECTOR_NOT_CONFIGURED after deletion of the admitted account.

## builtin-mcp-run-002

- Vitest: "builtin MCP Run admission > does not let an HTTP custom connector reuse MCP transport permissions"
- Mode: run
- Given: An authenticated member is creating an HTTP custom connector and chooses a permission bundle defined for the built-in manual MCP connector.
- When: The member posts the HTTP connector and MCP bundle reference to /api/custom-connectors.
- Then: Creation returns HTTP 400.
