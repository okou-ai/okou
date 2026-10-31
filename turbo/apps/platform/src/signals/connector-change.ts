import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { connectorChangedPayloadSchema } from "@okouai/api-contracts/validators/realtime";

export function isConnectorChangedPayloadFor(
  payload: unknown,
  connectorSlug: ConnectorSlug,
): boolean {
  const parsed = connectorChangedPayloadSchema.safeParse(payload);
  return parsed.success && parsed.data.connectorSlug === connectorSlug;
}
