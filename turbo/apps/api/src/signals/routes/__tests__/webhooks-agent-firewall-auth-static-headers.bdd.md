# webhooks-agent-firewall-auth-static-headers

## webhooks-agent-firewall-auth-static-headers-001

- Vitest: "catalog-owned Automatic MCP static headers > resolves the configured profile privately through refresh and denies a deleted account"
- Mode: run
- Given: A Pro workspace member connected a catalog Automatic MCP connector whose catalog profile defines static `X-Datadog-MCP-Toolsets` and `X-Mcp-Options` headers, through CIMD OAuth, and sent a chat whose Run is dispatched with that builtin firewall bound to the account.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with the catalog auth headers, again with `forceRefresh`, and again after the member deletes the connector account.
- Then: The Run's environment, platform environment and secret values contain no MCP or static access token. The first request returns HTTP 200 with exactly the initial bearer token plus `X-Datadog-MCP-Toolsets: all,cases` and `X-Mcp-Options: Mode=FULL; preview=v2`, and the forced refresh returns the refreshed bearer with the same static headers. After deletion the request returns HTTP 424 with `CONNECTOR_NOT_CONFIGURED`.

## webhooks-agent-firewall-auth-static-headers-002

- Vitest: "catalog-owned Automatic MCP static headers > denies omitted, changed and additional request policy without poisoning the accepted profile"
- Mode: run
- Given: A Pro workspace member connected a catalog Automatic MCP connector whose catalog profile defines a bearer token and static `X-Datadog-MCP-Toolsets` and `X-Mcp-Options` headers, and sent a chat whose Run is dispatched with that builtin firewall bound to the account.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with header profiles that omit the static headers, change the toolsets, add an `X-Api-Key`, replace the bearer, or omit the bearer; then with an added auth query or a different auth base; then for an unknown account ID; and finally with the exact catalog profile.
- Then: Every altered header profile and the added query or base return HTTP 424 with `CONNECTOR_NOT_CONFIGURED`, and the unknown account is not accepted. The exact catalog profile still returns HTTP 200 with exactly the initial bearer token, `X-Datadog-MCP-Toolsets: all,cases` and `X-Mcp-Options: Mode=FULL; preview=v2`.
