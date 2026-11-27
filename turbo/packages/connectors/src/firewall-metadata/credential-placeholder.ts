import { createHash } from "node:crypto";

/** The opaque credential marker format used by okou-connectors. */
export function connectorCredentialPlaceholder(
  source: string,
  binding: string,
): string {
  const digest = createHash("sha256")
    .update(source)
    .update("\0")
    .update(binding)
    .digest("hex");
  return `OkouConnector${digest.slice(0, 20)}`;
}
