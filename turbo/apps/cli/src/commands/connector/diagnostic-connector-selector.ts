import { uuid } from "zod";

import {
  listConnectorCatalog,
  listCustomConnectors,
} from "../../lib/api/domains/connectors";
import {
  findConnectorBySelector,
  parseConnectorSelector,
  type ConnectorSelectorIdentity,
} from "./connector-selector";
import { resolveCustomConnectorId } from "./custom-connector-selector";

export async function resolveDiagnosticConnectorSelector(
  selector: string,
): Promise<string> {
  const { kind, value } = parseConnectorSelector(selector);
  if (kind === "custom") {
    return `custom:${await resolveCustomConnectorId(selector)}`;
  }
  const catalog = await listConnectorCatalog();
  const identities: ConnectorSelectorIdentity[] = catalog.connectors.map(
    (connector) => {
      return { kind: "builtin", slug: connector.slug, label: connector.label };
    },
  );
  const hasBuiltinSlug = identities.some((identity) => {
    return identity.slug.toLowerCase() === value.toLowerCase();
  });
  if (
    kind !== "builtin" &&
    (uuid().safeParse(value).success || !hasBuiltinSlug)
  ) {
    const customConnectors = await listCustomConnectors();
    identities.push(
      ...customConnectors.map((connector): ConnectorSelectorIdentity => {
        return {
          kind: "custom",
          id: connector.id,
          slug: connector.slug,
          label: connector.displayName,
        };
      }),
    );
  }
  const identity = findConnectorBySelector(identities, selector, (item) => {
    return item;
  });
  if (!identity) {
    throw new Error(
      `Unknown or unavailable connector selector: ${selector}\nRun: okou connector list`,
    );
  }
  return identity.kind === "custom" ? `custom:${identity.id}` : identity.slug;
}
