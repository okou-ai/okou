import { connectorCatalogContract } from "@okouai/api-contracts/client/connector-catalog";
import { command, computed, state } from "ccstate";

import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";

const revision$ = state(0);

export const reloadConnectorCatalogRelease$ = command(({ set }) => {
  set(revision$, (revision) => {
    return revision + 1;
  });
});

export const connectorCatalogRelease$ = computed(async (get) => {
  get(revision$);
  const client = get(apiClient$)(connectorCatalogContract);
  const result = await accept(client.release(), [200]);
  return result.body.catalog;
});
