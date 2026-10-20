import type { CustomConnectorReaderResponse as CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connector-readers";

export function customConnectorTarget(
  connector: CustomConnectorResponse,
): string {
  return connector.kind === "mcp"
    ? connector.endpoint
    : connector.prefixTemplates.join(", ");
}
