/** Project a validated MCP request endpoint to its query-free network scope. */
export function mcpEndpointFirewallBase(endpoint: string): string {
  const url = new URL(endpoint);
  url.search = "";
  return url.href;
}
