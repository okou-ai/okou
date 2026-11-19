import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import type { ConnectorPermissions } from "@okouai/api-contracts/contracts/connector-permissions";

export function connectorPermissionsResponse(
  target: ConnectorAccountTarget,
  grants: readonly (ConnectorPermissions["grants"][number] & {
    readonly connectorSlug?: string;
  })[],
): ConnectorPermissions {
  return {
    target,
    grants: grants
      .filter((grant) => {
        return (
          target.kind === "custom" ||
          grant.connectorSlug === undefined ||
          grant.connectorSlug === target.connectorSlug
        );
      })
      .map(({ permission, action, expiresAt }) => {
        return { permission, action, expiresAt };
      }),
  };
}
