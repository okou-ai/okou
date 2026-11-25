# custom-connector-network-execution

## custom-connector-network-execution-001

- Vitest: "chat account startup preserves HTTP/MCP network bindings and unbound Direct intent"
- Mode: run
- Given: An authenticated organization admin has enabled Cloudflare Access for custom connectors, configured an organization Access credential and saved accounts for both HTTP and MCP connectors. For each transport one connector is bound to that configuration and the other is unbound.
- When: The admin starts a chat run, a Runner obtains execution and requests firewall authorization and network admission, and the admin rotates the configuration and then disables the feature before starting another run.
- Then: The initial execution names all four target account IDs. The bound targets carry the exact Access configuration and generation and the unbound targets are direct. The firewall returns HTTP 200 with the connected account's Authorization header for each matching target. Bound targets with an absent, direct or mismatched intent return HTTP 424 CONNECTOR_NOT_CONFIGURED. Network admission rejects a sandbox token with HTTP 401 and returns HTTP 200 with the Access headers for an authenticated Runner. Rotation returns HTTP 200 with generation incremented by one. Runtime sync reports both bound targets available with the new generation and admission returns the rotated headers. After disabling the feature, the next execution omits both bound connectors from firewall and runtime targets and retains both unbound firewalls without a network intent.
