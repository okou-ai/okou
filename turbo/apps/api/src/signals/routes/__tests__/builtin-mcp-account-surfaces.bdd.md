# builtin-mcp-account-surfaces

## builtin-mcp-account-surfaces-001

- Vitest: "builtin MCP account surfaces > includes MCP in catalog discovery, search and category totals"
- Mode: run
- Given: An authenticated workspace member has an active catalog with built-in public-mcp and manual-mcp entries in the test-connectors category.
- When: The member requests GET /api/connector-catalog, category discovery, GET /api/connectors/search for public-mcp, and catalog detail and permissions for public-mcp.
- Then: The four catalog/search reads return HTTP 200. Category discovery includes both MCP entries, its total matches the overall catalog size and its category count matches the entries returned. Search returns Public Tools for public-mcp. Detail reports streamable-http and no permissions, and the permissions route returns HTTP 404.

## builtin-mcp-account-surfaces-002

- Vitest: "builtin MCP account surfaces > connects and manages MCP accounts through ordinary connector endpoints"
- Mode: run
- Given: An authenticated workspace member can add a public, no-auth MCP connection.
- When: The member sends POST /api/connectors/public-mcp/no-auth with display name Research. They list connectors, read the account and scope diff and deletion impact, inspect the exact selection, set it as default and read it again.
- Then: Each operation returns HTTP 200. The connector appears connected and the exact account appears in list, as default and in detail. The scope diff has no added or removed scopes, the delete impact lists zero explicit selections and inspection marks the exact selection available. Final readback retains the exact ID, target and Research name.

## builtin-mcp-account-surfaces-003

- Vitest: "builtin MCP account surfaces > manages selected MCP accounts and keeps reads available during catalog outages"
- Mode: run
- Given: An entitled authenticated member has a connected public MCP account and creates a Chat thread with an explicit Claude model.
- When: The member uses PUT and GET /api/chat-threads/:id/connector-selections, inspects the chosen account, disables the account for the thread, then enables it and reapplies selection.
- Then: Thread creation returns HTTP 201, and the reads and changes return HTTP 200. The first read returns the exact selection and connected account, and inspect says available. While disabled, both selection arrays are empty. After re-enabling and setting it again, the exact selection is returned.
