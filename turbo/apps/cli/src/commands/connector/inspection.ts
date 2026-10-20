import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";

export function connectorInspectionType(
  target: ConnectorAccountTarget,
  definition: Pick<CustomConnectorResponse, "kind"> | null,
): "builtin" | "custom-http" | "custom-mcp" | null {
  if (target.kind === "builtin") {
    return "builtin";
  }
  if (definition === null) {
    return null;
  }
  return definition.kind === "http" ? "custom-http" : "custom-mcp";
}
