export interface McpPrincipal {
  readonly tokenType: "oauth";
  readonly userId: string;
  readonly orgId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}
