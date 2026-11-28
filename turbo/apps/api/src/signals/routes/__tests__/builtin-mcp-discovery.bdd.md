# builtin-mcp-discovery

## builtin-mcp-discovery-001

- Vitest: "builtin MCP discovery authority > refreshes discovery as Chat accounts become available and are deleted"
- Mode: run
- Given: An authenticated Chat member starts a run with no connected account for the built-in manual MCP connector. The member can add a manually connected account and later a healthy sibling.
- When: The run calls GET /api/mcp-connectors with its execution-provided Okou token before and after the first account is connected. A subsequent run calls it again, then the member adds a sibling, removes the first account and calls discovery with the same subsequent-run token.
- Then: Each read returns HTTP 200. The first result is empty, the next two expose the connected account as runtime available and the final result exposes the surviving sibling as runtime available.

## builtin-mcp-discovery-002

- Vitest: "builtin MCP discovery authority > returns reconnect guidance for the exact non-default account"
- Mode: run
- Given: An authenticated Chat member has a default and a distinct non-default account for the built-in manual MCP connector. The member selects the non-default account for the thread, then starts a run on that thread.
- When: With the run's execution-provided Okou token, the caller posts that connector and the read scope to /api/mcp-connectors/oauth2/reauthorize, deletes the selected account and repeats the request.
- Then: Both results return HTTP 200. The first result has kind reconnect, the selected account's ID and the App reconnect URL for that exact ID. After deletion, the result points to the remaining default account.
