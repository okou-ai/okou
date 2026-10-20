import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";

export function customConnectorTarget(
  connector: CustomConnectorResponse,
): string {
  return connector.kind === "mcp"
    ? connector.endpoint
    : connector.prefixTemplates.join(", ");
}
