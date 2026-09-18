// Rule identifiers are content-free. Detailed messages stay inside validation;
// the artifact loader never forwards them or their private catalog values.
export type ConnectorCatalogRelationshipRule =
  | "invalid-replacement"
  | "mcp-auth-contract"
  | "mcp-firewall-contract"
  | "duplicate-identifier"
  | "overlapping-storage-classes"
  | "platform-secret-storage-overlap"
  | "manual-field-storage"
  | "private-derived-public-id"
  | "device-option-default"
  | "auth-client-presence"
  | "auth-code-client-registration"
  | "auth-client-type"
  | "undeclared-storage-reference"
  | "refreshable-secret-storage"
  | "unknown-category-group"
  | "reserved-connector-ownership"
  | "unknown-category"
  | "duplicate-skill-storage-owner"
  | "duplicate-skill-version-owner"
  | "duplicate-storage-secret-owner"
  | "duplicate-storage-variable-owner"
  | "unknown-firewall-binding"
  | "conflicting-firewall-host-policies"
  | "missing-generated-firewall"
  | "invalid-firewall-fixed-host"
  | "duplicate-firewall-permission-rule"
  | "noncanonical-firewall-hostname"
  | "firewall-base-secret"
  | "invalid-firewall-base-url"
  | "missing-firewall-host-policy"
  | "firewall-permission-categories"
  | "firewall-category-order"
  | "firewall-default-allowlist";

export class ConnectorCatalogRelationshipError extends Error {
  constructor(
    readonly rule: ConnectorCatalogRelationshipRule,
    message: string,
  ) {
    super(message);
    this.name = "ConnectorCatalogRelationshipError";
  }
}
