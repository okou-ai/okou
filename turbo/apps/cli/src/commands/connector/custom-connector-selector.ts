import { uuid } from "zod";
import { listCustomConnectors } from "../../lib/api/domains/connectors";
import {
  findConnectorBySelector,
  parseConnectorSelector,
} from "./connector-selector";

export async function resolveCustomConnectorId(
  selector: string,
): Promise<string> {
  const { kind, value } = parseConnectorSelector(selector);
  if (kind === "builtin") {
    throw new Error(
      `Expected a custom connector: ${selector}\nRun: okou connector custom list`,
    );
  }
  const id = uuid().safeParse(value);
  if (id.success) {
    return id.data.toLowerCase();
  }

  const connectors = await listCustomConnectors();
  const connector = findConnectorBySelector(connectors, selector, (item) => {
    return {
      kind: "custom",
      id: item.id,
      slug: item.slug,
      label: item.displayName,
    };
  });
  if (!connector) {
    throw new Error(
      `Unknown or unavailable custom connector selector: ${selector}\nRun: okou connector custom list`,
    );
  }
  return connector.id;
}
