import { computed } from "ccstate";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { createCustomConnectorList } from "../services/custom-connector-list.service";
import type { RouteEntry } from "../route-entry";
import { customConnectorsCreateRoutes } from "./custom-connectors-create";
import { customConnectorsDeleteRoutes } from "./custom-connectors-delete";
import { customConnectorsGetRoutes } from "./custom-connectors-get";
import { customConnectorsUpdateRoutes } from "./custom-connectors-update";
import { customConnectorProposalRoutes } from "./custom-connectors-proposal";
import { customConnectorOAuth2Routes } from "./custom-connectors-oauth2";
import { customConnectorsValuesSetRoutes } from "./custom-connectors-values-set";

const customConnectorListScope$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  return { orgId: auth.orgId, userId: auth.userId };
});
const customConnectorList$ = createCustomConnectorList(
  customConnectorListScope$,
);

const listCustomConnectorsInner$ = computed(async (get) => {
  const connectors = await get(customConnectorList$);
  return { status: 200 as const, body: { connectors: [...connectors] } };
});

export const customConnectorsRoutes: readonly RouteEntry[] = [
  {
    route: customConnectorsContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:read",
      },
      listCustomConnectorsInner$,
    ),
  },
  ...customConnectorsCreateRoutes,
  ...customConnectorsGetRoutes,
  ...customConnectorsDeleteRoutes,
  ...customConnectorsUpdateRoutes,
  ...customConnectorProposalRoutes,
  ...customConnectorsValuesSetRoutes,
  ...customConnectorOAuth2Routes,
];
