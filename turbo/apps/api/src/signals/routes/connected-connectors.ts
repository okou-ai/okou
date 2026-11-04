import { command, computed } from "ccstate";
import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";

import { providerUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import { connectedConnectorBriefs } from "../services/connected-connectors.service";
import { isConnectorCatalogUnavailableError } from "../services/connector-catalog-reader.service";
import { createUserFeatureSwitchContext } from "../services/feature-switches.service";
import { settle } from "../utils";

const owner$ = computed((get) => {
  const { orgId, userId } = get(organizationAuthContext$);
  return { orgId, userId };
});
const context$ = createUserFeatureSwitchContext(owner$);
const connected$ = connectedConnectorBriefs(owner$, context$);
const list$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const result = await settle(get(connected$));
  signal.throwIfAborted();
  if (!result.ok) {
    if (isConnectorCatalogUnavailableError(result.error)) {
      return providerUnavailable(
        "Connector catalog is temporarily unavailable",
      );
    }
    throw result.error;
  }
  return { status: 200 as const, body: result.value };
});

export const connectedConnectorsRoutes: readonly RouteEntry[] = [
  {
    route: connectedConnectorsContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:read",
      },
      list$,
    ),
  },
];
