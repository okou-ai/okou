import {
  dataRouterRequest,
  dataRouterToolsPageSchema,
  type DataRouterFamily,
} from "@okouai/api-contracts/contracts/data-router-tools";
import { command, computed, state } from "ccstate";
import { object } from "zod";
import { resolveDataRouterUrl } from "../../../lib/platform-host.ts";
import { fetchResource } from "../../../lib/resource-fetch.ts";
import { detach, NEVER_RESOLVED_PROMISE, Reason } from "../../utils.ts";

/**
 * Router publishes its MCP tool catalog without credentials and owns every
 * family ID and its text. Only families with a listed tool become controls.
 */
async function readDataRouterFamilies(
  signal: AbortSignal,
): Promise<DataRouterFamily[]> {
  const families = new Map<string, DataRouterFamily>();
  const listed = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await fetchResource(
      resolveDataRouterUrl(),
      {
        method: "POST",
        ...dataRouterRequest(
          { method: "tools/list", params: cursor ? { cursor } : {} },
          cursors.size + 1,
        ),
        redirect: "error",
      },
      signal,
    );
    if (!response.ok) {
      throw new Error(
        `Data Router discovery failed (HTTP ${String(response.status)})`,
      );
    }
    const body: unknown = await response.json();
    signal.throwIfAborted();
    const page = object({ result: dataRouterToolsPageSchema }).parse(
      body,
    ).result;
    for (const tool of page.tools) {
      const family = tool._meta?.["ai.okou/data"]?.family;
      if (family) {
        listed.add(family);
      }
    }
    for (const family of page._meta["ai.okou/data"].families) {
      if (!families.has(family.id)) {
        families.set(family.id, family);
      }
    }
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) {
      throw new Error("Data Router repeated a discovery cursor");
    }
    if (cursor) {
      cursors.add(cursor);
    }
  } while (cursor);
  return [...families.values()].filter((family) => {
    return listed.has(family.id);
  });
}

/** Settings and onboarding own independent discoveries and cancellation. */
export function createPaidToolsCatalogSignals() {
  // Keep the operation itself so loadables own its status; derived values
  // never capture the owning page or Settings AbortSignal.
  const request$ = state<Promise<DataRouterFamily[]>>(NEVER_RESOLVED_PROMISE);
  const catalog$ = computed((get) => {
    return get(request$);
  });
  const startDiscovery$ = command(({ set }, signal: AbortSignal): void => {
    signal.throwIfAborted();
    const request = readDataRouterFamilies(signal);
    set(request$, request);
    detach(request, Reason.Daemon, "Public tool catalog discovery");
  });
  return { catalog$, startDiscovery$ };
}

const settingsCatalog = createPaidToolsCatalogSignals();
export const dataRouterCatalog$ = settingsCatalog.catalog$;
export const startPaidToolsCatalogDiscovery$ = settingsCatalog.startDiscovery$;
