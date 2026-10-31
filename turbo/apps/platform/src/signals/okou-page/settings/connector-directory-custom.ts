import { computed } from "ccstate";
import { isIntegrationManagedCustomConnector } from "@okouai/api-contracts/validators/custom-connectors";
import { connectorsSearch$ } from "./connectors.ts";
import { customConnectors$ } from "./custom-connectors.ts";

export const filteredDirectoryCustomConnectors$ = computed(async (get) => {
  const search = get(connectorsSearch$).trim().toLowerCase();
  const connectors = await get(customConnectors$);
  return connectors.filter((connector) => {
    return (
      !isIntegrationManagedCustomConnector(connector) &&
      connector.displayName.toLowerCase().includes(search)
    );
  });
});
