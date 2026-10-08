export interface ConnectorPermissionGrant {
  readonly connectorSlug: string;
  readonly permission: string;
  readonly action: "allow" | "deny";
  readonly expiresAt: Date | null;
}
