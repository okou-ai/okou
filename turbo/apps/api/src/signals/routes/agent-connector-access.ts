import { computed } from "ccstate";
import { agentConnectorAccessContract } from "@okouai/api-contracts/contracts/agent-connector-access";

import { notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  agentCustomConnectorGrants,
  agentEnabledConnectorSlugs,
  agentExists,
} from "../services/agent-data.service";
import { executableConnectorSlugs } from "../services/connector-action-resolver.service";

const agent$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const { id: agentId } = get(pathParamsOf(agentConnectorAccessContract.agent));
  const owner = { orgId: auth.orgId, userId: auth.userId, agentId };
  if (!(await get(agentExists(owner)))) {
    return notFound(`Agent not found: ${agentId}`);
  }
  const [slugs, grants] = await Promise.all([
    get(agentEnabledConnectorSlugs(owner)),
    get(agentCustomConnectorGrants(owner)),
  ]);
  const enabledConnectorSlugs = await get(executableConnectorSlugs(slugs));
  return {
    status: 200 as const,
    body: {
      enabledConnectorSlugs,
      customConnectorIds: grants.map((grant) => {
        return grant.customConnectorId;
      }),
    },
  };
});

export const agentConnectorAccessRoutes: readonly RouteEntry[] = [
  {
    route: agentConnectorAccessContract.agent,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        accept: ["session"],
      },
      agent$,
    ),
  },
];
