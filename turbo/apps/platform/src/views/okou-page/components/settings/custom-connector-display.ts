import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import { i18n } from "../../../../i18n/index.ts";

export function customConnectorTarget(
  connector: CustomConnectorResponse,
): string {
  const target =
    connector.kind === "mcp"
      ? connector.endpoint
      : connector.prefixTemplates.join(", ");
  const network = connector.networkBinding;
  return network
    ? `${target} · Cloudflare Access: ${
        network.name ??
        i18n.t(($) => {
          return $.cloudflareAccess.bindingUnavailable;
        })
      }`
    : target;
}
